/* TUF 33 finale linkage, as applied from first-party UFC evidence
 * (scripts/tuf/apply_tuf33_finale_links.mjs). Tested against the exact verifier and
 * a read-only snapshot of every canonical bout involving a TUF 33 finalist. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBout } from './boutVerification.mjs';

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const snapshot = read('./fixtures/tuf33_finalist_bouts_2026-09-13.json');
const evidence = read('../evidence/tuf33_ufc_first_party_finale_evidence_2026-09-13.json');
const inventory = read('../../../web/data/tuf/seasons.json');
const row = inventory.seasons.find((s) => s.slug === 'tuf-33');
const season = read('../../../web/data/tuf/seasons/tuf-33.json');
const TODAY = '2026-09-13';
const WELTER = '94616427-2d11-4216-b248-bc57e3ab83e2';
const FLY = 'aa7c0491-43f3-4c90-a668-10ccbdc118ac';
const BATCH = 'tuf33-finals-exact-linkage';

const stage = (wc, st) => season.bracket.find((b) => b.weight_class === wc).stages.find((s) => s.stage === st).bouts.map((b) => ({ ...b, weight_class: wc, stage: st }));
const final = (wc) => stage(wc, 'final')[0];
const pairRows = (b) => Object.values(snapshot.bouts).filter((r) => [r.fighter_a_id, r.fighter_b_id].sort().join('|') === [b.a_fighter_id, b.b_fighter_id].sort().join('|'));
const verify = (b, seasonRow = row, rows = pairRows(b)) => verifyBout({ bout: b, seasonRow, episodes: null, pairRows: rows, today: TODAY });
const one = (v) => (Array.isArray(v) ? v[0] : v);

test('Matt Dixon is the welterweight semi-final opponent, not a finalist; Rodrigo Sezinando is the finalist', () => {
  const semi = stage('Welterweight', 'semi_final').find((b) => [b.a, b.b].includes('Matt Dixon'));
  assert.deepEqual([semi.a, semi.b, semi.winner], ['Daniil Donchenko', 'Matt Dixon', 'Daniil Donchenko']);
  const f = final('Welterweight');
  assert.deepEqual([f.a, f.b], ['Daniil Donchenko', 'Rodrigo Sezinando']);
  const inv = row.finalists.find((x) => x.weight_class === 'Welterweight');
  assert.deepEqual(inv.fighters, ['Daniil Donchenko', 'Rodrigo Sezinando']);
  assert.deepEqual(inv.fighter_ids, [f.a_fighter_id, f.b_fighter_id]);
  assert.ok(!row.finalists.some((x) => x.fighters.includes('Matt Dixon')));
  assert.ok(!row.final_bouts.some((x) => [x.a, x.b].includes('Matt Dixon')));
  const c = row.corrections.find((x) => x.field === 'finalists');
  assert.equal(c.repair, `${BATCH}/welterweight-finalists`);
  assert.deepEqual(c.old.find((x) => x.weight_class === 'Welterweight').fighters, ['Daniil Donchenko', 'Matt Dixon'], 'the draft value is kept');
  assert.ok(c.sources.some((x) => x.url === 'https://www.ufc.com/news/ultimate-fighter-season-33-episode-12-recap'));
});

test('each final carries the exact explicit bout link and resolves only to its own bout', () => {
  for (const [wc, id, event, date, winner] of [
    ['Flyweight', FLY, 'UFC 319: Du Plessis vs. Chimaev', '2025-08-16', 'Joseph Morales'],
    ['Welterweight', WELTER, 'UFC Fight Night: Lopes vs. Silva', '2025-09-13', 'Daniil Donchenko'],
  ]) {
    const f = final(wc);
    assert.equal(f.verified_against, `ufc_bouts:${id}`);
    assert.equal(f.ufc_bout_id, undefined, 'one explicit link, not two');
    const rows = pairRows(f);
    assert.equal(rows.length, 1, `${wc}: the only bout between the finalists`);
    const v = verify(f);
    assert.deepEqual([v.result, v.actualFinaleDbBout.id, v.actualFinaleDbBout.linked_by, v.actualFinaleDbBout.event, v.actualFinaleDbBout.date], ['verified', id, 'explicit_bout_id', event, date]);
    assert.equal(f.winner, winner);
    const fb = row.final_bouts.find((x) => x.weight_class === wc);
    assert.deepEqual([fb.ufc_bout_id, fb.verified_against, fb.event, fb.date, fb.winner], [id, `ufc_bouts:${id}`, event, date, winner]);
    assert.deepEqual(row.winners.find((w) => w.weight_class === wc), { weight_class: wc, fighter: winner, fighter_id: winner === f.a ? f.a_fighter_id : f.b_fighter_id });
  }
});

test('the evidence, snapshot and first-party result agree for both finals', () => {
  for (const [wc, ev] of Object.entries(evidence.finals)) {
    const snap = snapshot.bouts[ev.ufc_bout_id];
    const r = one(snap.result); const e = one(snap.event);
    assert.equal(e.name, ev.event); assert.equal(e.event_date, ev.event_date);
    assert.equal(`${Math.floor(r.time_sec / 60)}:${String(r.time_sec % 60).padStart(2, '0')}`, ev.time);
    for (const k of ev.designation_sources) assert.match(evidence.sources[k].url, /^https:\/\/www\.ufc\.com\//, `${wc}: first-party only`);
  }
  assert.match(evidence.sources.ufc319_weigh_in.quotes[0], /^TUF Flyweight Finale Bout: Alibi Idiris .* vs Joseph Morales/);
  assert.match(evidence.sources.noche_weigh_in.quotes[0], /^TUF Welterweight Finale Bout: Rodrigo Sezinando .* vs Daniil Donchenko/);
  assert.match(evidence.sources.ufc319_updates.quotes[0], /welterweight finale between Rodrigo Sezinando and Daniil Donchenko/);
  assert.ok(!JSON.stringify(evidence.sources).includes('paramountplus'), 'the Paramount+ listing is not an authority');
});

test('no later or other bout of a finalist can satisfy either final', () => {
  for (const wc of ['Flyweight', 'Welterweight']) {
    const f = { ...final(wc) };
    const own = f.verified_against.slice('ufc_bouts:'.length);
    const others = Object.values(snapshot.bouts).filter((b) => b.id !== own && [b.fighter_a_id, b.fighter_b_id].some((id) => [f.a_fighter_id, f.b_fighter_id].includes(id)));
    assert.ok(others.length >= 1, `${wc}: finalists have other professional bouts`);
    /* UFC also states the winner (an official source on the bout), so the result is
     * verified either way. The assertion is on the database LINK: no other bout may
     * ever become this final's finale row. */
    for (const o of others) {
      const v = verify({ ...f, verified_against: `ufc_bouts:${o.id}` }, row, [...pairRows(f), o]);
      assert.equal(v.actualFinaleDbBout, null, `${wc}: other bout ${o.id} is not linked`);
      assert.equal(v.dbFinaleVerified, false);
      assert.ok(!v.evidence.includes('finale_result_row'));
    }
    const rematch = { ...snapshot.bouts[own], id: 'later-rematch', event: { name: 'UFC Later Card', event_date: '2027-01-01' } };
    const unlinked = { ...f }; delete unlinked.verified_against;
    const vu = verify(unlinked, { ...row, final_bouts: [], finale_event: null, finale_date: null }, [...pairRows(f), rematch]);
    assert.equal(vu.actualFinaleDbBout, null, `${wc}: an unlinked rematch links nothing`);
    assert.equal(vu.dbFinaleVerified, false);
    assert.equal(verify(f, row, [rematch, ...pairRows(f)]).actualFinaleDbBout.id, own, `${wc}: the explicit link wins over a rematch`);
  }
});

test('conflicting explicit links fail closed', () => {
  const f = final('Welterweight');
  const v = verify({ ...f, ufc_bout_id: FLY });
  assert.equal(v.actualFinaleDbBout, null);
  assert.match(v.finaleLinkReason, /conflicting explicit bout links/);
  const crossed = verify({ ...f, verified_against: `ufc_bouts:${FLY}` }, row, [...pairRows(f), snapshot.bouts[FLY]]);
  assert.equal(crossed.actualFinaleDbBout, null, 'the other final\'s bout is not between these ids');
  assert.equal(crossed.dbFinaleVerified, false);
});

test('no fuzzy event-name rule: UFC.com branding and the broadcaster title do not match the canonical event name', () => {
  const f = { ...final('Welterweight') }; delete f.verified_against;
  const withEvent = (event) => ({ ...row, final_bouts: [{ weight_class: 'Welterweight', a: f.a, b: f.b, event, date: '2025-09-13' }] });
  assert.equal(verify(f, withEvent('UFC Fight Night: Lopes vs. Silva')).actualFinaleDbBout.id, WELTER, 'the exact canonical name still links');
  assert.equal(verify(f, withEvent('Noche UFC: Lopes vs Silva')).actualFinaleDbBout, null, 'UFC.com branding is not a name match');
  assert.equal(verify(f, withEvent('TUF 33 Finale: Lopes vs. Silva')).actualFinaleDbBout, null, 'the broadcaster title is not a name match');
  const norm = (p) => crypto.createHash('sha256').update(fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(norm('./boutVerification.mjs'), '108d8c143d285ee4e405514ebfc2920bcc0fa4617901c357473b6f0d5edf78d9', 'the exact verifier is unchanged from main 9415fea');
  assert.equal(norm('../completeness_matrix.mjs'), 'b267434b68f2ab5cec20c5840c425d97e72b8ab296e019ab8272018bcb3039b0', 'the matrix is unchanged from main 9415fea');
});

test('both finals are professional from the exact finale bout and UFC\'s designation; winners carry an official source', () => {
  for (const wc of ['Flyweight', 'Welterweight']) {
    const f = final(wc);
    assert.equal(f.classification, 'professional');
    assert.match(f.classification_source, /exact finale bout ufc_bouts/);
    assert.deepEqual(f.classification_basis.affirmative.map((x) => [x.family, x.evidence_level]), [['our_records', 'canonical'], ['ufc_com_event', 'official']]);
    const cls = f.corrections.find((c) => c.field === 'classification');
    assert.deepEqual([cls.old, cls.new, cls.repair], ['unverified', 'professional', `${BATCH}/${wc.toLowerCase()}-final/classification`]);
    const link = f.corrections.find((c) => c.field === 'verified_against');
    assert.deepEqual([link.old, link.repair], [null, `${BATCH}/${wc.toLowerCase()}-final/link`]);
    const ws = f.sources.find((s) => s.fields.includes('winner'));
    assert.ok(ws.repair.startsWith(BATCH) && /^https:\/\/www\.ufc\.com\//.test(ws.url));
  }
});

test('re-running the repair is idempotent', () => {
  const script = fileURLToPath(new URL('../apply_tuf33_finale_links.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test('matrix: only TUF 33 changes, FINAL_NOT_VERIFIED clears, and finals verified moves by exactly two', () => {
  const before = read('../evidence/tuf_completeness_2026-09-13.after_tuf5_tuf6_nsac.json');
  const after = read('../evidence/tuf_completeness_2026-09-13.after_tuf33_finale_links.json');
  const by = (m) => Object.fromEntries(m.seasons.map((s) => [s.slug, s]));
  const B = by(before), A = by(after);
  const changed = Object.keys(B).filter((k) => JSON.stringify(B[k]) !== JSON.stringify(A[k]));
  assert.deepEqual(changed, ['tuf-33'], 'TUF 24, TUF 5, TUF 6 and every other season unchanged');
  assert.ok(B['tuf-33'].blockers.includes('FINAL_NOT_VERIFIED'));
  for (const gone of ['FINAL_NOT_VERIFIED', 'WINNER_UNRESOLVED', 'PROFESSIONAL_FINAL_NOT_LINKED']) assert.ok(!A['tuf-33'].blockers.includes(gone), gone);
  assert.equal(after.totals.finals_verified - before.totals.finals_verified, 2);
  assert.notEqual(A['tuf-33'].status, 'COMPLETE', 'other TUF 33 blockers remain; nothing is claimed complete');
});
