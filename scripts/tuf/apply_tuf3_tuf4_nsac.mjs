#!/usr/bin/env node
/**
 * TUF 3 + TUF 4 — Nevada State Athletic Commission reconciliation. Approved 2026-09-13.
 *
 *   node scripts/tuf/apply_tuf3_tuf4_nsac.mjs [--write]
 *
 * Idempotent. No network, no database. Input: the audited transcriptions in
 * scripts/tuf/evidence/nsac_tuf3_tuf4_audit_2026-09-13.json (24/24 deterministic
 * matches, both documents' sha256 live = archive). The same generic path as TUF 1
 * and TUF 2 (scripts/tuf/apply_tuf1_nsac.mjs):
 *
 *   - Ledger: each document and its 12 records go into
 *     web/data/tuf/commission_records.json, spliced in so no other entry changes.
 *     Audit-only transcription keys are dropped; a misprinted date keeps its
 *     printed form in the generic `date_printed`.
 *   - Official result from the commission: winner (unchanged), method category,
 *     round, time, fight date. Draft values stay in `corrections`.
 *   - Method decisions (approved): where the commission's category contradicts the
 *     draft's, the commission wins and the draft's category label is not kept;
 *     a compatible mechanism or context the draft states survives as
 *     `method_detail` with its own secondary source ("punches", "head kick and
 *     punches", "rib injury" — never "verbal submission"). Where the commission is
 *     less specific ("TKO" beside "TKO (strikes)") it is a method normalization.
 *     Where the commission is more specific (a sudden-victory decision) its wording
 *     is the canonical method. No scorecards are invented.
 *   - Classification: the commission record is the affirmative basis; the former
 *     basis (absence from complete 2006 records) is kept as corroboration.
 *   - Unchanged: finals, identities, rosters, fighter DOBs (four printed DOBs that
 *     differ are recorded on the ledger documents only), episode placement, and
 *     the open bracket conflicts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const WRITE = process.argv.includes('--write');
const BATCH = 'tuf3-tuf4-nsac-reconciliation';
const fail = (m) => { console.error(`STOP: ${m}`); process.exit(1); };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

const audit = readJson(path.join(ROOT, 'scripts', 'tuf', 'evidence', 'nsac_tuf3_tuf4_audit_2026-09-13.json'));

/* Approved method decisions, keyed by bout. `detail` survives as method_detail;
 * `detail_quote` is the draft's own words for it. */
const METHOD = {
  'tuf-3|Kalib Starnes vs Mike Stine': { kind: 'commission_correction', detail: 'punches', detail_quote: 'KO (punches)' },
  'tuf-3|Solomon Hutcherson vs Rory Singer': { kind: 'commission_correction', detail: 'head kick and punches', detail_quote: 'KO (head kick and punches)' },
  'tuf-3|Kalib Starnes vs Kendall Grove': { kind: 'commission_correction', detail: 'rib injury', detail_quote: 'Kendall Grove defeated Kalib Starnes by verbal submission (rib injury) at 0:30 of the third round..', detail_note: 'the draft states the rib injury; the commission record prints only TKO and states no injury. The draft\'s "verbal submission" is contradicted by the commission category and is not kept.' },
  'tuf-3|Kristian Rothaermel vs Michael Bisping': { kind: 'method_normalization', detail: 'strikes', detail_quote: 'TKO (strikes)' },
  'tuf-4|Charles McCarthy vs Pete Sell': { kind: 'commission_correction' },
  'tuf-4|Gideon Ray vs Edwin DeWees': { kind: 'commission_correction' },
};
const AUDIT_ONLY_KEYS = ['winner_surname', 'weight_class', 'stage', 'rounds_printed', 'scorecard_order_printed'];
const EXPECTED = {
  'tuf-3': { bouts: 12, time_corrections: 9, method_corrections: 3, method_normalizations: 1, round_corrections: 0 },
  'tuf-4': { bouts: 12, time_corrections: 4, method_corrections: 2, method_normalizations: 0, round_corrections: 0 },
};

const ledgerPath = path.join(DATA, 'commission_records.json');
const ledger = readJson(ledgerPath);
const report = {};
const seasonsOut = {};
const newDocs = [];
const newRecords = [];

for (const slug of ['tuf-3', 'tuf-4']) {
  const A = audit.seasons[slug];
  if (!A || A.summary.matched !== 12 || A.summary.unmatched || A.summary.ambiguous || A.summary.duplicate_use.length) fail(`${slug}: the audit does not show 12/12 deterministic matches`);
  if (A.summary.differences.winner) fail(`${slug}: a winner discrepancy needs review, not a repair`);
  const seasonPath = path.join(DATA, 'seasons', `${slug}.json`);
  const season = readJson(seasonPath);
  const draftSource = { family: 'wikipedia', evidence_level: 'secondary_draft', url: season._provenance.primary, retrieved: season._provenance.retrieved };

  /* ---- ledger document + records ---- */
  const D = A.document;
  const idOf = (name) => {
    for (const wc of season.bracket) for (const st of wc.stages) for (const b of st.bouts) {
      if (b.a === name) return b.a_fighter_id ?? null;
      if (b.b === name) return b.b_fighter_id ?? null;
    }
    return null;
  };
  const doc = {
    id: D.id, source_family: D.source_family, source_type: D.source_type, commission: D.commission, jurisdiction: D.jurisdiction,
    document: D.document, seasons: D.seasons, url: D.url, archive_url: D.archive_url, sha256: D.sha256, pages: D.pages, retrieved: D.retrieved,
    live_matches_archive: D.live_matches_archive, title_quote: D.title_quote, location: D.location, promoter: D.promoter, executive_director: D.executive_director,
    classification_language: D.classification_language, officials: D.officials, season_identity: D.season_identity,
    identity_disagreements: A.dates_of_birth.filter((x) => x.state === 'identity_disagreement').map((x) => ({
      fighter: x.fighter, fighter_id: idOf(x.fighter), field: 'dob', printed: x.printed, canonical: x.canonical,
      record_ids: A.records.filter((r) => [r.bout.a, r.bout.b].includes(x.fighter)).map((r) => r.id), action: 'recorded_only',
    })),
  };
  if (doc.identity_disagreements.some((x) => !x.fighter_id)) fail(`${slug}: a DOB disagreement has no canonical fighter id`);
  const records = A.records.map((r) => {
    const out = Object.fromEntries(Object.entries(r).filter(([k]) => !AUDIT_ONLY_KEYS.includes(k)));
    const order = ['id', 'document_id', 'date', 'date_printed', 'stage_label', 'corners', 'bout', 'winner', 'result_text', 'method', 'round', 'time', 'scheduled_rounds', 'scorecards', 'referee', 'remarks'];
    const extra = Object.keys(out).filter((k) => !order.includes(k));
    if (extra.length) fail(`${r.id}: unexpected record keys ${extra.join(', ')}`);
    return Object.fromEntries(order.filter((k) => k in out).map((k) => [k, out[k]]));
  });
  if (records.length !== 12 || records.some((r) => !r.winner || !r.bout)) fail(`${slug}: records incomplete`);
  newDocs.push(doc);
  newRecords.push(...records);

  /* ---- house bouts ---- */
  const commission = (rec, extra = {}) => ({
    family: 'athletic_commission', source_type: 'commission_result_record', evidence_level: 'commission_record',
    jurisdiction: doc.jurisdiction, commission: doc.commission, document_id: doc.id, record_id: rec.id,
    url: doc.url, archive_url: doc.archive_url, sha256: doc.sha256, retrieved: doc.retrieved, ...extra,
  });
  const finalsBefore = JSON.stringify(season.bracket.map((wc) => wc.stages.find((s) => s.stage === 'final')));
  const conflictsBefore = JSON.stringify(season._conflicts);
  const idsBefore = JSON.stringify(season.bracket.flatMap((wc) => wc.stages.flatMap((s) => s.bouts.map((b) => [b.a, b.a_fighter_id, b.b, b.b_fighter_id]))));
  const rostersBefore = JSON.stringify(season.teams ?? null);
  const stagesBefore = JSON.stringify(season.bracket.map((wc) => wc.stages.map((s) => [s.stage, s.status ?? null, s.note ?? null])));

  const tally = { bouts: 0, time_corrections: 0, method_corrections: 0, method_normalizations: 0, round_corrections: 0 };
  const used = new Set();
  for (const wc of season.bracket) for (const st of wc.stages) for (const b of st.bouts) {
    if (b.on_finale_card) continue;
    const key = `${b.a} vs ${b.b}`;
    const row = A.bouts.find((x) => x.bout === key && x.weight_class === wc.weight_class && x.stage === st.stage);
    if (!row || row.match !== 'deterministic') fail(`${slug} ${key}: not an audited deterministic match`);
    const rec = records.find((r) => r.id === row.record_id);
    if (!rec || used.has(rec.id)) fail(`${slug} ${key}: record missing or reused`);
    used.add(rec.id);
    if (rec.winner !== b.winner) fail(`${slug} ${key}: commission winner ${rec.winner} differs from ${b.winner}`);

    /* the state before this batch, recovered from its own history on a re-run */
    const mine = (b.corrections || []).filter((c) => c.batch === BATCH);
    const was = (field) => (mine.some((c) => c.field === field) ? mine.find((c) => c.field === field).old : b[field] ?? null);
    const draft = { method: was('method'), round: was('round'), time: was('time') };
    const priorClassificationSource = b.classification_basis?.corroborating?.find((x) => x.former_authority)?.quote ?? b.classification_source;

    const corrections = [];
    const reason = (field, value) => `the commission record states ${field} as ${JSON.stringify(value)} ("${rec.result_text}"); a primary commission record overrides the Wikipedia draft`;
    delete b.method_detail;
    if (draft.method !== rec.method) {
      const decision = METHOD[`${slug}|${key}`];
      if (!decision) fail(`${slug} ${key}: method ${draft.method} -> ${rec.method} has no approved decision`);
      if (decision.kind === 'method_normalization') {
        corrections.push({ field: 'method', kind: 'method_normalization', old: draft.method, new: rec.method, detail: decision.detail, source: { document_id: doc.id, record_id: rec.id },
          reason: `the commission record prints the method as ${JSON.stringify(rec.method)} ("${rec.result_text}"), less specific than the draft; the official method takes the commission wording and the draft's compatible detail "${decision.detail}" is kept as secondary detail, not shown to be wrong`, batch: BATCH });
        tally.method_normalizations += 1;
      } else {
        const more = rec.method.startsWith(`${draft.method.replace(/\)$/, '')}`) || /sudden victory/i.test(rec.method);
        corrections.push({ field: 'method', kind: 'commission_correction', old: draft.method, new: rec.method, source: { document_id: doc.id, record_id: rec.id },
          reason: more && /sudden victory/i.test(rec.method)
            ? `the commission record states the decision came in the sudden victory round ("${rec.result_text}"); the commission's wording is the canonical method`
            : `${reason('method', rec.method)}; the draft's category is contradicted and not kept${decision.detail ? `, and its compatible detail "${decision.detail}" is kept as secondary detail` : ''}`,
          batch: BATCH });
        tally.method_corrections += 1;
      }
      if (decision.detail) {
        b.method_detail = { value: decision.detail, relation: 'compatible_detail', source: { ...draftSource, quote: decision.detail_quote, note: decision.detail_note ?? 'secondary detail; the commission record does not print it' } };
      }
    }
    if (draft.round !== rec.round) {
      corrections.push({ field: 'round', kind: 'commission_correction', old: draft.round, new: rec.round, source: { document_id: doc.id, record_id: rec.id }, reason: reason('round', rec.round), batch: BATCH });
      tally.round_corrections += 1;
    }
    if ((draft.time ?? null) !== (rec.time ?? null)) {
      corrections.push({ field: 'time', kind: 'commission_correction', old: draft.time ?? null, new: rec.time, source: { document_id: doc.id, record_id: rec.id },
        reason: draft.time == null ? `the commission record states the time as ${JSON.stringify(rec.time)} ("${rec.result_text}"); the draft gave none` : reason('time', rec.time), batch: BATCH });
      tally.time_corrections += 1;
    }
    Object.assign(b, { method: rec.method, round: rec.round, time: rec.time });
    b.corrections = [...(b.corrections || []).filter((x) => x.batch !== BATCH), ...corrections];
    if (!b.corrections.length) delete b.corrections;

    b.fight_date = rec.date;
    b.fight_date_source = { document_id: doc.id, record_id: rec.id };
    b.superseded_result_sources = [{ ...draftSource, note: 'season draft import; stated this result before the commission record', superseded_by: rec.id }];
    b.result_sources = [commission(rec, { winner: rec.winner, quote: rec.result_text })];
    b.classification = 'exhibition';
    b.classification_basis = {
      affirmative: [commission(rec, { quote: doc.classification_language.quote, note: `listed under "${doc.classification_language.quote}" in the commission's ${slug.replace('tuf-', 'Season ')} results record` })],
      corroborating: [{ kind: 'record_absence', family: 'our_records', evidence_level: 'corroboration_only', year: 2006, quote: priorClassificationSource, former_authority: true, superseded_by: rec.id, note: 'the former classification basis, kept as corroboration' }],
      authority: 'affirmative',
      reopen_if: 'a later Nevada State Athletic Commission record contradicts this one',
    };
    b.classification_source = `exhibition: fought at the UFC Training Center on ${rec.date} and aired in episode ${b.episode}; the Nevada State Athletic Commission record lists it under "${doc.classification_language.quote}" (commission_record) — a commission-sanctioned exhibition, not a professional bout. Absence from our complete 2006 records is corroboration only.`;
    b.commission_record_id = rec.id;
    tally.bouts += 1;
  }
  if (!same(tally, EXPECTED[slug])) fail(`${slug}: applied ${JSON.stringify(tally)}, expected ${JSON.stringify(EXPECTED[slug])}`);

  const misprints = records.filter((r) => r.date_printed).map((r) => `${r.bout.a} vs ${r.bout.b} prints its show date as "${r.date_printed}" (the separator between day and year is missing); it is read as ${r.date} and the printed form is kept as date_printed`);
  const baseNote = String(season._provenance?.note ?? '').replace(/ House results, fight dates and classification are from the Nevada State Athletic Commission[\s\S]*$/, '');
  season._provenance = { ...season._provenance, note: `${baseNote} House results, fight dates and classification are from the Nevada State Athletic Commission's ${slug.replace('tuf-', 'Season ')} results record (${BATCH}). The draft's differing values are kept in each bout's corrections; its compatible method detail is kept as secondary detail.${misprints.length ? ` ${misprints.join('; ')}.` : ''}` };

  if (JSON.stringify(season.bracket.map((wc) => wc.stages.find((s) => s.stage === 'final'))) !== finalsBefore) fail(`${slug}: a final changed`);
  if (JSON.stringify(season._conflicts) !== conflictsBefore) fail(`${slug}: the conflicts changed`);
  if (JSON.stringify(season.bracket.flatMap((wc) => wc.stages.flatMap((s) => s.bouts.map((b) => [b.a, b.a_fighter_id, b.b, b.b_fighter_id])))) !== idsBefore) fail(`${slug}: an identity changed`);
  if (JSON.stringify(season.teams ?? null) !== rostersBefore) fail(`${slug}: a roster changed`);
  if (JSON.stringify(season.bracket.map((wc) => wc.stages.map((s) => [s.stage, s.status ?? null, s.note ?? null]))) !== stagesBefore) fail(`${slug}: a stage status changed`);

  seasonsOut[slug] = { path: seasonPath, season };
  report[slug] = { ...tally, dob_disagreements_recorded: doc.identity_disagreements.map((x) => x.fighter), date_printed: records.filter((r) => r.date_printed).map((r) => [r.id, r.date, r.date_printed]) };
}

ledger.documents = [...ledger.documents.filter((d) => !newDocs.some((n) => n.id === d.id)), ...newDocs];
ledger.records = [...ledger.records.filter((r) => !newDocs.some((n) => n.id === r.document_id)), ...newRecords];

console.log(JSON.stringify({ batch: BATCH, ...report }, null, 1));
if (!WRITE) { console.log('(dry run — pass --write)'); process.exit(0); }

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
for (const { path: p, season } of Object.values(seasonsOut)) fs.writeFileSync(p, JSON.stringify(season, null, 2) + '\n');
fs.writeFileSync(ledgerPath, ledgerText);
console.log('wrote web/data/tuf/seasons/tuf-3.json, web/data/tuf/seasons/tuf-4.json and web/data/tuf/commission_records.json');
