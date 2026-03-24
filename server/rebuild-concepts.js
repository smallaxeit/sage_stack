#!/usr/bin/env node
/**
 * rebuild-concepts.js
 * Standalone script to rebuild just the concept map from existing knowledge-base.json
 * Run: node rebuild-concepts.js
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
try {
  const lines = readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n');
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq === -1 || line.trim().startsWith('#')) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key) process.env[key] = val; // always override — child process inherits parent env
  }
} catch {}

const KB_FILE   = path.join(__dirname, 'knowledge-base.json');
const META_FILE = path.join(__dirname, 'knowledge-meta.json');

const CONCEPT_MAP_PROMPT = (conceptData) => `You are a scholar of comparative theology and philosophy synthesizing a deep knowledge map from multiple sacred and philosophical texts.

The source material spans: ${conceptData.sources.join(', ')}

Here are the top concepts extracted from the material (by frequency):
${JSON.stringify(conceptData.concepts, null, 2)}

Philosophical arguments found:
${JSON.stringify(conceptData.arguments, null, 2)}

Build a comprehensive, scholarly concept map. Return JSON in this exact shape:
{
  "coreThemes": ["string"],
  "traditions": [
    {
      "name": "string",
      "sourceFiles": ["string"],
      "coreBeliefs": ["string"],
      "distinctiveConcepts": ["string"]
    }
  ],
  "concepts": [
    {
      "name": "string",
      "description": "string",
      "relatedConcepts": ["string"],
      "themes": ["string"],
      "traditions": ["string"],
      "sourceFiles": ["string"],
      "appearsAcrossTraditions": true
    }
  ],
  "relationships": [
    {
      "from": "string",
      "to": "string",
      "type": "string",
      "description": "string"
    }
  ],
  "crossTraditionParallels": [
    {
      "concept": "string",
      "traditions": ["string"],
      "description": "string"
    }
  ],
  "learningPath": ["string"]
}

Return ONLY valid JSON. No markdown fences. No explanation.`;

async function main() {
  console.log('Loading knowledge-base.json...');
  const kb = JSON.parse(await fs.readFile(KB_FILE, 'utf-8'));

  const chunks = kb.chunks || [];
  const meta = chunks.map(c => c.meta || {});
  const sources = [...new Set(chunks.map(c => c.source))];

  console.log(`  ${chunks.length} chunks from ${sources.length} sources`);

  // Build concept frequency map
  const freq = {};
  for (const m of meta) for (const c of (m.concepts || [])) freq[c] = (freq[c] || 0) + 1;
  const topConcepts = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([c]) => c);
  const allArgs = meta.flatMap(m => m.philosophicalArguments || []).slice(0, 25);

  console.log(`  Top concepts: ${topConcepts.length}, arguments sample: ${allArgs.length}`);
  console.log('\nCalling Claude Sonnet for concept map...');

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 600000, // 10 minutes
  });

  let conceptMap;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`  Attempt ${attempt}/3...`);
      // Use streaming to avoid connection timeouts on long responses
      let fullText = '';
      const stream = await client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{ role: 'user', content: CONCEPT_MAP_PROMPT({ sources, concepts: topConcepts, arguments: allArgs }) }],
      });
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          fullText += chunk.delta.text;
          process.stdout.write('.');
        }
      }
      console.log('');

      const raw = fullText.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
      conceptMap = JSON.parse(raw);
      console.log('  Success!');
      break;
    } catch (err) {
      console.error(`  Attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        console.log('  Retrying in 5s...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  if (!conceptMap) {
    console.error('All attempts failed. Exiting.');
    process.exit(1);
  }

  console.log(`\nConcept map built:`);
  console.log(`  ${conceptMap.concepts?.length || 0} concepts`);
  console.log(`  ${conceptMap.relationships?.length || 0} relationships`);
  console.log(`  ${conceptMap.traditions?.length || 0} traditions`);
  console.log(`  ${conceptMap.crossTraditionParallels?.length || 0} cross-tradition parallels`);
  console.log(`  ${conceptMap.coreThemes?.length || 0} core themes`);

  // Update knowledge-base.json with the new concept map
  kb.conceptMap = conceptMap;
  kb.meta = { ...kb.meta, totalConcepts: conceptMap.concepts?.length || 0 };

  await fs.writeFile(KB_FILE, JSON.stringify(kb));
  console.log('\n✓ knowledge-base.json updated with concept map.');

  // Also patch knowledge-meta.json so the server picks it up on next restart
  try {
    const metaRaw = await fs.readFile(META_FILE, 'utf-8');
    const meta = JSON.parse(metaRaw);
    meta.conceptMap = conceptMap;
    meta.totalConcepts = conceptMap.concepts?.length || 0;
    await fs.writeFile(META_FILE, JSON.stringify(meta, null, 2));
    console.log('✓ knowledge-meta.json updated.');
  } catch (err) {
    console.warn('Could not update knowledge-meta.json:', err.message);
  }
  console.log('Restart the server to load the new concepts.');
}

main();
