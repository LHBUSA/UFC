#!/usr/bin/env node
/* A route-level global stylesheet must not be able to restyle another route.
 *
 * Next keeps a nested route's plain .css in the document after a client
 * navigation, so a stylesheet imported by app/<route>/layout.tsx is global for
 * the rest of the session. weighins-cinematic.css was written against the bare
 * site-wide `.page > section:first-of-type` and turned the first section of
 * /algo into the weigh-in hero, ghost text included.
 *
 * Rule: any plain (non-module) .css imported from anywhere except the root
 * app/layout.tsx must start EVERY selector with a class that is unique to that
 * route — never a shared layout/utility class, an element, an id or `*`.
 * Root-layout stylesheets are global by design and are not checked here.
 *
 *   node scripts/check-route-css-scope.mjs      exits 1 and lists each unsafe selector
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ROOT_LAYOUT = join(ROOT, 'app', 'layout.tsx');

/* Classes the whole site shares. A selector anchored on one of these is not scoped. */
export const SHARED_CLASSES = new Set([
  'page', 'wrap', 'row', 'card', 'btn', 'crumbs', 'eyebrow', 'stat', 'note', 'tbl', 'tbl-wrap', 'empty',
  'sec-head', 'segment', 'grid', 'between', 'faint', 'sm', 'hi', 'gold', 'hdr', 'hdr-in', 'nav', 'mnav', 'ftr',
]);

/** The first compound of a selector must be `.route-specific-class…`. */
export function selectorIsScoped(selector) {
  const first = selector.trim().split(/[\s>+~]/)[0];
  if (/^(:root|html|body)$/.test(first)) return false;
  const m = first.match(/^\.(-?[_a-zA-Z][\w-]*)/);
  if (!m) return false;                       // element, id, attribute, * or pseudo first
  return !SHARED_CLASSES.has(m[1]);
}

/** Every selector in a stylesheet, with its line. At-rule preludes are skipped. */
export function selectorsOf(css) {
  const text = css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/"[^"\n]*"|'[^'\n]*'/g, '""');          // a brace inside content: "…" is not a block
  const out = [];
  let buf = '', line = 1, bufLine = 1;
  for (const ch of text) {
    if (ch === '{') {
      const prelude = buf.trim();
      if (prelude && !prelude.startsWith('@')) {
        for (const sel of prelude.split(',')) if (sel.trim()) out.push({ selector: sel.trim().replace(/\s+/g, ' '), line: bufLine });
      }
      buf = '';
    } else if (ch === '}' || ch === ';') {
      buf = '';
    } else {
      if (!buf.trim()) bufLine = line;
      buf += ch;
    }
    if (ch === '\n') line += 1;
  }
  /* keyframe stops (from / to / 40%) are not selectors */
  return out.filter((s) => !/^(from|to|\d+(\.\d+)?%)$/.test(s.selector));
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n.startsWith('.')) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function routeStylesheets() {
  const sources = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))].filter((f) => /\.(tsx|ts|jsx|js)$/.test(f));
  const found = new Map();                     // css path -> importer
  for (const f of sources) {
    if (resolve(f) === resolve(ROOT_LAYOUT)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/import\s+["']([^"']+\.css)["']/g)) {
      if (/\.module\.css$/.test(m[1])) continue;
      const css = m[1].startsWith('@/') ? join(ROOT, m[1].slice(2)) : resolve(dirname(f), m[1]);
      if (existsSync(css)) found.set(css, f);
    }
  }
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sheets = routeStylesheets();
  const bad = [];
  for (const [css, importer] of sheets) {
    for (const s of selectorsOf(readFileSync(css, 'utf8'))) {
      if (!selectorIsScoped(s.selector)) bad.push(`  ${relative(ROOT, css)}:${s.line}  ${s.selector}   (imported by ${relative(ROOT, importer)})`);
    }
  }
  console.log(`route css scope: ${sheets.size} route-level stylesheet(s), ${bad.length} unscoped selector(s)`);
  for (const b of bad) console.log(b);
  if (bad.length) console.log('  Anchor every selector on a class unique to the route (e.g. .weighins-cinematic-page), or use a CSS module.');
  process.exit(bad.length ? 1 : 0);
}
