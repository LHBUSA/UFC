#!/usr/bin/env node
/**
 * TUF 2 gold-standard data repair. Approved 2026-09-13.
 *
 *   node scripts/tuf/apply_tuf2_gold.mjs [--write]
 *   UFC_ENV_FILE=... node scripts/tuf/resolve_identity.mjs --write     # Josh Burkman alias, pre-draft cast ids
 *
 * Idempotent: rebuilds TUF 2's repaired sections from the statements below and
 * from web/data/tuf/commission_records.json every run. No network, no database.
 *
 *   - The Nevada State Athletic Commission's Season 2 results record is the
 *     primary authority for all 12 house bouts: result (verified), method,
 *     round, time, fight date, and the exhibition classification. Where the
 *     commission and the Wikipedia draft differ, the commission wins and the
 *     bout's `corrections` keeps OLD, NEW, SOURCE and REASON.
 *   - fight_date is the commission's show date. It is never an air date and is
 *     never derived from one.
 *   - competition_format: pre-draft exits, team draft, elimination fights,
 *     semi-finals, live finals. The episode 1 exits are timeline events and a
 *     pre-draft cast list — never bouts. The synthetic "Unassigned" team goes.
 *   - format_exceptions become sourced timeline events.
 *   - overview keeps the house fight window apart from the broadcast window.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const WRITE = process.argv.includes('--write');
const BATCH = 'tuf2-gold-standard';
const RETRIEVED = '2026-09-13';
const fail = (m) => { console.error(`STOP: ${m}`); process.exit(1); };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

const seasonPath = path.join(DATA, 'seasons', 'tuf-2.json');
const season = readJson(seasonPath);
const ledger = readJson(path.join(DATA, 'commission_records.json'));
const doc = ledger.documents.find((d) => d.id === 'nsac-2005-tuf-season-2');
if (!doc) fail('commission document missing from the ledger');
const records = ledger.records.filter((r) => r.document_id === doc.id);
if (records.length !== 12) fail(`expected 12 commission records, found ${records.length}`);

/* ---- sources ---------------------------------------------------------------- */
const WIKI = { family: 'wikipedia', evidence_level: 'secondary_draft', url: 'https://en.wikipedia.org/wiki/The_Ultimate_Fighter_2', retrieved: RETRIEVED };
const wiki = (quote) => ({ ...WIKI, quote });
const PP_URL = 'https://www.paramountplus.com/shows/the-ultimate-fighter/xhr/episodes/page/0/size/50/xs/0/season/2/';
const PP_IDS = { 1: 'oy_2Ke1PEZATCGXVddYuK_GE1ylojKnJ', 2: 'z9988rJAJ5Xv_cgM0uribFOKhHDk_Wty', 3: 'D_bzk_SYrUPH7UBQZkPmqS9yLRPHsAtp', 4: 'TkeN2JgHH8XP4odVqqZnkTnwpdmOZbct', 5: 'EpJ6fvkZtLIFgEwAxtXmFcAkY4d_ARjJ', 6: '53HJjoTZCoLiRSTXdF_bOh4iUimpKWQe', 7: 'GRvyUhCGc4BOAaWbd4JCAq1fyTcq6LZE', 8: 'FQyvIHOlWUhtiarm0JqknLDqi4WVBZmk', 9: 'JHqCOX89ZDmyzlQcEY3u5DXObd64Fx8W', 10: 'gqP3OZYgcBG0whuR9Rl_BtkzxpReOwQs', 11: 'r3LUT9PRMeLxkdvj6n3lg3UtrkjhptLn', 12: 'xxzGTkKb72RKRhmRridUTFdub9VUt0O0' };
const pp = (item, quote, note) => ({ family: 'paramount_plus_episode_metadata', evidence_level: 'network_listing', url: PP_URL, content_id: PP_IDS[item], listing_item: item, retrieved: RETRIEVED, quote, ...(note ? { note } : {}) });
const commission = (rec, extra = {}) => ({
  family: 'athletic_commission', source_type: 'commission_result_record', evidence_level: 'commission_record',
  jurisdiction: doc.jurisdiction, commission: doc.commission, document_id: doc.id, record_id: rec.id,
  url: doc.url, archive_url: doc.archive_url, sha256: doc.sha256, retrieved: doc.retrieved, ...extra,
});

/* ---- 1. house bouts from the commission record --------------------------- */
const EPISODE = {
  'Josh Burkman|Melvin Guillard': { episode: 2, sources: [wiki('Josh Burkman defeated Melvin Guillard by unanimous decision after three rounds.'), pp(2, 'The opening fight of the season is a knock-out brawl between two welterweights.', 'names no fighter')] },
  'Brad Imes|Rob MacDonald': { episode: 3, sources: [wiki('Brad Imes defeated Rob MacDonald by submission (triangle choke) at 4:07 of the first round.'), pp(3, "the heavyweights prepare for their first battle in the Octagon'", 'names no fighter')] },
  'Joe Stevenson|Marcus Davis': { episode: 4, sources: [wiki('Joe Stevenson defeated Marcus Davis by submission (elbows) at 4:10 of the first round.'), pp(4, 'a second welterweight is sent home in brutal fashion', 'names no fighter')] },
  'Rashad Evans|Tom Murphy': { episode: 5, sources: [wiki('Rashad Evans defeated Tom Murphy by unanimous decision after three rounds.'), pp(5, "two more heavyweights go toe to toe in the Octagon'", 'names no fighter')] },
  'Jason Von Flue|Jorge Gurgel': { episode: 6, sources: [wiki('Jason Von Flue defeated Jorge Gurgel by unanimous decision after three rounds.'), pp(6, 'A welterweight suffers a crushing defeat in an all out three round slugfest.', 'names no fighter')] },
  'Seth Petruzelli|Dan Christison': { episode: 7, sources: [wiki('Seth Petruzelli defeated Dan Christison by unanimous decision after three rounds.'), pp(7, "clash of styles in the Octagon' sends another heavyweight home", 'names no fighter')] },
  'Luke Cummo|Anthony Torres': { episode: 8, sources: [wiki('Luke Cummo defeated Anthony Torres by unanimous decision after three rounds.'), pp(8, 'Two welterweights listen to his advice and go to war.', 'names no fighter')] },
  'Rashad Evans|Mike Whitehead': { episode: 9, sources: [wiki('Rashad Evans defeats Mike Whitehead by unanimous decision after three rounds.'), pp(9, "a heavyweight must live up to everyone's expectations", 'names no fighter')] },
  'Luke Cummo|Sammy Morgan': { episode: 10, sources: [wiki('Luke Cummo defeated Sammy Morgan by KO (knee) at 2:05 of the second round.'), pp(10, 'Semi-Final #1 Killer Instinct', 'listing title; this item\'s description is swapped with item 11 (see source_defects)'), pp(11, 'a welterweight demonstrates his killer instinct to become the first finalist', 'swapped item-11 description; used for the pairing stage only')] },
  'Rashad Evans|Keith Jardine': { episode: 11, sources: [wiki('Rashad Evans defeated Keith Jardine by unanimous decision after three rounds.'), pp(11, 'Semi-Final #2 Bloody Brawl', 'listing title'), pp(10, 'Rashad Evans takes on Keith Jardine in the first heavyweight semi-final match.', 'swapped item-10 description; names the pairing only')] },
  'Brad Imes|Seth Petruzelli': { episode: 12, sources: [wiki('Brad Imes defeated Seth Petruzelli by split decision after three rounds.'), pp(12, 'In the heavyweight semi-final, Brad and Seth battle for the last spot in the finals.')] },
  'Joe Stevenson|Jason Von Flue': { episode: 12, sources: [wiki('Joe Stevenson defeated Jason Von Flue by submission (armbar) at 4:46 of the first round.'), pp(12, "If he can't, Marcus will take his place and fight Joe in the 2nd welterweight semi-final.")] },
};

const house = season.bracket.flatMap((br) => br.stages.filter((st) => st.stage !== 'final').flatMap((st) => st.bouts.map((b) => ({ b, st, br }))));
if (house.length !== 12) fail(`expected 12 house bouts, found ${house.length}`);
let corrected = 0;
for (const { b, st, br } of house) {
  const rec = records.find((r) => r.bout.weight_class === br.weight_class && r.bout.stage === st.stage && fold(r.bout.a) === fold(b.a) && fold(r.bout.b) === fold(b.b));
  if (!rec) fail(`${b.a} vs ${b.b}: no commission record`);
  if (fold(rec.winner) !== fold(b.winner)) fail(`${b.a} vs ${b.b}: commission winner ${rec.winner} differs from the bracket winner ${b.winner} — a winner change needs review, not a repair`);
  const ep = EPISODE[`${b.a}|${b.b}`];
  if (!ep) fail(`${b.a} vs ${b.b}: no episode evidence`);
  if (b.episode !== ep.episode) fail(`${b.a} vs ${b.b}: episode ${b.episode} differs from evidence ${ep.episode}`);

  /* The draft values as they stood before this batch, so re-runs keep them. */
  const before = Object.fromEntries((b.corrections || []).filter((c) => c.batch === BATCH).map((c) => [c.field, c.old]));
  const draft = { method: before.method ?? b.method, round: before.round ?? b.round, time: before.time ?? b.time };
  const next = { method: rec.method, round: rec.round, time: rec.time };
  const corrections = [];
  for (const field of ['method', 'round', 'time']) {
    if (JSON.stringify(draft[field] ?? null) === JSON.stringify(next[field] ?? null)) continue;
    if (field === 'time' && next.time == null) continue; // the commission prints no time for a decision; keep none either way
    corrections.push({ field, old: draft[field] ?? null, new: next[field], source: { document_id: doc.id, record_id: rec.id }, reason: `the commission record states ${field} as ${JSON.stringify(next[field])} ("${rec.result_text}"); a primary commission record overrides the Wikipedia draft`, batch: BATCH });
  }
  Object.assign(b, { method: next.method, round: next.round, time: next.time });
  if (corrections.length) { b.corrections = [...(b.corrections || []).filter((c) => c.batch !== BATCH), ...corrections]; corrected += 1; }
  else b.corrections = (b.corrections || []).filter((c) => c.batch !== BATCH);
  if (!b.corrections.length) delete b.corrections;

  b.fight_date = rec.date;
  b.fight_date_source = { document_id: doc.id, record_id: rec.id };
  b.result_sources = [commission(rec, { winner: rec.winner, quote: rec.result_text })];
  b.episode_sources = ep.sources;
  b.classification = 'exhibition';
  b.classification_basis = {
    affirmative: [commission(rec, { quote: doc.classification_language.quote, note: `listed under "${doc.classification_language.quote}" in the commission's Season 2 results record` })],
    corroborating: [{ kind: 'record_absence', family: 'our_records', evidence_level: 'corroboration_only', year: 2005, note: 'no bout between these two fighters in our records for 2005, which are complete for that year' }],
    authority: 'affirmative',
    reopen_if: 'the commission reclassifies the Season 2 bouts again (the season source records one earlier reclassification from professional to exhibition)',
  };
  b.classification_source = `exhibition: fought at the UFC Training Center on ${rec.date} and aired in episode ${ep.episode}; the Nevada State Athletic Commission's Season 2 results record lists it under "Exhibition Results" (commission_record) — a commission-sanctioned exhibition, not a professional bout. Absence from our complete 2005 records is corroboration only.`;
  b.commission_record_id = rec.id;
}

/* ---- 2. finals: link by exact bout id, basis from the result row ----------- */
/* Exact finale bouts in our records (The Ultimate Fighter: Team Hughes vs. Team Franklin Finale). */
const FINAL_IDS = { Welterweight: '1027f33c-bd93-46f3-a424-277a6927c822', Heavyweight: 'efdfe676-6d25-4f2e-b8fe-e31bb368e99b' };
for (const br of season.bracket) {
  const f = br.stages.find((s) => s.stage === 'final')?.bouts[0];
  if (!f) fail(`${br.weight_class}: no final`);
  f.ufc_bout_id = FINAL_IDS[br.weight_class];
  f.classification_basis = {
    affirmative: [{ family: 'our_records', evidence_level: 'canonical', what: `ufc_bouts ${f.ufc_bout_id} + ufc_bout_results on ${season.finale.event_name}, ${season.finale.event_date}`, note: 'contested on the sanctioned finale card; the result row names the tournament winner' }],
    corroborating: [],
  };
}

/* ---- 3. format ------------------------------------------------------------ */
season.competition_format = {
  kind: 'elimination_then_semifinals',
  label: 'Pre-draft exits, team draft, elimination fights, semi-finals, live finals',
  applies_to: 'each weight class',
  steps: [
    { key: 'pre_draft', label: 'Before the draft', episode: 1, rule: 'Eighteen fighters arrived, nine per division. Before the draft one was injured out, one left the show, and one forfeited his match. None of these was a bout.' },
    { key: 'draft', label: 'Team draft', episode: 2, rule: 'A coin flip gave Franklin the first pick, and each coach drafted eight fighters, four per division.' },
  ],
  phases: [
    { stage: 'elimination', label: 'Elimination fights', expected_bouts: null, advances: 4,
      rule: 'Team challenges decided which team chose the next matchup, and the loser of each fight left the competition. A fighter could fight more than once, a replacement could take a withdrawn winner\'s place, and a fighter could reach the last four without a house fight.' },
    { stage: 'semi_final', label: 'Semi-finals', expected_bouts: 2, rule: 'Dana White, Franklin and Hughes set the semi-final matchups with input from the fighters.' },
    { stage: 'final', label: 'Final', expected_bouts: 1, contested: 'on the live finale card' },
  ],
  sources: [
    pp(1, "Eighteen of the world's toughest heavyweights and welterweights compete for two UFC contracts."),
    wiki('with 9 fighters initially in each division'),
    wiki('A coin is flipped and Franklin chose to pick the first fighter.'),
    wiki('The rest of the matches are set up by White, Franklin, and Hughes with input from fighters'),
  ],
};
for (const br of season.bracket) {
  const el = br.stages.find((s) => s.stage === 'elimination');
  Object.assign(el, { label: 'Elimination fights' });
  delete el.note;
}

/* ---- 4. cast: pre-draft exits, no synthetic team --------------------------- */
const unassigned = season.teams.find((t) => t.name === 'Unassigned');
const priorPre = season.pre_draft_cast || [];
const PRE = [
  { name: 'Kerry Schall', weight_class: 'Heavyweight', exit: 'injury', episode: 1, timeline_event: 'tuf2-schall-out' },
  { name: 'Eli Joslin', weight_class: null, exit: 'left_show', episode: 1, timeline_event: 'tuf2-joslin-leaves', weight_class_note: 'not stated by any captured source', identity_note: 'No canonical fighter. Jeff Joslin in ufc_fighters is a different person: no bout, event or date ties him to this season, and a shared surname is not identity.' },
  { name: 'Kenny Stevens', weight_class: 'Welterweight', exit: 'forfeit', episode: 1, timeline_event: 'tuf2-stevens-forfeit', identity_note: 'No canonical fighter: he forfeited before the draft and has no UFC bout in our records.' },
];
for (const p of PRE) {
  const had = unassigned?.roster.find((r) => r.name === p.name) || priorPre.find((r) => r.name === p.name);
  if (!had) fail(`${p.name} is not in the season's cast`);
  if (had.fighter_id) p.fighter_id = had.fighter_id;
}
season.pre_draft_cast = PRE;
season.teams = season.teams.filter((t) => t.name !== 'Unassigned');

const PICKS = {
  'Team Franklin': ['Keith Jardine', 'Jorge Gurgel', 'Seth Petruzelli', 'Marcus Davis', 'Rashad Evans', 'Anthony Torres', 'Melvin Guillard', 'Brad Imes'],
  'Team Hughes': ['Joe Stevenson', 'Mike Whitehead', 'Josh Burkman', 'Dan Christison', 'Sammy Morgan', 'Tom Murphy', 'Rob MacDonald', 'Luke Cummo'],
};
for (const t of season.teams) {
  t.pick_basis = "Draft order from the season source's episode 2 team-selection table (Wikipedia, secondary; it prints 'Rob McDonald'). Rosters are as drafted; moves and exits are timeline events.";
  for (const p of t.roster) {
    delete p.note;
    const i = PICKS[t.name].indexOf(p.name);
    if (i >= 0) p.pick = i + 1;
    else if (p.name === 'Jason Von Flue') { p.status = 'replacement'; p.replacement_for = 'Josh Burkman'; p.episode = 3; delete p.pick; }
    else fail(`${t.name}: ${p.name} not in the draft table`);
    if (p.name === 'Josh Burkman') { p.status = 'withdrawn'; p.episode = 3; }
  }
  t.roster.sort((x, y) => (x.pick ?? (PICKS[t.name].indexOf(x.replacement_for) + 1.5)) - (y.pick ?? (PICKS[t.name].indexOf(y.replacement_for) + 1.5)));
}

/* ---- 5. timeline events ----------------------------------------------------- */
const rec = (id) => records.find((r) => r.id === id);
const remark = (id, fighter) => commission(rec(id), { quote: rec(id).remarks.find((x) => x.fighter === fighter).quote, note: 'commission remark attached to the bout result' });
season.timeline_events = [
  { id: 'tuf2-schall-out', episode: 1, type: 'withdrawal', fighters: ['Kerry Schall'], detail: 'Left the competition before the draft with a knee injury.', sources: [wiki('Heavyweight Kerry Schall is eliminated due to a knee injury.')] },
  { id: 'tuf2-joslin-leaves', episode: 1, type: 'withdrawal', fighters: ['Eli Joslin'], detail: 'Chose to leave the show before the draft.', sources: [wiki('Eli Joslin chooses to leave the show')] },
  { id: 'tuf2-stevens-forfeit', episode: 1, type: 'forfeit', fighters: ['Kenny Stevens', 'Sammy Morgan'], detail: 'Kenny Stevens, named the weakest welterweight, called out Sammy Morgan and then forfeited the match. No bout took place; Morgan stayed in the competition.', sources: [wiki('Kenny Stevens is chosen as the weakest welterweight and calls out Sammy Morgan to fight.'), wiki('Stevens forfeits his match saying he will not be able to make weight for the fight.')] },
  { id: 'tuf2-stevens-weight', episode: 1, type: 'weight_issue', fighters: ['Kenny Stevens'], detail: 'Said he would not be able to make weight for the fight.', sources: [wiki('Stevens forfeits his match saying he will not be able to make weight for the fight.')] },
  { id: 'tuf2-christison-joins', episode: 2, type: 'replacement', fighters: ['Dan Christison'], replaces: 'Kerry Schall', detail: 'Joined the show in place of the injured Kerry Schall.', sources: [wiki('Dan Christison joins the show to replace the injured Schall.')] },
  { id: 'tuf2-draft', episode: 2, type: 'team_selection', fighters: [], detail: 'A coin flip gave Rich Franklin the first pick. First picks: Keith Jardine (Franklin) and Joe Stevenson (Hughes).', sources: [wiki('A coin is flipped and Franklin chose to pick the first fighter.'), pp(2, 'The coaches make their choices')] },
  { id: 'tuf2-burkman-injury', episode: 3, type: 'injury', fighters: ['Josh Burkman'], detail: 'Broke his arm in his fight with Melvin Guillard.', sources: [wiki('Josh Burkman is forced to leave the competition after breaking his arm in the match with Melvin Guillard.')] },
  { id: 'tuf2-burkman-withdrawal', episode: 3, type: 'withdrawal', fighters: ['Josh Burkman'], detail: 'Left the competition with the broken arm, after winning his fight.', sources: [wiki('Josh Burkman is forced to leave the competition after breaking his arm in the match with Melvin Guillard.')] },
  { id: 'tuf2-vonflue-joins', episode: 3, type: 'replacement', fighters: ['Jason Von Flue'], replaces: 'Josh Burkman', detail: 'Joined the show in place of Josh Burkman.', sources: [wiki('Jason Von Flue joins the show to replace Burkman.'), pp(3, 'A new fighter arrives at the house ruffling some feathers', 'names no fighter')] },
  { id: 'tuf2-macdonald-shoulder', episode: 3, type: 'injury', fighters: ['Rob MacDonald'], detail: 'Complained of a shoulder injury.', sources: [wiki('Rob MacDonald complains about his shoulder which he claims he injured very badly.'), pp(3, 'Coach Hughes gets annoyed with the constant whining of one of his fighters.', 'names no fighter')] },
  { id: 'tuf2-macdonald-medical', episode: 3, type: 'medical_clearance', fighters: ['Rob MacDonald'], detail: 'After his fight, the commission required left bicep and left labrum tears to be cleared by a doctor.', sources: [remark('nsac-2005-tuf2-02', 'Rob MacDonald')] },
  { id: 'tuf2-gurgel-medical', episode: 6, type: 'medical_clearance', fighters: ['Jorge Gurgel'], detail: 'After his fight, the commission required a torn left ACL to be cleared by an orthopedic doctor.', sources: [remark('nsac-2005-tuf2-05', 'Jorge Gurgel')] },
  { id: 'tuf2-vonflue-move', episode: 7, type: 'trade', fighters: ['Jason Von Flue'], from_team: 'Team Hughes', to_team: 'Team Franklin', detail: 'Sent to Team Franklin in a team reshuffle.', sources: [wiki('Hughes sends Von Flue over to Team Franklin for reshuffling.'), pp(7, 'The teams are re-balanced.')] },
  { id: 'tuf2-christison-medical', episode: 7, type: 'medical_clearance', fighters: ['Dan Christison'], detail: 'After his fight, the commission required nasal and facial fractures to be cleared by a doctor.', sources: [remark('nsac-2005-tuf2-06', 'Dan Christison')] },
  { id: 'tuf2-imes-move', episode: 8, type: 'trade', fighters: ['Brad Imes'], from_team: 'Team Franklin', to_team: 'Team Hughes', detail: 'Sent to Team Hughes in a team reshuffle.', sources: [wiki('Franklin sends Brad Imes to Team Hughes for reshuffling.'), pp(9, 'Brad quickly learns how different training is over at Team Hughes.', 'next episode')] },
  { id: 'tuf2-imes-cut', episode: 9, type: 'injury', fighters: ['Brad Imes'], detail: 'Passed over for a fight because of a cut over his eye from training; Mike Whitehead fought instead.', sources: [wiki('Brad Imes is passed over for a fight due to a cut over his eye received in training, so Whitehead is chosen to fight instead.')] },
  { id: 'tuf2-vonflue-cut', episode: 10, type: 'injury', fighters: ['Jason Von Flue'], detail: 'Cut between the eyes in practice.', sources: [wiki('Jason Von Flue sustains a cut between the eyes in practice')] },
  { id: 'tuf2-davis-alternate', episode: 10, type: 'alternate_named', fighters: ['Marcus Davis'], replaces: 'Jason Von Flue', detail: 'Brought back as the alternate in case Von Flue could not fight. Von Flue was cleared, and Davis did not fight.', sources: [wiki('Marcus Davis is brought back as an alternate in the case of Von Flue being unable to fight.'), pp(12, "If he can't, Marcus will take his place and fight Joe in the 2nd welterweight semi-final.")] },
  { id: 'tuf2-semis-set', episode: 10, type: 'semi_final_matchups_announced', fighters: [], detail: 'Dana White, Franklin and Hughes set the semi-finals with input from the fighters: Cummo vs Morgan, Stevenson vs Von Flue, Imes vs Petruzelli, Evans vs Jardine.', sources: [wiki('The rest of the matches are set up by White, Franklin, and Hughes with input from fighters'), pp(11, 'Dana announces the fight match-ups for the semi-finals', 'swapped item-11 description')] },
  { id: 'tuf2-vonflue-cleared', episode: 12, type: 'medical_clearance', fighters: ['Jason Von Flue'], detail: 'Cleared by the doctors to fight his semi-final.', sources: [wiki('Von Flue is cleared by the doctors to fight.'), pp(12, "A doctor examines Jason's cut to determine if he can fight.")] },
  { id: 'tuf2-petruzelli-ear', episode: 12, type: 'injury', fighters: ['Seth Petruzelli'], detail: 'Suffered damage to his right ear in his semi-final.', sources: [wiki('Petruzelli suffers extensive damage to his right ear')] },
];
delete season.format_exceptions;

/* ---- 6. overview ------------------------------------------------------------ */
season.overview = {
  format: { value: season.competition_format.label, basis: 'competition_format' },
  premiere: { date: '2005-08-22', basis: 'episode 1 air date (network listing + independent source agree)' },
  finale: { date: '2005-11-05', event: 'The Ultimate Fighter: Team Hughes vs. Team Franklin Finale', basis: 'our records (ufc_events)' },
  fight_window: { start: '2005-06-15', end: '2005-07-12', value: 'Jun 15 – Jul 12, 2005', basis: 'house fight dates in the Nevada State Athletic Commission record', sources: [commission(records[0], { quote: 'DATE OF SHOW: 06/15/05', note: 'first house bout' }), commission(records[11], { quote: 'DATE OF SHOW: 07/12/05', note: 'last house bout' })] },
  cast_size: { value: 18, sources: [pp(1, "Eighteen of the world's toughest heavyweights and welterweights compete for two UFC contracts.")] },
  network: { value: 'Spike TV', sources: [{ ...WIKI, quote: 'Spike TV', note: "the article's infobox network field" }] },
  hosts: { value: 'Dana White; Randy Couture (team challenges)', sources: [wiki('Hosts: Dana White, Randy Couture')] },
};

const baseNote = String(season._provenance.note).split(' House results, fight dates')[0];
season._provenance = { ...season._provenance, note: `${baseNote} House results, fight dates and classification are from the Nevada State Athletic Commission's Season 2 results record (${BATCH}); the draft's differing values are kept in each bout's corrections.` };

const text = JSON.stringify(season, null, 2) + '\n';
const prior = fs.readFileSync(seasonPath, 'utf8');
console.log(prior === text ? 'no changes (already applied)' : `tuf-2.json would change: ${corrected} bouts corrected by the commission; ${season.timeline_events.length} timeline events; pre-draft ${season.pre_draft_cast.length}`);
if (!WRITE) { console.log('(dry run — pass --write)'); process.exit(0); }
fs.writeFileSync(seasonPath, text);
console.log('wrote web/data/tuf/seasons/tuf-2.json — now run resolve_identity.mjs --write');
