/* ESPN official-scorecard reader.
 *
 * The rules worth protecting here are the ones that would fail silently and
 * plausibly: a card joined by display order instead of by official.$ref reads
 * perfectly right up until ESPN returns the two competitors' linescores in
 * different orders, and a placeholder official becomes a real judge profile
 * the moment nobody checks the name.
 */
import { Espn } from './espn.mjs';

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures += 1; console.log(`FAIL ${msg}`); } };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`);

const COMP = 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/600060772/competitions/401897736';
const oref = (id) => `http://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/600060772/competitions/401897736/officials/${id}?lang=en&region=us`;

/* Espn with a scripted transport: no network, exact payload control. */
function stub(routes) {
  const e = new Espn({ minIntervalMs: 0 });
  e.json = async (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) throw new Error(`unstubbed ${url}`);
    return routes[key];
  };
  return e;
}

const officialsPayload = (items) => ({ count: items.length, items });
const judge = (id, first, last, order) => ({ id, firstName: first, lastName: last, position: { name: 'Judge', id: '41' }, order });
const referee = (id, first, last) => ({ id, firstName: first, lastName: last, position: { name: 'Referee', id: '40' }, order: 4 });
/* period 0 everywhere: these are final card totals, never round scores. */
const lines = (pairs) => ({ count: 1, pageCount: 1, items: [{ value: pairs.reduce((n, p) => n + p[1], 0), period: 0, linescores: pairs.map(([oid, v], i) => ({ value: v, displayValue: String(v), period: 0, official: { $ref: oref(oid) }, order: i + 1 })) }] });

/* ---- officiating ------------------------------------------------------- */
{
  const e = stub({ '/officials': officialsPayload([
    judge('2594091', 'Chris', 'Flores', 2),
    referee('999', 'Gustav', 'Gibson'),
    judge('4021253', 'Ron', 'McCarthy', 1),
    judge('3023574', 'Michael', 'Bell', 3),
  ]) });
  const o = await e.officiating(`${COMP}/officials`);
  eq(o.referee, 'Gustav Gibson', 'referee is read from position.name, not from order');
  eq(o.judges.map((j) => j.name), ['Ron McCarthy', 'Chris Flores', 'Michael Bell'], 'judges come back in ESPN order, refereee excluded');
}
{
  const e = stub({ '/officials': officialsPayload([]) });
  const o = await e.officiating(`${COMP}/officials`);
  eq([o.referee, o.judges], [null, []], 'empty officials is not an error');
  eq(await (stub({}).officiating(null)), { referee: null, judges: [] }, 'null officials ref short-circuits without a fetch');
}

/* ---- scorecards: the join ---------------------------------------------- */
const JUDGES = [
  { id: '4021253', name: 'Ron McCarthy', order: 1 },
  { id: '2594091', name: 'Chris Flores', order: 2 },
  { id: '3023574', name: 'Michael Bell', order: 3 },
];
{
  /* Competitor A's linescores list the officials in one order and B's in the
   * REVERSE order. Joining on position would silently transpose two judges'
   * cards; joining on official.$ref cannot. */
  const e = stub({
    '/competitors/3136289/linescores': lines([['4021253', 28], ['2594091', 28], ['3023574', 29]]),
    '/competitors/5338118/linescores': lines([['3023574', 28], ['2594091', 29], ['4021253', 29]]),
  });
  const sc = await e.scorecards(`${COMP}?lang=en`, ['3136289', '5338118'], JUDGES);
  eq(sc.cards, [
    { judge: 'Ron McCarthy', score: '28-29' },
    { judge: 'Chris Flores', score: '28-29' },
    { judge: 'Michael Bell', score: '29-28' },
  ], 'cards join on official.$ref and keep ESPN judge order');
  eq(sc.rejected, [], 'nothing rejected on a clean card');
}

/* ---- scorecards: placeholders and half-cards --------------------------- */
{
  const e = stub({
    '/competitors/1/linescores': lines([['4021253', 29], ['77', 29], ['88', 30]]),
    '/competitors/2/linescores': lines([['4021253', 28], ['77', 28]]),
  });
  const sc = await e.scorecards(COMP, ['1', '2'], [
    { id: '4021253', name: 'Ron McCarthy', order: 1 },
    { id: '77', name: 'Judge 2', order: 2 },
    { id: '88', name: 'Judge 3', order: 3 },
  ]);
  eq(sc.cards, [{ judge: 'Ron McCarthy', score: '29-28' }], 'only the named official is stored');
  eq(sc.rejected.map((r) => r.reason).sort(), ['one_sided_linescore', 'placeholder_official'], 'a placeholder and a half-card are both reported, not silently dropped');
  check(!sc.cards.some((c) => /^judge\s*\d+$/i.test(c.judge)), 'no placeholder ever reaches a card');
}
{
  const e = stub({ '/linescores': lines([['4021253', 29]]) });
  const sc = await e.scorecards(COMP, ['1', '2'], [{ id: '4021253', name: '', order: 1 }]);
  eq(sc.cards, [], 'an official with no name yields no card');
  eq(sc.rejected[0]?.reason, 'unnamed_official', 'and says why');
}

/* ---- scorecards: refuses to guess -------------------------------------- */
{
  const e = stub({ '/linescores': lines([['4021253', 29]]) });
  eq(await e.scorecards(COMP, ['1'], JUDGES), { cards: [], rejected: [], scoredJudges: 0 }, 'a bout without exactly two competitors yields nothing');
  eq(await e.scorecards('https://example.com/nope', ['1', '2'], JUDGES), { cards: [], rejected: [], scoredJudges: 0 }, 'a ref that is not a competition yields nothing');
}
{
  /* A finish: ESPN keeps a placeholder official and publishes no linescore. */
  const e = stub({ '/linescores': { count: 0, items: [] } });
  const sc = await e.scorecards(COMP, ['1', '2'], [{ id: '77', name: 'Judge 1', order: 1 }]);
  eq([sc.cards, sc.rejected, sc.scoredJudges], [[], [], 0], 'a bout with no linescores produces nothing at all');
}

console.log(failures === 0 ? 'scorecards.mjs: OK' : `scorecards.mjs: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
