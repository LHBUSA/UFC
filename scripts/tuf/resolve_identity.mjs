#!/usr/bin/env node
/**
 * Resolve every person the TUF archive names to a canonical fighter, or say
 * why not.
 *
 *   UFC_ENV_FILE=D:/Workers/secrets/ufc-propbetedge.env \
 *     node scripts/tuf/resolve_identity.mjs [--write]
 *
 * READ-ONLY against the database: selects only. With --write it writes
 * web/data/tuf/identity.json (the evidence) and stamps fighter ids onto the
 * season files (rosters, coaches, bout corners) and the inventory's winners.
 *
 * Why this exists. The season pages linked people by `name = <printed name>`.
 * An accent broke that: "Julianna Peña" is "Julianna Pena" in ufc_fighters,
 * so a two-time TUF coach and a TUF 18 finalist rendered as an unlinked name,
 * her profile showed no TUF history, and ten other champions went the same
 * way. Loosening the match the obvious way is worse: the archive's shared name
 * matcher accepts "Anderson da Silva" (a TUF 28 heavyweight) as "Anderson
 * Silva" under its extended-surname rule, which would have hung a former
 * middleweight champion's career on a house fighter.
 *
 * So identity is decided in tiers, and the tier is recorded:
 *
 *   alias        asserted in name_aliases.json, which already carries the bout
 *                that proves it
 *   exact        the printed name equals exactly one fighter's name
 *   normalized   equal after removing accents, punctuation, case, a quoted
 *                nickname and a parenthesised note — and to exactly one
 *                fighter. No token is dropped, so "anderson da silva" never
 *                equals "anderson silva".
 *   convention   one of the shared matcher's other rules (suffix, initials,
 *                given-name variant, extra surname). NEVER sufficient alone:
 *                accepted only with bout evidence, below.
 *
 * Bout evidence, for a candidate F and season S:
 *
 *   castmate     F has a UFC bout against someone already resolved, by a tier
 *                that needs no evidence, to another member of S
 *   finale       F has a UFC bout on S's finale date
 *
 *   debut        for spellings that keep the surname only: F's first UFC bout
 *                came within 540 days after S's finale
 *
 * And one guard on the tiers that need no evidence, for contestants only: F's
 * UFC career must come within eight years of S on either side. Returning
 * veterans pass (Wes Sims on TUF 10); a house fighter who shares a name with
 * someone who fought a decade away does not, because a wrong career is worse
 * than none. The two seasons cast from UFC veterans are exempt, and say so.
 *
 * Anything that fails stays unlinked, with the reason, and is shown as a plain
 * name. Nothing is inserted into ufc_fighters.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold, nameMatch } from './lib/names.mjs';
import { splitName } from './normalize_staff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const WRITE = process.argv.includes('--write');

/* Seasons cast from fighters who had already fought in the UFC. */
const VETERAN_SEASONS = new Map([
  ['tuf-4', 'The Comeback cast fighters with prior UFC bouts'],
  ['tuf-25', 'Redemption cast former TUF contestants, several with prior UFC bouts'],
]);

/* Duplicate canonical rows proven to be one person, pending a database merge.
 * The archive links to the row that holds the TUF-era UFC bouts; both ids are
 * recorded so the link can be re-pointed when the merge is applied. */
export const PROVEN_DUPLICATES = {
  'f5785bba-c6f8-45de-8682-d044d586c8ac': {
    canonical_for_archive: 'ded1a158-8eed-43bb-8c6e-f950bb97432d',
    names: ['Marcio Alexandre Jr.', 'Marcio Alexandre Junior'],
    proof: 'ESPN athlete 3108776 (the ESPN-keyed row) competed on 2014-05-31, 2014-12-20 and 2015-12-12, losing each time; those are exactly the three UFC bouts held by the UFC Stats-keyed row d53482bef23235ba. On 2015-12-12 the ESPN opponent is athlete 2504639, which is Court McGee in ufc_fighters, the recorded winner of that bout. Both rows carry the nickname "Lyoto"; the birth dates disagree by two days (1989-05-03 ESPN, 1989-05-05 UFC Stats), the source disagreement that created the pair.',
    status: 'proven, merge not applied',
    retrieved: '2026-09-12',
  },
};

function loadEnv() {
  const file = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
  const env = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

async function selectAll(env, table, query) {
  const base = String(env.SUPABASE_URL).replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${base}/rest/v1/${table}?${query}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' },
    });
    if (res.status === 416) break;
    if (!res.ok) throw new Error(`${table} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/** Accent-, case- and punctuation-blind, nickname- and note-free. Drops no word. */
export function normalizedName(printed) {
  const { name } = splitName(printed);
  return fold(name.replace(/[’'`]/g, ''));
}

/* ---- what the archive names ---------------------------------------------- */

function references(inventory) {
  const refs = new Map(); // key -> { season, printed, roles:Set }
  const add = (season, printed, role) => {
    if (!printed || typeof printed !== 'string') return;
    const key = `${season}|${printed}`;
    if (!refs.has(key)) refs.set(key, { season, printed, roles: new Set() });
    refs.get(key).roles.add(role);
  };
  const seasons = new Map();
  for (const row of inventory.seasons) {
    const file = path.join(DATA, 'seasons', `${row.slug}.json`);
    const d = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    seasons.set(row.slug, { row, d, file });
    for (const c of row.coaches || []) add(row.slug, c, 'head_coach');
    for (const w of row.winners || []) add(row.slug, w.fighter, 'contestant');
    for (const f of row.finalists || []) for (const n of f.fighters) add(row.slug, n, 'contestant');
    for (const c of d.coaches || []) add(row.slug, c.name, c.role === 'head' ? 'head_coach' : 'staff');
    for (const t of d.teams || []) for (const p of t.roster) add(row.slug, p.name, 'contestant');
    for (const div of d.bracket || []) for (const st of div.stages) for (const b of st.bouts) { add(row.slug, b.a, 'contestant'); add(row.slug, b.b, 'contestant'); }
    for (const ch of d.champions || []) add(row.slug, ch.fighter, 'contestant');
    for (const div of d.bracket || []) for (const st of div.stages) for (const b of st.disputed || []) { add(row.slug, b.a, 'contestant'); add(row.slug, b.b, 'contestant'); }
    for (const f of row.final_bouts || []) { add(row.slug, f.a, 'contestant'); add(row.slug, f.b, 'contestant'); if (f.winner) add(row.slug, f.winner, 'contestant'); }
  }
  return { refs, seasons };
}

/* ---- resolution ----------------------------------------------------------- */

async function main() {
  const env = loadEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required (set UFC_ENV_FILE)');
  const inventory = JSON.parse(fs.readFileSync(path.join(DATA, 'seasons.json'), 'utf8'));
  const aliases = JSON.parse(fs.readFileSync(path.join(DATA, 'name_aliases.json'), 'utf8')).aliases;
  const { refs, seasons } = references(inventory);

  const fighters = await selectAll(env, 'ufc_fighters', 'select=id,name,espn_athlete_id,ufcstats_id,dob&order=id');
  const events = new Map((await selectAll(env, 'ufc_events', 'select=id,event_date&order=id')).map((e) => [e.id, e.event_date]));
  const bouts = await selectAll(env, 'ufc_bouts', 'select=fighter_a_id,fighter_b_id,event_id&order=id');
  const byId = new Map(fighters.map((f) => [f.id, f]));
  const byExact = new Map();
  const byNorm = new Map();
  const byToken = new Map();
  for (const f of fighters) {
    if (!byExact.has(f.name)) byExact.set(f.name, []);
    byExact.get(f.name).push(f);
    const n = normalizedName(f.name);
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(f);
    for (const t of new Set(n.split(' '))) {
      if (t.length < 3) continue;
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t).push(f);
    }
  }
  const opponents = new Map(); // fighter -> [{opp, date}]
  for (const b of bouts) {
    const date = events.get(b.event_id) || null;
    for (const [me, opp] of [[b.fighter_a_id, b.fighter_b_id], [b.fighter_b_id, b.fighter_a_id]]) {
      if (!opponents.has(me)) opponents.set(me, []);
      opponents.get(me).push({ opp, date });
    }
  }
  const finaleDates = (slug) => {
    const r = seasons.get(slug).row;
    return new Set([r.finale_date, ...(r.final_bouts || []).map((f) => f.date)].filter(Boolean));
  };

  const result = new Map();
  const decide = (ref, entry) => result.set(`${ref.season}|${ref.printed}`, { season: ref.season, printed: ref.printed, roles: [...ref.roles].sort(), ...entry });

  const seasonYear = (slug) => seasons.get(slug).row.year;
  const boutDates = (id) => (opponents.get(id) || []).map((x) => x.date).filter(Boolean).sort();
  /* A contestant's UFC career must come within eight years of the season, on
   * either side. Returning veterans (Wes Sims on TUF 10, Jason Knight on TUF
   * 31) pass; a namesake who fought a decade away from the show does not. */
  const WINDOW_YEARS = 8;
  const inWindow = (id, slug) => {
    const d = boutDates(id);
    if (!d.length) return false;
    const y = seasonYear(slug);
    return Number(d[d.length - 1].slice(0, 4)) >= y - WINDOW_YEARS && Number(d[0].slice(0, 4)) <= y + WINDOW_YEARS;
  };
  /* Spelling rules that never change a surname. Only these may lean on the
   * weakest evidence, a UFC debut soon after the season. */
  const SURNAME_PRESERVING = new Set(['exact', 'suffix-or-initials', 'given-name-variant', 'reversed-name-order']);

  /* Pass 1: tiers that need no evidence. */
  for (const ref of refs.values()) {
    const alias = aliases.find((a) => a.source_name === ref.printed && (!a.seasons || a.seasons.includes(ref.season)));
    let tier = null;
    let hits = [];
    if (alias) { tier = 'alias'; hits = byExact.get(alias.records_name) || []; }
    if (!hits.length) { hits = byExact.get(ref.printed) || []; if (hits.length) tier = 'exact'; }
    if (!hits.length) { hits = byNorm.get(normalizedName(ref.printed)) || []; if (hits.length) tier = 'normalized'; }
    if (!hits.length) continue;
    if (hits.length > 1) { decide(ref, { status: 'ambiguous', tier, candidates: hits.map((f) => ({ id: f.id, name: f.name })), reason: `${hits.length} fighters share this name` }); continue; }
    const f = hits[0];
    const contestantOnly = ref.roles.has('contestant') && !ref.roles.has('head_coach') && !ref.roles.has('staff');
    if (contestantOnly && tier !== 'alias' && !VETERAN_SEASONS.has(ref.season) && !inWindow(f.id, ref.season)) {
      const d = boutDates(f.id);
      decide(ref, { status: 'rejected', tier, candidates: [{ id: f.id, name: f.name, first_ufc_bout: d[0] || null, last_ufc_bout: d[d.length - 1] || null }], reason: `the only fighter with this name fought in the UFC outside ${WINDOW_YEARS} years of this season; a namesake is more likely than a career` });
      continue;
    }
    decide(ref, { status: 'linked', tier, fighter_id: f.id, records_name: f.name, ...(alias ? { evidence: alias.evidence } : {}), ...(VETERAN_SEASONS.has(ref.season) && contestantOnly ? { guard: VETERAN_SEASONS.get(ref.season) } : {}) });
  }

  /* Pass 2: anything pass 1 could not settle, decided by bout evidence. */
  const castIds = (slug) => new Set([...result.values()].filter((r) => r.season === slug && r.status === 'linked' && r.tier !== 'convention').map((r) => r.fighter_id));
  const finaleOf = (slug) => {
    const r = seasons.get(slug).row;
    return [r.finale_date, ...(r.final_bouts || []).map((f) => f.date)].filter(Boolean).sort().pop() || null;
  };
  for (const ref of refs.values()) {
    const key = `${ref.season}|${ref.printed}`;
    const prior = result.get(key);
    if (prior && prior.status === 'linked') continue;
    const n = normalizedName(ref.printed);
    const pool = new Map();
    for (const c of prior?.candidates || []) if (byId.get(c.id)) pool.set(c.id, { f: byId.get(c.id), rule: 'exact' });
    for (const t of n.split(' ')) for (const f of byToken.get(t) || []) {
      if (pool.has(f.id)) continue;
      const m = nameMatch(splitName(ref.printed).name, f.name);
      if (m.same) pool.set(f.id, { f, rule: m.rule });
    }
    if (!pool.size) {
      if (!prior) decide(ref, { status: 'unlinked', reason: 'no fighter in ufc_fighters has this name under any recorded convention' });
      continue;
    }
    const mates = castIds(ref.season);
    const finals = finaleDates(ref.season);
    const finale = finaleOf(ref.season);
    const withEvidence = [...pool.values()].map(({ f, rule }) => {
      const opps = opponents.get(f.id) || [];
      const castmate = opps.find((o) => mates.has(o.opp) && o.opp !== f.id);
      const onFinale = opps.find((o) => o.date && finals.has(o.date));
      const first = boutDates(f.id)[0] || null;
      const debutDays = first && finale ? (Date.parse(first) - Date.parse(finale)) / 86400e3 : null;
      let ev = null;
      if (castmate) ev = { kind: 'castmate', opponent: byId.get(castmate.opp)?.name, opponent_id: castmate.opp, date: castmate.date };
      else if (onFinale) ev = { kind: 'finale', opponent: byId.get(onFinale.opp)?.name, opponent_id: onFinale.opp, date: onFinale.date };
      else if (SURNAME_PRESERVING.has(rule) && debutDays != null && debutDays >= 0 && debutDays <= 540) ev = { kind: 'debut_after_season', first_ufc_bout: first, season_finale: finale, days_after: Math.round(debutDays) };
      return { f, rule, ev };
    });
    const proven = withEvidence.filter((x) => x.ev);
    if (proven.length === 1) {
      const { f, rule, ev } = proven[0];
      decide(ref, { status: 'linked', tier: rule === 'exact' ? 'exact_with_evidence' : 'convention', rule, fighter_id: f.id, records_name: f.name, evidence: ev, ...(prior ? { settled: prior.reason } : {}) });
    } else {
      decide(ref, {
        status: proven.length > 1 ? 'ambiguous' : (prior?.status || 'unlinked'),
        tier: prior?.tier || 'convention',
        candidates: withEvidence.map(({ f, rule, ev }) => ({ id: f.id, name: f.name, rule, evidence: ev })),
        reason: proven.length > 1
          ? 'more than one candidate has bout evidence'
          : prior?.reason || 'a naming convention matches, but no bout ties the candidate to this season, so it is not accepted',
      });
    }
  }

  /* Pass 3: two spellings of one castmate. Inside a single season's cast a
   * name that is another cast member's printed nickname ("Kimbo Slice" for
   * Kevin "Kimbo Slice" Ferguson), or that matches exactly one other printed
   * name of that season by a recorded convention ("Tom Theocharis" and
   * "Thomas Theocharis"), is that person. The pool is a few dozen people who
   * lived in one house, not the whole roster of the sport, and a match to more
   * than one of them is left alone. */
  for (const ref of refs.values()) {
    const key = `${ref.season}|${ref.printed}`;
    const cur = result.get(key);
    if (cur?.status === 'linked') continue;
    const { d } = seasons.get(ref.season);
    const castPrinted = new Set([
      ...(d.teams || []).flatMap((t) => t.roster.map((p) => p.name)),
      ...(d.bracket || []).flatMap((div) => div.stages.flatMap((st) => st.bouts.flatMap((b) => [b.a, b.b]))),
    ]);
    castPrinted.delete(ref.printed);
    const mine = splitName(ref.printed).name;
    const matches = [...castPrinted].filter((other) => {
      const o = splitName(other);
      if (o.nickname && fold(o.nickname) === fold(mine)) return true;
      return nameMatch(mine, o.name).same;
    });
    if (matches.length !== 1) continue;
    const other = result.get(`${ref.season}|${matches[0]}`);
    const rule = splitName(matches[0]).nickname && fold(splitName(matches[0]).nickname) === fold(mine) ? 'nickname' : nameMatch(mine, splitName(matches[0]).name).rule;
    const same_person_as = matches[0];
    if (other?.status === 'linked') {
      decide(ref, { status: 'linked', tier: 'season_spelling', rule, fighter_id: other.fighter_id, records_name: other.records_name, same_person_as, ...(cur ? { settled: cur.reason } : {}) });
    } else if (cur) {
      cur.same_person_as = same_person_as;
      cur.same_person_rule = rule;
    } else {
      decide(ref, { status: 'unlinked', same_person_as, same_person_rule: rule, reason: 'no fighter in ufc_fighters has this name under any recorded convention' });
    }
  }

  /* Proven duplicate rows: point both spellings at the archive's canonical row. */
  for (const r of result.values()) {
    const dup = PROVEN_DUPLICATES[r.fighter_id];
    if (r.status === 'linked' && dup) {
      r.duplicate_row = r.fighter_id;
      r.fighter_id = dup.canonical_for_archive;
      r.records_name = byId.get(dup.canonical_for_archive)?.name;
      r.duplicate_note = dup.status;
    }
    for (const c of r.candidates || []) if (PROVEN_DUPLICATES[c.id]) c.proven_duplicate_of = PROVEN_DUPLICATES[c.id].canonical_for_archive;
  }
  /* Ambiguity that is only the proven duplicate pair is not ambiguity. */
  for (const r of result.values()) {
    if (r.status !== 'ambiguous') continue;
    const ids = new Set((r.candidates || []).map((c) => PROVEN_DUPLICATES[c.id]?.canonical_for_archive || c.id));
    if (ids.size === 1) {
      const id = [...ids][0];
      Object.assign(r, { status: 'linked', fighter_id: id, records_name: byId.get(id)?.name, duplicate_note: 'candidates are one person split across two rows; see proven_duplicates' });
      delete r.reason;
    }
  }

  /* ---- report ---- */
  const all = [...result.values()].sort((a, b) => a.season.localeCompare(b.season, 'en', { numeric: true }) || a.printed.localeCompare(b.printed));
  const tally = (rows) => rows.reduce((m, r) => { const k = r.status === 'linked' ? `linked:${r.tier}` : r.status; m[k] = (m[k] || 0) + 1; return m; }, {});
  const contestants = all.filter((r) => r.roles.includes('contestant'));
  const heads = all.filter((r) => r.roles.includes('head_coach'));
  console.log('references', all.length, tally(all));
  console.log('contestant references', contestants.length, tally(contestants));
  console.log('head-coach references', heads.length, tally(heads));
  for (const r of all.filter((x) => x.status === 'ambiguous' || x.status === 'rejected' || (x.status === 'unlinked' && x.candidates))) {
    console.log(`  ${r.status.padEnd(9)} ${r.season.padEnd(14)} ${r.printed} — ${r.reason}${r.candidates ? ` [${r.candidates.map((c) => `${c.name}${c.rule ? `/${c.rule}` : ''}${c.evidence ? '+ev' : ''}`).join(', ')}]` : ''}`);
  }

  if (!WRITE) { console.log('\n(dry run — pass --write)'); return; }

  const registry = {
    _about: 'Who each name in the TUF archive is, and how that was decided. Generated by scripts/tuf/resolve_identity.mjs from ufc_fighters and ufc_bouts; the season files carry the resulting ids. Edit the script or name_aliases.json, never this file.',
    _tiers: {
      alias: 'asserted in name_aliases.json with the bout that proves it',
      exact: 'the printed name equals exactly one fighter name',
      normalized: 'equal to exactly one fighter name once accents, punctuation, case, a quoted nickname and a parenthesised note are removed; no word is dropped',
      exact_with_evidence: 'several fighters share the exact name and exactly one has bout evidence for the season',
      convention: 'a spelling convention (suffix, initials, given-name variant, extra surname) accepted only with bout evidence: a UFC bout against a resolved castmate, a bout on the season finale date, or, for spellings that keep the surname, a UFC debut within 540 days after the finale',
      season_spelling: "a second spelling of a castmate inside the same season: that castmate's printed nickname, or a recorded convention matching exactly one other printed name of the season",
    },
    _guard: 'A contestant resolved without evidence must have a UFC career within eight years of the season on either side, except in seasons cast from UFC veterans. A namesake a decade away is rejected, not linked.',
    proven_duplicates: PROVEN_DUPLICATES,
    generated_from: { fighters: fighters.length, bouts: bouts.length },
    entries: Object.fromEntries(all.map((r) => [`${r.season}|${r.printed}`, (({ season, printed, ...rest }) => rest)(r)])),
  };
  fs.writeFileSync(path.join(DATA, 'identity.json'), JSON.stringify(registry, null, 2) + '\n');
  /* The compact form the site bundles: season -> printed name -> fighter id.
   * The evidence stays in identity.json, out of every page's payload. */
  const index = {};
  for (const r of all) {
    if (r.status !== 'linked') continue;
    (index[r.season] ||= {})[r.printed] = r.fighter_id;
  }
  fs.writeFileSync(path.join(DATA, 'identity.index.json'), JSON.stringify(index, null, 1) + '\n');

  const idOf = (slug, printed) => {
    const r = result.get(`${slug}|${printed}`);
    return r?.status === 'linked' ? r.fighter_id : null;
  };
  const stamp = (obj, field, id) => { if (id) obj[field] = id; else delete obj[field]; };
  for (const [slug, { d, file }] of seasons) {
    if (!fs.existsSync(file)) continue;
    for (const c of d.coaches || []) stamp(c, 'fighter_id', idOf(slug, c.name));
    for (const t of d.teams || []) for (const p of t.roster) stamp(p, 'fighter_id', idOf(slug, p.name));
    for (const div of d.bracket || []) for (const st of div.stages) for (const b of st.bouts) {
      stamp(b, 'a_fighter_id', idOf(slug, b.a));
      stamp(b, 'b_fighter_id', idOf(slug, b.b));
    }
    for (const ch of d.champions || []) stamp(ch, 'fighter_id', idOf(slug, ch.fighter));
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  }
  for (const row of inventory.seasons) {
    row.coach_fighter_ids = (row.coaches || []).map((c) => idOf(row.slug, c));
    if (!row.coach_fighter_ids.some(Boolean)) delete row.coach_fighter_ids;
    for (const w of row.winners || []) stamp(w, 'fighter_id', idOf(row.slug, w.fighter));
    for (const f of row.finalists || []) {
      f.fighter_ids = f.fighters.map((n) => idOf(row.slug, n));
    }
  }
  fs.writeFileSync(path.join(DATA, 'seasons.json'), JSON.stringify(inventory, null, 2) + '\n');
  console.log('\nwrote web/data/tuf/identity.json and stamped ids onto the season files');
}

main().catch((e) => { console.error('FATAL', e.message); process.exitCode = 1; });
