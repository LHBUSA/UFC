#!/usr/bin/env node
/**
 * TUF Phase 2 completeness matrix. READ-ONLY.
 *
 *   UFC_ENV_FILE=D:/Workers/secrets/ufc-propbetedge.env \
 *     node scripts/tuf/completeness_matrix.mjs [--as-of 2026-09-13] [--out-json <path>] [--out-md <path>]
 *
 * Reproducible from committed source data plus read-only database selects:
 *   web/data/tuf/seasons.json, seasons/*.json, episodes/*.json, identity.json,
 *   scripts/tuf/evidence/paramount_plus.json
 *   ufc_bouts / ufc_bout_results / ufc_events  (finale linkage, by fighter id)
 *   ufc_images                                  (licensed portrait coverage)
 *
 * A file existing is never "complete". Every status below is computed from
 * explicit rules, and each season lists the blockers that keep it from the bar.
 *
 * RESULT VERIFICATION (per bout) — kept separate from classification:
 *   verified   the winner is attested by a source other than the Wikipedia
 *              draft: a professional result row (classification verified
 *              against ufc_bouts), an official source repair that covers the
 *              winner, or an official recap result in the episode layer for the
 *              same pairing with the same winner and no contradiction
 *   partial    a winner is recorded, but only the Wikipedia draft states it
 *   scheduled  a tournament final whose exact finalist pairing is an announced,
 *              not-yet-fought bout in ufc_bouts (a future fact, not a gap)
 *   unknown    no winner recorded
 *
 * CLASSIFICATION (per bout): professional | exhibition | unresolved
 *   (the data's 'unverified' value), each only with its recorded basis.
 *
 * COMPLETE requires ALL of:
 *   season completed · roster present · every expected quarter/semi/final bout
 *   present · every present bout has a winner · every final result verified ·
 *   one resolved winner per weight class, each linked to a canonical fighter ·
 *   the professional final linked by exact fighter ids where the final was on
 *   a finale card · zero unresolved classifications · no open source conflict ·
 *   every winner and finalist identity resolved · no unflagged spelling split
 * BLOCKED: a critical blocker that no loaded source can clear (an open source
 *   conflict on a final, or no bracket at all for a bracket season).
 * PARTIAL: everything else.
 *
 * EXPECTED STAGES come from the season's declared competition_format
 * (web/lib/tufFormat.ts). Only a season that declares none is measured against
 * the modern bracket shape. An elimination phase has no fixed bout count.
 *
 * PRODUCT DEPTH is reported beside the structural status and never replaces
 * it: episodes with sourced facts vs title-only shells, timeline coverage,
 * episode placement of house bouts, result and classification evidence,
 * identity coverage and finale integration. Depth never makes a season
 * COMPLETE, and COMPLETE never makes a season gold-standard.
 *
 * HOUSE_RESULTS_SECONDARY_ONLY also blocks COMPLETE: a house result resting
 * only on the Wikipedia draft is not a defensible record under the Phase 2
 * source tiers. Seasons that miss the bar for that reason alone are listed as
 * structurally_complete_except_house_sourcing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedBouts } from '../../web/lib/tufFormat.ts';
import { buildEpisodeViews, timelineCounts } from '../../web/lib/tufTimeline.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const AS_OF = opt('--as-of', new Date().toISOString().slice(0, 10));
const OUT_JSON = opt('--out-json', path.join(ROOT, 'scripts', 'tuf', 'evidence', `tuf_completeness_${AS_OF}.json`));
const OUT_MD = opt('--out-md', path.join(ROOT, 'docs', 'tuf', `tuf_completeness_${AS_OF}.md`));

const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
const env = { ...process.env };
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
async function q(p) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${p}&limit=1000&offset=${off}`, { headers: H });
    if (!r.ok) throw new Error(`${p.split('?')[0]} ${r.status} ${await r.text()}`);
    const rows = await r.json(); out.push(...rows); if (rows.length < 1000) break;
  }
  return out;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const inventory = readJson(path.join(DATA, 'seasons.json'));
const identity = readJson(path.join(DATA, 'identity.json'));
const paramount = readJson(path.join(ROOT, 'scripts', 'tuf', 'evidence', 'paramount_plus.json'));
const detailOf = (slug) => { const p = path.join(DATA, 'seasons', `${slug}.json`); return fs.existsSync(p) ? readJson(p) : null; };
const episodesOf = (slug) => { const p = path.join(DATA, 'episodes', `${slug}.json`); return fs.existsSync(p) ? readJson(p) : null; };

const norm = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
function lev(a, b) {
  const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
const pairKey = (a, b) => [norm(a), norm(b)].sort().join('|');
const idPair = (a, b) => [a, b].sort().join('|');

const STAGE_ORDER = ['elimination', 'round_of_16', 'quarter_final', 'semi_final', 'final'];

/* ---- database: finale pairings and portraits, by canonical id only ---- */
const allIds = new Set();
for (const s of inventory.seasons) {
  const d = detailOf(s.slug);
  for (const br of d?.bracket || []) for (const st of br.stages) for (const b of st.bouts) { if (b.a_fighter_id) allIds.add(b.a_fighter_id); if (b.b_fighter_id) allIds.add(b.b_fighter_id); }
  for (const t of d?.teams || []) for (const r of t.roster) if (r.fighter_id) allIds.add(r.fighter_id);
  for (const w of s.winners || []) if (w.fighter_id) allIds.add(w.fighter_id);
}
const ids = [...allIds];
const boutsByPair = new Map();
const portraitIds = new Set();
for (let i = 0; i < ids.length; i += 60) {
  const chunk = ids.slice(i, i + 60).join(',');
  for (const b of await q(`ufc_bouts?select=id,status,fighter_a_id,fighter_b_id,event:ufc_events(name,event_date,card_status),result:ufc_bout_results(winner_id,method,round,time_sec)&or=(fighter_a_id.in.(${chunk}),fighter_b_id.in.(${chunk}))&order=id.asc`)) {
    const k = idPair(b.fighter_a_id, b.fighter_b_id);
    boutsByPair.set(k, [...(boutsByPair.get(k) || []).filter((x) => x.id !== b.id), b]);
  }
  for (const im of await q(`ufc_images?select=fighter_id&fighter_id=in.(${chunk})&order=fighter_id.asc`)) portraitIds.add(im.fighter_id);
}
const one = (v) => (Array.isArray(v) ? v[0] : v);

/* ---- per season ---------------------------------------------------------- */
const seasons = [];
for (const row of inventory.seasons) {
  const d = detailOf(row.slug);
  const eps = episodesOf(row.slug);
  const blockers = [];
  const identEntries = Object.entries(identity.entries).filter(([k]) => k.startsWith(`${row.slug}|`)).map(([k, v]) => ({ name: k.slice(row.slug.length + 1), ...v }));
  const contestantEntries = identEntries.filter((e) => e.roles.includes('contestant'));
  const staffEntries = identEntries.filter((e) => !e.roles.includes('contestant'));

  /* episodes */
  const ppCount = (paramount.seasons[row.slug] || []).length;
  const epRows = (eps?.episodes || []).map((e) => ({
    episode: e.episode_number,
    title: Boolean(e.title),
    title_source: e.title_source || null,
    recap: Boolean(e.recap_url),
    bouts: (e.bouts || []).length,
    bout_results: (e.bouts || []).filter((b) => b.result?.winner).length,
    weigh_ins: (e.bouts || []).reduce((n, b) => n + (b.weigh_ins || []).length, 0),
    weight_misses: (e.bouts || []).reduce((n, b) => n + (b.weigh_ins || []).filter((w) => w.missed_weight).length, 0),
    event_types: [...new Set((e.events || []).map((x) => x.type))],
    air_date_sourced: Boolean(e.air_date),
  }));
  const episodes = {
    expected: Math.max(ppCount, epRows.length) || null,
    expected_basis: ppCount ? 'paramount_plus listing' : epRows.length ? 'episode layer' : 'none',
    present: epRows.length,
    with_title: epRows.filter((e) => e.title).length,
    with_recap_source: epRows.filter((e) => e.recap).length,
    with_bout_facts: epRows.filter((e) => e.bouts > 0).length,
    air_dates_sourced: epRows.filter((e) => e.air_date_sourced).length,
    rows: epRows,
  };
  if (!epRows.length) blockers.push('EPISODE_LAYER_MISSING');

  /* roster + identity */
  const roster = (d?.teams || []).flatMap((t) => t.roster.map((r) => ({ ...r, team: t.name })));
  const bracketNames = new Set();
  const bouts = [];
  for (const br of d?.bracket || []) for (const st of br.stages) {
    for (const b of st.bouts) { bouts.push({ ...b, weight_class: br.weight_class, stage: st.stage }); bracketNames.add(b.a); bracketNames.add(b.b); }
  }
  const rosterNorm = new Set(roster.map((r) => norm(r.name)));
  const bracketNotInRoster = [...bracketNames].filter((n) => n && !rosterNorm.has(norm(n)));
  const linkedContestants = contestantEntries.filter((e) => e.status === 'linked');
  const unresolvedContestants = contestantEntries.filter((e) => e.status !== 'linked');
  /* Spelling splits: an unlinked printed name within edit distance 2 of a
   * linked name in the same season. Reported, never merged here. */
  const spellingSplits = unresolvedContestants.flatMap((u) => linkedContestants
    .filter((l) => norm(l.name) !== norm(u.name) && lev(norm(l.name), norm(u.name)) <= 2)
    .map((l) => ({ unlinked: u.name, linked: l.name, fighter_id: l.fighter_id })));
  if (spellingSplits.length) blockers.push('SPELLING_SPLIT_IDENTITY');
  const staff = d?.coaches_full || (d?.coaches || []).map((c) => ({ ...c }));
  const heads = staff.filter((c) => c.role === 'head');
  const assistants = staff.filter((c) => c.role === 'assistant');

  /* bouts */
  const today = AS_OF;
  const boutRows = bouts.map((b) => {
    const officialWinner = (b.sources || []).some((s) => s.family !== 'wikipedia' && s.fields.includes('winner'));
    const recapResult = (eps?.episodes || []).flatMap((e) => e.bouts || [])
      .find((eb) => pairKey(eb.bracket?.a || eb.a, eb.bracket?.b || eb.b) === pairKey(b.a, b.b) && eb.result?.winner);
    const recapAgrees = recapResult && !recapResult.result.contradiction && norm(recapResult.result.winner) === norm(b.winner);
    let dbPair = null;
    /* The winner's id: the corner whose printed name matches, else the season's
     * linked winner for this weight class when that id is one of the corners.
     * A winner printed differently from both corners is a data defect either way. */
    const winnerNameIsCorner = !b.winner || norm(b.winner) === norm(b.a) || norm(b.winner) === norm(b.b);
    const seasonWinnerId = (row.winners || []).find((w) => norm(w.weight_class) === norm(b.weight_class) || (row.winners || []).length === 1)?.fighter_id;
    const winnerId = !b.winner ? null
      : norm(b.winner) === norm(b.a) ? b.a_fighter_id
        : norm(b.winner) === norm(b.b) ? b.b_fighter_id
          : b.stage === 'final' && seasonWinnerId && [b.a_fighter_id, b.b_fighter_id].includes(seasonWinnerId) ? seasonWinnerId : null;
    if (b.a_fighter_id && b.b_fighter_id) dbPair = (boutsByPair.get(idPair(b.a_fighter_id, b.b_fighter_id)) || []).map((x) => ({
      status: x.status, event: one(x.event)?.name, date: one(x.event)?.event_date, has_result: Boolean(one(x.result)),
      winner_matches_archive: Boolean(one(x.result)?.winner_id) && one(x.result).winner_id === winnerId,
    }));
    /* A professional bout is verified by its result row: the stored winner id
     * must be the archive winner's id, not merely a bout between the two. */
    const dbVerified = (dbPair || []).some((x) => x.winner_matches_archive);
    /* A result row between exactly these ids, on the finale card, while the
     * archive still says 'unverified': the classification can be repaired. */
    const classificationRepairable = b.classification === 'unverified' && b.stage === 'final' && dbVerified;
    const scheduled = b.stage === 'final' && !b.winner && (dbPair || []).some((x) => !x.has_result && x.status !== 'cancelled' && String(x.date) >= today);
    let result;
    if (b.winner && (dbVerified || officialWinner || recapAgrees)) result = 'verified';
    else if (b.winner) result = 'partial';
    else if (scheduled) result = 'scheduled';
    else result = 'unknown';
    const cls = b.classification === 'unverified' ? 'unresolved' : b.classification;
    const blockersForBout = [];
    if (result === 'partial') blockersForBout.push('NO_PRIMARY_SOURCE');
    if (result === 'unknown') blockersForBout.push(d?._conflicts?.some((c) => c.field.includes(b.weight_class) && /final/.test(c.field)) ? 'SOURCE_AMBIGUOUS' : 'NO_PRIMARY_SOURCE');
    if (b.winner && !b.method) blockersForBout.push('RESULT_ONLY_NO_METHOD');
    if (b.winner && b.method && !b.time && !/decision|draw/i.test(b.method)) blockersForBout.push('METHOD_ONLY_NO_TIME');
    if (!b.a_fighter_id || !b.b_fighter_id) blockersForBout.push('IDENTITY_UNRESOLVED');
    if (b.episode == null) blockersForBout.push('EPISODE_NOT_AVAILABLE');
    if (!winnerNameIsCorner) blockersForBout.push('WINNER_NAME_NOT_A_CORNER');
    if (classificationRepairable) blockersForBout.push('CLASSIFICATION_REPAIRABLE_FROM_RESULT_ROW');
    return {
      weight_class: b.weight_class, stage: b.stage, a: b.a, b: b.b, winner: b.winner, method: b.method, round: b.round, time: b.time, episode: b.episode,
      a_fighter_id: b.a_fighter_id || null, b_fighter_id: b.b_fighter_id || null,
      result_verification: result, classification: cls, classification_basis: b.classification_source || null,
      on_finale_card: Boolean(b.on_finale_card), db_pairing: dbPair, blockers: blockersForBout,
    };
  });

  const count = (f) => boutRows.filter(f).length;
  const byStage = {};
  for (const wc of d?.bracket || []) {
    for (const st of wc.stages) {
      const key = `${wc.weight_class}|${st.stage}`;
      const present = st.bouts.length;
      const exp = expectedBouts(d?.competition_format, st.stage, present);
      const expected = exp.expected;
      const rows = boutRows.filter((x) => x.weight_class === wc.weight_class && x.stage === st.stage);
      byStage[key] = {
        weight_class: wc.weight_class, stage: st.stage, expected, expected_basis: exp.basis, present,
        results_present: rows.filter((x) => x.winner).length,
        results_verified: rows.filter((x) => x.result_verification === 'verified').length,
        disputed: (st.disputed || []).length,
        complete: present === expected && rows.every((x) => x.winner),
      };
    }
  }
  const stageDone = (stage) => {
    const s = Object.values(byStage).filter((x) => x.stage === stage);
    return s.length ? s.every((x) => x.complete) : null;
  };
  const finals = boutRows.filter((x) => x.stage === 'final');
  const winners = (row.winners || []);
  const wcCount = (row.weight_classes || []).length || finals.length;
  const tournamentBoutsExpected = Object.values(byStage).reduce((n, s) => n + s.expected, 0);
  const openConflicts = (d?._conflicts || []).length + (inventory._conflicts || []).filter((c) => c.scope === row.slug).length;

  /* finale linkage by exact ids */
  const finaleExpected = finals.filter((f) => f.on_finale_card).length;
  const finaleProfessionalLinked = finals.filter((f) => f.on_finale_card && f.classification === 'professional' && (f.db_pairing || []).some((x) => x.winner_matches_archive)).length;
  const finaleScheduled = finals.filter((f) => f.result_verification === 'scheduled').length;

  /* product depth — reported beside the status, never folded into it */
  const views = d ? buildEpisodeViews(d, eps) : { episodes: [], unplacedEvents: [] };
  const houseBouts = bouts.filter((b) => !(b.stage === 'final' && b.on_finale_card));
  const tl = d ? timelineCounts(d) : null;
  const exhibitions = bouts.filter((b) => b.classification === 'exhibition');
  const depthMetrics = {
    episodes_total: views.episodes.length,
    episodes_with_facts: views.episodes.filter((v) => v.hasFacts).length,
    title_only_shells: views.episodes.filter((v) => !v.hasFacts).length,
    timeline_events: (d?.timeline_events || []).length,
    timeline_unplaced: views.unplacedEvents.length,
    timeline_counts: tl,
    house_bouts: houseBouts.length,
    house_bouts_with_episode: houseBouts.filter((b) => b.episode != null).length,
    house_bouts_with_result_evidence: houseBouts.filter((b) => (b.result_sources || []).length || (b.sources || []).some((x) => x.fields.includes('winner'))).length,
    exhibition_with_affirmative_basis: exhibitions.filter((b) => (b.classification_basis?.affirmative || []).length).length,
    exhibition_absence_only: exhibitions.filter((b) => !(b.classification_basis?.affirmative || []).length).length,
    competition_format_declared: Boolean(d?.competition_format),
    overview_declared: Boolean(d?.overview),
  };
  /* portraits */
  const linkedIds = [...new Set(linkedContestants.map((e) => e.fighter_id).filter(Boolean))];
  const portraits = linkedIds.filter((id) => portraitIds.has(id)).length;

  /* ---- blockers + status ---- */
  if (row.season_state !== 'completed') blockers.push('SEASON_NOT_COMPLETED');
  if (!roster.length) blockers.push('ROSTER_MISSING');
  if (!d?.bracket?.length && row.coverage !== 'format_complete') blockers.push('BRACKET_MISSING');
  if (Object.values(byStage).some((s) => s.present < s.expected)) blockers.push('BRACKET_BOUTS_MISSING');
  if (boutRows.some((x) => !x.winner && x.result_verification !== 'scheduled')) blockers.push('RESULTS_MISSING');
  if (finaleScheduled) blockers.push('FINALE_NOT_YET_FOUGHT');
  if (finals.some((f) => f.result_verification !== 'verified')) blockers.push('FINAL_NOT_VERIFIED');
  if (winners.length < wcCount) blockers.push('WINNER_UNRESOLVED');
  if (winners.some((w) => !w.fighter_id)) blockers.push('WINNER_NOT_LINKED');
  if (finaleExpected && finaleProfessionalLinked < finaleExpected) blockers.push('PROFESSIONAL_FINAL_NOT_LINKED');
  if (count((x) => x.classification === 'unresolved')) blockers.push('CLASSIFICATION_UNRESOLVED');
  if (openConflicts) blockers.push('OPEN_SOURCE_CONFLICT');
  const finalistNames = new Set(finals.flatMap((f) => [f.a, f.b]));
  if (finals.some((f) => !f.a_fighter_id || !f.b_fighter_id)) blockers.push('FINALIST_IDENTITY_UNRESOLVED');
  if (bracketNotInRoster.length) blockers.push('BRACKET_NAME_NOT_IN_ROSTER');
  if (boutRows.some((x) => x.blockers.includes('WINNER_NAME_NOT_A_CORNER'))) blockers.push('WINNER_NAME_NOT_A_CORNER');
  /* Wikipedia is not a tier the Phase 2 source strategy accepts as primary. A
   * season whose house results rest on it alone is not complete, however tidy
   * the structure; it is counted separately so near-misses stay visible. */
  if (boutRows.some((x) => x.result_verification === 'partial')) blockers.push('HOUSE_RESULTS_SECONDARY_ONLY');

  const critical = [];
  if (!d?.bracket?.length && row.coverage !== 'format_complete') critical.push('no bracket loaded for a bracket season');
  if (openConflicts && finals.some((f) => f.result_verification === 'unknown')) critical.push('an open source conflict leaves a final undecided');
  const completeBlockers = blockers.filter((b) => b !== 'EPISODE_LAYER_MISSING');
  const status = row.coverage === 'format_complete' && !completeBlockers.filter((b) => !['BRACKET_MISSING', 'BRACKET_BOUTS_MISSING', 'FINAL_NOT_VERIFIED'].includes(b)).length
    ? 'COMPLETE'
    : !completeBlockers.length ? 'COMPLETE' : critical.length ? 'BLOCKED' : 'PARTIAL';

  /* completeness score for ranking only (0-100); status, not score, is the bar */
  const frac = (a, b) => (b ? a / b : 1);
  const score = Math.round(100 * (
    0.20 * frac(Object.values(byStage).reduce((n, s) => n + Math.min(s.present, s.expected), 0), tournamentBoutsExpected || 1)
    + 0.20 * frac(count((x) => x.result_verification === 'verified'), boutRows.length || 1)
    + 0.10 * frac(count((x) => x.winner), boutRows.length || 1)
    + 0.15 * frac(count((x) => x.classification !== 'unresolved'), boutRows.length || 1)
    + 0.15 * frac(winners.filter((w) => w.fighter_id).length, wcCount || 1)
    + 0.10 * frac(linkedContestants.length, contestantEntries.length || 1)
    + 0.10 * frac(episodes.with_bout_facts, episodes.expected || 1)
  ));

  seasons.push({
    slug: row.slug, name: row.name, year: row.year, edition: row.edition, season_state: row.season_state, coverage: row.coverage,
    status, score, critical_blockers: critical, blockers,
    depth: (() => {
      const fr = (a, b) => (b ? a / b : null);
      const parts = {
        episodes_with_facts: fr(depthMetrics.episodes_with_facts, depthMetrics.episodes_total),
        house_bouts_placed_in_episodes: fr(depthMetrics.house_bouts_with_episode, depthMetrics.house_bouts),
        /* Verified, not merely cited: a Wikipedia result source is recorded
         * evidence, and it still does not make the result verified. */
        house_results_verified: fr(boutRows.filter((x) => !(x.stage === 'final' && x.on_finale_card) && x.result_verification === 'verified').length, depthMetrics.house_bouts),
        classification_affirmative: fr(depthMetrics.exhibition_with_affirmative_basis + finaleProfessionalLinked, exhibitions.length + finaleProfessionalLinked + count((x) => x.classification === 'unresolved')),
        identity_coverage: fr(linkedContestants.length, contestantEntries.length),
        finale_integration: fr(finaleProfessionalLinked + finaleScheduled, finaleExpected),
      };
      const known = Object.values(parts).filter((v) => v != null);
      return { ...depthMetrics, identity: { contestants: contestantEntries.length, linked: linkedContestants.length }, finale_integration: { expected: finaleExpected, linked_by_exact_ids: finaleProfessionalLinked, scheduled: finaleScheduled }, parts, depth_score: known.length ? Math.round((100 * known.reduce((a, v) => a + v, 0)) / known.length) : null };
    })(),
    structurally_complete_except_house_sourcing: status !== 'COMPLETE' && blockers.filter((x) => !['EPISODE_LAYER_MISSING', 'HOUSE_RESULTS_SECONDARY_ONLY'].includes(x)).length === 0,
    episodes: { ...episodes, rows: undefined },
    contestants: {
      roster_present: roster.length, bracket_fighters: bracketNames.size, bracket_names_not_in_roster: bracketNotInRoster,
      identity_entries: contestantEntries.length, linked: linkedContestants.length, unresolved: unresolvedContestants.length,
      unresolved_names: unresolvedContestants.map((e) => ({ name: e.name, reason: e.reason, priority: finalistNames.has(e.name) ? 'finalist' : winners.some((w) => w.fighter === e.name) ? 'winner' : bouts.some((b) => b.stage === 'semi_final' && (b.a === e.name || b.b === e.name)) ? 'semifinalist' : 'contestant' })),
      spelling_splits: spellingSplits,
    },
    staff: { head_coaches: heads.length, assistant_coaches: assistants.length, staff_without_canonical_record: staff.filter((c) => !c.fighter_id).length, staff_identity_entries_unlinked: staffEntries.filter((e) => e.status !== 'linked').length },
    tournament: {
      bouts_expected: tournamentBoutsExpected, bouts_present: boutRows.length,
      professional: count((x) => x.classification === 'professional'), exhibition: count((x) => x.classification === 'exhibition'), classification_unresolved: count((x) => x.classification === 'unresolved'),
      result_verified: count((x) => x.result_verification === 'verified'), result_partial: count((x) => x.result_verification === 'partial'),
      result_scheduled: count((x) => x.result_verification === 'scheduled'), result_unknown: count((x) => x.result_verification === 'unknown'),
      missing_winner: count((x) => !x.winner), missing_method: count((x) => x.winner && !x.method), missing_round: count((x) => x.winner && x.round == null), missing_time: count((x) => x.winner && !x.time),
      quarterfinals_complete: stageDone('quarter_final'), semifinals_complete: stageDone('semi_final'), final_complete: stageDone('final'),
      stages: Object.values(byStage),
    },
    winners: { expected: wcCount, resolved: winners.length, linked: winners.filter((w) => w.fighter_id).length, names: winners.map((w) => w.fighter) },
    finale: {
      expected: finaleExpected, event_linked: Boolean(row.finale_event), finale_event: row.finale_event, finale_date: row.finale_date,
      professional_final_linked: finaleProfessionalLinked, scheduled: finaleScheduled,
      finals: finals.map((f) => ({ weight_class: f.weight_class, a: f.a, b: f.b, winner: f.winner, result_verification: f.result_verification, classification: f.classification, db_pairing: f.db_pairing })),
    },
    weigh_ins: { present: epRows.reduce((n, e) => n + e.weigh_ins, 0), weight_misses: epRows.reduce((n, e) => n + e.weight_misses, 0) },
    conflicts: { open: openConflicts, disputed_bouts: Object.values(byStage).reduce((n, s) => n + s.disputed, 0), recap_contradictions: (eps?.episodes || []).flatMap((e) => e.bouts || []).filter((b) => b.result?.contradiction).length },
    portraits: { linked_contestants: linkedIds.length, with_licensed_portrait: portraits },
    bouts: boutRows,
    episode_matrix: epRows,
  });
}

/* ---- totals ---- */
const all = seasons.flatMap((s) => s.bouts);
const finalsAll = all.filter((b) => b.stage === 'final');
const identAll = Object.values(identity.entries).filter((e) => e.roles.includes('contestant'));
const totals = {
  as_of: AS_OF,
  seasons_total: seasons.length,
  complete: seasons.filter((s) => s.status === 'COMPLETE').length,
  partial: seasons.filter((s) => s.status === 'PARTIAL').length,
  blocked: seasons.filter((s) => s.status === 'BLOCKED').length,
  structurally_complete_except_house_sourcing: seasons.filter((s) => s.structurally_complete_except_house_sourcing).map((s) => s.slug),
  tournament_bouts_total: all.length,
  result_verified: all.filter((b) => b.result_verification === 'verified').length,
  result_partial: all.filter((b) => b.result_verification === 'partial').length,
  result_scheduled: all.filter((b) => b.result_verification === 'scheduled').length,
  result_unknown: all.filter((b) => b.result_verification === 'unknown').length,
  classification_professional: all.filter((b) => b.classification === 'professional').length,
  classification_exhibition: all.filter((b) => b.classification === 'exhibition').length,
  classification_unresolved: all.filter((b) => b.classification === 'unresolved').length,
  finals_total: finalsAll.length,
  finals_verified: finalsAll.filter((b) => b.result_verification === 'verified').length,
  finals_partial: finalsAll.filter((b) => b.result_verification === 'partial').length,
  finals_scheduled: finalsAll.filter((b) => b.result_verification === 'scheduled').length,
  finals_unresolved: finalsAll.filter((b) => b.result_verification === 'unknown').length,
  finals_conflicted: seasons.reduce((n, s) => n + (s.conflicts.open ? s.finale.finals.filter((f) => f.result_verification === 'unknown').length : 0), 0),
  winners_expected: seasons.reduce((n, s) => n + s.winners.expected, 0),
  winners_resolved: seasons.reduce((n, s) => n + s.winners.resolved, 0),
  winners_linked: seasons.reduce((n, s) => n + s.winners.linked, 0),
  contestant_identity_entries: identAll.length,
  contestant_linked: identAll.filter((e) => e.status === 'linked').length,
  contestant_link_rate: Number((identAll.filter((e) => e.status === 'linked').length / identAll.length).toFixed(4)),
  spelling_splits: seasons.reduce((n, s) => n + s.contestants.spelling_splits.length, 0),
  finale_links_expected: seasons.reduce((n, s) => n + s.finale.expected, 0),
  finale_links_verified: seasons.reduce((n, s) => n + s.finale.professional_final_linked, 0),
  finale_links_scheduled: seasons.reduce((n, s) => n + s.finale.scheduled, 0),
  episodes_total: seasons.reduce((n, s) => n + s.episodes.present, 0),
  episodes_expected: seasons.reduce((n, s) => n + (s.episodes.expected || 0), 0),
  episodes_with_title: seasons.reduce((n, s) => n + s.episodes.with_title, 0),
  episodes_with_source: seasons.reduce((n, s) => n + s.episodes.with_recap_source, 0),
  episodes_with_bout_facts: seasons.reduce((n, s) => n + s.episodes.with_bout_facts, 0),
  depth_episodes_with_facts: seasons.reduce((n, s) => n + s.depth.episodes_with_facts, 0),
  depth_title_only_shells: seasons.reduce((n, s) => n + s.depth.title_only_shells, 0),
  depth_timeline_events: seasons.reduce((n, s) => n + s.depth.timeline_events, 0),
  exhibition_with_affirmative_basis: seasons.reduce((n, s) => n + s.depth.exhibition_with_affirmative_basis, 0),
  exhibition_absence_only: seasons.reduce((n, s) => n + s.depth.exhibition_absence_only, 0),
  seasons_with_declared_format: seasons.filter((s) => s.depth.competition_format_declared).map((s) => s.slug),
};
totals.finale_links_missing = totals.finale_links_expected - totals.finale_links_verified - totals.finale_links_scheduled;
const worst = [...seasons].sort((a, b) => a.score - b.score || b.year - a.year).slice(0, 10).map((s) => ({ slug: s.slug, score: s.score, status: s.status, blockers: s.blockers }));

const out = { _about: 'Generated by scripts/tuf/completeness_matrix.mjs. Do not edit by hand; re-run the script.', _rules: 'See the header of scripts/tuf/completeness_matrix.mjs for every definition.', totals, worst_10: worst, seasons };
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 1) + '\n');

/* ---- markdown dashboard ---- */
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const tick = (v) => (v === null ? '—' : v ? 'yes' : 'no');
const md = [];
md.push(`# TUF completeness — ${AS_OF}`, '', `Generated by \`scripts/tuf/completeness_matrix.mjs\` from committed TUF data and read-only database selects. Re-run it; do not edit this file.`, '');
md.push('## Acceptance dashboard', '', '| Measure | Value |', '|---|---|');
for (const [k, v] of [
  ['Seasons total', totals.seasons_total], ['Complete', totals.complete], ['Partial', totals.partial], ['Blocked', totals.blocked], ['Structurally complete except house-result sourcing', totals.structurally_complete_except_house_sourcing.join(', ') || 'none'],
  ['Tournament bouts total', totals.tournament_bouts_total], ['Result verified', totals.result_verified], ['Result partial (Wikipedia-only winner)', totals.result_partial],
  ['Result scheduled (final not yet fought)', totals.result_scheduled], ['Result unknown', totals.result_unknown],
  ['Classification professional', totals.classification_professional], ['Classification exhibition', totals.classification_exhibition], ['Classification unresolved', totals.classification_unresolved],
  ['Finals total', totals.finals_total], ['Finals verified', totals.finals_verified], ['Finals partial', totals.finals_partial], ['Finals scheduled', totals.finals_scheduled], ['Finals unresolved', totals.finals_unresolved], ['Finals conflicted', totals.finals_conflicted],
  ['Winners expected', totals.winners_expected], ['Winners resolved', totals.winners_resolved], ['Winners linked', totals.winners_linked],
  ['Contestant link rate', `${(totals.contestant_link_rate * 100).toFixed(1)}% (${totals.contestant_linked}/${totals.contestant_identity_entries})`], ['Spelling-split identities', totals.spelling_splits],
  ['Finale links expected', totals.finale_links_expected], ['Finale links verified', totals.finale_links_verified], ['Finale links scheduled', totals.finale_links_scheduled], ['Finale links missing', totals.finale_links_missing],
  ['Episodes with sourced facts (all seasons)', totals.depth_episodes_with_facts], ['Title-only episode shells', totals.depth_title_only_shells], ['Timeline events', totals.depth_timeline_events], ['Exhibitions with an affirmative basis / absence-only', `${totals.exhibition_with_affirmative_basis} / ${totals.exhibition_absence_only}`], ['Seasons with a declared format', totals.seasons_with_declared_format.join(', ') || 'none'],
  ['Episodes (present / expected)', `${totals.episodes_total} / ${totals.episodes_expected}`], ['Episodes with title', totals.episodes_with_title], ['Episodes with recap source', totals.episodes_with_source], ['Episodes with bout facts', totals.episodes_with_bout_facts],
]) md.push(`| ${k} | ${v} |`);
md.push('', '## Worst 10 by completeness score', '', '| Season | Score | Status | Blockers |', '|---|---|---|---|');
for (const w of worst) md.push(`| ${w.slug} | ${w.score} | ${w.status} | ${w.blockers.join(', ')} |`);
md.push('', '## Season matrix', '', '| Season | Year | State | Status | Score | Episodes (title/recap/bouts of exp.) | Roster | Linked/Unresolved | Bouts (present/exp.) | Pro/Exh/Unres | Result V/P/S/U | QF/SF/F done | Winners (res/linked of exp.) | Finale (pro linked of exp.) | Open conflicts | Portraits |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const s of seasons) {
  const t = s.tournament;
  md.push(`| ${s.slug} | ${s.year} | ${s.season_state} | ${s.status} | ${s.score} | ${s.episodes.with_title}/${s.episodes.with_recap_source}/${s.episodes.with_bout_facts} of ${s.episodes.expected ?? '—'} | ${s.contestants.roster_present} | ${s.contestants.linked}/${s.contestants.unresolved} | ${t.bouts_present}/${t.bouts_expected} | ${t.professional}/${t.exhibition}/${t.classification_unresolved} | ${t.result_verified}/${t.result_partial}/${t.result_scheduled}/${t.result_unknown} | ${tick(t.quarterfinals_complete)}/${tick(t.semifinals_complete)}/${tick(t.final_complete)} | ${s.winners.resolved}/${s.winners.linked} of ${s.winners.expected} | ${s.finale.professional_final_linked} of ${s.finale.expected}${s.finale.scheduled ? ` (${s.finale.scheduled} scheduled)` : ''} | ${s.conflicts.open} | ${s.portraits.with_licensed_portrait}/${s.portraits.linked_contestants} |`);
}
md.push('', '## Product depth', '', 'Reported beside the structural status, never folded into it. Depth score = mean of the parts that apply (episodes with sourced facts, house bouts placed in episodes, house results verified, classification with an affirmative basis, identity coverage, finale integration).', '', '| Season | Depth | Episodes with facts / shells | Timeline events (unplaced) | House bouts in episodes | Result evidence | Exhibition affirmative / absence-only | Identity | Finale linked+scheduled / exp. | Format declared |', '|---|---|---|---|---|---|---|---|---|---|');
for (const s of seasons) {
  const x = s.depth;
  md.push(`| ${s.slug} | ${x.depth_score ?? '—'} | ${x.episodes_with_facts} / ${x.title_only_shells} | ${x.timeline_events} (${x.timeline_unplaced}) | ${x.house_bouts_with_episode}/${x.house_bouts} | ${x.house_bouts_with_result_evidence}/${x.house_bouts} | ${x.exhibition_with_affirmative_basis} / ${x.exhibition_absence_only} | ${x.identity.linked}/${x.identity.contestants} | ${x.finale_integration.linked_by_exact_ids + x.finale_integration.scheduled}/${x.finale_integration.expected} | ${x.competition_format_declared ? 'yes' : 'no'} |`);
}
md.push('', '## Season blockers', '');
for (const s of seasons) md.push(`- **${s.slug}** (${s.status}): ${s.blockers.join(', ') || 'none'}${s.critical_blockers.length ? ` — critical: ${s.critical_blockers.join('; ')}` : ''}`);
md.push('', `Column key: Result V/P/S/U = verified / partial (Wikipedia-only winner) / scheduled / unknown. Portraits = licensed ufc_images rows / linked contestants (display fallbacks not counted). Percent verified overall: ${pct(totals.result_verified, totals.tournament_bouts_total)}.`);
fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
fs.writeFileSync(OUT_MD, md.join('\n') + '\n');
console.log(JSON.stringify({ totals, worst_10: worst.map((w) => `${w.slug}:${w.score}:${w.status}`) }, null, 1));
