/* An external draft may never be created public. This is a regression guard.
 *
 * WHAT IT IS GUARDING
 *
 * An `external` story is a deterministic fact packet built from an RSS title and
 * our own tables - 76 to 101 words, headlined "Contract report from Bloody
 * Elbow: the table view on Paulo Costa". The source page is never fetched, so
 * there is no evidence in it beyond the headline and a record lookup. It is
 * research, not an article.
 *
 * For a while generateExternal decided publication from the wire item's
 * taxonomy label:
 *
 *   const review = qualifying.some((l) => l === 'injury' || l === 'withdrawal');
 *   status: review ? 'review' : 'published', needs_human: review,
 *
 * so `injury` and `withdrawal` were held and `contract`, `rankings`,
 * `suspension`, `replacement`, `weight_miss` and `bout_moved` went straight to
 * the public site. Three did on 2026-09-08 and were live about seven hours
 * before a human demoted them; one more did at 2026-09-09T22:16Z.
 *
 * The label a wire item carries says nothing about whether eighty words of
 * table lookup is worth reading, so it was never the right question. That is
 * why the guard below is not "hold the right labels" but "hold everything":
 * a condition here is the bug, whatever the condition is.
 *
 * WHY THIS TEST READS SOURCE
 *
 * generateExternal needs a fully built `world` - fighters, bouts, events, the
 * alias index - and a live PostgREST. Standing all of that up would test the
 * fakes as much as the invariant. The invariant itself is a single literal in a
 * single object, so the honest test is to assert on that literal. The repo
 * already does this in isolate_state.test.mjs, for the same reason: some
 * properties live in the shape of the code rather than in its output.
 *
 * If generateExternal is ever restructured so this no longer parses, the test
 * fails loudly and whoever restructured it decides how to prove the invariant
 * again. That is the correct outcome; a guard that silently stops guarding is
 * worse than no guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITER = resolve(HERE, '../../../scripts/news/write_articles.mjs');
const source = readFileSync(WRITER, 'utf8');

/** The object literal generateExternal pushes for each external draft. */
function externalDraftLiteral() {
  const marker = "story_type: 'external'";
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `could not find the external draft in ${WRITER}; the guard below cannot run`);
  const end = source.indexOf('});', at);
  assert.notEqual(end, -1, 'could not find the end of the external draft literal');
  return source.slice(at, end);
}

test('an external draft is created private, unconditionally', () => {
  const draft = externalDraftLiteral();
  assert.match(draft, /status:\s*'review'/, 'external drafts must be created with status review');
  assert.match(draft, /needs_human:\s*true/, 'external drafts must be created needing a human');
});

test('publication of an external draft is not conditional on anything', () => {
  /* The specific bug was a ternary on the taxonomy label. The guard is broader
   * on purpose: ANY conditional in the status or needs_human position means
   * some class of thin external can reach the public site again. */
  const draft = externalDraftLiteral();
  const statusExpr = draft.match(/status:\s*([^,]+),/);
  const humanExpr = draft.match(/needs_human:\s*([^,]+),/);
  assert.ok(statusExpr && humanExpr, 'external draft must set both status and needs_human');
  assert.equal(statusExpr[1].trim(), "'review'", `status must be the literal 'review', got: ${statusExpr[1].trim()}`);
  assert.equal(humanExpr[1].trim(), 'true', `needs_human must be the literal true, got: ${humanExpr[1].trim()}`);
  for (const expr of [statusExpr[1], humanExpr[1]]) {
    assert.doesNotMatch(expr, /[?]|&&|\|\|/, `no conditional is permitted here, got: ${expr.trim()}`);
  }
});

test("'published' does not appear anywhere in the external draft path", () => {
  /* A belt-and-braces check on the same few lines: the word should simply not
   * be reachable from here. */
  assert.doesNotMatch(externalDraftLiteral(), /published/, "the external draft path must not mention 'published'");
});

test('the label-based hold that caused the incident is gone', () => {
  assert.doesNotMatch(
    source,
    /const\s+review\s*=\s*qualifying\.some/,
    'the taxonomy-label publication gate was reintroduced; see the 2026-09-08 and 2026-09-09 incidents',
  );
});
