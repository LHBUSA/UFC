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
  assert.deepEqual(p, { id: "w", image_url: "https://x/p.jpg", card_url: "https://x/c.jpg", thumb_url: "https://x/t.jpg", author: "Photog", license: "CC BY-SA 4.0", source_url: "https://commons.wikimedia.org/wiki/File:A.jpg", kind: "wikimedia" });
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
const articleNoHero = { ...articleHero, id: A_NOHERO, slug: "nomedia-preview", headline: "Aaron Nomedia preview", hero_image_ref: null, hero_credit: null, fighter_ids: [F_NOMEDIA], bout_id: null, event_id: E_PAST, published_at: "2026-09-05T10:00:00Z" };

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

function matchFilter(row, key, raw) {
  const value = row[key];
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
  if (raw.startsWith("gte.")) return String(value) >= raw.slice(4);
  if (raw.startsWith("lte.")) return String(value) <= raw.slice(4);
  if (raw.startsWith("lt.")) return String(value) < raw.slice(3);
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
    if (ch === "," && depth === 0) { keys.push(token.split(":")[0].split("(")[0].split("!")[0].trim()); token = ""; continue; }
    token += ch;
  }
  const out = {};
  for (const k of keys) if (k in row) out[k] = row[k];
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
    source_url: "https://commons.wikimedia.org/wiki/File:Sean_Strickland_at_UFN_200.png", kind: "wikimedia",
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
    kind: "wikimedia", fighter_id: F_MEDIA, ref: IMG_MEDIA,
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
