/**
 * Guards two things that have each gone wrong more than once.
 *
 *   node --test scripts/tuf/lib/source-text.test.mjs
 *
 * 1. No source file may contain a control character.
 *
 *    Patching JavaScript through a shell heredoc turns a single-backslash \b
 *    into an actual 0x08 byte. The regex still compiles, the file looks right
 *    in an editor, and the alternative it sits on silently never matches. It
 *    happened three times in one day: it disabled "sub" and "ko" as method
 *    families in the classifier, and it broke seven round-parsing patterns at
 *    once — which made 414 method strings WORSE while appearing to be a fix.
 *    Nothing in a normal review catches this. A byte check does.
 *
 * 2. The method/round splitter keeps working on the shapes these articles
 *    actually use, which is more shapes than anyone would guess.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(mjs|js|ts|tsx|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("no source file carries a stray control character", () => {
  const files = [
    ...sourceFiles(path.join(ROOT, 'scripts', 'tuf')),
    path.join(ROOT, 'web', 'lib', 'tuf.ts'),
    path.join(ROOT, 'web', 'lib', 'tuf.test.ts'),
  ];
  const offenders = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const bad = new Set();
    for (const ch of text) {
      const n = ch.charCodeAt(0);
      if (n < 32 && n !== 9 && n !== 10 && n !== 13) bad.add(n);
    }
    if (bad.size) offenders.push(`${path.relative(ROOT, f)} (${[...bad].join(', ')})`);
  }
  assert.deepEqual(
    offenders,
    [],
    'a control character here is almost always a \\b that a shell heredoc turned into 0x08, which silently disables the pattern it belongs to',
  );
});

/* The splitter is not exported, so the shapes are pinned against the drafted
 * output instead: no bout may keep a round phrase inside its method string. */
test("no bout keeps its round or time welded into the method", () => {
  const dir = path.join(ROOT, 'web', 'data', 'tuf', 'seasons');
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const season = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const div of season.bracket ?? []) {
      for (const st of div.stages) {
        for (const b of st.bouts) {
          if (!b.method) continue;
          if (/\bround\b/i.test(b.method) || /\b\d{1,2}:\d{2}\b/.test(b.method)) {
            offenders.push(`${f}: "${b.method}"`);
          }
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'the round and the time belong in their own fields, not in the method text');
});

test("a method that names a round yields a round number", () => {
  /* The counterpart to the test above: stripping the phrase is only half the
   * job. If the phrase was there, the number it named must have landed in the
   * round field rather than been thrown away. */
  const dir = path.join(ROOT, 'web', 'data', 'tuf', 'seasons');
  let episodeBouts = 0;
  let withRound = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const season = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const div of season.bracket ?? []) {
      for (const st of div.stages) {
        for (const b of st.bouts) {
          if (!b.episode) continue;
          episodeBouts += 1;
          if (typeof b.round === 'number') withRound += 1;
        }
      }
    }
  }
  assert.ok(episodeBouts > 400, `expected the archive to hold plenty of episode bouts, found ${episodeBouts}`);
  const ratio = withRound / episodeBouts;
  assert.ok(
    ratio > 0.9,
    `only ${withRound} of ${episodeBouts} episode bouts carry a round (${(ratio * 100).toFixed(1)}%) — the tail splitter has probably stopped matching a common phrasing`,
  );
});
