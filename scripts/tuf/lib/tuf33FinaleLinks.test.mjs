/* TUF 33 finale linkage: the held proposals, tested against the exact verifier and a
 * read-only snapshot of every canonical bout involving a TUF 33 finalist. Nothing here
 * applies a link; each test works on an in-memory copy of the season data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyBout } from './boutVerification.mjs';

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const snapshot = read('./fixtures/tuf33_finalist_bouts_2026-09-13.json');
const proposal = read('../evidence/tuf33_finale_link_proposal_2026-09-13.json');
const simulation = read('../evidence/tuf33_finale_links_matrix_simulation_2026-09-13.json');
const inventory = read('../../../web/data/tuf/seasons.json');
const row = inventory.seasons.find((s) => s.slug === 'tuf-33');
const season = () => read('../../../web/data/tuf/seasons/tuf-33.json');
const TODAY = '2026-09-13';
const WELTER = '94616427-2d11-4216-b248-bc57e3ab83e2';
const FLY = 'aa7c0491-43f3-4c90-a668-10ccbdc118ac';

const finalsOf = (s) => s.bracket.flatMap((wc) => wc.stages.filter((st) => st.stage === 'final').flatMap((st) => st.bouts.map((b) => ({ ...b, weight_class: wc.weight_class, stage: 'final' }))));
const pairRows = (b) => Object.values(snapshot.bouts).filter((r) => [r.fighter_a_id, r.fighter_b_id].sort().join('|') === [b.a_fighter_id, b.b_fighter_id].sort().join('|'));
const verify = (b, seasonRow = row, rows = pairRows(b)) => verifyBout({ bout: b, seasonRow, episodes: null, pairRows: rows, today: TODAY });
const withLinks = (divisions) => {
  const s = season();
  for (const rec of proposal.records.filter((r) => divisions.includes(r.final.weight_class))) {
    const b = s.bracket.find((wc) => wc.weight_class === rec.final.weight_class).stages.find((st) => st.stage === 'final').bouts.find((x) => x.a === rec.final.a && x.b === rec.final.b);
    b.verified_against = rec.new;
  }
  return finalsOf(s);
};

test('TUF 33 today: both finals are unverified for want of an exact link, and the proposal is not applied', () => {
  const finals = finalsOf(season());
  assert.equal(finals.length, 2);
  for (const f of finals) {
    const v = verify(f);
    assert.equal(v.result, 'partial', `${f.a} vs ${f.b}`);
    assert.equal(v.actualFinaleDbBout, null);
    assert.match(v.finaleLinkReason, /no explicit bout link and no recorded finale date or event/);
    assert.equal(f.verified_against, undefined, 'no link written to the season');
    assert.equal(f.ufc_bout_id, undefined);
  }
  assert.equal(pairRows(finals.find((f) => f.weight_class === 'Welterweight')).length, 1, 'exactly one canonical bout between the welterweight finalists');
  assert.equal(pairRows(finals.find((f) => f.weight_class === 'Flyweight')).length, 1, 'exactly one canonical bout between the flyweight finalists');
});

test('the proposal holds both records: neither final has an exact finale-event record', () => {
  assert.deepEqual(proposal.records.map((r) => [r.final.weight_class, r.status, r.new]), [['Welterweight', 'held', `ufc_bouts:${WELTER}`], ['Flyweight', 'held', `ufc_bouts:${FLY}`]]);
  assert.match(proposal.records[0].hold_reason, /NOT PROVEN EXACTLY/);
  assert.match(proposal.records[1].hold_reason, /CONTRADICTED/);
  for (const r of proposal.records) {
    assert.ok(r.repair_key && r.field === 'verified_against' && r.old === null && r.canonical_bout && r.finale_link_provenance, r.repair_key);
    assert.deepEqual([...r.canonical_bout.fighter_ids].sort(), [...Object.values(snapshot.bouts).find((b) => b.id === r.canonical_bout.ufc_bout_id) ? [snapshot.bouts[r.canonical_bout.ufc_bout_id].fighter_a_id, snapshot.bouts[r.canonical_bout.ufc_bout_id].fighter_b_id] : []].sort());
  }
});

test('each proposed explicit link resolves exactly its own final and verifies no other', () => {
  const welterOnly = withLinks(['Welterweight']);
  const w = welterOnly.find((f) => f.weight_class === 'Welterweight'), fl = welterOnly.find((f) => f.weight_class === 'Flyweight');
  const vw = verify(w), vf = verify(fl);
  assert.deepEqual([vw.result, vw.actualFinaleDbBout.id, vw.actualFinaleDbBout.linked_by], ['verified', WELTER, 'explicit_bout_id']);
  assert.equal(vf.result, 'partial', 'linking the welterweight final does not verify the flyweight final');
  const both = withLinks(['Welterweight', 'Flyweight']);
  assert.deepEqual(both.map((f) => verify(f).actualFinaleDbBout.id).sort(), [FLY, WELTER].sort());
  /* a link pointed at the other final's bout is not between these ids: fail closed */
  const crossed = { ...w, verified_against: `ufc_bouts:${FLY}` };
  assert.equal(verify(crossed, row, [...pairRows(w), snapshot.bouts[FLY]]).actualFinaleDbBout, null);
});

test('no later or other bout of a finalist can satisfy a final', () => {
  const [w] = withLinks([]).filter((f) => f.weight_class === 'Welterweight');
  /* every other canonical bout of either finalist, pointed at by an explicit link */
  const others = Object.values(snapshot.bouts).filter((b) => b.id !== WELTER && [b.fighter_a_id, b.fighter_b_id].some((id) => [w.a_fighter_id, w.b_fighter_id].includes(id)));
  assert.ok(others.length >= 3, 'the finalists have later professional bouts');
  for (const o of others) assert.equal(verify({ ...w, verified_against: `ufc_bouts:${o.id}` }, row, [...pairRows(w), o]).result, 'partial', `other bout ${o.id}`);
  /* a hypothetical later rematch with the same winner, unlinked, verifies nothing */
  const rematch = { ...snapshot.bouts[WELTER], id: 'later-rematch', event: { name: 'UFC Later Card', event_date: '2027-01-01' } };
  assert.equal(verify(w, row, [...pairRows(w), rematch]).result, 'partial');
  /* with the explicit link, only the linked bout counts even when a rematch exists */
  assert.equal(verify({ ...w, verified_against: `ufc_bouts:${WELTER}` }, row, [rematch, ...pairRows(w)]).actualFinaleDbBout.id, WELTER);
});

test('exact event + date + pair fallback still works, and the broadcaster headline alone does not', () => {
  const [w] = withLinks([]).filter((f) => f.weight_class === 'Welterweight');
  const exact = { ...row, final_bouts: [{ weight_class: 'Welterweight', a: w.a, b: w.b, event: 'UFC Fight Night: Lopes vs. Silva', date: '2025-09-13' }] };
  const v = verify(w, exact);
  assert.deepEqual([v.result, v.actualFinaleDbBout.id, v.actualFinaleDbBout.linked_by], ['verified', WELTER, 'recorded_finale_event_date_pair']);
  const listingTitle = { ...row, final_bouts: [{ weight_class: 'Welterweight', a: w.a, b: w.b, event: 'TUF 33 Finale: Lopes vs. Silva', date: '2025-09-13' }] };
  assert.equal(verify(w, listingTitle).actualFinaleDbBout, null, 'a headline correspondence is not an exact event');
  const listingDate = { ...row, final_bouts: [{ weight_class: 'Welterweight', a: w.a, b: w.b, event: 'UFC Fight Night: Lopes vs. Silva', date: '2026-05-25' }] };
  assert.equal(verify(w, listingDate).actualFinaleDbBout, null, 'the broadcaster listing date is not the fight date');
  /* the flyweight bout is not on the only finale card any source names */
  const [fl] = withLinks([]).filter((f) => f.weight_class === 'Flyweight');
  assert.equal(verify(fl, { ...row, finale_event: 'UFC Fight Night: Lopes vs. Silva', finale_date: '2025-09-13' }).actualFinaleDbBout, null);
});

test('recorded explicit bout ids take precedence, and conflicting explicit links fail closed', () => {
  const [w] = withLinks(['Welterweight']).filter((f) => f.weight_class === 'Welterweight');
  const misleading = { ...row, final_bouts: [{ weight_class: 'Welterweight', a: w.a, b: w.b, event: 'Some Other Card', date: '2025-01-01' }] };
  assert.equal(verify(w, misleading).actualFinaleDbBout.id, WELTER, 'the explicit link wins over a recorded event');
  const conflicting = { ...w, ufc_bout_id: 'ffffffff-0000-0000-0000-000000000000' };
  const v = verify(conflicting);
  assert.equal(v.actualFinaleDbBout, null);
  assert.match(v.finaleLinkReason, /conflicting explicit bout links/);
});

test('simulation: only TUF 33 changes, finals verified moves only by the applied links, hub unchanged', () => {
  assert.equal(simulation.before_equals_committed_main_matrix, true);
  const before = simulation.states.before;
  for (const [name, st] of Object.entries(simulation.states)) {
    assert.deepEqual(st.other_seasons_changed_vs_before, [], `${name}: no other season changes (TUF 1-32, 24, 34, international, TUF 5/6 included)`);
    assert.equal(st.totals.finals_verified - before.totals.finals_verified, st.applied.length, `${name}: finals verified change equals applied links`);
    assert.equal(st.totals.finale_links_verified, before.totals.finale_links_verified, `${name}: professional finale links unchanged (classification still unverified)`);
    assert.deepEqual(st.hub_cards, { Complete: 42, 'Complete + Verified': 1, 'Season ongoing': 1 }, `${name}: hub cards`);
    assert.equal(st.tuf33.status, 'PARTIAL');
  }
  assert.equal(before.tuf33.final_not_verified, true);
  assert.equal(simulation.states.welterweight.tuf33.final_not_verified, true, 'one link does not clear FINAL_NOT_VERIFIED');
  assert.equal(simulation.states.both.tuf33.final_not_verified, false);
});
