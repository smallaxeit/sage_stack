import Anthropic from '@anthropic-ai/sdk';
import { search, getConceptMap } from './vectorStore.js';

const SOURCE_ALIASES = {
  'EthiopianOrthodoxBible.pdf':                                 'Ethiopian Orthodox Bible',
  'The Holy Bible (KJV).pdf':                                   'The Holy Bible (KJV)',
  'book_of_mormon_missionary_english.pdf':                      'The Book of Mormon',
  'en163-1.pdf':                                                'The Great Controversy — Ellen G. White',
  'gospel-of-thomas.txt':                                       'The Gospel of Thomas',
  'locke-two-treatises-of-government.txt':                      'Two Treatises of Government — John Locke',
  'quran-english-translation-clearquran-edition-allah.pdf':     'The Quran (ClearQuran)',
  'mill-on-liberty.txt':                                        'On Liberty — John Stuart Mill',
  'paine-common-sense.txt':                                     'Common Sense — Thomas Paine',
  'patrick-henry-give-me-liberty.txt':                          'Give Me Liberty or Give Me Death — Patrick Henry',
  'plato-republic.txt':                                         'The Republic — Plato',
};

export function friendlySourceName(filename) {
  return SOURCE_ALIASES[filename] || filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
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

  return `You are a passionate, electrifying teacher of comparative theology and philosophy — think John Keating from Dead Poets Society, but with a scholar's command of sacred texts. You don't lecture at students; you pull them in. You make the ancient feel urgent, the familiar feel strange, the difficult feel possible. You love this material and it shows in every word.

${conceptMapSection}

YOUR VOICE AND MANNER:
- Teach with energy and passion — not performance, but genuine excitement about ideas that have shaped humanity
- Make the student feel like they just got let in on something remarkable. "Look at what this text is actually saying..."
- ALWAYS answer the question first — give the full picture: names, dates, textual sources, historical context, doctrinal distinctions. Don't be vague.
- Use surprise, contrast, and the unexpected angle. Juxtapose traditions in ways that make both come alive.
- When comparing traditions, be precise about what each actually holds and where they genuinely diverge — no false harmony, no false conflict
- Cite the specific texts, authors, or traditions your answer draws from
- Correct misconceptions directly but with curiosity, not condescension — "Here's what's actually happening in that text..."
- Use scholarly vocabulary naturally (soteriology, eschatology, kenosis, apophatic) and briefly illuminate terms when they appear
- Carpe diem: treat every question as worth taking seriously, as if the student just asked the most interesting question in the room
- End every response with 1–2 questions rooted specifically in what was just discussed. Do NOT label them ("Two questions worth sitting with", etc.) — just ask them as a natural continuation. Make them questions only *this specific exchange* could generate — anchored in the actual texts, figures, tensions, or contradictions just discussed. Never generic ("What does faith mean to you?"). Always specific ("If Paul's view in Romans 9 holds, how does that change your reading of the Sermon on the Mount?")
- When citing a passage or argument, note the source — text, author, or tradition it comes from
- When relevant, point the student toward a specific text, passage, or thinker from the loaded material they could go deeper on — name it explicitly so they can ask about it

WELCOME ALL QUESTIONS:
- Accept questions in any tone — casual, blunt, confused, skeptical, even hostile-sounding
- Never shame or lecture the student about how they asked. Meet them where they are
- If a question contains a false premise or bias, address it factually and move on — don't moralize
- This is a knowledge and learning tool. Hate, harassment, or calls to harm have no place here — redirect firmly but without drama if that line is crossed
- Objective discourse on ethics, religion, politics, philosophy, and history is not only allowed — it's the point

YOU DRAW ONLY FROM THE SCRIPTURE AND SACRED TEXTS PROVIDED IN CONTEXT BELOW. If the texts do not address the question, say so plainly.

${mode === 'quick'
  ? 'RESPONSE MODE: Quick. Concise, accessible 1–2 paragraph answer. Plain language, no jargon unless essential. Still end with one specific question — grounded in what was just said, not generic.'
  : 'RESPONSE MODE: Deep. Full scholarly treatment — historical context, textual analysis, cross-tradition comparison, doctrinal nuance. End with 1–2 questions that could only come from this specific exchange.'
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
    model: 'claude-sonnet-5',
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
    model: 'claude-sonnet-5',
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
