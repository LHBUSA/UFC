#!/usr/bin/env node
/**
 * TUF 5 + TUF 6 — Nevada State Athletic Commission reconciliation.
 * Decisions approved 2026-09-13 by Justin Erickson (reviewer).
 *
 *   node scripts/tuf/apply_tuf5_tuf6_nsac.mjs            dry run: report what would change
 *   node scripts/tuf/apply_tuf5_tuf6_nsac.mjs --write    write the season files and ledger
 *   node scripts/tuf/apply_tuf5_tuf6_nsac.mjs --check    exit 1 unless the files already equal
 *                                                         the applied result (idempotence)
 *
 * No network, no database. Input: the audited transcriptions in
 * scripts/tuf/evidence/nsac_tuf5_tuf6_audit_2026-09-13.json (28/28 deterministic
 * matches, both documents' sha256 live = archive). The TUF 3/4 path
 * (scripts/tuf/apply_tuf3_tuf4_nsac.mjs), with these approved additions:
 *
 *   - ONE winner correction: TUF 5 quarter-final Brandon Melendez vs Gray Maynard,
 *     Melendez -> Maynard (commission_correction). The quarter_finals conflict it
 *     explains moves to _resolved_conflicts, and the quarter-final stage's
 *     "unverified" marker, which pointed at that conflict, is closed with the record.
 *     Any other winner difference stops the script.
 *   - Method: a contradicted category is corrected and its draft detail is NOT kept as
 *     method_detail (Georgieff vs Mandaloniz "punch", Speer vs Sotiropoulos
 *     "strikes"); the draft value stays only in corrections[].old and
 *     superseded_result_sources. Compatible detail survives, with its own secondary
 *     source, only where the commission category already agrees (method_normalization).
 *     Where the commission is more specific, its wording is canonical.
 *   - Times: every commission time; an added time where the draft had none.
 *   - Printed readings kept beside the normalized value: "choke out", "verbal tap
 *     out", "kumara" (result_text + source note), "0611/07" (date_printed),
 *     "Sotriopoulos" (result_text + source note).
 *   - TUF 6 page-3 note -> three commission-sourced timeline events, episode null.
 *
 * Unchanged: finals, identities, DOBs (the Hightower DOB difference is recorded in the
 * audit only), rosters, teams, episode placement, TUF 5 opening-round naming, the
 * other TUF 5 conflicts, and every other season.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const WRITE = process.argv.includes('--write');
const CHECK = process.argv.includes('--check');
const BATCH = 'tuf5-tuf6-nsac-reconciliation';
const REVIEWER = 'Justin Erickson';
const fail = (m) => { console.error(`STOP: ${m}`); process.exit(1); };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

const audit = readJson(path.join(ROOT, 'scripts', 'tuf', 'evidence', 'nsac_tuf5_tuf6_audit_2026-09-13.json'));

/* Approved decisions, keyed slug|a vs b|stage (stage separates the two Danzig vs Kolosci bouts). */
const WINNER = {
  'tuf-5|Brandon Melendez vs Gray Maynard|quarter_final': { old: 'Brandon Melendez', new: 'Gray Maynard' },
};
const METHOD = {
  'tuf-5|Corey Hill vs Rob Emerson|elimination': { kind: 'commission_correction', why: 'more_specific' },
  'tuf-5|Gray Maynard vs Wayne Weems|elimination': { kind: 'method_normalization', detail: 'punches', detail_quote: 'TKO (punches)' },
  'tuf-5|Joe Lauzon vs Cole Miller|quarter_final': { kind: 'method_normalization', detail: 'strikes', detail_quote: 'TKO (strikes)' },
  'tuf-6|Paul Georgieff vs Troy Mandaloniz|round_of_16': { kind: 'commission_correction', why: 'category' },
  'tuf-6|Tom Speer vs George Sotiropoulos|semi_final': { kind: 'commission_correction', why: 'category' },
  'tuf-6|Tom Speer vs Ben Saunders|quarter_final': { kind: 'commission_correction', why: 'decision_type' },
  'tuf-6|Tom Speer vs Jon Koppenhaver|round_of_16': { kind: 'commission_correction', why: 'more_specific' },
  'tuf-6|Matt Arroyo vs Troy Mandaloniz|quarter_final': { kind: 'commission_correction', why: 'more_specific' },
  'tuf-6|Blake Bowman vs Richie Hightower|round_of_16': { kind: 'method_normalization', detail: 'strikes', detail_quote: 'TKO (strikes)' },
  'tuf-6|Jared Rollins vs George Sotiropoulos|round_of_16': { kind: 'method_normalization', detail: 'strikes', detail_quote: 'TKO (strikes)' },
};
/* Printed readings the reviewer approved; carried on the bout's commission source. */
const READING = {
  'tuf-5|Matt Wiman vs Marlon Sims|elimination': 'the record prints "choke out ... rear naked choke"; read as Technical submission (rear naked choke) (approved reading)',
  'tuf-6|Matt Arroyo vs Troy Mandaloniz|quarter_final': 'the record prints "verbal tap out ... arm bar"; canonical method Submission (armbar); "verbal" is kept in the printed result text only (approved reading)',
  'tuf-6|Richie Hightower vs George Sotiropoulos|quarter_final': 'the record prints "kumara"; read as kimura (print defect, approved reading)',
  'tuf-6|Jared Rollins vs George Sotiropoulos|round_of_16': 'the result line prints the winner as "Sotriopoulos"; the record\'s own corner prints GEORGE SOTIROPOULOS, and the letters are the same name rearranged (print defect, approved reading)',
  'tuf-6|Mac Danzig vs Joe Scarola|round_of_16': 'the record prints the show date as "0611/07"; read as 2007-06-11 (print defect, approved reading; kept as date_printed)',
};
const AUDIT_ONLY_KEYS = ['winner_surname', 'weight_class', 'stage', 'rounds_printed', 'scores_printed', 'reading'];
const EXPECTED = {
  'tuf-5': { bouts: 14, winner_corrections: 1, method_corrections: 1, method_normalizations: 2, round_corrections: 0, time_corrections: 8, time_added: 0, classification_corrections: 0 },
  'tuf-6': { bouts: 14, winner_corrections: 0, method_corrections: 5, method_normalizations: 2, round_corrections: 0, time_corrections: 9, time_added: 1, classification_corrections: 1 },
};

const ledgerPath = path.join(DATA, 'commission_records.json');
const ledger = readJson(ledgerPath);
const report = {};
const seasonsOut = {};
const newDocs = [];
const newRecords = [];

for (const slug of ['tuf-5', 'tuf-6']) {
  const A = audit.seasons[slug];
  if (!A || A.summary.matched !== 14 || A.summary.unmatched || A.summary.ambiguous || A.summary.duplicate_use.length || A.summary.unused_records.length) fail(`${slug}: the audit does not show 14/14 deterministic matches`);
  const seasonPath = path.join(DATA, 'seasons', `${slug}.json`);
  const season = readJson(seasonPath);
  const draftSource = { family: 'wikipedia', evidence_level: 'secondary_draft', url: season._provenance.primary, retrieved: season._provenance.retrieved };

  /* ---- ledger document + records ---- */
  const D = A.document;
  const doc = {
    id: D.id, source_family: D.source_family, source_type: D.source_type, commission: D.commission, jurisdiction: D.jurisdiction,
    document: D.document, seasons: D.seasons, url: D.url, archive_url: D.archive_url, sha256: D.sha256, pages: D.pages, retrieved: D.retrieved,
    live_matches_archive: D.live_matches_archive, title_quote: D.title_quote, location: D.location, promoter: D.promoter, executive_director: D.executive_director,
    classification_language: D.classification_language, officials: D.officials, season_identity: D.season_identity,
  };
  const records = A.records.map((r) => {
    const out = Object.fromEntries(Object.entries(r).filter(([k]) => !AUDIT_ONLY_KEYS.includes(k)));
    const order = ['id', 'document_id', 'date', 'date_printed', 'stage_label', 'corners', 'bout', 'winner', 'result_text', 'method', 'round', 'time', 'scheduled_rounds', 'scorecards', 'referee', 'remarks'];
    const extra = Object.keys(out).filter((k) => !order.includes(k));
    if (extra.length) fail(`${r.id}: unexpected record keys ${extra.join(', ')}`);
    return Object.fromEntries(order.filter((k) => k in out).map((k) => [k, out[k]]));
  });
  if (records.length !== 14 || records.some((r) => !r.winner || !r.bout || !r.document_id || r.document_id !== doc.id)) fail(`${slug}: records incomplete`);
  newDocs.push(doc);
  newRecords.push(...records);

  const commission = (rec, extra = {}) => ({
    family: 'athletic_commission', source_type: 'commission_result_record', evidence_level: 'commission_record',
    jurisdiction: doc.jurisdiction, commission: doc.commission, document_id: doc.id, record_id: rec.id,
    url: doc.url, archive_url: doc.archive_url, sha256: doc.sha256, retrieved: doc.retrieved, ...extra,
  });

  const finalsBefore = JSON.stringify(season.bracket.map((wc) => wc.stages.find((s) => s.stage === 'final')));
  const idsBefore = JSON.stringify(season.bracket.flatMap((wc) => wc.stages.flatMap((s) => s.bouts.map((b) => [b.a, b.a_fighter_id ?? null, b.b, b.b_fighter_id ?? null, b.episode ?? null]))));
  const rostersBefore = JSON.stringify(season.teams ?? null);

  const tally = { bouts: 0, winner_corrections: 0, method_corrections: 0, method_normalizations: 0, round_corrections: 0, time_corrections: 0, time_added: 0, classification_corrections: 0 };
  const changes = [];
  const used = new Set();
  for (const wc of season.bracket) for (const st of wc.stages) for (const b of st.bouts) {
    if (b.on_finale_card) continue;
    const pair = `${b.a} vs ${b.b}`;
    const key = `${slug}|${pair}|${st.stage}`;
    const row = A.bouts.find((x) => x.bout === pair && x.weight_class === wc.weight_class && x.stage === st.stage);
    if (!row || row.match !== 'deterministic') fail(`${key}: not an audited deterministic match`);
    const rec = records.find((r) => r.id === row.record_id);
    if (!rec || used.has(rec.id)) fail(`${key}: record missing or reused`);
    used.add(rec.id);

    /* the state before this batch, recovered from its own history on a re-run */
    const mine = (b.corrections || []).filter((c) => c.batch === BATCH);
    const was = (field) => (mine.some((c) => c.field === field) ? mine.find((c) => c.field === field).old : b[field] ?? null);
    const draft = { winner: was('winner'), method: was('method'), round: was('round'), time: was('time'), classification: was('classification') };
    const priorClassificationSource = (b.classification_basis?.corroborating || []).find((x) => x.former_authority)?.quote ?? (mine.length || b.commission_record_id ? null : b.classification_source ?? null);

    const corrections = [];
    const src = { document_id: doc.id, record_id: rec.id };
    const base = { batch: BATCH, reviewer: REVIEWER };

    /* winner */
    if (draft.winner !== rec.winner) {
      const w = WINNER[key];
      if (!w || w.old !== draft.winner || w.new !== rec.winner) fail(`${key}: winner ${draft.winner} -> ${rec.winner} is not an approved correction`);
      corrections.push({ field: 'winner', kind: 'commission_correction', old: draft.winner, new: rec.winner, source: src,
        reason: `the commission record states "${rec.result_text}" (${rec.date}, "${rec.stage_label}"); ${rec.winner} won the quarter-final, which is why he fights Nate Diaz in the commission's semi-final. Method, round and time already agreed; only the winner was inverted in the draft`, ...base });
      tally.winner_corrections += 1;
    } else if (WINNER[key]) fail(`${key}: approved winner correction no longer applies`);

    /* method */
    delete b.method_detail;
    let methodDetail = null;
    if (draft.method !== rec.method) {
      const m = METHOD[key];
      if (!m) fail(`${key}: method ${draft.method} -> ${rec.method} has no approved decision`);
      if (m.kind === 'method_normalization') {
        corrections.push({ field: 'method', kind: 'method_normalization', old: draft.method, new: rec.method, detail: m.detail, source: src,
          reason: `the commission record prints the method as ${JSON.stringify(rec.method)} ("${rec.result_text}"), the same category as the draft but less specific; the official method takes the commission wording and the draft's compatible detail "${m.detail}" is kept as secondary detail with the draft as its source — the commission does not print it`, ...base });
        methodDetail = { value: m.detail, relation: 'compatible_detail', source: { ...draftSource, quote: m.detail_quote, note: 'secondary detail from the season draft; the commission record does not print it' } };
        tally.method_normalizations += 1;
      } else {
        const reason = m.why === 'more_specific'
          ? `the commission record states the method more specifically ("${rec.result_text}"); the commission's wording ${JSON.stringify(rec.method)} is canonical`
          : m.why === 'decision_type'
            ? `the commission record states a ${rec.method.replace(/^Decision \((.*)\)$/, '$1')} decision ("${rec.result_text}"), contradicting the draft's ${JSON.stringify(draft.method)}; a primary commission record overrides the draft`
            : `the commission record states ${JSON.stringify(rec.method)} ("${rec.result_text}"), a different category from the draft's ${JSON.stringify(draft.method)}; the commission category is canonical and the draft's detail is not carried forward, because the commission does not print it`;
        corrections.push({ field: 'method', kind: 'commission_correction', old: draft.method, new: rec.method, source: src, reason, ...base });
        tally.method_corrections += 1;
      }
    } else if (METHOD[key]) fail(`${key}: approved method decision no longer applies`);

    /* round */
    if (draft.round !== rec.round) {
      corrections.push({ field: 'round', kind: 'commission_correction', old: draft.round, new: rec.round, source: src, reason: `the commission record states round ${rec.round} ("${rec.result_text}")`, ...base });
      tally.round_corrections += 1;
    }
    /* time */
    if ((draft.time ?? null) !== (rec.time ?? null)) {
      if (rec.time == null) fail(`${key}: the commission prints no time; none is inferred`);
      corrections.push({ field: 'time', kind: 'commission_correction', old: draft.time ?? null, new: rec.time, source: src,
        reason: draft.time == null ? `the commission record states the time as ${JSON.stringify(rec.time)} ("${rec.result_text}"); the draft gave none, so it is added as a primary fact` : `the commission record states the time as ${JSON.stringify(rec.time)} ("${rec.result_text}"); a primary commission record overrides the draft's ${JSON.stringify(draft.time)}`,
        ...base });
      if (draft.time == null) tally.time_added += 1; else tally.time_corrections += 1;
    }
    /* classification */
    if (draft.classification !== 'exhibition') {
      corrections.push({ field: 'classification', kind: 'commission_correction', old: draft.classification, new: 'exhibition', source: src,
        reason: `the commission's Season ${slug.split('-')[1]} results record lists this bout under "${doc.classification_language.quote}"`, ...base });
      tally.classification_corrections += 1;
    }

    Object.assign(b, { winner: rec.winner, method: rec.method, round: rec.round, time: rec.time });
    b.corrections = [...(b.corrections || []).filter((x) => x.batch !== BATCH), ...corrections];
    if (!b.corrections.length) delete b.corrections;

    b.fight_date = rec.date;
    b.fight_date_source = src;
    b.superseded_result_sources = [{ ...draftSource, note: draft.winner !== rec.winner ? `season draft import; stated ${draft.winner} as the winner (${draft.method}, round ${draft.round}, ${draft.time}) before the commission record` : 'season draft import; stated this result before the commission record', ...(draft.method !== rec.method || draft.time !== rec.time ? { stated: { winner: draft.winner, method: draft.method, round: draft.round, time: draft.time } } : {}), superseded_by: rec.id }];
    b.result_sources = [commission(rec, { winner: rec.winner, quote: rec.result_text, ...(READING[key] ? { note: READING[key] } : {}) })];
    b.classification = 'exhibition';
    b.classification_basis = {
      affirmative: [commission(rec, { quote: doc.classification_language.quote, note: `listed under "${doc.classification_language.quote}" in the commission's Season ${slug.split('-')[1]} results record` })],
      corroborating: priorClassificationSource ? [{ kind: 'record_absence', family: 'our_records', evidence_level: 'corroboration_only', year: 2007, quote: priorClassificationSource, former_authority: true, superseded_by: rec.id, note: 'the former classification basis, kept as corroboration' }] : [],
      authority: 'affirmative',
      reopen_if: 'a later Nevada State Athletic Commission record contradicts this one',
    };
    b.classification_source = `exhibition: fought at the UFC Training Center on ${rec.date}${b.episode != null ? ` and aired in episode ${b.episode}` : '; not placed in an episode'}; the Nevada State Athletic Commission record lists it under "${doc.classification_language.quote}" (commission_record) — a commission-sanctioned exhibition, not a professional bout.${priorClassificationSource ? ' Absence from our complete 2007 records is corroboration only.' : ''}`;
    b.commission_record_id = rec.id;
    if (methodDetail) b.method_detail = methodDetail;
    tally.bouts += 1;
    if (corrections.length) changes.push({ bout: pair, stage: st.stage, record_id: rec.id, corrections: corrections.map((c) => ({ field: c.field, kind: c.kind, old: c.old, new: c.new })) });
  }
  if (!same(tally, EXPECTED[slug])) fail(`${slug}: applied ${JSON.stringify(tally)}, expected ${JSON.stringify(EXPECTED[slug])}`);

  /* ---- TUF 5: the quarter-final conflict the record resolves ---- */
  if (slug === 'tuf-5') {
    const rec = records.find((r) => r.id === 'nsac-2007-tuf5-09');
    const semi = records.find((r) => r.id === 'nsac-2007-tuf5-14');
    const open = (season._conflicts || []).find((c) => c.field === 'quarter_finals');
    const done = (season._resolved_conflicts || []).find((c) => c.field === 'quarter_finals' && c.resolved_by === BATCH);
    if (!open && !done) fail('tuf-5: the quarter_finals conflict is missing');
    const resolution = { resolved_by: BATCH, resolved_with: `${doc.commission}, ${doc.document} — record ${rec.id} (${rec.date}, "${rec.stage_label}") and ${semi.id} (${semi.date}, "${semi.stage_label}")`,
      resolution: `Not two contradictory results: the draft inverted the winner. The commission records "${rec.result_text}", then Maynard in the semi-final against Nate Diaz ("${semi.result_text}"). Winner corrected to Gray Maynard; method, round and time were already right.`, reviewer: REVIEWER };
    if (open) {
      season._conflicts = season._conflicts.filter((c) => c !== open);
      season._resolved_conflicts = [...(season._resolved_conflicts || []), { ...open, ...resolution }];
    } else Object.assign(done, resolution);
    const qf = season.bracket[0].stages.find((s) => s.stage === 'quarter_final');
    delete qf.status;
    qf.note = 'Closed against the Nevada State Athletic Commission record: all four quarter-finals are on it, and Gray Maynard beat Brandon Melendez before meeting Nate Diaz in the semi-finals.';
    qf.sources = [...(qf.sources || []).filter((s) => s.repair !== `${BATCH}/quarter_final`), { repair: `${BATCH}/quarter_final`, fields: ['status', 'note'], family: 'athletic_commission', evidence_level: 'commission_record', document_id: doc.id, record_id: rec.id, url: doc.url, retrieved: doc.retrieved, quote: rec.result_text }];
  }

  /* ---- TUF 6: the page-3 note, as commission-sourced timeline events (episode null) ---- */
  if (slug === 'tuf-6') {
    const note = A.document.printed_notes[0];
    if (note?.quote !== 'MATT ARROYO – Injured and could not compete in Semi-Finals. John Kolosci replaced him.') fail('tuf-6: the page-3 note is not the audited text');
    const semi = records.find((r) => r.id === 'nsac-2007-tuf6-13');
    const source = commission(semi, { quote: note.quote, note: 'printed on page 3 of the document above its semi-final table, outside any record row; it names no injury and no episode' });
    const events = [
      { id: 'tuf6-arroyo-injured', episode: null, type: 'injury', fighters: ['Matt Arroyo'], detail: 'Injured; the commission record names no injury.', sources: [source] },
      { id: 'tuf6-arroyo-out-of-semi-final', episode: null, type: 'withdrawal', fighters: ['Matt Arroyo'], detail: 'Could not compete in the semi-finals.', sources: [source] },
      { id: 'tuf6-kolosci-replaces-arroyo', episode: null, type: 'replacement', fighters: ['John Kolosci'], replaces: 'Matt Arroyo', detail: 'Replaced Matt Arroyo in the semi-finals.', sources: [source] },
    ];
    const ids = new Set(events.map((e) => e.id));
    season.timeline_events = [...(season.timeline_events || []).filter((e) => !ids.has(e.id)), ...events];
  }

  const readings = Object.entries(READING).filter(([k]) => k.startsWith(`${slug}|`)).map(([k, v]) => `${k.split('|')[1]}: ${v}`);
  const baseNote = String(season._provenance?.note ?? '').replace(/ House results, fight dates and classification are from the Nevada State Athletic Commission[\s\S]*$/, '');
  season._provenance = { ...season._provenance, note: `${baseNote} House results, fight dates and classification are from the Nevada State Athletic Commission's Season ${slug.split('-')[1]} results record (${BATCH}, reviewed by ${REVIEWER}). The draft's differing values are kept in each bout's corrections and superseded_result_sources; compatible method detail survives only where the commission category agrees.${readings.length ? ` Printed readings: ${readings.join('; ')}.` : ''}` };

  if (JSON.stringify(season.bracket.map((wc) => wc.stages.find((s) => s.stage === 'final'))) !== finalsBefore) fail(`${slug}: a final changed`);
  if (JSON.stringify(season.bracket.flatMap((wc) => wc.stages.flatMap((s) => s.bouts.map((b) => [b.a, b.a_fighter_id ?? null, b.b, b.b_fighter_id ?? null, b.episode ?? null])))) !== idsBefore) fail(`${slug}: an identity or episode changed`);
  if (JSON.stringify(season.teams ?? null) !== rostersBefore) fail(`${slug}: a roster changed`);

  seasonsOut[slug] = { path: seasonPath, season };
  report[slug] = { ...tally, changes };
}

ledger.documents = [...ledger.documents.filter((d) => !newDocs.some((n) => n.id === d.id)), ...newDocs];
ledger.records = [...ledger.records.filter((r) => !newDocs.some((n) => n.id === r.document_id)), ...newRecords];

/* The ledger is hand-formatted: splice this batch's entries into the text and
 * prove the result parses to exactly the ledger built above. */
function objectEnd(text, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  fail('unbalanced ledger text');
}
function splice(text) {
  for (const id of [...newDocs.map((d) => d.id), ...newRecords.map((r) => r.id)]) {
    const at = text.indexOf(`"id": ${JSON.stringify(id)}`);
    if (at < 0) continue;
    let s = text.lastIndexOf('{', at);
    const e = objectEnd(text, s);
    while (/\s/.test(text[s - 1])) s--;
    if (text[s - 1] === ',') s--;
    text = text.slice(0, s) + text.slice(e + 1);
  }
  const block = (o) => JSON.stringify(o, null, 2).split('\n').map((l) => `    ${l}`).join('\n');
  const docsClose = text.indexOf('\n  ],', text.indexOf('"documents": ['));
  text = `${text.slice(0, docsClose)},\n${newDocs.map(block).join(',\n')}${text.slice(docsClose)}`;
  const recsClose = text.lastIndexOf('\n  ]');
  return `${text.slice(0, recsClose)},\n${newRecords.map(block).join(',\n')}${text.slice(recsClose)}`;
}
const ledgerText = splice(fs.readFileSync(ledgerPath, 'utf8'));
if (!same(JSON.parse(ledgerText), ledger)) fail('spliced ledger text does not parse to the intended ledger');
const outputs = [...Object.values(seasonsOut).map(({ path: p, season }) => [p, JSON.stringify(season, null, 2) + '\n']), [ledgerPath, ledgerText]];

if (CHECK) {
  const stale = outputs.filter(([p, text]) => fs.readFileSync(p, 'utf8') !== text).map(([p]) => path.relative(ROOT, p));
  if (stale.length) { console.error(`not applied or not idempotent: ${stale.join(', ')}`); process.exit(1); }
  console.log(`idempotent: re-applying ${BATCH} changes nothing`);
  process.exit(0);
}
console.log(JSON.stringify({ batch: BATCH, reviewer: REVIEWER, ...report }, null, 1));
if (!WRITE) { console.log('(dry run — pass --write)'); process.exit(0); }
for (const [p, text] of outputs) fs.writeFileSync(p, text);
console.log('wrote web/data/tuf/seasons/tuf-5.json, web/data/tuf/seasons/tuf-6.json and web/data/tuf/commission_records.json');
