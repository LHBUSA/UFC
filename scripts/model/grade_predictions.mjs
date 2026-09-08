#!/usr/bin/env node
// Grade published predictions against stored official bout results.
//
//   node scripts/model/grade_predictions.mjs           # DRY RUN (default)
//   node scripts/model/grade_predictions.mjs --apply   # append grades
//
// Grades are APPEND-ONLY. This command never edits or deletes one. When the
// stored result disagrees with the grade currently in force - a decision
// overturned on appeal, a win reclassified as a no-contest, a commission
// correcting its own record - it appends a NEW REVISION that supersedes the
// previous one and says why. The superseded grade stays readable forever, and
// the prediction it grades is never touched by any of this.
//
// That asymmetry is the design. A prediction is a claim someone made at a
// moment and it must never move. A result is an assertion about the world made
// by a source, and sources revise. A schema that cannot represent the second
// forces someone to either publish a knowingly wrong record or break the
// immutability of the first.
//
// The model is not consulted here. Grading reads ufc_bout_results and nothing
// else, so a grade can never be influenced by what was predicted.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rest, cacheDir } from './common.mjs';
import { flag, opt } from './live.mjs';

const APPLY = flag('--apply');
const EVENT = opt('--event', null);
const GRADED_BY = opt('--graded-by', 'scripts/model/grade_predictions.mjs');
const SOURCE = 'ufc_bout_results';

/** Map an official result onto the prediction's pick. */
function gradeFor(result, pred) {
  if (!result) return null;
  if (result.method === 'NC') return { result: 'NC', winner_id: null };
  if (result.method === 'DRAW' || !result.winner_id) {
    // A method-less result with no winner is a draw in this schema; anything
    // else with no winner is not something to guess at.
    return result.method === 'DRAW' ? { result: 'DRAW', winner_id: null } : null;
  }
  if (result.winner_id === pred.pick_fighter_id) return { result: 'WIN', winner_id: result.winner_id };
  if (result.winner_id === pred.fighter_a_id || result.winner_id === pred.fighter_b_id) {
    return { result: 'LOSS', winner_id: result.winner_id };
  }
  // The stored winner is not one of the two corners on the prediction. That is
  // a data problem, not a grade, and it is never resolved by picking one.
  return null;
}

async function main() {
  const db = rest();
  console.log(`PBE Fight Model — grade  [${APPLY ? 'APPLY' : 'DRY RUN'}]`);

  let locked;
  try {
    locked = await db.selectAll(
      'ufc_model_predictions',
      '?select=id,bout_id,event_id,fighter_a_id,fighter_b_id,pick_fighter_id,pick_probability,model_version,locked_at' +
      '&locked_at=not.is.null' + (EVENT ? `&event_id=eq.${EVENT}` : ''),
    );
  } catch (e) {
    if (/HTTP 404/.test(String(e.message))) {
      console.log('\nufc_model_predictions does not exist: migration 011 has not been applied to this project.');
      console.log('Nothing to grade. This is the expected state before the tracker is provisioned.');
      return;
    }
    throw e;
  }

  if (!locked.length) {
    console.log('\nNo locked predictions exist. Nothing to grade.');
    console.log('That is the expected state until publish_predictions.mjs has locked a pick before a fight.');
    return;
  }

  const boutIds = [...new Set(locked.map((p) => p.bout_id))];
  const [results, grades] = await Promise.all([
    db.selectAll('ufc_bout_results', `?select=bout_id,winner_id,method,method_raw,round,time_sec,source_url,captured_at&bout_id=in.(${boutIds.join(',')})`),
    db.selectAll('ufc_model_prediction_current_grade', `?select=*&prediction_id=in.(${locked.map((p) => p.id).join(',')})`),
  ]);
  const resultBy = new Map(results.map((r) => [r.bout_id, r]));
  const gradeBy = new Map(grades.map((g) => [g.prediction_id, g]));

  const newGrades = [];
  const revisions = [];
  const waiting = [];
  const unresolved = [];

  for (const pred of locked) {
    const result = resultBy.get(pred.bout_id);
    if (!result) { waiting.push(pred); continue; }
    const graded = gradeFor(result, pred);
    if (!graded) { unresolved.push({ pred, result }); continue; }

    const current = gradeBy.get(pred.id);
    const row = {
      prediction_id: pred.id,
      result: graded.result,
      winner_id: graded.winner_id,
      method: result.method,
      source: SOURCE,
      source_ref: result.source_url ?? null,
      source_captured_at: result.captured_at ?? null,
      graded_by: GRADED_BY,
    };

    if (!current) { newGrades.push({ row, pred, result }); continue; }

    const changed = current.result !== graded.result || (current.winner_id ?? null) !== (graded.winner_id ?? null);
    if (!changed) continue;

    // A correction has to say what changed and on whose authority. Generating
    // that sentence from the observed difference keeps it accurate; a free-text
    // reason typed by whoever ran the command would drift from the data.
    revisions.push({
      row: {
        ...row,
        revision_reason:
          `Official result changed in ${SOURCE}: previously graded ${current.result}` +
          `${current.method ? ` (${current.method})` : ''} at revision ${current.revision}, now ${graded.result}` +
          `${result.method ? ` (${result.method})` : ''}. Source captured ${result.captured_at ?? 'unknown'}.`,
      },
      pred,
      current,
      result,
    });
  }

  console.log(`\nlocked predictions        ${locked.length}`);
  console.log(`awaiting a stored result  ${waiting.length}`);
  console.log(`already graded, unchanged ${locked.length - waiting.length - newGrades.length - revisions.length - unresolved.length}`);
  console.log(`new grades to append      ${newGrades.length}`);
  console.log(`REVISIONS to append       ${revisions.length}`);
  console.log(`unresolvable              ${unresolved.length}`);

  for (const g of newGrades) {
    console.log(`  grade   ${g.pred.id.slice(0, 8)} ${g.row.result.padEnd(5)} ${g.row.method ?? ''}`);
  }
  for (const r of revisions) {
    console.log(`  REVISE  ${r.pred.id.slice(0, 8)} ${r.current.result} -> ${r.row.result} (revision ${r.current.revision + 1})`);
    console.log(`          ${r.row.revision_reason}`);
  }
  for (const u of unresolved) {
    console.log(`  SKIP    ${u.pred.id.slice(0, 8)} stored result has method=${u.result.method} winner=${u.result.winner_id ?? 'none'}; not gradeable without a judgement call`);
  }

  const out = path.join(cacheDir(), 'grading_plan.json');
  fs.writeFileSync(out, JSON.stringify({
    generated_at: new Date().toISOString(),
    dry_run: !APPLY,
    new_grades: newGrades.map((g) => g.row),
    revisions: revisions.map((r) => r.row),
    unresolved: unresolved.map((u) => ({ prediction_id: u.pred.id, bout_id: u.pred.bout_id, method: u.result.method })),
  }, null, 2));
  console.log(`\n-> ${out}`);

  if (!APPLY) {
    console.log('\nDRY RUN: nothing was written.');
    return;
  }

  const payload = [...newGrades.map((g) => g.row), ...revisions.map((r) => r.row)];
  if (!payload.length) { console.log('\nNothing to append.'); return; }

  const res = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/ufc_model_prediction_grades`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    // revision and supersedes_grade_id are deliberately absent: the database
    // assigns them, so a grading history cannot be renumbered by its grader.
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`grade insert failed: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
  const written = await res.json();
  console.log(`\nAppended ${written.length} grade(s). No prediction was modified.`);
}


// Importable for tests: only run the command when this file IS the command.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });

export { gradeFor };
