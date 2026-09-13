#!/usr/bin/env node
/**
 * TUF 1 gold-standard data repair. Approved 2026-09-13.
 *
 *   UFC_ENV_FILE=D:/Workers/secrets/ufc-propbetedge.env node scripts/tuf/apply_tuf1_gold.mjs [--write]
 *   node scripts/tuf/resolve_identity.mjs --write          # re-stamp ids (Nathan -> Nate Quarry alias)
 *
 * Idempotent: rebuilds the TUF 1 season file's repaired sections from the
 * statements below every run. Evidence and its short quotes are in
 * scripts/tuf/evidence/tuf1_gold_audit_2026-09-13.json. Read-only against the
 * database (the bout lookups that corroborate classification and anchor the
 * finals). Nothing is copied from the database into the file except the bout
 * ids that link to it.
 *
 * What changes:
 *   - competition_format: an elimination phase, then semi-finals, then live
 *     finals. The two quarter-final stages become ordered elimination stages;
 *     the "conflicts" they produced move to _resolved_conflicts.
 *   - timeline_events: sourced roster moves, eliminations without a fight,
 *     injuries, withdrawal, return, alternate, weight issue, staff change.
 *     Bouts are NOT repeated here: an episode reads its bouts from the bracket.
 *   - The Rafferty trade stays unresolved (episode 7 vs 8) as an open conflict.
 *   - Every house bout: episode_sources, result_sources (Wikipedia = draft), and
 *     a classification_basis whose affirmative evidence is ESPN's 2020
 *     retrospective (secondary_affirmative). Database absence is corroboration
 *     only, argued from 2004 — the year the house fights were filmed.
 *   - Finals: classification_basis from the result row (canonical). The copied
 *     scorecards string is removed; the page reads ufc_bout_scorecards.
 *   - Staff: discipline coaches with no team; Nathan Quarry as assistant coach
 *     from episode 8. Roster notes give way to draft picks and timeline events.
 *   - overview: sourced season facts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const WRITE = process.argv.includes('--write');
const BATCH = 'tuf1-gold-standard';
const RETRIEVED = '2026-09-13';

const env = { ...process.env };
const envFile = process.env.UFC_ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
const q = async (p) => { const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${p}`, { headers: H }); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
const fail = (m) => { console.error(`STOP: ${m}`); process.exit(1); };
const one = (v) => (Array.isArray(v) ? v[0] : v);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const seasonPath = path.join(DATA, 'seasons', 'tuf-1.json');
const season = readJson(seasonPath);
const completeness = readJson(path.join(DATA, 'record_completeness.json')).years;
if (!completeness['2004']?.complete) fail('2004 record completeness must be measured (record_completeness.mjs --years 2004 --write) before it is cited');

/* ---- sources ------------------------------------------------------------- */
const WIKI = { family: 'wikipedia', evidence_level: 'secondary_draft', url: 'https://en.wikipedia.org/wiki/The_Ultimate_Fighter_1', retrieved: RETRIEVED };
const WIKI_TUF = { family: 'wikipedia', evidence_level: 'secondary_draft', url: 'https://en.wikipedia.org/wiki/The_Ultimate_Fighter', retrieved: RETRIEVED };
const PP_URL = 'https://www.paramountplus.com/shows/the-ultimate-fighter/xhr/episodes/page/0/size/50/xs/0/season/1/';
const PP_IDS = { 1: 'spUhuYW6QdsZ7uX8u25WyTpmuOZY9k3u', 2: 'BoArfPQnMrsDrVTV6kXyLPso9Xt3rRbX', 3: 'ikGbywWpCajQDB90W53YGcmGZ9_l_Jzk', 4: 'ITewzu08Ny7kRkNRpIgG6jhRt3h67wid', 5: 'Wihp2LD6hEdtskUWUezTvYOsGy153ZAc', 6: 'FNQYXSgrM6B_YjTAOCAyLcO83_g8pvmc', 7: 'GDzsFvzKw1wXYtf0NjnEMj9qzy4sHBWS', 8: 'yXh34gY8fl9J_EeArDBZatvU25USf_Kh', 9: 'xSil9csBKcjEmYmibordYZ0fkv1Vetf2', 10: 'YA5TIwXDGp2sJHrrnlP41IyzxnzI4cYp', 11: 'GNQbFUSqbuIOaOeVwMDAdMrbWLXZ_bcJ', 12: 'WWsGd_YF0JBJ9i3hzHVhlM7G379ojqoz' };
const pp = (item, quote, note) => ({ family: 'paramount_plus_episode_metadata', evidence_level: 'network_listing', url: PP_URL, content_id: PP_IDS[item], listing_item: item, retrieved: RETRIEVED, quote, ...(note ? { note } : {}) });
const wiki = (quote) => ({ ...WIKI, quote });
const ESPN20 = {
  family: 'espn_retrospective', evidence_level: 'secondary_affirmative',
  url: 'https://www.espn.com/mma/story/_/id/29014001/the-story-how-ultimate-fighter-saved-ufc-15-years-ago',
  author: 'Michael Rothstein', published: '2020-04-09', retrieved: RETRIEVED,
  quote: 'Fertitta had worked with the Nevada State Athletic Commission to designate any fights before the live finale as exhibitions',
  scope: 'every TUF 1 fight before the live finale',
  not: 'not the commission record itself; reopen if a commission record contradicts it',
};
const UFCCOM = { family: 'ufc.com', evidence_level: 'official', url: 'https://www.ufc.com/news/ufc-legends-griffin-vs-bonnar-1', published: '2015-04-14', retrieved: RETRIEVED, quote: 'Filming for the show started in late 2004' };

/* ---- 1. format ------------------------------------------------------------ */
season.competition_format = {
  kind: 'elimination_then_semifinals',
  label: 'Elimination fights, then semi-finals, then live finals',
  applies_to: 'each weight class',
  phases: [
    { stage: 'elimination', label: 'Elimination fights', expected_bouts: null, advances: 4,
      rule: 'Team challenges decided which team chose the next matchup, and the loser of each fight left the competition. Early challenges also eliminated fighters without a fight. A fighter could fight more than once, and a fighter could reach the last four without a house fight.' },
    { stage: 'semi_final', label: 'Semi-finals', expected_bouts: 2 },
    { stage: 'final', label: 'Final', expected_bouts: 1, contested: 'on the live finale card' },
  ],
  sources: [
    wiki('to determine which had the right to pair one of their fighters against an opponent of their choice'),
    { ...WIKI_TUF, quote: "These challenges resulted in eliminations of fighters who hadn't fought" },
    { ...WIKI_TUF, quote: 'fighters would also leave the house for good upon losing' },
    pp(2, 'two fighters are eliminated and sent home'),
  ],
};

/* ---- 2. bracket: ordered elimination stages, sourced bouts --------------- */
const EPISODE_EVIDENCE = {
  'Bobby Southworth|Lodune Sincaid': { episode: 3, sources: [wiki('Bobby Southworth defeated Lodune Sincaid by KO (strikes) at 0:12 of the second round.'), pp(3, "Two fighters christen the Octagon'", 'names no fighter; the first fight of the season aired here')] },
  'Diego Sanchez|Alex Karalexis': { episode: 4, sources: [wiki('Diego Sanchez defeated Alex Karalexis by submission (rear naked choke) at 1:47 of the first round.'), pp(4, "two Middle Weights face off in the Octagon'", 'names no fighter')] },
  'Josh Koscheck|Chris Leben': { episode: 6, sources: [wiki('Josh Koscheck defeated Chris Leben by unanimous decision after two rounds.'), pp(7, 'After the much-anticipated Leben vs Koscheck fight', 'the next episode opens after this pairing'), pp(6, "the emotional conflict is settled in the Octagon'")] },
  'Stephan Bonnar|Bobby Southworth': { episode: 7, sources: [wiki('Stephan Bonnar defeated Bobby Southworth by split decision after 2 rounds.'), pp(7, 'The Light Heavyweights have a match up that pits two of the strongest fighters against each other.', 'names no fighter')] },
  'Diego Sanchez|Josh Rafferty': { episode: 8, sources: [wiki('Diego Sanchez defeated Josh Rafferty by submission (rear naked choke) at 1:48 of the first round.')] },
  'Forrest Griffin|Alex Schoenauer': { episode: 9, sources: [wiki('Forrest Griffin defeated Alex Schoenauer by submission (strikes) at 1:20 of the first round.'), pp(9, 'The Light Heavyweights compete in the challenge, and controversy arises during the fighter selection.', 'names no fighter')], note: "The same article's finale section says Griffin beat Schoenauer 'by TKO'; the episode wording is kept." },
  'Kenny Florian|Chris Leben': { episode: 10, sources: [wiki('Kenny Florian defeated Chris Leben by TKO (doctor stoppage) at 3:11 of the second round.'), pp(10, 'Middleweight Semi-Final #1', 'listing title')] },
  'Diego Sanchez|Josh Koscheck': { episode: 11, sources: [wiki('Diego Sanchez defeated Josh Koscheck by split decision after 3 rounds'), pp(11, 'Middleweight Semi-Final #2', 'listing title; this item\'s description is swapped with item 12 (see source_defects)')] },
  'Forrest Griffin|Sam Hoger': { episode: 12, sources: [wiki('Forrest Griffin defeated Sam Hoger by TKO (strikes) at 1:05 of the second round.'), pp(12, 'Light Heavyweight Semi-Finals', 'listing title'), pp(11, 'Forrest Griffin finds out if his cut has healed enough to fight Sam Hoger', 'names the pairing, in the swapped item-11 description; used for the pairing only')] },
  'Stephan Bonnar|Mike Swick': { episode: 12, sources: [wiki('Stephan Bonnar defeated Mike Swick by submission (triangle armbar) at 4:58 of the first round.'), pp(12, 'Light Heavyweight Semi-Finals', 'listing title'), pp(11, 'Stephan Bonnar fights his close friend and training partner Mike Swick', 'names the pairing, in the swapped item-11 description; used for the pairing only')] },
};
const keyOf = (b) => EPISODE_EVIDENCE[`${b.a}|${b.b}`] ? `${b.a}|${b.b}` : EPISODE_EVIDENCE[`${b.b}|${b.a}`] ? `${b.b}|${b.a}` : null;

const allBouts = () => season.bracket.flatMap((br) => br.stages.flatMap((st) => st.bouts.map((b) => ({ b, st, br }))));
if (allBouts().length !== 12) fail(`expected 12 bouts, found ${allBouts().length}`);

for (const br of season.bracket) {
  const qf = br.stages.find((s) => s.stage === 'quarter_final' || s.stage === 'elimination');
  if (!qf || qf.bouts.length !== 3) fail(`${br.weight_class}: expected 3 opening bouts`);
  Object.assign(qf, { stage: 'elimination', label: 'Elimination fights' });
  delete qf.status; delete qf.note;
  for (const st of br.stages) if (st.stage === 'semi_final' || st.stage === 'final') delete st.note;
}

/* Our records, read-only: no professional bout between any house pairing in
 * 2004 or 2005, and the two finals by exact ids on the finale card. */
const FINALE_EVENT = 'c93a5b04-6a74-4ec9-854b-422fbfbc5074';
for (const { b, st, br } of allBouts()) {
  if (!b.a_fighter_id || !b.b_fighter_id) fail(`${b.a} vs ${b.b}: both corners must already be linked`);
  const pair = await q(`ufc_bouts?select=id,event_id,event:ufc_events(name,event_date),result:ufc_bout_results(winner_id,method_raw,round)&or=(and(fighter_a_id.eq.${b.a_fighter_id},fighter_b_id.eq.${b.b_fighter_id}),and(fighter_a_id.eq.${b.b_fighter_id},fighter_b_id.eq.${b.a_fighter_id}))`);
  if (st.stage === 'final') {
    const onCard = pair.filter((x) => x.event_id === FINALE_EVENT);
    if (onCard.length !== 1) fail(`${br.weight_class} final: expected one bout on the finale card, found ${onCard.length}`);
    const row = onCard[0];
    const winnerId = b.winner === b.a ? b.a_fighter_id : b.b_fighter_id;
    if (one(row.result)?.winner_id !== winnerId) fail(`${br.weight_class} final: result row winner does not match`);
    delete b.scorecards;
    b.ufc_bout_id = row.id;
    b.classification_basis = {
      affirmative: [{ family: 'our_records', evidence_level: 'canonical', what: `ufc_bouts ${row.id} + ufc_bout_results on ${one(row.event).name}, ${one(row.event).event_date}`, note: 'contested on the sanctioned finale card; the result row names the tournament winner' }],
      corroborating: [],
    };
    continue;
  }
  const k = keyOf(b);
  if (!k) fail(`${b.a} vs ${b.b}: no episode evidence`);
  const ev = EPISODE_EVIDENCE[k];
  if (b.episode != null && b.episode !== ev.episode) fail(`${b.a} vs ${b.b}: episode ${b.episode} already set, evidence says ${ev.episode}`);
  const professionalIn2004or5 = pair.filter((x) => /^200[45]-/.test(String(one(x.event)?.event_date)));
  if (professionalIn2004or5.length) fail(`${b.a} vs ${b.b}: a professional bout between them exists in 2004/2005 — classification must be reviewed`);
  b.episode = ev.episode;
  b.episode_sources = ev.sources;
  b.result_sources = [ev.sources[0]];
  if (ev.note) b.result_note = ev.note;
  const weighIn = k === 'Bobby Southworth|Lodune Sincaid'
    ? [{ kind: 'commission_oversight', ...wiki('the Nevada State Athletic Commission gives Southworth 2 hours to cut 2 pounds'), note: 'shows the commission overseeing this house bout\'s weigh-in; corroborates regulation, not the exhibition label by itself' }]
    : [];
  const c04 = completeness['2004'];
  b.classification = 'exhibition';
  b.classification_basis = {
    affirmative: [ESPN20],
    corroborating: [
      { kind: 'record_absence', evidence_level: 'corroboration_only', year: 2004, note: `no bout between these two fighters in our records for 2004 (complete: ${c04.events} events, ${c04.bouts} bouts, every one with a result) or 2005; the season was filmed in late 2004`, filming_source: UFCCOM },
      ...weighIn,
    ],
    authority: 'affirmative',
    reopen_if: 'a Nevada State Athletic Commission record contradicts the ESPN account',
  };
  b.classification_source = `exhibition: fought in the house before the live finale and aired in episode ${ev.episode}, not contested on a sanctioned card. Affirmative basis: ESPN's 2020 retrospective reports that Lorenzo Fertitta worked with the Nevada State Athletic Commission to designate fights before the live finale as exhibitions (secondary_affirmative; not the commission record). Absence from our complete 2004 records is corroboration only.`;
}
for (const br of season.bracket) {
  const el = br.stages.find((s) => s.stage === 'elimination');
  el.bouts.sort((x, y) => x.episode - y.episode);
}

/* ---- 3. conflicts --------------------------------------------------------- */
const FORMAT_RESOLUTION = 'Not a source conflict. Season 1 had an elimination phase, not quarter-finals: the loser of each house fight left, so a fighter could fight twice and others reached the last four without a house fight. Every bout fits that format and none is missing (see competition_format).';
const prevResolved = (season._resolved_conflicts || []).filter((c) => c.resolved_by !== BATCH);
const draftConflicts = (season._conflicts || []).filter((c) => ['light_heavyweight_quarter_finals', 'middleweight_quarter_finals', 'assistant_coaches'].includes(c.field));
const keepResolved = new Map((season._resolved_conflicts || []).filter((c) => c.resolved_by === BATCH).map((c) => [c.field, c]));
for (const c of draftConflicts) {
  keepResolved.set(c.field, {
    field: c.field, detail: c.detail, resolved_by: BATCH,
    resolved_with: c.field === 'assistant_coaches' ? 'wikipedia cast list (discipline coaches)' : 'competition_format',
    resolution: c.field === 'assistant_coaches'
      ? 'Not a gap to guess at. The season source names them as the grappling, Muay Thai and boxing coaches of the season, with no team; they are recorded with their discipline and team left empty.'
      : FORMAT_RESOLUTION,
  });
}
season._resolved_conflicts = [...prevResolved, ...keepResolved.values()];
const RAFFERTY_CONFLICT = {
  field: 'timeline:josh_rafferty_trade_episode',
  kind: 'episode_placement',
  detail: "Josh Rafferty's move to Team Couture is placed in episode 7 by the season source's episode bullets and in episode 8 by the season draft imported on 2026-09-07. The network listing does not mention the trade. Left unresolved.",
  candidates: [
    { episode: 7, source: wiki('Josh Rafferty is traded to Team Couture in another team reshuffle.') },
    { episode: 8, source: { ...WIKI, retrieved: '2026-09-07', note: 'season draft import (scripts/tuf/import_season.mjs), team-changes listing' } },
  ],
  retrieved: RETRIEVED,
};
season._conflicts = [RAFFERTY_CONFLICT];

/* ---- 4. timeline events -------------------------------------------------- */
season.timeline_events = [
  { id: 'tuf1-draft', episode: 1, type: 'team_selection', fighters: [], detail: 'Coaches Chuck Liddell and Randy Couture drafted their teams. First picks: Bobby Southworth (Liddell) and Nate Quarry (Couture).', sources: [wiki('Light heavyweight and middleweight teams are chosen by coaches Liddell and Couture'), pp(1, 'Sixteen Mixed Martial Artist fighters begin their journey')] },
  { id: 'tuf1-thacker-out', episode: 2, type: 'elimination_without_fight', fighters: ['Jason Thacker'], team: 'Team Couture', detail: 'Sent home by Couture without a fight.', sources: [pp(2, 'two fighters are eliminated and sent home', 'names neither fighter'), wiki('Jason Thacker is sent home by Couture.')] },
  { id: 'tuf1-sanford-out', episode: 2, type: 'elimination_without_fight', fighters: ['Chris Sanford'], team: 'Team Couture', detail: 'Sent home by Couture without a fight.', sources: [pp(2, 'two fighters are eliminated and sent home', 'names neither fighter'), wiki('Chris Sanford is sent home by Couture.')] },
  { id: 'tuf1-southworth-weight', episode: 3, type: 'weight_issue', fighters: ['Bobby Southworth'], detail: 'Cut about 20 lb in 24 hours; weighed 208 lb, was given 2 hours by the Nevada State Athletic Commission, and made 206 lb.', sources: [pp(3, 'a top contender struggles to lose 20 lbs in 24 hours, or face elimination', 'names no fighter'), wiki('the Nevada State Athletic Commission gives Southworth 2 hours to cut 2 pounds')] },
  { id: 'tuf1-schoenauer-trade', episode: 4, type: 'trade', fighters: ['Alex Schoenauer'], from_team: 'Team Liddell', to_team: 'Team Couture', detail: 'Moved to Team Couture in a team reshuffle.', sources: [wiki('Alex Schoenauer is traded to Team Couture as part of a team reshuffle.')] },
  { id: 'tuf1-quarry-injury', episode: 5, type: 'injury', fighters: ['Nathan Quarry'], detail: 'Injured his ankle in practice.', sources: [wiki('Nate Quarry injures his ankle after Couture lands on his ankle during a takedown in practice.')] },
  { id: 'tuf1-leben-injury', episode: 5, type: 'injury', fighters: ['Chris Leben'], detail: 'Cut his hand punching a door window during a house incident.', sources: [pp(5, 'A night on the town for the team members turns violent.', 'names no fighter'), wiki('punching the front door window with his left hand')] },
  { id: 'tuf1-koscheck-leben-ordered', episode: 5, type: 'matchup_ordered', fighters: ['Josh Koscheck', 'Chris Leben'], detail: 'Dana White ordered Koscheck vs Leben to settle the incident, with no challenge.', sources: [pp(5, 'Dana White and his coaches wrestle with how to settle the conflict.', 'names no fighter'), wiki('the only fair way to resolve the situation is for Koscheck and Leben to fight')] },
  { id: 'tuf1-rafferty-trade', episode: null, episode_candidates: [7, 8], conflict: RAFFERTY_CONFLICT.field, type: 'trade', fighters: ['Josh Rafferty'], from_team: 'Team Liddell', to_team: 'Team Couture', detail: 'Moved to Team Couture. Episode unresolved: 7 or 8.', sources: [wiki('Josh Rafferty is traded to Team Couture in another team reshuffle.')] },
  { id: 'tuf1-quarry-withdrawal', episode: 8, type: 'withdrawal', fighters: ['Nathan Quarry'], detail: 'Left the competition because of the ankle injury.', sources: [pp(8, 'Nate discovers his fate in the game'), wiki('Nate Quarry is eliminated from the show due to his ankle injury.')] },
  { id: 'tuf1-leben-return', episode: 8, type: 'replacement_return', fighters: ['Chris Leben'], replaces: 'Nathan Quarry', detail: 'Returned to the competition in place of Quarry, who chose him from the eliminated fighters.', sources: [pp(8, 'a previously eliminated fighter gets another shot at the contract', 'names no fighter'), wiki('Quarry gets to choose his replacement from the loser\'s lounge, and he chooses Chris Leben.')] },
  { id: 'tuf1-quarry-assistant', episode: 8, type: 'staff_change', fighters: ['Nathan Quarry'], detail: 'Stayed on as an assistant coach. No team is stated.', sources: [wiki('White asks Quarry to stay on as an assistant coach, and he agrees.')] },
  { id: 'tuf1-florian-trade', episode: 9, type: 'trade', fighters: ['Kenny Florian'], from_team: 'Team Liddell', to_team: 'Team Couture', detail: 'Moved to Team Couture in a team reshuffle.', sources: [wiki('Kenny Florian is traded to Team Couture in another team reshuffle.')] },
  { id: 'tuf1-griffin-cut', episode: 9, type: 'injury', fighters: ['Forrest Griffin'], detail: 'Cut above the left eye in the Schoenauer fight, feared serious enough to stop him fighting on.', sources: [wiki('Griffin receives a cut above his left eye'), pp(10, "Forrest's cut puts his dream for the contract in jeopardy.", 'next episode')] },
  { id: 'tuf1-southworth-alternate', episode: 10, type: 'alternate_named', fighters: ['Bobby Southworth'], replaces: 'Forrest Griffin', detail: 'Named by Griffin as his alternate. Griffin was cleared, and Southworth did not fight.', sources: [wiki('He chooses Bobby Southworth, who is not given the chance to fight'), pp(11, 'give up his chance for the contract to alternate Bobby Southworth', 'swapped item-11 description; names the alternate')] },
  { id: 'tuf1-semis-announced', episode: 10, type: 'semi_final_matchups_announced', fighters: [], detail: 'Dana White announced how the semi-final opponents would be decided. The content of the announcement is not stated.', sources: [pp(10, 'a surprising announcement from Dana that effect who they will fight to get into the finals')] },
];

/* ---- 5. roster: draft picks, no loose notes ------------------------------ */
const PICKS = {
  'Team Liddell': ['Bobby Southworth', 'Josh Koscheck', 'Diego Sanchez', 'Sam Hoger', 'Forrest Griffin', 'Kenny Florian', 'Alex Schoenauer', 'Josh Rafferty'],
  'Team Couture': ['Nathan Quarry', 'Chris Leben', 'Stephan Bonnar', 'Mike Swick', 'Lodune Sincaid', 'Alex Karalexis', 'Chris Sanford', 'Jason Thacker'],
};
for (const t of season.teams) {
  t.pick_basis = 'Draft order from the season source\'s episode 1 team-selection table (Wikipedia, secondary). Rosters are as originally assigned; moves are timeline events.';
  for (const p of t.roster) {
    const i = PICKS[t.name]?.indexOf(p.name);
    if (i == null || i < 0) fail(`${t.name}: ${p.name} not in the draft table`);
    p.pick = i + 1;
    delete p.note;
  }
  t.roster.sort((x, y) => x.pick - y.pick);
}
delete season.coaching_changes;

/* ---- 6. staff ------------------------------------------------------------- */
const DISCIPLINES = { 'Marc Laimon': 'Grappling', 'Ganyao Fairtex': 'Muay Thai', 'Peter Welch': 'Boxing' };
const CAST_QUOTE = { 'Marc Laimon': 'Marc Laimon, grappling coach', 'Ganyao Fairtex': 'Ganyao Fairtex, Muay Thai coach', 'Peter Welch': 'Peter Welch, boxing coach' };
season.coaches = season.coaches.filter((c) => c.name !== 'Nathan Quarry');
for (const c of season.coaches) {
  if (!DISCIPLINES[c.name]) continue;
  Object.assign(c, { team: null, role: 'assistant', discipline: DISCIPLINES[c.name], role_basis: `named in the season source's cast list as the season's ${DISCIPLINES[c.name].toLowerCase()} coach, with no team (Wikipedia, secondary)`, role_sources: [wiki(CAST_QUOTE[c.name])] });
}
season.coaches.push({ team: null, name: 'Nathan Quarry', role: 'assistant', from_episode: 8, role_basis: 'asked by Dana White to stay on as an assistant coach after withdrawing injured in episode 8 (Wikipedia, secondary); no team is stated', role_sources: [wiki('White asks Quarry to stay on as an assistant coach, and he agrees.')] });

/* ---- 7. overview ------------------------------------------------------------ */
season.overview = {
  format: { value: season.competition_format.label, basis: 'competition_format' },
  premiere: { date: '2005-01-17', basis: 'episode 1 air date (network listing + independent source agree)' },
  finale: { date: '2005-04-09', event: 'The Ultimate Fighter: Team Couture vs. Team Liddell Finale', basis: 'our records (ufc_events)' },
  filming: { value: 'Late 2004', sources: [UFCCOM, { family: 'espn_retrospective', evidence_level: 'secondary', url: ESPN20.url, published: ESPN20.published, retrieved: RETRIEVED, quote: 'The 16 fighters all lived in the same house for 54 days' }] },
  cast_size: { value: 16, sources: [pp(1, 'Sixteen Mixed Martial Artist fighters begin their journey')] },
  network: { value: 'Spike TV', sources: [{ ...WIKI, quote: 'Spike TV', note: "the article's infobox network field" }] },
};

const text = JSON.stringify(season, null, 2) + '\n';
const before = fs.readFileSync(seasonPath, 'utf8');
console.log(before === text ? 'no changes (already applied)' : `tuf-1.json would change (${before.length} -> ${text.length} bytes); timeline events ${season.timeline_events.length}; open conflicts ${season._conflicts.length}; resolved ${season._resolved_conflicts.length}`);
if (!WRITE) { console.log('(dry run — pass --write)'); process.exit(0); }
fs.writeFileSync(seasonPath, text);
console.log('wrote web/data/tuf/seasons/tuf-1.json — now run resolve_identity.mjs --write');
