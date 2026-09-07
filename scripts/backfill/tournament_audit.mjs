#!/usr/bin/env node
// Tournament and special-format audit. Read-only.
//
// Early UFC was not the modern card model: one-night brackets, alternates,
// openweight, superfights, and fighters with three bouts on the same evening.
// Forcing that into "one fighter, one bout, one event" loses the actual
// history, so the first job is to find out exactly what the source says
// rather than to start normalising guesses.
//
// This reports every distinct raw label containing tournament-like language,
// with counts, plus the same-event multi-bout fighters that prove a bracket
// existed. Nothing is normalised here and nothing is written.
//
//   node scripts/backfill/tournament_audit.mjs [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = {};
for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
}
const URL_ = (env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_ || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, accept: 'application/json' };
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

async function all(q, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${URL_}/rest/v1/${q}`, { headers: { ...H, Range: `${from}-${from + pageSize - 1}` } });
    if (!r.ok) throw new Error(`${q.split('?')[0]} -> ${r.status}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

/* Deliberately broad. The point is to discover vocabulary, not to confirm a
 * list we already believe in, so anything bracket-shaped is surfaced for a
 * human to read before any of it is normalised. */
const TOURNAMENT_RE = /tournament|quarter[- ]?final|semi[- ]?final|\bfinal\b|road to ufc|ultimate ultimate|alternate|reserve|superfight|open ?weight|catch ?weight|grand prix/i;

const main = async () => {
  const [events, bouts, fighters] = await Promise.all([
    all('ufc_events?select=id,name,event_date'),
    all('ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,weight_class,weight_class_raw,is_title,bout_order,card_position'),
    all('ufc_fighters?select=id,name'),
  ]);
  const evById = new Map(events.map((e) => [e.id, e]));
  const fnById = new Map(fighters.map((f) => [f.id, f.name]));

  /* ---- distinct raw labels ---- */
  const labels = new Map();
  for (const b of bouts) {
    const raw = (b.weight_class_raw || '').trim();
    if (!raw) continue;
    let v = labels.get(raw);
    if (!v) { v = { count: 0, titleFlagged: 0, years: new Set(), sample: null }; labels.set(raw, v); }
    v.count += 1;
    if (b.is_title) v.titleFlagged += 1;
    const d = evById.get(b.event_id)?.event_date;
    if (d) v.years.add(d.slice(0, 4));
    if (!v.sample) v.sample = evById.get(b.event_id)?.name || null;
  }
  const tournamentLabels = [...labels.entries()].filter(([raw]) => TOURNAMENT_RE.test(raw)).sort((a, b) => b[1].count - a[1].count);

  console.log('\n=== DISTINCT TOURNAMENT-LIKE SOURCE LABELS ===');
  console.log('these are raw source strings; none of them are normalised yet\n');
  console.log('count  title?  years                 label');
  for (const [raw, v] of tournamentLabels) {
    const yrs = [...v.years].sort();
    const span = yrs.length ? (yrs.length === 1 ? yrs[0] : `${yrs[0]}–${yrs[yrs.length - 1]}`) : '—';
    console.log(`${String(v.count).padStart(5)}  ${String(v.titleFlagged).padStart(5)}  ${span.padEnd(20)}  ${raw}`);
  }
  console.log(`\ndistinct tournament-like labels ${tournamentLabels.length} · distinct labels overall ${labels.size}`);

  /* ---- events that look like tournaments ---- */
  const tournamentEvents = new Map();
  for (const b of bouts) {
    if (!TOURNAMENT_RE.test(b.weight_class_raw || '')) continue;
    const e = evById.get(b.event_id);
    if (!e) continue;
    let v = tournamentEvents.get(e.id);
    if (!v) { v = { name: e.name, date: e.event_date, bouts: 0 }; tournamentEvents.set(e.id, v); }
    v.bouts += 1;
  }

  /* ---- same-event multi-bout fighters: the bracket signature ---- */
  const perEventFighter = new Map();
  for (const b of bouts) {
    for (const fid of [b.fighter_a_id, b.fighter_b_id]) {
      if (!fid) continue;
      const key = `${b.event_id}|${fid}`;
      let v = perEventFighter.get(key);
      if (!v) { v = { eventId: b.event_id, fighterId: fid, bouts: [] }; perEventFighter.set(key, v); }
      v.bouts.push(b);
    }
  }
  const multi = [...perEventFighter.values()].filter((v) => v.bouts.length > 1);
  const multiByEvent = new Map();
  for (const m of multi) {
    let v = multiByEvent.get(m.eventId);
    if (!v) { v = []; multiByEvent.set(m.eventId, v); }
    v.push(m);
  }

  console.log('\n=== SAME-EVENT MULTI-BOUT FIGHTERS ===');
  console.log('a fighter with more than one bout on a card is a bracket, not a data error\n');
  const rows = [...multiByEvent.entries()]
    .map(([eid, list]) => ({ e: evById.get(eid), list }))
    .filter((x) => x.e)
    .sort((a, b) => String(a.e.event_date).localeCompare(String(b.e.event_date)));
  for (const { e, list } of rows.slice(0, 30)) {
    console.log(`${e.event_date}  ${e.name}  ·  ${list.length} fighter(s) with multiple bouts`);
    for (const m of list.slice(0, 4)) {
      const seq = m.bouts.sort((x, y) => (x.bout_order ?? 0) - (y.bout_order ?? 0))
        .map((b) => `#${b.bout_order ?? '?'}${b.is_title ? ' [title-flagged]' : ''}`).join(' → ');
      console.log(`    ${(fnById.get(m.fighterId) || m.fighterId).padEnd(24)} ${m.bouts.length} bouts: ${seq}`);
    }
  }
  console.log(`\nevents with multi-bout fighters ${rows.length} · fighter-event pairs ${multi.length}`);

  /* ---- title-flag risk: a tournament final is not a divisional title ---- */
  const finalsFlaggedTitle = bouts.filter((b) => /tournament/i.test(b.weight_class_raw || '') && b.is_title);
  console.log('\n=== TITLE-FLAG RISK ===');
  console.log(`bouts whose raw label mentions a tournament AND are flagged is_title: ${finalsFlaggedTitle.length}`);
  console.log('each of these currently renders as a championship fight and probably should not.');
  for (const b of finalsFlaggedTitle.slice(0, 12)) {
    const e = evById.get(b.event_id);
    console.log(`  ${e?.event_date || '????'}  ${(e?.name || '').slice(0, 42).padEnd(42)}  ${b.weight_class_raw}`);
  }

  /* ---- special formats ---- */
  console.log('\n=== SPECIAL FORMATS ===');
  for (const [pat, name] of [[/open ?weight/i, 'openweight'], [/catch ?weight/i, 'catchweight'], [/superfight/i, 'superfight'], [/alternate|reserve/i, 'alternate/reserve'], [/ultimate ultimate/i, 'Ultimate Ultimate'], [/road to ufc/i, 'Road to UFC']]) {
    const hits = [...labels.entries()].filter(([raw]) => pat.test(raw));
    const total = hits.reduce((acc, [, v]) => acc + v.count, 0);
    console.log(`  ${name.padEnd(20)} ${String(total).padStart(4)} bouts across ${hits.length} distinct label(s)`);
  }

  /* ---- null weight class: unknown formats ---- */
  const nullWc = bouts.filter((b) => !b.weight_class);
  console.log(`\nbouts with no normalized weight class: ${nullWc.length} (early tournaments legitimately carry none)`);

  if (opt('--json')) {
    fs.writeFileSync(opt('--json'), JSON.stringify({
      generated_at: new Date().toISOString(),
      tournament_labels: tournamentLabels.map(([raw, v]) => ({ raw, count: v.count, title_flagged: v.titleFlagged, years: [...v.years].sort() })),
      tournament_events: [...tournamentEvents.entries()].map(([id, v]) => ({ id, ...v })),
      multi_bout_fighter_events: rows.map(({ e, list }) => ({
        event_id: e.id, event: e.name, date: e.event_date,
        fighters: list.map((m) => ({ fighter_id: m.fighterId, name: fnById.get(m.fighterId) || null, bouts: m.bouts.map((b) => ({ id: b.id, order: b.bout_order, raw: b.weight_class_raw, is_title: b.is_title })) })),
      })),
      title_flag_risk: finalsFlaggedTitle.map((b) => ({ bout_id: b.id, raw: b.weight_class_raw, event: evById.get(b.event_id)?.name || null })),
      counts: { tournament_labels: tournamentLabels.length, tournament_events: tournamentEvents.size, multi_bout_pairs: multi.length, null_weight_class: nullWc.length },
    }, null, 2) + '\n');
    console.log(`\njson -> ${opt('--json')}`);
  }
};
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
