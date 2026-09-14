#!/usr/bin/env node
/* Round-level source scout for ONE bout missing round rows. READ-ONLY.
 *
 *   node scripts/sources/dwcs_round_source_scout.mjs --bout <uuid> [--official-event <id>] [--scan 1320-1340] [--out <file>]
 *   env: UFC_ENV_FILE (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *
 * For each candidate source it records: provider, endpoint, HTTP result, event
 * identity, bout identity, fighter identities, both corners, round count, round
 * stat fields, freshness, DWCS coverage, access/terms notes, request cost and
 * whether identity is deterministic. It never writes to the database and never
 * requests ufcstats.com (blocked: challenge on every automated read).
 *
 * Candidates, in the order the lanes would use them:
 *   A. UFC official statistics feed (d29dxerjsp82wz.cloudfront.net/api/v3)
 *   B. ESPN core API (already the results/identity source)
 *   C. UFC Stats (BLOCKED; reported from stored source health, no request)
 *   D. Internet Archive captures of UFC Stats pages (CDX only)
 *   E. Licensed providers (not in our architecture; no request)
 */
import fs from 'node:fs';
import dns from 'node:dns';
import {
  parseOfficialEvent, parseOfficialFight, officialReadiness, sameOfficialEvent, mapOfficialFighters, validateOfficialFight,
  officialRoundRows, officialEventUrl, officialFightUrl, contenderSeasonWeek, ROUND_COLUMNS,
} from '../../workers/ufc-stats-ingest/src/ufcOfficial.mjs';

dns.setDefaultResultOrder('ipv4first');
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BOUT = arg('bout');
if (!BOUT) { console.error('usage: --bout <uuid> [--official-event <id>] [--scan 1320-1340] [--out file]'); process.exit(2); }

const env = {};
for (const line of fs.readFileSync(process.env.UFC_ENV_FILE || 'D:/Workers/secrets/ufc-propbetedge.env', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const DB = env.SUPABASE_URL.replace(/\/$/, '');
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
const db = async (p) => { const r = await fetch(`${DB}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`db ${p} ${r.status}`); return r.json(); };

/* Polite external GET: 1.5s spacing, one retry on a transport failure only. */
let lastAt = 0;
async function get(url, { json = true, headers = {} } = {}) {
  const wait = lastAt + 1500 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    lastAt = Date.now();
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'PropBetEdge source scout (read-only)', ...headers } });
      const text = await res.text();
      const out = { url, status: res.status, ms: Date.now() - t0, bytes: text.length, date: res.headers.get('date'), last_modified: res.headers.get('last-modified'), cache: res.headers.get('x-cache'), attempt };
      if (json) { try { out.body = JSON.parse(text); } catch { out.body = null; out.not_json = true; } } else out.body = text;
      return out;
    } catch (e) {
      if (attempt === 1) return { url, status: 'transport_error', detail: String(e?.cause?.code || e?.message || e).slice(0, 80), attempt };
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
const requests = [];
const logged = async (candidate, url, opts) => { const r = await get(url, opts); requests.push({ candidate, url, status: r.status, ms: r.ms, bytes: r.bytes }); return r; };

/* ---------------------------------------------------------------- our bout */
const bout = (await db(`ufc_bouts?select=id,event_id,ufcstats_id,espn_competition_id,fighter_a_id,fighter_b_id,status,scheduled_rounds,bout_order&id=eq.${BOUT}`))[0];
if (!bout) throw new Error('unknown bout');
const event = (await db(`ufc_events?select=id,name,event_date,ufcstats_id,espn_event_id&id=eq.${bout.event_id}`))[0];
const fighters = await db(`ufc_fighters?select=id,name,dob,ufcstats_id,espn_athlete_id&id=in.(${bout.fighter_a_id},${bout.fighter_b_id})`);
const fa = fighters.find((f) => f.id === bout.fighter_a_id);
const fb = fighters.find((f) => f.id === bout.fighter_b_id);
const aliasRows = await db(`ufc_fighter_aliases?select=fighter_id,alias,source&fighter_id=in.(${fa.id},${fb.id})`);
const aliases = new Map([[fa.id, aliasRows.filter((a) => a.fighter_id === fa.id).map((a) => a.alias)], [fb.id, aliasRows.filter((a) => a.fighter_id === fb.id).map((a) => a.alias)]]);
const result = (await db(`ufc_bout_results?select=winner_id,method,round,time_sec,result_source,referee&bout_id=eq.${bout.id}`))[0] || null;
const roundRows = (await db(`ufc_bout_round_stats?select=bout_id&bout_id=eq.${bout.id}`)).length;
const queue = (await db(`ufc_round_stat_queue?select=state,last_reason&bout_id=eq.${bout.id}`))[0] || null;
const report = {
  at: new Date().toISOString(), tool: 'scripts/sources/dwcs_round_source_scout.mjs', database_writes: 0,
  bout: { id: bout.id, event: { id: event.id, name: event.name, event_date: event.event_date, contender: contenderSeasonWeek(event.name), espn_event_id: event.espn_event_id, ufcstats_id: event.ufcstats_id },
    fighters: [fa, fb].map((f) => ({ id: f.id, name: f.name, ufcstats_id: f.ufcstats_id, espn_athlete_id: f.espn_athlete_id, aliases: aliases.get(f.id) })),
    stored_result: result, stored_round_rows: roundRows, queue },
  candidates: {},
};

/* ------------------------------------------- A. UFC official statistics feed */
{
  const c = { provider: 'UFC (official fight statistics feed behind UFC.com)', base: 'https://d29dxerjsp82wz.cloudfront.net/api/v3', access: 'public JSON, no key; UFC-owned; already used in production (ufc-stats-ingest official lane, v0.7.x)' };
  report.candidates.ufc_official = c;
  let official = null;
  const tryEvent = async (id) => {
    const r = await logged('ufc_official', officialEventUrl(id));
    if (r.status !== 200 || !r.body) return { id, status: r.status };
    const p = parseOfficialEvent(r.body);
    return { id, status: r.status, name: p.name, date: p.date, feed_status: p.status, fights: p.fightIds?.length, match: !p.error && sameOfficialEvent(p, event), parsed: p, http: { date: r.date, cache: r.cache } };
  };
  if (arg('official-event')) {
    const t = await tryEvent(arg('official-event'));
    c.event_lookup = [{ ...t, parsed: undefined }];
    if (t.match) official = t;
  } else {
    const [lo, hi] = String(arg('scan', '1320-1340')).split('-').map(Number);
    c.event_lookup = [];
    for (let id = lo; id <= hi && !official; id += 1) {
      const t = await tryEvent(id);
      c.event_lookup.push({ ...t, parsed: undefined });
      if (t.match) official = t;
    }
  }
  if (!official) {
    c.verdict = 'no matching official event found'; c.viable = false;
  } else {
    c.event_identity = { official_event_id: official.id, official_name: official.name, official_date: official.date, our_name: event.name, our_date: event.event_date,
      rule: contenderSeasonWeek(event.name) ? 'Contender Series season + week + date (+-1 day)' : 'numbered event or normalized name + date', deterministic: true };
    const docs = [];
    for (const fid of official.parsed.fightIds) {
      const r = await logged('ufc_official', officialFightUrl(fid));
      docs.push(r.status === 200 && r.body ? { fid, url: r.url, parsed: parseOfficialFight(r.body), http: { date: r.date, cache: r.cache } } : { fid, url: r.url, status: r.status });
    }
    const matches = docs.filter((d) => d.parsed && !d.parsed.error).map((d) => ({ d, m: mapOfficialFighters(d.parsed, fa, fb, aliases) })).filter((x) => x.m.map);
    c.bout_identity = { fights_on_card: docs.length, exact_corner_matches: matches.length, fetch_failures: docs.filter((d) => !d.parsed).map((d) => ({ fight_id: d.fid, status: d.status })) };
    if (matches.length !== 1) {
      c.verdict = matches.length ? 'ambiguous: more than one official fight matches both corners' : 'no official fight matches both corners exactly'; c.viable = false;
    } else {
      const { d, m } = matches[0];
      const p = d.parsed;
      const problems = validateOfficialFight({ parsed: p, mapping: m, result });
      const ready = officialReadiness(p);
      const rows = problems.length || !ready.ready ? [] : officialRoundRows(p, m, bout.id, d.url, '(not written)');
      const byRound = new Map();
      for (const r of p.rounds) { if (!byRound.has(r.round)) byRound.set(r.round, new Set()); byRound.get(r.round).add(r.official_fighter_id); }
      Object.assign(c.bout_identity, { official_fight_id: d.fid, endpoint: d.url, fighter_identities: m.via, deterministic: true, ambiguity: 'none' });
      c.source_says = { status: p.status, official_stats: p.official, fighters: p.fighters.map((x) => ({ official_id: x.official_id, name: x.name, outcome: x.outcome })), result: p.result, possible_rounds: p.possible_rounds };
      c.validation = { readiness: ready, problems, winner_agrees: !problems.some((x) => /winner/.test(x)), finish_round_agrees: !problems.some((x) => /finish round/.test(x)), finish_time_agrees: !problems.some((x) => /finish time/.test(x)) };
      c.rounds = { count: byRound.size, rounds: [...byRound.keys()].sort((a, b) => a - b), corners_per_round: Object.fromEntries([...byRound].map(([k, v]) => [k, v.size])), both_corners_every_round: [...byRound.values()].every((v) => v.size === 2) };
      c.round_stat_fields = ROUND_COLUMNS.map(([col, key]) => `${col} <- ${key}`);
      c.freshness = { feed_status: p.status, official_stats: p.official, http_date: d.http?.date, cache: d.http?.cache, note: 'the feed carries no capture timestamp; OfficialStats marks the numbers final' };
      c.parsed_rows_would_write = rows;
      c.dwcs_coverage = 'Season 10 weeks 1-5 are official events 1328, 1329, 1330, 1333, 1334 (named "DWCS 10.<week>"); not on UFC.com event pages, so card identity uses the season/week rule or a verified admin link';
      c.verdict = problems.length ? `validation failed: ${problems.join('; ')}` : ready.ready ? 'round-level official statistics, identity and result verified' : `not ready: ${ready.reason}`;
      c.viable = !problems.length && ready.ready && c.rounds.both_corners_every_round && rows.length > 0;
    }
  }
  c.request_cost = requests.filter((r) => r.candidate === 'ufc_official').length;
}

/* ---------------------------------------------------------------- B. ESPN */
{
  const c = { provider: 'ESPN core API', access: 'public JSON; already the production schedule/result/identity source' };
  report.candidates.espn = c;
  if (!event.espn_event_id || !bout.espn_competition_id) {
    c.verdict = 'bout not linked to ESPN'; c.viable = false;
  } else {
    const compUrl = `https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/${event.espn_event_id}/competitions/${bout.espn_competition_id}?lang=en&region=us`;
    const comp = await logged('espn', compUrl);
    c.competition = { url: compUrl, status: comp.status, date: comp.body?.date, competitors: (comp.body?.competitors || []).map((x) => ({ id: x.id, winner: x.winner })) };
    const statRef = comp.body?.competitors?.[0]?.statistics?.$ref;
    if (statRef) {
      const s0 = await logged('espn', statRef.replace('http://', 'https://'));
      const s1 = await logged('espn', statRef.replace('http://', 'https://').replace(/statistics\/0/, 'statistics/1'));
      c.statistics = {
        url: s0.url, status: s0.status, split: s0.body?.splits ? { id: s0.body.splits.id, name: s0.body.splits.name, type: s0.body.splits.type } : null,
        split_1_identical_to_split_0: JSON.stringify(s0.body?.splits) === JSON.stringify(s1.body?.splits),
        fields: (s0.body?.splits?.categories || []).flatMap((cat) => cat.stats.map((x) => x.name)).slice(0, 12),
      };
    }
    c.dwcs_coverage = 'DWCS events and results present (our result_source for these bouts is ESPN)';
    c.verdict = 'fight totals only (splits.type "total"); no round dimension, so it cannot supply ufc_bout_round_stats';
    c.viable = false;
  }
  c.request_cost = requests.filter((r) => r.candidate === 'espn').length;
}

/* ---------------------------------------------------------- C. UFC Stats */
{
  const h = await (await fetch('https://ufc-stats-ingest.sales-fd3.workers.dev/health')).json();
  report.candidates.ufcstats = {
    provider: 'UFC Stats (ufcstats.com)', status: 'BLOCKED', request_cost: 0,
    evidence: { source_health: h.source_health && { status: h.source_health.status, at: h.source_health.at, via: h.source_health.via, detail: h.source_health.detail, retry_after: h.source_health.retry_after },
      canaries: '2026-09-10, 2026-09-13, 2026-09-14 00:34Z and 10:00Z (single-bout, 1 request): challenge interstitial every time' },
    verdict: 'not requested: automated reads are challenged; no bypass, no solver', viable: false,
  };
}

/* ------------------------------------------------ D. Internet Archive (CDX) */
{
  const c = { provider: 'Internet Archive (captures of UFC Stats pages)', access: 'public CDX index; existing scripts/backfill/wayback.py path; ufcstats.com never contacted' };
  report.candidates.wayback = c;
  const anchor = [fa, fb].find((f) => f.ufcstats_id);
  if (!anchor) {
    c.verdict = 'no UFC Stats id on either corner or the bout, so there is no page to look up'; c.viable = false;
  } else {
    const from = event.event_date.replace(/-/g, '');
    const url = `http://web.archive.org/cdx/search/cdx?url=ufcstats.com/fighter-details/${anchor.ufcstats_id}&output=json&fl=timestamp,statuscode,length&from=${from}`;
    const r = await logged('wayback', url);
    const caps = Array.isArray(r.body) ? r.body.slice(1) : [];
    c.lookup = { url, status: r.status, captures_since_event: caps.length, captures: caps.slice(-5) };
    c.verdict = caps.length ? 'captures exist after the event; would still need a non-interstitial capture of the fight page' : 'no capture of the anchor fighter page since the event';
    c.viable = false;
  }
  c.request_cost = requests.filter((r) => r.candidate === 'wayback').length;
}

/* ------------------------------------------------------ E. Licensed providers */
report.candidates.licensed = {
  provider: 'Commercial MMA data (e.g. Sportradar MMA, Stats Perform)', request_cost: 0,
  verdict: 'not requested: not in our architecture, needs a contract/key and owner approval; unnecessary while the official feed covers DWCS', viable: null,
};

report.requests = requests;
report.request_cost_total = requests.length;
report.viable_sources = Object.entries(report.candidates).filter(([, v]) => v.viable).map(([k]) => k);
const out = arg('out');
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify({
  bout: `${fa.name} vs ${fb.name}`, event: event.name, viable_sources: report.viable_sources, requests: report.request_cost_total,
  official: { event: report.candidates.ufc_official.event_identity, fight: report.candidates.ufc_official.bout_identity?.official_fight_id, verdict: report.candidates.ufc_official.verdict, rounds: report.candidates.ufc_official.rounds, validation: report.candidates.ufc_official.validation },
  espn: report.candidates.espn.verdict, wayback: report.candidates.wayback.verdict, ufcstats: report.candidates.ufcstats.status,
}, null, 1));
