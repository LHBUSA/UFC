import test from "node:test";
import assert from "node:assert/strict";
import worker, { __test } from "./index.js";

/* ---- pure helpers ----------------------------------------------------- */

test("clampInt applies defaults and bounds", () => {
  assert.equal(__test.clampInt(undefined, 25, 1, 100), 25);
  assert.equal(__test.clampInt("0", 25, 1, 100), 1);
  assert.equal(__test.clampInt("999", 25, 1, 100), 100);
  assert.equal(__test.clampInt("42", 25, 1, 100), 42);
});

test("sanitizeLike strips PostgREST wildcard punctuation", () => {
  assert.equal(__test.sanitizeLike("  Sean*(O'Malley),  "), "Sean O'Malley");
});

test("identityFilter routes UUID, UFCStats ids, and ESPN ids", () => {
  assert.deepEqual(
    __test.identityFilter("bc0f994d-e052-1926-a123-123456789abc", "id", "ufcstats_id", "espn_event_id"),
    ["id", "eq.bc0f994d-e052-1926-a123-123456789abc"],
  );
  assert.deepEqual(
    __test.identityFilter("abcdef1234567890", "id", "ufcstats_id", "espn_event_id"),
    ["ufcstats_id", "eq.abcdef1234567890"],
  );
  assert.deepEqual(
    __test.identityFilter("600056266", "id", "ufcstats_id", "espn_event_id"),
    ["espn_event_id", "eq.600056266"],
  );
});

test("normalizeBout turns embedded result arrays into one result", () => {
  assert.deepEqual(__test.normalizeBout({ id: "x", result: [{ bout_id: "x" }] }), { id: "x", result: { bout_id: "x" } });
  assert.deepEqual(__test.normalizeBout({ id: "x", result: [] }), { id: "x", result: null });
});

test("parseIncludes accepts known values and rejects unknown ones", () => {
  const url = new URL("https://x/v1/ufc/fighters/a?include=media, ranking,STATS");
  assert.deepEqual([...__test.parseIncludes(url, ["media", "ranking", "next", "history", "stats"])], ["media", "ranking", "stats"]);
  assert.throws(() => __test.parseIncludes(new URL("https://x/?include=odds"), ["media"]), (e) => e.code === "invalid_include" && e.status === 400);
  assert.equal(__test.parseIncludes(new URL("https://x/"), ["media"]).size, 0);
});

test("mediaUrls derives portrait/card/thumb only for the portrait layout", () => {
  const env = { UFC_IMAGE_BASE_URL: "https://cdn.example/ufc-media/" };
  assert.deepEqual(__test.mediaUrls(env, { r2_key: "fighters/abc/portrait.jpg" }), {
    image_url: "https://cdn.example/ufc-media/fighters/abc/portrait.jpg",
    card_url: "https://cdn.example/ufc-media/fighters/abc/card.jpg",
    thumb_url: "https://cdn.example/ufc-media/fighters/abc/thumb.jpg",
  });
  assert.deepEqual(__test.mediaUrls(env, { r2_key: "statcards/abc.png" }), {
    image_url: "https://cdn.example/ufc-media/statcards/abc.png", card_url: null, thumb_url: null,
  });
  assert.deepEqual(__test.mediaUrls({}, { r2_key: "fighters/abc/portrait.jpg" }), { image_url: null, card_url: null, thumb_url: null });
  assert.deepEqual(__test.mediaUrls(env, null), { image_url: null, card_url: null, thumb_url: null });
});

test("primaryImage prefers a resolvable wikimedia image and returns the compact contract", () => {
  const p = __test.primaryImage([
    { id: "s", kind: "statcard", r2_key: "s.png", image_url: "https://x/s.png", author: null, license: null, source_url: null },
    { id: "w", kind: "wikimedia", r2_key: "fighters/a/portrait.jpg", image_url: "https://x/p.jpg", card_url: "https://x/c.jpg", thumb_url: "https://x/t.jpg", author: "Photog", license: "CC BY-SA 4.0", source_url: "https://commons.wikimedia.org/wiki/File:A.jpg" },
  ]);
  assert.deepEqual(p, { id: "w", image_url: "https://x/p.jpg", card_url: "https://x/c.jpg", thumb_url: "https://x/t.jpg", author: "Photog", license: "CC BY-SA 4.0", source_url: "https://commons.wikimedia.org/wiki/File:A.jpg", kind: "wikimedia", attribution_text: null, rights_label: null });
  assert.equal(__test.primaryImage([]), null);
  assert.equal(__test.primaryImage([{ id: "w", kind: "wikimedia", r2_key: "k", image_url: null }]), null);
});

test("slugId matches the web fighter slug rule (espn id, else ufcstats id)", () => {
  assert.equal(__test.slugId({ espn_athlete_id: "3093653", ufcstats_id: "0d8011111be000b2" }), "3093653");
  assert.equal(__test.slugId({ espn_athlete_id: null, ufcstats_id: "0d8011111be000b2" }), "0d8011111be000b2");
  assert.equal(__test.slugId({}), null);
});

test("boutOutcome and boutElapsedSeconds follow result semantics", () => {
  const bout = { result: { winner_id: "A", method: "KO_TKO", round: 2, time_sec: 75 } };
  assert.equal(__test.boutOutcome(bout, "A"), "W");
  assert.equal(__test.boutOutcome(bout, "B"), "L");
  assert.equal(__test.boutOutcome({ result: { winner_id: null, method: "DRAW" } }, "A"), "D");
  assert.equal(__test.boutOutcome({ result: { winner_id: null, method: "NC" } }, "A"), "NC");
  assert.equal(__test.boutOutcome({ result: null }, "A"), null);
  assert.deepEqual(__test.boutElapsedSeconds(bout, 2), { seconds: 375, basis: "result" });
  assert.deepEqual(__test.boutElapsedSeconds({ result: null }, 3), { seconds: 900, basis: "rounds_x_5min" });
  assert.deepEqual(__test.boutElapsedSeconds(null, 0), { seconds: null, basis: "unknown" });
});

test("sumMetrics keeps null when every round is null and sums otherwise", () => {
  const t = __test.sumMetrics([{ kd: 1, sig_str_landed: 10, ctrl_sec: null }, { kd: 0, sig_str_landed: 5, ctrl_sec: null }]);
  assert.equal(t.kd, 1);
  assert.equal(t.sig_str_landed, 15);
  assert.equal(t.ctrl_sec, null);
  assert.equal(t.td_landed, null);
});

test("divisionLabel matches the snapshot labelling", () => {
  assert.equal(__test.divisionLabel("P4P", false, true), "Men's Pound-for-Pound");
  assert.equal(__test.divisionLabel("P4P", true, true), "Women's Pound-for-Pound");
  assert.equal(__test.divisionLabel("LIGHT_HEAVYWEIGHT", false, false), "Light Heavyweight");
  assert.equal(__test.divisionLabel("STRAWWEIGHT", true, false), "Women's Strawweight");
});

/* ---- fixtures --------------------------------------------------------- */

const F_MEDIA = "ec94d296-2db3-4e0d-be6a-46de4f480672";  // fighter with a licensed portrait
const F_NOMEDIA = "1a2b3c4d-1111-4222-8333-444455556666"; // fighter without any image row
const F_OPP = "2b3c4d5e-2222-4333-8444-555566667777";
const E_PAST = "3c4d5e6f-3333-4444-8555-666677778888";
const E_NEXT = "4d5e6f70-4444-4555-8666-777788889999";
const B_PAST = "5e6f7081-5555-4666-8777-88889999aaaa";
const B_NEXT = "6f708192-6666-4777-8888-9999aaaabbbb";
const IMG_MEDIA = "006e6554-f441-4892-8a49-30409d01e52e";
const IMG_OPP = "116e6554-f441-4892-8a49-30409d01e52e";
const A_HERO = "7081a2b3-7777-4888-8999-aaaabbbbcccc";
const A_NOHERO = "81a2b3c4-8888-4999-8aaa-bbbbccccdddd";

const MEDIA_BASE = "https://media.example/ufc-media";

const fighterMedia = {
  id: F_MEDIA, ufcstats_id: "0d8011111be000b2", espn_athlete_id: "3093653", name: "Sean Strickland", nickname: "Tarzan", dob: "1991-02-27",
  height_in: 73, reach_in: 76, weight_lbs: 185, stance: "ORTHODOX", record_w: 29, record_l: 7, record_d: 0, record_nc: 0, is_active: true,
  career_slpm: 5.9, career_str_acc: 0.41, career_sapm: 4.2, career_str_def: 0.62, career_td_avg: 0.6, career_td_acc: 0.3, career_td_def: 0.8, career_sub_avg: 0.1,
  fight_history_count: 36, updated_at: "2026-09-06T00:00:00Z",
};
const fighterNoMedia = {
  ...fighterMedia, id: F_NOMEDIA, ufcstats_id: null, espn_athlete_id: "4199009", name: "Aaron Nomedia", nickname: null, record_w: 12, record_l: 4,
};
const fighterOpp = { ...fighterMedia, id: F_OPP, ufcstats_id: "ab12cd34ef567890", espn_athlete_id: "2222222", name: "Opponent Person", nickname: null };

const eventPast = { id: E_PAST, ufcstats_id: null, espn_event_id: "600050000", name: "UFC 300", event_date: "2025-04-13", venue: null, city: "Las Vegas", region: "NV", country: "USA", commission: null, is_ppv: true, card_status: "complete", updated_at: null };
const eventNext = { id: E_NEXT, ufcstats_id: null, espn_event_id: "600060772", name: "Noche UFC: Silva vs. Delgado", event_date: "2999-09-12", venue: null, city: "San Antonio", region: "TX", country: "USA", commission: null, is_ppv: false, card_status: "announced", updated_at: null };

const resultPast = { bout_id: B_PAST, winner_id: F_MEDIA, method: "DEC_U", method_raw: "Decision - Unanimous", round: 3, time_sec: 300, time_format: "3 Rnd (5-5-5)", referee: null, judge_1: null, judge_2: null, judge_3: null, scorecards: null, finish_detail: null, result_source: "espn", has_stats: true, captured_at: "2025-04-14T00:00:00Z" };

const brief = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith("career_") && k !== "fight_history_count" && k !== "updated_at"));
const boutPast = { id: B_PAST, ufcstats_id: "0123456789abcdef", espn_competition_id: "401000001", event_id: E_PAST, fighter_a_id: F_MEDIA, fighter_b_id: F_OPP, weight_class: "MIDDLEWEIGHT", weight_class_raw: "Middleweight Bout", is_womens: false, is_title: false, scheduled_rounds: 3, card_position: "main", bout_order: 5, status: "complete", replaced_bout_id: null, short_notice_days: null,
  fighter_a: brief(fighterMedia), fighter_b: brief(fighterOpp), result: [resultPast], event: eventPast };
const boutNext = { id: B_NEXT, ufcstats_id: null, espn_competition_id: "401000002", event_id: E_NEXT, fighter_a_id: F_NOMEDIA, fighter_b_id: F_MEDIA, weight_class: "MIDDLEWEIGHT", weight_class_raw: "Middleweight Bout", is_womens: false, is_title: true, scheduled_rounds: 5, card_position: "main", bout_order: 12, status: "announced", replaced_bout_id: null, short_notice_days: null,
  fighter_a: brief(fighterNoMedia), fighter_b: brief(fighterMedia), result: [], event: eventNext };

const images = [
  { id: IMG_MEDIA, kind: "wikimedia", r2_key: `fighters/${F_MEDIA}/portrait.jpg`, license: "CC BY-SA 4.0", author: "MMAnytt", source_url: "https://commons.wikimedia.org/wiki/File:Sean_Strickland_at_UFN_200.png", fighter_id: F_MEDIA, created_at: "2026-09-06T13:37:16Z" },
  { id: IMG_OPP, kind: "wikimedia", r2_key: `fighters/${F_OPP}/portrait.jpg`, license: "CC BY 3.0", author: "LA LATA", source_url: "https://commons.wikimedia.org/wiki/File:Opp.png", fighter_id: F_OPP, created_at: "2026-09-06T13:32:52Z" },
];

const roundRows = [1, 2, 3].flatMap((round) => [
  { bout_id: B_PAST, fighter_id: F_MEDIA, round, kd: 0, sig_str_landed: 30 + round, sig_str_att: 60, total_str_landed: 40, total_str_att: 70, td_landed: 0, td_att: 1, sub_att: 0, rev: 0, ctrl_sec: 10, head_landed: 20, head_att: 40, body_landed: 5, body_att: 10, leg_landed: 5 + round, leg_att: 10, distance_landed: 30 + round, distance_att: 60, clinch_landed: 0, clinch_att: 0, ground_landed: 0, ground_att: 0, captured_at: "2025-04-14T00:00:00Z" },
  { bout_id: B_PAST, fighter_id: F_OPP, round, kd: 0, sig_str_landed: 20, sig_str_att: 50, total_str_landed: 25, total_str_att: 55, td_landed: 1, td_att: 2, sub_att: 0, rev: 0, ctrl_sec: 40, head_landed: 10, head_att: 30, body_landed: 5, body_att: 10, leg_landed: 5, leg_att: 10, distance_landed: 20, distance_att: 50, clinch_landed: 0, clinch_att: 0, ground_landed: 0, ground_att: 0, captured_at: "2025-04-14T00:00:00Z" },
]);

const articleHero = { id: A_HERO, slug: "strickland-preview", headline: "Sean Strickland preview", dek: null, story_type: "fight_preview", status: "published", hero_image_ref: IMG_MEDIA,
  hero_credit: { author: "MMAnytt", license: "CC BY-SA 4.0", source_url: "https://commons.wikimedia.org/wiki/File:Sean_Strickland_at_UFN_200.png" },
  fighter_ids: [F_MEDIA, F_NOMEDIA], bout_id: B_NEXT, event_id: E_NEXT, published_at: "2026-09-06T10:00:00Z", updated_at: "2026-09-06T10:00:00Z", body_md: "# Body", sources: [], fact_block: null, model_version: null, needs_human: false };
const legacyFactBlock = { type: "preview", event: { id: E_PAST }, bout: { id: null }, fighters: [], derived: {}, generated_from: ["ufc_bouts"] };
const articleNoHero = { ...articleHero, id: A_NOHERO, slug: "nomedia-preview", headline: "Aaron Nomedia preview", hero_image_ref: null, hero_credit: null, fighter_ids: [F_NOMEDIA], bout_id: null, event_id: E_PAST, published_at: "2026-09-05T10:00:00Z", fact_block: legacyFactBlock };

const A_V2 = "91a2b3c4-9999-4bbb-8ccc-ddddeeee0002";
const factBlockV2 = {
  version: 2, story_class: "main_event_preview", generated_at: "2026-09-06T09:00:00Z",
  sources: { families: ["espn", "ufcstats"], news_item_ids: [] },
  event: { id: E_PAST, name: "UFC 300", event_date: "2025-04-13", venue: null, city: "Las Vegas", region: "NV", country: "USA" },
  bout: { id: B_PAST, weight_class: "MIDDLEWEIGHT", is_womens: false, is_title: false, scheduled_rounds: 3, card_position: "main", bout_order: 5 },
  matchup: {
    a: { fighter_id: F_MEDIA, name: "Sean Strickland", nickname: "Tarzan", slug: "sean-strickland-3093653", record: { w: 29, l: 7, d: 0, nc: 0 }, age: 35, height_in: 73, reach_in: 76, stance: "ORTHODOX", weight_lbs: 185, career: { slpm: 5.9, str_acc: 41, sapm: 4.2, str_def: 62, td_avg: 0.6, td_acc: 30, td_def: 80, sub_avg: 0.1 }, archive: { fights: 1, w: 1, l: 0, d: 0, nc: 0, ko: 0, sub: 0, dec: 1, finish_rate: 0, rounds_with_stats: 3, totals: { sig_l: 96, sig_a: 180, td_l: 0, td_a: 3, kd: 0, ctrl_sec: 30 }, last: [], days_since_last: 511 } },
    b: { fighter_id: F_OPP, name: "Opponent Person", nickname: null, slug: "opponent-person-2222222", record: { w: 29, l: 7, d: 0, nc: 0 }, age: 35, height_in: 73, reach_in: 74, stance: "ORTHODOX", weight_lbs: 185, career: null, archive: null },
    edges: [{ key: "reach", favors: "a", delta: 2, unit: "in", note: "Strickland holds a two-inch reach edge." }],
  },
  bettor_angle: {
    impact_score: 4, markets: ["moneyline", "fight_goes_distance", "significant_strikes"],
    summary: "Analysis: the volume edge points to a decision-heavy profile.",
    supporting_facts: ["Strickland lands 5.9 significant strikes per minute.", "Strickland holds a two-inch reach edge."],
    risks: ["Opponent Person's power is untested in the archive."],
    watch_items: ["Weigh-in status", "Line movement once priced"],
    odds_status: "unavailable", model_status: "unavailable",
  },
  market_watch: { status: "unavailable", markets: ["fight_goes_distance", "significant_strikes"], note: "Current market price not yet available in PropBetEdge data." },
};
const articleV2 = { ...articleHero, id: A_V2, slug: "main-event-preview-champion-meets-opponent", headline: "Main event preview: the champion meets Opponent Person", hero_image_ref: null, hero_credit: null,
  fighter_ids: [F_MEDIA, F_OPP], bout_id: B_PAST, event_id: E_PAST, published_at: "2026-09-06T11:00:00Z", story_type: "fight_preview",
  body_md: "## The setup\n\nSean Strickland meets Opponent Person on Saturday night.", fact_block: factBlockV2 };

const snapshot = {
  captured_at: "2026-09-06T14:05:11.339Z", source_url: "https://www.ufc.com/rankings", snapshot_date: "2026-09-06",
  divisions: [
    { key: "MIDDLEWEIGHT", label: "Middleweight", is_womens: false, is_p4p: false, champion: { name: "Sean Strickland", ufc_slug: "sean-strickland", fighter_id: F_MEDIA },
      entries: [{ rank: 2, name: "Opponent Person", ufc_slug: "opponent-person", fighter_id: F_OPP, change: 1, is_new: false }, { rank: 1, name: "Unlinked Guy", ufc_slug: "unlinked-guy", fighter_id: null, change: 0, is_new: false }] },
    { key: "P4P", label: "Men's Pound-for-Pound", is_womens: false, is_p4p: true, champion: null,
      entries: [{ rank: 1, name: "Sean Strickland", ufc_slug: "sean-strickland", fighter_id: F_MEDIA, change: 0, is_new: false }] },
  ],
};

/* ---- minimal PostgREST + Storage mock --------------------------------- */

/* PostgREST JSON path: "fact_block->>version" / "fact_block->bettor_angle". */
function jsonPath(row, expr) {
  const parts = expr.split(/(->>|->)/);
  let v = row[parts[0]];
  let lastOp = null;
  for (let i = 1; i < parts.length; i += 2) {
    lastOp = parts[i];
    v = v && typeof v === "object" ? v[parts[i + 1]] : undefined;
  }
  if (v === undefined) v = null;
  if (lastOp === "->>" && v !== null && typeof v !== "string") return typeof v === "object" ? JSON.stringify(v) : String(v);
  return v;
}

function matchFilter(row, key, raw) {
  const value = key.includes("->") ? jsonPath(row, key) : row[key];
  if (raw.startsWith("eq.")) return String(value) === raw.slice(3);
  if (raw.startsWith("neq.")) return String(value) !== raw.slice(4);
  if (raw.startsWith("in.(")) {
    const list = raw.slice(4, -1).split(",").map((s) => s.replace(/^"|"$/g, ""));
    return list.includes(String(value));
  }
  if (raw.startsWith("ilike.")) {
    const pat = raw.slice(6).replace(/\*/g, "");
    return String(value || "").toLowerCase().includes(pat.toLowerCase());
  }
  if (raw.startsWith("cs.{")) return Array.isArray(value) && value.includes(raw.slice(4, -1));
  if (raw === "not.is.null") return value !== null && value !== undefined;
  if (raw === "is.null") return value === null || value === undefined;
  // Range operators compare numerically when both sides are numbers (jsonb / numeric semantics), else as text.
  const range = raw.match(/^(gte|lte|gt|lt)\.(.*)$/);
  if (range) {
    if (value === null || value === undefined) return false;
    const [, op, lit] = range;
    const numeric = typeof value === "number" && Number.isFinite(Number(lit));
    const a = numeric ? value : String(value);
    const b = numeric ? Number(lit) : lit;
    return op === "gte" ? a >= b : op === "lte" ? a <= b : op === "gt" ? a > b : a < b;
  }
  if (raw.startsWith("cs.[")) {
    const needles = JSON.parse(raw.slice(3));
    const hay = Array.isArray(value) ? value : [];
    const subset = (n, h) => n && typeof n === "object" && h && typeof h === "object" && Object.entries(n).every(([k, v]) => h[k] === v);
    return needles.every((n) => hay.some((h) => subset(n, h)));
  }
  throw new Error(`mock: unsupported filter ${key}=${raw}`);
}

/* Top-level projection of a PostgREST select list: "id,name,fighter_a:ufc_fighters!fk(a,b)" keeps id, name, fighter_a. */
function projectSelect(row, select) {
  if (!select || select === "*") return row;
  const keys = [];
  let depth = 0;
  let token = "";
  for (const ch of `${select},`) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { keys.push(token.trim()); token = ""; continue; }
    token += ch;
  }
  const out = {};
  for (const token of keys) {
    if (token.includes("->")) {
      const [alias, expr] = token.includes(":") ? token.split(":") : [token.split(/->>?/).pop(), token];
      out[alias] = jsonPath(row, expr);
      continue;
    }
    const k = token.split(":")[0].split("(")[0].split("!")[0].trim();
    if (k in row) out[k] = row[k];
  }
  return out;
}

function applyParams(rows, params) {
  let out = rows;
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (key === "or") {
      const parts = raw.slice(1, -1).split(",").map((p) => { const i = p.indexOf("."); return [p.slice(0, i), p.slice(i + 1)]; });
      out = out.filter((row) => parts.some(([k, v]) => matchFilter(row, k, v)));
      continue;
    }
    out = out.filter((row) => matchFilter(row, key, raw));
  }
  // PostgREST order: "col.desc,col2.asc.nullslast" (top-level columns or JSON paths).
  const order = String(params.get("order") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (order.length) {
    const terms = order.map((t) => { const [col, dir] = t.split("."); return [col, dir === "desc" ? -1 : 1]; });
    out = [...out].sort((x, y) => {
      for (const [col, dir] of terms) {
        const a = col.includes("->") ? jsonPath(x, col) : x[col];
        const b = col.includes("->") ? jsonPath(y, col) : y[col];
        if (a === b || (a == null && b == null)) continue;
        if (a == null) return 1;
        if (b == null) return -1;
        const cmp = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
        if (cmp) return cmp * dir;
      }
      return 0;
    });
  }
  const offset = Number(params.get("offset") || 0);
  const limit = Number(params.get("limit") || out.length);
  const select = params.get("select") || "*";
  return { rows: out.slice(offset, offset + limit).map((r) => projectSelect(r, select)), total: out.length };
}

function installMock({ tables, storage = {}, missingTables = [] }) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push(url.pathname + url.search);
    const href = url.origin + url.pathname;
    if (href.startsWith(`${MEDIA_BASE}/`) || url.pathname.startsWith("/storage/v1/object/public/ufc-media/")) {
      const key = href.startsWith(`${MEDIA_BASE}/`) ? href.slice(MEDIA_BASE.length + 1) : url.pathname.replace("/storage/v1/object/public/ufc-media/", "");
      if (key in storage) return new Response(JSON.stringify(storage[key]), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ statusCode: "404", error: "not_found" }), { status: 400 });
    }
    const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m) return new Response("nope", { status: 404 });
    const table = m[1];
    if (missingTables.includes(table) || !(table in tables)) {
      return new Response(JSON.stringify({ code: "42P01", message: `relation "public.${table}" does not exist` }), { status: 404 });
    }
    assert.equal(init.headers?.apikey, "service-key", "mock: service key must be sent");
    const { rows, total } = applyParams(tables[table], url.searchParams);
    const headers = { "Content-Type": "application/json" };
    if (init.headers?.Prefer === "count=exact") headers["Content-Range"] = `0-${Math.max(rows.length - 1, 0)}/${total}`;
    return new Response(JSON.stringify(rows), { status: 200, headers });
  };
  return calls;
}

const env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "service-key", UFC_IMAGE_BASE_URL: MEDIA_BASE, API_VERSION: "test" };
const fullTables = {
  ufc_fighters: [fighterMedia, fighterNoMedia, fighterOpp],
  ufc_events: [eventPast, eventNext],
  ufc_bouts: [boutPast, boutNext],
  ufc_bout_results: [resultPast],
  ufc_bout_round_stats: roundRows,
  ufc_images: images,
  ufc_articles: [articleHero, articleNoHero],
};

async function call(path) {
  const res = await worker.fetch(new Request(`https://ufc-api.test${path}`), env);
  return { status: res.status, body: await res.json() };
}

function resetRankings() {
  __test.rankingsState.probe = null;
  __test.rankingsState.probedAt = 0;
  __test.rankingsState.memo = null;
  __test.rankingsState.memoAt = 0;
}

/* ---- B1 media --------------------------------------------------------- */

test("fighter list attaches primary_image for a fighter with media and null without", async () => {
  installMock({ tables: fullTables });
  const { status, body } = await call("/v1/ufc/fighters?limit=10");
  assert.equal(status, 200);
  const withMedia = body.data.find((f) => f.id === F_MEDIA);
  const without = body.data.find((f) => f.id === F_NOMEDIA);
  assert.deepEqual(withMedia.primary_image, {
    id: IMG_MEDIA,
    image_url: `${MEDIA_BASE}/fighters/${F_MEDIA}/portrait.jpg`,
    card_url: `${MEDIA_BASE}/fighters/${F_MEDIA}/card.jpg`,
    thumb_url: `${MEDIA_BASE}/fighters/${F_MEDIA}/thumb.jpg`,
    author: "MMAnytt", license: "CC BY-SA 4.0",
    source_url: "https://commons.wikimedia.org/wiki/File:Sean_Strickland_at_UFN_200.png", kind: "wikimedia", attribution_text: null, rights_label: null,
  });
  assert.equal(without.primary_image, null);
  assert.equal("images" in withMedia, false, "list rows must stay compact (no images[])");
  assert.equal(body.meta.with_media, 2);
  assert.equal(body.meta.total, 3);
});

test("fighter detail keeps images[] and adds primary_image + slug_id; no-media fighter gets [] and null", async () => {
  installMock({ tables: fullTables });
  const a = await call(`/v1/ufc/fighters/0d8011111be000b2`);
  assert.equal(a.status, 200);
  assert.equal(a.body.data.id, F_MEDIA);
  assert.equal(a.body.data.slug_id, "3093653");
  assert.equal(a.body.data.images.length, 1);
  assert.equal(a.body.data.images[0].image_url, `${MEDIA_BASE}/fighters/${F_MEDIA}/portrait.jpg`);
  assert.equal(a.body.data.images[0].thumb_url, `${MEDIA_BASE}/fighters/${F_MEDIA}/thumb.jpg`);
  assert.equal(a.body.data.primary_image.card_url, `${MEDIA_BASE}/fighters/${F_MEDIA}/card.jpg`);
  assert.equal("ranking" in a.body.data, false, "default detail has no include fields");
  const b = await call(`/v1/ufc/fighters/${F_NOMEDIA}`);
  assert.deepEqual(b.body.data.images, []);
  assert.equal(b.body.data.primary_image, null);
  assert.equal(b.body.data.slug_id, "4199009");
});

test("event card fighters carry images[] and primary_image; default response has no round stats", async () => {
  installMock({ tables: fullTables });
  const { body } = await call(`/v1/ufc/events/600060772/card`);
  assert.equal(body.data.event.id, E_NEXT);
  assert.equal(body.data.bouts.length, 1);
  const bout = body.data.bouts[0];
  assert.equal(bout.fighter_a.primary_image, null);
  assert.equal(bout.fighter_b.primary_image.thumb_url, `${MEDIA_BASE}/fighters/${F_MEDIA}/thumb.jpg`);
  assert.equal(bout.result, null);
  assert.equal("round_stats" in bout, false);
});

test("bulk fighter media returns a map keyed by id, null for fighters without media", async () => {
  installMock({ tables: fullTables });
  const { status, body } = await call(`/v1/ufc/fighters/media?ids=${F_MEDIA},${F_NOMEDIA},${F_OPP}`);
  assert.equal(status, 200);
  assert.equal(body.meta.requested, 3);
  assert.equal(body.meta.found, 2);
  assert.equal(body.data.media[F_NOMEDIA], null);
  assert.equal(body.data.media[F_MEDIA].image_url, `${MEDIA_BASE}/fighters/${F_MEDIA}/portrait.jpg`);
  const bad = await call(`/v1/ufc/fighters/media?ids=not-a-uuid`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_ids");
  assert.equal(bad.body.data, null);
  const tooMany = await call(`/v1/ufc/fighters/media?ids=${Array.from({ length: 151 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`).join(",")}`);
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error.code, "too_many_ids");
});

test("search fighter hits carry primary_image and slug_id; article hits carry hero media", async () => {
  installMock({ tables: fullTables });
  const { body } = await call("/v1/ufc/search?q=strickland");
  assert.equal(body.data.fighters.length, 1);
  assert.equal(body.data.fighters[0].slug_id, "3093653");
  assert.equal(body.data.fighters[0].primary_image.kind, "wikimedia");
  assert.equal(body.data.articles.length, 1);
  assert.equal(body.data.articles[0].hero_image_url, `${MEDIA_BASE}/fighters/${F_MEDIA}/portrait.jpg`);
  assert.ok(Array.isArray(body.data.events));
});

/* ---- B2 rankings ------------------------------------------------------ */

test("rankings served from the snapshot when ufc_rankings is absent (probe once), with linked identities", async () => {
  resetRankings();
  const calls = installMock({ tables: fullTables, missingTables: ["ufc_rankings"], storage: { "rankings/latest.json": snapshot } });
  const { status, body } = await call("/v1/ufc/rankings");
  assert.equal(status, 200);
  assert.equal(body.meta.store, "snapshot");
  assert.equal(body.data.source, "ufc.com official rankings");
  assert.equal(body.data.source_url, "https://www.ufc.com/rankings");
  assert.equal(body.data.snapshot_date, "2026-09-06");
  assert.equal(body.data.captured_at, "2026-09-06T14:05:11.339Z");
  assert.deepEqual(body.data.divisions.map((d) => d.key), ["P4P", "MIDDLEWEIGHT"], "stable official order");
  const mw = body.data.divisions[1];
  assert.deepEqual(mw.champion.fighter, { id: F_MEDIA, name: "Sean Strickland", slug_id: "3093653" });
  assert.deepEqual(mw.entries.map((e) => e.rank), [1, 2], "entries sorted by rank");
  assert.equal(mw.entries[0].fighter, null, "unlinked entry keeps fighter null, never guessed");
  assert.equal(mw.entries[0].fighter_id, null);
  assert.deepEqual(mw.entries[1].fighter, { id: F_OPP, name: "Opponent Person", slug_id: "2222222" });
  assert.equal(calls.filter((c) => c.startsWith("/rest/v1/ufc_rankings")).length, 1);

  const again = await call("/v1/ufc/rankings?division=middleweight");
  assert.equal(again.body.data.divisions.length, 1);
  assert.equal(again.body.data.divisions[0].key, "MIDDLEWEIGHT");
  assert.equal(calls.filter((c) => c.startsWith("/rest/v1/ufc_rankings")).length, 1, "table probed once");
  const none = await call("/v1/ufc/rankings?division=heavyweight");
  assert.equal(none.status, 404);
  assert.equal(none.body.error.code, "division_not_found");
});

test("rankings from the table when migration 003 is applied and populated", async () => {
  resetRankings();
  const rows = [
    { snapshot_date: "2026-09-06", division: "MIDDLEWEIGHT", is_womens: false, is_p4p: false, rank: 0, fighter_id: F_MEDIA, name_raw: "Sean Strickland", ufc_slug: "sean-strickland", rank_change: null, is_new: false, source_url: "https://www.ufc.com/rankings", captured_at: "2026-09-06T14:05:11Z" },
    { snapshot_date: "2026-09-06", division: "MIDDLEWEIGHT", is_womens: false, is_p4p: false, rank: 1, fighter_id: F_OPP, name_raw: "Opponent Person", ufc_slug: "opponent-person", rank_change: 2, is_new: true, source_url: "https://www.ufc.com/rankings", captured_at: "2026-09-06T14:05:11Z" },
    { snapshot_date: "2026-09-06", division: "P4P", is_womens: true, is_p4p: true, rank: 1, fighter_id: null, name_raw: "Someone Else", ufc_slug: null, rank_change: 0, is_new: false, source_url: "https://www.ufc.com/rankings", captured_at: "2026-09-06T14:05:11Z" },
    { snapshot_date: "2026-08-30", division: "MIDDLEWEIGHT", is_womens: false, is_p4p: false, rank: 0, fighter_id: F_OPP, name_raw: "Old Champ", ufc_slug: null, rank_change: null, is_new: false, source_url: "https://www.ufc.com/rankings", captured_at: "2026-08-30T14:05:11Z" },
  ];
  installMock({ tables: { ...fullTables, ufc_rankings: rows }, storage: {} });
  const { status, body } = await call("/v1/ufc/rankings");
  assert.equal(status, 200);
  assert.equal(body.meta.store, "table");
  assert.equal(body.data.snapshot_date, "2026-09-06");
  assert.deepEqual(body.data.divisions.map((d) => `${d.key}/${d.is_womens}`), ["MIDDLEWEIGHT/false", "P4P/true"]);
  assert.equal(body.data.divisions[0].champion.name, "Sean Strickland");
  assert.equal(body.data.divisions[0].champion.fighter.slug_id, "3093653");
  assert.deepEqual(body.data.divisions[0].entries[0], { rank: 1, name: "Opponent Person", ufc_slug: "opponent-person", fighter_id: F_OPP, change: 2, is_new: true, fighter: { id: F_OPP, name: "Opponent Person", slug_id: "2222222" } });
  assert.equal(body.data.divisions[1].label, "Women's Pound-for-Pound");
  assert.equal(body.data.divisions[1].champion, null);
});

test("rankings are an explicit rankings_not_available error with null data when no store exists", async () => {
  resetRankings();
  installMock({ tables: fullTables, missingTables: ["ufc_rankings"], storage: {} });
  const { status, body } = await call("/v1/ufc/rankings");
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.data, null);
  assert.equal(body.error.code, "rankings_not_available");
});

/* ---- B3 article media ------------------------------------------------- */

test("news resolves hero_image_url + hero_image for articles with a hero ref and null without", async () => {
  installMock({ tables: fullTables });
  const { body } = await call("/v1/ufc/news?limit=10");
  const hero = body.data.find((a) => a.slug === "strickland-preview");
  const noHero = body.data.find((a) => a.slug === "nomedia-preview");
  assert.equal(hero.hero_image_ref, IMG_MEDIA, "existing field preserved");
  assert.equal(hero.hero_image_url, `${MEDIA_BASE}/fighters/${F_MEDIA}/portrait.jpg`);
  assert.deepEqual(hero.hero_image, {
    id: IMG_MEDIA,
    image_url: `${MEDIA_BASE}/fighters/${F_MEDIA}/portrait.jpg`,
    card_url: `${MEDIA_BASE}/fighters/${F_MEDIA}/card.jpg`,
    thumb_url: `${MEDIA_BASE}/fighters/${F_MEDIA}/thumb.jpg`,
    author: "MMAnytt", license: "CC BY-SA 4.0",
    source_url: "https://commons.wikimedia.org/wiki/File:Sean_Strickland_at_UFN_200.png",
    kind: "wikimedia", attribution_text: null, rights_label: null, fighter_id: F_MEDIA, ref: IMG_MEDIA,
  });
  assert.equal(noHero.hero_image_url, null);
  assert.equal(noHero.hero_image, null);
  assert.equal(body.meta.with_hero, 1);
  assert.equal("body_md" in hero, false, "list stays compact");
});

test("article detail resolves hero; dangling hero ref never fabricates; article credit overrides image credit", async () => {
  installMock({ tables: { ...fullTables, ufc_articles: [
    { ...articleHero, hero_credit: { author: "Override", license: "CC0", source_url: "https://commons.wikimedia.org/wiki/File:O.jpg" } },
    { ...articleNoHero, slug: "dangling", hero_image_ref: "99999999-9999-4999-8999-999999999999" },
  ] } });
  const a = await call("/v1/ufc/articles/strickland-preview");
  assert.equal(a.status, 200);
  assert.equal(a.body.data.body_md, "# Body");
  assert.equal(a.body.data.hero_image.author, "Override");
  assert.equal(a.body.data.hero_image.license, "CC0");
  assert.equal(a.body.data.hero_image_url, `${MEDIA_BASE}/fighters/${F_MEDIA}/portrait.jpg`);
  const d = await call("/v1/ufc/articles/dangling");
  assert.equal(d.status, 200);
  assert.equal(d.body.data.hero_image_url, null);
  assert.equal(d.body.data.hero_image, null);
  const missing = await call("/v1/ufc/articles/nope");
  assert.equal(missing.status, 404);
});

test("event and fighter article routes filter correctly and resolve hero media", async () => {
  installMock({ tables: fullTables });
  const ev = await call(`/v1/ufc/events/${E_NEXT}/articles`);
  assert.equal(ev.status, 200);
  assert.equal(ev.body.data.event.id, E_NEXT);
  assert.deepEqual(ev.body.data.articles.map((a) => a.slug), ["strickland-preview"]);
  assert.equal(ev.body.data.articles[0].hero_image_url, `${MEDIA_BASE}/fighters/${F_MEDIA}/portrait.jpg`);
  const fi = await call(`/v1/ufc/fighters/${F_NOMEDIA}/articles`);
  assert.equal(fi.body.data.fighter.slug_id, "4199009");
  assert.deepEqual(fi.body.data.articles.map((a) => a.slug), ["strickland-preview", "nomedia-preview"]);
  assert.equal(fi.body.meta.count, 2);
  const none = await call(`/v1/ufc/fighters/00000000-0000-4000-8000-000000000000/articles`);
  assert.equal(none.status, 404);
});

/* ---- B4 composite contracts ------------------------------------------- */

test("fighter include=media,ranking,next,history,stats returns every additive block", async () => {
  resetRankings();
  installMock({ tables: fullTables, missingTables: ["ufc_rankings"], storage: { "rankings/latest.json": snapshot } });
  const { status, body } = await call(`/v1/ufc/fighters/${F_MEDIA}?include=media,ranking,next,history,stats`);
  assert.equal(status, 200);
  const d = body.data;
  assert.deepEqual(body.meta.include, ["media", "ranking", "next", "history", "stats"]);
  // base fields unchanged
  assert.equal(d.name, "Sean Strickland");
  assert.equal(d.images.length, 1);
  // ranking
  assert.equal(d.ranking.snapshot_date, "2026-09-06");
  assert.deepEqual(d.ranking.positions, [
    { division: "P4P", label: "Men's Pound-for-Pound", is_womens: false, is_p4p: true, rank: 1, is_champion: false, change: 0, is_new: false },
    { division: "MIDDLEWEIGHT", label: "Middleweight", is_womens: false, is_p4p: false, rank: 0, is_champion: true, change: null, is_new: false },
  ]);
  // next
  assert.equal(d.next_bout.id, B_NEXT);
  assert.equal(d.next_bout.event.id, E_NEXT);
  assert.equal(d.next_bout.opponent.id, F_NOMEDIA);
  assert.equal(d.next_bout.opponent.primary_image, null);
  assert.equal(d.next_bout.is_fighter_a, false);
  assert.equal(d.next_bout.outcome, null);
  // history
  assert.deepEqual(d.history.map((h) => h.id), [B_NEXT, B_PAST], "newest first");
  const past = d.history[1];
  assert.equal(past.outcome, "W");
  assert.equal(past.result.method, "DEC_U");
  assert.equal(past.opponent.id, F_OPP);
  assert.equal(past.opponent.slug_id, "2222222");
  assert.equal(past.opponent.primary_image.thumb_url, `${MEDIA_BASE}/fighters/${F_OPP}/thumb.jpg`);
  assert.equal(past.event.name, "UFC 300");
  // stats
  assert.equal(d.stats.career_snapshot.slpm, 5.9);
  assert.ok(d.stats.warning.includes("display-only"));
  const c = d.stats.computed;
  assert.equal(c.provenance.source, "ufcstats_round_stats");
  assert.equal(c.provenance.bouts_with_stats, 1);
  assert.equal(c.provenance.rounds, 3);
  assert.equal(c.provenance.fight_time_sec, 900);
  assert.deepEqual(c.provenance.fight_time_basis, { result: 1, rounds_x_5min: 0 });
  assert.equal(c.career_totals.sig_str_landed, 96);
  assert.equal(c.career_totals.sig_str_att, 180);
  assert.equal(c.career_rates.sig_str_landed_per_min, 6.4);
  assert.equal(c.career_rates.sig_str_accuracy, 0.5333);
  assert.equal(c.career_rates.td_per_15min, 0);
  assert.equal(c.career_rates.ctrl_share, 0.0333);
  assert.equal(c.bouts.length, 1);
  assert.equal(c.bouts[0].bout_id, B_PAST);
  assert.equal(c.bouts[0].opponent.name, "Opponent Person");
  assert.equal(c.bouts[0].outcome, "W");
  assert.equal(c.bouts[0].totals.leg_landed, 21);
  assert.equal(c.bouts[0].rounds_detail.length, 3);
  assert.equal(body.meta.round_stat_rows, 3);
  assert.equal(body.meta.history_count, 2);
});

test("fighter include=ranking yields ranking null when no store exists and empty positions when unranked", async () => {
  resetRankings();
  installMock({ tables: fullTables, missingTables: ["ufc_rankings"], storage: {} });
  const none = await call(`/v1/ufc/fighters/${F_MEDIA}?include=ranking`);
  assert.equal(none.status, 200);
  assert.equal(none.body.data.ranking, null);
  resetRankings();
  installMock({ tables: fullTables, missingTables: ["ufc_rankings"], storage: { "rankings/latest.json": snapshot } });
  const unranked = await call(`/v1/ufc/fighters/${F_NOMEDIA}?include=ranking,stats`);
  assert.deepEqual(unranked.body.data.ranking.positions, []);
  assert.equal(unranked.body.data.stats.computed.provenance.bouts_with_stats, 0);
  assert.equal(unranked.body.data.stats.computed.career_rates.sig_str_landed_per_min, null);
  const bad = await call(`/v1/ufc/fighters/${F_MEDIA}?include=odds`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_include");
});

test("event card include=media,results,stats attaches round_stats and stat_totals per bout", async () => {
  installMock({ tables: fullTables });
  const { status, body } = await call(`/v1/ufc/events/${E_PAST}/card?include=media,results,stats`);
  assert.equal(status, 200);
  assert.equal(body.meta.round_stat_rows, 6);
  const bout = body.data.bouts[0];
  assert.equal(bout.id, B_PAST);
  assert.equal(bout.result.winner_id, F_MEDIA);
  assert.equal(bout.round_stats.length, 6);
  assert.equal(bout.stat_totals[F_MEDIA].rounds, 3);
  assert.equal(bout.stat_totals[F_MEDIA].sig_str_landed, 96);
  assert.equal(bout.stat_totals[F_OPP].td_landed, 3);
  assert.equal(bout.fighter_a.primary_image.kind, "wikimedia");
  const upcoming = await call(`/v1/ufc/events/${E_NEXT}/card?include=stats`);
  assert.deepEqual(upcoming.body.data.bouts[0].round_stats, []);
  assert.deepEqual(upcoming.body.data.bouts[0].stat_totals, {});
});

/* ---- B5/B6 stats, history, counts ------------------------------------ */

test("bout stats expose every round column plus totals and provenance", async () => {
  installMock({ tables: fullTables });
  const { body } = await call(`/v1/ufc/bouts/0123456789abcdef/stats`);
  assert.equal(body.data.bout.id, B_PAST);
  assert.equal(body.data.rounds.length, 6);
  const cols = ["bout_id", "fighter_id", "round", "kd", "sig_str_landed", "sig_str_att", "total_str_landed", "total_str_att", "td_landed", "td_att", "sub_att", "rev", "ctrl_sec", "head_landed", "head_att", "body_landed", "body_att", "leg_landed", "leg_att", "distance_landed", "distance_att", "clinch_landed", "clinch_att", "ground_landed", "ground_att"];
  for (const c of cols) assert.ok(c in body.data.rounds[0], `round row missing ${c}`);
  assert.equal(body.data.totals[F_OPP].ctrl_sec, 120);
  assert.equal(body.data.fight_time_sec, 900);
  assert.equal(body.data.fight_time_basis, "result");
  assert.equal(body.data.provenance.rows, 6);
});

test("fighter stats keep career_snapshot + warning and add round_stats + computed", async () => {
  installMock({ tables: fullTables });
  const { body } = await call(`/v1/ufc/fighters/3093653/stats`);
  assert.equal(body.data.fighter.id, F_MEDIA);
  assert.equal(body.data.fighter.slug_id, "3093653");
  assert.equal(body.data.career_snapshot.takedown_defense, 0.8);
  assert.ok(body.data.warning);
  assert.equal(body.data.round_stats.length, 3);
  assert.equal(body.data.computed.career_totals.sig_str_landed, 96);
  assert.equal(body.data.computed.bouts[0].event.name, "UFC 300");
});

test("fighter history rows add opponent + outcome and keep bout/event/result", async () => {
  installMock({ tables: fullTables });
  const { body } = await call(`/v1/ufc/fighters/${F_OPP}/history`);
  assert.equal(body.data.fighter.id, F_OPP);
  assert.equal(body.data.bouts.length, 1);
  assert.equal(body.data.bouts[0].outcome, "L");
  assert.equal(body.data.bouts[0].opponent.id, F_MEDIA);
  assert.equal(body.data.bouts[0].event.id, E_PAST);
  assert.equal(body.data.bouts[0].result.method, "DEC_U");
});

test("counts add images, fighters_with_media and a rounds alias", async () => {
  installMock({ tables: fullTables });
  const { body } = await call("/v1/ufc/counts");
  assert.deepEqual(body.data, { fighters: 3, events: 2, bouts: 2, results: 1, round_stat_rows: 6, articles: 2, images: 2, fighters_with_media: 2, rounds: 6 });
});

test("health reports media configuration and the index advertises the new routes", async () => {
  installMock({ tables: fullTables });
  const h = await call("/health");
  assert.equal(h.body.data.media_configured, true);
  const i = await call("/v1/ufc");
  assert.equal(i.body.data.media_base_url, MEDIA_BASE);
  for (const k of ["fighters_media", "event_articles", "fighter_articles", "rankings"]) assert.ok(i.body.data.endpoints[k], `index missing ${k}`);
});

/* ---- editorial analysis (docs/editorial_contract.md) ------------------ */

const analysisTables = { ...fullTables, ufc_articles: [articleHero, articleNoHero, articleV2] };

test("wordCount ignores markdown syntax and links, counts prose", () => {
  assert.equal(__test.wordCount("## The setup\n\nSean Strickland meets Opponent Person on Saturday night."), 10);
  assert.equal(__test.wordCount("See [the card](https://x/y) and `code` ```js\nignored()\n``` **bold** done."), 7);
  assert.equal(__test.wordCount(""), 0);
  assert.equal(__test.wordCount(null), 0);
  assert.equal(__test.analysisSummaryFrom("1", "results", { impact_score: 3 }), null, "legacy version yields null");
  assert.equal(__test.analysisSummaryFrom(2, "results", null), null, "no bettor_angle yields null");
  assert.deepEqual(__test.analysisSummaryFrom("2", "results", { impact_score: 3, markets: ["moneyline"] }), { impact_score: 3, markets: ["moneyline"], odds_status: "unavailable", model_status: "unavailable", story_class: "results" });
  assert.equal(__test.articleAnalysis(legacyFactBlock), null);
  assert.equal(__test.articleAnalysis(null), null);
});

test("article detail exposes analysis copied from a v2 fact block plus word_count/reading_minutes", async () => {
  installMock({ tables: analysisTables });
  const { status, body } = await call(`/v1/ufc/articles/${articleV2.slug}`);
  assert.equal(status, 200);
  const d = body.data;
  assert.deepEqual(Object.keys(d.analysis), ["version", "story_class", "generated_at", "sources", "bettor_angle", "market_watch", "matchup"]);
  assert.equal(d.analysis.version, 2);
  assert.equal(d.analysis.story_class, "main_event_preview");
  assert.equal(d.analysis.generated_at, "2026-09-06T09:00:00Z");
  assert.deepEqual(d.analysis.sources, factBlockV2.sources);
  assert.deepEqual(d.analysis.bettor_angle, factBlockV2.bettor_angle);
  assert.deepEqual(d.analysis.market_watch, factBlockV2.market_watch);
  assert.deepEqual(d.analysis.matchup, factBlockV2.matchup);
  assert.ok(d.analysis.bettor_angle.supporting_facts.length >= 1 && d.analysis.bettor_angle.risks.length >= 1);
  assert.equal(d.analysis.bettor_angle.odds_status, "unavailable");
  assert.deepEqual(d.analysis_summary, { impact_score: 4, markets: ["moneyline", "fight_goes_distance", "significant_strikes"], odds_status: "unavailable", model_status: "unavailable", story_class: "main_event_preview" });
  assert.deepEqual(d.fact_block, factBlockV2, "raw fact_block stays on detail");
  assert.equal(d.word_count, 10);
  assert.equal(d.reading_minutes, 1);
  assert.equal(d.body_md, articleV2.body_md);
  assert.equal(d.hero_image, null);
});

test("article detail with a legacy fact block yields analysis null and analysis_summary null", async () => {
  installMock({ tables: analysisTables });
  const { body } = await call("/v1/ufc/articles/nomedia-preview");
  assert.equal(body.data.analysis, null);
  assert.equal(body.data.analysis_summary, null);
  assert.deepEqual(body.data.fact_block, legacyFactBlock);
  assert.equal(body.data.word_count, 1);
  assert.equal(body.data.reading_minutes, 1);
  const noBlock = await call("/v1/ufc/articles/strickland-preview");
  assert.equal(noBlock.body.data.analysis, null);
  assert.equal(noBlock.body.data.analysis_summary, null);
});

test("list rows carry analysis_summary (or null) without the raw fact_block; story_class filters", async () => {
  installMock({ tables: analysisTables });
  const { body } = await call("/v1/ufc/news?limit=10");
  assert.equal(body.data.length, 3);
  const v2 = body.data.find((a) => a.slug === articleV2.slug);
  const legacy = body.data.find((a) => a.slug === "nomedia-preview");
  assert.deepEqual(v2.analysis_summary, { impact_score: 4, markets: ["moneyline", "fight_goes_distance", "significant_strikes"], odds_status: "unavailable", model_status: "unavailable", story_class: "main_event_preview" });
  assert.equal(legacy.analysis_summary, null);
  for (const row of body.data) {
    for (const k of ["fact_block", "analysis", "analysis_version", "analysis_story_class", "analysis_bettor_angle", "word_count", "body_md"]) {
      assert.equal(k in row, false, `list row must not carry ${k}`);
    }
    assert.ok("analysis_summary" in row);
  }
  assert.equal(body.meta.with_analysis, 1);
  assert.equal(body.meta.story_class, null);

  const filtered = await call("/v1/ufc/news?story_class=main_event_preview");
  assert.deepEqual(filtered.body.data.map((a) => a.slug), [articleV2.slug]);
  assert.equal(filtered.body.meta.story_class, "main_event_preview");
  assert.equal(filtered.body.meta.total, 1);
  const none = await call("/v1/ufc/news?story_class=results");
  assert.deepEqual(none.body.data, []);
  const both = await call("/v1/ufc/news?story_type=fight_preview&story_class=main_event_preview");
  assert.equal(both.body.data.length, 1);

  const ev = await call(`/v1/ufc/events/${E_PAST}/articles`);
  assert.deepEqual(ev.body.data.articles.map((a) => [a.slug, a.analysis_summary?.impact_score ?? null]).sort(), [[articleV2.slug, 4], ["nomedia-preview", null]].sort());
  const fi = await call(`/v1/ufc/fighters/${F_OPP}/articles`);
  assert.equal(fi.body.data.articles[0].analysis_summary.story_class, "main_event_preview");
  const search = await call("/v1/ufc/search?q=preview");
  assert.equal(search.body.data.articles.length, 3);
  assert.ok(search.body.data.articles.every((a) => "analysis_summary" in a && !("fact_block" in a)));
});

/* ---- live wire -------------------------------------------------------- */

const NOW = new Date("2026-09-06T15:00:00Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
const SRC_ESPN = { name: "ESPN MMA", url: "https://www.espn.com/espn/rss/mma/news" };
const SRC_MMAF = { name: "MMA Fighting", url: "https://www.mmafighting.com/rss/index.xml" };
const B_THIRD = "7a8b9c0d-7777-4888-8999-aaaabbbbcccd";
const boutThird = { id: B_THIRD, ufcstats_id: null, espn_competition_id: "401000003", event_id: E_PAST, fighter_a_id: F_OPP, fighter_b_id: F_NOMEDIA, weight_class: "WELTERWEIGHT", weight_class_raw: null, is_womens: false, is_title: false, scheduled_rounds: 3, card_position: "prelim", bout_order: 2, status: "complete", replaced_bout_id: null, short_notice_days: null,
  fighter_a: brief(fighterOpp), fighter_b: brief(fighterNoMedia), result: [], event: eventPast };
const eventFightWeek = { ...eventPast, id: "8b9c0d1e-8888-4999-8aaa-bbbbccccddde", espn_event_id: "600060700", name: "UFC Fight Night: Hooker vs. Parnasse", event_date: "2026-09-05", card_status: "complete" };
const eventDwcs = { ...eventPast, id: "9c0d1e2f-9999-4aaa-8bbb-ccccddddeeef", espn_event_id: "600060701", name: "Dana White's Contender Series: Season 10, Week 5", event_date: "2026-09-08", card_status: "announced" };

const wireItem = (id, title, mins, extra = {}) => ({
  id: `${id}-0000-4000-8000-000000000000`,
  url: `https://example.com/${id}`, title, published_at: minutesAgo(mins), summary: `Summary for ${id}`,
  taxonomy: { labels: ["result"], scores: { result: 0.4 }, matched: ["result:win"], confidence: 0.4 },
  fighter_ids: [], event_id: null, bout_id: null, source: SRC_ESPN, ...extra,
});
const W_ARTICLE_BOUT = wireItem("a0000001", "Strickland outpoints Opponent Person at UFC 300", 30, { bout_id: B_PAST, event_id: E_PAST, fighter_ids: [F_MEDIA, F_OPP] });
const W_BOUT = wireItem("a0000002", "Opponent Person edges Aaron Nomedia on the prelims", 45, { bout_id: B_THIRD, event_id: null, fighter_ids: [F_OPP, F_NOMEDIA] });
const W_EVENT = wireItem("a0000003", "UFC 300 weigh-in results: everyone makes weight", 60, { event_id: E_PAST, fighter_ids: [] });
const W_EVENT_FIGHTER_ARTICLE = wireItem("a0000004", "Aaron Nomedia talks UFC 300 camp", 70, { event_id: E_PAST, fighter_ids: [F_NOMEDIA] });
const W_FIGHTER = wireItem("a0000005", "Sean Strickland calls for a title shot", 80, { fighter_ids: [F_MEDIA] });
const W_NONE = wireItem("a0000006", "Regional MMA roundup from Brazil", 90, { fighter_ids: [], taxonomy: { labels: [], scores: {}, matched: [], confidence: 0 } });
const W_TWO_FIGHTERS_NO_EVENT = wireItem("a0000007", "Two veterans in talks for a rematch", 95, { fighter_ids: [F_MEDIA, F_OPP] });
const W_SOURCE_REF = wireItem("a0000008", "Contract news picked up by our newsroom", 100, { fighter_ids: [] });
const W_DUP_FIRST = wireItem("a0000009", "Parnasse wins in UFC debut, tops Hooker in Paris", 120, { source: SRC_ESPN });
const W_DUP_LATER = wireItem("a000000a", "Parnasse Wins In UFC Debut, Tops Hooker In Paris!", 110, { source: SRC_MMAF, url: "https://mmafighting.example/dup" });
const articleBoutPast = { ...articleNoHero, id: "b1b2c3d4-aaaa-4bbb-8ccc-ddddeeeeff00", slug: "strickland-vs-opponent-recap", event_id: E_PAST, bout_id: B_PAST, fighter_ids: [F_MEDIA, F_OPP], published_at: "2025-04-14T12:00:00Z" };
const articleSourceRef = { ...articleNoHero, id: "a1b2c3d4-aaaa-4bbb-8ccc-ddddeeeeffff", slug: "contract-news-story", event_id: null, bout_id: null, fighter_ids: [], sources: [{ kind: "news_item", id: W_SOURCE_REF.id }], published_at: "2026-09-06T12:00:00Z" };

const wireTables = {
  ...fullTables,
  ufc_bouts: [boutPast, boutNext, boutThird],
  ufc_events: [eventPast, eventNext, eventFightWeek, eventDwcs],
  ufc_articles: [articleHero, articleNoHero, articleBoutPast, articleSourceRef],
  ufc_news_items: [W_ARTICLE_BOUT, W_BOUT, W_EVENT, W_EVENT_FIGHTER_ARTICLE, W_FIGHTER, W_NONE, W_TWO_FIGHTERS_NO_EVENT, W_SOURCE_REF, W_DUP_FIRST, W_DUP_LATER],
};

test("wire slug helpers match web/lib/slug.ts", () => {
  assert.equal(__test.slugify("Michael ‘Venom’ Page's Fight!"), "michael-venom-pages-fight");
  assert.equal(__test.slugify("Noche UFC: Silva vs. Delgado"), "noche-ufc-silva-vs-delgado");
  assert.equal(__test.fighterSlug({ name: "Sean Strickland", espn_athlete_id: "3093653", ufcstats_id: "0d8011111be000b2" }), "sean-strickland-3093653");
  assert.equal(__test.fighterSlug({ name: "Nobody", espn_athlete_id: null, ufcstats_id: null }), null);
  assert.equal(__test.eventSlug({ name: "UFC 300", event_date: "2025-04-13" }), "ufc-300-2025-04-13");
  assert.equal(__test.eventSlug({ name: "UFC 999", event_date: null }), "ufc-999-tbd");
  assert.equal(__test.matchupSlug({ name: "Jean Silva" }, { name: "Jose Miguel Delgado" }, { name: "Noche UFC: Silva vs. Delgado", event_date: "2026-09-12" }), "jean-silva-vs-jose-miguel-delgado-noche-ufc-silva-vs-delgado-2026-09-12");
});

test("normalizeTitle strips punctuation/stopwords; dedupe keeps the earliest copy, newest first", () => {
  assert.equal(__test.normalizeTitle("Parnasse Wins In UFC Debut, Tops Hooker In Paris!"), __test.normalizeTitle("Parnasse wins in UFC debut, tops Hooker in Paris"));
  assert.notEqual(__test.normalizeTitle("Strickland wins"), __test.normalizeTitle("Strickland loses"));
  const out = __test.dedupeWireItems([W_DUP_LATER, W_FIGHTER, W_DUP_FIRST]);
  assert.deepEqual(out.map((i) => i.id), [W_FIGHTER.id, W_DUP_FIRST.id]);
  assert.equal(__test.wireTaxonomy({ labels: ["card_change", "injury"] }), "card_change");
  assert.equal(__test.wireTaxonomy({ labels: [] }), null);
  assert.equal(__test.wireTaxonomy(null), null);
});

test("wire maps internal_url: article (bout / event+fighter / sources ref), bout, event, fighter, none", async () => {
  installMock({ tables: wireTables });
  const out = await __test.wire(env, new URL("https://x/v1/ufc/wire?limit=20"), NOW);
  const by = Object.fromEntries(out.data.map((i) => [i.id, i]));
  assert.equal(by[W_ARTICLE_BOUT.id].internal_url, "/news/strickland-vs-opponent-recap", "bout-linked article wins over the fight page");
  assert.equal(by[W_BOUT.id].internal_url, "/fights/opponent-person-vs-aaron-nomedia-ufc-300-2025-04-13");
  assert.equal(by[W_EVENT.id].internal_url, "/events/ufc-300-2025-04-13");
  assert.equal(by[W_EVENT_FIGHTER_ARTICLE.id].internal_url, "/news/nomedia-preview");
  assert.equal(by[W_FIGHTER.id].internal_url, "/fighters/sean-strickland-3093653");
  assert.equal(by[W_NONE.id].internal_url, null);
  assert.equal(by[W_TWO_FIGHTERS_NO_EVENT.id].internal_url, null);
  assert.equal(by[W_SOURCE_REF.id].internal_url, "/news/contract-news-story");
  const it = by[W_ARTICLE_BOUT.id];
  assert.deepEqual(Object.keys(it), ["id", "title", "published_at", "summary", "taxonomy", "taxonomy_detail", "source", "source_url", "fighter_ids", "event_id", "bout_id", "internal_url"]);
  assert.equal(it.taxonomy, "result");
  assert.deepEqual(it.taxonomy_detail.labels, ["result"]);
  assert.deepEqual(it.source, SRC_ESPN);
  assert.equal(it.source_url, W_ARTICLE_BOUT.url);
  assert.equal(it.summary, "Summary for a0000001");
  assert.equal(it.title, W_ARTICLE_BOUT.title);
  assert.equal(by[W_NONE.id].taxonomy, null);
});

test("wire dedupes near-identical headlines keeping the earliest copy and orders newest first", async () => {
  installMock({ tables: wireTables });
  const out = await __test.wire(env, new URL("https://x/v1/ufc/wire?limit=20"), NOW);
  const ids = out.data.map((i) => i.id);
  assert.ok(ids.includes(W_DUP_FIRST.id) && !ids.includes(W_DUP_LATER.id), "earliest-published duplicate must survive");
  assert.equal(out.data.find((i) => i.id === W_DUP_FIRST.id).source.name, "ESPN MMA");
  assert.equal(out.meta.count, 9);
  assert.equal(out.meta.fetched, 10);
  assert.equal(out.meta.deduped, 1);
  const stamps = out.data.map((i) => i.published_at);
  assert.deepEqual(stamps, [...stamps].sort().reverse(), "newest first");
  const keys = new Set(out.data.map((i) => __test.normalizeTitle(i.title)));
  assert.equal(keys.size, out.data.length, "no duplicate normalized titles");
  const limited = await __test.wire(env, new URL("https://x/v1/ufc/wire?limit=2"), NOW);
  assert.equal(limited.data.length, 2);
  assert.equal(limited.meta.limit, 2);
  const clamped = await __test.wire(env, new URL("https://x/v1/ufc/wire?limit=500"), NOW);
  assert.equal(clamped.meta.limit, 50);
});

test("wire meta: live within 120 minutes, stale otherwise; fight_week ignores Contender Series", async () => {
  installMock({ tables: wireTables });
  const live = await __test.wire(env, new URL("https://x/v1/ufc/wire"), NOW);
  assert.equal(live.meta.generated_at, NOW.toISOString());
  assert.equal(live.meta.newest_published_at, W_ARTICLE_BOUT.published_at);
  assert.equal(live.meta.freshness_minutes, 30);
  assert.equal(live.meta.live, true);
  assert.equal(live.meta.fight_week, true, "UFC Fight Night one day ago counts");
  assert.deepEqual(live.meta.fight_week_events.map((e) => e.name), ["UFC Fight Night: Hooker vs. Parnasse"]);
  assert.equal(live.meta.linked, 6);

  const later = new Date(NOW.getTime() + 3 * 60 * 60000); // three hours on: newest item is 210 min old
  installMock({ tables: { ...wireTables, ufc_events: [eventPast, eventNext, eventDwcs] } });
  const stale = await __test.wire(env, new URL("https://x/v1/ufc/wire"), later);
  assert.equal(stale.meta.freshness_minutes, 210);
  assert.equal(stale.meta.live, false);
  assert.equal(stale.meta.fight_week, false, "Contender Series alone is not fight week");

  installMock({ tables: { ...wireTables, ufc_news_items: [] } });
  const empty = await __test.wire(env, new URL("https://x/v1/ufc/wire"), NOW);
  assert.deepEqual(empty.data, []);
  assert.equal(empty.meta.newest_published_at, null);
  assert.equal(empty.meta.freshness_minutes, null);
  assert.equal(empty.meta.live, false);
});

test("GET /v1/ufc/wire uses the short cache policy, keeps CORS *, and the standard envelope", async () => {
  installMock({ tables: wireTables });
  const res = await worker.fetch(new Request("https://ufc-api.test/v1/ufc/wire?limit=5"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=15, s-maxage=30, stale-while-revalidate=120");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.length, 5);
  assert.equal(body.meta.api, "PropSports UFC");
  assert.ok(!Number.isNaN(Date.parse(body.meta.generated_at)));
  for (const k of ["newest_published_at", "count", "freshness_minutes", "fight_week", "live"]) assert.ok(k in body.meta, `wire meta missing ${k}`);
  const i = await call("/v1/ufc");
  assert.equal(i.body.data.endpoints.wire, "/v1/ufc/wire?limit=20");
});

/* ---- Fight DNA (docs/fight_dna_api.md) -------------------------------- */

const F_NODNA = "9d0e1f2a-dddd-4eee-8fff-000011112222"; // fighter with no snapshot at all
const fighterNoDna = { ...fighterNoMedia, id: F_NODNA, espn_athlete_id: "5555555", name: "Nadia Nosnap", stance: "SOUTHPAW" };
const fighterOppSouthpaw = { ...fighterOpp, stance: "SOUTHPAW" };

const mo = (key, value, extra = {}) => ({
  metric_key: key, value, unit: "ratio", numerator: null, denominator: null,
  sample_bouts: 0, sample_rounds: 0, sample_seconds: 0,
  confidence: "insufficient", coverage_status: "insufficient", definition_version: 1,
  origin: "pbe_derived", source_families: ["ufcstats"], as_of_date: "2026-09-06", ...extra,
});
const HIGH = { sample_bouts: 8, sample_rounds: 22, sample_seconds: 6300, confidence: "high", coverage_status: "high" };
const MED = { sample_bouts: 6, sample_rounds: 18, sample_seconds: 5400, confidence: "medium", coverage_status: "medium" };
const LOW = { sample_bouts: 1, sample_rounds: 3, sample_seconds: 900, confidence: "low", coverage_status: "low" };
const NONE = { sample_bouts: 0, sample_rounds: 0, sample_seconds: 0, confidence: "insufficient", coverage_status: "insufficient" };

const split = (rec, extra = {}) => ({
  record: rec, ko_tko_wins: 0, submission_wins: 0, decision_wins: 0,
  finish_rate: mo("stance_finish_rate", null, NONE), ko_rate: mo("stance_ko_rate", null, NONE), sub_rate: mo("stance_sub_rate", null, NONE),
  sig_diff_per_min: mo("stance_sig_diff_per_min", null, NONE), kd_per_15: mo("stance_kd_rate_15", null, NONE), td_landed_per_15: mo("stance_td_rate_15", null, NONE),
  stat_bouts: 0, stat_rounds: 0, observed_seconds: 0, confidence: "insufficient", ...extra,
});

function stricklandMetrics(sample) {
  return {
    sig_landed_per_min: mo("sig_landed_per_min", 5.9, { unit: "per_min", numerator: 620, denominator: 6300, ...sample }),
    sig_absorbed_per_min: mo("sig_absorbed_per_min", 4.1, { unit: "per_min", ...sample }),
    sig_accuracy: mo("sig_accuracy", 0.41, sample),
    sig_defense: mo("sig_defense", 0.62, sample),
    head_attack_share: mo("head_attack_share", 0.72, sample),
    body_attack_share: mo("body_attack_share", 0.16, sample),
    leg_attack_share: mo("leg_attack_share", 0.12, sample),
    distance_attack_share: mo("distance_attack_share", 0.88, sample),
    clinch_attack_share: mo("clinch_attack_share", 0.08, sample),
    ground_attack_share: mo("ground_attack_share", 0.04, sample),
    knockdowns_per_15: mo("knockdowns_per_15", 0.4, { unit: "per_15", ...sample }),
    td_attempts_per_15: mo("td_attempts_per_15", 0.6, { unit: "per_15", ...sample }),
    td_accuracy: mo("td_accuracy", 0.3, sample),
    control_seconds_per_td: mo("control_seconds_per_td", 45, { unit: "seconds_per_td", ...sample }),
    sub_attempts_per_15: mo("sub_attempts_per_15", 0.1, { unit: "per_15", ...sample }),
    pace_retention_r2_vs_r1: mo("pace_retention_r2_vs_r1", 0.97, MED),
    pace_retention_r3_vs_r1: mo("pace_retention_r3_vs_r1", 0.94, MED),
    finish_rate: mo("finish_rate", 0.33, { numerator: 3, denominator: 9, sample_bouts: 9, confidence: "high", coverage_status: "high", source_families: ["espn", "ufcstats"] }),
  };
}

const stricklandSnapshot = (asOf, sample, extra = {}) => ({
  fighter_id: F_MEDIA, as_of_date: asOf, definition_version: 1,
  sample_bouts: 12, sample_completed_bouts: 12, sample_stat_bouts: sample.sample_bouts, sample_rounds: sample.sample_rounds, sample_seconds: sample.sample_seconds,
  coverage_status: sample.coverage_status,
  metrics: stricklandMetrics(sample),
  stance_splits: {
    SOUTHPAW: split({ w: 4, l: 1, d: 0, nc: 0, appearances: 5 }, { ko_tko_wins: 1, submission_wins: 1, decision_wins: 2, finish_rate: mo("stance_finish_rate", 0.5, { numerator: 2, denominator: 4, sample_bouts: 4, confidence: "medium", coverage_status: "medium" }), ko_rate: mo("stance_ko_rate", 0.2, { sample_bouts: 5, confidence: "medium" }), stat_bouts: 3, stat_rounds: 9, observed_seconds: 2700, confidence: "medium" }),
    ORTHODOX: split({ w: 6, l: 1, d: 0, nc: 0, appearances: 7 }, { decision_wins: 6, finish_rate: mo("stance_finish_rate", 0, { sample_bouts: 6, confidence: "medium" }), confidence: "medium" }),
    SWITCH: split({ w: 1, l: 1, d: 0, nc: 0, appearances: 2 }, { decision_wins: 1, confidence: "low" }),
    UNKNOWN: split({ w: 0, l: 0, d: 0, nc: 0, appearances: 0 }),
    open: split({ w: 4, l: 1, d: 0, nc: 0, appearances: 5 }, { confidence: "medium" }),
    same: split({ w: 6, l: 1, d: 0, nc: 0, appearances: 7 }, { confidence: "medium" }),
  },
  round_profile: {
    rounds: { "1": { sig_att_per_min: mo("r1_sig_att_per_min", 16.2, { unit: "per_min", ...sample }), rounds: 8, seconds: 2400 }, "3": { sig_att_per_min: mo("r3_sig_att_per_min", 15.2, { unit: "per_min", ...sample }), rounds: 6, seconds: 1800 } },
    pace_retention_r2_vs_r1: mo("pace_retention_r2_vs_r1", 0.97, MED),
    pace_retention_r3_vs_r1: mo("pace_retention_r3_vs_r1", 0.94, MED),
    championship_round_delta: mo("championship_round_delta", null, NONE),
    defensive_drift_r3_vs_r1: mo("defensive_drift_r3_vs_r1", 0.3, { unit: "per_min", ...MED }),
  },
  finish_profile: {
    finish_rate: mo("finish_rate", 0.33, { numerator: 3, denominator: 9, sample_bouts: 9, confidence: "high", coverage_status: "high" }),
    ko_finish_rate: mo("ko_finish_rate", 0.22, { sample_bouts: 9, confidence: "high" }),
    submission_finish_rate: mo("submission_finish_rate", 0.11, { sample_bouts: 9, confidence: "high" }),
    finish_round_distribution: mo("finish_round_distribution", { buckets: { "1": 2, "2": 1, "3": 0, "4": 0, "5": 0 }, total: 3 }, { unit: "distribution", sample_bouts: 3, confidence: "medium" }),
    finish_time_median_sec: mo("finish_time_median_sec", 240, { unit: "seconds", sample_bouts: 3, confidence: "medium" }),
    finished_by: { ko_tko: 2, submission: 1 },
  },
  context_splits: { three_round: split({ w: 7, l: 2, d: 0, nc: 0, appearances: 9 }), five_round: split({ w: 2, l: 1, d: 0, nc: 0, appearances: 3 }) },
  position_profile: {},
  archetype: null,
  provenance: { bouts: [B_PAST], watermark: { results_captured_at: "2025-04-14T00:00:00Z" }, build_run_id: "run-1" },
  generated_at: "2026-09-06T12:00:00Z",
  ...extra,
});

// Opponent: one stat-covered bout -> rate metrics low, pace retention insufficient (needs 2 bouts), finish rate insufficient (1 win).
const oppSnapshot = (asOf, extra = {}) => ({
  fighter_id: F_OPP, as_of_date: asOf, definition_version: 1,
  sample_bouts: 3, sample_completed_bouts: 3, sample_stat_bouts: 1, sample_rounds: 3, sample_seconds: 900, coverage_status: "low",
  metrics: {
    sig_landed_per_min: mo("sig_landed_per_min", 4.0, { unit: "per_min", ...LOW }),
    sig_absorbed_per_min: mo("sig_absorbed_per_min", 6.2, { unit: "per_min", ...LOW }),
    head_attack_share: mo("head_attack_share", 0.5, LOW),
    body_attack_share: mo("body_attack_share", 0.2, LOW),
    leg_attack_share: mo("leg_attack_share", 0.3, LOW),
    distance_attack_share: mo("distance_attack_share", 0.6, LOW),
    clinch_attack_share: mo("clinch_attack_share", 0.25, LOW),
    ground_attack_share: mo("ground_attack_share", 0.15, LOW),
    knockdowns_per_15: mo("knockdowns_per_15", 0, { unit: "per_15", ...LOW }),
    td_attempts_per_15: mo("td_attempts_per_15", 3.0, { unit: "per_15", ...LOW }),
    td_accuracy: mo("td_accuracy", 0.5, LOW),
    control_seconds_per_td: mo("control_seconds_per_td", 40, { unit: "seconds_per_td", ...LOW }),
    sub_attempts_per_15: mo("sub_attempts_per_15", 0, { unit: "per_15", ...LOW }),
    pace_retention_r2_vs_r1: mo("pace_retention_r2_vs_r1", 0.8, { sample_bouts: 1, sample_rounds: 3, sample_seconds: 900, confidence: "insufficient", coverage_status: "low" }),
    pace_retention_r3_vs_r1: mo("pace_retention_r3_vs_r1", 0.7, { sample_bouts: 1, sample_rounds: 3, sample_seconds: 900, confidence: "insufficient", coverage_status: "low" }),
    finish_rate: mo("finish_rate", 1, { numerator: 1, denominator: 1, sample_bouts: 1, confidence: "insufficient" }),
  },
  stance_splits: {
    ORTHODOX: split({ w: 1, l: 1, d: 0, nc: 0, appearances: 2 }, { ko_tko_wins: 1, confidence: "low" }),
    SOUTHPAW: split({ w: 0, l: 1, d: 0, nc: 0, appearances: 1 }, { confidence: "insufficient" }),
    open: split({ w: 1, l: 1, d: 0, nc: 0, appearances: 2 }, { confidence: "low" }),
    same: split({ w: 0, l: 1, d: 0, nc: 0, appearances: 1 }),
  },
  round_profile: { rounds: { "1": { sig_att_per_min: mo("r1_sig_att_per_min", 12, { unit: "per_min", ...LOW }), rounds: 1, seconds: 300 } }, pace_retention_r3_vs_r1: mo("pace_retention_r3_vs_r1", 0.7, { sample_bouts: 1, sample_rounds: 3, sample_seconds: 900, confidence: "insufficient", coverage_status: "low" }) },
  finish_profile: { finish_rate: mo("finish_rate", 1, { numerator: 1, denominator: 1, sample_bouts: 1, confidence: "insufficient" }), finished_by: { ko_tko: 1, submission: 0 } },
  context_splits: {},
  position_profile: {},
  archetype: null,
  provenance: { bouts: [B_PAST], build_run_id: "run-1" },
  generated_at: "2026-09-06T12:00:00Z",
  ...extra,
});

// Zero-coverage fighter: results exist, no round rows -> every rate metric null + insufficient, empty round profile.
const nullMetrics = Object.fromEntries(["sig_landed_per_min", "sig_absorbed_per_min", "head_attack_share", "body_attack_share", "leg_attack_share", "distance_attack_share", "clinch_attack_share", "ground_attack_share", "knockdowns_per_15", "td_attempts_per_15", "td_accuracy", "control_seconds_per_td", "sub_attempts_per_15", "pace_retention_r2_vs_r1", "pace_retention_r3_vs_r1"].map((k) => [k, mo(k, null, NONE)]));
const zeroSnapshot = {
  fighter_id: F_NOMEDIA, as_of_date: "2026-09-06", definition_version: 1,
  sample_bouts: 2, sample_completed_bouts: 2, sample_stat_bouts: 0, sample_rounds: 0, sample_seconds: 0, coverage_status: "insufficient",
  metrics: { ...nullMetrics, finish_rate: mo("finish_rate", 0, { numerator: 0, denominator: 1, sample_bouts: 1, confidence: "insufficient" }) },
  stance_splits: { ORTHODOX: split({ w: 1, l: 1, d: 0, nc: 0, appearances: 2 }, { decision_wins: 1, confidence: "low" }), UNKNOWN: split({ w: 0, l: 0, d: 0, nc: 0, appearances: 0 }) },
  round_profile: {},
  finish_profile: { finish_rate: mo("finish_rate", 0, { numerator: 0, denominator: 1, sample_bouts: 1, confidence: "insufficient" }), finished_by: { ko_tko: 0, submission: 0 } },
  context_splits: {},
  position_profile: {},
  archetype: null,
  provenance: { bouts: [], build_run_id: "run-1" },
  generated_at: "2026-09-06T12:00:00Z",
};

const dnaSnapshots = [
  stricklandSnapshot("2026-09-06", HIGH),
  stricklandSnapshot("2025-04-14", MED, { provenance: { bouts: [B_PAST], build_run_id: "run-0" } }),   // includes the 2025-04-13 bout
  stricklandSnapshot("2024-01-01", LOW, { sample_bouts: 10, provenance: { bouts: [], build_run_id: "run-0" } }), // before it
  oppSnapshot("2026-09-06"),
  // an older opponent snapshot that would pass a pace filter: must never qualify because the latest one fails
  oppSnapshot("2025-01-01", { metrics: { ...oppSnapshot("2025-01-01").metrics, pace_retention_r3_vs_r1: mo("pace_retention_r3_vs_r1", 0.95, MED) } }),
  zeroSnapshot,
];

const splitRow = (fighterId, asOf, stance, rec, extra = {}) => ({
  fighter_id: fighterId, as_of_date: asOf, opponent_stance: stance, definition_version: 1,
  appearances: rec.appearances, wins: rec.w, losses: rec.l, draws: rec.d, no_contests: rec.nc,
  ko_tko_wins: 0, submission_wins: 0, decision_wins: 0, stat_bouts: 0, stat_rounds: 0, observed_seconds: 0,
  metrics: { finish_rate: mo("stance_finish_rate", null, NONE), ko_rate: mo("stance_ko_rate", null, NONE), sub_rate: mo("stance_sub_rate", null, NONE), sig_diff_per_min: mo("stance_sig_diff_per_min", null, NONE), kd_per_15: mo("stance_kd_rate_15", null, NONE), td_landed_per_15: mo("stance_td_rate_15", null, NONE) },
  confidence: "insufficient", provenance: { build_run_id: "run-1" }, generated_at: "2026-09-06T12:00:00Z", ...extra,
});
const dnaSplits = [
  splitRow(F_MEDIA, "2026-09-06", "SOUTHPAW", { w: 4, l: 1, d: 0, nc: 0, appearances: 5 }, { ko_tko_wins: 1, submission_wins: 1, decision_wins: 2, stat_bouts: 3, stat_rounds: 9, observed_seconds: 2700, confidence: "medium",
    metrics: { finish_rate: mo("stance_finish_rate", 0.5, { sample_bouts: 4, confidence: "medium" }), ko_rate: mo("stance_ko_rate", 0.2, { sample_bouts: 5, confidence: "medium" }), sub_rate: mo("stance_sub_rate", 0.2, { sample_bouts: 5, confidence: "medium" }), sig_diff_per_min: mo("stance_sig_diff_per_min", 1.4, { unit: "per_min", sample_bouts: 3, sample_rounds: 9, sample_seconds: 2700, confidence: "medium" }), kd_per_15: mo("stance_kd_rate_15", 0.33, { unit: "per_15", sample_bouts: 3, confidence: "medium" }), td_landed_per_15: mo("stance_td_rate_15", 0, { unit: "per_15", sample_bouts: 3, confidence: "medium" }) } }),
  splitRow(F_MEDIA, "2026-09-06", "ORTHODOX", { w: 6, l: 1, d: 0, nc: 0, appearances: 7 }, { decision_wins: 6, confidence: "medium", metrics: { finish_rate: mo("stance_finish_rate", 0, { sample_bouts: 6, confidence: "medium" }), ko_rate: mo("stance_ko_rate", 0, { sample_bouts: 7, confidence: "medium" }) } }),
  splitRow(F_MEDIA, "2026-09-06", "SWITCH", { w: 1, l: 1, d: 0, nc: 0, appearances: 2 }, { decision_wins: 1, confidence: "low" }),
  splitRow(F_MEDIA, "2026-09-06", "UNKNOWN", { w: 0, l: 0, d: 0, nc: 0, appearances: 0 }),
  splitRow(F_MEDIA, "2025-04-14", "SOUTHPAW", { w: 3, l: 1, d: 0, nc: 0, appearances: 4 }, { confidence: "medium" }),
  splitRow(F_MEDIA, "2025-04-14", "ORTHODOX", { w: 5, l: 1, d: 0, nc: 0, appearances: 6 }, { confidence: "medium" }),
  splitRow(F_OPP, "2026-09-06", "ORTHODOX", { w: 1, l: 1, d: 0, nc: 0, appearances: 2 }, { ko_tko_wins: 1, confidence: "low", metrics: { ko_rate: mo("stance_ko_rate", 0.5, { sample_bouts: 2, confidence: "low" }) } }),
  splitRow(F_OPP, "2026-09-06", "SOUTHPAW", { w: 0, l: 1, d: 0, nc: 0, appearances: 1 }),
];

const metricDef = (metric_key, family, extra = {}) => ({
  metric_key, definition_version: 1, family, display_name: metric_key, description: `${metric_key} description`, unit: "ratio", formula: "x / y",
  source_families: ["ufcstats"], min_bouts: 1, min_rounds: 2, min_seconds: 300, public: true, active: true, updated_at: "2026-09-06T00:00:00Z", ...extra,
});
const dnaDefinitions = [
  metricDef("sig_landed_per_min", "striking", { unit: "per_min" }),
  metricDef("head_attack_share", "striking"),
  metricDef("pace_retention_r3_vs_r1", "pace", { min_bouts: 2, min_rounds: 6, min_seconds: 900 }),
  metricDef("td_accuracy", "grappling"),
  metricDef("stance_ko_rate", "stance", { min_bouts: 2, min_rounds: 0, min_seconds: 0, source_families: ["espn", "ufcstats"] }),
  metricDef("finish_rate", "finish", { min_bouts: 2, min_rounds: 0, min_seconds: 0 }),
  metricDef("retired_metric", "striking", { active: false }),
  metricDef("internal_metric", "composite", { public: false }),
];

const dnaTables = {
  ...fullTables,
  ufc_fighters: [fighterMedia, fighterNoMedia, fighterOppSouthpaw, fighterNoDna],
  ufc_dna_metric_definitions: dnaDefinitions,
  ufc_fighter_dna_snapshots: dnaSnapshots,
  ufc_fighter_stance_splits: dnaSplits,
};
const DNA_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=900";
const TIERS = ["low", "medium", "high"];

async function callRaw(path) {
  const res = await worker.fetch(new Request(`https://ufc-api.test${path}`), env);
  return { res, body: await res.json() };
}

test("dna helpers: confidence gate, alias lookup, stance normalization, as_of validation", () => {
  assert.equal(__test.meetsConfidence(mo("x", 0.5, { confidence: "low" })), true);
  assert.equal(__test.meetsConfidence(mo("x", 0.5, { confidence: "insufficient" })), false, "insufficient never qualifies");
  assert.equal(__test.meetsConfidence(mo("x", null, { confidence: "high" })), false, "null value never qualifies");
  assert.equal(__test.meetsConfidence(mo("x", 0.5, { confidence: "low" }), "medium"), false);
  assert.equal(__test.meetsConfidence(null), false);
  const snap = __test.snapshotView(stricklandSnapshot("2026-09-06", HIGH));
  assert.equal(__test.findMetric(snap, { key: "kd_per_15", aliases: ["knockdowns_per_15"] }).value, 0.4, "alias resolves the registry spelling");
  assert.equal(__test.findMetric(snap, { key: "pace_retention_r3_vs_r1" }).value, 0.94, "round_profile is searched");
  assert.equal(__test.findMetric(snap, { key: "nope" }), null);
  assert.equal(__test.normalizeStance(" southpaw "), "SOUTHPAW");
  assert.equal(__test.normalizeStance("open stance"), "OPEN_STANCE");
  assert.equal(__test.normalizeStance(null), null);
  assert.equal(__test.stanceMatchupContext("ORTHODOX", "SOUTHPAW"), "open");
  assert.equal(__test.stanceMatchupContext("ORTHODOX", "ORTHODOX"), "same");
  assert.equal(__test.stanceMatchupContext("SWITCH", "ORTHODOX"), "switch_involved");
  assert.equal(__test.stanceMatchupContext(null, "ORTHODOX"), "unknown");
  assert.equal(__test.parseAsOf(new URL("https://x/?as_of=2026-09-06")), "2026-09-06");
  assert.equal(__test.parseAsOf(new URL("https://x/")), null);
  assert.throws(() => __test.parseAsOf(new URL("https://x/?as_of=2026-02-30")), (e) => e.code === "invalid_as_of");
  assert.throws(() => __test.parseAsOf(new URL("https://x/?as_of=yesterday")), (e) => e.code === "invalid_as_of");
  assert.equal(__test.fmtSample({ sample_bouts: 5, sample_rounds: 13, sample_seconds: 3720 }), "5 bouts / 13 rounds / 62.0 min");
  assert.equal(__test.fmtValue(0.94, "ratio"), "94%");
  assert.equal(__test.fmtValue(null, "ratio"), "n/a");
  assert.equal(__test.DNA_COMPARISONS.length, 18);
});

test("GET /v1/ufc/dna/metrics returns active public registry rows grouped by family", async () => {
  installMock({ tables: dnaTables });
  const { res, body } = await callRaw("/v1/ufc/dna/metrics");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), DNA_CACHE);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(body.data.definition_version, 1);
  assert.deepEqual(Object.keys(body.data.families), ["stance", "striking", "pace", "grappling", "finish"], "registry family order");
  assert.deepEqual(body.data.metrics.map((m) => m.metric_key), ["stance_ko_rate", "head_attack_share", "sig_landed_per_min", "pace_retention_r3_vs_r1", "td_accuracy", "finish_rate"]);
  assert.ok(!body.data.metrics.some((m) => m.metric_key === "retired_metric" || m.metric_key === "internal_metric"), "inactive / non-public rows excluded");
  assert.equal(body.data.metrics[0].origin, "pbe_derived");
  assert.equal(body.data.families.pace[0].min_bouts, 2);
  assert.ok(body.data.confidence_tiers.insufficient && body.data.as_of_semantics.includes("exclusive"));
  assert.deepEqual(body.data.origin_labels, { pbe_derived: "PBE DERIVED", source: "SOURCE", licensed: "LICENSED", model: "MODEL" });
  assert.equal(body.meta.count, 6);
  installMock({ tables: dnaTables, missingTables: ["ufc_dna_metric_definitions"] });
  const gone = await call("/v1/ufc/dna/metrics");
  assert.equal(gone.status, 503);
  assert.equal(gone.body.error.code, "dna_not_available");
  assert.equal(gone.body.data, null);
  assert.equal(gone.body.error.detail.reason, "schema_not_applied");
});

test("fighter DNA: latest snapshot for a high-coverage fighter, resolvable by every id form", async () => {
  installMock({ tables: dnaTables });
  const { res, body } = await callRaw("/v1/ufc/fighters/0d8011111be000b2/dna");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), DNA_CACHE);
  const d = body.data;
  assert.equal(d.fighter.id, F_MEDIA);
  assert.equal(d.fighter.slug_id, "3093653");
  assert.equal(d.fighter.stance, "ORTHODOX");
  assert.equal(d.fighter.primary_image.thumb_url, `${MEDIA_BASE}/fighters/${F_MEDIA}/thumb.jpg`);
  assert.equal(d.snapshot.as_of_date, "2026-09-06", "latest snapshot when no as_of");
  assert.equal(d.snapshot.coverage_status, "high");
  assert.equal(d.snapshot.sample_stat_bouts, 8);
  assert.equal(d.snapshot.origin, "pbe_derived");
  for (const k of ["metrics", "stance_splits", "round_profile", "finish_profile", "context_splits", "position_profile", "provenance"]) assert.ok(k in d.snapshot, `snapshot missing ${k}`);
  const m = d.snapshot.metrics.sig_landed_per_min;
  assert.deepEqual([m.value, m.unit, m.numerator, m.denominator, m.sample_bouts, m.sample_rounds, m.sample_seconds, m.confidence, m.coverage_status, m.definition_version, m.origin], [5.9, "per_min", 620, 6300, 8, 22, 6300, "high", "high", 1, "pbe_derived"], "sample context is never stripped");
  assert.equal(d.snapshot.stance_splits.SOUTHPAW.record.appearances, 5);
  assert.equal(d.snapshot.round_profile.pace_retention_r3_vs_r1.value, 0.94);
  assert.deepEqual(d.snapshot.position_profile, {});
  assert.equal(body.meta.resolved_as_of, "2026-09-06");
  assert.equal(body.meta.requested_as_of, null);
  assert.equal(body.meta.definition_version, 1);
  assert.ok(body.meta.as_of_semantics.includes("excluded by the snapshot dated D"));
  const byEspn = await call("/v1/ufc/fighters/3093653/dna");
  const byUuid = await call(`/v1/ufc/fighters/${F_MEDIA}/dna`);
  assert.equal(byEspn.body.data.fighter.id, F_MEDIA);
  assert.equal(byUuid.body.data.snapshot.as_of_date, "2026-09-06");
});

test("fighter DNA as_of resolution picks the prior snapshot so a bout on the as_of date is excluded", async () => {
  installMock({ tables: dnaTables });
  // The 2025-04-13 bout is inside the snapshot dated 2025-04-14 (exclusive as_of). Asking as_of the fight date must step back.
  const fightDay = await call(`/v1/ufc/fighters/${F_MEDIA}/dna?as_of=2025-04-13`);
  assert.equal(fightDay.status, 200);
  assert.equal(fightDay.body.data.snapshot.as_of_date, "2024-01-01");
  assert.deepEqual(fightDay.body.data.snapshot.provenance.bouts, [], "no bout from the as_of date leaks in");
  assert.equal(fightDay.body.meta.requested_as_of, "2025-04-13");
  assert.equal(fightDay.body.meta.resolved_as_of, "2024-01-01");
  const dayAfter = await call(`/v1/ufc/fighters/${F_MEDIA}/dna?as_of=2025-04-14`);
  assert.equal(dayAfter.body.data.snapshot.as_of_date, "2025-04-14");
  assert.deepEqual(dayAfter.body.data.snapshot.provenance.bouts, [B_PAST]);
  const future = await call(`/v1/ufc/fighters/${F_MEDIA}/dna?as_of=2030-01-01`);
  assert.equal(future.body.data.snapshot.as_of_date, "2026-09-06");
  const tooEarly = await call(`/v1/ufc/fighters/${F_MEDIA}/dna?as_of=2023-01-01`);
  assert.equal(tooEarly.status, 404);
  assert.equal(tooEarly.body.error.code, "dna_not_available");
  assert.equal(tooEarly.body.data, null);
  assert.equal(tooEarly.body.error.detail.reason, "no_snapshot_at_or_before_as_of");
  const bad = await call(`/v1/ufc/fighters/${F_MEDIA}/dna?as_of=13-04-2025`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_as_of");
  const v2 = await call(`/v1/ufc/fighters/${F_MEDIA}/dna?version=2`);
  assert.equal(v2.status, 404, "an unbuilt definition version is explicit, never faked");
});

test("fighter DNA: zero-coverage fighter returns explicit nulls, no snapshot is dna_not_available, missing schema is 503", async () => {
  installMock({ tables: dnaTables });
  const zero = await call(`/v1/ufc/fighters/${F_NOMEDIA}/dna`);
  assert.equal(zero.status, 200);
  const s = zero.body.data.snapshot;
  assert.equal(s.coverage_status, "insufficient");
  assert.equal(s.sample_stat_bouts, 0);
  assert.equal(s.sample_seconds, 0);
  for (const k of ["sig_landed_per_min", "head_attack_share", "td_accuracy", "pace_retention_r3_vs_r1"]) {
    assert.equal(s.metrics[k].value, null, `${k} must be null with no denominator`);
    assert.equal(s.metrics[k].confidence, "insufficient");
  }
  assert.deepEqual(s.round_profile, {});
  assert.equal(zero.body.data.fighter.primary_image, null);
  const rp = await call(`/v1/ufc/fighters/${F_NOMEDIA}/round-profile`);
  assert.equal(rp.status, 200);
  assert.equal(rp.body.data.available, false);
  assert.equal(rp.body.data.status, "insufficient_coverage");
  assert.equal(rp.body.data.round_profile, null);
  assert.ok(rp.body.data.note.includes("0 stat-covered bouts"));
  // The builder may store the full round_profile structure with null-valued MetricObjects: still explicitly unavailable, and the nulls stay visible.
  installMock({ tables: { ...dnaTables, ufc_fighter_dna_snapshots: [...dnaSnapshots.filter((s) => s.fighter_id !== F_NOMEDIA), { ...zeroSnapshot, round_profile: { rounds: {}, pace_retention_r2_vs_r1: mo("pace_retention_r2_vs_r1", null, NONE), pace_retention_r3_vs_r1: mo("pace_retention_r3_vs_r1", null, NONE) } }] } });
  const structured = await call(`/v1/ufc/fighters/${F_NOMEDIA}/round-profile`);
  assert.equal(structured.body.data.available, false);
  assert.equal(structured.body.data.status, "insufficient_coverage");
  assert.equal(structured.body.data.round_profile.pace_retention_r3_vs_r1.value, null, "null-valued metrics stay visible");
  assert.equal(__test.familyHasValues({ a: mo("a", null, NONE) }), false);
  assert.equal(__test.familyHasValues({ rounds: { "1": { sig_att_per_min: mo("x", 12, LOW) } } }), true);
  assert.equal(__test.familyHasValues({ d: mo("d", { buckets: {}, total: 0 }, NONE) }), false);
  assert.equal(__test.familyHasValues({}), false);
  installMock({ tables: dnaTables });
  const none = await call(`/v1/ufc/fighters/${F_NODNA}/dna`);
  assert.equal(none.status, 404);
  assert.equal(none.body.ok, false);
  assert.equal(none.body.data, null);
  assert.equal(none.body.error.code, "dna_not_available");
  assert.equal(none.body.error.detail.reason, "no_snapshot");
  const unknown = await call("/v1/ufc/fighters/00000000-0000-4000-8000-000000000000/dna");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "fighter_not_found");
  installMock({ tables: dnaTables, missingTables: ["ufc_fighter_dna_snapshots"] });
  const schema = await call(`/v1/ufc/fighters/${F_MEDIA}/dna`);
  assert.equal(schema.status, 503);
  assert.equal(schema.body.error.code, "dna_not_available");
  assert.equal(schema.body.data, null);
  const family = await call(`/v1/ufc/fighters/${F_MEDIA}/finish-profile`);
  assert.equal(family.status, 503);
  const matchup = await call(`/v1/ufc/matchups/${F_MEDIA}/${F_OPP}/dna`);
  assert.equal(matchup.status, 503);
});

test("fighter splits: all stances in canonical order, one stance filter, as_of, unknown stance rejected", async () => {
  installMock({ tables: dnaTables });
  const { res, body } = await callRaw("/v1/ufc/fighters/0d8011111be000b2/splits");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), DNA_CACHE);
  assert.equal(body.data.as_of_date, "2026-09-06");
  assert.deepEqual(body.data.splits.map((s) => s.opponent_stance), ["ORTHODOX", "SOUTHPAW", "SWITCH", "UNKNOWN"]);
  assert.equal("split" in body.data, false);
  const sp = body.data.splits[1];
  assert.deepEqual(sp.record, { w: 4, l: 1, d: 0, nc: 0, appearances: 5 });
  assert.equal(sp.record.w + sp.record.l + sp.record.d + sp.record.nc, sp.appearances, "record reconciles to appearances");
  assert.equal(sp.ko_tko_wins + sp.submission_wins + sp.decision_wins, sp.wins, "win methods reconcile to wins");
  assert.equal(sp.metrics.ko_rate.value, 0.2);
  assert.equal(sp.confidence, "medium");
  assert.equal(sp.origin, "pbe_derived");
  assert.equal(body.meta.count, 4);
  assert.equal(body.data.fighter.primary_image.kind, "wikimedia");

  const one = await call(`/v1/ufc/fighters/${F_MEDIA}/splits?opponent_stance=southpaw`);
  assert.equal(one.body.data.opponent_stance, "SOUTHPAW");
  assert.equal(one.body.data.splits.length, 1);
  assert.equal(one.body.data.split.opponent_stance, "SOUTHPAW");
  assert.equal(one.body.data.split.record.appearances, 5);
  assert.equal(one.body.meta.opponent_stance, "SOUTHPAW");

  const older = await call(`/v1/ufc/fighters/${F_MEDIA}/splits?as_of=2025-04-14&opponent_stance=SOUTHPAW`);
  assert.equal(older.body.data.as_of_date, "2025-04-14");
  assert.equal(older.body.data.split.record.appearances, 4);
  const stepBack = await call(`/v1/ufc/fighters/${F_MEDIA}/splits?as_of=2026-01-01`);
  assert.equal(stepBack.body.data.as_of_date, "2025-04-14", "latest as_of <= requested");
  assert.equal(stepBack.body.meta.resolved_as_of, "2025-04-14");

  const absent = await call(`/v1/ufc/fighters/${F_OPP}/splits?opponent_stance=SWITCH`);
  assert.equal(absent.status, 200);
  assert.equal(absent.body.data.split, null, "no row -> explicit null, never synthesized");
  assert.deepEqual(absent.body.data.splits, []);
  assert.ok(absent.body.meta.note.includes("null"));

  const bad = await call(`/v1/ufc/fighters/${F_MEDIA}/splits?opponent_stance=karate`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_stance");
  assert.deepEqual(bad.body.error.detail.allowed, __test.DNA_STANCES);
  const noRows = await call(`/v1/ufc/fighters/${F_NOMEDIA}/splits`);
  assert.equal(noRows.status, 404);
  assert.equal(noRows.body.error.code, "dna_not_available");
  installMock({ tables: dnaTables, missingTables: ["ufc_fighter_stance_splits"] });
  const gone = await call(`/v1/ufc/fighters/${F_MEDIA}/splits`);
  assert.equal(gone.status, 503);
});

test("round-profile / finish-profile return the family with sample context; position-profile is licensed_data_not_available", async () => {
  installMock({ tables: dnaTables });
  const rp = await call("/v1/ufc/fighters/0d8011111be000b2/round-profile");
  assert.equal(rp.status, 200);
  assert.equal(rp.body.data.available, true);
  assert.equal(rp.body.data.status, "ok");
  assert.equal(rp.body.data.round_profile.pace_retention_r3_vs_r1.value, 0.94);
  assert.equal(rp.body.data.round_profile.rounds["1"].sig_att_per_min.value, 16.2);
  assert.deepEqual(rp.body.data.sample, { sample_bouts: 12, sample_completed_bouts: 12, sample_stat_bouts: 8, sample_rounds: 22, sample_seconds: 6300, sample_minutes: 105, coverage_status: "high" });
  assert.equal(rp.body.data.origin, "pbe_derived");
  assert.equal(rp.body.meta.family, "round_profile");
  const asOf = await call(`/v1/ufc/fighters/${F_MEDIA}/round-profile?as_of=2025-04-13`);
  assert.equal(asOf.body.data.as_of_date, "2024-01-01");

  const fp = await call(`/v1/ufc/fighters/${F_MEDIA}/finish-profile`);
  assert.equal(fp.body.data.finish_profile.finish_rate.value, 0.33);
  assert.deepEqual(fp.body.data.finish_profile.finished_by, { ko_tko: 2, submission: 1 });
  assert.deepEqual(fp.body.data.finish_profile.finish_round_distribution.value, { buckets: { "1": 2, "2": 1, "3": 0, "4": 0, "5": 0 }, total: 3 });
  assert.equal(fp.body.data.status, "ok");

  const pp = await call(`/v1/ufc/fighters/${F_MEDIA}/position-profile`);
  assert.equal(pp.status, 200);
  assert.equal(pp.body.data.available, false);
  assert.equal(pp.body.data.status, "licensed_data_not_available");
  assert.equal(pp.body.data.position_profile, null);
  assert.ok(pp.body.data.note.includes("licensed"));
  assert.equal(pp.body.data.sample.sample_stat_bouts, 8, "sample context still present");
  assert.equal(pp.body.meta.status, "licensed_data_not_available");
});

test("matchup DNA emits insights only above thresholds and names every missing sample in warnings", async () => {
  installMock({ tables: dnaTables });
  const { res, body } = await callRaw(`/v1/ufc/matchups/0d8011111be000b2/${F_OPP}/dna`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), DNA_CACHE);
  const d = body.data;
  assert.deepEqual(d.fighters.map((f) => [f.id, f.stance]), [[F_MEDIA, "ORTHODOX"], [F_OPP, "SOUTHPAW"]]);
  assert.equal(d.fighters[0].primary_image.kind, "wikimedia");
  assert.equal(d.a.as_of_date, "2026-09-06");
  assert.equal(d.b.coverage_status, "low");
  for (const k of ["provenance", "context_splits", "position_profile"]) assert.equal(k in d.a, false, `matchup subset must not carry ${k}`);

  // comparisons: one per paired metric, aliases resolved, delta/direction only when both sides are numeric
  assert.deepEqual(d.comparisons.map((c) => c.key), __test.DNA_COMPARISONS.map((c) => c.key));
  const by = Object.fromEntries(d.comparisons.map((c) => [c.key, c]));
  assert.equal(by.kd_per_15.a.value, 0.4, "knockdowns_per_15 alias resolved");
  assert.equal(by.head_attack_share.delta, 0.22);
  assert.equal(by.head_attack_share.direction, "a");
  assert.equal(by.td_attempts_per_15.delta, -2.4);
  assert.equal(by.td_attempts_per_15.direction, "b");
  assert.equal(by.sig_absorbed_per_min.higher_is_better, false);
  assert.equal(by.sig_accuracy.b, null);
  assert.equal(by.sig_accuracy.delta, null);
  assert.equal(by.sig_accuracy.direction, null);
  assert.equal(by.sig_accuracy.comparable, false);
  assert.equal(by.pace_retention_r3_vs_r1.min_confidence, "insufficient", "the weaker side's confidence governs");

  // stance context: A's split vs B's listed stance (southpaw) and B's vs A's (orthodox)
  assert.equal(d.stance_context.context, "open");
  assert.equal(d.stance_context.a_vs_b_stance.opponent_stance, "SOUTHPAW");
  assert.equal(d.stance_context.a_vs_b_stance.meets_threshold, true);
  assert.equal(d.stance_context.a_vs_b_stance.split.record.appearances, 5);
  assert.equal(d.stance_context.b_vs_a_stance.opponent_stance, "ORTHODOX");
  assert.equal(d.stance_context.b_vs_a_stance.meets_threshold, false, "2 appearances < 3");
  assert.equal(d.stance_context.a_context_split.record.appearances, 5);

  const keys = d.insights.map((i) => i.key);
  assert.deepEqual(keys, [
    "a_vs_southpaw_record", "a_vs_southpaw_finish_rate",
    "a_pace_retention_r3_vs_r1",
    "head_attack_share_mismatch", "leg_attack_share_mismatch",
    "distance_attack_share_mismatch", "clinch_attack_share_mismatch", "ground_attack_share_mismatch",
    "td_attempts_per_15_mismatch", "td_accuracy_mismatch",
    "a_finish_rate",
  ]);
  for (const i of d.insights) {
    assert.ok(TIERS.includes(i.confidence), `${i.key}: confidence ${i.confidence} may not back an insight`);
    assert.ok(["a", "b", "contextual"].includes(i.direction), `${i.key}: direction`);
    assert.ok(typeof i.explanation === "string" && i.explanation.length > 20 && "sample_bouts" in i && "label" in i && "value" in i, `${i.key}: shape`);
    assert.equal(i.origin, "pbe_derived");
  }
  const rec = d.insights[0];
  assert.deepEqual(rec.record, { w: 4, l: 1, d: 0, nc: 0, appearances: 5 });
  assert.equal(rec.value, 0.8);
  assert.equal(rec.sample_bouts, 5);
  assert.equal(rec.confidence, "medium");
  assert.equal(rec.explanation, "Sean Strickland is 4-1-0 in 5 UFC bouts against southpaws (1 KO/TKO, 1 submission, 2 decision wins), PBE-derived from canonical results as of 2026-09-06.");
  assert.equal(d.insights[1].value, 0.5);
  assert.ok(d.insights[1].explanation.startsWith("50% of Sean Strickland's 4 wins against southpaws came by finish"));
  const pace = d.insights[2];
  assert.equal(pace.value, 0.94);
  assert.equal(pace.sample_bouts, 6);
  assert.equal(pace.explanation, "Sean Strickland kept 94% of round-one significant-strike attempt pace into round three across 6 bouts / 18 rounds / 90.0 min of stat-covered fights as of 2026-09-06.");
  const head = d.insights[3];
  assert.equal(head.value, 0.22);
  assert.equal(head.direction, "a");
  assert.equal(head.confidence, "low", "two-sided insight carries the weaker confidence");
  assert.equal(head.sample_bouts, 1, "binding (smaller) sample");
  assert.deepEqual(head.samples.b, { sample_bouts: 1, sample_rounds: 3, sample_seconds: 900, confidence: "low" });
  assert.ok(head.explanation.includes("Sean Strickland 72% (8 bouts / 22 rounds / 105.0 min) vs Opponent Person 50% (1 bout / 3 rounds / 15.0 min); delta +22% toward Sean Strickland"), head.explanation);
  assert.equal(d.insights.find((i) => i.key === "td_attempts_per_15_mismatch").direction, "b");
  assert.ok(!keys.includes("body_attack_share_mismatch"), "0.16 vs 0.20 is below the 0.10 mismatch threshold");
  assert.ok(!keys.includes("control_seconds_per_td_mismatch"), "45 vs 40 s is below the 30 s threshold");
  assert.ok(!keys.includes("b_vs_orthodox_record") && !keys.includes("b_pace_retention_r3_vs_r1") && !keys.includes("pace_retention_r3_vs_r1_mismatch") && !keys.includes("b_finish_rate"), "no insight below threshold");

  const w = d.warnings.join("\n");
  assert.ok(w.includes("Opponent Person vs orthodox opponents: 2 appearances, confidence low; needs >= 3 appearances"), w);
  assert.ok(w.includes("Opponent Person pace_retention_r3_vs_r1: confidence insufficient (1 bout / 3 rounds / 15.0 min); needs >= 2 stat-covered bouts"), w);
  assert.ok(w.includes("Opponent Person finish_rate: confidence insufficient (1 bout)"), w);
  assert.ok(!w.includes("Sig. strike accuracy"), "metrics without an insight family report comparable:false, not a warning");
  assert.equal(d.warnings.filter((x) => x.startsWith("Sean Strickland")).length, 0, "the high-coverage side has nothing missing");

  // Bettor's Edge evidence mirrors the insights one-to-one and never carries a pick
  assert.equal(d.bettors_edge_evidence.length, d.insights.length);
  assert.deepEqual(Object.keys(d.bettors_edge_evidence[0]), ["key", "label", "value", "unit", "side", "direction", "sample", "sample_bouts", "sample_rounds", "sample_seconds", "confidence", "origin", "origin_label", "explanation"]);
  assert.equal(d.bettors_edge_evidence[0].sample, "5 bouts / 9 rounds / 45.0 min");
  assert.equal(d.bettors_edge_evidence[0].origin_label, "PBE DERIVED");
  assert.ok(!/\b(pick|probability|price|odds)\b/i.test(JSON.stringify(d.bettors_edge_evidence)), "evidence only");
  assert.equal(d.note, "Fight DNA is PBE-derived evidence with explicit samples and confidence. It is not a pick, price or probability.");
  assert.deepEqual(body.meta.resolved_as_of, { a: "2026-09-06", b: "2026-09-06" });
  assert.equal(body.meta.insight_rules.stance_history.min_appearances, 3);
  assert.equal(body.meta.insights, 11);
  assert.equal(body.meta.comparable, 16);
});

test("matchup DNA against a zero-coverage fighter or a fighter without a snapshot never fabricates", async () => {
  installMock({ tables: dnaTables });
  const zero = await call(`/v1/ufc/matchups/${F_MEDIA}/${F_NOMEDIA}/dna`);
  assert.equal(zero.status, 200);
  const keys = zero.body.data.insights.map((i) => i.key);
  assert.ok(keys.every((k) => k.startsWith("a_")), `only a-side insights, got ${keys}`);
  // 0 finishes in 6 wins vs orthodox opponents is a real, medium-confidence observation: value 0 is emitted, never hidden.
  assert.deepEqual(keys, ["a_vs_orthodox_record", "a_vs_orthodox_finish_rate", "a_pace_retention_r3_vs_r1", "a_finish_rate"]);
  assert.equal(zero.body.data.insights[1].value, 0);
  assert.ok(zero.body.data.insights[1].explanation.startsWith("0% of Sean Strickland's 6 wins against orthodox opponents came by finish"));
  assert.ok(!keys.some((k) => k.endsWith("_mismatch")), "no mismatch insight when one side is insufficient");
  const w = zero.body.data.warnings.join("\n");
  assert.ok(w.includes("Aaron Nomedia pace_retention_r3_vs_r1: confidence insufficient (0 bouts)"), w);
  assert.ok(w.includes("Head attack share: Aaron Nomedia confidence insufficient (0 bouts)"), w);
  assert.ok(w.includes("Aaron Nomedia vs orthodox opponents: 2 appearances, confidence low; needs >= 3 appearances"), w);
  assert.equal(zero.body.data.stance_context.context, "same");
  assert.equal(zero.body.data.stance_context.b_vs_a_stance.meets_threshold, false);

  const one = await call(`/v1/ufc/matchups/${F_MEDIA}/${F_NODNA}/dna`);
  assert.equal(one.status, 200);
  assert.equal(one.body.data.b, null);
  assert.equal(one.body.data.a.as_of_date, "2026-09-06");
  assert.ok(one.body.data.warnings[0].includes("Nadia Nosnap: no Fight DNA snapshot"));
  assert.ok(one.body.data.insights.every((i) => i.side === "a"));
  assert.ok(one.body.data.comparisons.every((c) => c.b === null && c.delta === null));
  assert.deepEqual(one.body.meta.resolved_as_of, { a: "2026-09-06", b: null });

  const both = await call(`/v1/ufc/matchups/${F_NODNA}/00000000-0000-4000-8000-000000000000/dna`);
  assert.equal(both.status, 404);
  assert.equal(both.body.error.code, "fighter_not_found");
  const same = await call(`/v1/ufc/matchups/${F_MEDIA}/3093653/dna`);
  assert.equal(same.status, 400);
  assert.equal(same.body.error.code, "invalid_matchup");
  const asOf = await call(`/v1/ufc/matchups/${F_MEDIA}/${F_OPP}/dna?as_of=2025-04-13`);
  assert.equal(asOf.status, 200);
  assert.deepEqual(asOf.body.meta.resolved_as_of, { a: "2024-01-01", b: "2025-01-01" }, "each side resolves its own prior snapshot");
  assert.equal(asOf.body.data.b.metrics.pace_retention_r3_vs_r1.value, 0.95);
  const noSnap = await call(`/v1/ufc/matchups/${F_NODNA}/${F_OPP}/dna?as_of=2024-01-01`);
  assert.equal(noSnap.status, 404);
  assert.equal(noSnap.body.error.code, "dna_not_available");
  assert.equal(noSnap.body.data, null);
});

test("buildMatchupDna is deterministic: same inputs give byte-identical output", () => {
  const A = __test.snapshotView(stricklandSnapshot("2026-09-06", HIGH));
  const B = __test.snapshotView(oppSnapshot("2026-09-06"));
  const one = JSON.stringify(__test.buildMatchupDna(fighterMedia, A, fighterOppSouthpaw, B));
  const two = JSON.stringify(__test.buildMatchupDna(fighterMedia, __test.snapshotView(stricklandSnapshot("2026-09-06", HIGH)), fighterOppSouthpaw, __test.snapshotView(oppSnapshot("2026-09-06"))));
  assert.equal(one, two);
  const unknownStance = __test.buildMatchupDna({ ...fighterMedia, stance: null }, A, fighterOppSouthpaw, B);
  assert.equal(unknownStance.stance_context.context, "unknown");
  assert.equal(unknownStance.stance_context.b_vs_a_stance.opponent_stance, null);
  assert.ok(unknownStance.warnings.some((w) => w.includes("listed stance is unknown")));
  assert.ok(!unknownStance.insights.some((i) => i.key.startsWith("b_vs_")));
});

test("dna query filters current snapshots by a metric value and confidence; older passing snapshots never qualify", async () => {
  installMock({ tables: dnaTables });
  const { res, body } = await callRaw("/v1/ufc/dna/query?metric=pace_retention_r3_vs_r1&min=0.9");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), DNA_CACHE);
  assert.equal(body.meta.mode, "snapshot");
  assert.equal(body.meta.metric, "pace_retention_r3_vs_r1");
  assert.equal(body.meta.min, 0.9);
  assert.equal(body.meta.min_confidence, "low");
  assert.deepEqual(body.data.map((r) => [r.fighter.id, r.as_of_date]), [[F_MEDIA, "2026-09-06"]], "Strickland only: Opponent's older 0.95 snapshot is superseded by an insufficient current one");
  const row = body.data[0];
  assert.equal(row.fighter.slug_id, "3093653");
  assert.equal(row.fighter.stance, "ORTHODOX");
  assert.equal(row.metric.value, 0.94);
  assert.equal(row.metric.confidence, "medium");
  assert.equal(row.metric_key, "pace_retention_r3_vs_r1");
  assert.equal(row.sample.coverage_status, "high");
  assert.equal(body.meta.candidates, 4, "four snapshot rows pass the raw filter before the latest-per-fighter rule");
  assert.equal(body.meta.matched, 1);
  assert.equal(body.meta.truncated, false);
  assert.deepEqual(body.meta.filter.value, ["metrics->pace_retention_r3_vs_r1->value=gte.0.9"]);
  assert.ok(body.meta.note.includes("capped at 1000"));

  const older = await call("/v1/ufc/dna/query?metric=pace_retention_r3_vs_r1&min=0.9&as_of=2025-06-01");
  assert.deepEqual(older.body.data.map((r) => [r.fighter.id, r.as_of_date]), [[F_OPP, "2025-01-01"], [F_MEDIA, "2025-04-14"]], "as_of makes the 2025-01-01 opponent snapshot current; sorted by value desc");
  const all = await call("/v1/ufc/dna/query?metric=sig_landed_per_min&min_confidence=insufficient&order=asc");
  assert.deepEqual(all.body.data.map((r) => [r.fighter.name, r.metric.value]), [["Opponent Person", 4], ["Sean Strickland", 5.9], ["Aaron Nomedia", null]], "asc order, nulls last");
  const strict = await call("/v1/ufc/dna/query?metric=sig_landed_per_min&min_confidence=medium&max=6");
  assert.deepEqual(strict.body.data.map((r) => r.fighter.name), ["Sean Strickland"]);
  const active = await call("/v1/ufc/dna/query?metric=sig_landed_per_min&active=false");
  assert.deepEqual(active.body.data, []);
  assert.equal(active.body.meta.active, false);
  const limited = await call("/v1/ufc/dna/query?metric=sig_landed_per_min&min_confidence=insufficient&limit=1");
  assert.equal(limited.body.data.length, 1);
  assert.equal(limited.body.meta.matched, 3);
  assert.equal(limited.body.meta.count, 1);

  const bad = await call("/v1/ufc/dna/query?metric=DROP%20TABLE");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_metric");
  const none = await call("/v1/ufc/dna/query");
  assert.equal(none.status, 400);
  const badBound = await call("/v1/ufc/dna/query?metric=finish_rate&min=high");
  assert.equal(badBound.body.error.code, "invalid_bound");
  const badConf = await call("/v1/ufc/dna/query?metric=finish_rate&min_confidence=solid");
  assert.equal(badConf.body.error.code, "invalid_confidence");
  installMock({ tables: dnaTables, missingTables: ["ufc_fighter_dna_snapshots"] });
  const gone = await call("/v1/ufc/dna/query?metric=finish_rate");
  assert.equal(gone.status, 503);
  assert.equal(gone.body.error.code, "dna_not_available");
});

test("dna query with ?stance= runs over stance splits (fighters with >= N appearances vs a stance by KO rate)", async () => {
  installMock({ tables: dnaTables });
  const { body } = await call("/v1/ufc/dna/query?metric=stance_ko_rate&stance=southpaw&min=0.1&min_appearances=3");
  assert.equal(body.meta.mode, "stance_split");
  assert.equal(body.meta.metric, "ko_rate");
  assert.equal(body.meta.metric_requested, "stance_ko_rate");
  assert.equal(body.meta.stance, "SOUTHPAW");
  assert.equal(body.meta.min_appearances, 3);
  assert.deepEqual(body.data.map((r) => [r.fighter.name, r.opponent_stance, r.metric.value]), [["Sean Strickland", "SOUTHPAW", 0.2]]);
  assert.deepEqual(body.data[0].record, { w: 4, l: 1, d: 0, nc: 0, appearances: 5 });
  assert.equal(body.data[0].ko_tko_wins, 1);
  assert.deepEqual(body.data[0].sample, { stat_bouts: 3, stat_rounds: 9, observed_seconds: 2700, confidence: "medium" });
  const orthodox = await call("/v1/ufc/dna/query?metric=ko_rate&stance=ORTHODOX&min=0.1&min_confidence=low");
  assert.deepEqual(orthodox.body.data.map((r) => r.fighter.name), ["Opponent Person"]);
  const bad = await call("/v1/ufc/dna/query?metric=sig_landed_per_min&stance=SOUTHPAW");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_metric");
  assert.ok(bad.body.error.detail.allowed.includes("ko_rate"));
});

test("index advertises every Fight DNA route", async () => {
  installMock({ tables: dnaTables });
  const i = await call("/v1/ufc");
  for (const k of ["dna_metrics", "dna_query", "fighter_dna", "fighter_splits", "fighter_round_profile", "fighter_finish_profile", "fighter_position_profile", "matchup_dna"]) {
    assert.ok(i.body.data.endpoints[k], `index missing ${k}`);
  }
  assert.equal(i.body.data.endpoints.matchup_dna, "/v1/ufc/matchups/{fighterA}/{fighterB}/dna?as_of=YYYY-MM-DD");
});

/* ---- Fight State Ledger (docs/fight_state_ledger.md) ------------------ */

const L_1 = "a1000000-1111-4222-8333-000000000001";
const L_2 = "a1000000-1111-4222-8333-000000000002";
const L_3 = "a1000000-1111-4222-8333-000000000003";
const B_PRELIM = "b2000000-2222-4333-8444-000000000004";
const boutNextPrelim = { ...boutNext, id: B_PRELIM, espn_competition_id: "401000004", fighter_a_id: F_OPP, fighter_b_id: F_NODNA, bout_order: 3, card_position: "prelim", is_title: false, scheduled_rounds: 3,
  fighter_a: brief(fighterOppSouthpaw), fighter_b: brief(fighterNoDna) };

const ledgerFighters = (aStance, context) => ({
  a: { id: F_NOMEDIA, name: "Aaron Nomedia", slug_id: "4199009", stance: aStance, record: { w: 12, l: 4, d: 0, nc: 0 }, rankings: null, nickname: null, is_active: true, updated_at: "2026-09-06T13:38:44Z" },
  b: { id: F_MEDIA, name: "Sean Strickland", slug_id: "3093653", stance: "ORTHODOX", record: { w: 29, l: 7, d: 0, nc: 0 }, rankings: [{ division: "MIDDLEWEIGHT", rank: 0 }], nickname: "Tarzan", is_active: true, updated_at: "2026-09-06T13:38:44Z" },
  stance_context: context,
});
const ledgerBoutState = (status, boutUpdatedAt) => ({
  status, card_position: "main", bout_order: 12, scheduled_rounds: 5, is_title: true, is_main_event: true, weight_class: "MIDDLEWEIGHT", is_womens: false,
  short_notice_days: null, replaced_bout_id: null, ufcstats_id: null, espn_competition_id: "401000002", bout_updated_at: boutUpdatedAt,
  event: { name: "Noche UFC: Silva vs. Delgado", city: "San Antonio", region: "TX", country: "USA", venue: null, card_status: "announced", event_updated_at: boutUpdatedAt },
});
const UNAVAILABLE = (reason) => ({ status: "unavailable", reason });
const ledgerRow = (id, checkpoint, capturedAt, hours, overrides = {}) => ({
  id, bout_id: B_NEXT, event_id: E_NEXT, checkpoint, ledger_version: 1, captured_at: capturedAt, scheduled_start: "2999-09-12T22:00:00+00:00", event_date: "2999-09-12", hours_to_start: hours,
  bout_state: ledgerBoutState("announced", "2026-09-06T13:40:34Z"),
  fighters: ledgerFighters("ORTHODOX", "same"),
  rankings: { status: "ok", snapshot_date: "2026-09-06", a: [], b: [{ division: "MIDDLEWEIGHT", rank: 0 }] },
  dna: { a: UNAVAILABLE("no_snapshot"), b: { as_of_date: "2026-09-06", definition_version: 1, coverage_status: "high", sample_bouts: 12, metrics: { sig_landed_per_min: mo("sig_landed_per_min", 5.9, HIGH) } } },
  weigh_in: UNAVAILABLE("weigh_in_ingestion_not_built"),
  wire: { status: "ok", count: 2, items: [{ id: "w1", title: "Camp news" }, { id: "w2", title: "Presser" }], articles: [] },
  odds: UNAVAILABLE("no_odds_provider_connected"), market: UNAVAILABLE("no_odds_provider_connected"), model: UNAVAILABLE("no_model_output_exists"),
  result: { status: "pending" },
  provenance: { builder: "scripts/ledger/capture_fight_state.mjs@1", captured_at: capturedAt, checkpoint_basis: "espn_event_start" },
  ...overrides,
});
const ledgerRows = [
  ledgerRow(L_1, "ad_hoc", "2026-09-06T16:19:01.844+00:00", 150.5),
  // T-24h: fighter A's listed stance changed, the bout row was re-synced (bookkeeping only), rankings refreshed, wire grew.
  ledgerRow(L_2, "t_minus_24h", "2999-09-11T22:00:00+00:00", 24, {
    bout_state: ledgerBoutState("announced", "2999-09-10T09:00:00Z"),
    fighters: ledgerFighters("SOUTHPAW", "open"),
    rankings: { status: "ok", snapshot_date: "2999-09-10", a: [], b: [{ division: "MIDDLEWEIGHT", rank: 0 }] },
    wire: { status: "ok", count: 5, items: [], articles: [] },
  }),
  // post_result: the result arrived and the bout completed.
  ledgerRow(L_3, "post_result", "2999-09-13T06:00:00+00:00", -8, {
    bout_state: ledgerBoutState("complete", "2999-09-13T05:00:00Z"),
    fighters: ledgerFighters("SOUTHPAW", "open"),
    rankings: { status: "ok", snapshot_date: "2999-09-10", a: [], b: [{ division: "MIDDLEWEIGHT", rank: 0 }] },
    wire: { status: "ok", count: 9, items: [], articles: [] },
    result: { status: "final", winner_id: F_MEDIA, method: "KO_TKO", round: 2, time_sec: 75, result_source: "espn" },
  }),
];
const ledgerTables = { ...dnaTables, ufc_bouts: [boutPast, boutNext, boutNextPrelim], ufc_fight_state_ledger: ledgerRows };

test("ledgerView normalizes full rows and compact alias rows to one shape", () => {
  const full = __test.ledgerView(ledgerRows[0]);
  assert.equal(full.dna.a.status, "unavailable");
  assert.deepEqual(full.dna.b, { status: "ok", as_of_date: "2026-09-06", definition_version: 1 });
  assert.equal(full.wire.count, 2);
  assert.equal(full.odds.status, "unavailable");
  assert.equal("bout_updated_at" in full.bout_state, false);
  assert.equal("event_updated_at" in full.bout_state.event, false);
  assert.deepEqual(Object.keys(full.fighters.a), ["id", "name", "slug_id", "stance", "record", "rankings"]);
  const compact = __test.ledgerView({
    id: L_1, bout_id: B_NEXT, event_id: E_NEXT, checkpoint: "ad_hoc", captured_at: "2026-09-06T16:19:01Z", hours_to_start: "150.5",
    bout_state: ledgerRows[0].bout_state, fighters: ledgerRows[0].fighters, rankings: ledgerRows[0].rankings, result: { status: "pending" },
    dna_status: null, dna_a_status: "unavailable", dna_a_as_of: null, dna_a_version: null, dna_b_status: null, dna_b_as_of: "2026-09-06", dna_b_version: 1,
    wire_status: "ok", wire_count: 2, weigh_in_status: "unavailable", odds_status: "unavailable", market_status: "unavailable", model_status: "unavailable",
  });
  assert.deepEqual(compact.dna, full.dna);
  assert.deepEqual(compact.wire, full.wire);
  assert.equal(compact.hours_to_start, 150.5);
  assert.deepEqual(__test.ledgerDiff(full, full).changed, [], "identical snapshots produce an empty diff");
});

test("GET /v1/ufc/bouts/{id}/ledger returns snapshots newest-first with deterministic shallow diffs", async () => {
  installMock({ tables: ledgerTables });
  const { res, body } = await callRaw("/v1/ufc/bouts/401000002/ledger");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), DNA_CACHE);
  const d = body.data;
  assert.equal(d.bout.id, B_NEXT);
  assert.equal(d.bout.event.id, E_NEXT);
  assert.equal(d.bout.fighter_b.name, "Sean Strickland");
  assert.deepEqual(d.snapshots.map((s) => s.checkpoint), ["post_result", "t_minus_24h", "ad_hoc"], "newest first");
  for (const k of ["bout_state", "fighters", "rankings", "dna", "weigh_in", "wire", "odds", "market", "model", "result", "provenance"]) assert.ok(k in d.snapshots[0], `snapshot missing block ${k}`);
  assert.equal(d.snapshots[2].hours_to_start, 150.5);
  assert.equal(d.snapshots[0].wire.count, 9);
  assert.deepEqual(d.card_shock, { status: "not_computed", reason: "card_shock_engine_not_built" });

  assert.equal(d.diffs.length, 2);
  const [resultDiff, stanceDiff] = d.diffs;
  assert.deepEqual(resultDiff.newer, { id: L_3, checkpoint: "post_result", captured_at: "2999-09-13T06:00:00+00:00" });
  assert.deepEqual(resultDiff.older, { id: L_2, checkpoint: "t_minus_24h", captured_at: "2999-09-11T22:00:00+00:00" });
  assert.equal(resultDiff.hours_between, 32);
  assert.deepEqual(resultDiff.changed, ["bout_state.status", "wire.count", "result.status"]);
  assert.deepEqual(resultDiff.changes[0], { path: "bout_state.status", from: "announced", to: "complete" });
  assert.deepEqual(resultDiff.changes[2], { path: "result.status", from: "pending", to: "final" });
  assert.deepEqual(stanceDiff.changed, ["fighters.a.stance", "fighters.stance_context", "rankings.snapshot_date", "wire.count"]);
  assert.deepEqual(stanceDiff.changes[0], { path: "fighters.a.stance", from: "ORTHODOX", to: "SOUTHPAW" });
  assert.deepEqual(stanceDiff.changes[1], { path: "fighters.stance_context", from: "same", to: "open" });
  assert.ok(!JSON.stringify(d.diffs).includes("_updated_at"), "bookkeeping timestamps never appear in a diff");
  assert.deepEqual(body.meta.checkpoints, { t_minus_24h: 1, post_result: 1, ad_hoc: 1 });
  assert.equal(body.meta.total, 3);
  assert.equal(body.meta.append_only, true);

  const limited = await call(`/v1/ufc/bouts/${B_NEXT}/ledger?limit=2`);
  assert.equal(limited.body.data.snapshots.length, 2);
  assert.equal(limited.body.data.diffs.length, 1);
  assert.equal(limited.body.meta.total, 3);
  assert.ok(limited.body.meta.note.includes("newest 2 of 3"));
  const empty = await call(`/v1/ufc/bouts/${B_PRELIM}/ledger`);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data.snapshots, []);
  assert.deepEqual(empty.body.data.diffs, []);
  assert.ok(empty.body.meta.note.includes("No ledger checkpoint"));
  const missing = await call("/v1/ufc/bouts/00000000-0000-4000-8000-000000000000/ledger");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "bout_not_found");
  installMock({ tables: ledgerTables, missingTables: ["ufc_fight_state_ledger"] });
  const gone = await call(`/v1/ufc/bouts/${B_NEXT}/ledger`);
  assert.equal(gone.status, 503);
  assert.equal(gone.body.error.code, "ledger_not_available");
  assert.equal(gone.body.data, null);
});

test("GET /v1/ufc/events/{id}/intelligence summarizes the latest checkpoint per bout with a card_shock placeholder", async () => {
  installMock({ tables: ledgerTables });
  const now = new Date("2999-09-12T10:00:00Z");
  const out = await __test.eventIntelligence(env, "600060772", new URL("https://x/v1/ufc/events/600060772/intelligence"), now);
  assert.equal(out.data.event.id, E_NEXT);
  assert.equal(out.data.event.scheduled_start, "2999-09-12T22:00:00+00:00");
  assert.equal(out.data.event.hours_to_start, 12);
  assert.deepEqual(out.data.card_shock, { status: "not_computed", reason: "card_shock_engine_not_built" });
  assert.equal(out.data.bouts.length, 2);
  const [main, prelim] = out.data.bouts;
  assert.equal(main.bout.id, B_NEXT);
  assert.equal(main.bout.fighter_b.primary_image.kind, "wikimedia");
  assert.equal(main.ledger_status, "ok");
  assert.equal(main.latest.checkpoint, "post_result");
  assert.equal(main.latest.captured_at, "2999-09-13T06:00:00+00:00");
  assert.equal(main.latest.hours_to_start_at_capture, -8);
  assert.equal(main.hours_to_start, 12);
  assert.deepEqual(main.checkpoints, ["post_result", "t_minus_24h", "ad_hoc"]);
  assert.equal(main.snapshots, 3);
  assert.equal(main.bout_state.status, "complete");
  assert.equal("bout_updated_at" in main.bout_state, false);
  assert.equal(main.fighters.a.stance, "SOUTHPAW");
  assert.deepEqual(main.has_dna, { a: false, b: true });
  assert.deepEqual(main.dna.b, { status: "ok", as_of_date: "2026-09-06", definition_version: 1 });
  assert.equal(main.wire_count, 9);
  assert.equal(main.result.status, "final");
  assert.equal(main.result.winner_id, F_MEDIA);
  assert.deepEqual(main.sources, { weigh_in: "unavailable", odds: "unavailable", market: "unavailable", model: "unavailable" });
  assert.deepEqual(main.diff.changed, ["bout_state.status", "wire.count", "result.status"]);
  assert.equal(main.diff.older.checkpoint, "t_minus_24h");
  assert.deepEqual(main.card_shock, { status: "not_computed", reason: "card_shock_engine_not_built" });

  assert.equal(prelim.bout.id, B_PRELIM);
  assert.equal(prelim.ledger_status, "no_checkpoint");
  assert.equal(prelim.latest, null);
  assert.deepEqual(prelim.has_dna, { a: null, b: null });
  assert.equal(prelim.diff, null);
  assert.equal(prelim.wire_count, null);
  assert.deepEqual(prelim.checkpoints, []);

  assert.equal(out.meta.generated_at, now.toISOString());
  assert.equal(out.meta.bouts, 2);
  assert.equal(out.meta.bouts_with_ledger, 1);
  assert.equal(out.meta.snapshots, 3);
  assert.deepEqual(out.meta.checkpoints, { t_minus_24h: 1, post_result: 1, ad_hoc: 1 });
  assert.equal(out.meta.latest_captured_at, "2999-09-13T06:00:00+00:00");
  assert.deepEqual(out.meta.unavailable_sources, ["weigh_in", "odds", "market", "model"]);
  assert.deepEqual(out.meta.source_status.odds, { unavailable: 1 });
  assert.equal(out.meta.truncated, false);

  const { res, body } = await callRaw(`/v1/ufc/events/${E_NEXT}/intelligence`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), DNA_CACHE);
  assert.equal(body.data.bouts.length, 2);
  assert.ok(!Number.isNaN(Date.parse(body.meta.generated_at)));
  const noLedger = await call(`/v1/ufc/events/${E_PAST}/intelligence`);
  assert.equal(noLedger.status, 200);
  assert.equal(noLedger.body.meta.bouts_with_ledger, 0);
  assert.deepEqual(noLedger.body.meta.unavailable_sources, []);
  assert.ok(noLedger.body.meta.note.includes("No ledger checkpoint"));
  const missing = await call("/v1/ufc/events/00000000-0000-4000-8000-000000000000/intelligence");
  assert.equal(missing.status, 404);
  installMock({ tables: ledgerTables, missingTables: ["ufc_fight_state_ledger"] });
  const gone = await call(`/v1/ufc/events/${E_NEXT}/intelligence`);
  assert.equal(gone.status, 503);
  assert.equal(gone.body.error.code, "ledger_not_available");
  const i = await call("/v1/ufc");
  assert.equal(i.body.data.endpoints.bout_ledger, "/v1/ufc/bouts/{id}/ledger?limit=25");
  assert.equal(i.body.data.endpoints.event_intelligence, "/v1/ufc/events/{id}/intelligence");
});

/* ---- official videos (docs/UFC_MEDIA_VIDEO_ADDENDUM.md) --------------- */

const V_CHANNEL = { id: "UCvgfXK4nTYKudb0rFR6noLA", name: "UFC" };
const videoRow = (id, vid, type, publishedAt, extra = {}) => ({
  id, provider: "youtube", provider_video_id: vid, channel_id: V_CHANNEL.id, channel_name: V_CHANNEL.name, channel_verified_source: true,
  url: `https://www.youtube.com/watch?v=${vid}`, title: `${type} ${vid}`, description: "desc", published_at: publishedAt, duration_sec: 600,
  thumbnail_url: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, embeddable: true, live_broadcast_state: "none", video_type: type,
  fighter_ids: [], event_id: null, bout_id: null, article_id: null, resolver_confidence: "high", link_status: "published",
  source_metadata: { discovery: "uploads_playlist" }, captured_at: "2026-09-06T12:00:00Z", updated_at: "2026-09-06T12:00:00Z", ...extra,
});
const V1 = "c1000000-1111-4222-8333-000000000001";
const V2 = "c1000000-1111-4222-8333-000000000002";
const V3 = "c1000000-1111-4222-8333-000000000003";
const V4 = "c1000000-1111-4222-8333-000000000004";
const V5 = "c1000000-1111-4222-8333-000000000005";
const V6 = "c1000000-1111-4222-8333-000000000006";
const videoRows = [
  videoRow(V1, "aaaaaaaaaa1", "countdown", "2999-09-08T18:00:00Z", { event_id: E_NEXT, bout_id: B_NEXT, fighter_ids: [F_MEDIA, F_NOMEDIA] }),
  videoRow(V2, "aaaaaaaaaa2", "press_conference", "2999-09-10T20:00:00Z", { event_id: E_NEXT, fighter_ids: [F_MEDIA] }),
  videoRow(V3, "aaaaaaaaaa3", "fight_preview", "2999-09-05T12:00:00Z", { event_id: E_NEXT, duration_sec: null, embeddable: null }),
  videoRow(V4, "aaaaaaaaaa4", "interview", "2026-08-01T12:00:00Z", { fighter_ids: [F_MEDIA], resolver_confidence: "medium", channel_verified_source: false, channel_name: null, channel_id: "UCunknown" }),
  videoRow(V5, "aaaaaaaaaa5", "weigh_in", "2999-09-11T20:00:00Z", { event_id: E_NEXT, fighter_ids: [F_MEDIA], link_status: "review" }),
  videoRow(V6, "aaaaaaaaaa6", "highlights", "2999-09-13T02:00:00Z", { event_id: E_NEXT, bout_id: B_NEXT, fighter_ids: [F_MEDIA], link_status: "rejected" }),
];
const videoTables = { ...fullTables, ufc_videos: videoRows, ufc_video_channels: [{ provider: "youtube", channel_id: V_CHANNEL.id, name: "UFC", handle: "@UFC", channel_class: "ufc_official", verified: true, enabled: true }] };
const EMBED = (vid) => `https://www.youtube-nocookie.com/embed/${vid}`;

test("videoView builds the embed URL at render time and exposes provider, channel, links and attribution", () => {
  const v = __test.videoView(videoRows[0]);
  assert.deepEqual(Object.keys(v), ["id", "provider", "provider_video_id", "url", "embed_url", "thumbnail_url", "title", "published_at", "duration_sec", "embeddable", "live_broadcast_state", "video_type", "video_type_label", "channel", "links", "resolver_confidence", "attribution", "captured_at", "updated_at"]);
  assert.equal(v.embed_url, EMBED("aaaaaaaaaa1"));
  assert.deepEqual(v.channel, { id: V_CHANNEL.id, name: "UFC", verified: true });
  assert.deepEqual(v.links, { event_id: E_NEXT, bout_id: B_NEXT, article_id: null, fighter_ids: [F_MEDIA, F_NOMEDIA] });
  assert.equal(v.attribution, "YouTube · UFC");
  assert.equal("link_status" in v, false, "link_status never leaves the API");
  assert.equal("description" in v, false);
  const unknown = __test.videoView(videoRows[2]);
  assert.equal(unknown.duration_sec, null, "unknown duration stays null");
  assert.equal(unknown.embeddable, null, "unchecked embeddability stays null");
  const nameless = __test.videoView(videoRows[3]);
  assert.equal(nameless.attribution, "YouTube · UCunknown");
  assert.equal(nameless.channel.verified, false);
  assert.equal(__test.videoEmbedUrl({ provider: "vimeo", provider_video_id: "1" }), null);
  assert.equal(__test.videoEmbedUrl({ provider: "youtube", provider_video_id: "a b" }), EMBED("a%20b"));
});

test("GET /v1/ufc/videos lists published rows newest first with type / fighter / event / bout filters", async () => {
  installMock({ tables: videoTables });
  const { status, body } = await call("/v1/ufc/videos?limit=10");
  assert.equal(status, 200);
  assert.deepEqual(body.data.map((v) => v.id), [V2, V1, V3, V4], "newest first, review/rejected excluded");
  assert.equal(body.meta.published_only, true);
  assert.equal(body.meta.total, 4);
  assert.ok(body.data.every((v) => v.embed_url.startsWith("https://www.youtube-nocookie.com/embed/") && v.attribution.startsWith("YouTube · ")));
  const byType = await call("/v1/ufc/videos?type=Countdown");
  assert.deepEqual(byType.body.data.map((v) => v.id), [V1]);
  assert.equal(byType.body.meta.type, "countdown");
  const byFighter = await call(`/v1/ufc/videos?fighter_id=${F_MEDIA}`);
  assert.deepEqual(byFighter.body.data.map((v) => v.id), [V2, V1, V4]);
  const byEvent = await call("/v1/ufc/videos?event_id=600060772");
  assert.deepEqual(byEvent.body.data.map((v) => v.id), [V2, V1, V3], "event resolved by ESPN id");
  assert.equal(byEvent.body.meta.event_id, E_NEXT);
  const byBout = await call(`/v1/ufc/videos?bout_id=${B_NEXT}&limit=1`);
  assert.deepEqual(byBout.body.data.map((v) => v.id), [V1]);
  assert.equal(byBout.body.meta.total, 1);
  const badType = await call("/v1/ufc/videos?type=vlog");
  assert.equal(badType.status, 400);
  assert.equal(badType.body.error.code, "invalid_type");
  assert.deepEqual(badType.body.error.detail.allowed, __test.VIDEO_TYPES);
  const badFighter = await call("/v1/ufc/videos?fighter_id=3093653");
  assert.equal(badFighter.status, 400);
  assert.equal(badFighter.body.error.code, "invalid_fighter_id");
  const noEvent = await call("/v1/ufc/videos?event_id=000000000");
  assert.equal(noEvent.status, 404);
  installMock({ tables: videoTables, missingTables: ["ufc_videos"] });
  const gone = await call("/v1/ufc/videos");
  assert.equal(gone.status, 503);
  assert.equal(gone.body.error.code, "videos_not_available");
  assert.equal(gone.body.data, null);
});

test("fighter / bout / event video routes; the event rail is chronological and grouped in fight-week order", async () => {
  installMock({ tables: videoTables });
  const f = await call("/v1/ufc/fighters/0d8011111be000b2/videos");
  assert.equal(f.status, 200);
  assert.equal(f.body.data.fighter.id, F_MEDIA);
  assert.equal(f.body.data.fighter.primary_image.kind, "wikimedia");
  assert.deepEqual(f.body.data.videos.map((v) => v.id), [V2, V1, V4]);
  const fNone = await call(`/v1/ufc/fighters/${F_OPP}/videos`);
  assert.deepEqual(fNone.body.data.videos, []);
  assert.equal(fNone.body.meta.total, 0);

  const b = await call(`/v1/ufc/bouts/401000002/videos`);
  assert.equal(b.body.data.bout.id, B_NEXT);
  assert.equal(b.body.data.bout.fighter_b.name, "Sean Strickland");
  assert.deepEqual(b.body.data.videos.map((v) => v.id), [V1], "rejected bout video never appears");

  const e = await call(`/v1/ufc/events/${E_NEXT}/videos`);
  assert.equal(e.body.data.event.id, E_NEXT);
  assert.deepEqual(e.body.data.videos.map((v) => v.id), [V3, V1, V2], "chronological");
  assert.deepEqual(e.body.data.groups.map((g) => [g.video_type, g.label, g.count]), [["fight_preview", "Fight preview", 1], ["countdown", "Countdown", 1], ["press_conference", "Press conference", 1]]);
  assert.equal(e.body.data.groups[0].first_published_at, "2999-09-05T12:00:00Z");
  assert.equal(e.body.meta.order, "chronological");
  assert.deepEqual(e.body.meta.timeline_order, __test.VIDEO_TIMELINE_ORDER);
  const eType = await call(`/v1/ufc/events/${E_NEXT}/videos?type=press_conference`);
  assert.deepEqual(eType.body.data.videos.map((v) => v.id), [V2]);
  const eNone = await call(`/v1/ufc/events/${E_PAST}/videos`);
  assert.deepEqual(eNone.body.data.groups, []);
  const missing = await call("/v1/ufc/events/000000000/videos");
  assert.equal(missing.status, 404);
});

test("include=videos adds a compact latest-6 block on fighter detail, event detail and event card; media objects carry rights fields", async () => {
  installMock({ tables: { ...videoTables, ufc_images: [{ ...images[0], attribution_text: "MMAnytt, CC BY-SA 4.0, via Wikimedia Commons", rights_label: "CC BY-SA 4.0" }, images[1]] } });
  const fd = await call(`/v1/ufc/fighters/${F_MEDIA}?include=videos`);
  assert.equal(fd.status, 200);
  assert.deepEqual(fd.body.data.videos.map((v) => v.id), [V2, V1, V4]);
  assert.equal(fd.body.meta.videos, 3);
  assert.deepEqual(fd.body.meta.include, ["videos"]);
  assert.equal(fd.body.data.primary_image.attribution_text, "MMAnytt, CC BY-SA 4.0, via Wikimedia Commons");
  assert.equal(fd.body.data.primary_image.rights_label, "CC BY-SA 4.0");
  assert.equal(fd.body.data.primary_image.kind, "wikimedia");
  const plain = await call(`/v1/ufc/fighters/${F_MEDIA}`);
  assert.equal("videos" in plain.body.data, false, "default response never grows");
  const ev = await call(`/v1/ufc/events/${E_NEXT}?include=videos`);
  assert.equal(ev.body.data.id, E_NEXT);
  assert.deepEqual(ev.body.data.videos.map((v) => v.id), [V2, V1, V3]);
  const evPlain = await call(`/v1/ufc/events/${E_NEXT}`);
  assert.equal("videos" in evPlain.body.data, false);
  const evBad = await call(`/v1/ufc/events/${E_NEXT}?include=odds`);
  assert.equal(evBad.status, 400);
  const card = await call(`/v1/ufc/events/${E_NEXT}/card?include=videos`);
  assert.deepEqual(card.body.data.videos.map((v) => v.id), [V2, V1, V3]);
  assert.equal(card.body.meta.videos, 3);
  const cardPlain = await call(`/v1/ufc/events/${E_NEXT}/card`);
  assert.equal("videos" in cardPlain.body.data, false);
  const opp = await call(`/v1/ufc/fighters/${F_OPP}?include=videos`);
  assert.deepEqual(opp.body.data.videos, []);
  const noMediaRights = await call(`/v1/ufc/fighters/${F_OPP}`);
  assert.equal(noMediaRights.body.data.primary_image.attribution_text, null, "rights fields are null when not recorded, never invented");
  installMock({ tables: videoTables, missingTables: ["ufc_videos"] });
  const tolerant = await call(`/v1/ufc/fighters/${F_MEDIA}?include=videos`);
  assert.equal(tolerant.status, 200);
  assert.equal(tolerant.body.data.videos, null, "include=videos degrades to null while the table is missing");
  const i = await call("/v1/ufc");
  for (const k of ["videos", "fighter_videos", "event_videos", "bout_videos"]) assert.ok(i.body.data.endpoints[k], `index missing ${k}`);
});
