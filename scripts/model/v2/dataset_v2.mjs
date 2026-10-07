// V2 dataset assembly: the clean extract plus every point-in-time V2 extra.
// Shared by research.mjs (walk-forward) and freeze_candidate.mjs (release), so
// the frozen artifact is built from exactly the features that were validated.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { readJsonl } from '../common.mjs';
import { FEATURE_KEYS } from '../feature_spec.mjs';
import { latestAsOf } from '../features_core.mjs';
import { eloLadder, chooseEloK, slimSnapshot, opponentQuality, extendRow, C2_KEYS, C3_KEYS } from './features_v2.mjs';

export const PRE_ERA = '2013-01-01';
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

export async function loadV2(CACHE) {

  async function loadSnapshots(file) {
    const snapsOf = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const s = JSON.parse(line);
      if (!snapsOf.has(s.fighter_id)) snapsOf.set(s.fighter_id, []);
      snapsOf.get(s.fighter_id).push(slimSnapshot(s));
    }
    for (const a of snapsOf.values()) a.sort((x, y) => x.as_of_date.localeCompare(y.as_of_date));
    return snapsOf;
  }

  log('loading extract from', CACHE);
  const dataset = readJsonl(path.join(CACHE, 'dataset.jsonl'));
  const events = new Map(readJsonl(path.join(CACHE, 'events.jsonl')).map((e) => [e.id, e]));
  const bouts = readJsonl(path.join(CACHE, 'bouts.jsonl'));
  const results = new Map(readJsonl(path.join(CACHE, 'results.jsonl')).map((r) => [r.bout_id, r]));
  const boutFeatures = readJsonl(path.join(CACHE, 'bout_features.jsonl'));
  const snapsOf = await loadSnapshots(path.join(CACHE, 'snapshots.jsonl'));
  log('rows', dataset.length, 'snap fighters', snapsOf.size);

  /* --------------------------------------------------------- Elo + extras */

  const eloBouts = bouts.map((b) => {
    const date = events.get(b.event_id)?.event_date;
    const f1 = b.fighter_a_id < b.fighter_b_id ? b.fighter_a_id : b.fighter_b_id;
    const f2 = f1 === b.fighter_a_id ? b.fighter_b_id : b.fighter_a_id;
    const r = results.get(b.id);
    const winner = r?.winner_id ? r.winner_id : r?.method === 'DRAW' ? 'draw' : null;
    return { id: b.id, date, f1, f2, winner };
  }).filter((b) => b.date);
  const eloChoice = chooseEloK(eloBouts, PRE_ERA);
  const elo = eloLadder(eloBouts, eloChoice.k);
  log('elo K', eloChoice.k);

  /* Population centring for opponent metrics: snapshots dated before the walk-forward era only. */
  const pre = [];
  for (const arr of snapsOf.values()) { const s = latestAsOf(arr, '2012-12-31'); if (s && s.stat_bouts >= 1) pre.push(s); }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const popMeans = {
    sig_diff: mean(pre.filter((s) => s.sig_diff != null).map((s) => s.sig_diff)),
    ctrl: mean(pre.filter((s) => s.ctrl != null).map((s) => s.ctrl)),
    ko_loss: mean(pre.filter((s) => s.ko_loss != null).map((s) => s.ko_loss)),
  };

  const rowsOfFighter = new Map();
  for (const r of boutFeatures) { if (!rowsOfFighter.has(r.fighter_id)) rowsOfFighter.set(r.fighter_id, []); rowsOfFighter.get(r.fighter_id).push(r); }

  const extrasOf = new Map();
  for (const row of dataset) {
    const d = row.event_date;
    const e = elo.get(row.bout_id);
    const extra = {
      elo: e ? { r1: e.r1, r2: e.r2 } : null,
      oq1: opponentQuality(rowsOfFighter.get(row.fighter_1_id) || [], snapsOf, d, popMeans),
      oq2: opponentQuality(rowsOfFighter.get(row.fighter_2_id) || [], snapsOf, d, popMeans),
      snap1: latestAsOf(snapsOf.get(row.fighter_1_id) || [], d),
      snap2: latestAsOf(snapsOf.get(row.fighter_2_id) || [], d),
    };
    const ext = extendRow(row, extra);
    extrasOf.set(row.bout_id, { ...ext, elo_n: e ? [e.n1, e.n2] : [0, 0] });
  }

  /* ------------------------------------------------------------ candidates */

  const withX = (row, set) => {
    const e = extrasOf.get(row.bout_id);
    const x = set === 'v1' ? row.x : set === 'c2' ? [...row.x, ...e.c2] : set === 'c2elo' ? [...row.x, e.c2[0]] : set === 'c2dna' ? [...row.x, ...e.c2.slice(1)] : set === 'c3only' ? [...row.x, ...e.c3] : [...row.x, ...e.c2, ...e.c3];
    return { ...row, x };
  };
  const KEYS = { v1: FEATURE_KEYS, c2: [...FEATURE_KEYS, ...C2_KEYS], c2elo: [...FEATURE_KEYS, C2_KEYS[0]], c2dna: [...FEATURE_KEYS, ...C2_KEYS.slice(1)], c3only: [...FEATURE_KEYS, ...C3_KEYS], c3: [...FEATURE_KEYS, ...C2_KEYS, ...C3_KEYS] };


  return { dataset, events, bouts, results, extrasOf, eloChoice, popMeans, withX, KEYS };
}
