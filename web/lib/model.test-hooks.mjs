/* Loader hooks so lib/model.ts can be imported by `node --test`.
 *
 * Three things Next resolves for free and node does not:
 *
 *   `server-only` throws by design outside a React Server Component. model.ts
 *   is server-only for real reasons and should stay that way, so the marker
 *   resolves to an empty module for the test run and only for the test run.
 *
 *   `@/...` is the tsconfig path alias for the web root. Node has no idea about
 *   it, so it is rewritten to a file URL here rather than by loosening the
 *   alias in the app, which would make every import in the codebase uglier to
 *   satisfy a test runner.
 *
 *   A bare `import x from "./thing.json"` is valid TypeScript and, in node, an
 *   error without an import attribute. Rewriting the release artifact into a
 *   JS module keeps the application source idiomatic; changing the source to
 *   carry `with { type: "json" }` would work too, but it would be a change made
 *   to the shipped app for the benefit of the tests.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const WEB_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
  if (specifier.startsWith('@/')) {
    return next(pathToFileURL(resolvePath(WEB_ROOT, specifier.slice(2))).href, context);
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.json')) {
    const json = readFileSync(fileURLToPath(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: `export default ${json};` };
  }
  return next(url, context);
}
