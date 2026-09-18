/* nextBout() reads EFFECTIVE bout truth (public.ufc_bouts_effective, migration 031), never ufc_bouts.status.
 *
 * ufc_bouts.status is not rewritten when a bout leaves a card (migration 029), so the old read
 * (`ufc_bouts ... status=neq.cancelled`) told the newsroom Brian Ortega was booked against Renato Moicano for
 * three days after the official card dropped the fight.
 *
 * The fake below is a PostgREST stand-in over rows shaped exactly like the view's output for each rule case
 * (the SQL proof, supabase/migrations/tests/20260918120000_ufc_bouts_effective.test.sql, asserts the view
 * produces these columns for these situations). It honours the filters the code sends, so a read that forgets
 * `is_active` or goes back to the raw table fails here.   Run: node --test test/ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextBout, NEXT_BOUT_SOURCE } from '../src/packet.mjs';

const TODAY = '2026-09-18';
const ORTEGA = 'f-ortega', MOICANO = 'f-moicano', NOLAN = 'f-nolan', ALLEN = 'f-allen', PICO = 'f-pico', VAN = 'f-van', PANTOJA = 'f-pantoja', X = 'f-x', Y = 'f-y';
const NAMES = { [ORTEGA]: 'Brian Ortega', [MOICANO]: 'Renato Moicano', [NOLAN]: 'Tom Nolan', [ALLEN]: 'Arnold Allen', [PICO]: 'Aaron Pico', [VAN]: 'Joshua Van', [PANTOJA]: 'Alexandre Pantoja', [X]: 'Fighter X', [Y]: 'Fighter Y' };
const ev = (id, name, date) => ({ id, name, event_date: date, venue: 'Arena', city: 'City', country: 'USA' });
const E331 = ev('e-331', 'UFC 331: Van vs. Pantoja 2', '2026-09-19'), E333 = ev('e-333', 'UFC 333: Volkanovski vs. Evloev', '2026-10-24');
const EHALLOWEEN = ev('e-1031', 'UFC Fight Night', '2026-10-31'), ETONIGHT = ev('e-today', 'UFC Fight Night: Tonight', TODAY), EINC = ev('e-inc', 'UFC 340', '2026-11-14');

const row = (id, a, b, event, over = {}) => ({
  id, event_id: event.id, fighter_a_id: a, fighter_b_id: b, weight_class: 'LIGHTWEIGHT', is_title: false, is_womens: false, scheduled_rounds: 3, card_position: 'main',
  stored_status: 'announced', effective_status: 'announced', is_active: true, is_settled: false, withdrawal_reported: false, withdrawn_fighter_id: null,
  removal_reported_at: null, official_card_present: true, official_card_state: 'confirmed', reason: null, source_receipt_count: 0, event, ...over,
});
/* What the view returns for each situation. */
const VIEW = [
  /* UFC 331 Moicano vs Ortega: stored announced, the newest COMPLETE official card no longer lists it */
  row('b-removed', MOICANO, ORTEGA, E331, { effective_status: 'cancelled', is_active: false, official_card_present: false, official_card_state: 'missing', withdrawn_fighter_id: ORTEGA, reason: 'injury', source_receipt_count: 7, removal_reported_at: '2026-09-14T20:16:13Z' }),
  /* Moicano was rebooked */
  row('b-rebooked', MOICANO, NOLAN, EHALLOWEEN),
  /* UFC 333 Allen vs Pico: withdrawal reported, official card still lists it */
  row('b-warned', ALLEN, PICO, E333, { withdrawal_reported: true, withdrawn_fighter_id: ALLEN, source_receipt_count: 2, removal_reported_at: '2026-09-18T11:39:08Z' }),
  /* a bout already fought on a card dated today, and one settled by a result while still stored as announced */
  row('b-fought', VAN, PANTOJA, ETONIGHT, { stored_status: 'complete', effective_status: 'complete', is_settled: true }),
  row('b-fought-result-only', VAN, X, ETONIGHT, { is_settled: true }),
  /* the newest official read is INCOMPLETE (an older complete read lacked the bout): ambiguous, removes nobody */
  row('b-incomplete-read', X, Y, EINC, { official_card_present: null, official_card_state: 'incomplete' }),
];

function fakeSb(view = VIEW) {
  const calls = [];
  return {
    calls,
    async select(table, query) {
      calls.push({ table, query });
      if (table === 'ufc_fighters') { const id = /id=eq\.([^&]+)/.exec(query)?.[1]; return NAMES[id] ? [{ id, name: NAMES[id] }] : []; }
      if (table !== 'ufc_bouts_effective') throw new Error(`nextBout read ${table}: bout truth must come from ufc_bouts_effective`);
      const p = new URLSearchParams(query);
      const ids = [...(p.get('or') || '').matchAll(/fighter_[ab]_id\.eq\.([^,)]+)/g)].map((m) => m[1]);
      let rows = view.filter((r) => ids.includes(r.fighter_a_id) || ids.includes(r.fighter_b_id));
      for (const col of ['is_active', 'is_settled']) {
        const f = p.get(col);
        if (f === 'is.true') rows = rows.filter((r) => r[col] === true);
        if (f === 'is.false') rows = rows.filter((r) => r[col] === false);
      }
      /* PostgREST aliasing: `status:effective_status` */
      return rows.map((r) => ({ ...r, status: r.effective_status }));
    },
  };
}

test('Moicano vs Ortega is never described as an upcoming bout', async () => {
  assert.equal(await nextBout(fakeSb(), ORTEGA, TODAY), null, 'Ortega has no upcoming bout');
  const moicano = await nextBout(fakeSb(), MOICANO, TODAY);
  assert.deepEqual([moicano.bout_id, moicano.opponent, moicano.event.date], ['b-rebooked', 'Tom Nolan', '2026-10-31'], 'the removed bout is skipped even though it is EARLIER than the real one');
  assert.notEqual(moicano.opponent, 'Brian Ortega');
});

test('Allen vs Pico stays upcoming while officially listed, and carries the withdrawal warning', async () => {
  for (const [me, opp] of [[ALLEN, 'Aaron Pico'], [PICO, 'Arnold Allen']]) {
    const n = await nextBout(fakeSb(), me, TODAY);
    assert.deepEqual([n.bout_id, n.opponent, n.status], ['b-warned', opp, 'announced']);
    assert.deepEqual(n.card_truth, { stored_status: 'announced', withdrawal_reported: true, withdrawn_fighter_id: ALLEN, withdrawal_reported_at: '2026-09-18T11:39:08Z', official_card_present: true, reason: null, source_receipt_count: 2 });
  }
  /* a bout nobody reported against carries no warning, and no reason is ever synthesised */
  const clean = await nextBout(fakeSb(), MOICANO, TODAY);
  assert.deepEqual([clean.card_truth.withdrawal_reported, clean.card_truth.reason], [false, null]);
});

test('fought bouts remain historical: a settled bout is never the next bout, even on a card dated today', async () => {
  assert.equal(await nextBout(fakeSb(), PANTOJA, TODAY), null, 'stored complete');
  assert.equal(await nextBout(fakeSb(), VAN, TODAY), null, 'settled by a stored result while the row still says announced');
});

test('an incomplete official-card observation removes nobody', async () => {
  const n = await nextBout(fakeSb(), X, TODAY);
  assert.deepEqual([n.bout_id, n.opponent, n.status, n.card_truth.official_card_present], ['b-incomplete-read', 'Fighter Y', 'announced', null]);
});

test('the read itself: the effective view, filtered in SQL, never the stored status', async () => {
  const sb = fakeSb();
  await nextBout(sb, ORTEGA, TODAY);
  const q = sb.calls.find((c) => c.table === NEXT_BOUT_SOURCE);
  assert.equal(NEXT_BOUT_SOURCE, 'ufc_bouts_effective');
  assert.ok(q, 'reads the view');
  assert.match(q.query, /[?&]is_active=is\.true(&|$)/);
  assert.match(q.query, /[?&]is_settled=is\.false(&|$)/);
  assert.match(q.query, /status:effective_status/);
  assert.doesNotMatch(q.query, /status=neq|[,=]status,|[,=]status&/, 'no bare status column: the view has none');
  /* and if the filters were dropped, this fixture WOULD return the removed bout: the fake has teeth */
  const leaky = fakeSb(VIEW.map((r) => ({ ...r, is_active: true, is_settled: false })));
  assert.equal((await nextBout(leaky, ORTEGA, TODAY)).opponent, 'Renato Moicano');
});
