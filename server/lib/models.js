/**
 * models.js — which model does which job, and what it costs.
 *
 * Reads config/models.json. Code asks for a PURPOSE ("rewrite", "vision") and
 * this decides what runs it, so swapping a model is a config edit rather than
 * a grep across the server.
 *
 * That grep used to be the actual process, and it missed things: the vision
 * estimator carried its own price table quoting Sonnet at $2/$10 while the
 * chat path priced the same model at $3/$15.
 *
 * Precedence, narrowest first:
 *   1. an explicit argument in code
 *   2. the subject's own profile        (chat.model, embed.model, analysis.model)
 *   3. SAGESTACK_MODEL_<PURPOSE>        — for a one-off run
 *   4. config/models.json
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../config/models.json');

function load() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    // Every model call depends on this, so a missing or malformed config is
    // worth failing loudly at startup rather than at the first question.
    throw new Error(`Cannot read config/models.json: ${err.message}`);
  }
}

const config = load();

/** The whole config, for callers that want the pricing tables. */
export function modelConfig() { return config; }

const envKey = (purpose) => `SAGESTACK_MODEL_${purpose.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;

/**
 * Everything configured for a purpose: model, and whatever else it carries
 * (maxTokens, dim, fallback).
 */
export function purposeConfig(purpose) {
  const entry = config.purposes?.[purpose];
  if (!entry) {
    throw new Error(
      `Unknown model purpose "${purpose}". Known: ${Object.keys(config.purposes || {}).join(', ')}. ` +
      `Add it to config/models.json.`,
    );
  }
  const override = process.env[envKey(purpose)];
  return override ? { ...entry, model: override } : entry;
}

/** The model id for a purpose. */
export function modelFor(purpose) {
  return purposeConfig(purpose).model;
}

/**
 * Check at boot that every purpose names a model with a price on file.
 *
 * Not fatal — an unpriced model still works, it just cannot be costed, and
 * refusing to start over a display concern would be worse than the warning.
 */
export function checkModelPricing(log = console) {
  const missing = [];
  for (const [purpose, entry] of Object.entries(config.purposes || {})) {
    const model = purposeConfig(purpose).model;
    const table = purpose === 'embed' ? config.pricing?.embedding : config.pricing?.text;
    const priced = table && Object.keys(table).some(k => model === k || model.startsWith(k));
    if (!priced) missing.push(`${purpose}=${model}`);
  }
  if (missing.length) {
    log.warn?.(
      `  No price on file for ${missing.join(', ')} — those calls will run but ` +
      `report no cost. Add them to config/models.json.`,
    );
  }
  return missing;
}
