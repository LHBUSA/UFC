/* PBE Fight State Ledger — append-only fight-week snapshots per bout.
 *
 *   node scripts/ledger/capture_fight_state.mjs --auto            # capture every checkpoint that is due now
 *   node scripts/ledger/capture_fight_state.mjs --checkpoint ad_hoc [--event <substring>] [--dry-run] [--json]
 *
 * Checkpoints (relative to the ESPN scheduled start of the event; when the
 * start is unknown the event date at 22:00 UTC is assumed and recorded in
 * provenance.checkpoint_basis):
 *   t_minus_7d (start-168h)  t_minus_72h (start-72h)  t_minus_24h (start-24h)
 *   post_weigh_in (start-26h until weigh-in ingestion exists; basis recorded)
 *   t_minus_3h (start-3h)    close (start-1h)   post_result (once a result row exists)
 * A checkpoint is captured once per bout, only inside its window
 * [checkpoint_time, checkpoint_time + LATE_HOURS]. Missed windows are never
 * back-filled: the point of the ledger is state that cannot be recreated.
 * Rows are inserted, never updated (the table trigger enforces it). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_VERSION = 1;
const BUILDER = 'scripts/ledger/capture_fight_state.mjs@1';
const LATE_HOURS = 12;
const ASSUMED_START_UTC = 'T22:00:00Z';
const CHECKPOINTS = [
  ['t_minus_7d', 168], ['t_minus_72h', 72], ['post_weigh_in', 26], ['t_minus_24h', 24], ['t_minus_3h', 3], ['close', 1],
];

const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const URL_ = (process.env.SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const AUTO = args.includes('--auto');
const CHECKPOINT = opt('--checkpoint', AUTO ? null : 'ad_hoc');
const DRY = args.includes('--dry-run');
const EVENT_FILTER = (opt('--event', '') || '').toLowerCase();
const JSON_OUT = args.includes('--json');
const NOW = new Date();
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

async function rest(path) {
  const out = []; let off = 0;
  for (;;) {
    const res = await fetch(`${URL_}/rest/v1/${path}${path.includes('?') ? '&' : '?'}offset=${off}&limit=1000`, { headers: H });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${res.status} ${await res.text()}`);
    const rows = await res.json(); out.push(...rows);
    if (rows.length < 1000) return out; off += 1000;
  }
}
async function insert(rows) {
  if (DRY || !rows.length) return rows.length;
  const res = await fetch(`${URL_}/rest/v1/ufc_fight_state_ledger`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
  if (!res.ok) throw new Error(`ledger insert -> HTTP ${res.status} ${await res.text()}`);
  return rows.length;
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
async function espnStart(espnEventId) {
  if (!espnEventId) return null;
  try {
    const res = await fetch(`https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/${espnEventId}?lang=en&region=us`, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.date ? new Date(j.date).toISOString() : null;
  } catch { return null; }
}
const iso = (d) => new Date(d).toISOString();
const hours = (a, b) => (new Date(a).getTime() - new Date(b).getTime()) / 3600e3;
const compactFighter = (f, rank) => ({ id: f.id, name: f.name, nickname: f.nickname, stance: f.stance, slug_id: f.espn_athlete_id || f.ufcstats_id || null, record: { w: f.record_w, l: f.record_l, d: f.record_d, nc: f.record_nc }, dob: f.dob, height_in: f.height_in, reach_in: f.reach_in, weight_lbs: f.weight_lbs, is_active: f.is_active, updated_at: f.updated_at, rankings: rank });
const pick = (m, keys) => Object.fromEntries(keys.filter((k) => m && m[k]).map((k) => [k, m[k]]));

async function main() {
  const today = NOW.toISOString().slice(0, 10);
  const from = new Date(NOW.getTime() - 3 * 86400e3).toISOString().slice(0, 10);
  const to = new Date(NOW.getTime() + 9 * 86400e3).toISOString().slice(0, 10);
  const events = (await rest(`ufc_events?select=id,name,event_date,espn_event_id,ufcstats_id,venue,city,region,country,card_status,updated_at&event_date=gte.${from}&event_date=lte.${to}&order=event_date.asc`)) || [];
  const evs = events.filter((e) => !EVENT_FILTER || e.name.toLowerCase().includes(EVENT_FILTER));
  if (!evs.length) { log('[ledger] no events in window'); return finish({ events: 0 }); }
  const evIds = evs.map((e) => e.id);
  const bouts = (await rest(`ufc_bouts?select=*,fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(*),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(*)&event_id=in.(${evIds.join(',')})&order=bout_order.desc`)) || [];
  const results = new Map(((await rest(`ufc_bout_results?select=*&bout_id=in.(${bouts.map((b) => b.id).join(',')})`)) || []).map((r) => [r.bout_id, r]));
  const existing = (await rest(`ufc_fight_state_ledger?select=bout_id,checkpoint,captured_at&event_id=in.(${evIds.join(',')})`)) || [];
  const have = new Set(existing.map((r) => `${r.bout_id}:${r.checkpoint}`));
  const fighterIds = [...new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))];

  /* rankings: latest snapshot in the table, else unavailable */
  const rankRows = await rest(`ufc_rankings?select=snapshot_date,division,is_womens,is_p4p,rank,fighter_id,name_raw,captured_at&fighter_id=in.(${fighterIds.join(',')})&order=snapshot_date.desc`);
  const latestSnap = rankRows?.length ? rankRows[0].snapshot_date : null;
  const rankBy = new Map();
  for (const r of rankRows || []) if (r.snapshot_date === latestSnap) { if (!rankBy.has(r.fighter_id)) rankBy.set(r.fighter_id, []); rankBy.get(r.fighter_id).push({ division: r.division, is_womens: r.is_womens, is_p4p: r.is_p4p, rank: r.rank }); }

  /* Fight DNA: latest snapshot at or before today per fighter */
  const dnaRows = await rest(`ufc_fighter_dna_snapshots?select=fighter_id,as_of_date,definition_version,sample_bouts,sample_completed_bouts,sample_stat_bouts,sample_rounds,sample_seconds,coverage_status,metrics,stance_splits,round_profile,finish_profile,generated_at&fighter_id=in.(${fighterIds.join(',')})&as_of_date=lte.${today}&order=as_of_date.desc,definition_version.desc`);
  const dnaBy = new Map();
  for (const r of dnaRows || []) if (!dnaBy.has(r.fighter_id)) dnaBy.set(r.fighter_id, r);

  /* wire: attributed items linked to the event, bout or either fighter, last 14 days */
  const since = new Date(NOW.getTime() - 14 * 86400e3).toISOString();
  const wireRows = (await rest(`ufc_news_items?select=id,title,url,published_at,captured_at,taxonomy,fighter_ids,event_id,bout_id,source:ufc_news_sources(name)&published_at=gte.${since}&order=published_at.desc`)) || [];
  const artRows = (await rest(`ufc_articles?select=id,slug,headline,story_type,status,updated_at,bout_id,event_id,fighter_ids,fact_block->>version&status=eq.published&event_id=in.(${evIds.join(',')})`)) || [];

  const rows = []; const skipped = []; const missed = [];
  for (const e of evs) {
    const start = await espnStart(e.espn_event_id);
    const startIso = start || `${e.event_date}${ASSUMED_START_UTC}`;
    const basis = start ? 'espn_event_start' : 'event_date_22z_assumed';
    for (const b of bouts.filter((x) => x.event_id === e.id)) {
      const res = results.get(b.id) || null;
      const due = [];
      if (AUTO) {
        for (const [cp, hBefore] of CHECKPOINTS) {
          const at = new Date(new Date(startIso).getTime() - hBefore * 3600e3);
          const age = hours(NOW, at);
          if (age < 0) continue;                                   // not yet
          if (have.has(`${b.id}:${cp}`)) continue;                 // captured once
          if (age > LATE_HOURS) { missed.push({ bout: b.id, checkpoint: cp, hours_late: Math.round(age) }); continue; }
          due.push(cp);
        }
        if (res && !have.has(`${b.id}:post_result`)) due.push('post_result');
      } else if (CHECKPOINT) {
        if (CHECKPOINT !== 'ad_hoc' && have.has(`${b.id}:${CHECKPOINT}`)) { skipped.push({ bout: b.id, checkpoint: CHECKPOINT }); } else due.push(CHECKPOINT);
      }
      for (const cp of due) {
        const fa = b.fighter_a, fb = b.fighter_b;
        const dna = (f, opp) => {
          const s = dnaBy.get(f.id);
          if (!s) return { status: 'unavailable', reason: 'no_snapshot' };
          const oppStance = opp.stance || 'UNKNOWN';
          return {
            status: 'ok', as_of_date: s.as_of_date, definition_version: s.definition_version, coverage_status: s.coverage_status,
            sample: { bouts: s.sample_bouts, completed_bouts: s.sample_completed_bouts, stat_bouts: s.sample_stat_bouts, rounds: s.sample_rounds, seconds: s.sample_seconds },
            metrics: pick(s.metrics, ['sig_landed_per_min', 'sig_absorbed_per_min', 'sig_accuracy', 'sig_defense', 'head_attack_share', 'body_attack_share', 'leg_attack_share', 'distance_attack_share', 'clinch_attack_share', 'ground_attack_share', 'knockdowns_per_15', 'td_attempts_per_15', 'td_accuracy', 'control_seconds_per_td', 'sub_attempts_per_15']),
            pace: pick(s.round_profile, ['pace_retention_r2_vs_r1', 'pace_retention_r3_vs_r1', 'championship_round_delta']),
            finish: pick(s.finish_profile, ['finish_rate', 'ko_finish_rate', 'submission_finish_rate', 'finish_round_distribution']),
            vs_opponent_stance: { opponent_stance: oppStance, split: s.stance_splits?.[oppStance] || null },
            generated_at: s.generated_at,
          };
        };
        const wire = wireRows.filter((n) => n.bout_id === b.id || n.event_id === e.id || (n.fighter_ids || []).some((id) => id === fa.id || id === fb.id));
        const arts = artRows.filter((a) => a.bout_id === b.id || (a.event_id === e.id && (a.fighter_ids || []).some((id) => id === fa.id || id === fb.id)));
        const scheduledStart = new Date(startIso);
        rows.push({
          bout_id: b.id, event_id: e.id, checkpoint: cp, ledger_version: LEDGER_VERSION, captured_at: NOW.toISOString(),
          scheduled_start: startIso, event_date: e.event_date, hours_to_start: Number(hours(scheduledStart, NOW).toFixed(2)),
          bout_state: { status: b.status, card_position: b.card_position, bout_order: b.bout_order, is_main_event: b.bout_order === Math.max(...bouts.filter((x) => x.event_id === e.id).map((x) => x.bout_order)), scheduled_rounds: b.scheduled_rounds, is_title: b.is_title, weight_class: b.weight_class, weight_class_raw: b.weight_class_raw, is_womens: b.is_womens, short_notice_days: b.short_notice_days, replaced_bout_id: b.replaced_bout_id, espn_competition_id: b.espn_competition_id, ufcstats_id: b.ufcstats_id, bout_updated_at: b.updated_at, event: { name: e.name, card_status: e.card_status, venue: e.venue, city: e.city, region: e.region, country: e.country, event_updated_at: e.updated_at } },
          fighters: { a: compactFighter(fa, rankBy.get(fa.id) || null), b: compactFighter(fb, rankBy.get(fb.id) || null), stance_context: !fa.stance || !fb.stance ? 'unknown' : (fa.stance === 'SWITCH' || fb.stance === 'SWITCH') ? 'switch_involved' : fa.stance === fb.stance ? 'same' : 'open' },
          rankings: rankRows === null ? { status: 'unavailable', reason: 'table_missing' } : latestSnap ? { status: 'ok', snapshot_date: latestSnap, a: rankBy.get(fa.id) || [], b: rankBy.get(fb.id) || [] } : { status: 'unavailable', reason: 'no_snapshot' },
          dna: dnaRows === null ? { status: 'unavailable', reason: 'table_missing' } : { a: dna(fa, fb), b: dna(fb, fa) },
          weigh_in: { status: 'unavailable', reason: 'weigh_in_ingestion_not_built' },
          wire: { status: 'ok', count: wire.length, items: wire.slice(0, 40).map((n) => ({ id: n.id, title: n.title, url: n.url, source: n.source?.name || null, published_at: n.published_at, labels: n.taxonomy?.labels || [], links: { bout: n.bout_id === b.id, event: n.event_id === e.id, fighters: (n.fighter_ids || []).filter((id) => id === fa.id || id === fb.id) } })), articles: arts.map((a) => ({ id: a.id, slug: a.slug, headline: a.headline, story_type: a.story_type, fact_block_version: a.version ?? a['fact_block'] ?? null, updated_at: a.updated_at })) },
          odds: { status: 'unavailable', reason: 'no_odds_provider_connected' },
          market: { status: 'unavailable', reason: 'no_odds_provider_connected' },
          model: { status: 'unavailable', reason: 'no_model_output_exists' },
          result: res ? { status: 'final', winner_id: res.winner_id, method: res.method, method_raw: res.method_raw, round: res.round, time_sec: res.time_sec, time_format: res.time_format, referee: res.referee, finish_detail: res.finish_detail, result_source: res.result_source, has_stats: res.has_stats, captured_at: res.captured_at } : { status: 'pending' },
          provenance: {
            builder: BUILDER, checkpoint_basis: basis, scheduled_start_source: start ? 'espn_core_api' : 'assumed', captured_at: NOW.toISOString(),
            sources: { bout: { table: 'ufc_bouts', updated_at: b.updated_at }, event: { table: 'ufc_events', updated_at: e.updated_at }, fighters: { table: 'ufc_fighters', updated_at: [fa.updated_at, fb.updated_at] }, result: res ? { table: 'ufc_bout_results', captured_at: res.captured_at } : null, rankings: latestSnap ? { table: 'ufc_rankings', snapshot_date: latestSnap } : null, dna: { table: 'ufc_fighter_dna_snapshots', a_generated_at: dnaBy.get(fa.id)?.generated_at || null, b_generated_at: dnaBy.get(fb.id)?.generated_at || null }, wire: { table: 'ufc_news_items', window_days: 14, newest_published_at: wire[0]?.published_at || null } },
          },
        });
      }
    }
  }
  const n = await insert(rows);
  return finish({ events: evs.length, bouts: bouts.length, inserted: DRY ? 0 : n, would_insert: DRY ? n : undefined, skipped_existing: skipped.length, missed_windows: missed.length, checkpoints: rows.reduce((m, r) => ({ ...m, [r.checkpoint]: (m[r.checkpoint] || 0) + 1 }), {}), missed });
}
function finish(summary) {
  if (JSON_OUT) console.log(JSON.stringify(summary, null, 2)); else console.log(`[ledger] ${JSON.stringify({ ...summary, missed: undefined })}${summary.missed?.length ? ` missed=${summary.missed.length} (windows older than ${LATE_HOURS}h are never back-filled)` : ''}`);
  return summary;
}
main().catch((e) => { console.error('[ledger] FAILED', e.message); process.exit(1); });
