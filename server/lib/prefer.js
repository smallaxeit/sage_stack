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
export function termsFrom(chunk, key) {
  const terms = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) terms.add(v.trim().toLowerCase());
  };

  const walk = (value, depth = 0) => {
    if (depth > 2 || value == null) return;
    if (typeof value === 'string') return add(value);
    if (Array.isArray(value)) return value.forEach(v => walk(v, depth + 1));
    if (typeof value === 'object') {
      for (const v of Object.values(value)) walk(v, depth + 1);
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
 * Every distinct term present across a set of chunks, for offering choices.
 *
 * Only what the documents actually contain — selecting something with nothing
 * behind it produces an empty answer and looks like a bug.
 */
export function availableTerms(values, key, { limit = 500 } = {}) {
  const counts = new Map();
  for (const v of values) {
    // Accepts either whole chunks or bare extras values, so a caller can pass
    // a cheap projection instead of loading every chunk's text.
    const chunkLike = (v && typeof v === 'object' && 'extras' in v) ? v : { extras: { [key]: v } };
    for (const t of termsFrom(chunkLike, key)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, chunks]) => ({ term, chunks }));
}
