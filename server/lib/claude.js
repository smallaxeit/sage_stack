import Anthropic from '@anthropic-ai/sdk';
import { search, getConceptMap, getSources } from './vectorStore.js';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const SOURCE_NAMES = {
  'The Holy Bible (KJV).pdf':                                  'The Holy Bible — King James Version (KJV)',
  'EthiopianOrthodoxBible.pdf':                                'Ethiopian Orthodox Bible (includes deuterocanonical & Enochic texts)',
  'Torah.pdf':                                                 'The Torah (Hebrew Bible)',
  'quran-english-translation-clearquran-edition-allah.pdf':    'The Quran (ClearQuran English translation)',
  'quran-rodwell-translation.txt':                             'The Quran (Rodwell English translation)',
  'the-4-vedas.pdf':                                           'The Four Vedas (Rig, Sama, Yajur, Atharva)',
  'en163-1.pdf':                                               'The Great Controversy — Ellen G. White (Seventh-day Adventist)',
  'locke-two-treatises-of-government.txt':                     'Two Treatises of Government — John Locke',
  'gospel-of-thomas.txt':                                      'The Gospel of Thomas (Nag Hammadi, Lambdin translation)',
  'book_of_mormon_missionary_english.pdf':                     'The Book of Mormon',
  'plato-republic.txt':                                        'The Republic — Plato',
  'plato-phaedo.txt':                                          'Phaedo — Plato',
  'plato-meno.txt':                                            'Meno — Plato',
  'aristotle-nicomachean-ethics.txt':                          'Nicomachean Ethics — Aristotle',
  'aristotle-politics.txt':                                    'Politics — Aristotle',
  'marcus-aurelius-meditations.txt':                           'Meditations — Marcus Aurelius',
  'epictetus-discourses.txt':                                  'Discourses — Epictetus',
  'hobbes-leviathan.txt':                                      'Leviathan — Thomas Hobbes',
  'rousseau-social-contract.txt':                              'The Social Contract — Jean-Jacques Rousseau',
  'mill-utilitarianism.txt':                                   'Utilitarianism — John Stuart Mill',
  'mill-on-liberty.txt':                                       'On Liberty — John Stuart Mill',
  'aquinas-summa-theologica-selections.txt':                   'Summa Theologica (selections) — Thomas Aquinas',
  'hume-enquiry-concerning-human-understanding.txt':           'Enquiry Concerning Human Understanding — David Hume',
  'kant-groundwork-metaphysics-of-morals.txt':                 'Groundwork for the Metaphysics of Morals — Immanuel Kant',
  'descartes-meditations-on-first-philosophy.txt':             'Meditations on First Philosophy — René Descartes',
  'nietzsche-beyond-good-and-evil.txt':                        'Beyond Good and Evil — Friedrich Nietzsche',
  'nietzsche-thus-spoke-zarathustra.txt':                      'Thus Spoke Zarathustra — Friedrich Nietzsche',
  'bastiat-the-law.txt':                                       'The Law — Frédéric Bastiat',
  'paine-rights-of-man.txt':                                   'Rights of Man — Thomas Paine',
  'paine-common-sense.txt':                                    'Common Sense — Thomas Paine',
  'jefferson-declaration-of-independence.txt':                 'The Declaration of Independence — Thomas Jefferson',
  'jefferson-notes-on-the-state-of-virginia.txt':             'Notes on the State of Virginia — Thomas Jefferson',
  'madison-hamilton-jay-federalist-papers.txt':                'The Federalist Papers — Madison, Hamilton & Jay',
  'franklin-autobiography.txt':                                'The Autobiography of Benjamin Franklin',
  'franklin-poor-richards-almanack.txt':                       'Poor Richard\'s Almanack — Benjamin Franklin',
  'washington-farewell-address.txt':                           'Farewell Address — George Washington',
  'patrick-henry-give-me-liberty.txt':                         'Give Me Liberty or Give Me Death — Patrick Henry',
};

export function friendlySourceName(filename) {
  return SOURCE_NAMES[filename] || filename.replace(/\.(pdf|txt|md)$/i, '').replace(/[-_]/g, ' ');
}

function buildSystemPrompt(mode = 'deep') {
  const conceptMap = getConceptMap();

  const conceptMapSection = conceptMap ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THEOLOGICAL KNOWLEDGE MAP
(Your full understanding of this subject — use it to guide students)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CORE THEMES:
${(conceptMap.coreThemes || []).join(', ')}

SUGGESTED LEARNING PATH:
${(conceptMap.learningPath || []).join(' → ')}

KEY CONCEPTS AND RELATIONSHIPS:
${(conceptMap.concepts || []).map(c =>
  `• ${c.name}: ${c.description}${c.relatedConcepts?.length ? ` [related: ${c.relatedConcepts.join(', ')}]` : ''}`
).join('\n')}

CONCEPTUAL RELATIONSHIPS:
${(conceptMap.relationships || []).map(r =>
  `• ${r.from} ${r.type} ${r.to}: ${r.description}`
).join('\n')}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : '';

  return `You are a rigorous professor of comparative theology and philosophy with deep expertise across the world's sacred traditions — Christianity, Judaism, Islam, Hinduism, Buddhism, and their philosophical schools. You teach with precision, intellectual depth, and scholarly authority.

${conceptMapSection}

YOUR VOICE AND MANNER:
- Speak as a knowledgeable professor — clear, direct, factual, intellectually engaged
- ALWAYS answer the question first. Give the full picture: names, dates, textual sources, historical context, doctrinal distinctions
- When comparing traditions, be precise about what each tradition actually holds and where they diverge
- Cite the specific texts, authors, or traditions your answer draws from
- Correct misconceptions plainly; don't soften facts to avoid tension
- Use scholarly vocabulary naturally (soteriology, eschatology, kenosis, apophatic, etc.) and briefly define terms when introducing them
- End every response with 1–2 genuine questions that push the student to the next layer — not rhetorical filler, but questions that open something unresolved or worth sitting with
- When citing a passage or argument, note the source — text, author, or tradition it comes from
- When relevant, point the student toward a specific text, passage, or thinker from the loaded material they could go deeper on — name it explicitly so they can ask about it

WELCOME ALL QUESTIONS:
- Accept questions in any tone — casual, blunt, confused, skeptical, even hostile-sounding
- Never shame or lecture the student about how they asked. Meet them where they are
- If a question contains a false premise or bias, address it factually and move on — don't moralize
- This is a knowledge and learning tool. Hate, harassment, or calls to harm have no place here — redirect firmly but without drama if that line is crossed
- Objective discourse on ethics, religion, politics, philosophy, and history is not only allowed — it's the point

LOADED SOURCE TEXTS:
${getSources().map(s => `• ${friendlySourceName(s)}`).join('\n')}

You have deep knowledge of all the sources listed above. The passages below are the most relevant excerpts for this specific question — use them as your primary reference, but do not tell the student a source is unavailable if it appears in the list above. If a specific passage isn't in the context window, draw on your broader knowledge of that text.

${mode === 'quick'
  ? 'RESPONSE MODE: Quick. Concise, accessible 1–2 paragraph answer. Plain language, no jargon unless essential. Still end with one question worth thinking about.'
  : 'RESPONSE MODE: Deep. Full scholarly treatment — historical context, textual analysis, cross-tradition comparison, doctrinal nuance. End with 1–2 questions that open the next layer.'
}`;
}

async function buildContext(lastUserMessage) {
  const results = await search(lastUserMessage, 10);

  console.log(`\n[chat] Query: "${lastUserMessage.slice(0, 80)}"`);
  console.log(`[chat] Retrieved ${results.length} chunks:`);
  results.forEach((r, i) => console.log(`  ${i + 1}. [${r.source}] ${r.text.slice(0, 80).replace(/\n/g, ' ')}...`));

  const contextStr = results.length > 0
    ? `\n\nRELEVANT SOURCE PASSAGES:\n` +
      results.map(r => {
        const meta = [
          r.concepts.length ? `Concepts: ${r.concepts.join(', ')}` : '',
          r.scriptureRefs.length ? `Scripture: ${r.scriptureRefs.join(', ')}` : '',
        ].filter(Boolean).join(' | ');
        return `[${friendlySourceName(r.source)}${meta ? ' — ' + meta : ''}]\n${r.text}`;
      }).join('\n\n---\n\n')
    : '\n\nNo closely matching passages found. Stay within what you know from the full content.';

  // Deduplicated source list for citation panel
  const sourceMap = new Map();
  for (const r of results) {
    if (!sourceMap.has(r.source)) {
      sourceMap.set(r.source, { source: friendlySourceName(r.source), preview: r.text.slice(0, 160).replace(/\n/g, ' ') });
    }
  }
  const sources = [...sourceMap.values()];

  // Chips: top concepts + scripture refs from retrieved chunks
  const seen = new Set();
  const chips = [];
  for (const r of results) {
    for (const c of [...(r.concepts || []), ...(r.scriptureRefs || [])]) {
      if (c && !seen.has(c) && chips.length < 6) { seen.add(c); chips.push(c); }
    }
  }

  // Analytics metadata — subjects/themes aggregated from retrieved chunks
  const allSubjects = [...new Set(results.flatMap(r => r.concepts || []))].slice(0, 20);
  const allThemes   = [...new Set(results.flatMap(r => r.themes   || []))].slice(0, 10);
  const chunkRefs   = results.map(r => ({ source: r.source, chunk_index: r.chunk_index }));

  return { contextStr, sources, chips, analytics: { subjects: allSubjects, themes: allThemes, chunkRefs } };
}

export async function chat(messages, mode = 'deep') {
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const { contextStr, sources, chips, analytics } = await buildContext(lastUserMessage);
  const systemPrompt = buildSystemPrompt(mode) + contextStr;

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  console.log(`[chat] Response length: ${response.content[0].text.length} chars\n`);
  return { text: response.content[0].text, sources, chips, analytics };
}

export async function chatStream(messages, onChunk, mode = 'deep') {
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const { contextStr, sources, chips, analytics } = await buildContext(lastUserMessage);
  const systemPrompt = buildSystemPrompt(mode) + contextStr;

  const stream = await getClient().messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  let fullText = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      fullText += event.delta.text;
      onChunk(event.delta.text);
    }
  }

  const finalMessage = await stream.finalMessage();
  const outputTokens = finalMessage?.usage?.output_tokens || 0;

  console.log(`[chat] Stream complete, ${fullText.length} chars, ${outputTokens} tokens\n`);
  return { text: fullText, sources, chips, analytics, outputTokens };
}
