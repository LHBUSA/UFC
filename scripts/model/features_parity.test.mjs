// Parity: the Worker's targeted per-bout assembly (features_core.assembleBoutRow)
// must reproduce the batch builder's whole-history date-block walk exactly, for
// every upcoming bout and a deterministic sample of historical ones. Requires a
// local extract (PBE_MODEL_CACHE with dataset.jsonl); skipped without one.
//
//   PBE_MODEL_CACHE=... node --test scripts/model/features_parity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonl } from './common.mjs';
import { assembleBoutRow } from './features_core.mjs';
import { FEATURE_KEYS } from './feature_spec.mjs';

const cache = process.env.PBE_MODEL_CACHE;
const have = cache && fs.existsSync(path.join(cache, 'dataset.jsonl'));

test('targeted per-bout assembly equals the batch builder', { skip: !have && 'no PBE_MODEL_CACHE extract' }, () => {
  const L = (n) => readJsonl(path.join(cache, `${n}.jsonl`));
  const events = new Map(L('events').map((e) => [e.id, e]));
  const fighters = new Map(L('fighters').map((f) => [f.id, f]));
  const bouts = L('bouts');
  const rowsOf = new Map();
  for (const r of L('bout_features')) { if (!rowsOf.has(r.fighter_id)) rowsOf.set(r.fighter_id, []); rowsOf.get(r.fighter_id).push(r); }
  const snapsOf = new Map();
  for (const s of L('snapshots')) { if (!snapsOf.has(s.fighter_id)) snapsOf.set(s.fighter_id, []); snapsOf.get(s.fighter_id).push(s); }
  for (const a of snapsOf.values()) a.sort((x, y) => x.as_of_date.localeCompare(y.as_of_date));
  const batch = new Map(readJsonl(path.join(cache, 'dataset.jsonl')).map((r) => [r.bout_id, r]));

  const today = new Date().toISOString().slice(0, 10);
  const dated = bouts.filter((b) => events.get(b.event_id)?.event_date);
  const upcoming = dated.filter((b) => events.get(b.event_id).event_date >= today);
  // Deterministic sample: every bout whose id hashes into 1 of 12 buckets.
  const sample = dated.filter((b) => events.get(b.event_id).event_date < today && createHash('sha256').update(b.id).digest()[0] % 12 === 0);
  const checked = [...upcoming, ...sample];
  assert.ok(upcoming.length >= 20, `expected an upcoming card in the extract, got ${upcoming.length}`);
  assert.ok(sample.length >= 500, `historical sample too small: ${sample.length}`);

  let mismatches = 0;
  const examples = [];
  for (const b of checked) {
    const want = batch.get(b.id);
    const got = assembleBoutRow(b, events.get(b.event_id), fighters, snapsOf, rowsOf);
    const same = JSON.stringify(got.x) === JSON.stringify(want.x)
      && JSON.stringify(got.available) === JSON.stringify(want.available)
      && got.min_prior_bouts === want.min_prior_bouts && got.min_stat_bouts === want.min_stat_bouts
      && got.fighter_1_id === want.fighter_1_id;
    if (!same) {
      mismatches += 1;
      if (examples.length < 5) {
        const bad = FEATURE_KEYS.filter((k, i) => got.x[i] !== want.x[i] || got.available[i] !== want.available[i]).map((k) => {
          const i = FEATURE_KEYS.indexOf(k);
          return `${k}: ${got.x[i]}/${got.available[i]} vs ${want.x[i]}/${want.available[i]}`;
        });
        examples.push({ bout: b.id, date: events.get(b.event_id).event_date, bad });
      }
    }
  }
  assert.equal(mismatches, 0, `${mismatches}/${checked.length} bouts differ:\n${JSON.stringify(examples, null, 2)}`);
  console.log(`parity: ${checked.length} bouts (${upcoming.length} upcoming, ${sample.length} historical) identical`);
});
