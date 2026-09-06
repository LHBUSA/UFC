const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UFCSTATS_RE = /^[0-9a-f]{16}$/i;

const FIGHTER_BRIEF_COLS = [
  "id", "ufcstats_id", "espn_athlete_id", "name", "nickname", "dob",
  "height_in", "reach_in", "weight_lbs", "stance",
  "record_w", "record_l", "record_d", "record_nc", "is_active"
].join(",");

const FIGHTER_COLS = [
  FIGHTER_BRIEF_COLS,
  "career_slpm", "career_str_acc", "career_sapm", "career_str_def",
  "career_td_avg", "career_td_acc", "career_td_def", "career_sub_avg",
  "fight_history_count", "updated_at"
].join(",");

const EVENT_COLS = [
  "id", "ufcstats_id", "espn_event_id", "name", "event_date", "venue",
  "city", "region", "country", "commission", "is_ppv", "card_status", "updated_at"
].join(",");

const RESULT_COLS = [
  "bout_id", "winner_id", "method", "method_raw", "round", "time_sec",
  "time_format", "referee", "judge_1", "judge_2", "judge_3", "scorecards",
  "finish_detail", "result_source", "has_stats", "captured_at"
].join(",");

const BOUT_BASE_COLS = [
  "id", "ufcstats_id", "espn_competition_id", "event_id", "weight_class",
  "weight_class_raw", "is_womens", "is_title", "scheduled_rounds",
  "card_position", "bout_order", "status", "replaced_bout_id", "short_notice_days"
].join(",");

const BOUT_SELECT = `${BOUT_BASE_COLS},` +
  `fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(${FIGHTER_BRIEF_COLS}),` +
  `fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(${FIGHTER_BRIEF_COLS}),` +
  `result:ufc_bout_results(${RESULT_COLS})`;

const BOUT_WITH_EVENT_SELECT = `${BOUT_SELECT},event:ufc_events(${EVENT_COLS})`;

const ARTICLE_LIST_COLS = [
  "id", "slug", "headline", "dek", "story_type", "status", "hero_image_ref",
  "hero_credit", "fighter_ids", "bout_id", "event_id", "published_at", "updated_at"
].join(",");
const ARTICLE_DETAIL_COLS = `${ARTICLE_LIST_COLS},body_md,sources,fact_block,model_version,needs_human`;

const IMAGE_COLS = "id,kind,r2_key,license,author,source_url,fighter_id,created_at";

class ApiError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeLike(value) {
  return String(value || "")
    .replace(/[,%*()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function normalizeOne(value) {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function normalizeBout(row) {
  if (!row) return row;
  return { ...row, result: normalizeOne(row.result) };
}

function cacheHeaders(seconds = 60) {
  return {
    "Cache-Control": `public, max-age=${Math.min(seconds, 60)}, s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`,
    "CDN-Cache-Control": `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`,
  };
}

function baseHeaders(env, requestId, cacheSeconds = 60) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization",
    "Access-Control-Expose-Headers": "X-Request-Id, X-API-Version",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
    "X-API-Version": env.API_VERSION || "v1",
    ...cacheHeaders(cacheSeconds),
  };
}

function ok(env, requestId, data, meta = {}, cacheSeconds = 60, status = 200) {
  return new Response(JSON.stringify({
    ok: true,
    data,
    meta: {
      api: "PropSports UFC",
      version: env.API_VERSION || "v1",
      request_id: requestId,
      ...meta,
    },
  }), { status, headers: baseHeaders(env, requestId, cacheSeconds) });
}

function fail(env, requestId, status, code, message, detail = null) {
  return new Response(JSON.stringify({
    ok: false,
    error: { code, message, ...(detail == null ? {} : { detail }) },
    meta: { api: "PropSports UFC", version: env.API_VERSION || "v1", request_id: requestId },
  }), {
    status,
    headers: {
      ...baseHeaders(env, requestId, 0),
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
    },
  });
}

function requireDb(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ApiError(503, "api_not_configured", "UFC API data source is not configured.");
  }
}

function sbHeaders(env, count = false) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: "application/json",
    ...(count ? { Prefer: "count=exact" } : {}),
  };
}

async function sb(env, table, params, { count = false } = {}) {
  requireDb(env);
  const qs = params instanceof URLSearchParams ? params.toString() : String(params || "");
  const url = `${String(env.SUPABASE_URL).replace(/\/$/, "")}/rest/v1/${table}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: sbHeaders(env, count) });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new ApiError(502, "upstream_error", `UFC data source returned HTTP ${res.status}.`, body || null);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : [];
  const range = res.headers.get("content-range");
  const total = range && range.includes("/") ? Number(range.split("/")[1]) : null;
  return { data, count: Number.isFinite(total) ? total : null };
}

function identityFilter(id, uuidCol, ufcstatsCol, espnCol) {
  if (UUID_RE.test(id)) return [uuidCol, `eq.${id}`];
  if (UFCSTATS_RE.test(id)) return [ufcstatsCol, `eq.${id}`];
  return [espnCol, `eq.${id}`];
}

async function resolveEvent(env, id) {
  const [col, filter] = identityFilter(id, "id", "ufcstats_id", "espn_event_id");
  const p = new URLSearchParams({ select: EVENT_COLS, [col]: filter, limit: "1" });
  const rows = (await sb(env, "ufc_events", p)).data;
  return rows[0] || null;
}

async function resolveFighter(env, id) {
  const [col, filter] = identityFilter(id, "id", "ufcstats_id", "espn_athlete_id");
  const p = new URLSearchParams({ select: FIGHTER_COLS, [col]: filter, limit: "1" });
  const rows = (await sb(env, "ufc_fighters", p)).data;
  return rows[0] || null;
}

async function resolveBout(env, id) {
  const [col, filter] = identityFilter(id, "id", "ufcstats_id", "espn_competition_id");
  const p = new URLSearchParams({ select: BOUT_WITH_EVENT_SELECT, [col]: filter, limit: "1" });
  const rows = (await sb(env, "ufc_bouts", p)).data;
  return normalizeBout(rows[0] || null);
}

function imageUrl(env, row) {
  const base = String(env.UFC_IMAGE_BASE_URL || "").replace(/\/$/, "");
  return base && row?.r2_key ? `${base}/${String(row.r2_key).replace(/^\//, "")}` : null;
}

async function imagesForFighters(env, fighterIds) {
  const ids = [...new Set((fighterIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const p = new URLSearchParams({
    select: IMAGE_COLS,
    fighter_id: `in.(${ids.join(",")})`,
    order: "created_at.desc",
    limit: String(Math.min(ids.length * 4, 400)),
  });
  const rows = (await sb(env, "ufc_images", p)).data;
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.fighter_id)) map.set(row.fighter_id, []);
    map.get(row.fighter_id).push({ ...row, image_url: imageUrl(env, row) });
  }
  return map;
}

function attachBoutImages(bouts, imageMap) {
  return bouts.map((bout) => ({
    ...bout,
    fighter_a: bout.fighter_a ? { ...bout.fighter_a, images: imageMap.get(bout.fighter_a.id) || [] } : null,
    fighter_b: bout.fighter_b ? { ...bout.fighter_b, images: imageMap.get(bout.fighter_b.id) || [] } : null,
  }));
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authorize(request, env) {
  if (String(env.REQUIRE_API_KEY || "false").toLowerCase() !== "true") return { tier: "public" };
  const supplied = request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!supplied) throw new ApiError(401, "api_key_required", "A valid API key is required.");
  if (env.INTERNAL_API_KEY && supplied === env.INTERNAL_API_KEY) return { tier: "internal" };
  if (env.API_KEYS && typeof env.API_KEYS.get === "function") {
    const hash = await sha256Hex(supplied);
    const record = await env.API_KEYS.get(`key:${hash}`, { type: "json" });
    if (record && record.enabled !== false) {
      if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
        throw new ApiError(401, "api_key_expired", "The API key has expired.");
      }
      return { tier: record.tier || "developer", key_id: record.id || null };
    }
  }
  throw new ApiError(401, "invalid_api_key", "The API key is invalid.");
}

async function listEvents(env, url) {
  const status = url.searchParams.get("status") || "all";
  const date = url.searchParams.get("date");
  const limit = clampInt(url.searchParams.get("limit"), 25, 1, 1000);
  const p = new URLSearchParams({ select: EVENT_COLS, limit: String(limit) });
  if (date) {
    p.set("event_date", `eq.${date}`);
    p.set("order", "event_date.asc");
  } else if (status === "upcoming") {
    p.set("event_date", `gte.${today()}`);
    p.set("order", "event_date.asc");
  } else if (status === "recent") {
    p.set("event_date", `lt.${today()}`);
    p.set("order", "event_date.desc");
  } else {
    p.set("order", "event_date.desc.nullslast");
  }
  const { data, count } = await sb(env, "ufc_events", p, { count: true });
  return { data, meta: { count: data.length, total: count, status, date: date || null } };
}

async function eventCard(env, eventId) {
  const event = await resolveEvent(env, eventId);
  if (!event) throw new ApiError(404, "event_not_found", "UFC event not found.");
  const p = new URLSearchParams({ select: BOUT_SELECT, event_id: `eq.${event.id}`, order: "bout_order.desc" });
  const rows = (await sb(env, "ufc_bouts", p)).data.map(normalizeBout);
  const fighterIds = rows.flatMap((b) => [b.fighter_a?.id, b.fighter_b?.id]);
  const imageMap = await imagesForFighters(env, fighterIds);
  return { event, bouts: attachBoutImages(rows, imageMap) };
}

async function listFighters(env, url) {
  const q = sanitizeLike(url.searchParams.get("q"));
  const active = url.searchParams.get("active");
  const limit = clampInt(url.searchParams.get("limit"), 60, 1, 250);
  const p = new URLSearchParams({ select: FIGHTER_COLS, order: "name.asc", limit: String(limit) });
  if (q) p.set("name", `ilike.*${q}*`);
  if (active === "true" || active === "false") p.set("is_active", `eq.${active}`);
  const { data, count } = await sb(env, "ufc_fighters", p, { count: true });
  return { data, meta: { count: data.length, total: count, q: q || null, active: active || null } };
}

async function fighterDetail(env, fighterId) {
  const fighter = await resolveFighter(env, fighterId);
  if (!fighter) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.");
  const imageMap = await imagesForFighters(env, [fighter.id]);
  return { ...fighter, images: imageMap.get(fighter.id) || [] };
}

async function fighterHistory(env, fighterId, url) {
  const fighter = await resolveFighter(env, fighterId);
  if (!fighter) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.");
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 250);
  const p = new URLSearchParams({
    select: BOUT_WITH_EVENT_SELECT,
    or: `(fighter_a_id.eq.${fighter.id},fighter_b_id.eq.${fighter.id})`,
    limit: String(limit),
  });
  const rows = (await sb(env, "ufc_bouts", p)).data.map(normalizeBout)
    .sort((a, b) => String(b.event?.event_date || "").localeCompare(String(a.event?.event_date || "")));
  return { fighter, bouts: rows };
}

async function fighterStats(env, fighterId) {
  const fighter = await resolveFighter(env, fighterId);
  if (!fighter) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.");
  return {
    fighter: {
      id: fighter.id,
      ufcstats_id: fighter.ufcstats_id,
      espn_athlete_id: fighter.espn_athlete_id,
      name: fighter.name,
    },
    career_snapshot: {
      slpm: fighter.career_slpm,
      striking_accuracy: fighter.career_str_acc,
      sapm: fighter.career_sapm,
      striking_defense: fighter.career_str_def,
      takedown_average: fighter.career_td_avg,
      takedown_accuracy: fighter.career_td_acc,
      takedown_defense: fighter.career_td_def,
      submission_average: fighter.career_sub_avg,
    },
    warning: "Career snapshot fields are display-only and must not be used as historical model features because they include future information relative to older bouts.",
  };
}

async function boutStats(env, boutId) {
  const bout = await resolveBout(env, boutId);
  if (!bout) throw new ApiError(404, "bout_not_found", "UFC bout not found.");
  const p = new URLSearchParams({
    select: "bout_id,fighter_id,round,kd,sig_str_landed,sig_str_att,total_str_landed,total_str_att,td_landed,td_att,sub_att,rev,ctrl_sec,head_landed,head_att,body_landed,body_att,leg_landed,leg_att,distance_landed,distance_att,clinch_landed,clinch_att,ground_landed,ground_att,captured_at",
    bout_id: `eq.${bout.id}`,
    order: "round.asc,fighter_id.asc",
  });
  const rounds = (await sb(env, "ufc_bout_round_stats", p)).data;
  return { bout, rounds };
}

async function listResults(env, url) {
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
  const rp = new URLSearchParams({ select: RESULT_COLS, order: "captured_at.desc", limit: String(limit) });
  const results = (await sb(env, "ufc_bout_results", rp)).data;
  if (!results.length) return [];
  const boutIds = results.map((r) => r.bout_id);
  const bp = new URLSearchParams({ select: BOUT_WITH_EVENT_SELECT, id: `in.(${boutIds.join(",")})` });
  const bouts = (await sb(env, "ufc_bouts", bp)).data.map(normalizeBout);
  const byId = new Map(bouts.map((b) => [b.id, b]));
  return results.map((result) => ({ ...result, bout: byId.get(result.bout_id) || null }));
}

async function listArticles(env, url) {
  const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
  const storyType = sanitizeLike(url.searchParams.get("story_type"));
  const p = new URLSearchParams({
    select: ARTICLE_LIST_COLS,
    status: "eq.published",
    order: "published_at.desc",
    limit: String(limit),
  });
  if (storyType) p.set("story_type", `eq.${storyType}`);
  return (await sb(env, "ufc_articles", p)).data;
}

async function articleDetail(env, slug) {
  const p = new URLSearchParams({
    select: ARTICLE_DETAIL_COLS,
    status: "eq.published",
    slug: `eq.${slug}`,
    limit: "1",
  });
  const rows = (await sb(env, "ufc_articles", p)).data;
  return rows[0] || null;
}

async function counts(env) {
  const specs = [
    ["fighters", "ufc_fighters", "id"],
    ["events", "ufc_events", "id"],
    ["bouts", "ufc_bouts", "id"],
    ["results", "ufc_bout_results", "bout_id"],
    ["round_stat_rows", "ufc_bout_round_stats", "bout_id"],
    ["articles", "ufc_articles", "id", "status", "eq.published"],
  ];
  const values = await Promise.all(specs.map(async ([key, table, col, filterCol, filter]) => {
    const p = new URLSearchParams({ select: col, limit: "1" });
    if (filterCol) p.set(filterCol, filter);
    const result = await sb(env, table, p, { count: true });
    return [key, result.count];
  }));
  return Object.fromEntries(values);
}

async function searchAll(env, url) {
  const q = sanitizeLike(url.searchParams.get("q"));
  if (!q || q.length < 2) throw new ApiError(400, "invalid_query", "Search query must contain at least 2 characters.");
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 25);
  const fp = new URLSearchParams({ select: FIGHTER_BRIEF_COLS, name: `ilike.*${q}*`, order: "name.asc", limit: String(limit) });
  const ep = new URLSearchParams({ select: EVENT_COLS, name: `ilike.*${q}*`, order: "event_date.desc.nullslast", limit: String(limit) });
  const ap = new URLSearchParams({ select: ARTICLE_LIST_COLS, status: "eq.published", headline: `ilike.*${q}*`, order: "published_at.desc", limit: String(limit) });
  const [fighters, events, articles] = await Promise.all([
    sb(env, "ufc_fighters", fp), sb(env, "ufc_events", ep), sb(env, "ufc_articles", ap),
  ]);
  return { q, fighters: fighters.data, events: events.data, articles: articles.data };
}

function apiIndex(env) {
  return {
    name: "PropSports UFC API",
    version: env.API_VERSION || "v1",
    status: "beta",
    principles: [
      "read-only contract",
      "source-grounded normalized facts",
      "explicit nulls and unavailable states",
      "no fabricated rankings, odds, predictions, or editorial facts",
    ],
    endpoints: {
      events: "/v1/ufc/events",
      event: "/v1/ufc/events/{id}",
      card: "/v1/ufc/events/{id}/card",
      fighters: "/v1/ufc/fighters",
      fighter: "/v1/ufc/fighters/{id}",
      fighter_history: "/v1/ufc/fighters/{id}/history",
      fighter_stats: "/v1/ufc/fighters/{id}/stats",
      bout: "/v1/ufc/bouts/{id}",
      bout_stats: "/v1/ufc/bouts/{id}/stats",
      results: "/v1/ufc/results",
      rankings: "/v1/ufc/rankings",
      news: "/v1/ufc/news",
      article: "/v1/ufc/articles/{slug}",
      search: "/v1/ufc/search?q=volkanovski",
      counts: "/v1/ufc/counts",
    },
  };
}

async function route(request, env, url, access) {
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/" || path === "/health") {
    return ok(env, crypto.randomUUID(), {
      service: "propbetedge-ufc-api",
      status: "ok",
      database_configured: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
    }, {}, 0);
  }

  const requestId = crypto.randomUUID();
  if (path === "/v1/ufc") return ok(env, requestId, apiIndex(env), { access_tier: access.tier }, 300);

  if (path === "/v1/ufc/events") {
    const out = await listEvents(env, url);
    return ok(env, requestId, out.data, { ...out.meta, access_tier: access.tier }, url.searchParams.get("status") === "upcoming" ? 60 : 300);
  }

  let m = path.match(/^\/v1\/ufc\/events\/([^/]+)\/card$/);
  if (m) return ok(env, requestId, await eventCard(env, decodeURIComponent(m[1])), { access_tier: access.tier }, 60);

  m = path.match(/^\/v1\/ufc\/events\/([^/]+)$/);
  if (m) {
    const event = await resolveEvent(env, decodeURIComponent(m[1]));
    if (!event) throw new ApiError(404, "event_not_found", "UFC event not found.");
    return ok(env, requestId, event, { access_tier: access.tier }, 300);
  }

  if (path === "/v1/ufc/fighters") {
    const out = await listFighters(env, url);
    return ok(env, requestId, out.data, { ...out.meta, access_tier: access.tier }, 300);
  }

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)\/history$/);
  if (m) return ok(env, requestId, await fighterHistory(env, decodeURIComponent(m[1]), url), { access_tier: access.tier }, 300);

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)\/stats$/);
  if (m) return ok(env, requestId, await fighterStats(env, decodeURIComponent(m[1])), { access_tier: access.tier }, 300);

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)$/);
  if (m) return ok(env, requestId, await fighterDetail(env, decodeURIComponent(m[1])), { access_tier: access.tier }, 300);

  m = path.match(/^\/v1\/ufc\/bouts\/([^/]+)\/stats$/);
  if (m) return ok(env, requestId, await boutStats(env, decodeURIComponent(m[1])), { access_tier: access.tier }, 300);

  m = path.match(/^\/v1\/ufc\/bouts\/([^/]+)$/);
  if (m) {
    const bout = await resolveBout(env, decodeURIComponent(m[1]));
    if (!bout) throw new ApiError(404, "bout_not_found", "UFC bout not found.");
    return ok(env, requestId, bout, { access_tier: access.tier }, 300);
  }

  if (path === "/v1/ufc/results") {
    const data = await listResults(env, url);
    return ok(env, requestId, data, { count: data.length, access_tier: access.tier }, 300);
  }

  if (path === "/v1/ufc/rankings") {
    throw new ApiError(501, "rankings_not_available", "Rankings are not populated in the verified UFC data layer yet. No synthetic ranking will be returned.");
  }

  if (path === "/v1/ufc/news") {
    const data = await listArticles(env, url);
    return ok(env, requestId, data, { count: data.length, access_tier: access.tier }, 120);
  }

  m = path.match(/^\/v1\/ufc\/articles\/([^/]+)$/);
  if (m) {
    const article = await articleDetail(env, decodeURIComponent(m[1]));
    if (!article) throw new ApiError(404, "article_not_found", "UFC article not found.");
    return ok(env, requestId, article, { access_tier: access.tier }, 300);
  }

  if (path === "/v1/ufc/search") {
    return ok(env, requestId, await searchAll(env, url), { access_tier: access.tier }, 60);
  }

  if (path === "/v1/ufc/counts") {
    return ok(env, requestId, await counts(env), { access_tier: access.tier }, 60);
  }

  throw new ApiError(404, "route_not_found", "UFC API route not found.");
}

export const __test = { clampInt, sanitizeLike, identityFilter, normalizeBout };

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseHeaders(env, requestId, 0) });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fail(env, requestId, 405, "method_not_allowed", "Only GET, HEAD, and OPTIONS are supported.");
    }

    try {
      const url = new URL(request.url);
      const publicPath = url.pathname === "/" || url.pathname === "/health";
      const access = publicPath ? { tier: "public" } : await authorize(request, env);
      const response = await route(request, env, url, access);
      if (request.method === "HEAD") return new Response(null, { status: response.status, headers: response.headers });
      return response;
    } catch (error) {
      if (error instanceof ApiError) return fail(env, requestId, error.status, error.code, error.message, error.detail);
      console.error("[ufc-api] unhandled", error);
      return fail(env, requestId, 500, "internal_error", "Unexpected UFC API error.");
    }
  },
};
