#!/usr/bin/env node
// Lock PBE Fight Model predictions before a fight. This is the publishing step.
//
//   node scripts/model/publish_predictions.mjs --event <event_id>            # DRY RUN
//   node scripts/model/publish_predictions.mjs --event <event_id> --apply    # publish
//
// PUBLISHING IS IRREVERSIBLE. A locked prediction cannot be edited, unlocked or
// deleted by anyone, including whoever ran this command, including in a SQL
// console. That is the entire point of the record, so this command is built to
// be hard to run by accident and to explain itself before it acts.
//
// Six gates, all of which must pass:
//
//   1  --apply is required. Without it nothing is sent.
//   2  A scope must be named explicitly. There is no "publish everything".
//   3  The model version must be REGISTERED and LIVE in the database, and its
//      spec hash must match the artifact on disk. Publishing picks from
//      coefficients that differ from the registered ones would make the stored
//      model_version a lie, and nobody would notice.
//   4  The extract must be fresh. Stale features are the quiet failure: a
//      fighter who fought last weekend would otherwise be scored on the
//      snapshot from before that bout.
//   5  Each draft's stored probability must still match what the current data
//      produces. A draft written a week ago may no longer be the model's view.
//   6  The lock window must be open with the required lead time. The database
//      enforces its own floor regardless; this refuses earlier and louder.
//
// The lock timestamp itself is never sent. ufc_model_publish_prediction() takes
// the row FOR UPDATE and the database stamps its own clock, so this command
// cannot backdate a pick even if it tried.

import { pathToFileURL } from 'node:url';

import { rest } from './common.mjs';
import {
  argv, flag, opt, loadArtifact, scoreRow, upcomingRows, marketIndex, cacheAge,
  checkRegisteredModel, lockCutoff, hoursUntil,
} from './live.mjs';

const APPLY = flag('--apply');
const EVENT = opt('--event', null);
const BOUT = opt('--bout', null);
const MIN_LEAD_HOURS = Number(opt('--min-lead-hours', 6));
const MAX_EXTRACT_AGE_HOURS = Number(opt('--max-extract-age-hours', 12));
const MAX_DRIFT_PTS = Number(opt('--max-drift-pts', 0.5));
const ALLOW_DRIFT = flag('--allow-drift');

const fail = (msg) => { console.error(`\nREFUSED: ${msg}`); process.exit(1); };

async function main() {
  console.log(`PBE Fight Model — publish  [${APPLY ? 'APPLY — THIS PUBLISHES' : 'DRY RUN'}]`);

  // ---- gate 2: explicit scope ------------------------------------------
  if (!EVENT && !BOUT) {
    fail('name a scope: --event <event_id> or --bout <bout_id>.\n' +
         '          There is deliberately no way to publish every upcoming bout in one command.');
  }

  const artifact = loadArtifact();
  console.log(`model    ${artifact.model.model_version}  ${artifact.model.feature_version}`);
  console.log(`spec     ${artifact.model.spec_sha256}`);

  // ---- gate 3: the registered model ------------------------------------
  const registered = await checkRegisteredModel(artifact);
  console.log(`registry ${registered.ok ? 'OK — registered and live, spec hash matches' : registered.reason}`);

  // ---- gate 4: extract freshness ---------------------------------------
  const age = cacheAge();
  if (!age) fail('no extract manifest. Run: node scripts/model/extract_dataset.mjs');
  console.log(`extract  ${age.extracted_at} (${age.hours.toFixed(1)}h old, limit ${MAX_EXTRACT_AGE_HOURS}h)`);

  // ---- candidates -------------------------------------------------------
  const byBout = marketIndex();
  const fresh = upcomingRows()
    .filter((r) => (EVENT ? r.event_id === EVENT : true))
    .filter((r) => (BOUT ? r.bout_id === BOUT : true))
    .map((r) => scoreRow(r, artifact, byBout));

  if (!fresh.length) fail(`no upcoming ungraded bouts match ${EVENT ? `--event ${EVENT}` : `--bout ${BOUT}`} in the current extract.`);

  const drafts = await loadDrafts(artifact, fresh.map((p) => p.bout_id));

  console.log(`\n${fresh.length} bout(s) in scope; ${drafts.size} matching draft(s) in the database\n`);

  const checks = fresh.map((p) => evaluate(p, drafts.get(p.bout_id), age));
  const header = ['status', 'bout'.padEnd(40), 'pick'.padEnd(22), '  band', ' lead h', 'note'].join('  ');
  console.log(header);
  for (const c of checks) {
    console.log([
      (c.ready ? 'READY ' : 'BLOCK '),
      `${c.p.fighter_1_name} vs ${c.p.fighter_2_name}`.slice(0, 40).padEnd(40),
      (c.p.pick_fighter_name || '').slice(0, 22).padEnd(22),
      c.p.confidence_band.padStart(6),
      c.leadHours.toFixed(1).padStart(7),
      c.reason ?? '',
    ].join('  '));
  }

  const ready = checks.filter((c) => c.ready);
  const blocked = checks.filter((c) => !c.ready);
  console.log(`\n${ready.length} publishable, ${blocked.length} blocked.`);

  // Gates that stop the whole run rather than an individual bout.
  const hardStops = [];
  if (!registered.ok) hardStops.push(registered.reason);
  if (age.hours > MAX_EXTRACT_AGE_HOURS) hardStops.push(`the extract is ${age.hours.toFixed(1)}h old (limit ${MAX_EXTRACT_AGE_HOURS}h); re-run extract_dataset.mjs and build_features.mjs`);
  if (!ready.length) hardStops.push('nothing is publishable');

  if (!APPLY) {
    console.log('\nDRY RUN: nothing was published.');
    if (hardStops.length) {
      console.log('An --apply run would be refused:');
      for (const h of hardStops) console.log(`  - ${h}`);
    } else {
      console.log(`An --apply run would lock ${ready.length} prediction(s), permanently.`);
    }
    return;
  }

  if (hardStops.length) fail(hardStops.join('\n          '));

  const db = rest();
  let locked = 0;
  for (const c of ready) {
    const res = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/ufc_model_publish_prediction`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      // Note what is NOT here: a timestamp. The database supplies it.
      body: JSON.stringify({ p_prediction_id: c.draft.id, p_min_lead: `${MIN_LEAD_HOURS} hours` }),
    });
    if (!res.ok) {
      console.error(`  FAILED ${c.p.fighter_1_name} vs ${c.p.fighter_2_name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const row = await res.json();
    locked += 1;
    console.log(`  LOCKED ${c.p.pick_fighter_name} at ${(c.p.pick_probability * 100).toFixed(1)}% — server stamped ${row.locked_at ?? '(see row)'}`);
  }
  console.log(`\n${locked} prediction(s) published. They are now permanent.`);
  void db;
}

/** Existing unlocked drafts for these bouts, keyed by bout. */
async function loadDrafts(artifact, boutIds) {
  const db = rest();
  const out = new Map();
  if (!boutIds.length) return out;
  try {
    const rows = await db.selectAll(
      'ufc_model_predictions',
      `?select=id,bout_id,prob_a,prob_b,pick_fighter_id,pick_probability,locked_at,model_version,feature_version` +
      `&model_version=eq.${encodeURIComponent(artifact.model.model_version)}` +
      `&bout_id=in.(${boutIds.join(',')})`,
    );
    for (const r of rows) out.set(r.bout_id, r);
  } catch (e) {
    if (/HTTP 404/.test(String(e.message))) {
      console.log('registry ufc_model_predictions does not exist: migration 011 has not been applied to this project');
      return out;
    }
    throw e;
  }
  return out;
}

/** Per-bout gates 5 and 6. */
function evaluate(p, draft, age) {
  const cutoff = lockCutoff(p.event_date);
  const leadHours = hoursUntil(cutoff);

  if (!draft) return { p, draft, leadHours, ready: false, reason: 'no draft in the database — run predict_upcoming.mjs --apply first' };
  if (draft.locked_at) return { p, draft, leadHours, ready: false, reason: `already published at ${draft.locked_at}` };
  if (leadHours <= 0) return { p, draft, leadHours, ready: false, reason: 'lock window closed — this can never be published' };
  if (leadHours < MIN_LEAD_HOURS) return { p, draft, leadHours, ready: false, reason: `only ${leadHours.toFixed(1)}h of lead, needs ${MIN_LEAD_HOURS}h` };

  // Gate 5: has the model's view moved since the draft was written?
  const driftPts = Math.abs(Number(draft.pick_probability) - p.pick_probability) * 100;
  const pickChanged = draft.pick_fighter_id !== p.pick_fighter_id;
  if (pickChanged && !ALLOW_DRIFT) {
    return { p, draft, leadHours, ready: false, reason: 'the current data picks the OTHER corner — regenerate the draft' };
  }
  if (driftPts > MAX_DRIFT_PTS && !ALLOW_DRIFT) {
    return { p, draft, leadHours, ready: false, reason: `stored draft differs from current data by ${driftPts.toFixed(2)} pts (limit ${MAX_DRIFT_PTS})` };
  }
  if (age.hours > MAX_EXTRACT_AGE_HOURS) {
    return { p, draft, leadHours, ready: false, reason: `extract ${age.hours.toFixed(1)}h old` };
  }
  return { p, draft, leadHours, ready: true, reason: null };
}


// Importable for tests: only run the command when this file IS the command.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
void argv;

export { evaluate, MIN_LEAD_HOURS, MAX_DRIFT_PTS };
