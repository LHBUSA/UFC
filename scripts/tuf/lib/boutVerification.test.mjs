/* Result verification must be tied to the bout itself: a professional fight
 * between the same two fighters at another time never verifies a TUF bout. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyBout, actualFinaleDbBout } from './boutVerification.mjs';

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const row = (id, date, name, winner, extra = {}) => ({ id, status: winner === undefined ? 'scheduled' : 'complete', fighter_a_id: A, fighter_b_id: B, event: { name, event_date: date }, result: winner === undefined ? null : { winner_id: winner }, ...extra });
const house = (extra = {}) => ({ a: 'Nate Diaz', b: 'Gray Maynard', winner: 'Nate Diaz', a_fighter_id: A, b_fighter_id: B, weight_class: 'Lightweight', stage: 'semi_final', classification: 'exhibition', ...extra });
const final = (extra = {}) => ({ a: 'Forrest Griffin', b: 'Stephan Bonnar', winner: 'Forrest Griffin', a_fighter_id: A, b_fighter_id: B, weight_class: 'Light Heavyweight', stage: 'final', on_finale_card: true, classification: 'professional', ...extra });
const seasonRow = { slug: 'tuf-x', finale_date: '2005-04-09', finale_event: 'The Ultimate Fighter Finale', winners: [], final_bouts: [{ weight_class: 'Light Heavyweight', a: 'Forrest Griffin', b: 'Stephan Bonnar', event: 'The Ultimate Fighter Finale', date: '2005-04-09' }] };
const TODAY = '2026-09-13';
const run = (bout, pairRows, extra = {}) => verifyBout({ bout, seasonRow, episodes: null, pairRows, today: TODAY, ...extra });

test('1. a later professional rematch with the same winner does not verify a house bout', () => {
  const v = run(house(), [row('pro-2013', '2013-11-30', 'TUF 18 Finale', A)]);
  assert.equal(v.result, 'partial');
  assert.equal(v.dbFinaleVerified, false);
  assert.equal(v.actualFinaleDbBout, null);
  assert.deepEqual(v.evidence, []);
  assert.equal(v.dbPairMatches.length, 1, 'the rematch is still listed');
  assert.equal(v.dbPairMatches[0].winner_matches_archive, true);
  assert.equal(v.dbPairMatches[0].is_linked_finale, false);
});

test('1b. an earlier professional bout with the same winner does not verify a house bout either', () => {
  assert.equal(run(house(), [row('pro-2001', '2001-05-04', 'UFC 31', A)]).result, 'partial');
});

test('1c. a house bout marked on no finale card never links, even to a bout on the finale date', () => {
  const v = run(house(), [row('finale-card-bout', '2005-04-09', 'The Ultimate Fighter Finale', A)]);
  assert.equal(v.result, 'partial');
  assert.equal(v.actualFinaleDbBout, null);
});

test('2. a later professional rematch with the opposite winner does not affect a house result', () => {
  const v = run(house(), [row('pro-2010', '2010-01-11', 'UFC Fight Night', B)]);
  assert.equal(v.result, 'partial');
  assert.equal(v.dbPairMatches[0].winner_matches_archive, false);
});

test('3. the exact finale ufc_bout_id verifies the professional final', () => {
  const v = run(final({ ufc_bout_id: 'finale-1' }), [row('finale-1', '2005-04-09', 'The Ultimate Fighter Finale', A)]);
  assert.equal(v.result, 'verified');
  assert.equal(v.dbFinaleVerified, true);
  assert.equal(v.actualFinaleDbBout.linked_by, 'explicit_bout_id');
  assert.deepEqual(v.evidence, ['finale_result_row']);
});

test('3b. without ufc_bout_id, the recorded finale date + event + pair identifies the final', () => {
  const v = run(final(), [row('finale-1', '2005-04-09', 'The Ultimate Fighter Finale', A)]);
  assert.equal(v.result, 'verified');
  assert.equal(v.actualFinaleDbBout.linked_by, 'recorded_finale_event_date_pair');
});

test('3c. an exact finale row that names the other fighter does not verify the archive winner', () => {
  assert.equal(run(final({ ufc_bout_id: 'finale-1' }), [row('finale-1', '2005-04-09', 'The Ultimate Fighter Finale', B)]).result, 'partial');
});

test('4. with several professional bouts between the pair, only the exact linked finale can verify', () => {
  const rematch = row('ufc-62', '2006-08-26', 'UFC 62', A);
  const finaleOpposite = row('finale-1', '2005-04-09', 'The Ultimate Fighter Finale', B);
  /* finale result disagrees; the rematch agrees — not verified */
  let v = run(final({ ufc_bout_id: 'finale-1' }), [rematch, finaleOpposite]);
  assert.equal(v.result, 'partial');
  assert.equal(v.actualFinaleDbBout.id, 'finale-1');
  v = run(final(), [rematch, finaleOpposite]);
  assert.equal(v.result, 'partial');
  /* ufc_bout_id pointing at a bout that is not in the pair rows: fail closed, never fall back */
  v = run(final({ ufc_bout_id: 'somewhere-else' }), [rematch, row('finale-1', '2005-04-09', 'The Ultimate Fighter Finale', A)]);
  assert.equal(v.result, 'partial');
  assert.equal(v.actualFinaleDbBout, null);
  /* no recorded finale date and no id: the rematch cannot stand in */
  v = verifyBout({ bout: final(), seasonRow: { winners: [], final_bouts: [] }, episodes: null, pairRows: [rematch], today: TODAY });
  assert.equal(v.result, 'partial');
  assert.match(v.finaleLinkReason, /no recorded finale date or event/);
  /* fight_date disagreeing with the recorded finale date: fail closed */
  v = run(final({ fight_date: '2006-08-26' }), [rematch, row('finale-1', '2005-04-09', 'The Ultimate Fighter Finale', A)]);
  assert.equal(v.actualFinaleDbBout, null);
  /* two rows on the recorded date (a data defect): ambiguous, fail closed */
  v = run(final(), [row('dup-1', '2005-04-09', 'The Ultimate Fighter Finale', A), row('dup-2', '2005-04-09', 'The Ultimate Fighter Finale', A)]);
  assert.equal(v.actualFinaleDbBout, null);
  /* a same-date row at a different event name: not the recorded finale */
  v = run(final(), [row('other-card', '2005-04-09', 'Some Other Card', A)]);
  assert.equal(v.actualFinaleDbBout, null);
});

test('4d. a recorded verified_against "ufc_bouts:<uuid>" is an explicit link, never overridden by the fallback', () => {
  const onDate = row('finale-1', '2005-04-09', 'The Ultimate Fighter Finale', A);
  const LINKED = 'aaaaaaaa-1111-2222-3333-444444444444';
  let v = run(final({ verified_against: `ufc_bouts:${LINKED}` }), [onDate, row(LINKED, '2005-04-09', 'The Ultimate Fighter Finale', A)]);
  assert.equal(v.actualFinaleDbBout.id, LINKED);
  assert.equal(v.actualFinaleDbBout.linked_by, 'explicit_bout_id');
  /* the recorded link is not among the pair rows: fail closed although a date+event candidate exists */
  v = run(final({ verified_against: 'ufc_bouts:bbbbbbbb-1111-2222-3333-444444444444' }), [onDate]);
  assert.equal(v.actualFinaleDbBout, null);
  assert.equal(v.result, 'partial');
  /* free-text verified_against is not a link; the fallback applies */
  assert.equal(run(final({ verified_against: 'ufc_bouts + ufc_bout_results' }), [onDate]).actualFinaleDbBout.linked_by, 'recorded_finale_event_date_pair');
  /* explicit links that disagree: fail closed */
  v = run(final({ ufc_bout_id: 'finale-1', verified_against: 'ufc_bouts:bbbbbbbb-1111-2222-3333-444444444444' }), [onDate]);
  assert.equal(v.actualFinaleDbBout, null);
  assert.match(v.finaleLinkReason, /conflicting explicit bout links/);
});

test('4e. the fallback needs a recorded event matched exactly; only the tournament final on the finale card links', () => {
  const onDate = row('finale-1', '2005-04-09', 'The Ultimate Fighter Finale', A);
  let v = verifyBout({ bout: final(), seasonRow: { winners: [], finale_date: '2005-04-09', final_bouts: [] }, episodes: null, pairRows: [onDate], today: TODAY });
  assert.equal(v.actualFinaleDbBout, null);
  assert.match(v.finaleLinkReason, /no recorded finale event/);
  assert.equal(run(final(), [row('finale-1', '2005-04-09', 'The Ultimate Fighter: Finale', A)]).actualFinaleDbBout, null, 'near-miss event name');
  v = run(final({ stage: 'semi_final' }), [onDate]);
  assert.equal(v.actualFinaleDbBout, null);
  assert.equal(v.result, 'partial');
});

test('4b. classification repair needs the exact finale bout, never a rematch', () => {
  const unverified = final({ classification: 'unverified' });
  assert.equal(run(unverified, [row('ufc-62', '2006-08-26', 'UFC 62', A)]).classificationRepairable, false);
  assert.equal(run(unverified, [row('finale-1', '2005-04-09', 'The Ultimate Fighter Finale', A)]).classificationRepairable, true);
  assert.equal(run(house({ classification: 'unverified' }), [row('ufc-62', '2006-08-26', 'UFC 62', A)]).classificationRepairable, false);
});

test('4c. a scheduled final is scheduled only through its own announced bout', () => {
  const open = final({ winner: null, ufc_bout_id: 'announced' });
  assert.equal(run(open, [row('announced', '2026-09-26', 'TUF Finale', undefined)]).result, 'scheduled');
  assert.equal(run(final({ winner: null }), [row('rematch-later', '2026-12-01', 'Other card', undefined)]).result, 'unknown');
});

test('5. a commission-backed house bout remains verified', () => {
  const bout = house({ result_sources: [{ family: 'athletic_commission', source_type: 'commission_result_record', evidence_level: 'commission_record', document_id: 'nsac-doc', record_id: 'nsac-rec', winner: 'Nate Diaz' }] });
  const v = run(bout, [row('pro-2010', '2010-01-11', 'UFC Fight Night', B)]);
  assert.equal(v.result, 'verified');
  assert.deepEqual(v.evidence, ['commission_record']);
});

test('6. an official-repair-backed house bout remains verified', () => {
  const v = run(house({ sources: [{ repair: 'r1', fields: ['winner'], url: 'https://www.ufc.com/news/x', family: 'ufc_com', retrieved: '2026-09-12', quote: 'Diaz won' }] }), []);
  assert.equal(v.result, 'verified');
  assert.deepEqual(v.evidence, ['official_repair']);
  /* a non-Wikipedia source covering the winner that is not an applied repair does not verify */
  assert.equal(run(house({ sources: [{ fields: ['winner'], url: 'https://www.ufc.com/news/x', family: 'ufc_com', retrieved: '2026-09-12', quote: 'Diaz won' }] }), []).result, 'partial');
  /* a Wikipedia source covering the winner is not an official repair */
  assert.equal(run(house({ sources: [{ repair: 'r2', fields: ['winner'], url: 'https://en.wikipedia.org/x', family: 'wikipedia', retrieved: '2026-09-12', quote: 'x' }] }), []).result, 'partial');
});

test('7. an official-recap-backed house bout remains verified; a contradicted recap does not verify', () => {
  const episodes = (result) => ({ episodes: [{ episode_number: 3, bouts: [{ a: 'Gray Maynard', b: 'Nate Diaz', result }] }] });
  assert.equal(verifyBout({ bout: house(), seasonRow, episodes: episodes({ winner: 'Nate Diaz' }), pairRows: [], today: TODAY }).result, 'verified');
  assert.deepEqual(verifyBout({ bout: house(), seasonRow, episodes: episodes({ winner: 'Nate Diaz' }), pairRows: [], today: TODAY }).evidence, ['official_recap']);
  assert.equal(verifyBout({ bout: house(), seasonRow, episodes: episodes({ winner: 'Nate Diaz', contradiction: 'x' }), pairRows: [], today: TODAY }).result, 'partial');
  assert.equal(verifyBout({ bout: house(), seasonRow, episodes: episodes({ winner: 'Gray Maynard' }), pairRows: [], today: TODAY }).result, 'partial');
});

test('8. TUF 1-4: every bout keeps its verification under the exact rule, from its own evidence', () => {
  const inventory = read('../../../web/data/tuf/seasons.json');
  const fixture = read('./fixtures/tuf1_4_db_pair_rows_2026-09-13.json');
  const expectedFinale = {
    'tuf-1|Light Heavyweight': '65856c98-1421-4859-8e62-4eb651fdc221', // not the UFC 62 rematch
    'tuf-4|Welterweight': 'ba067d26-0058-4b30-b6a4-7e76044a060a', // not the UFC 119 rematch
  };
  let house_ = 0, finals = 0;
  for (const slug of ['tuf-1', 'tuf-2', 'tuf-3', 'tuf-4']) {
    const season = read(`../../../web/data/tuf/seasons/${slug}.json`);
    const sRow = inventory.seasons.find((s) => s.slug === slug);
    let episodes = null;
    try { episodes = read(`../../../web/data/tuf/episodes/${slug}.json`); } catch { /* none */ }
    for (const wc of season.bracket) for (const st of wc.stages) for (const b of st.bouts) {
      const bout = { ...b, weight_class: wc.weight_class, stage: st.stage };
      const key = [b.a_fighter_id, b.b_fighter_id].sort().join('|');
      const pairRows = b.a_fighter_id && b.b_fighter_id ? fixture.pairs[key] || [] : [];
      const v = verifyBout({ bout, seasonRow: sRow, episodes, pairRows, today: TODAY });
      assert.equal(v.result, 'verified', `${slug} ${b.a} vs ${b.b}: ${v.result}`);
      if (b.on_finale_card) {
        finals += 1;
        assert.equal(v.dbFinaleVerified, true, `${slug} ${b.a} vs ${b.b}: final not linked (${v.finaleLinkReason})`);
        const want = expectedFinale[`${slug}|${wc.weight_class}`];
        if (want) assert.equal(v.actualFinaleDbBout.id, want);
      } else {
        house_ += 1;
        assert.ok(v.evidence.length && !v.evidence.includes('finale_result_row'), `${slug} ${b.a} vs ${b.b}: house bout verified by ${v.evidence}`);
        /* the house result stands without any database row at all */
        assert.equal(verifyBout({ bout, seasonRow: sRow, episodes, pairRows: [], today: TODAY }).result, 'verified');
      }
    }
  }
  assert.equal(finals, 8);
  assert.equal(house_, 46);
});

test('8b. the TUF 1 Griffin vs Bonnar final links to the finale, never to the UFC 62 rematch', () => {
  const fixture = read('./fixtures/tuf1_4_db_pair_rows_2026-09-13.json');
  const inventory = read('../../../web/data/tuf/seasons.json');
  const season = read('../../../web/data/tuf/seasons/tuf-1.json');
  const wc = season.bracket.find((x) => x.weight_class === 'Light Heavyweight');
  const b = wc.stages.find((s) => s.stage === 'final').bouts[0];
  const rows = fixture.pairs[[b.a_fighter_id, b.b_fighter_id].sort().join('|')];
  assert.equal(rows.length, 2);
  const withoutId = { ...b, ufc_bout_id: undefined, weight_class: wc.weight_class, stage: 'final' };
  const hit = actualFinaleDbBout(withoutId, inventory.seasons.find((s) => s.slug === 'tuf-1'), rows);
  assert.equal(hit.row.id, '65856c98-1421-4859-8e62-4eb651fdc221');
  assert.equal(hit.linked_by, 'recorded_finale_event_date_pair');
});
