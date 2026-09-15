// Training-row assembly for a set of completed events, in bounded batched reads.
//
// One code path for the daily increment (the few events graded since the parent
// dataset) and the weekly full rebuild (one calendar year per Workflow step).
// It feeds features_core.assembleBoutRow exactly the rows the batch builder
// uses for a bout dated D: snapshots with as_of_date <= D (latest wins), the
// fighter's and every opponent's bout-feature rows dated before D. Parity with
// the batch builder is proven by scripts/model/features_parity.test.mjs.

import { SNAPSHOT_SELECT, assembleBoutRow } from '../../../../scripts/model/features_core.mjs';
import { compactRow, labelFromResult } from './core.js';

const PAGE = 1000;

/** Every row of a filtered read, paged with a stable order (small result sets only). */
export async function readAll(q, path, order) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await q.get(`${path}&order=${order}&limit=${PAGE}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < PAGE) return out;
    if (offset > 200 * PAGE) throw new Error(`readAll: runaway pagination on ${path.split('?')[0]}`);
  }
}

async function inChunksAll(q, table, column, ids, select, extra, order, size) {
  const out = [];
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += size) {
    const chunk = list.slice(i, i + size).map((x) => `"${x}"`).join(',');
    out.push(...(await readAll(q, `${table}?select=${select}&${column}=in.(${chunk})${extra}`, order)));
  }
  return out;
}

/**
 * @param q       db client (supabase.js)
 * @param events  [{ id, name, event_date }] completed events
 * @param opts.upcoming  assemble scheduled, unresulted bouts instead (label null) for prediction-drift checks
 * @returns { rows: compact rows, ungraded: [bout_id], integrity: [...], skipped: [{bout_id, reason}] }
 */
export async function assembleEvents(q, events, { upcoming = false } = {}) {
  if (!events.length) return { rows: [], ungraded: [], integrity: [], skipped: [] };
  const eventById = new Map(events.map((e) => [e.id, e]));
  const bouts = await inChunksAll(q, 'ufc_bouts', 'event_id', events.map((e) => e.id),
    'id,event_id,fighter_a_id,fighter_b_id,weight_class,is_womens,is_title,scheduled_rounds,card_position,status', '&model_scope=eq.true', 'id', 20);
  const results = new Map((await inChunksAll(q, 'ufc_bout_results', 'bout_id', bouts.map((b) => b.id), 'bout_id,winner_id,method', '', 'bout_id', 60)).map((r) => [r.bout_id, r]));
  const graded = upcoming
    ? bouts.filter((b) => !results.has(b.id) && !['cancelled', 'replaced'].includes(b.status))
    : bouts.filter((b) => results.get(b.id)?.winner_id);
  const ungraded = bouts.filter((b) => !results.get(b.id)?.winner_id).map((b) => b.id);
  if (!graded.length) return { rows: [], ungraded, integrity: [], skipped: [] };

  const fighterIds = [...new Set(graded.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))];
  const maxDate = events.map((e) => e.event_date).sort().pop();
  const fighters = new Map((await inChunksAll(q, 'ufc_fighters', 'id', fighterIds, 'id,name,dob,height_in,reach_in,stance', '', 'id', 60)).map((f) => [f.id, f]));

  /* Snapshots: every definition-1 snapshot of these fighters dated on or before the shard's last event (median 8 per fighter); latestAsOf picks per bout. */
  const snapsOf = new Map(fighterIds.map((id) => [id, []]));
  for (const snap of await inChunksAll(q, 'ufc_fighter_dna_snapshots', 'fighter_id', fighterIds, SNAPSHOT_SELECT, `&definition_version=eq.1&as_of_date=lte.${maxDate}`, 'fighter_id,as_of_date', 20)) snapsOf.get(snap.fighter_id)?.push(snap);
  for (const arr of snapsOf.values()) arr.sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));

  /* Bout-feature ladder rows: the fighters', then their opponents'. Dated before the shard's last event. */
  const rowsOf = new Map();
  const addRows = (rows) => { for (const r of rows) { if (!rowsOf.has(r.fighter_id)) rowsOf.set(r.fighter_id, []); if (!rowsOf.get(r.fighter_id).some((x) => x.bout_id === r.bout_id)) rowsOf.get(r.fighter_id).push(r); } };
  const own = await inChunksAll(q, 'ufc_fighter_bout_features', 'fighter_id', fighterIds, 'fighter_id,bout_id,opponent_id,event_date,outcome,opp_totals:raw_stats->opp_totals', `&feature_version=eq.1&event_date=lt.${maxDate}`, 'fighter_id,bout_id', 10);
  addRows(own);
  const opponents = [...new Set(own.map((r) => r.opponent_id))].filter((id) => id && !fighterIds.includes(id));
  addRows(await inChunksAll(q, 'ufc_fighter_bout_features', 'fighter_id', opponents, 'fighter_id,bout_id,opponent_id,event_date,outcome', `&feature_version=eq.1&event_date=lt.${maxDate}`, 'fighter_id,bout_id', 10));

  const rows = [], integrity = [], skipped = [];
  for (const b of graded) {
    const event = eventById.get(b.event_id);
    let r;
    try { r = assembleBoutRow(b, event, fighters, snapsOf, rowsOf); } catch (e) { skipped.push({ bout_id: b.id, reason: `assembly failed: ${String(e?.message || e).slice(0, 120)}` }); continue; }
    integrity.push(...r.snapshot_integrity.map((s) => ({ ...s, bout_id: b.id })));
    if (upcoming) { if (!r.snapshot_integrity.some((x) => x.target_in_snapshot || x.snapshot_after_event)) rows.push(compactRow(r, null)); continue; }
    const label = labelFromResult(results.get(b.id), r.fighter_1_id, r.fighter_2_id);
    if (label == null) { skipped.push({ bout_id: b.id, reason: 'winner is neither corner' }); continue; }
    rows.push(compactRow(r, label));
  }
  return { rows, ungraded, integrity, skipped };
}
