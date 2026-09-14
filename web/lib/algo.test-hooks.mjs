/* model.test-hooks.mjs plus extensionless `@/...` imports resolved to .ts, so
 * lib/algo.ts (which imports lib/slug) loads under `node --test`. */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
export { load } from './model.test-hooks.mjs';

const WEB_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
  if (specifier.startsWith('@/')) {
    const base = resolvePath(WEB_ROOT, specifier.slice(2));
    const hit = /\.[a-z]+$/.test(base) ? base : [`${base}.ts`, `${base}.tsx`].find((f) => existsSync(f)) || base;
    return next(pathToFileURL(hit).href, context);
  }
  return next(specifier, context);
}
