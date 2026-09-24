/* node:module customization hooks that let a `node --test` file render a .tsx
 * component with react-dom/server (lib/allAccessHero.test.ts).
 *
 *   - "@/x" resolves to web/x, and an extensionless local import tries
 *     .ts / .tsx / .js / /index.ts so the app's import style works unchanged.
 *   - .tsx is transformed with Next's own SWC binding (already installed with
 *     next; nothing new to depend on) to ESM with the automatic JSX runtime.
 *   - .ts keeps going to Node's --experimental-strip-types.
 *
 * Registered from the test file with module.register(); never used by the app. */
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createRequire } from "node:module";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
let bindings = null;

export async function initialize() {
  const { loadBindings } = require("next/dist/build/swc/index.js");
  bindings = await loadBindings();
}

async function exists(p) { try { return (await stat(p)).isFile(); } catch { return false; } }

async function withExtension(fileUrl) {
  const p = fileURLToPath(fileUrl);
  if (/\.[cm]?[jt]sx?$|\.json$|\.css$/.test(p)) return fileUrl;
  for (const ext of [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"]) {
    if (await exists(p + ext)) return pathToFileURL(p + ext).href;
  }
  return fileUrl;
}

export async function resolve(specifier, context, next) {
  /* next has no "exports" map, so its deep imports need the file extension under ESM. */
  if (/^next\/[\w-]+$/.test(specifier)) return next(`${specifier}.js`, context);
  if (specifier.startsWith("@/")) {
    const url = await withExtension(pathToFileURL(join(WEB, specifier.slice(2))).href);
    return { url, shortCircuit: true, format: url.endsWith(".tsx") ? "module" : undefined };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL && context.parentURL.startsWith("file:")) {
    const url = await withExtension(new URL(specifier, context.parentURL).href);
    if (url !== new URL(specifier, context.parentURL).href) return { url, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    const filename = fileURLToPath(url);
    const src = await readFile(filename, "utf8");
    const out = bindings.transformSync(src, {
      filename,
      jsc: { parser: { syntax: "typescript", tsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "es6" },
      sourceMaps: false,
    });
    return { format: "module", source: out.code, shortCircuit: true };
  }
  if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
  return next(url, context);
}
