#!/usr/bin/env node
/* Contender Series round-stat repair — manual tool, bounded by identity.
 *
 * UFC Stats hosts Dana White's Contender Series cards ("DWCS 9.2") with full
 * per-round tables, but its completed-events list omits them, so neither the
 * Python backfill nor the ufc-stats-ingest lane can discover them. The only
 * route in is a fighter's UFC Stats history page. This tool uses that route
 * ONLY for bouts whose BOTH fighters are already linked to UFC Stats ids:
 * identity is decided by those ids, never by a name.
 *
 *   node scripts/backfill/dwcs_round_repair.mjs plan     # writes dwcs_want_fighters.json
 *   python scripts/backfill/capture_pages.py dwcs_want_fighters.json
 *   node scripts/backfill/dwcs_round_repair.mjs resolve  # writes dwcs_want_fights.json
 *   python scripts/backfill/capture_pages.py dwcs_want_fights.json
 *   node scripts/backfill/dwcs_round_repair.mjs check    # parse + validate, no writes
 *   node scripts/backfill/dwcs_round_repair.mjs apply    # writes validated bouts only
 *
 * Writes mirror the ufc-stats-ingest lane exactly: the production parser
 * (parity with the stored archive: 539 fights, 54,472 cells, 0 mismatches,
 * 2026-09-10), validateFight() must return no problems, the stored method must
 * agree, rows upsert on the PK (bout_id,fighter_id,round), rows written is an
 * observed before/after count, the bout gets its ufcstats_id (refused if any
 * other bout already holds it), the result gets its stats marks.
 *
 * DWCS EVENTS ARE NEVER LINKED (ufc_events.ufcstats_id). A linked event enters
 * backfill_ufcstats.py's event walk, which creates stub fighters and duplicate
 * bouts for the many DWCS fighters who were never identity-linked; a dry run
 * on 2026-09-10 showed exactly that. Re-running apply is idempotent.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (repo .env); HTML_CACHE_DIR
 * (default scripts/backfill/cache) is where capture_pages.py stored pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WORKER = path.join(ROOT, 'workers', 'ufc-stats-ingest');
const P = await import(pathToFileURL(path.join(WORKER, 'src', 'parsers.mjs')).href);
const { validateFight, roundRowsFor, isContenderSeries } = await import(pathToFileURL(path.join(WORKER, 'src', 'lane.mjs')).href);
const { isInterstitial } = await import(pathToFileURL(path.join(WORKER, 'src', 'ufcstats.mjs')).href);
const cheerio = await import(pathToFileURL(path.join(WORKER, 'node_modules', 'cheerio', 'dist', 'esm', 'index.js')).href);

const env = { ...Object.fromEntries((fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '')
  .replace(/^﻿/, '').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])), ...process.env };
const CACHE = path.resolve(ROOT, env.HTML_CACHE_DIR ? path.resolve(process.cwd(), env.HTML_CACHE_DIR) : path.join(HERE, 'cache'));
const BASE = String(env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!BASE || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: KEY, 'content-type': 'application/json', ...(KEY.startsWith('eyJ') ? { authorization: `Bearer ${KEY}` } : {}) };

async function rest(p, init = {}) {
  const res = await fetch(`${BASE}/rest/v1/${p}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!res.ok && res.status !== 206) throw new Error(`${init.method || 'GET'} ${p.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}
/* PostgREST caps a response at 1000 rows; always page. */
async function all(p) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await (await rest(p, { headers: { range: `${from}-${from + 999}` } })).json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

const page = (kind, id) => {
  const f = path.join(CACHE, kind, `${id}.html`);
  if (!fs.existsSync(f)) return null;
  const h = fs.readFileSync(f, 'utf8');
  return isInterstitial(h) ? null : h;
};
const DAY = 86400000;
const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= DAY;   // UFC Stats dates are US-local, ESPN's UTC
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const isoDate = (s) => { const m = /([A-Za-z]{3})\.?\s+(\d{1,2}),\s+(\d{4})/.exec(s || ''); return m ? `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };

function history(fighterUfc) {
  const h = page('fighters', fighterUfc); if (!h) return null;
  const $ = cheerio.load(h); const rows = [];
  $('tr.b-fight-details__table-row').each((_, tr) => {
    const ev = $(tr).find('a[href*="event-details"]').first(); if (!ev.length) return;
    const fight = ($(tr).attr('data-link') || '').match(/([0-9a-f]{16})$/)?.[1] || null;
    const opp = $(tr).find('a[href*="fighter-details"]').toArray().map((a) => ($(a).attr('href') || '').match(/([0-9a-f]{16})$/)?.[1]).filter((x) => x && x !== fighterUfc);
    rows.push({ fight, event_name: ev.text().trim(), date: isoDate($(tr).find('td').toArray().map((td) => $(td).text()).join(' ')), opponent: opp[0] || null });
  });
  return rows;
}

async function targets() {
  const events = new Map((await all('ufc_events?select=id,name,event_date')).filter((e) => isContenderSeries(e.name)).map((e) => [e.id, e]));
  const bouts = (await all('ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,scheduled_rounds&order=id')).filter((b) => events.has(b.event_id));
  const ids = bouts.map((b) => b.id);
  const withRows = new Set(); const results = new Map(); const fighterIds = new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]));
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80).join(',');
    for (const r of await all(`ufc_bout_round_stats?select=bout_id&bout_id=in.(${chunk})`)) withRows.add(r.bout_id);
    for (const r of await all(`ufc_bout_results?select=bout_id,winner_id,method,round&bout_id=in.(${chunk})`)) results.set(r.bout_id, r);
  }
  const fighters = new Map();
  const fids = [...fighterIds];
  for (let i = 0; i < fids.length; i += 80) for (const f of await all(`ufc_fighters?select=id,name,ufcstats_id&id=in.(${fids.slice(i, i + 80).join(',')})`)) fighters.set(f.id, f);
  return bouts.filter((b) => results.has(b.id) && !withRows.has(b.id)).map((b) => ({
    bout: b, event: events.get(b.event_id), result: results.get(b.id), a: fighters.get(b.fighter_a_id), b: fighters.get(b.fighter_b_id),
  })).filter((t) => t.a?.ufcstats_id && t.b?.ufcstats_id);
}

function resolve(t) {
  const hits = [];
  for (const [me, them] of [[t.a.ufcstats_id, t.b.ufcstats_id], [t.b.ufcstats_id, t.a.ufcstats_id]]) {
    for (const x of history(me) || []) if (x.opponent === them && x.date && near(x.date, t.event.event_date) && /^DWCS|contender/i.test(x.event_name)) hits.push(x);
  }
  const fights = [...new Set(hits.map((x) => x.fight))];
  return fights.length === 1 ? { fight: fights[0], date: hits[0].date } : { status: hits.length ? 'fight_ambiguous' : 'fight_not_resolved' };
}

const mode = process.argv[2];
const list = await targets();
console.log(`targets (DWCS, result, no round rows, both fighters UFC Stats-linked): ${list.length}`);
if (mode === 'plan') {
  const want = list.filter((t) => !page('fighters', t.a.ufcstats_id) && !page('fighters', t.b.ufcstats_id)).map((t) => ({ kind: 'fighters', id: t.a.ufcstats_id }));
  fs.writeFileSync('dwcs_want_fighters.json', JSON.stringify(want)); console.log({ fighter_pages_to_capture: want.length });
} else if (mode === 'resolve') {
  const want = []; const s = {};
  for (const t of list) { const r = resolve(t); s[r.status || 'resolved'] = (s[r.status || 'resolved'] || 0) + 1; if (r.fight && !page('fights', r.fight)) want.push({ kind: 'fights', id: r.fight, min_ts: r.date.replaceAll('-', '') }); }
  fs.writeFileSync('dwcs_want_fights.json', JSON.stringify(want)); console.log({ ...s, fight_pages_to_capture: want.length });
} else if (mode === 'check' || mode === 'apply') {
  const valid = []; const s = {};
  for (const t of list) {
    const r = resolve(t); let st = r.status;
    if (r.fight) {
      const url = `http://ufcstats.com/fight-details/${r.fight}`; const html = page('fights', r.fight);
      if (!html) st = 'no_capture';
      else if (P.isPreResultFightPage(html)) st = 'preview_capture';
      else {
        let f; try { f = P.parseFightPage(html, url); } catch { st = 'parser_failure'; }
        if (f && !f.rounds.length) st = 'source_no_round_detail';
        else if (f) {
          const problems = validateFight({ parsed: f, fighterA: t.a, fighterB: t.b, result: t.result });
          if (f.method !== t.result.method) problems.push(`method: stored ${t.result.method} vs page ${f.method}`);
          st = problems.length ? 'validation_failed' : 'valid';
          if (problems.length) console.log('  validation_failed', t.bout.id, problems.join('; '));
          else valid.push({ t, fight: r.fight, f, url });
        }
      }
    }
    s[st] = (s[st] || 0) + 1;
  }
  console.log(s);
  if (mode === 'apply') {
    const count = async (b) => { const cr = (await rest(`ufc_bout_round_stats?select=bout_id&bout_id=eq.${b}`, { headers: { prefer: 'count=exact', range: '0-0' } })).headers.get('content-range'); return Number(cr.slice(cr.lastIndexOf('/') + 1)); };
    let written = 0, applied = 0, skipped = 0;
    for (const { t, fight, f, url } of valid) {
      const taken = await (await rest(`ufc_bouts?select=id&ufcstats_id=eq.${fight}`)).json();
      if (taken.length && taken[0].id !== t.bout.id) { skipped += 1; console.log('  skip: ufcstats_id held by', taken[0].id); continue; }
      const at = new Date().toISOString();
      const rows = roundRowsFor(f, t.a, t.b, t.bout.id, url, at);
      const before = await count(t.bout.id);
      await rest('ufc_bout_round_stats?on_conflict=bout_id,fighter_id,round', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      const after = await count(t.bout.id);
      if (after !== rows.length) throw new Error(`bout ${t.bout.id}: ${after} rows after upsert, parsed ${rows.length}`);
      await rest(`ufc_bouts?id=eq.${t.bout.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ ufcstats_id: fight, ...(t.bout.scheduled_rounds == null && f.scheduled_rounds != null ? { scheduled_rounds: f.scheduled_rounds } : {}), updated_at: at }) });
      await rest(`ufc_bout_results?bout_id=eq.${t.bout.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ stats_source_url: url, stats_captured_at: at, has_stats: true,
        ...(f.scorecards ? { scorecards: f.scorecards, judge_1: f.scorecards[0]?.judge ?? null, judge_2: f.scorecards[1]?.judge ?? null, judge_3: f.scorecards[2]?.judge ?? null } : {}) }) });
      written += after - before; applied += 1;
    }
    console.log({ applied, skipped, round_rows_written: written });
  }
} else {
  console.error('mode: plan | resolve | check | apply'); process.exit(2);
}
