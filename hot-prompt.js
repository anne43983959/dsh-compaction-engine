import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_CHARS = 12000;
const cache = new Map();

export function resolveHotPromptPath(env = process.env) {
  const explicit = typeof env.DSH_COMPACTION_PROMPT === 'string' ? env.DSH_COMPACTION_PROMPT.trim() : '';
  if (explicit.length > 0) return path.resolve(explicit);
  const home = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return home.length > 0 ? path.join(home, 'compaction-prompt.md') : null;
}

export function readHotPrompt(options = {}) {
  const env = options.env ?? process.env;
  const file = options.path ?? resolveHotPromptPath(env);
  if (file === null) return { text: '', path: null, hash: null, cached: false };
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { text: '', path: file, hash: null, cached: false };
    const key = String(stat.mtimeMs) + ':' + String(stat.size);
    const hit = cache.get(file);
    if (hit !== undefined && hit.key === key) return { ...hit.value, cached: true };
    const raw = fs.readFileSync(file, 'utf8');
    const text = raw.slice(0, MAX_CHARS).trim();
    const hash = createHash('sha256').update(text).digest('hex');
    const value = { text, path: file, hash };
    cache.set(file, { key, value });
    return { ...value, cached: false };
  } catch {
    return { text: '', path: file, hash: null, cached: false };
  }
}

export function clearHotPromptCache() {
  cache.clear();
}
