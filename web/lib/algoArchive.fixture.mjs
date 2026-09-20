/* In-memory stand-in for the record store, for algoArchive.test.mjs ONLY.
 *
 * Nothing here touches a network or a database: the "store" is a set of arrays
 * and `reader()` answers the PostgREST paths lib/algoArchive.ts and lib/algo.ts
 * issue, including a server-side row cap (max-rows), which is the behaviour the
 * no-row-cap scan has to survive. Synthetic picks exist only in this process. */

const uuid = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (offset, base) => new Date(base + offset * 86400e3).toISOString().slice(0, 10);
const RESULTS = ['WIN', 'LOSS', 'WIN', 'LOSS', 'WIN', 'DRAW', 'WIN', 'LOSS', 'NC', 'VOID'];

/**
 * 123 events. Oldest first by index:
 *   0..119  completed cards, 10 official picks each (1,200 picks), fully graded
 *   120     an old card with 2 picks never graded            -> GRADING_OVERDUE
 *   121     last night's card, 6 of 10 graded                -> GRADING
 *   122     next week's card, 10 locked, none graded         -> AWAITING_RESULTS
 * Plus drafts (locked_at NULL), a shadow table and a backtest table that the
 * archive must never read, two official model versions, picks without a lock
 * price, corrected grades, one pick with no event and one orphan grade.
 */
export function buildStore(now = Date.now()) {
  const events = [], fighters = [], bouts = [], preds = [], grades = [];
  let f = 0, gradeSeq = 0;
  const addGrade = (prediction_id, revision, result, graded_at, reason = null) => {
    gradeSeq += 1;
    grades.push({ id: uuid('eeeeeeee', gradeSeq), prediction_id, revision, result, graded_at, revision_reason: reason, source: 'fixture', method: null, graded_by: 'fixture', winner_id: null });
  };
  const addEvent = (i, offsetDays, picks, gradedCount) => {
    const event = { id: uuid('aaaaaaaa', i), name: `UFC Fixture ${i}`, event_date: day(offsetDays, now) };
    events.push(event);
    for (let k = 0; k < picks; k += 1) {
      const n = preds.length;
      const a = { id: uuid('ffffffff', f += 1), name: `Fighter ${f}A` };
      const b = { id: uuid('ffffffff', f += 1), name: `Fighter ${f}B` };
      fighters.push(a, b);
      const bout = { id: uuid('bbbbbbbb', n), event_id: event.id, card_position: k < 5 ? 'main' : 'prelim', bout_order: picks - k, fighter_a: a, fighter_b: b, event };
      bouts.push(bout);
      const priced = n % 7 !== 3;                       // every seventh pick has no lock-time price
      const odds = n % 4 < 2 ? 150 + (n % 9) * 10 : -(110 + (n % 9) * 10);   // underdog picks land on every result type
      const locked_at = new Date(Date.parse(`${event.event_date}T00:00:00Z`) - 8 * 3600e3 + k * 1000).toISOString();
      preds.push({
        id: uuid('cccccccc', n), bout_id: bout.id, event_id: event.id, fighter_a_id: a.id, fighter_b_id: b.id,
        model_version: i < 60 ? 'pbe-fight-model-v1' : 'pbe-fight-model-v2', feature_version: 'pbe-fight-features-v1',
        locked_at, generated_at: locked_at, pick_fighter_id: n % 3 ? a.id : b.id, pick_probability: 0.52 + (n % 40) / 100, confidence_band: '55-60',
        market_implied_prob_pick: priced ? 0.5 : null, model_edge_pts: priced ? (n % 25) - 8 : null, market_books: priced ? 6 : null, market_snapshot_at: priced ? locked_at : null,
        sample_context: { confidence: ['HIGH', 'MEDIUM', 'LEAN'][n % 3], market: priced ? { status: 'FRESH', source: 'the-odds-api', books: 6, observed_at: locked_at, pick_best_odds: odds, pick_best_book: 'FixtureBook', pick_consensus_odds: odds - 5, devigged_pick: odds > 0 ? 0.4 : 0.6, devigged_opponent: odds > 0 ? 0.6 : 0.4 } : { status: 'UNAVAILABLE' } },
      });
      if (k < gradedCount) {
        const at = new Date(Date.parse(`${event.event_date}T23:00:00Z`) + k * 60e3).toISOString();
        addGrade(preds[n].id, 1, RESULTS[n % RESULTS.length], at);
        if (n % 97 === 5) addGrade(preds[n].id, 2, 'NC', new Date(Date.parse(at) + 30 * 86400e3).toISOString(), 'overturned by the commission');
      }
    }
  };
  for (let i = 0; i < 120; i += 1) addEvent(i, -(900 - i * 7), 10, 10);
  addEvent(120, -40, 2, 0);
  addEvent(121, -1, 10, 6);
  addEvent(122, 6, 10, 0);

  /* A pick whose event row cannot be read, and a grade whose prediction is not an official locked pick. */
  const stray = { ...preds[0], id: uuid('cccccccc', 999001), bout_id: bouts[0].id, event_id: null };
  preds.push(stray);
  addGrade(stray.id, 1, 'WIN', new Date(now - 50 * 86400e3).toISOString());
  addGrade(uuid('cccccccc', 999002), 1, 'LOSS', new Date(now - 50 * 86400e3).toISOString());

  /* Never official: drafts share the table with locked_at NULL. */
  const drafts = Array.from({ length: 30 }, (_, k) => ({ ...preds[1212 + (k % 5)], id: uuid('dddddddd', k), locked_at: null }));
  return { events, fighters, bouts, preds, drafts, grades, shadow: [{ id: uuid('99999999', 1) }], backtest: [{ id: uuid('99999999', 2) }] };
}

const LEAN = (p) => ({ id: p.id, event_id: p.event_id, bout_id: p.bout_id, locked_at: p.locked_at, model_version: p.model_version, pick_probability: p.pick_probability, model_edge_pts: p.model_edge_pts, confidence: p.sample_context?.confidence ?? null, best_odds: p.sample_context?.market?.pick_best_odds == null ? null : String(p.sample_context.market.pick_best_odds), consensus_odds: p.sample_context?.market?.pick_consensus_odds == null ? null : String(p.sample_context.market.pick_consensus_odds), devigged_pick: p.sample_context?.market?.devigged_pick == null ? null : String(p.sample_context.market.devigged_pick), devigged_opponent: p.sample_context?.market?.devigged_opponent == null ? null : String(p.sample_context.market.devigged_opponent) });

/** A PostgREST-shaped reader over the store. `maxRows` is the server cap. */
export function reader(store, { maxRows = 1000, fail = null, log = [] } = {}) {
  return async (path) => {
    log.push(path);
    const [table, qs = ''] = path.split('?');
    if (fail && fail(table, path)) throw new Error(`fixture: ${table} unavailable`);
    const params = qs.split('&').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))]; });
    const get = (k) => params.find(([x]) => x === k)?.[1];
    let rows;
    if (table === 'ufc_model_predictions') rows = [...store.preds, ...store.drafts];
    else if (table === 'ufc_model_prediction_grades') rows = store.grades;
    else if (table === 'ufc_events') rows = store.events;
    else if (table === 'ufc_bouts') rows = store.bouts;
    else if (table === 'ufc_fighters') rows = store.fighters;
    else if (table === 'ufc_model_card_current') rows = [];            // Pro reader only; evaluations are not part of the record
    else throw new Error(`fixture: unexpected table ${table}`);
    for (const [k, v] of params) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      if (v === 'not.is.null') rows = rows.filter((r) => r[k] != null);
      else if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3));
      else if (v.startsWith('gt.')) rows = rows.filter((r) => String(r[k]) > v.slice(3));
      else if (v.startsWith('in.(')) { const set = new Set(v.slice(4, -1).split(',').map((x) => x.replace(/"/g, ''))); rows = rows.filter((r) => set.has(String(r[k]))); }
      else throw new Error(`fixture: unsupported filter ${k}=${v}`);
    }
    const order = get('order');
    if (order) { const [col] = order.split('.'); rows = rows.slice().sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0)); }
    rows = rows.slice(0, Math.min(Number(get('limit') || maxRows), maxRows));
    const lean = table === 'ufc_model_predictions' && String(get('select')).includes('best_odds:');
    return rows.map((r) => (lean ? LEAN(r) : { ...r }));
  };
}

/** The same store behind `fetch`, for lib/algo.ts. */
export function fetchStub(store, opts = {}) {
  const read = reader(store, opts);
  return async (url) => {
    const path = String(url).split('/rest/v1/')[1];
    try {
      const rows = await read(path);
      return { ok: true, status: 200, json: async () => rows };
    } catch {
      return { ok: false, status: 503, json: async () => ({}) };
    }
  };
}

/* Independent arithmetic over the authoritative arrays: what the archive must reconcile with. */
export function authoritative(store, predicate = () => true) {
  const current = new Map();
  for (const g of store.grades) { const c = current.get(g.prediction_id); if (!c || g.revision > c.revision) current.set(g.prediction_id, g); }
  let locked = 0, wins = 0, losses = 0, noDecision = 0, pending = 0, priced = 0, net = 0;
  for (const p of store.preds.filter(predicate)) {
    locked += 1;
    const g = current.get(p.id);
    if (!g) { pending += 1; continue; }
    if (g.result !== 'WIN' && g.result !== 'LOSS') { noDecision += 1; continue; }
    if (g.result === 'WIN') wins += 1; else losses += 1;
    const odds = p.sample_context?.market?.pick_best_odds;
    if (odds == null) continue;
    priced += 1;
    net += g.result === 'LOSS' ? -1 : odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  }
  return { locked, wins, losses, no_decision: noDecision, pending, priced_decided: priced, net_units: net, current };
}
