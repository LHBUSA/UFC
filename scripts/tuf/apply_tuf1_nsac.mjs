#!/usr/bin/env node
/**
 * TUF 1 — Nevada State Athletic Commission reconciliation. Approved 2026-09-13.
 *
 *   node scripts/tuf/apply_tuf1_nsac.mjs [--write]
 *
 * Idempotent. No network, no database. Input: the transcription and document
 * facts in scripts/tuf/evidence/tuf1_nsac_audit_2026-09-13.json (audited: 10/10
 * deterministic matches, sha256 live = archive).
 *
 *   - The commission record is canonical for each house bout's official result:
 *     winner (unchanged), official method category, round, time, fight date and
 *     the exhibition classification. It goes into the generic commission ledger
 *     (web/data/tuf/commission_records.json) exactly as TUF 2's did.
 *   - A value the record contradicts is replaced; the draft value stays in
 *     `corrections` (kind commission_correction).
 *   - Where the record states the method less specifically than the draft
 *     ("TKO" beside "TKO (doctor stoppage)"), the canonical method becomes the
 *     record's wording and the draft's compatible detail moves to
 *     `method_detail` with its own secondary source (kind method_normalization).
 *     The detail is never presented as part of the verified result.
 *   - The Wikipedia result sources move to `superseded_result_sources` (history).
 *     ESPN's 2020 retrospective and the 2004 record absence stay attached as
 *     corroboration; nothing is deleted.
 *   - Unchanged: finals, identities, fighter DOBs (two printed DOBs that differ
 *     are recorded on the ledger document only), episode placement and air
 *     dates, and the open Josh Rafferty episode-placement conflict.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
const WRITE = process.argv.includes('--write');
const BATCH = 'tuf1-nsac-reconciliation';
const APPLIED = '2026-09-13';
const fail = (m) => { console.error(`STOP: ${m}`); process.exit(1); };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const surname = (s) => fold(String(s).trim().split(/\s+/).pop());
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

const audit = readJson(path.join(ROOT, 'scripts', 'tuf', 'evidence', 'tuf1_nsac_audit_2026-09-13.json'));
if (audit.summary.matched !== 10 || audit.summary.unmatched || audit.summary.ambiguous) fail('the audit does not show 10/10 deterministic matches');
if (audit.summary.discrepancies.winner) fail('the audit shows a winner discrepancy — that needs review, not a repair');

/* ---- 1. the ledger: document + 10 records --------------------------------- */
const ledgerPath = path.join(DATA, 'commission_records.json');
const ledger = readJson(ledgerPath);
const A = audit.document;
const seasonPath = path.join(DATA, 'seasons', 'tuf-1.json');
const season = readJson(seasonPath);
const idOf = (name) => {
  for (const wc of season.bracket) for (const st of wc.stages) for (const b of st.bouts) {
    if (b.a === name) return b.a_fighter_id;
    if (b.b === name) return b.b_fighter_id;
  }
  return null;
};
const doc = {
  id: A.id, source_family: A.source_family, source_type: A.source_type, commission: A.commission, jurisdiction: A.jurisdiction,
  document: A.document, seasons: A.seasons, url: A.url, archive_url: A.archive_url, sha256: A.sha256, pages: A.pages, retrieved: A.retrieved,
  live_matches_archive: A.live_matches_archive, title_quote: A.title_quote, location: A.location, promoter: A.promoter,
  executive_director: A.executive_director,
  classification_language: { quote: A.classification_language.quote, where: A.classification_language.where },
  officials: A.officials,
  season_identity: A.season_identity,
  identity_disagreements: audit.dates_of_birth.filter((d) => !d.agrees).map((d) => ({
    fighter: d.fighter, fighter_id: idOf(d.fighter), field: 'dob', printed: d.printed[0], canonical: d.canonical,
    record_ids: audit.records.filter((r) => [r.bout.a, r.bout.b].includes(d.fighter)).map((r) => r.id), action: 'recorded_only',
  })),
};
if (doc.identity_disagreements.some((x) => !x.fighter_id)) fail('a DOB disagreement has no canonical fighter id');
const records = audit.records;
if (records.length !== 10) fail(`expected 10 records, found ${records.length}`);
ledger.documents = [...ledger.documents.filter((d) => d.id !== doc.id), doc];
ledger.records = [...ledger.records.filter((r) => r.document_id !== doc.id), ...records];

/* ---- 2. house bouts -------------------------------------------------------- */
const commission = (rec, extra = {}) => ({
  family: 'athletic_commission', source_type: 'commission_result_record', evidence_level: 'commission_record',
  jurisdiction: doc.jurisdiction, commission: doc.commission, document_id: doc.id, record_id: rec.id,
  url: doc.url, archive_url: doc.archive_url, sha256: doc.sha256, retrieved: doc.retrieved, ...extra,
});
const base = (m) => String(m ?? '').replace(/\s*\(.*\)$/, '');
const paren = (m) => (String(m ?? '').match(/\((.*)\)$/) || [])[1] ?? null;
/* The draft method adds detail the record does not print, without contradicting it. */
function compatibleDetail(draft, official) {
  if (!draft || draft === official) return null;
  if (base(draft) === official && paren(draft)) return paren(draft);                       // "TKO (doctor stoppage)" under "TKO"
  if (base(draft) === base(official) && paren(official) && paren(draft)
    && fold(paren(draft)).endsWith(fold(paren(official)))) return paren(draft);             // "Submission (triangle armbar)" under "Submission (armbar)"
  return undefined;                                                                           // a contradiction
}

const finalsBefore = JSON.stringify(season.bracket.map((wc) => wc.stages.find((s) => s.stage === 'final')));
const conflictsBefore = JSON.stringify(season._conflicts);
const idsBefore = JSON.stringify(season.bracket.flatMap((wc) => wc.stages.flatMap((s) => s.bouts.map((b) => [b.a, b.a_fighter_id, b.b, b.b_fighter_id]))));
const teamsBefore = JSON.stringify(season.teams);

const tally = { bouts: 0, time_corrections: 0, method_corrections: 0, method_normalizations: 0, round_corrections: 0 };
const used = new Set();
for (const wc of season.bracket) for (const st of wc.stages) for (const b of st.bouts) {
  if (b.on_finale_card) continue;
  const matches = records.filter((r) => r.bout.weight_class === wc.weight_class && r.bout.stage === st.stage
    && [surname(b.a), surname(b.b)].sort().join('|') === r.corners.map((x) => surname(x.printed)).sort().join('|'));
  if (matches.length !== 1) fail(`${b.a} vs ${b.b}: ${matches.length} commission records`);
  const rec = matches[0];
  if (used.has(rec.id)) fail(`${rec.id} matched twice`);
  used.add(rec.id);
  if (fold(rec.winner) !== fold(b.winner)) fail(`${b.a} vs ${b.b}: commission winner ${rec.winner} differs from ${b.winner}`);

  /* State before this batch, recovered from the batch's own history on a re-run. */
  const mine = (b.corrections || []).filter((c) => c.batch === BATCH);
  const was = (field) => (mine.find((c) => c.field === field) ? mine.find((c) => c.field === field).old : b[field]);
  const draft = { method: was('method'), round: was('round'), time: was('time') };
  const priorResultSources = b.superseded_result_sources ?? b.result_sources ?? [];
  const priorBasis = b.classification_basis?.affirmative?.some((s) => s.family === 'athletic_commission')
    ? { affirmative: b.classification_basis.corroborating.filter((s) => s.former_authority).map(({ former_authority, superseded_by, ...s }) => s), corroborating: b.classification_basis.corroborating.filter((s) => !s.former_authority) }
    : b.classification_basis;
  if (priorResultSources.some((s) => s.family !== 'wikipedia')) fail(`${b.a} vs ${b.b}: unexpected prior result source`);
  const wikiResult = priorResultSources.find((s) => s.family === 'wikipedia');

  const corrections = [];
  const reason = (field, value) => `the commission record states ${field} as ${JSON.stringify(value)} ("${rec.result_text}"); a primary commission record overrides the Wikipedia draft`;
  /* method */
  delete b.method_detail;
  if (draft.method !== rec.method) {
    const detail = compatibleDetail(draft.method, rec.method);
    if (detail) {
      corrections.push({ field: 'method', kind: 'method_normalization', old: draft.method, new: rec.method, detail, source: { document_id: doc.id, record_id: rec.id },
        reason: `the commission record prints the method as ${JSON.stringify(rec.method)} ("${rec.result_text}"), less specific than the draft; the official method takes the commission wording and the draft's compatible detail "${detail}" is kept as secondary detail, not shown to be wrong`, batch: BATCH });
      b.method_detail = { value: detail, relation: 'compatible_detail', source: { ...wikiResult, note: 'secondary detail; the commission record does not print it' } };
      tally.method_normalizations += 1;
    } else {
      corrections.push({ field: 'method', kind: 'commission_correction', old: draft.method, new: rec.method, source: { document_id: doc.id, record_id: rec.id }, reason: reason('method', rec.method), batch: BATCH });
      tally.method_corrections += 1;
    }
  }
  if (draft.round !== rec.round) {
    corrections.push({ field: 'round', kind: 'commission_correction', old: draft.round, new: rec.round, source: { document_id: doc.id, record_id: rec.id }, reason: reason('round', rec.round), batch: BATCH });
    tally.round_corrections += 1;
  }
  if ((draft.time ?? null) !== (rec.time ?? null)) {
    corrections.push({ field: 'time', kind: 'commission_correction', old: draft.time ?? null, new: rec.time, source: { document_id: doc.id, record_id: rec.id }, reason: reason('time', rec.time), batch: BATCH });
    tally.time_corrections += 1;
  }
  Object.assign(b, { method: rec.method, round: rec.round, time: rec.time });
  b.corrections = [...(b.corrections || []).filter((c) => c.batch !== BATCH), ...corrections];
  if (!b.corrections.length) delete b.corrections;

  b.fight_date = rec.date;
  b.fight_date_source = { document_id: doc.id, record_id: rec.id };
  b.superseded_result_sources = priorResultSources.map((s) => ({ ...s, superseded_by: rec.id }));
  b.result_sources = [commission(rec, { winner: rec.winner, quote: rec.result_text })];
  b.classification = 'exhibition';
  b.classification_basis = {
    affirmative: [commission(rec, { quote: doc.classification_language.quote, note: `listed in the commission's "${doc.classification_language.quote}" record` })],
    corroborating: [
      ...priorBasis.affirmative.map((s) => ({ ...s, former_authority: true, superseded_by: rec.id })),
      ...priorBasis.corroborating,
    ],
    authority: 'affirmative',
    reopen_if: 'a later Nevada State Athletic Commission record contradicts this one',
  };
  b.classification_source = `exhibition: fought at the UFC Training Center on ${rec.date} and aired in episode ${b.episode}; the Nevada State Athletic Commission record lists it under "${doc.classification_language.quote}" (commission_record) — a commission-sanctioned exhibition, not a professional bout. ESPN's 2020 retrospective and absence from our complete 2004 records are corroboration only.`;
  b.commission_record_id = rec.id;
  tally.bouts += 1;
}
if (tally.bouts !== 10 || used.size !== 10) fail(`applied ${tally.bouts} bouts from ${used.size} records`);

/* ---- 3. overview: the house fight window, apart from the broadcast ------- */
const sorted = [...records].sort((x, y) => x.date.localeCompare(y.date));
const fmt = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
season.overview = {
  ...season.overview,
  fight_window: {
    start: sorted[0].date, end: sorted.at(-1).date, value: `${fmt(sorted[0].date)} – ${fmt(sorted.at(-1).date)}, 2004`,
    basis: 'house fight dates in the Nevada State Athletic Commission record',
    sources: [commission(sorted[0], { quote: 'DATE OF SHOW: 10/01/04', note: 'first house bout' }), commission(sorted.at(-1), { quote: 'DATE OF SHOW: 11/03/04', note: 'last house bout' })],
  },
};
const baseNote = String(season._provenance?.note ?? '').replace(/ House results, fight dates and classification are from the Nevada State Athletic Commission[^.]*\.[^.]*\.$/, '');
season._provenance = { ...season._provenance, note: `${baseNote} House results, fight dates and classification are from the Nevada State Athletic Commission's Season 1 results record (${BATCH}). The draft's differing values are kept in each bout's corrections; its compatible extra method detail is kept as secondary detail.`.trim() };

/* ---- 4. guarantees --------------------------------------------------------- */
if (JSON.stringify(season.bracket.map((wc) => wc.stages.find((s) => s.stage === 'final'))) !== finalsBefore) fail('a final changed');
if (JSON.stringify(season._conflicts) !== conflictsBefore) fail('the conflicts changed');
if (JSON.stringify(season.bracket.flatMap((wc) => wc.stages.flatMap((s) => s.bouts.map((b) => [b.a, b.a_fighter_id, b.b, b.b_fighter_id])))) !== idsBefore) fail('an identity changed');
if (JSON.stringify(season.teams) !== teamsBefore) fail('a roster changed');

console.log(JSON.stringify({ batch: BATCH, ...tally, dob_disagreements_recorded: doc.identity_disagreements.map((x) => x.fighter), fight_window: season.overview.fight_window.value }, null, 1));
if (!WRITE) { console.log('(dry run — pass --write)'); process.exit(0); }
fs.writeFileSync(seasonPath, JSON.stringify(season, null, 2) + '\n');
/* The ledger is hand-formatted. Splice this document's entries into the text
 * rather than re-serializing the file, so other seasons' entries are untouched,
 * then prove the result parses to exactly the ledger built above. */
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
  for (const id of [doc.id, ...records.map((r) => r.id)]) {
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
  text = `${text.slice(0, docsClose)},\n${block(doc)}${text.slice(docsClose)}`;
  const recsClose = text.lastIndexOf('\n  ]');
  return `${text.slice(0, recsClose)},\n${records.map(block).join(',\n')}${text.slice(recsClose)}`;
}
const ledgerText = splice(fs.readFileSync(ledgerPath, 'utf8'));
if (!same(JSON.parse(ledgerText), ledger)) fail('spliced ledger text does not parse to the intended ledger');
fs.writeFileSync(ledgerPath, ledgerText);
console.log('wrote web/data/tuf/seasons/tuf-1.json and web/data/tuf/commission_records.json');
