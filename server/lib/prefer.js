/**
 * prefer.js — soft filtering of retrieval results.
 *
 * A subject can nominate a list of things the reader currently cares about —
 * for Rx, the drugs they are actually taking. Passages mentioning those are
 * pulled up the ranking, but nothing is excluded.
 *
 * Soft rather than hard, deliberately. A hard filter makes the most valuable
 * question unanswerable: "is it safe to add ibuprofen?" is precisely about a
 * drug that is NOT on the list, and restricting retrieval to the list would
 * return nothing and look like missing documentation.
 *
 * Generic on purpose. The subject names the field via retrieval.filterKey, so
 * this is not drug-specific — any subject with a list-shaped extract field can
 * use it.
 */

/**
 * Every string worth matching on, from one chunk's value for `key`.
 *
 * Extraction may produce either plain strings (["aspirin"]) or objects
 * ({generic, brand, drugClass}), and both have to work — a drug recorded only
 * under its brand name must still match someone who typed the generic.
 */
/**
 * Values a model emits when a field does not apply. They are answers to the
 * question, not data, and without this they become selectable "drugs" —
 * "not specified in passage" was the single most common term extracted from a
 * real set of package inserts, ahead of every actual drug.
 */
const PLACEHOLDER = /^(n\/?a|none|null|unknown|unspecified|not (specified|stated|applicable|listed|mentioned|given|provided|available)( in (the )?(passage|text|document))?|see (above|below|label)|various|multiple)$/i;

export const isPlaceholder = (term) => PLACEHOLDER.test(String(term).trim());

/**
 * Every string worth matching on, from one chunk's value for `key`.
 *
 * Extraction may produce either plain strings (["aspirin"]) or objects
 * ({generic, brand, drugClass}), and both have to work — a drug recorded only
 * under its brand name must still match someone who typed the generic.
 *
 * `fields` restricts which keys of an object are read. Matching wants
 * everything, so that typing a class still finds its drugs; the selectable
 * list wants names only, so a dropdown of medications is not half full of
 * pharmacological categories.
 */
export function termsFrom(chunk, key, { fields = null } = {}) {
  const terms = new Set();
  const add = (v) => {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t && !isPlaceholder(t)) terms.add(t.toLowerCase());
  };

  const walk = (value, depth = 0) => {
    if (depth > 2 || value == null) return;
    if (typeof value === 'string') return add(value);
    if (Array.isArray(value)) return value.forEach(v => walk(v, depth + 1));
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (fields && depth > 0 && !fields.includes(k)) continue;
        walk(v, depth + 1);
      }
    }
  };

  walk(chunk?.extras?.[key]);
  return terms;
}

/**
 * Does this chunk mention any of the active terms?
 *
 * Substring both ways, because labeling is inconsistent about salt forms and
 * qualifiers: a reader types "atorvastatin", the label says "atorvastatin
 * calcium", the interaction table says "Atorvastatin". Requiring exact equality
 * would silently drop all three cases, and a silent miss here reads as "your
 * documents don't mention that drug".
 */
export function matches(chunk, key, active) {
  if (!active?.length) return false;
  const terms = termsFrom(chunk, key);
  if (terms.size === 0) return false;

  for (const wanted of active) {
    const w = String(wanted).trim().toLowerCase();
    if (!w) continue;
    for (const t of terms) {
      if (t === w || t.includes(w) || w.includes(t)) return true;
    }
  }
  return false;
}

/**
 * Re-rank so preferred passages rise, then take the top `limit`.
 *
 * The boost is additive on a cosine score that in practice sits around
 * 0.5-0.7, so ~0.12 reliably lifts a relevant match above an unpreferred one
 * without letting a weak match outrank a strong one. Setting it near 1 would
 * make it a hard filter by another name.
 *
 * Stable within a tier: equal scores keep the order the store returned.
 */
export function preferRank(results, { key, active, boost = 0.12, limit = 10 } = {}) {
  if (!key || !active?.length) return results.slice(0, limit);

  const scored = results.map((r, i) => {
    const hit = matches(r, key, active);
    return { r, i, hit, score: (r.score ?? 0) + (hit ? boost : 0) };
  });

  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));

  return scored.slice(0, limit).map(({ r, hit }) => ({ ...r, preferred: hit }));
}

/**
 * Make sure every active term is represented in the results.
 *
 * Ranking alone does not do this. Scores are per passage, not per term, so a
 * question spanning four drugs returns whichever passages are nearest the
 * question — and the drug with the most pages wins every slot. A real case:
 * four drugs on the list, topK 10, and the two rosuvastatin inserts (half the
 * documents) took every slot. Amlodipine had 24 embedded, tagged passages and
 * got none, so the answer reported it as not covered.
 *
 * A boost cannot fix that. It moves preferred passages up relative to
 * unpreferred ones, but every passage here was preferred; they were just
 * preferred for the same drug.
 *
 * So each term gets a guaranteed floor: its best-scoring passage in the pool,
 * appended if ranking did not already include one. Results can exceed `limit`
 * by up to one per uncovered term, which is the point — the alternative is an
 * answer that is silently blind to one of the things it was asked about.
 */
export function coverActive(selected, pool, { key, active, limit = 1 } = {}) {
  if (!key || !active?.length) return { results: selected, uncovered: [] };

  const results = [...selected];
  const seen = new Set(results.map(r => r.id));
  const uncovered = [];

  for (const term of active) {
    if (results.some(r => matches(r, key, [term]))) continue;

    // Best-scoring passages for this term that ranking left behind. The pool
    // is already score-ordered, so position is the ranking.
    const found = pool.filter(r => !seen.has(r.id) && matches(r, key, [term])).slice(0, limit);
    if (found.length === 0) {
      // Nothing anywhere in the pool. The caller can search specifically for
      // it — only the caller can embed a new query.
      uncovered.push(term);
      continue;
    }
    for (const r of found) {
      seen.add(r.id);
      results.push({ ...r, preferred: true, coveredFor: term });
    }
  }

  return { results, uncovered };
}

/**
 * Every distinct term present across a set of chunks, for offering choices.
 *
 * Only what the documents actually contain — selecting something with nothing
 * behind it produces an empty answer and looks like a bug.
 */
export function availableTerms(values, key, { limit = 500, fields = null } = {}) {
  const counts = new Map();
  for (const v of values) {
    // Accepts either whole chunks or bare extras values, so a caller can pass
    // a cheap projection instead of loading every chunk's text.
    const chunkLike = (v && typeof v === 'object' && 'extras' in v) ? v : { extras: { [key]: v } };
    for (const t of termsFrom(chunkLike, key, { fields })) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, chunks]) => ({ term, chunks }));
}
