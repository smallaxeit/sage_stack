/**
 * subjects.test.js — subject profile loading, validation, and prompt assembly.
 *
 *   node --test server/lib/subjects.test.js
 *
 * The real subjects/ directory is exercised too, so a malformed profile that
 * someone commits fails here rather than at runtime on a live question.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  normaliseProfile, loadSubject, listSubjects, buildSystemPrompt,
  renderConceptMap, renderExtractSchema, subjectSourceDir, renderGrounding,
  DEFAULT_RULES, DEFAULT_GROUNDING, GROUNDING_MODES, INGEST_MODES, EMBED_DRIVERS,
} from './subjects.js';

const MINIMAL = { voice: 'You are a test teacher.' };

describe('normaliseProfile — defaults', () => {
  test('a minimal profile gets sane defaults', () => {
    const p = normaliseProfile('demo', MINIMAL);
    assert.equal(p.slug, 'demo');
    assert.equal(p.name, 'demo', 'name falls back to slug');
    assert.equal(p.ingest.mode, 'auto');
    assert.equal(p.ingest.chunkTarget, 1400);
    assert.equal(p.embed.driver, 'voyage');
    assert.equal(p.embed.model, 'voyage-3.5');
    assert.equal(p.embed.dim, 1024);
    assert.equal(p.retrieval.topK, 10);
    assert.equal(p.conceptMap.enabled, false, 'concept map is opt-in');
    assert.deepEqual(p.extract, {});
    assert.equal(p.rules, DEFAULT_RULES);
    assert.deepEqual(p.grounding, { mode: 'grounded', instruction: null });
  });

  test('the default rules are domain-neutral', () => {
    // A service-manual subject inherits these, so they must not mention
    // scripture, traditions, students, or theology.
    for (const word of ['scripture', 'theolog', 'tradition', 'sacred', 'doctrin']) {
      assert.ok(!DEFAULT_RULES.toLowerCase().includes(word),
        `DEFAULT_RULES leaks theology vocabulary: "${word}"`);
      assert.ok(!DEFAULT_GROUNDING.toLowerCase().includes(word),
        `DEFAULT_GROUNDING leaks theology vocabulary: "${word}"`);
    }
  });

  test('nested blocks merge rather than replace', () => {
    const p = normaliseProfile('demo', { ...MINIMAL, embed: { dim: 768, driver: 'local' } });
    assert.equal(p.embed.dim, 768);
    assert.equal(p.embed.driver, 'local');
    assert.equal(p.embed.model, 'voyage-3.5', 'unspecified keys keep their default');
  });
});

describe('normaliseProfile — validation', () => {
  test('voice is required', () => {
    assert.throws(() => normaliseProfile('demo', {}), /non-empty "voice" is required/);
    assert.throws(() => normaliseProfile('demo', { voice: '   ' }), /non-empty "voice" is required/);
  });

  test('slug must be valid and must match the directory', () => {
    assert.throws(() => normaliseProfile('Bad-Slug', MINIMAL), /Invalid subject slug/);
    assert.throws(() => normaliseProfile('../escape', MINIMAL), /Invalid subject slug/);
    assert.throws(
      () => normaliseProfile('demo', { ...MINIMAL, slug: 'other' }),
      /declares slug "other" but lives in directory "demo"/,
    );
  });

  test('enums are checked', () => {
    assert.throws(() => normaliseProfile('demo', { ...MINIMAL, ingest: { mode: 'ocr' } }), /ingest\.mode must be one of/);
    assert.throws(() => normaliseProfile('demo', { ...MINIMAL, embed: { driver: 'openai' } }), /embed\.driver must be one of/);
    for (const mode of INGEST_MODES) {
      assert.equal(normaliseProfile('demo', { ...MINIMAL, ingest: { mode } }).ingest.mode, mode);
    }
    for (const driver of EMBED_DRIVERS) {
      assert.equal(normaliseProfile('demo', { ...MINIMAL, embed: { driver } }).embed.driver, driver);
    }
  });

  test('numeric fields are checked', () => {
    assert.throws(() => normaliseProfile('demo', { ...MINIMAL, embed: { dim: 0 } }), /embed\.dim/);
    assert.throws(() => normaliseProfile('demo', { ...MINIMAL, embed: { dim: 1024.5 } }), /embed\.dim/);
    assert.throws(() => normaliseProfile('demo', { ...MINIMAL, retrieval: { topK: -1 } }), /retrieval\.topK/);
    assert.throws(
      () => normaliseProfile('demo', { ...MINIMAL, ingest: { chunkTarget: 2000, chunkMax: 1000 } }),
      /chunkMax >= chunkTarget/,
    );
  });

  test('extract must map field -> description string', () => {
    assert.throws(() => normaliseProfile('demo', { ...MINIMAL, extract: ['a'] }), /extract must be an object/);
    assert.throws(() => normaliseProfile('demo', { ...MINIMAL, extract: { specs: '' } }), /extract\.specs/);
    assert.throws(() => normaliseProfile('demo', { ...MINIMAL, extract: { specs: 42 } }), /extract\.specs/);
  });
});

describe('grounding modes', () => {
  test('accepts a mode name', () => {
    const p = normaliseProfile('demo', { ...MINIMAL, grounding: { mode: 'strict' } });
    assert.equal(p.grounding.mode, 'strict');
    assert.match(renderGrounding(p), /GROUNDING — STRICT/);
  });

  test('a legacy string is kept verbatim', () => {
    // The first subject.json files used a plain string; silently changing what
    // they do would be worse than carrying the shape.
    const p = normaliseProfile('demo', { ...MINIMAL, grounding: 'ONLY use the passages.' });
    assert.equal(p.grounding.mode, 'custom');
    assert.equal(renderGrounding(p), 'ONLY use the passages.');
  });

  test('a mode can be extended with extra instruction text', () => {
    const p = normaliseProfile('demo', {
      ...MINIMAL,
      grounding: { mode: 'strict', instruction: 'Never mention church councils.' },
    });
    const text = renderGrounding(p);
    assert.match(text, /GROUNDING — STRICT/);
    assert.match(text, /Never mention church councils\./);
  });

  test('rejects an unknown mode, and a custom mode with no text', () => {
    assert.throws(() => normaliseProfile('demo', { ...MINIMAL, grounding: { mode: 'loose' } }),
      /grounding\.mode must be one of/);
    assert.throws(() => normaliseProfile('demo', { ...MINIMAL, grounding: { mode: 'custom' } }),
      /custom grounding needs instruction text/);
  });

  test('strict forbids naming absent sources, not just using them', () => {
    // The observed failure was an answer that named Ignatius, Justin Martyr,
    // Constantine and Laodicea *while* saying they were not in the corpus.
    // Disclaiming a claim still puts it in front of the reader.
    const strict = GROUNDING_MODES.strict;
    assert.match(strict, /not even to say they are absent/i);
    assert.match(strict, /overrides any\s*\n?part of your persona/i);
  });

  test('grounding is the LAST instruction in the prompt', () => {
    // It is the constraint most likely to be contradicted by an expansive
    // persona, so it gets the recency position.
    const p = normaliseProfile('demo', {
      voice: 'VOICE', rules: 'RULES', modes: { deep: 'MODE-DEEP' },
      grounding: { mode: 'strict' },
    });
    const prompt = buildSystemPrompt(p, { mode: 'deep' });
    assert.ok(prompt.indexOf('GROUNDING — STRICT') > prompt.indexOf('MODE-DEEP'),
      'grounding must come after the mode instruction');
    assert.ok(prompt.indexOf('GROUNDING — STRICT') > prompt.indexOf('VOICE'));
    assert.ok(prompt.trimEnd().endsWith(GROUNDING_MODES.strict.trim()),
      'grounding must be the final block');
  });

  test('no mode lets the model claim the collection lacks something', () => {
    // The failure this prevents: SageStack told the user there is no Book of
    // Enoch, when the Ethiopian Orthodox Bible — its largest source, 2,124
    // chunks — contains it and retrieval finds it easily.
    //
    // Retrieval returns topK passages. Absence from those is not absence from
    // the collection, and the model cannot see the difference. Any mode that
    // permits a "not in the collection" claim will eventually make a false one.
    for (const mode of ['strict', 'grounded']) {
      const text = GROUNDING_MODES[mode];
      assert.match(text, /not the whole\s*\n?\s*collection|whole\s*\n?\s*collection/i,
        `${mode} must state the passages are a subset`);
      assert.match(text, /never say|never that/i,
        `${mode} must forbid claiming something is absent from the collection`);
    }
  });

  test('committed subjects never assert what their corpus lacks', async () => {
    const { subjects } = await listSubjects();
    for (const p of subjects) {
      const text = (p.grounding.instruction || '') + '\n' + p.voice;

      // Split into sentences and drop the ones that FORBID such a claim —
      // "Never assert what this collection does or does not contain" is the
      // cure, not the disease.
      const claims = text
        .split(/(?<=[.!?])\s+|\n+/)
        .filter(sentence => !/\b(never|don'?t|do not|avoid|rather than)\b/i.test(sentence));

      // "contains no X" / "there is no X" are the shapes that produced a false
      // denial. A subject may describe what it IS, not what it is not.
      const offender = claims.find(sentence =>
        /\bcontains no\b|\bdoes not contain\b|\bthere (?:is|are) no\b|\bit has no\b/i.test(sentence));

      assert.ok(!offender,
        `subject "${p.slug}" asserts an absence the model will repeat: ${JSON.stringify(offender)}`);
    }
  });

  test('every mode is domain-neutral', () => {
    for (const [name, text] of Object.entries(GROUNDING_MODES)) {
      for (const word of ['scripture', 'theolog', 'tradition', 'sacred', 'torque']) {
        assert.ok(!text.toLowerCase().includes(word), `${name} leaks "${word}"`);
      }
    }
  });
});

describe('prompt assembly', () => {
  const profile = normaliseProfile('demo', {
    voice: 'VOICE-TEXT',
    rules: 'RULES-TEXT',
    grounding: 'GROUNDING-TEXT',
    modes: { quick: 'QUICK-TEXT', deep: 'DEEP-TEXT' },
  });

  test('assembles voice, rules, grounding and mode', () => {
    const prompt = buildSystemPrompt(profile, { mode: 'deep' });
    for (const part of ['VOICE-TEXT', 'RULES-TEXT', 'GROUNDING-TEXT', 'DEEP-TEXT']) {
      assert.ok(prompt.includes(part), `missing ${part}`);
    }
    assert.ok(!prompt.includes('QUICK-TEXT'));
    assert.ok(prompt.indexOf('VOICE-TEXT') < prompt.indexOf('GROUNDING-TEXT'), 'voice leads');
  });

  test('mode selects the right instruction and falls back to deep', () => {
    assert.ok(buildSystemPrompt(profile, { mode: 'quick' }).includes('QUICK-TEXT'));
    assert.ok(buildSystemPrompt(profile, { mode: 'nonsense' }).includes('DEEP-TEXT'));
  });

  test('concept map is omitted unless the subject opts in', () => {
    const map = { coreThemes: ['grace'], concepts: [{ name: 'x', description: 'y' }] };
    assert.equal(renderConceptMap(profile, map), '', 'disabled subject must render nothing');
    assert.ok(!buildSystemPrompt(profile, { conceptMap: map }).includes('grace'));

    const on = normaliseProfile('demo', { voice: 'v', conceptMap: { enabled: true, label: 'MY MAP' } });
    const rendered = renderConceptMap(on, map);
    assert.ok(rendered.includes('MY MAP'));
    assert.ok(rendered.includes('grace'));
    assert.ok(buildSystemPrompt(on, { conceptMap: map }).includes('grace'));
  });

  test('an enabled subject with no concept map yet renders nothing', () => {
    const on = normaliseProfile('demo', { voice: 'v', conceptMap: { enabled: true } });
    assert.equal(renderConceptMap(on, null), '');
  });

  test('renderExtractSchema turns the extract block into schema lines', () => {
    assert.equal(renderExtractSchema(profile), '', 'no extract fields -> empty');
    const withExtract = normaliseProfile('demo', { voice: 'v', extract: { specs: 'torque values' } });
    const schema = renderExtractSchema(withExtract);
    assert.ok(schema.includes('"specs"'));
    assert.ok(schema.includes('torque values'));
  });
});

describe('loading from disk', () => {
  test('a missing subject gives a clear error', async () => {
    await assert.rejects(() => loadSubject('definitely_absent'), /No such subject/);
  });

  test('malformed JSON is reported as such', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sagestack-subj-'));
    try {
      await fs.mkdir(path.join(root, 'broken'), { recursive: true });
      await fs.writeFile(path.join(root, 'broken', 'subject.json'), '{ not json');
      await assert.rejects(() => loadSubject('broken', { root }), /not valid JSON/);

      // listSubjects reports the bad one instead of throwing
      const { subjects, errors } = await listSubjects({ root });
      assert.equal(subjects.length, 0);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].slug, 'broken');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('subjectSourceDir points inside the subject', () => {
    assert.ok(subjectSourceDir('theology').replace(/\\/g, '/').endsWith('subjects/theology/source'));
  });
});

describe('the real subjects/ directory', () => {
  test('every committed profile is valid', async () => {
    const { subjects, errors } = await listSubjects();
    assert.deepEqual(errors, [], 'a committed subject.json failed validation');
    assert.ok(subjects.length >= 2, 'expected at least theology and softail');
  });

  test('theology reproduces the original SageStack prompt', async () => {
    const p = await loadSubject('theology');
    assert.equal(p.name, 'SageStack');
    assert.equal(p.conceptMap.enabled, true);
    assert.equal(p.ingest.mode, 'text');

    const prompt = buildSystemPrompt(p, { mode: 'deep' });
    // Distinctive phrases from the hardcoded prompt this replaces. The
    // grounding clause is deliberately NOT among them — the original
    // ("YOU DRAW ONLY FROM THE SCRIPTURE…") was replaced by strict mode after
    // it failed to hold against this very voice.
    for (const phrase of [
      'John Keating from Dead Poets Society',
      'Carpe diem',
      'soteriology, eschatology, kenosis, apophatic',
      'WELCOME ALL QUESTIONS',
      'RESPONSE MODE: Deep',
    ]) {
      assert.ok(prompt.includes(phrase), `theology prompt lost: "${phrase}"`);
    }
    assert.ok(buildSystemPrompt(p, { mode: 'quick' }).includes('RESPONSE MODE: Quick'));

    // The voice must no longer ask for material the corpus cannot supply.
    assert.equal(p.grounding.mode, 'strict');
    assert.ok(!p.voice.includes('names, dates, textual sources, historical context'),
      'the voice still instructs the model to supply external history');
    assert.ok(prompt.trimEnd().endsWith(
      [GROUNDING_MODES.strict, p.grounding.instruction].join('\n\n').trim(),
    ), 'strict grounding must be the final instruction');
  });

  test('softail is a genuinely different subject, not theology with a new name', async () => {
    const p = await loadSubject('softail');
    assert.equal(p.ingest.mode, 'vision', 'scanned manual needs vision ingestion');
    assert.equal(p.conceptMap.enabled, false);
    assert.equal(p.retrieval.topK, 5);

    const prompt = buildSystemPrompt(p);
    assert.ok(!prompt.includes('Keating'), 'theology voice leaked into softail');
    assert.ok(!prompt.toLowerCase().includes('scripture'));
    assert.ok(prompt.includes('torque'));

    // The extract blocks are disjoint — this is the whole point of §5.
    const theology = await loadSubject('theology');
    const overlap = Object.keys(p.extract).filter(k => k in theology.extract);
    assert.deepEqual(overlap, [], `subjects share extract fields: ${overlap.join(', ')}`);
  });
});
