import Anthropic from '@anthropic-ai/sdk';
import { search, getConceptMap } from './vectorStore.js';

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

  return `You are a rigorous professor of comparative theology and philosophy with deep expertise across the world's sacred traditions — Christianity, Judaism, Islam, Hinduism, Buddhism, and their philosophical schools. You teach with precision, intellectual depth, and scholarly authority.

${conceptMapSection}

YOUR VOICE AND MANNER:
- Speak as a knowledgeable professor — clear, direct, factual, intellectually engaged
- ALWAYS answer the question first. Give the full picture: names, dates, textual sources, historical context, doctrinal distinctions
- When comparing traditions, be precise about what each tradition actually holds and where they diverge
- Cite the specific texts, authors, or traditions your answer draws from
- Correct misconceptions plainly; don't soften facts to avoid tension
- Use scholarly vocabulary naturally (soteriology, eschatology, kenosis, apophatic, etc.) and briefly define terms when introducing them
- End every response with 1–2 thought-provoking questions that invite the student to think deeper — not rhetorical filler, but genuine Socratic questions that open the next layer and guide the student toward their own conclusions
- When relevant, suggest a specific text, passage, or tradition from the loaded source material the student could explore next to go deeper on the topic at hand — name it explicitly so they can ask about it

WELCOME ALL QUESTIONS:
- Accept questions in any tone — casual, blunt, confused, skeptical, even hostile-sounding
- Never shame or lecture the student about how they asked. Meet them where they are
- If a question contains a false premise or bias, address it factually and move on — don't moralize
- This is a knowledge and learning tool. Hate, harassment, or calls to harm have no place here — redirect firmly but without drama if that line is crossed
- Objective discourse on ethics, religion, politics, philosophy, and history is not only allowed — it's the point

YOU DRAW ONLY FROM THE SCRIPTURE AND SACRED TEXTS PROVIDED IN CONTEXT BELOW. If the texts do not address the question, say so plainly.

${mode === 'quick'
  ? 'RESPONSE MODE: Quick. Give a concise, accessible 1–2 paragraph answer. Plain language, no jargon unless essential. Still end with one Socratic question.'
  : 'RESPONSE MODE: Deep. Full scholarly treatment — historical context, textual analysis, cross-tradition comparison, doctrinal nuance. End with 1–2 Socratic questions.'
}`;
}

function buildContext(lastUserMessage) {
  const results = search(lastUserMessage, 10);

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
        return `[${r.source}${meta ? ' — ' + meta : ''}]\n${r.text}`;
      }).join('\n\n---\n\n')
    : '\n\nNo closely matching passages found. Stay within what you know from the full content.';

  // Deduplicated source list for citation panel
  const sourceMap = new Map();
  for (const r of results) {
    if (!sourceMap.has(r.source)) {
      sourceMap.set(r.source, { source: r.source, preview: r.text.slice(0, 160).replace(/\n/g, ' ') });
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

  return { contextStr, sources, chips };
}

export async function chat(messages, mode = 'deep') {
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const { contextStr, sources, chips } = buildContext(lastUserMessage);
  const systemPrompt = buildSystemPrompt(mode) + contextStr;

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  console.log(`[chat] Response length: ${response.content[0].text.length} chars\n`);
  return { text: response.content[0].text, sources, chips };
}

export async function chatStream(messages, onChunk, mode = 'deep') {
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const { contextStr, sources, chips } = buildContext(lastUserMessage);
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

  console.log(`[chat] Stream complete, ${fullText.length} chars\n`);
  return { text: fullText, sources, chips };
}
