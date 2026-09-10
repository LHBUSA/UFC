#!/usr/bin/env node
/* Every var(--x) used in the site's CSS must resolve to a custom property
 * defined somewhere in that CSS (or set inline in app/layout.tsx). An
 * undefined token is not a missing style, it is an invalid declaration: the
 * property falls back to its inherited value, and inside a `font:` shorthand
 * the family and weight go with it.
 *
 *   node scripts/check-css-tokens.mjs      exits 1 and lists any undefined token
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (n === 'node_modules' || n.startsWith('.')) return [];
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))];
const css = files.filter((f) => f.endsWith('.css'));
const tsx = files.filter((f) => /\.(tsx|ts)$/.test(f));

const defined = new Set();
const used = new Map();   // token -> [file:line]
for (const f of css) {
  const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  for (const m of text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) {
      if (m[2] === ',') continue;   // has a fallback value
      if (!used.has(m[1])) used.set(m[1], []);
      used.get(m[1]).push(`${relative(ROOT, f)}:${i + 1}`);
    }
  });
}
/* Tokens set from TSX (inline style objects, e.g. the font bridge on <body>). */
for (const f of tsx) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/["'](--[a-zA-Z0-9-]+)["']\s*(?:as string)?\]?\s*:/g)) defined.add(m[1]);
  for (const m of text.matchAll(/\[\s*"(--[a-zA-Z0-9-]+)"/g)) defined.add(m[1]);
}
/* next/font variables are defined by the font loader at runtime. */
for (const v of ['--font-inter', '--font-playfair', '--font-mono']) defined.add(v);

const undefinedTokens = [...used.entries()].filter(([t]) => !defined.has(t));
console.log(`css files ${css.length}, tokens defined ${defined.size}, tokens referenced ${used.size}, undefined ${undefinedTokens.length}`);
for (const [t, where] of undefinedTokens) console.log(`  ${t}  (${where.length}x) ${where.slice(0, 4).join(', ')}${where.length > 4 ? ' ...' : ''}`);
process.exit(undefinedTokens.length ? 1 : 0);
