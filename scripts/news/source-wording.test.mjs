// Generated UFC articles are born with PropSports-neutral source wording (no "UFC Stats" / "ESPN" lane branding),
// and the wording change is version-gated so existing stored rows are not refreshed by a wording-only change.
// Runs the real generator (main, dry + print) against a fixture world served through a mocked Supabase fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WORDING, legacyHashView, LANE_BRANDING } from './source-wording.mjs';
import { factHash } from './lib.mjs';

const day = (n) => new Date(Date.UTC(2026, 9, 3) + n * 86400000).toISOString().slice(0, 10);
const fighter = (id, name, career) => ({
  id, ufcstats_id: `u${id}`, espn_athlete_id: `e${id}`, name, nickname: null, dob: '1992-01-01', record_w: 10, record_l: 2, record_d: 0, record_nc: 0,
  height_in: 70, reach_in: id === 'f1' ? 76 : 71, stance: 'Orthodox', weight_lbs: 155, source_url: null,
  career_slpm: career ? 5.1 : null, career_str_acc: career ? 48 : null, career_sapm: career ? 3.2 : null, career_str_def: career ? 58 : null,
  career_td_avg: career ? 1.2 : null, career_td_acc: career ? 40 : null, career_td_def: career ? 70 : null, career_sub_avg: career ? 0.4 : null,
});
const TABLES = {
  // f1/f2 have no career averages (exercises every "not on file" branch); f3/f4 have them.
  ufc_fighters: [fighter('f1', 'Alan Archer', false), fighter('f2', 'Ben Brooks', false), fighter('f3', 'Carl Cruz', true), fighter('f4', 'Dan Dorsey', true)],
  ufc_fighter_aliases: [],
  ufc_events: [
    { id: 'e-up', name: 'UFC Fight Night: Archer vs. Brooks', event_date: day(7), venue: 'Apex', city: 'Las Vegas', region: 'NV', country: 'USA', card_status: 'announced' },
    { id: 'e-done', name: 'UFC Fight Night: Cruz vs. Dorsey', event_date: day(-6), venue: 'Apex', city: 'Las Vegas', region: 'NV', country: 'USA', card_status: 'completed' },
  ],
  ufc_bouts: [
    { id: 'b-up', event_id: 'e-up', fighter_a_id: 'f1', fighter_b_id: 'f2', weight_class: 'LW', weight_class_raw: 'Lightweight', is_womens: false, is_title: false, scheduled_rounds: 5, card_position: 'main', bout_order: 10, status: 'announced', replaced_bout_id: null, short_notice_days: null },
    { id: 'b-up2', event_id: 'e-up', fighter_a_id: 'f3', fighter_b_id: 'f4', weight_class: 'LW', weight_class_raw: 'Lightweight', is_womens: false, is_title: false, scheduled_rounds: 3, card_position: 'main', bout_order: 9, status: 'announced', replaced_bout_id: null, short_notice_days: null },
    { id: 'b-done', event_id: 'e-done', fighter_a_id: 'f3', fighter_b_id: 'f4', weight_class: 'LW', weight_class_raw: 'Lightweight', is_womens: false, is_title: false, scheduled_rounds: 5, card_position: 'main', bout_order: 10, status: 'completed', replaced_bout_id: null, short_notice_days: null },
  ],
  ufc_bout_results: [{ bout_id: 'b-done', winner_id: 'f3', method: 'KO_TKO', method_raw: 'KO/TKO', round: 2, time_sec: 140, time_format: '5-5-5-5-5', referee: null, scorecards: null, finish_detail: 'Punches', has_stats: false }],
  ufc_bout_round_stats: [],
  ufc_images: [],
  ufc_articles: [],
};
function mockFetch() {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    const table = u.pathname.split('/rest/v1/')[1]?.split('?')[0];
    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'GET') throw new Error(`write attempted in dry run: ${method} ${table}`);
    const rows = TABLES[table] ?? [];
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('generator output (previews + results, dry run) carries no upstream lane branding', async () => {
  const { main } = await import('./write_articles.mjs');
  const realFetch = globalThis.fetch, realLog = console.log;
  const out = [];
  globalThis.fetch = mockFetch();
  console.log = (...a) => out.push(a.join(' '));
  let r;
  try {
    r = await main({ SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test' }, { dry: true, print: true, llm: false, today: day(0), types: ['fight_preview', 'results'] });
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
  const text = out.join('\n');
  assert.ok(r.created >= 2, `expected generated articles, got ${JSON.stringify(r)}\n${text.slice(0, 2000)}`);
  // The neutral branches really ran (not a vacuous pass).
  assert.match(text, /Round-level striking and grappling averages are not on file for/);
  assert.match(text, /Career-to-date round statistics (are|were) on file for/);
  assert.match(text, /Round-level data (for the main event|for this bout)/);
  const hit = text.split('\n').find((l) => LANE_BRANDING.test(l));
  assert.equal(hit, undefined, `upstream lane branding in generated copy: ${hit}`);
});

test('wording-only change keeps the stored fact-block hash (no refresh storm)', () => {
  const neutral = { bettor_angle: { risks: [`${WORDING[0][0]} Alan Archer, so pace is unknown.`] }, depth: { short_reason: `${WORDING[3][0]} Ben Brooks` } };
  const legacy = { bettor_angle: { risks: [`${WORDING[0][1]} Alan Archer, so pace is unknown.`] }, depth: { short_reason: `${WORDING[3][1]} Ben Brooks` } };
  assert.equal(factHash(legacyHashView(neutral), { salt: 'v2' }), factHash(legacy, { salt: 'v2' }));
  // A real fact change still changes the hash.
  const changed = { ...neutral, depth: { short_reason: `${WORDING[3][0]} Carl Cruz` } };
  assert.notEqual(factHash(legacyHashView(changed), { salt: 'v2' }), factHash(legacy, { salt: 'v2' }));
});

test('wording table is an exact, collision-free inverse', () => {
  for (const [i, [n, l]] of WORDING.entries()) {
    assert.ok(!LANE_BRANDING.test(n), `neutral phrase still branded: ${n}`);
    for (const [j, [n2, l2]] of WORDING.entries()) if (i !== j) { assert.ok(!n2.includes(n), `${n} nested in ${n2}`); assert.ok(!l2.includes(l), `${l} nested in ${l2}`); }
  }
});
