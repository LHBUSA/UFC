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

const FIGHTER_IDENTITY_COLS = "id,name,nickname,ufcstats_id,espn_athlete_id,record_w,record_l,record_d,record_nc";

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
// List rows read only the compact analysis fields out of fact_block (PostgREST JSON path aliases); the raw block stays on detail.
const ARTICLE_ANALYSIS_COLS = "analysis_version:fact_block->>version,analysis_story_class:fact_block->>story_class,analysis_bettor_angle:fact_block->bettor_angle";
const ARTICLE_LIST_SELECT = `${ARTICLE_LIST_COLS},${ARTICLE_ANALYSIS_COLS}`;
const ANALYSIS_MIN_VERSION = 2;
const READING_WPM = 220;

// 006 added the rights columns (source_family, attribution_text, rights_label, ...); they are exposed on compact media objects.
const IMAGE_COLS = "id,kind,r2_key,license,author,source_url,fighter_id,created_at,source_family,attribution_text,rights_label,rights_expires_at,stored_first_party";

const ROUND_STAT_METRICS = [
  "kd", "sig_str_landed", "sig_str_att", "total_str_landed", "total_str_att",
  "td_landed", "td_att", "sub_att", "rev", "ctrl_sec",
  "head_landed", "head_att", "body_landed", "body_att", "leg_landed", "leg_att",
  "distance_landed", "distance_att", "clinch_landed", "clinch_att", "ground_landed", "ground_att",
];
const ROUND_STAT_COLS = `bout_id,fighter_id,round,${ROUND_STAT_METRICS.join(",")},captured_at`;

// Official ufc.com list order (men's P4P, men's divisions light to heavy, women's P4P, women's divisions).
const RANKING_DIVISION_ORDER = [
  "P4P/m", "FLYWEIGHT/m", "BANTAMWEIGHT/m", "FEATHERWEIGHT/m", "LIGHTWEIGHT/m", "WELTERWEIGHT/m",
  "MIDDLEWEIGHT/m", "LIGHT_HEAVYWEIGHT/m", "HEAVYWEIGHT/m",
  "P4P/w", "STRAWWEIGHT/w", "FLYWEIGHT/w", "BANTAMWEIGHT/w",
];
const RANKINGS_SOURCE = "ufc.com official rankings";
const RANKINGS_SNAPSHOT_KEY = "rankings/latest.json";
const RANKINGS_MEMO_TTL_MS = 5 * 60 * 1000;
const RANKINGS_PROBE_TTL_MS = 10 * 60 * 1000;

const FIGHTER_INCLUDES = ["media", "ranking", "next", "history", "stats", "videos"];
const CARD_INCLUDES = ["media", "results", "stats", "videos"];
const EVENT_INCLUDES = ["videos"];
const BULK_MEDIA_MAX_IDS = 150;

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

function parseIncludes(url, allowed) {
  const raw = String(url.searchParams.get("include") || "");
  const wanted = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = wanted.filter((w) => !allowed.includes(w));
  if (unknown.length) {
    throw new ApiError(400, "invalid_include", `Unknown include value(s): ${unknown.join(", ")}.`, { allowed });
  }
  return new Set(wanted);
}

function normalizeOne(value) {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function normalizeBout(row) {
  if (!row) return row;
  return { ...row, result: normalizeOne(row.result) };
}

function slugId(fighter) {
  return fighter?.espn_athlete_id || fighter?.ufcstats_id || null;
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

function ok(env, requestId, data, meta = {}, cacheSeconds = 60, status = 200, headerOverrides = null) {
  return new Response(JSON.stringify({
    ok: true,
    data,
    meta: {
      api: "PropSports UFC",
      version: env.API_VERSION || "v1",
      request_id: requestId,
      ...meta,
    },
  }), { status, headers: { ...baseHeaders(env, requestId, cacheSeconds), ...(headerOverrides || {}) } });
}

function fail(env, requestId, status, code, message, detail = null) {
  return new Response(JSON.stringify({
    ok: false,
    data: null,
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

function sbUrl(env, table, params) {
  const qs = params instanceof URLSearchParams ? params.toString() : String(params || "");
  return `${String(env.SUPABASE_URL).replace(/\/$/, "")}/rest/v1/${table}${qs ? `?${qs}` : ""}`;
}

/* `optional: true` returns null (instead of a 502) when PostgREST answers 404,
 * i.e. the relation does not exist yet. Used for tables that later migrations
 * add so routes can fail explicitly while a migration is pending. */
async function sb(env, table, params, { count = false, optional = false } = {}) {
  requireDb(env);
  const res = await fetch(sbUrl(env, table, params), { headers: sbHeaders(env, count) });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    if (optional && res.status === 404) return null;
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

/* ---- media ------------------------------------------------------------ */

function imageBase(env) {
  return String(env.UFC_IMAGE_BASE_URL || "").replace(/\/$/, "");
}

function imageUrl(env, row) {
  const base = imageBase(env);
  return base && row?.r2_key ? `${base}/${String(row.r2_key).replace(/^\//, "")}` : null;
}

/* `fighters/<id>/portrait.jpg` is the only key recorded in ufc_images; the
 * pipeline writes card.jpg (800x1000) and thumb.jpg (320x400) beside it.
 * Derivatives are only claimed for that layout, never guessed for other keys. */
function mediaUrls(env, row) {
  const base = imageBase(env);
  const key = String(row?.r2_key || "").replace(/^\//, "");
  if (!base || !key) return { image_url: null, card_url: null, thumb_url: null };
  const image_url = `${base}/${key}`;
  const m = key.match(/^(.*)\/portrait\.jpg$/);
  if (!m) return { image_url, card_url: null, thumb_url: null };
  return { image_url, card_url: `${base}/${m[1]}/card.jpg`, thumb_url: `${base}/${m[1]}/thumb.jpg` };
}

function decorateImage(env, row) {
  return { ...row, ...mediaUrls(env, row) };
}

function compactImage(image, credit = null) {
  if (!image) return null;
  return {
    id: image.id ?? null,
    image_url: image.image_url ?? null,
    card_url: image.card_url ?? null,
    thumb_url: image.thumb_url ?? null,
    author: credit?.author ?? image.author ?? null,
    license: credit?.license ?? image.license ?? null,
    source_url: credit?.source_url ?? image.source_url ?? null,
    kind: image.kind ?? null,
    attribution_text: image.attribution_text ?? null,
    rights_label: image.rights_label ?? null,
  };
}

function primaryImage(images) {
  const list = Array.isArray(images) ? images : [];
  const pick = list.find((i) => i.image_url && i.kind === "wikimedia")
    || list.find((i) => i.image_url)
    || null;
  return compactImage(pick);
}

async function imagesForFighters(env, fighterIds) {
  const ids = [...new Set((fighterIds || []).filter((id) => id && UUID_RE.test(id)))];
  if (!ids.length) return new Map();
  const p = new URLSearchParams({
    select: IMAGE_COLS,
    fighter_id: `in.(${ids.join(",")})`,
    order: "created_at.desc",
    limit: String(Math.min(ids.length * 4, 1000)),
  });
  const rows = (await sb(env, "ufc_images", p)).data;
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.fighter_id)) map.set(row.fighter_id, []);
    map.get(row.fighter_id).push(decorateImage(env, row));
  }
  return map;
}

function withPrimaryImage(fighter, imageMap) {
  if (!fighter) return null;
  return { ...fighter, primary_image: primaryImage(imageMap.get(fighter.id)) };
}

function attachBoutImages(bouts, imageMap) {
  return bouts.map((bout) => ({
    ...bout,
    fighter_a: bout.fighter_a ? { ...bout.fighter_a, images: imageMap.get(bout.fighter_a.id) || [], primary_image: primaryImage(imageMap.get(bout.fighter_a.id)) } : null,
    fighter_b: bout.fighter_b ? { ...bout.fighter_b, images: imageMap.get(bout.fighter_b.id) || [], primary_image: primaryImage(imageMap.get(bout.fighter_b.id)) } : null,
  }));
}

function compactFighter(fighter, imageMap) {
  if (!fighter) return null;
  return {
    id: fighter.id,
    name: fighter.name,
    nickname: fighter.nickname ?? null,
    ufcstats_id: fighter.ufcstats_id ?? null,
    espn_athlete_id: fighter.espn_athlete_id ?? null,
    slug_id: slugId(fighter),
    record_w: fighter.record_w ?? null,
    record_l: fighter.record_l ?? null,
    record_d: fighter.record_d ?? null,
    record_nc: fighter.record_nc ?? null,
    primary_image: imageMap ? primaryImage(imageMap.get(fighter.id)) : (fighter.primary_image ?? null),
  };
}

function compactEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    name: event.name,
    event_date: event.event_date ?? null,
    venue: event.venue ?? null,
    city: event.city ?? null,
    region: event.region ?? null,
    country: event.country ?? null,
    card_status: event.card_status ?? null,
    espn_event_id: event.espn_event_id ?? null,
    ufcstats_id: event.ufcstats_id ?? null,
  };
}

async function bulkFighterMedia(env, url) {
  const raw = String(url.searchParams.get("ids") || "");
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) throw new ApiError(400, "invalid_ids", "Provide ?ids= as a comma-separated list of fighter UUIDs.");
  if (ids.length > BULK_MEDIA_MAX_IDS) throw new ApiError(400, "too_many_ids", `At most ${BULK_MEDIA_MAX_IDS} fighter ids per request.`);
  const bad = ids.filter((id) => !UUID_RE.test(id));
  if (bad.length) throw new ApiError(400, "invalid_ids", "Fighter ids must be UUIDs.", { invalid: bad.slice(0, 10) });
  const imageMap = await imagesForFighters(env, ids);
  const media = {};
  let found = 0;
  for (const id of ids) {
    const primary = primaryImage(imageMap.get(id));
    if (primary) found += 1;
    media[id] = primary;
  }
  return { data: { media, ids }, meta: { requested: ids.length, found } };
}

/* ---- article hero media ----------------------------------------------- */

function looksLikeStorageKey(ref) {
  return /^[^\s]+\/[^\s]+\.(jpe?g|png|webp|avif)$/i.test(String(ref || ""));
}

async function heroImagesForArticles(env, articles) {
  const refs = [...new Set((articles || []).map((a) => a?.hero_image_ref).filter(Boolean))];
  const map = new Map();
  if (!refs.length) return map;
  const uuidRefs = refs.filter((r) => UUID_RE.test(r));
  const keyRefs = refs.filter((r) => !UUID_RE.test(r) && looksLikeStorageKey(r));
  const queries = [];
  if (uuidRefs.length) {
    queries.push(sb(env, "ufc_images", new URLSearchParams({ select: IMAGE_COLS, id: `in.(${uuidRefs.join(",")})`, limit: String(uuidRefs.length) })));
  }
  if (keyRefs.length) {
    const quoted = keyRefs.map((k) => `"${k.replace(/"/g, "")}"`).join(",");
    queries.push(sb(env, "ufc_images", new URLSearchParams({ select: IMAGE_COLS, r2_key: `in.(${quoted})`, limit: String(keyRefs.length) })));
  }
  for (const result of await Promise.all(queries)) {
    for (const row of result.data) {
      const image = decorateImage(env, row);
      map.set(row.id, image);
      map.set(row.r2_key, image);
    }
  }
  // A raw storage key with no ufc_images row still resolves to its durable URL; the credit stays with the article.
  for (const key of keyRefs) {
    if (!map.has(key)) map.set(key, decorateImage(env, { id: null, kind: null, r2_key: key, license: null, author: null, source_url: null, fighter_id: null }));
  }
  return map;
}

function attachHero(article, heroMap) {
  if (!article) return article;
  const ref = article.hero_image_ref || null;
  const image = ref ? heroMap.get(ref) || null : null;
  const credit = article.hero_credit && typeof article.hero_credit === "object" ? article.hero_credit : null;
  const compact = image ? compactImage(image, credit) : null;
  return {
    ...article,
    hero_image_url: compact?.image_url ?? null,
    hero_image: compact ? { ...compact, fighter_id: image.fighter_id ?? null, ref } : null,
  };
}

/* ---- article analysis (docs/editorial_contract.md) -------------------- */

function analysisVersion(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/* Compact bettor-angle summary for list rows. Null unless the fact block is a
 * v2+ editorial block with a bettor_angle; never synthesized from prose. */
function analysisSummaryFrom(version, storyClass, bettorAngle) {
  if (analysisVersion(version) < ANALYSIS_MIN_VERSION) return null;
  if (!bettorAngle || typeof bettorAngle !== "object") return null;
  return {
    impact_score: Number.isFinite(Number(bettorAngle.impact_score)) ? Number(bettorAngle.impact_score) : null,
    markets: Array.isArray(bettorAngle.markets) ? bettorAngle.markets.filter((m) => typeof m === "string") : [],
    odds_status: typeof bettorAngle.odds_status === "string" ? bettorAngle.odds_status : "unavailable",
    model_status: typeof bettorAngle.model_status === "string" ? bettorAngle.model_status : "unavailable",
    story_class: typeof storyClass === "string" ? storyClass : null,
  };
}

/* Full analysis block for article detail: copied field-for-field from a v2+
 * fact block; null for legacy blocks. */
function articleAnalysis(factBlock) {
  if (!factBlock || typeof factBlock !== "object" || analysisVersion(factBlock.version) < ANALYSIS_MIN_VERSION) return null;
  return {
    version: factBlock.version,
    story_class: factBlock.story_class ?? null,
    generated_at: factBlock.generated_at ?? null,
    sources: factBlock.sources ?? null,
    bettor_angle: factBlock.bettor_angle ?? null,
    market_watch: factBlock.market_watch ?? null,
    matchup: factBlock.matchup ?? null,
  };
}

function wordCount(markdown) {
  const text = String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`~|-]+/g, " ");
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu);
  return words ? words.length : 0;
}

function withAnalysis(article) {
  if (!article) return article;
  const { analysis_version, analysis_story_class, analysis_bettor_angle, ...rest } = article;
  const hasBlock = Object.prototype.hasOwnProperty.call(rest, "fact_block");
  const fb = hasBlock && rest.fact_block && typeof rest.fact_block === "object" ? rest.fact_block : null;
  const out = {
    ...rest,
    analysis_summary: hasBlock
      ? analysisSummaryFrom(fb?.version, fb?.story_class, fb?.bettor_angle)
      : analysisSummaryFrom(analysis_version, analysis_story_class, analysis_bettor_angle),
  };
  if (hasBlock) {
    out.analysis = articleAnalysis(fb);
    const wc = wordCount(rest.body_md);
    out.word_count = wc;
    out.reading_minutes = wc ? Math.max(1, Math.ceil(wc / READING_WPM)) : 0;
  }
  return out;
}

async function withHeroMedia(env, articles) {
  const list = Array.isArray(articles) ? articles : [];
  const heroMap = await heroImagesForArticles(env, list);
  return list.map((a) => withAnalysis(attachHero(a, heroMap)));
}

/* ---- rankings --------------------------------------------------------- */

const rankingsState = { probe: null, probedAt: 0, memo: null, memoAt: 0 };

function divisionLabel(division, isWomens, isP4p) {
  if (isP4p) return isWomens ? "Women's Pound-for-Pound" : "Men's Pound-for-Pound";
  const words = String(division || "").toLowerCase().split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return isWomens ? `Women's ${words}` : words;
}

function divisionSortKey(d) {
  const idx = RANKING_DIVISION_ORDER.indexOf(`${d.key}/${d.is_womens ? "w" : "m"}`);
  return idx < 0 ? RANKING_DIVISION_ORDER.length : idx;
}

function sortRankingEntries(entries) {
  return [...entries].sort((a, b) => (a.rank - b.rank) || String(a.name).localeCompare(String(b.name)));
}

async function rankingsTablePresent(env) {
  const now = Date.now();
  if (rankingsState.probe !== null && now - rankingsState.probedAt < RANKINGS_PROBE_TTL_MS) return rankingsState.probe;
  requireDb(env);
  const res = await fetch(sbUrl(env, "ufc_rankings", new URLSearchParams({ select: "snapshot_date", limit: "1" })), { headers: sbHeaders(env) });
  await res.text();
  rankingsState.probe = res.ok;
  rankingsState.probedAt = now;
  return res.ok;
}

async function rankingsFromTable(env) {
  const latest = (await sb(env, "ufc_rankings", new URLSearchParams({ select: "snapshot_date", order: "snapshot_date.desc", limit: "1" }))).data;
  const snapshotDate = latest[0]?.snapshot_date;
  if (!snapshotDate) return null;
  const p = new URLSearchParams({
    select: "snapshot_date,division,is_womens,is_p4p,rank,fighter_id,name_raw,ufc_slug,rank_change,is_new,source_url,captured_at",
    snapshot_date: `eq.${snapshotDate}`,
    order: "division.asc,is_womens.asc,rank.asc,name_raw.asc",
    limit: "1000",
  });
  const rows = (await sb(env, "ufc_rankings", p)).data;
  if (!rows.length) return null;
  const divisions = new Map();
  let capturedAt = null;
  let sourceUrl = null;
  for (const row of rows) {
    if (!capturedAt || String(row.captured_at) > String(capturedAt)) capturedAt = row.captured_at;
    sourceUrl = sourceUrl || row.source_url;
    const k = `${row.division}/${row.is_womens ? "w" : "m"}`;
    if (!divisions.has(k)) {
      divisions.set(k, { key: row.division, label: divisionLabel(row.division, row.is_womens, row.is_p4p), is_womens: Boolean(row.is_womens), is_p4p: Boolean(row.is_p4p), champion: null, entries: [] });
    }
    const d = divisions.get(k);
    const entry = { rank: row.rank, name: row.name_raw, ufc_slug: row.ufc_slug ?? null, fighter_id: row.fighter_id ?? null, change: row.rank_change ?? null, is_new: Boolean(row.is_new) };
    if (row.rank === 0 && !row.is_p4p) d.champion = { name: entry.name, ufc_slug: entry.ufc_slug, fighter_id: entry.fighter_id };
    else d.entries.push(entry);
  }
  return {
    store: "table",
    captured_at: capturedAt,
    source_url: sourceUrl,
    snapshot_date: snapshotDate,
    divisions: [...divisions.values()].map((d) => ({ ...d, entries: sortRankingEntries(d.entries) })).sort((a, b) => divisionSortKey(a) - divisionSortKey(b)),
  };
}

async function rankingsFromSnapshot(env) {
  requireDb(env);
  const base = imageBase(env) || `${String(env.SUPABASE_URL).replace(/\/$/, "")}/storage/v1/object/public/ufc-media`;
  const res = await fetch(`${base}/${RANKINGS_SNAPSHOT_KEY}`, { headers: { Accept: "application/json" }, cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) { await res.text(); return null; }
  let json = null;
  try { json = await res.json(); } catch { return null; }
  if (!json || !Array.isArray(json.divisions)) return null;
  return {
    store: "snapshot",
    captured_at: json.captured_at ?? null,
    source_url: json.source_url ?? null,
    snapshot_date: json.snapshot_date ?? null,
    divisions: json.divisions.map((d) => ({
      key: d.key,
      label: d.label ?? divisionLabel(d.key, d.is_womens, d.is_p4p),
      is_womens: Boolean(d.is_womens),
      is_p4p: Boolean(d.is_p4p),
      champion: d.champion ? { name: d.champion.name, ufc_slug: d.champion.ufc_slug ?? null, fighter_id: d.champion.fighter_id ?? null } : null,
      entries: sortRankingEntries((d.entries || []).map((e) => ({ rank: e.rank, name: e.name, ufc_slug: e.ufc_slug ?? null, fighter_id: e.fighter_id ?? null, change: e.change ?? null, is_new: Boolean(e.is_new) }))),
    })).sort((a, b) => divisionSortKey(a) - divisionSortKey(b)),
  };
}

/* Verified store only: the ufc_rankings table when migration 003 is applied
 * and populated, otherwise the Storage snapshot written by the same ingest.
 * Returns null when neither exists. Never synthesizes. */
async function loadRankings(env) {
  const now = Date.now();
  if (rankingsState.memo && now - rankingsState.memoAt < RANKINGS_MEMO_TTL_MS) return rankingsState.memo;
  let out = null;
  if (await rankingsTablePresent(env)) out = await rankingsFromTable(env);
  if (!out) out = await rankingsFromSnapshot(env);
  if (out) {
    rankingsState.memo = out;
    rankingsState.memoAt = now;
  }
  return out;
}

function rankingsFighterIds(rankings) {
  const ids = new Set();
  for (const d of rankings?.divisions || []) {
    if (d.champion?.fighter_id) ids.add(d.champion.fighter_id);
    for (const e of d.entries || []) if (e.fighter_id) ids.add(e.fighter_id);
  }
  return [...ids];
}

async function fighterIdentities(env, ids) {
  const list = [...new Set((ids || []).filter((id) => id && UUID_RE.test(id)))];
  const map = new Map();
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const p = new URLSearchParams({ select: FIGHTER_IDENTITY_COLS, id: `in.(${chunk.join(",")})`, limit: String(chunk.length) });
    for (const row of (await sb(env, "ufc_fighters", p)).data) map.set(row.id, row);
  }
  return map;
}

function linkedIdentity(fighterId, identityMap) {
  const f = fighterId ? identityMap.get(fighterId) : null;
  return f ? { id: f.id, name: f.name, slug_id: slugId(f) } : null;
}

async function rankingsResponse(env, url) {
  const rankings = await loadRankings(env);
  if (!rankings) {
    throw new ApiError(503, "rankings_not_available", "No verified rankings snapshot is available. No synthetic ranking will be returned.");
  }
  const divisionFilter = String(url.searchParams.get("division") || "").trim().toUpperCase().replace(/-/g, "_");
  const womens = url.searchParams.get("womens");
  let divisions = rankings.divisions;
  if (divisionFilter) divisions = divisions.filter((d) => d.key === divisionFilter);
  if (womens === "true" || womens === "false") divisions = divisions.filter((d) => d.is_womens === (womens === "true"));
  if (divisionFilter && !divisions.length) {
    throw new ApiError(404, "division_not_found", "No ranked division matches the requested filter.", { division: divisionFilter, womens: womens || null });
  }
  const identityMap = await fighterIdentities(env, rankingsFighterIds({ divisions }));
  const data = {
    source: RANKINGS_SOURCE,
    source_url: rankings.source_url,
    snapshot_date: rankings.snapshot_date,
    captured_at: rankings.captured_at,
    divisions: divisions.map((d) => ({
      ...d,
      champion: d.champion ? { ...d.champion, fighter: linkedIdentity(d.champion.fighter_id, identityMap) } : null,
      entries: d.entries.map((e) => ({ ...e, fighter: linkedIdentity(e.fighter_id, identityMap) })),
    })),
  };
  return { data, meta: { store: rankings.store, divisions: data.divisions.length, division: divisionFilter || null, womens: womens || null } };
}

function rankingPositionsForFighter(rankings, fighterId) {
  const positions = [];
  for (const d of rankings?.divisions || []) {
    const base = { division: d.key, label: d.label, is_womens: d.is_womens, is_p4p: d.is_p4p };
    if (d.champion?.fighter_id === fighterId) positions.push({ ...base, rank: 0, is_champion: true, change: null, is_new: false });
    for (const e of d.entries || []) {
      if (e.fighter_id === fighterId) positions.push({ ...base, rank: e.rank, is_champion: false, change: e.change ?? null, is_new: Boolean(e.is_new) });
    }
  }
  return positions;
}

async function fighterRanking(env, fighterId) {
  const rankings = await loadRankings(env);
  if (!rankings) return null;
  return {
    source: RANKINGS_SOURCE,
    source_url: rankings.source_url,
    snapshot_date: rankings.snapshot_date,
    captured_at: rankings.captured_at,
    positions: rankingPositionsForFighter(rankings, fighterId),
  };
}

/* ---- round stats ------------------------------------------------------ */

function sumMetrics(rows) {
  const totals = {};
  for (const key of ROUND_STAT_METRICS) {
    let sum = null;
    for (const r of rows) {
      const v = r[key];
      if (v === null || v === undefined) continue;
      sum = (sum ?? 0) + Number(v);
    }
    totals[key] = sum;
  }
  return totals;
}

function ratio(num, den) {
  return Number.isFinite(num) && Number.isFinite(den) && den > 0 ? Math.round((num / den) * 10000) / 10000 : null;
}

function perMinute(num, seconds, window = 60) {
  return Number.isFinite(num) && Number.isFinite(seconds) && seconds > 0 ? Math.round((num / (seconds / window)) * 100) / 100 : null;
}

/* Elapsed fight time from the recorded result (round + final-round clock);
 * falls back to rounds-with-stats x 5:00 when no result exists. Labelled so
 * consumers know which it was. */
function boutElapsedSeconds(bout, roundsWithStats) {
  const result = bout?.result;
  if (result && Number.isFinite(Number(result.round)) && Number(result.round) > 0) {
    const round = Number(result.round);
    const tail = Number.isFinite(Number(result.time_sec)) ? Number(result.time_sec) : 300;
    return { seconds: (round - 1) * 300 + tail, basis: "result" };
  }
  if (roundsWithStats > 0) return { seconds: roundsWithStats * 300, basis: "rounds_x_5min" };
  return { seconds: null, basis: "unknown" };
}

function totalsByFighter(rows) {
  const byFighter = new Map();
  for (const r of rows) {
    if (!byFighter.has(r.fighter_id)) byFighter.set(r.fighter_id, []);
    byFighter.get(r.fighter_id).push(r);
  }
  const out = {};
  for (const [fighterId, list] of byFighter) {
    out[fighterId] = { rounds: list.length, ...sumMetrics(list) };
  }
  return out;
}

function boutOutcome(bout, fighterId) {
  const result = bout?.result;
  if (!result) return null;
  if (result.method === "NC") return "NC";
  if (result.method === "DRAW") return "D";
  if (!result.winner_id) return null;
  return result.winner_id === fighterId ? "W" : "L";
}

function computeFighterStats(fighter, roundRows, boutsById, imageMap) {
  const byBout = new Map();
  for (const r of roundRows) {
    if (!byBout.has(r.bout_id)) byBout.set(r.bout_id, []);
    byBout.get(r.bout_id).push(r);
  }
  const bouts = [];
  const career = { bouts_with_stats: 0, rounds: 0, fight_time_sec: 0, fight_time_basis: { result: 0, rounds_x_5min: 0 } };
  const careerTotals = {};
  for (const key of ROUND_STAT_METRICS) careerTotals[key] = null;
  for (const [boutId, rows] of byBout) {
    const bout = boutsById.get(boutId) || null;
    const totals = sumMetrics(rows);
    const elapsed = boutElapsedSeconds(bout, rows.length);
    const isA = bout?.fighter_a?.id === fighter.id;
    const opponent = bout ? (isA ? bout.fighter_b : bout.fighter_a) : null;
    bouts.push({
      bout_id: boutId,
      event: compactEvent(bout?.event),
      opponent: compactFighter(opponent, imageMap),
      result: bout?.result ?? null,
      outcome: bout ? boutOutcome(bout, fighter.id) : null,
      rounds: rows.length,
      fight_time_sec: elapsed.seconds,
      fight_time_basis: elapsed.basis,
      totals,
      rounds_detail: [...rows].sort((a, b) => a.round - b.round),
    });
    career.bouts_with_stats += 1;
    career.rounds += rows.length;
    if (elapsed.seconds) {
      career.fight_time_sec += elapsed.seconds;
      career.fight_time_basis[elapsed.basis] += 1;
    }
    for (const key of ROUND_STAT_METRICS) {
      if (totals[key] === null) continue;
      careerTotals[key] = (careerTotals[key] ?? 0) + totals[key];
    }
  }
  bouts.sort((a, b) => String(b.event?.event_date || "").localeCompare(String(a.event?.event_date || "")));
  const t = careerTotals;
  const secs = career.fight_time_sec || null;
  return {
    provenance: {
      source: "ufcstats_round_stats",
      method: "Totals are sums of per-round UFC Stats rows for this fighter. Rates use elapsed fight time from the recorded result (final round + clock), or rounds x 5:00 when no result exists.",
      bouts_with_stats: career.bouts_with_stats,
      rounds: career.rounds,
      fight_time_sec: secs,
      fight_time_basis: career.fight_time_basis,
      coverage_note: "Only bouts with UFC Stats round rows are included; coverage may be partial and these are not as-of model features.",
    },
    career_totals: careerTotals,
    career_rates: {
      sig_str_landed_per_min: perMinute(t.sig_str_landed, secs),
      sig_str_accuracy: ratio(t.sig_str_landed, t.sig_str_att),
      total_str_accuracy: ratio(t.total_str_landed, t.total_str_att),
      td_per_15min: perMinute(t.td_landed, secs, 900),
      td_accuracy: ratio(t.td_landed, t.td_att),
      sub_att_per_15min: perMinute(t.sub_att, secs, 900),
      kd_per_15min: perMinute(t.kd, secs, 900),
      ctrl_share: ratio(t.ctrl_sec, secs),
      head_share: ratio(t.head_landed, t.sig_str_landed),
      body_share: ratio(t.body_landed, t.sig_str_landed),
      leg_share: ratio(t.leg_landed, t.sig_str_landed),
      distance_share: ratio(t.distance_landed, t.sig_str_landed),
      clinch_share: ratio(t.clinch_landed, t.sig_str_landed),
      ground_share: ratio(t.ground_landed, t.sig_str_landed),
    },
    bouts,
  };
}

async function fighterRoundRows(env, fighterId) {
  const p = new URLSearchParams({ select: ROUND_STAT_COLS, fighter_id: `eq.${fighterId}`, order: "bout_id.asc,round.asc", limit: "3000" });
  return (await sb(env, "ufc_bout_round_stats", p)).data;
}

async function fighterBoutRows(env, fighterId, limit = 250) {
  const p = new URLSearchParams({
    select: BOUT_WITH_EVENT_SELECT,
    or: `(fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId})`,
    limit: String(limit),
  });
  return (await sb(env, "ufc_bouts", p)).data.map(normalizeBout)
    .sort((a, b) => String(b.event?.event_date || "").localeCompare(String(a.event?.event_date || "")));
}

function historyRow(bout, fighterId, imageMap) {
  const isA = bout.fighter_a?.id === fighterId;
  const opponent = isA ? bout.fighter_b : bout.fighter_a;
  return {
    ...bout,
    event: bout.event ?? null,
    is_fighter_a: isA,
    opponent: compactFighter(opponent, imageMap),
    outcome: boutOutcome(bout, fighterId),
  };
}

function nextScheduledBout(bouts, fighterId, imageMap) {
  const t = today();
  const upcoming = bouts.filter((b) => !b.result && b.event?.event_date && b.event.event_date >= t && !["cancelled", "replaced", "complete"].includes(b.status));
  upcoming.sort((a, b) => String(a.event.event_date).localeCompare(String(b.event.event_date)));
  return upcoming.length ? historyRow(upcoming[0], fighterId, imageMap) : null;
}

/* ---- auth ------------------------------------------------------------- */

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

/* ---- endpoints -------------------------------------------------------- */

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

async function eventCard(env, eventId, url) {
  const includes = parseIncludes(url, CARD_INCLUDES);
  const event = await resolveEvent(env, eventId);
  if (!event) throw new ApiError(404, "event_not_found", "UFC event not found.");
  const p = new URLSearchParams({ select: BOUT_SELECT, event_id: `eq.${event.id}`, order: "bout_order.desc" });
  const rows = (await sb(env, "ufc_bouts", p)).data.map(normalizeBout);
  const fighterIds = rows.flatMap((b) => [b.fighter_a?.id, b.fighter_b?.id]);
  const [imageMap, roundRows, videos] = await Promise.all([
    imagesForFighters(env, fighterIds),
    includes.has("stats") && rows.length
      ? sb(env, "ufc_bout_round_stats", new URLSearchParams({ select: ROUND_STAT_COLS, bout_id: `in.(${rows.map((b) => b.id).join(",")})`, order: "bout_id.asc,round.asc,fighter_id.asc", limit: "5000" })).then((r) => r.data)
      : Promise.resolve(null),
    includes.has("videos") ? compactVideosFor(env, { event_id: event.id }) : Promise.resolve(null),
  ]);
  let bouts = attachBoutImages(rows, imageMap);
  if (roundRows) {
    const byBout = new Map();
    for (const r of roundRows) {
      if (!byBout.has(r.bout_id)) byBout.set(r.bout_id, []);
      byBout.get(r.bout_id).push(r);
    }
    bouts = bouts.map((b) => {
      const list = byBout.get(b.id) || [];
      return { ...b, round_stats: list, stat_totals: totalsByFighter(list) };
    });
  }
  const meta = { include: [...includes], bouts: bouts.length };
  if (roundRows) meta.round_stat_rows = roundRows.length;
  const data = { event, bouts };
  if (includes.has("videos")) { data.videos = videos; meta.videos = videos ? videos.length : null; }
  return { data, meta };
}

async function listFighters(env, url) {
  const q = sanitizeLike(url.searchParams.get("q"));
  const active = url.searchParams.get("active");
  const limit = clampInt(url.searchParams.get("limit"), 60, 1, 250);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 100000);
  const p = new URLSearchParams({ select: FIGHTER_COLS, order: "name.asc", limit: String(limit) });
  if (offset) p.set("offset", String(offset));
  if (q) p.set("name", `ilike.*${q}*`);
  if (active === "true" || active === "false") p.set("is_active", `eq.${active}`);
  const { data, count } = await sb(env, "ufc_fighters", p, { count: true });
  const imageMap = await imagesForFighters(env, data.map((f) => f.id));
  const rows = data.map((f) => withPrimaryImage(f, imageMap));
  return { data: rows, meta: { count: rows.length, total: count, offset, q: q || null, active: active || null, with_media: rows.filter((f) => f.primary_image).length } };
}

function careerSnapshot(fighter) {
  return {
    slpm: fighter.career_slpm,
    striking_accuracy: fighter.career_str_acc,
    sapm: fighter.career_sapm,
    striking_defense: fighter.career_str_def,
    takedown_average: fighter.career_td_avg,
    takedown_accuracy: fighter.career_td_acc,
    takedown_defense: fighter.career_td_def,
    submission_average: fighter.career_sub_avg,
  };
}

const CAREER_SNAPSHOT_WARNING = "Career snapshot fields are display-only and must not be used as historical model features because they include future information relative to older bouts.";

async function fighterDetail(env, fighterId, url) {
  const includes = parseIncludes(url, FIGHTER_INCLUDES);
  const fighter = await resolveFighter(env, fighterId);
  if (!fighter) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.");
  const needBouts = includes.has("next") || includes.has("history") || includes.has("stats");
  const historyLimit = clampInt(url.searchParams.get("history_limit"), 100, 1, 250);
  const [ownImages, bouts, roundRows, ranking, videos] = await Promise.all([
    imagesForFighters(env, [fighter.id]),
    needBouts ? fighterBoutRows(env, fighter.id, 250) : Promise.resolve([]),
    includes.has("stats") ? fighterRoundRows(env, fighter.id) : Promise.resolve(null),
    includes.has("ranking") ? fighterRanking(env, fighter.id) : Promise.resolve(undefined),
    includes.has("videos") ? compactVideosFor(env, { fighter_id: fighter.id }) : Promise.resolve(null),
  ]);
  const opponentIds = bouts.flatMap((b) => [b.fighter_a?.id, b.fighter_b?.id]).filter((id) => id && id !== fighter.id);
  const imageMap = opponentIds.length ? await imagesForFighters(env, opponentIds) : new Map();
  for (const [k, v] of ownImages) imageMap.set(k, v);

  const data = { ...fighter, slug_id: slugId(fighter), images: ownImages.get(fighter.id) || [], primary_image: primaryImage(ownImages.get(fighter.id)) };
  if (includes.has("ranking")) data.ranking = ranking ?? null;
  if (includes.has("next")) data.next_bout = nextScheduledBout(bouts, fighter.id, imageMap);
  if (includes.has("history")) data.history = bouts.slice(0, historyLimit).map((b) => historyRow(b, fighter.id, imageMap));
  if (includes.has("stats")) {
    const boutsById = new Map(bouts.map((b) => [b.id, b]));
    data.stats = {
      career_snapshot: careerSnapshot(fighter),
      warning: CAREER_SNAPSHOT_WARNING,
      computed: computeFighterStats(fighter, roundRows || [], boutsById, imageMap),
    };
  }
  if (includes.has("videos")) data.videos = videos; // null while the video table is missing, never omitted
  const meta = { include: [...includes] };
  if (includes.has("history")) meta.history_count = data.history.length;
  if (includes.has("stats")) meta.round_stat_rows = (roundRows || []).length;
  if (includes.has("videos")) meta.videos = videos ? videos.length : null;
  return { data, meta };
}

async function fighterHistory(env, fighterId, url) {
  const fighter = await resolveFighter(env, fighterId);
  if (!fighter) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.");
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 250);
  const rows = await fighterBoutRows(env, fighter.id, limit);
  return { fighter, bouts: rows.map((b) => historyRow(b, fighter.id, null)) };
}

async function fighterStats(env, fighterId) {
  const fighter = await resolveFighter(env, fighterId);
  if (!fighter) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.");
  const roundRows = await fighterRoundRows(env, fighter.id);
  const boutIds = [...new Set(roundRows.map((r) => r.bout_id))];
  const bouts = boutIds.length
    ? (await sb(env, "ufc_bouts", new URLSearchParams({ select: BOUT_WITH_EVENT_SELECT, id: `in.(${boutIds.join(",")})`, limit: String(boutIds.length) }))).data.map(normalizeBout)
    : [];
  const boutsById = new Map(bouts.map((b) => [b.id, b]));
  const opponentIds = bouts.flatMap((b) => [b.fighter_a?.id, b.fighter_b?.id]).filter((id) => id && id !== fighter.id);
  const imageMap = await imagesForFighters(env, opponentIds);
  return {
    fighter: {
      id: fighter.id,
      ufcstats_id: fighter.ufcstats_id,
      espn_athlete_id: fighter.espn_athlete_id,
      slug_id: slugId(fighter),
      name: fighter.name,
    },
    career_snapshot: careerSnapshot(fighter),
    warning: CAREER_SNAPSHOT_WARNING,
    round_stats: roundRows,
    computed: computeFighterStats(fighter, roundRows, boutsById, imageMap),
  };
}

async function boutStats(env, boutId) {
  const bout = await resolveBout(env, boutId);
  if (!bout) throw new ApiError(404, "bout_not_found", "UFC bout not found.");
  const p = new URLSearchParams({
    select: ROUND_STAT_COLS,
    bout_id: `eq.${bout.id}`,
    order: "round.asc,fighter_id.asc",
  });
  const rounds = (await sb(env, "ufc_bout_round_stats", p)).data;
  const elapsed = boutElapsedSeconds(bout, new Set(rounds.map((r) => r.round)).size);
  return {
    bout,
    rounds,
    totals: totalsByFighter(rounds),
    fight_time_sec: elapsed.seconds,
    fight_time_basis: elapsed.basis,
    provenance: { source: "ufcstats_round_stats", rows: rounds.length, has_stats: bout.result?.has_stats ?? null },
  };
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
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 100000);
  const storyType = sanitizeLike(url.searchParams.get("story_type"));
  const storyClass = sanitizeLike(url.searchParams.get("story_class"));
  const p = new URLSearchParams({
    select: ARTICLE_LIST_SELECT,
    status: "eq.published",
    order: "published_at.desc",
    limit: String(limit),
  });
  if (offset) p.set("offset", String(offset));
  if (storyType) p.set("story_type", `eq.${storyType}`);
  if (storyClass) p.set("fact_block->>story_class", `eq.${storyClass}`);
  const { data, count } = await sb(env, "ufc_articles", p, { count: true });
  const rows = await withHeroMedia(env, data);
  return {
    data: rows,
    meta: {
      count: rows.length, total: count, offset, story_type: storyType || null, story_class: storyClass || null,
      with_hero: rows.filter((a) => a.hero_image_url).length, with_analysis: rows.filter((a) => a.analysis_summary).length,
    },
  };
}

async function articlesForEvent(env, eventId, url) {
  const event = await resolveEvent(env, eventId);
  if (!event) throw new ApiError(404, "event_not_found", "UFC event not found.");
  const limit = clampInt(url.searchParams.get("limit"), 12, 1, 100);
  const p = new URLSearchParams({ select: ARTICLE_LIST_SELECT, status: "eq.published", event_id: `eq.${event.id}`, order: "published_at.desc", limit: String(limit) });
  const rows = await withHeroMedia(env, (await sb(env, "ufc_articles", p)).data);
  return { data: { event: compactEvent(event), articles: rows }, meta: { count: rows.length } };
}

async function articlesForFighter(env, fighterId, url) {
  const fighter = await resolveFighter(env, fighterId);
  if (!fighter) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.");
  const limit = clampInt(url.searchParams.get("limit"), 8, 1, 100);
  const p = new URLSearchParams({ select: ARTICLE_LIST_SELECT, status: "eq.published", fighter_ids: `cs.{${fighter.id}}`, order: "published_at.desc", limit: String(limit) });
  const rows = await withHeroMedia(env, (await sb(env, "ufc_articles", p)).data);
  return { data: { fighter: compactFighter(fighter, null), articles: rows }, meta: { count: rows.length } };
}

async function articleDetail(env, slug) {
  const p = new URLSearchParams({
    select: ARTICLE_DETAIL_COLS,
    status: "eq.published",
    slug: `eq.${slug}`,
    limit: "1",
  });
  const rows = (await sb(env, "ufc_articles", p)).data;
  if (!rows[0]) return null;
  return (await withHeroMedia(env, [rows[0]]))[0];
}

async function counts(env) {
  const specs = [
    ["fighters", "ufc_fighters", "id"],
    ["events", "ufc_events", "id"],
    ["bouts", "ufc_bouts", "id"],
    ["results", "ufc_bout_results", "bout_id"],
    ["round_stat_rows", "ufc_bout_round_stats", "bout_id"],
    ["articles", "ufc_articles", "id", "status", "eq.published"],
    ["images", "ufc_images", "id"],
    ["fighters_with_media", "ufc_images", "fighter_id", "fighter_id", "not.is.null"],
  ];
  const values = await Promise.all(specs.map(async ([key, table, col, filterCol, filter]) => {
    const p = new URLSearchParams({ select: col, limit: "1" });
    if (filterCol) p.set(filterCol, filter);
    const result = await sb(env, table, p, { count: true });
    return [key, result.count];
  }));
  const out = Object.fromEntries(values);
  out.rounds = out.round_stat_rows;
  return out;
}

async function searchAll(env, url) {
  const q = sanitizeLike(url.searchParams.get("q"));
  if (!q || q.length < 2) throw new ApiError(400, "invalid_query", "Search query must contain at least 2 characters.");
  const limit = clampInt(url.searchParams.get("limit"), 10, 1, 25);
  const fp = new URLSearchParams({ select: FIGHTER_BRIEF_COLS, name: `ilike.*${q}*`, order: "name.asc", limit: String(limit) });
  const ep = new URLSearchParams({ select: EVENT_COLS, name: `ilike.*${q}*`, order: "event_date.desc.nullslast", limit: String(limit) });
  const ap = new URLSearchParams({ select: ARTICLE_LIST_SELECT, status: "eq.published", headline: `ilike.*${q}*`, order: "published_at.desc", limit: String(limit) });
  const [fighters, events, articles] = await Promise.all([
    sb(env, "ufc_fighters", fp), sb(env, "ufc_events", ep), sb(env, "ufc_articles", ap),
  ]);
  const [imageMap, articleRows] = await Promise.all([
    imagesForFighters(env, fighters.data.map((f) => f.id)),
    withHeroMedia(env, articles.data),
  ]);
  return {
    q,
    fighters: fighters.data.map((f) => ({ ...withPrimaryImage(f, imageMap), slug_id: slugId(f) })),
    events: events.data,
    articles: articleRows,
  };
}

/* ---- live wire (ufc_news_items) --------------------------------------- */

const WIRE_LIVE_MINUTES = 120;
const WIRE_FIGHT_WEEK_AHEAD_DAYS = 6;
const WIRE_FIGHT_WEEK_BEHIND_DAYS = 1;
const WIRE_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=120",
  "CDN-Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
};
const WIRE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "for", "with", "vs", "vs.", "v", "as", "by", "from", "is", "are",
  "his", "her", "their", "its", "this", "that", "after", "before", "over", "into", "out", "up", "off", "ufc", "mma",
]);
const WIRE_ITEM_COLS = "id,url,title,published_at,summary,taxonomy,fighter_ids,event_id,bout_id,source:ufc_news_sources(name,url)";
const WIRE_BOUT_SELECT = "id,event_id,fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(id,name,espn_athlete_id,ufcstats_id),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(id,name,espn_athlete_id,ufcstats_id),event:ufc_events(id,name,event_date)";
const CONTENDER_SERIES_RE = /contender series|road to ufc/i;

/* Same public slug rules as web/lib/slug.ts. */
function slugify(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fighterSlug(f) {
  const id = slugId(f);
  return f?.name && id ? `${slugify(f.name)}-${id}` : null;
}

function eventSlug(e) {
  return e?.name ? `${slugify(e.name)}-${e.event_date || "tbd"}` : null;
}

function matchupSlug(a, b, e) {
  const ev = eventSlug(e);
  return a?.name && b?.name && ev ? `${slugify(a.name)}-vs-${slugify(b.name)}-${ev}` : null;
}

/* Dedupe key: lowercase, strip punctuation and stopwords, first 60 chars. */
function normalizeTitle(title) {
  return String(title || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !WIRE_STOPWORDS.has(w))
    .join(" ")
    .slice(0, 60)
    .trim();
}

/* Collapse near-identical headlines from multiple feeds, keeping the copy
 * published first. Output is newest-first by the kept copy's timestamp. */
function dedupeWireItems(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = normalizeTitle(item.title) || `id:${item.id}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, item); continue; }
    const a = String(item.published_at || "9999");
    const b = String(prev.published_at || "9999");
    if (a < b) byKey.set(key, item);
  }
  return [...byKey.values()].sort((x, y) => String(y.published_at || "").localeCompare(String(x.published_at || "")));
}

function articleMatchesItem(article, item) {
  if (item.bout_id && article.bout_id && article.bout_id === item.bout_id) return true;
  if (item.event_id && article.event_id && article.event_id === item.event_id) {
    const fids = new Set(Array.isArray(item.fighter_ids) ? item.fighter_ids : []);
    if ((Array.isArray(article.fighter_ids) ? article.fighter_ids : []).some((id) => fids.has(id))) return true;
  }
  const sources = Array.isArray(article.sources) ? article.sources : [];
  return sources.some((s) => s && typeof s === "object" && s.kind === "news_item" && ((s.id && s.id === item.id) || (s.url && item.url && s.url === item.url)));
}

function wireInternalUrl(item, { articles, boutsById, eventsById, fightersById }) {
  const article = articles.find((a) => articleMatchesItem(a, item));
  if (article?.slug) return `/news/${article.slug}`;
  const bout = item.bout_id ? boutsById.get(item.bout_id) : null;
  if (bout) {
    const slug = matchupSlug(bout.fighter_a, bout.fighter_b, bout.event || eventsById.get(bout.event_id));
    if (slug) return `/fights/${slug}`;
  }
  const event = item.event_id ? eventsById.get(item.event_id) : null;
  if (event) {
    const slug = eventSlug(event);
    if (slug) return `/events/${slug}`;
  }
  const fids = Array.isArray(item.fighter_ids) ? item.fighter_ids.filter(Boolean) : [];
  if (fids.length === 1) {
    const slug = fighterSlug(fightersById.get(fids[0]));
    if (slug) return `/fighters/${slug}`;
  }
  return null;
}

function wireTaxonomy(taxonomy) {
  const labels = taxonomy && typeof taxonomy === "object" && Array.isArray(taxonomy.labels) ? taxonomy.labels.filter((l) => typeof l === "string" && l) : [];
  return labels[0] || null;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fightWeek(env, now = new Date()) {
  const t = now.toISOString().slice(0, 10);
  const p = new URLSearchParams({
    select: "id,name,event_date",
    event_date: `gte.${addDays(t, -WIRE_FIGHT_WEEK_BEHIND_DAYS)}`,
    order: "event_date.asc",
    limit: "20",
  });
  p.append("event_date", `lte.${addDays(t, WIRE_FIGHT_WEEK_AHEAD_DAYS)}`);
  const rows = (await sb(env, "ufc_events", p)).data;
  const hits = rows.filter((e) => e.name && !CONTENDER_SERIES_RE.test(e.name));
  return { fight_week: hits.length > 0, events: hits.map((e) => ({ id: e.id, name: e.name, event_date: e.event_date })) };
}

async function wire(env, url, now = new Date()) {
  const limit = clampInt(url.searchParams.get("limit"), 20, 1, 50);
  const ip = new URLSearchParams({ select: WIRE_ITEM_COLS, order: "published_at.desc.nullslast", limit: String(Math.min(limit * 3, 150)) });
  const [rawItems, week] = await Promise.all([sb(env, "ufc_news_items", ip).then((r) => r.data), fightWeek(env, now)]);
  const fetched = rawItems.length;
  const items = dedupeWireItems(rawItems).slice(0, limit);

  const boutIds = [...new Set(items.map((i) => i.bout_id).filter(Boolean))];
  const eventIds = [...new Set(items.map((i) => i.event_id).filter(Boolean))];
  const soloFighterIds = [...new Set(items.filter((i) => Array.isArray(i.fighter_ids) && i.fighter_ids.filter(Boolean).length === 1).map((i) => i.fighter_ids[0]))];
  const articleSelect = "id,slug,bout_id,event_id,fighter_ids,sources,published_at";
  const [boutRows, eventRows, fighterRows, byBout, byEvent, byNewsItem] = await Promise.all([
    boutIds.length ? sb(env, "ufc_bouts", new URLSearchParams({ select: WIRE_BOUT_SELECT, id: `in.(${boutIds.join(",")})`, limit: String(boutIds.length) })).then((r) => r.data) : [],
    eventIds.length ? sb(env, "ufc_events", new URLSearchParams({ select: "id,name,event_date", id: `in.(${eventIds.join(",")})`, limit: String(eventIds.length) })).then((r) => r.data) : [],
    soloFighterIds.length ? sb(env, "ufc_fighters", new URLSearchParams({ select: FIGHTER_IDENTITY_COLS, id: `in.(${soloFighterIds.join(",")})`, limit: String(soloFighterIds.length) })).then((r) => r.data) : [],
    boutIds.length ? sb(env, "ufc_articles", new URLSearchParams({ select: articleSelect, status: "eq.published", bout_id: `in.(${boutIds.join(",")})`, order: "published_at.desc", limit: "200" })).then((r) => r.data) : [],
    eventIds.length ? sb(env, "ufc_articles", new URLSearchParams({ select: articleSelect, status: "eq.published", event_id: `in.(${eventIds.join(",")})`, order: "published_at.desc", limit: "200" })).then((r) => r.data) : [],
    sb(env, "ufc_articles", new URLSearchParams({ select: articleSelect, status: "eq.published", sources: 'cs.[{"kind":"news_item"}]', order: "published_at.desc", limit: "200" })).then((r) => r.data),
  ]);
  const seen = new Set();
  const articles = [...byBout, ...byEvent, ...byNewsItem]
    .filter((a) => a?.slug && !seen.has(a.id) && seen.add(a.id))
    .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
  const ctx = {
    articles,
    boutsById: new Map(boutRows.map((b) => [b.id, b])),
    eventsById: new Map(eventRows.map((e) => [e.id, e])),
    fightersById: new Map(fighterRows.map((f) => [f.id, f])),
  };

  const data = items.map((item) => ({
    id: item.id,
    title: item.title,
    published_at: item.published_at ?? null,
    summary: item.summary ?? null,
    taxonomy: wireTaxonomy(item.taxonomy),
    taxonomy_detail: item.taxonomy && typeof item.taxonomy === "object" ? item.taxonomy : null,
    source: { name: item.source?.name ?? null, url: item.source?.url ?? null },
    source_url: item.url ?? null,
    fighter_ids: Array.isArray(item.fighter_ids) ? item.fighter_ids : [],
    event_id: item.event_id ?? null,
    bout_id: item.bout_id ?? null,
    internal_url: wireInternalUrl(item, ctx),
  }));

  const newest = data.map((i) => i.published_at).filter(Boolean).sort().reverse()[0] || null;
  const newestMs = newest ? Date.parse(newest) : NaN;
  const freshness = Number.isFinite(newestMs) ? Math.max(0, Math.round((now.getTime() - newestMs) / 60000)) : null;
  const meta = {
    generated_at: now.toISOString(),
    newest_published_at: newest,
    count: data.length,
    limit,
    fetched,
    deduped: fetched - dedupeWireItems(rawItems).length,
    freshness_minutes: freshness,
    live: freshness !== null && freshness <= WIRE_LIVE_MINUTES,
    live_threshold_minutes: WIRE_LIVE_MINUTES,
    fight_week: week.fight_week,
    fight_week_events: week.events,
    linked: data.filter((i) => i.internal_url).length,
  };
  return { data, meta };
}

/* ---- Fight DNA (docs/fight_dna_api.md, docs/FIGHT_DNA_CONTRACT.md) ---- */

const DNA_DEFINITION_VERSION = 1;
const DNA_ORIGIN = "pbe_derived";
const DNA_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=900",
  "CDN-Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
};
const DNA_AS_OF_NOTE = "as_of_date is exclusive: the snapshot dated D contains bouts with event_date < D, so a bout fought on D is excluded by the snapshot dated D. ?as_of=D resolves to the latest stored snapshot with as_of_date <= D, which therefore never contains a bout fought on or after D.";
const DNA_EVIDENCE_NOTE = "Fight DNA is PBE-derived evidence with explicit samples and confidence. It is not a pick, price or probability.";
const DNA_SCHEMA_MISSING_MESSAGE = "Fight DNA tables are not available yet (migration 004 not applied). No synthetic DNA will be returned.";
const DNA_STANCES = ["ORTHODOX", "SOUTHPAW", "SWITCH", "OPEN_STANCE", "SIDEWAYS", "UNKNOWN"];
const DNA_CONFIDENCE_RANK = { insufficient: 0, low: 1, medium: 2, high: 3 };
const DNA_CONFIDENCE_TIERS = {
  insufficient: "sample below the metric's registry minimum (min_bouts / min_rounds / min_seconds); value is null when there is no denominator",
  low: "minimum met but sample_bouts < 3 (result metrics) or sample_seconds < 1800 (rate metrics)",
  medium: "sample_bouts < 8 (result metrics) or sample_seconds < 5400 (rate metrics)",
  high: "sample_bouts >= 8 (result metrics) or sample_seconds >= 5400 (rate metrics)",
};
const DNA_ORIGIN_LABELS = { pbe_derived: "PBE DERIVED", source: "SOURCE", licensed: "LICENSED", model: "MODEL" };
const DNA_FAMILY_ORDER = ["stance", "striking", "pace", "grappling", "finish", "context", "position", "composite", "opponent_adjusted"];
const DNA_SNAPSHOT_COLS = [
  "fighter_id", "as_of_date", "definition_version", "sample_bouts", "sample_completed_bouts", "sample_stat_bouts",
  "sample_rounds", "sample_seconds", "coverage_status", "metrics", "stance_splits", "round_profile", "finish_profile",
  "context_splits", "position_profile", "archetype", "provenance", "generated_at",
].join(",");
const DNA_SPLIT_COLS = [
  "fighter_id", "as_of_date", "opponent_stance", "definition_version", "appearances", "wins", "losses", "draws", "no_contests",
  "ko_tko_wins", "submission_wins", "decision_wins", "stat_bouts", "stat_rounds", "observed_seconds", "metrics", "confidence",
  "provenance", "generated_at",
].join(",");
const DNA_METRIC_DEF_COLS = "metric_key,definition_version,family,display_name,description,unit,formula,source_families,min_bouts,min_rounds,min_seconds,public,active,updated_at";
const DNA_FIGHTER_COLS = "id,name,nickname,ufcstats_id,espn_athlete_id,stance,is_active,record_w,record_l,record_d,record_nc";
// Supabase PostgREST max_rows is 1000: a larger limit is silently clamped, so the cap is declared honestly here and in meta.
const DNA_QUERY_CANDIDATE_LIMIT = 1000;
const DNA_SPLIT_METRIC_KEYS = ["finish_rate", "ko_rate", "sub_rate", "sig_diff_per_min", "kd_per_15", "td_landed_per_15"];
const DNA_SPLIT_METRIC_ALIASES = {
  stance_finish_rate: "finish_rate", stance_ko_rate: "ko_rate", stance_sub_rate: "sub_rate",
  stance_sig_diff_per_min: "sig_diff_per_min", stance_kd_rate_15: "kd_per_15", stance_td_rate_15: "td_landed_per_15",
};

/* Paired matchup comparisons. `aliases` are the registry/builder spellings a
 * metric may be stored under; `higher_is_better` is null for contextual
 * shares/rates where more is not better. `mismatch` names the insight family
 * and `min_abs_delta` its magnitude threshold (see DNA_INSIGHT_RULES). */
const DNA_COMPARISONS = [
  { key: "sig_landed_per_min", label: "Sig. strikes landed / min", unit: "per_min", family: "striking", higher_is_better: true },
  { key: "sig_absorbed_per_min", label: "Sig. strikes absorbed / min", unit: "per_min", family: "striking", higher_is_better: false },
  { key: "sig_accuracy", label: "Sig. strike accuracy", unit: "ratio", family: "striking", higher_is_better: true },
  { key: "sig_defense", label: "Sig. strike defense", unit: "ratio", family: "striking", higher_is_better: true },
  { key: "head_attack_share", label: "Head attack share", unit: "ratio", family: "striking", higher_is_better: null, mismatch: "target_share_mismatch", min_abs_delta: 0.10 },
  { key: "body_attack_share", label: "Body attack share", unit: "ratio", family: "striking", higher_is_better: null, mismatch: "target_share_mismatch", min_abs_delta: 0.10 },
  { key: "leg_attack_share", label: "Leg attack share", unit: "ratio", family: "striking", higher_is_better: null, mismatch: "target_share_mismatch", min_abs_delta: 0.10 },
  { key: "distance_attack_share", label: "Distance attack share", unit: "ratio", family: "striking", higher_is_better: null, mismatch: "phase_share_mismatch", min_abs_delta: 0.10 },
  { key: "clinch_attack_share", label: "Clinch attack share", unit: "ratio", family: "striking", higher_is_better: null, mismatch: "phase_share_mismatch", min_abs_delta: 0.10 },
  { key: "ground_attack_share", label: "Ground attack share", unit: "ratio", family: "striking", higher_is_better: null, mismatch: "phase_share_mismatch", min_abs_delta: 0.10 },
  { key: "kd_per_15", aliases: ["knockdowns_per_15"], label: "Knockdowns / 15 min", unit: "per_15", family: "striking", higher_is_better: true },
  { key: "td_attempts_per_15", label: "Takedown attempts / 15 min", unit: "per_15", family: "grappling", higher_is_better: null, mismatch: "grappling_mismatch", min_abs_delta: 1.0 },
  { key: "td_accuracy", label: "Takedown accuracy", unit: "ratio", family: "grappling", higher_is_better: true, mismatch: "grappling_mismatch", min_abs_delta: 0.10 },
  { key: "control_seconds_per_td", label: "Control seconds / takedown", unit: "seconds_per_td", family: "grappling", higher_is_better: true, mismatch: "grappling_mismatch", min_abs_delta: 30 },
  { key: "sub_attempts_per_15", label: "Submission attempts / 15 min", unit: "per_15", family: "grappling", higher_is_better: null, mismatch: "grappling_mismatch", min_abs_delta: 0.5 },
  { key: "pace_retention_r2_vs_r1", label: "R2 pace retention", unit: "ratio", family: "pace", higher_is_better: true },
  { key: "pace_retention_r3_vs_r1", label: "R3 pace retention", unit: "ratio", family: "pace", higher_is_better: true, mismatch: "pace_retention_mismatch", min_abs_delta: 0.10 },
  { key: "finish_rate", label: "Finish rate (finishes / wins)", unit: "ratio", family: "finish", higher_is_better: null },
];

/* Insight thresholds. An insight is emitted only when every rule below is met;
 * otherwise the missing sample is named in warnings[]. Never from `insufficient`. */
const DNA_INSIGHT_RULES = {
  version: 1,
  min_confidence: "low",
  stance_history: { min_appearances: 3, min_confidence: "low" },
  stance_finish_rate: { min_appearances: 3, min_confidence: "low", note: "finish_rate MetricObject of the split must itself be >= low (registry min 2 wins)" },
  pace_retention: { metric: "pace_retention_r3_vs_r1", min_bouts: 2, min_confidence: "low" },
  pace_retention_mismatch: { metric: "pace_retention_r3_vs_r1", min_bouts: 2, min_confidence: "low", min_abs_delta: 0.10 },
  target_share_mismatch: { metrics: ["head_attack_share", "body_attack_share", "leg_attack_share"], min_confidence: "low", min_abs_delta: 0.10 },
  phase_share_mismatch: { metrics: ["distance_attack_share", "clinch_attack_share", "ground_attack_share"], min_confidence: "low", min_abs_delta: 0.10 },
  grappling_mismatch: { min_confidence: "low", min_abs_delta: { td_attempts_per_15: 1.0, td_accuracy: 0.10, control_seconds_per_td: 30, sub_attempts_per_15: 0.5 } },
  finish_rate: { metric: "finish_rate", min_confidence: "low" },
};

function dnaSchemaMissing() {
  return new ApiError(503, "dna_not_available", DNA_SCHEMA_MISSING_MESSAGE, { reason: "schema_not_applied" });
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function isMetricObject(m) {
  return Boolean(m) && typeof m === "object" && !Array.isArray(m) && "value" in m;
}

/* A family "has values" when at least one MetricObject inside it carries a non-null value
 * (a distribution counts when its total > 0). The builder may store a full structure of
 * null-valued MetricObjects for zero-coverage fighters; that is explicit, not available. */
function familyHasValues(block, depth = 0) {
  if (!block || typeof block !== "object" || depth > 4) return false;
  if (isMetricObject(block)) {
    const v = block.value;
    if (v && typeof v === "object" && !Array.isArray(v)) return numOrNull(v.total) !== null ? Number(v.total) > 0 : Object.keys(v).length > 0;
    return numOrNull(v) !== null;
  }
  return Object.values(block).some((v) => familyHasValues(v, depth + 1));
}

function confRank(c) {
  return DNA_CONFIDENCE_RANK[String(c || "insufficient").toLowerCase()] ?? 0;
}

/* A metric may back an insight only with a numeric value and confidence >= min. */
function meetsConfidence(m, min = "low") {
  return isMetricObject(m) && numOrNull(m.value) !== null && confRank(m.confidence) >= confRank(min);
}

function normalizeStance(s) {
  const v = String(s ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return v || null;
}

function stanceNoun(stance) {
  return {
    ORTHODOX: "orthodox opponents", SOUTHPAW: "southpaws", SWITCH: "switch-stance opponents",
    OPEN_STANCE: "open-stance-listed opponents", SIDEWAYS: "sideways-listed opponents", UNKNOWN: "opponents with an unlisted stance",
  }[stance] || `${String(stance).toLowerCase()} opponents`;
}

function stanceMatchupContext(a, b) {
  if (!a || !b || a === "UNKNOWN" || b === "UNKNOWN") return "unknown";
  if (a === "SWITCH" || b === "SWITCH") return "switch_involved";
  return a === b ? "same" : "open";
}

function fmtValue(v, unit) {
  const n = numOrNull(v);
  if (n === null) return "n/a";
  if (unit === "ratio") return `${Math.round(n * 100)}%`;
  if (unit === "seconds_per_td" || unit === "seconds") return `${Math.round(n)} s`;
  return n.toFixed(2);
}

function fmtSample(m) {
  const parts = [];
  const b = numOrNull(m?.sample_bouts);
  const r = numOrNull(m?.sample_rounds);
  const s = numOrNull(m?.sample_seconds);
  if (b !== null) parts.push(`${b} bout${b === 1 ? "" : "s"}`);
  if (r !== null && r > 0) parts.push(`${r} round${r === 1 ? "" : "s"}`);
  if (s !== null && s > 0) parts.push(`${(s / 60).toFixed(1)} min`);
  return parts.length ? parts.join(" / ") : "no sample";
}

function describeConfidence(m) {
  return isMetricObject(m) ? `confidence ${m.confidence || "insufficient"} (${fmtSample(m)})` : "metric not stored";
}

/* Locate a comparison metric wherever the builder stored it (metrics, round_profile, finish_profile), honouring aliases. */
function findMetric(snapshot, spec) {
  if (!snapshot) return null;
  const keys = [spec.key, ...(spec.aliases || [])];
  for (const src of [snapshot.metrics, snapshot.round_profile, snapshot.finish_profile]) {
    if (!src || typeof src !== "object") continue;
    for (const k of keys) if (isMetricObject(src[k])) return src[k];
  }
  return null;
}

function parseAsOf(url) {
  const raw = url.searchParams.get("as_of");
  if (raw === null || raw === "") return null;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) && new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) === raw;
  if (!ok) throw new ApiError(400, "invalid_as_of", "as_of must be a calendar date formatted YYYY-MM-DD.", { as_of: raw });
  return raw;
}

function parseDefinitionVersion(url) {
  return clampInt(url.searchParams.get("version"), DNA_DEFINITION_VERSION, 1, 99);
}

function parseStanceParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  const stance = normalizeStance(raw);
  if (!DNA_STANCES.includes(stance)) throw new ApiError(400, "invalid_stance", `Unknown ${name} value.`, { [name]: raw, allowed: DNA_STANCES });
  return stance;
}

function dnaFighter(fighter, imageMap) {
  if (!fighter) return null;
  return { ...compactFighter(fighter, imageMap), stance: normalizeStance(fighter.stance), is_active: fighter.is_active ?? null };
}

function snapshotView(row) {
  return {
    as_of_date: row.as_of_date,
    definition_version: row.definition_version ?? DNA_DEFINITION_VERSION,
    sample_bouts: row.sample_bouts ?? 0,
    sample_completed_bouts: row.sample_completed_bouts ?? 0,
    sample_stat_bouts: row.sample_stat_bouts ?? 0,
    sample_rounds: row.sample_rounds ?? 0,
    sample_seconds: row.sample_seconds ?? 0,
    coverage_status: row.coverage_status || "insufficient",
    metrics: asObject(row.metrics),
    stance_splits: asObject(row.stance_splits),
    round_profile: asObject(row.round_profile),
    finish_profile: asObject(row.finish_profile),
    context_splits: asObject(row.context_splits),
    position_profile: asObject(row.position_profile),
    archetype: row.archetype ?? null,
    provenance: asObject(row.provenance),
    generated_at: row.generated_at ?? null,
    origin: DNA_ORIGIN,
  };
}

function sampleContext(s) {
  return {
    sample_bouts: s.sample_bouts, sample_completed_bouts: s.sample_completed_bouts, sample_stat_bouts: s.sample_stat_bouts,
    sample_rounds: s.sample_rounds, sample_seconds: s.sample_seconds,
    sample_minutes: Math.round((Number(s.sample_seconds) || 0) / 6) / 10,
    coverage_status: s.coverage_status,
  };
}

function splitView(row) {
  return {
    ...row,
    metrics: asObject(row.metrics),
    record: { w: row.wins ?? 0, l: row.losses ?? 0, d: row.draws ?? 0, nc: row.no_contests ?? 0, appearances: row.appearances ?? 0 },
    origin: DNA_ORIGIN,
  };
}

/* Latest snapshot with as_of_date <= asOf (or the latest overall). `present:false` = table missing. */
async function loadSnapshot(env, fighterId, { asOf = null, version = DNA_DEFINITION_VERSION } = {}) {
  const p = new URLSearchParams({ select: DNA_SNAPSHOT_COLS, fighter_id: `eq.${fighterId}`, definition_version: `eq.${version}`, order: "as_of_date.desc", limit: "1" });
  if (asOf) p.set("as_of_date", `lte.${asOf}`);
  const res = await sb(env, "ufc_fighter_dna_snapshots", p, { optional: true });
  if (res === null) return { present: false, snapshot: null };
  const rows = [...res.data].sort((a, b) => String(b.as_of_date).localeCompare(String(a.as_of_date)));
  return { present: true, snapshot: rows[0] || null };
}

function noSnapshotError(fighter, asOf, version) {
  return new ApiError(404, "dna_not_available",
    `No Fight DNA snapshot exists for ${fighter.name}${asOf ? ` at or before ${asOf}` : ""}. Nothing is synthesized.`,
    { fighter_id: fighter.id, requested_as_of: asOf, definition_version: version, reason: asOf ? "no_snapshot_at_or_before_as_of" : "no_snapshot" });
}

async function fighterDnaContext(env, fighterId, url) {
  const fighter = await resolveFighter(env, fighterId);
  if (!fighter) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.");
  const asOf = parseAsOf(url);
  const version = parseDefinitionVersion(url);
  const [imageMap, snap] = await Promise.all([imagesForFighters(env, [fighter.id]), loadSnapshot(env, fighter.id, { asOf, version })]);
  if (!snap.present) throw dnaSchemaMissing();
  if (!snap.snapshot) throw noSnapshotError(fighter, asOf, version);
  return { fighter: dnaFighter(fighter, imageMap), snapshot: snapshotView(snap.snapshot), asOf, version };
}

function dnaMeta(ctx, extra = {}) {
  return {
    requested_as_of: ctx.asOf,
    resolved_as_of: ctx.snapshot.as_of_date,
    definition_version: ctx.snapshot.definition_version,
    as_of_semantics: DNA_AS_OF_NOTE,
    origin: DNA_ORIGIN,
    origin_label: DNA_ORIGIN_LABELS[DNA_ORIGIN],
    ...extra,
  };
}

async function dnaMetricsRegistry(env, url) {
  const version = parseDefinitionVersion(url);
  const p = new URLSearchParams({
    select: DNA_METRIC_DEF_COLS, active: "eq.true", public: "eq.true", definition_version: `eq.${version}`,
    order: "family.asc,metric_key.asc", limit: "500",
  });
  const res = await sb(env, "ufc_dna_metric_definitions", p, { optional: true });
  if (res === null) throw dnaSchemaMissing();
  const familyIdx = (f) => { const i = DNA_FAMILY_ORDER.indexOf(f); return i < 0 ? DNA_FAMILY_ORDER.length : i; };
  const rows = res.data
    .map((r) => ({ ...r, origin: DNA_ORIGIN }))
    .sort((a, b) => (familyIdx(a.family) - familyIdx(b.family)) || String(a.metric_key).localeCompare(String(b.metric_key)));
  const families = {};
  for (const r of rows) {
    if (!families[r.family]) families[r.family] = [];
    families[r.family].push(r);
  }
  return {
    data: {
      definition_version: version,
      origin: DNA_ORIGIN,
      origin_labels: DNA_ORIGIN_LABELS,
      confidence_tiers: DNA_CONFIDENCE_TIERS,
      as_of_semantics: DNA_AS_OF_NOTE,
      families,
      metrics: rows,
    },
    meta: { count: rows.length, families: Object.keys(families).length, definition_version: version, ...(rows.length ? {} : { note: "The metric registry table exists but holds no active public rows for this version." }) },
  };
}

async function fighterDna(env, fighterId, url) {
  const ctx = await fighterDnaContext(env, fighterId, url);
  return { data: { fighter: ctx.fighter, snapshot: ctx.snapshot }, meta: dnaMeta(ctx) };
}

async function fighterDnaFamily(env, fighterId, url, family) {
  const ctx = await fighterDnaContext(env, fighterId, url);
  const block = ctx.snapshot[family];
  const stored = Object.keys(block).length > 0;
  const available = stored && familyHasValues(block);
  const data = {
    fighter: ctx.fighter,
    as_of_date: ctx.snapshot.as_of_date,
    definition_version: ctx.snapshot.definition_version,
    origin: DNA_ORIGIN,
    sample: sampleContext(ctx.snapshot),
    available,
    status: "ok",
    [family]: stored ? block : null, // the stored family verbatim (null-valued MetricObjects stay visible); null when nothing was stored
  };
  if (family === "position_profile") {
    data.origin = available ? "licensed" : DNA_ORIGIN;
    if (!available) {
      data.status = "licensed_data_not_available";
      data.note = "Position / control-time families require a licensed source (ufc_bout_position_stats). Nothing is synthesized from UFC Stats control time.";
    }
  } else if (!available) {
    data.status = "insufficient_coverage";
    data.note = `No ${family.replace("_", " ")} metric has a value for this snapshot: ${ctx.snapshot.sample_stat_bouts} stat-covered bouts across ${ctx.snapshot.sample_bouts} bouts. Nothing is synthesized.`;
  }
  return { data, meta: dnaMeta(ctx, { family, available, status: data.status }) };
}

async function fighterSplits(env, fighterId, url) {
  const fighter = await resolveFighter(env, fighterId);
  if (!fighter) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.");
  const asOf = parseAsOf(url);
  const version = parseDefinitionVersion(url);
  const stance = parseStanceParam(url, "opponent_stance");
  const lp = new URLSearchParams({ select: "as_of_date", fighter_id: `eq.${fighter.id}`, definition_version: `eq.${version}`, order: "as_of_date.desc", limit: "1" });
  if (asOf) lp.set("as_of_date", `lte.${asOf}`);
  const [imageMap, latest] = await Promise.all([imagesForFighters(env, [fighter.id]), sb(env, "ufc_fighter_stance_splits", lp, { optional: true })]);
  if (latest === null) throw dnaSchemaMissing();
  const resolvedAsOf = [...latest.data].map((r) => r.as_of_date).sort().reverse()[0] || null;
  if (!resolvedAsOf) {
    throw new ApiError(404, "dna_not_available", `No stance splits exist for ${fighter.name}${asOf ? ` at or before ${asOf}` : ""}. Nothing is synthesized.`,
      { fighter_id: fighter.id, requested_as_of: asOf, definition_version: version, reason: asOf ? "no_splits_at_or_before_as_of" : "no_splits" });
  }
  const rp = new URLSearchParams({ select: DNA_SPLIT_COLS, fighter_id: `eq.${fighter.id}`, definition_version: `eq.${version}`, as_of_date: `eq.${resolvedAsOf}`, order: "opponent_stance.asc", limit: "50" });
  if (stance) rp.set("opponent_stance", `eq.${stance}`);
  const stanceIdx = (s) => { const i = DNA_STANCES.indexOf(s); return i < 0 ? DNA_STANCES.length : i; };
  const rows = (await sb(env, "ufc_fighter_stance_splits", rp)).data
    .map(splitView)
    .sort((a, b) => (stanceIdx(a.opponent_stance) - stanceIdx(b.opponent_stance)) || String(a.opponent_stance).localeCompare(String(b.opponent_stance)));
  const data = {
    fighter: dnaFighter(fighter, imageMap),
    as_of_date: resolvedAsOf,
    definition_version: version,
    origin: DNA_ORIGIN,
    opponent_stance: stance,
    splits: rows,
  };
  if (stance) data.split = rows[0] || null;
  const meta = {
    requested_as_of: asOf, resolved_as_of: resolvedAsOf, definition_version: version, opponent_stance: stance, count: rows.length,
    as_of_semantics: DNA_AS_OF_NOTE, origin: DNA_ORIGIN, origin_label: DNA_ORIGIN_LABELS[DNA_ORIGIN],
  };
  if (stance && !rows.length) meta.note = `${fighter.name} has no stored split against ${stanceNoun(stance)} as of ${resolvedAsOf}; split is null, nothing is synthesized.`;
  return { data, meta };
}

/* ---- matchup DNA ------------------------------------------------------ */

function compareMetric(spec, A, B) {
  const a = findMetric(A, spec);
  const b = findMetric(B, spec);
  const av = a ? numOrNull(a.value) : null;
  const bv = b ? numOrNull(b.value) : null;
  const comparable = av !== null && bv !== null;
  const delta = comparable ? round4(av - bv) : null;
  const direction = !comparable ? null : delta > 0 ? "a" : delta < 0 ? "b" : "even";
  const minConf = comparable ? (confRank(a.confidence) <= confRank(b.confidence) ? a.confidence : b.confidence) : "insufficient";
  return {
    key: spec.key, label: spec.label, unit: spec.unit, family: spec.family, higher_is_better: spec.higher_is_better,
    mismatch: spec.mismatch ?? null, min_abs_delta: spec.min_abs_delta ?? null,
    a, b, delta, direction, comparable, min_confidence: minConf || "insufficient",
  };
}

function matchupSubset(S) {
  if (!S) return null;
  return {
    as_of_date: S.as_of_date, definition_version: S.definition_version,
    sample_bouts: S.sample_bouts, sample_completed_bouts: S.sample_completed_bouts, sample_stat_bouts: S.sample_stat_bouts,
    sample_rounds: S.sample_rounds, sample_seconds: S.sample_seconds, coverage_status: S.coverage_status,
    metrics: S.metrics, stance_splits: S.stance_splits, round_profile: S.round_profile, finish_profile: S.finish_profile,
    origin: DNA_ORIGIN,
  };
}

function stanceHistoryBlock(side, subject, subjectSnap, opponent, warnings) {
  const oppStance = normalizeStance(opponent.stance);
  const usable = oppStance && oppStance !== "UNKNOWN";
  const split = usable && subjectSnap ? (subjectSnap.stance_splits[oppStance] || null) : null;
  const rules = DNA_INSIGHT_RULES.stance_history;
  const appearances = split ? numOrNull(split.record?.appearances ?? split.appearances) ?? 0 : 0;
  const confidence = split?.confidence || "insufficient";
  const meets = Boolean(split) && appearances >= rules.min_appearances && confRank(confidence) >= confRank(rules.min_confidence);
  if (!usable) warnings.push(`${opponent.name}: listed stance is unknown; no stance-history block for ${subject.name}.`);
  else if (!subjectSnap) warnings.push(`${subject.name}: no Fight DNA snapshot; no stance history vs ${stanceNoun(oppStance)}.`);
  else if (!split) warnings.push(`${subject.name} vs ${stanceNoun(oppStance)}: no split stored in the snapshot (0 appearances). No stance insight emitted.`);
  else if (!meets) warnings.push(`${subject.name} vs ${stanceNoun(oppStance)}: ${appearances} appearance${appearances === 1 ? "" : "s"}, confidence ${confidence}; needs >= ${rules.min_appearances} appearances and confidence >= ${rules.min_confidence}. No stance insight emitted.`);
  return { side, fighter_id: subject.id, opponent_stance: usable ? oppStance : null, split, appearances, confidence, meets_threshold: meets };
}

function stanceInsights(block, subject, subjectSnap, warnings) {
  const out = [];
  if (!block.meets_threshold) return out;
  const { side, split, opponent_stance: stance } = block;
  const noun = stanceNoun(stance);
  const rec = split.record || {};
  const w = numOrNull(rec.w) ?? numOrNull(split.wins) ?? 0;
  const l = numOrNull(rec.l) ?? numOrNull(split.losses) ?? 0;
  const d = numOrNull(rec.d) ?? numOrNull(split.draws) ?? 0;
  const nc = numOrNull(rec.nc) ?? numOrNull(split.no_contests) ?? 0;
  const ko = numOrNull(split.ko_tko_wins) ?? 0;
  const sub = numOrNull(split.submission_wins) ?? 0;
  const dec = numOrNull(split.decision_wins) ?? 0;
  const app = block.appearances;
  out.push({
    key: `${side}_vs_${stance.toLowerCase()}_record`,
    label: `${subject.name} vs ${noun}`,
    value: app > 0 ? round4(w / app) : null,
    unit: "ratio",
    record: { w, l, d, nc, appearances: app },
    sample_bouts: app,
    sample_rounds: numOrNull(split.stat_rounds),
    sample_seconds: numOrNull(split.observed_seconds),
    confidence: split.confidence,
    direction: "contextual",
    side,
    metric_keys: ["stance_record"],
    explanation: `${subject.name} is ${w}-${l}-${d}${nc ? ` (${nc} NC)` : ""} in ${app} UFC bouts against ${noun} (${ko} KO/TKO, ${sub} submission, ${dec} decision wins), PBE-derived from canonical results as of ${subjectSnap.as_of_date}.`,
  });
  const fr = split.finish_rate;
  if (meetsConfidence(fr, DNA_INSIGHT_RULES.stance_finish_rate.min_confidence)) {
    const v = numOrNull(fr.value);
    out.push({
      key: `${side}_vs_${stance.toLowerCase()}_finish_rate`,
      label: `Finish history vs ${noun}`,
      value: v,
      unit: fr.unit || "ratio",
      sample_bouts: numOrNull(fr.sample_bouts) ?? w,
      sample_rounds: numOrNull(fr.sample_rounds),
      sample_seconds: numOrNull(fr.sample_seconds),
      confidence: fr.confidence,
      direction: "contextual",
      side,
      metric_keys: ["stance_finish_rate"],
      explanation: `${Math.round(v * 100)}% of ${subject.name}'s ${w} win${w === 1 ? "" : "s"} against ${noun} came by finish (${ko} KO/TKO, ${sub} submission), across ${fmtSample(fr)} as of ${subjectSnap.as_of_date}.`,
    });
  } else {
    warnings.push(`${subject.name} finish rate vs ${noun}: ${describeConfidence(fr)}; needs confidence >= ${DNA_INSIGHT_RULES.stance_finish_rate.min_confidence} (${w} win${w === 1 ? "" : "s"}, registry minimum 2). No finish-rate insight emitted.`);
  }
  return out;
}

function paceInsight(side, subject, snap, warnings) {
  if (!snap) return null;
  const rules = DNA_INSIGHT_RULES.pace_retention;
  const spec = DNA_COMPARISONS.find((c) => c.key === rules.metric);
  const m = findMetric(snap, spec);
  const bouts = numOrNull(m?.sample_bouts) ?? 0;
  if (!meetsConfidence(m, rules.min_confidence) || bouts < rules.min_bouts) {
    warnings.push(`${subject.name} ${rules.metric}: ${describeConfidence(m)}; needs >= ${rules.min_bouts} stat-covered bouts and confidence >= ${rules.min_confidence}. No pace insight emitted.`);
    return null;
  }
  const v = numOrNull(m.value);
  return {
    key: `${side}_${rules.metric}`,
    label: `${subject.name} R3 pace retention`,
    value: v,
    unit: m.unit || "ratio",
    sample_bouts: bouts,
    sample_rounds: numOrNull(m.sample_rounds),
    sample_seconds: numOrNull(m.sample_seconds),
    confidence: m.confidence,
    direction: "contextual",
    side,
    metric_keys: [rules.metric],
    explanation: `${subject.name} kept ${Math.round(v * 100)}% of round-one significant-strike attempt pace into round three across ${fmtSample(m)} of stat-covered fights as of ${snap.as_of_date}.`,
  };
}

function mismatchInsight(cmp, fa, fb, warnings, { minBouts = 0 } = {}) {
  const min = DNA_INSIGHT_RULES.min_confidence;
  const okA = meetsConfidence(cmp.a, min) && (numOrNull(cmp.a.sample_bouts) ?? 0) >= minBouts;
  const okB = meetsConfidence(cmp.b, min) && (numOrNull(cmp.b.sample_bouts) ?? 0) >= minBouts;
  if (!okA || !okB) {
    const missing = [];
    if (!okA) missing.push(`${fa.name} ${describeConfidence(cmp.a)}`);
    if (!okB) missing.push(`${fb.name} ${describeConfidence(cmp.b)}`);
    warnings.push(`${cmp.label}: ${missing.join("; ")}. Both sides need confidence >= ${min}${minBouts ? ` and >= ${minBouts} stat-covered bouts` : ""}; no ${cmp.mismatch.replace(/_/g, " ")} insight emitted.`);
    return null;
  }
  if (Math.abs(cmp.delta) < cmp.min_abs_delta) return null;
  const lead = cmp.direction === "a" ? fa : fb;
  const sign = cmp.delta > 0 ? "+" : "";
  return {
    key: `${cmp.key}_mismatch`,
    label: `${cmp.label} mismatch`,
    value: cmp.delta,
    unit: cmp.unit,
    a_value: numOrNull(cmp.a.value),
    b_value: numOrNull(cmp.b.value),
    sample_bouts: Math.min(numOrNull(cmp.a.sample_bouts) ?? 0, numOrNull(cmp.b.sample_bouts) ?? 0),
    sample_rounds: Math.min(numOrNull(cmp.a.sample_rounds) ?? 0, numOrNull(cmp.b.sample_rounds) ?? 0),
    sample_seconds: Math.min(numOrNull(cmp.a.sample_seconds) ?? 0, numOrNull(cmp.b.sample_seconds) ?? 0),
    samples: { a: { sample_bouts: cmp.a.sample_bouts ?? null, sample_rounds: cmp.a.sample_rounds ?? null, sample_seconds: cmp.a.sample_seconds ?? null, confidence: cmp.a.confidence }, b: { sample_bouts: cmp.b.sample_bouts ?? null, sample_rounds: cmp.b.sample_rounds ?? null, sample_seconds: cmp.b.sample_seconds ?? null, confidence: cmp.b.confidence } },
    confidence: cmp.min_confidence,
    direction: cmp.direction,
    side: cmp.direction,
    metric_keys: [cmp.key],
    explanation: `${cmp.label}: ${fa.name} ${fmtValue(cmp.a.value, cmp.unit)} (${fmtSample(cmp.a)}) vs ${fb.name} ${fmtValue(cmp.b.value, cmp.unit)} (${fmtSample(cmp.b)}); delta ${sign}${fmtValue(cmp.delta, cmp.unit)} toward ${lead.name}.`,
  };
}

function finishInsight(side, subject, snap, warnings) {
  if (!snap) return null;
  const rules = DNA_INSIGHT_RULES.finish_rate;
  const m = findMetric(snap, { key: rules.metric });
  if (!meetsConfidence(m, rules.min_confidence)) {
    warnings.push(`${subject.name} ${rules.metric}: ${describeConfidence(m)}; needs confidence >= ${rules.min_confidence} (registry minimum 2 wins). No finish-profile insight emitted.`);
    return null;
  }
  const v = numOrNull(m.value);
  const by = asObject(snap.finish_profile.finished_by);
  const ko = numOrNull(by.ko_tko);
  const sub = numOrNull(by.submission);
  const wins = numOrNull(m.denominator) ?? numOrNull(m.sample_bouts);
  const byText = ko !== null || sub !== null ? ` (${ko ?? 0} KO/TKO, ${sub ?? 0} submission)` : "";
  return {
    key: `${side}_finish_rate`,
    label: `${subject.name} finish rate`,
    value: v,
    unit: m.unit || "ratio",
    sample_bouts: numOrNull(m.sample_bouts),
    sample_rounds: numOrNull(m.sample_rounds),
    sample_seconds: numOrNull(m.sample_seconds),
    confidence: m.confidence,
    direction: "contextual",
    side,
    metric_keys: [rules.metric],
    explanation: `${Math.round(v * 100)}% of ${subject.name}'s ${wins ?? "counted"} UFC wins came by finish${byText}, PBE-derived from canonical results as of ${snap.as_of_date}.`,
  };
}

function evidenceFrom(insight) {
  return {
    key: insight.key,
    label: insight.label,
    value: insight.value,
    unit: insight.unit,
    side: insight.side ?? null,
    direction: insight.direction,
    sample: fmtSample(insight),
    sample_bouts: insight.sample_bouts ?? null,
    sample_rounds: insight.sample_rounds ?? null,
    sample_seconds: insight.sample_seconds ?? null,
    confidence: insight.confidence,
    origin: DNA_ORIGIN,
    origin_label: DNA_ORIGIN_LABELS[DNA_ORIGIN],
    explanation: insight.explanation,
  };
}

function buildMatchupDna(fa, A, fb, B) {
  const warnings = [];
  if (!A) warnings.push(`${fa.name}: no Fight DNA snapshot; side a is null in every comparison and no a-side insight is emitted.`);
  if (!B) warnings.push(`${fb.name}: no Fight DNA snapshot; side b is null in every comparison and no b-side insight is emitted.`);
  const comparisons = DNA_COMPARISONS.map((spec) => compareMetric(spec, A, B));
  const byKey = new Map(comparisons.map((c) => [c.key, c]));
  const aStance = normalizeStance(fa.stance);
  const bStance = normalizeStance(fb.stance);
  const context = stanceMatchupContext(aStance, bStance);
  const aVsB = stanceHistoryBlock("a", fa, A, fb, warnings);
  const bVsA = stanceHistoryBlock("b", fb, B, fa, warnings);
  const stance_context = {
    a_stance: aStance, b_stance: bStance, context,
    a_vs_b_stance: aVsB, b_vs_a_stance: bVsA,
    a_context_split: A && (context === "same" || context === "open") ? A.stance_splits[context] || null : null,
    b_context_split: B && (context === "same" || context === "open") ? B.stance_splits[context] || null : null,
  };

  const insights = [];
  insights.push(...stanceInsights(aVsB, fa, A, warnings));
  insights.push(...stanceInsights(bVsA, fb, B, warnings));
  const paceA = paceInsight("a", fa, A, warnings);
  const paceB = paceInsight("b", fb, B, warnings);
  if (paceA) insights.push(paceA);
  if (paceB) insights.push(paceB);
  if (paceA && paceB) {
    const cmp = { ...byKey.get(DNA_INSIGHT_RULES.pace_retention_mismatch.metric), mismatch: "pace_retention_mismatch", min_abs_delta: DNA_INSIGHT_RULES.pace_retention_mismatch.min_abs_delta };
    const m = mismatchInsight(cmp, fa, fb, warnings, { minBouts: DNA_INSIGHT_RULES.pace_retention_mismatch.min_bouts });
    if (m) insights.push(m);
  }
  for (const family of ["target_share_mismatch", "phase_share_mismatch", "grappling_mismatch"]) {
    for (const cmp of comparisons.filter((c) => c.mismatch === family)) {
      const m = mismatchInsight(cmp, fa, fb, warnings);
      if (m) insights.push(m);
    }
  }
  const finA = finishInsight("a", fa, A, warnings);
  const finB = finishInsight("b", fb, B, warnings);
  if (finA) insights.push(finA);
  if (finB) insights.push(finB);
  for (const i of insights) i.origin = DNA_ORIGIN;

  return {
    fighters: [fa, fb].map((f) => dnaFighter(f, null)),
    a: matchupSubset(A),
    b: matchupSubset(B),
    comparisons,
    stance_context,
    insights,
    warnings,
    bettors_edge_evidence: insights.map(evidenceFrom),
    origin: DNA_ORIGIN,
    note: DNA_EVIDENCE_NOTE,
  };
}

async function matchupDna(env, aId, bId, url) {
  const asOf = parseAsOf(url);
  const version = parseDefinitionVersion(url);
  const [fa, fb] = await Promise.all([resolveFighter(env, aId), resolveFighter(env, bId)]);
  if (!fa || !fb) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.", { missing: [!fa ? aId : null, !fb ? bId : null].filter(Boolean) });
  if (fa.id === fb.id) throw new ApiError(400, "invalid_matchup", "A matchup needs two different fighters.");
  const [imageMap, sa, sbB] = await Promise.all([
    imagesForFighters(env, [fa.id, fb.id]),
    loadSnapshot(env, fa.id, { asOf, version }),
    loadSnapshot(env, fb.id, { asOf, version }),
  ]);
  if (!sa.present || !sbB.present) throw dnaSchemaMissing();
  if (!sa.snapshot && !sbB.snapshot) {
    throw new ApiError(404, "dna_not_available", `No Fight DNA snapshot exists for ${fa.name} or ${fb.name}${asOf ? ` at or before ${asOf}` : ""}. Nothing is synthesized.`,
      { fighter_ids: [fa.id, fb.id], requested_as_of: asOf, definition_version: version, reason: "no_snapshot" });
  }
  const A = sa.snapshot ? snapshotView(sa.snapshot) : null;
  const B = sbB.snapshot ? snapshotView(sbB.snapshot) : null;
  const data = buildMatchupDna(fa, A, fb, B);
  data.fighters = [fa, fb].map((f) => dnaFighter(f, imageMap));
  return {
    data,
    meta: {
      requested_as_of: asOf,
      resolved_as_of: { a: A?.as_of_date ?? null, b: B?.as_of_date ?? null },
      definition_version: version,
      insight_rules: DNA_INSIGHT_RULES,
      comparisons: data.comparisons.length,
      comparable: data.comparisons.filter((c) => c.comparable).length,
      insights: data.insights.length,
      warnings: data.warnings.length,
      as_of_semantics: DNA_AS_OF_NOTE,
      origin: DNA_ORIGIN,
      origin_label: DNA_ORIGIN_LABELS[DNA_ORIGIN],
    },
  };
}

/* ---- DNA query (north-star filter over current snapshots) ------------- */

function parseBound(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ApiError(400, "invalid_bound", `${name} must be a number.`, { [name]: raw });
  return n;
}

async function dnaFighterIdentities(env, ids) {
  const list = [...new Set((ids || []).filter((id) => id && UUID_RE.test(id)))];
  const map = new Map();
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const p = new URLSearchParams({ select: DNA_FIGHTER_COLS, id: `in.(${chunk.join(",")})`, limit: String(chunk.length) });
    for (const row of (await sb(env, "ufc_fighters", p)).data) map.set(row.id, row);
  }
  return map;
}

async function dnaQuery(env, url) {
  const metricRaw = String(url.searchParams.get("metric") || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(metricRaw)) {
    throw new ApiError(400, "invalid_metric", "Provide ?metric=<metric_key> (lowercase letters, digits, underscores).", { metric: metricRaw || null });
  }
  const stance = parseStanceParam(url, "stance");
  const min = parseBound(url, "min");
  const max = parseBound(url, "max");
  const minConfidence = String(url.searchParams.get("min_confidence") || "low").toLowerCase();
  if (!(minConfidence in DNA_CONFIDENCE_RANK)) throw new ApiError(400, "invalid_confidence", "min_confidence must be one of insufficient, low, medium, high.", { min_confidence: minConfidence });
  const minAppearances = clampInt(url.searchParams.get("min_appearances"), 1, 0, 1000);
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
  const active = url.searchParams.get("active");
  const order = String(url.searchParams.get("order") || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const asOf = parseAsOf(url);
  const version = parseDefinitionVersion(url);
  const mode = stance ? "stance_split" : "snapshot";
  const metric = stance ? (DNA_SPLIT_METRIC_ALIASES[metricRaw] || metricRaw) : metricRaw;
  if (stance && !DNA_SPLIT_METRIC_KEYS.includes(metric)) {
    throw new ApiError(400, "invalid_metric", "With ?stance= the metric must be a stance-split metric.", { metric: metricRaw, allowed: [...DNA_SPLIT_METRIC_KEYS, ...Object.keys(DNA_SPLIT_METRIC_ALIASES)] });
  }
  const table = stance ? "ufc_fighter_stance_splits" : "ufc_fighter_dna_snapshots";
  const baseCols = stance
    ? "fighter_id,as_of_date,opponent_stance,appearances,wins,losses,draws,no_contests,ko_tko_wins,submission_wins,decision_wins,stat_bouts,stat_rounds,observed_seconds,confidence"
    : "fighter_id,as_of_date,sample_bouts,sample_completed_bouts,sample_stat_bouts,sample_rounds,sample_seconds,coverage_status";
  const allowedConf = Object.keys(DNA_CONFIDENCE_RANK).filter((k) => DNA_CONFIDENCE_RANK[k] >= DNA_CONFIDENCE_RANK[minConfidence]);
  const p = new URLSearchParams({
    select: `${baseCols},metric:metrics->${metric}`,
    definition_version: `eq.${version}`,
    order: "fighter_id.asc,as_of_date.desc",
    limit: String(DNA_QUERY_CANDIDATE_LIMIT),
  });
  if (stance) {
    p.set("opponent_stance", `eq.${stance}`);
    p.set("appearances", `gte.${minAppearances}`);
  }
  if (min !== null) p.append(`metrics->${metric}->value`, `gte.${min}`);
  if (max !== null) p.append(`metrics->${metric}->value`, `lte.${max}`);
  p.set(`metrics->${metric}->>confidence`, `in.(${allowedConf.join(",")})`);
  if (asOf) p.set("as_of_date", `lte.${asOf}`);
  const res = await sb(env, table, p, { optional: true, count: true });
  if (res === null) throw dnaSchemaMissing();
  const candidates = res.data.filter((r) => isMetricObject(r.metric));
  const truncated = res.count !== null && res.count > res.data.length;

  // Only a fighter's latest row (<= as_of) may qualify: an older snapshot that passes while the latest fails is excluded.
  const fighterIds = [...new Set(candidates.map((r) => r.fighter_id))];
  const latestByFighter = new Map();
  for (let i = 0; i < fighterIds.length; i += 200) {
    const chunk = fighterIds.slice(i, i + 200);
    const lp = new URLSearchParams({ select: "fighter_id,as_of_date", fighter_id: `in.(${chunk.join(",")})`, definition_version: `eq.${version}`, order: "as_of_date.desc", limit: "10000" });
    if (stance) lp.set("opponent_stance", `eq.${stance}`);
    if (asOf) lp.set("as_of_date", `lte.${asOf}`);
    for (const row of (await sb(env, table, lp)).data) {
      const prev = latestByFighter.get(row.fighter_id);
      if (!prev || String(row.as_of_date) > String(prev)) latestByFighter.set(row.fighter_id, row.as_of_date);
    }
  }
  const seen = new Set();
  const current = candidates.filter((r) => latestByFighter.get(r.fighter_id) === r.as_of_date && !seen.has(r.fighter_id) && seen.add(r.fighter_id));
  const identities = await dnaFighterIdentities(env, current.map((r) => r.fighter_id));
  let rows = current.map((r) => {
    const f = identities.get(r.fighter_id) || null;
    const { metric: m, fighter_id, ...rest } = r;
    const out = {
      fighter: f ? { id: f.id, name: f.name, nickname: f.nickname ?? null, slug_id: slugId(f), stance: normalizeStance(f.stance), is_active: f.is_active ?? null } : { id: fighter_id, name: null, nickname: null, slug_id: null, stance: null, is_active: null },
      as_of_date: r.as_of_date,
      metric_key: metric,
      metric: m,
      origin: DNA_ORIGIN,
    };
    if (stance) {
      out.opponent_stance = r.opponent_stance;
      out.record = { w: r.wins ?? 0, l: r.losses ?? 0, d: r.draws ?? 0, nc: r.no_contests ?? 0, appearances: r.appearances ?? 0 };
      out.ko_tko_wins = r.ko_tko_wins ?? 0; out.submission_wins = r.submission_wins ?? 0; out.decision_wins = r.decision_wins ?? 0;
      out.sample = { stat_bouts: r.stat_bouts ?? 0, stat_rounds: r.stat_rounds ?? 0, observed_seconds: r.observed_seconds ?? 0, confidence: r.confidence || "insufficient" };
    } else {
      out.sample = { sample_bouts: rest.sample_bouts ?? 0, sample_completed_bouts: rest.sample_completed_bouts ?? 0, sample_stat_bouts: rest.sample_stat_bouts ?? 0, sample_rounds: rest.sample_rounds ?? 0, sample_seconds: rest.sample_seconds ?? 0, coverage_status: rest.coverage_status || "insufficient" };
    }
    return out;
  });
  if (active === "true" || active === "false") rows = rows.filter((r) => r.fighter.is_active === (active === "true"));
  const val = (r) => numOrNull(r.metric?.value);
  rows.sort((x, y) => {
    const a = val(x); const b = val(y);
    if (a === null && b === null) return String(x.fighter.name || "").localeCompare(String(y.fighter.name || "")) || String(x.fighter.id).localeCompare(String(y.fighter.id));
    if (a === null) return 1;
    if (b === null) return -1;
    return (order === "asc" ? a - b : b - a) || String(x.fighter.name || "").localeCompare(String(y.fighter.name || "")) || String(x.fighter.id).localeCompare(String(y.fighter.id));
  });
  const matched = rows.length;
  rows = rows.slice(0, limit);
  return {
    data: rows,
    meta: {
      mode, metric, metric_requested: metricRaw, stance, min, max, min_confidence: minConfidence, min_appearances: stance ? minAppearances : null,
      active: active === "true" || active === "false" ? active === "true" : null, order,
      requested_as_of: asOf, definition_version: version,
      candidates: res.data.length, candidates_total: res.count, truncated, matched, count: rows.length, limit,
      filter: {
        table,
        value: [min !== null ? `metrics->${metric}->value=gte.${min}` : null, max !== null ? `metrics->${metric}->value=lte.${max}` : null].filter(Boolean),
        confidence: `metrics->${metric}->>confidence=in.(${allowedConf.join(",")})`,
      },
      note: `Filters run in PostgREST on the stored MetricObject (jsonb ordering on ->value, text match on ->>confidence). Only each fighter's latest ${stance ? "split" : "snapshot"}${asOf ? ` at or before ${asOf}` : ""} qualifies. The candidate scan is capped at ${DNA_QUERY_CANDIDATE_LIMIT} rows; when truncated is true the result set is incomplete. Active filtering happens after the scan.`,
      as_of_semantics: DNA_AS_OF_NOTE,
      origin: DNA_ORIGIN,
    },
  };
}

/* ---- Fight State Ledger (docs/fight_state_ledger.md) ------------------ */

const LEDGER_COLS = "id,bout_id,event_id,checkpoint,ledger_version,captured_at,scheduled_start,event_date,hours_to_start,bout_state,fighters,rankings,dna,weigh_in,wire,odds,market,model,result,provenance";
/* Compact select for card-wide reads: the large blocks (dna, wire) are reduced to the fields the diff needs. */
const LEDGER_SUMMARY_COLS = [
  "id", "bout_id", "event_id", "checkpoint", "ledger_version", "captured_at", "scheduled_start", "event_date", "hours_to_start",
  "bout_state", "fighters", "rankings", "result",
  "dna_status:dna->>status", "dna_a_status:dna->a->>status", "dna_a_as_of:dna->a->>as_of_date", "dna_a_version:dna->a->definition_version",
  "dna_b_status:dna->b->>status", "dna_b_as_of:dna->b->>as_of_date", "dna_b_version:dna->b->definition_version",
  "wire_status:wire->>status", "wire_count:wire->count",
  "weigh_in_status:weigh_in->>status", "odds_status:odds->>status", "market_status:market->>status", "model_status:model->>status",
].join(",");
const LEDGER_CHECKPOINTS = ["t_minus_7d", "t_minus_72h", "t_minus_24h", "post_weigh_in", "t_minus_3h", "close", "post_result", "ad_hoc"];
const LEDGER_SOURCES = ["weigh_in", "odds", "market", "model"];
const LEDGER_FIGHTER_DIFF_KEYS = ["id", "name", "slug_id", "stance", "record", "rankings"];
const LEDGER_DNA_DIFF_KEYS = ["status", "as_of_date", "definition_version"];
const LEDGER_DIFF_RULES = "Deterministic shallow diff between consecutive snapshots, no interpretation: top-level keys of bout_state (keys ending in _updated_at ignored), fighters.a/b {id,name,slug_id,stance,record,rankings} and fighters.stance_context, top-level keys of rankings, dna.a/b {status,as_of_date,definition_version}, wire.count, weigh_in/odds/market/model/result .status. Values are compared as JSON.";
const CARD_SHOCK_PLACEHOLDER = { status: "not_computed", reason: "card_shock_engine_not_built" };
const LEDGER_MAX_ROWS = 1000; // PostgREST max_rows

function ledgerSchemaMissing() {
  return new ApiError(503, "ledger_not_available", "The Fight State Ledger table is not available yet (migration 005 not applied). Nothing is synthesized.", { reason: "schema_not_applied" });
}

function stripUpdatedAt(obj) {
  const out = {};
  for (const [k, v] of Object.entries(asObject(obj))) {
    if (/_updated_at$/.test(k)) continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter(([kk]) => !/_updated_at$/.test(kk)))
      : v;
  }
  return out;
}

function statusOf(block) {
  const b = asObject(block);
  return typeof b.status === "string" ? b.status : null;
}

/* One shape for a ledger row whether it was read with every block (LEDGER_COLS) or with the compact aliases (LEDGER_SUMMARY_COLS). */
function ledgerView(row) {
  const full = row.dna !== undefined || row.wire !== undefined;
  const dnaSide = (side) => {
    if (full) {
      const d = asObject(asObject(row.dna)[side]);
      return { status: statusOf(d) ?? (d.as_of_date ? "ok" : statusOf(row.dna)), as_of_date: d.as_of_date ?? null, definition_version: d.definition_version ?? null };
    }
    return { status: row[`dna_${side}_status`] ?? (row[`dna_${side}_as_of`] ? "ok" : (row.dna_status ?? null)), as_of_date: row[`dna_${side}_as_of`] ?? null, definition_version: row[`dna_${side}_version`] ?? null };
  };
  const sourceStatus = (name) => ({ status: full ? statusOf(row[name]) : (row[`${name}_status`] ?? null) });
  const fighters = asObject(row.fighters);
  const pickFighter = (f) => { const o = asObject(f); return Object.fromEntries(LEDGER_FIGHTER_DIFF_KEYS.map((k) => [k, o[k] ?? null])); };
  return {
    id: row.id, bout_id: row.bout_id, event_id: row.event_id, checkpoint: row.checkpoint, ledger_version: row.ledger_version ?? 1,
    captured_at: row.captured_at, scheduled_start: row.scheduled_start ?? null, event_date: row.event_date ?? null, hours_to_start: numOrNull(row.hours_to_start),
    bout_state: stripUpdatedAt(row.bout_state),
    fighters: { a: pickFighter(fighters.a), b: pickFighter(fighters.b), stance_context: fighters.stance_context ?? null },
    rankings: asObject(row.rankings),
    dna: { a: dnaSide("a"), b: dnaSide("b") },
    wire: { status: full ? statusOf(row.wire) : (row.wire_status ?? null), count: full ? numOrNull(asObject(row.wire).count) : numOrNull(row.wire_count) },
    weigh_in: sourceStatus("weigh_in"), odds: sourceStatus("odds"), market: sourceStatus("market"), model: sourceStatus("model"),
    result: asObject(row.result),
  };
}

function ledgerDiff(newer, older) {
  const changes = [];
  const push = (path, from, to) => {
    const a = from === undefined ? null : from;
    const b = to === undefined ? null : to;
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path, from: a, to: b });
  };
  const keys = (x, y) => [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
  for (const k of keys(older.bout_state, newer.bout_state)) push(`bout_state.${k}`, older.bout_state[k], newer.bout_state[k]);
  for (const side of ["a", "b"]) for (const k of LEDGER_FIGHTER_DIFF_KEYS) push(`fighters.${side}.${k}`, older.fighters[side][k], newer.fighters[side][k]);
  push("fighters.stance_context", older.fighters.stance_context, newer.fighters.stance_context);
  for (const k of keys(older.rankings, newer.rankings)) push(`rankings.${k}`, older.rankings[k], newer.rankings[k]);
  for (const side of ["a", "b"]) for (const k of LEDGER_DNA_DIFF_KEYS) push(`dna.${side}.${k}`, older.dna[side][k], newer.dna[side][k]);
  push("wire.count", older.wire.count, newer.wire.count);
  for (const s of LEDGER_SOURCES) push(`${s}.status`, older[s].status, newer[s].status);
  push("result.status", older.result.status ?? null, newer.result.status ?? null);
  const hours = (Date.parse(newer.captured_at) - Date.parse(older.captured_at)) / 3600000;
  return {
    newer: { id: newer.id, checkpoint: newer.checkpoint, captured_at: newer.captured_at },
    older: { id: older.id, checkpoint: older.checkpoint, captured_at: older.captured_at },
    hours_between: Number.isFinite(hours) ? Math.round(hours * 100) / 100 : null,
    changed: changes.map((c) => c.path),
    changes,
  };
}

function sortLedgerRows(rows) {
  return [...rows].sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)) || String(a.id).localeCompare(String(b.id)));
}

function countBy(list, key) {
  const out = {};
  for (const item of list) { const k = item[key] ?? "null"; out[k] = (out[k] || 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (LEDGER_CHECKPOINTS.indexOf(a) - LEDGER_CHECKPOINTS.indexOf(b)) || a.localeCompare(b)));
}

async function boutLedger(env, boutId, url) {
  const bout = await resolveBout(env, boutId);
  if (!bout) throw new ApiError(404, "bout_not_found", "UFC bout not found.");
  const limit = clampInt(url.searchParams.get("limit"), 25, 1, 100);
  const p = new URLSearchParams({ select: LEDGER_COLS, bout_id: `eq.${bout.id}`, order: "captured_at.desc,id.asc", limit: String(limit) });
  const res = await sb(env, "ufc_fight_state_ledger", p, { optional: true, count: true });
  if (res === null) throw ledgerSchemaMissing();
  const rows = sortLedgerRows(res.data).map((r) => ({ ...r, hours_to_start: numOrNull(r.hours_to_start) }));
  const views = rows.map(ledgerView);
  const diffs = [];
  for (let i = 0; i + 1 < views.length; i += 1) diffs.push(ledgerDiff(views[i], views[i + 1]));
  const data = {
    bout: {
      id: bout.id, status: bout.status ?? null, bout_order: bout.bout_order ?? null, card_position: bout.card_position ?? null,
      weight_class: bout.weight_class ?? null, scheduled_rounds: bout.scheduled_rounds ?? null, is_title: bout.is_title ?? null,
      event: compactEvent(bout.event), fighter_a: compactFighter(bout.fighter_a, null), fighter_b: compactFighter(bout.fighter_b, null),
      has_result: Boolean(bout.result),
    },
    snapshots: rows,
    diffs,
    card_shock: CARD_SHOCK_PLACEHOLDER,
  };
  const meta = {
    count: rows.length, total: res.count, limit,
    checkpoints: countBy(rows, "checkpoint"),
    latest_captured_at: rows[0]?.captured_at ?? null,
    append_only: true,
    diff_rules: LEDGER_DIFF_RULES,
  };
  if (!rows.length) meta.note = "No ledger checkpoint has been captured for this bout. Nothing is synthesized.";
  else if (res.count !== null && res.count > rows.length) meta.note = `Only the newest ${rows.length} of ${res.count} snapshots are returned; raise ?limit= (max 100) for more.`;
  return { data, meta };
}

async function eventIntelligence(env, eventId, url, now = new Date()) {
  const event = await resolveEvent(env, eventId);
  if (!event) throw new ApiError(404, "event_not_found", "UFC event not found.");
  const bp = new URLSearchParams({ select: BOUT_SELECT, event_id: `eq.${event.id}`, order: "bout_order.desc" });
  const lp = new URLSearchParams({ select: LEDGER_SUMMARY_COLS, event_id: `eq.${event.id}`, order: "captured_at.desc,id.asc", limit: String(LEDGER_MAX_ROWS) });
  const [boutRows, ledger] = await Promise.all([
    sb(env, "ufc_bouts", bp).then((r) => r.data.map(normalizeBout)),
    sb(env, "ufc_fight_state_ledger", lp, { optional: true, count: true }),
  ]);
  if (ledger === null) throw ledgerSchemaMissing();
  const imageMap = await imagesForFighters(env, boutRows.flatMap((b) => [b.fighter_a?.id, b.fighter_b?.id]));
  const byBout = new Map();
  for (const row of sortLedgerRows(ledger.data)) {
    if (!byBout.has(row.bout_id)) byBout.set(row.bout_id, []);
    byBout.get(row.bout_id).push(ledgerView(row));
  }
  const nowMs = now.getTime();
  const hoursTo = (start) => {
    const ms = start ? Date.parse(start) : NaN;
    return Number.isFinite(ms) ? Math.round(((ms - nowMs) / 3600000) * 100) / 100 : null;
  };
  const sourceStatus = Object.fromEntries(LEDGER_SOURCES.map((s) => [s, {}]));
  const bouts = boutRows.map((b) => {
    const views = byBout.get(b.id) || [];
    const latest = views[0] || null;
    const previous = views[1] || null;
    if (latest) for (const s of LEDGER_SOURCES) { const st = latest[s].status ?? "null"; sourceStatus[s][st] = (sourceStatus[s][st] || 0) + 1; }
    const hasDna = (side) => latest ? (latest.dna[side].status === "ok" || Boolean(latest.dna[side].as_of_date)) : null;
    return {
      bout: {
        id: b.id, status: b.status ?? null, bout_order: b.bout_order ?? null, card_position: b.card_position ?? null,
        weight_class: b.weight_class ?? null, scheduled_rounds: b.scheduled_rounds ?? null, is_title: b.is_title ?? null,
        fighter_a: compactFighter(b.fighter_a, imageMap), fighter_b: compactFighter(b.fighter_b, imageMap), has_result: Boolean(b.result),
      },
      ledger_status: latest ? "ok" : "no_checkpoint",
      latest: latest ? { id: latest.id, checkpoint: latest.checkpoint, captured_at: latest.captured_at, ledger_version: latest.ledger_version, scheduled_start: latest.scheduled_start, hours_to_start_at_capture: latest.hours_to_start } : null,
      hours_to_start: latest ? hoursTo(latest.scheduled_start) : null,
      checkpoints: [...new Set(views.map((v) => v.checkpoint))],
      snapshots: views.length,
      bout_state: latest ? latest.bout_state : null,
      fighters: latest ? latest.fighters : null,
      has_dna: { a: hasDna("a"), b: hasDna("b") },
      dna: latest ? latest.dna : null,
      wire_count: latest ? latest.wire.count : null,
      result: latest ? latest.result : null,
      sources: latest ? Object.fromEntries(LEDGER_SOURCES.map((s) => [s, latest[s].status])) : null,
      diff: latest && previous ? ledgerDiff(latest, previous) : null,
      card_shock: CARD_SHOCK_PLACEHOLDER,
    };
  });
  const withLedger = bouts.filter((b) => b.latest);
  const scheduledStart = withLedger.map((b) => b.latest.scheduled_start).find(Boolean) || null;
  const allViews = [...byBout.values()].flat();
  const data = {
    event: { ...compactEvent(event), scheduled_start: scheduledStart, hours_to_start: hoursTo(scheduledStart) },
    bouts,
    card_shock: CARD_SHOCK_PLACEHOLDER,
  };
  const meta = {
    generated_at: now.toISOString(),
    bouts: bouts.length,
    bouts_with_ledger: withLedger.length,
    snapshots: ledger.data.length,
    snapshots_total: ledger.count,
    truncated: ledger.count !== null && ledger.count > ledger.data.length,
    checkpoints: countBy(allViews, "checkpoint"),
    latest_captured_at: allViews[0]?.captured_at ?? null,
    unavailable_sources: LEDGER_SOURCES.filter((s) => withLedger.length > 0 && withLedger.every((b) => b.sources[s] === "unavailable")),
    source_status: sourceStatus,
    card_shock: CARD_SHOCK_PLACEHOLDER,
    diff_rules: LEDGER_DIFF_RULES,
  };
  if (!withLedger.length) meta.note = "No ledger checkpoint has been captured for this card. Nothing is synthesized.";
  return { data, meta };
}

/* ---- official videos (docs/UFC_MEDIA_VIDEO_ADDENDUM.md sections 5-9) --- */

const VIDEO_COLS = [
  "id", "provider", "provider_video_id", "channel_id", "channel_name", "channel_verified_source", "url", "title",
  "published_at", "duration_sec", "thumbnail_url", "embeddable", "live_broadcast_state", "video_type", "fighter_ids",
  "event_id", "bout_id", "article_id", "resolver_confidence", "link_status", "captured_at", "updated_at",
].join(",");
const VIDEO_TYPES = [
  "embedded_episode", "countdown", "fight_preview", "full_fight", "highlights", "interview", "press_conference",
  "media_day", "weigh_in", "faceoff", "post_fight", "analysis", "other",
];
/* Fight-week timeline order for the event page rail (addendum section 8). */
const VIDEO_TIMELINE_ORDER = [
  "fight_preview", "countdown", "embedded_episode", "interview", "analysis", "press_conference", "media_day",
  "weigh_in", "faceoff", "full_fight", "highlights", "post_fight", "other",
];
const VIDEO_TYPE_LABELS = {
  embedded_episode: "Embedded", countdown: "Countdown", fight_preview: "Fight preview", full_fight: "Full fight",
  highlights: "Highlights", interview: "Interview", press_conference: "Press conference", media_day: "Media day",
  weigh_in: "Weigh-in", faceoff: "Faceoff", post_fight: "Post-fight", analysis: "Analysis", other: "Other",
};
const VIDEO_PROVIDER_LABELS = { youtube: "YouTube" };
const VIDEO_COMPACT_LIMIT = 6;
const VIDEO_EMBED_BASE = "https://www.youtube-nocookie.com/embed/";

function videosSchemaMissing() {
  return new ApiError(503, "videos_not_available", "The official video tables are not available yet (migration 006 not applied). Nothing is synthesized.", { reason: "schema_not_applied" });
}

/* Embed URL is constructed at render time from the provider id (privacy-enhanced domain); never a rehosted file. */
function videoEmbedUrl(row) {
  return row.provider === "youtube" && row.provider_video_id ? `${VIDEO_EMBED_BASE}${encodeURIComponent(row.provider_video_id)}` : null;
}

function videoView(row) {
  const providerLabel = VIDEO_PROVIDER_LABELS[row.provider] || String(row.provider || "").replace(/^./, (c) => c.toUpperCase());
  const channelName = row.channel_name ?? null;
  return {
    id: row.id,
    provider: row.provider,
    provider_video_id: row.provider_video_id,
    url: row.url,
    embed_url: videoEmbedUrl(row),
    thumbnail_url: row.thumbnail_url ?? null,
    title: row.title,
    published_at: row.published_at ?? null,
    duration_sec: numOrNull(row.duration_sec),
    embeddable: typeof row.embeddable === "boolean" ? row.embeddable : null,
    live_broadcast_state: row.live_broadcast_state ?? null,
    video_type: row.video_type || "other",
    video_type_label: VIDEO_TYPE_LABELS[row.video_type] || VIDEO_TYPE_LABELS.other,
    channel: { id: row.channel_id ?? null, name: channelName, verified: Boolean(row.channel_verified_source) },
    links: { event_id: row.event_id ?? null, bout_id: row.bout_id ?? null, article_id: row.article_id ?? null, fighter_ids: Array.isArray(row.fighter_ids) ? row.fighter_ids : [] },
    resolver_confidence: row.resolver_confidence || "none",
    attribution: `${providerLabel} · ${channelName || row.channel_id || "unknown channel"}`,
    captured_at: row.captured_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function parseVideoType(url) {
  const raw = String(url.searchParams.get("type") || "").trim().toLowerCase();
  if (!raw) return null;
  if (!VIDEO_TYPES.includes(raw)) throw new ApiError(400, "invalid_type", "Unknown video type.", { type: raw, allowed: VIDEO_TYPES });
  return raw;
}

/* Published rows only: review / rejected links never leave the database. */
async function queryVideos(env, { fighter_id = null, event_id = null, bout_id = null, type = null, limit = 20, order = "desc" } = {}) {
  const p = new URLSearchParams({
    select: VIDEO_COLS,
    link_status: "eq.published",
    order: `published_at.${order}.nullslast,id.asc`,
    limit: String(limit),
  });
  if (fighter_id) p.set("fighter_ids", `cs.{${fighter_id}}`);
  if (event_id) p.set("event_id", `eq.${event_id}`);
  if (bout_id) p.set("bout_id", `eq.${bout_id}`);
  if (type) p.set("video_type", `eq.${type}`);
  const res = await sb(env, "ufc_videos", p, { optional: true, count: true });
  if (res === null) throw videosSchemaMissing();
  const cmp = (a, b) => {
    const x = a.published_at || ""; const y = b.published_at || "";
    if (x !== y) { if (!x) return 1; if (!y) return -1; return order === "asc" ? x.localeCompare(y) : y.localeCompare(x); }
    return String(a.id).localeCompare(String(b.id));
  };
  const rows = [...res.data].filter((r) => r.link_status === "published").sort(cmp).map(videoView);
  return { rows, total: res.count };
}

/* include=videos block: latest 6 published, tolerant of the table not existing (null block, never a failure). */
async function compactVideosFor(env, filter) {
  try {
    return (await queryVideos(env, { ...filter, limit: VIDEO_COMPACT_LIMIT })).rows;
  } catch (error) {
    if (error instanceof ApiError && error.code === "videos_not_available") return null;
    throw error;
  }
}

async function resolveScopedId(env, raw, kind) {
  if (!raw) return null;
  if (UUID_RE.test(raw)) return raw;
  if (kind === "fighter") throw new ApiError(400, "invalid_fighter_id", "fighter_id must be a UUID.", { fighter_id: raw });
  const entity = kind === "event" ? await resolveEvent(env, raw) : await resolveBout(env, raw);
  if (!entity) throw new ApiError(404, kind === "event" ? "event_not_found" : "bout_not_found", `UFC ${kind} not found.`);
  return entity.id;
}

async function listVideos(env, url) {
  const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
  const type = parseVideoType(url);
  const [fighterId, eventId, boutId] = await Promise.all([
    resolveScopedId(env, url.searchParams.get("fighter_id"), "fighter"),
    resolveScopedId(env, url.searchParams.get("event_id"), "event"),
    resolveScopedId(env, url.searchParams.get("bout_id"), "bout"),
  ]);
  const { rows, total } = await queryVideos(env, { fighter_id: fighterId, event_id: eventId, bout_id: boutId, type, limit });
  return { data: rows, meta: { count: rows.length, total, limit, type, fighter_id: fighterId, event_id: eventId, bout_id: boutId, published_only: true } };
}

async function fighterVideos(env, fighterId, url) {
  const fighter = await resolveFighter(env, fighterId);
  if (!fighter) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.");
  const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
  const type = parseVideoType(url);
  const [imageMap, { rows, total }] = await Promise.all([imagesForFighters(env, [fighter.id]), queryVideos(env, { fighter_id: fighter.id, type, limit })]);
  return { data: { fighter: compactFighter(fighter, imageMap), videos: rows }, meta: { count: rows.length, total, limit, type, published_only: true } };
}

async function boutVideos(env, boutId, url) {
  const bout = await resolveBout(env, boutId);
  if (!bout) throw new ApiError(404, "bout_not_found", "UFC bout not found.");
  const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
  const type = parseVideoType(url);
  const { rows, total } = await queryVideos(env, { bout_id: bout.id, type, limit });
  const data = {
    bout: { id: bout.id, event: compactEvent(bout.event), fighter_a: compactFighter(bout.fighter_a, null), fighter_b: compactFighter(bout.fighter_b, null), bout_order: bout.bout_order ?? null, weight_class: bout.weight_class ?? null },
    videos: rows,
  };
  return { data, meta: { count: rows.length, total, limit, type, published_only: true, note: "Videos linked to this bout only; event-wide fight-week videos live on /events/{id}/videos." } };
}

/* Chronological rail grouped by video_type in fight-week order (addendum section 8). */
async function eventVideos(env, eventId, url) {
  const event = await resolveEvent(env, eventId);
  if (!event) throw new ApiError(404, "event_not_found", "UFC event not found.");
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 200);
  const type = parseVideoType(url);
  const { rows, total } = await queryVideos(env, { event_id: event.id, type, limit, order: "asc" });
  const byType = new Map();
  for (const v of rows) {
    if (!byType.has(v.video_type)) byType.set(v.video_type, []);
    byType.get(v.video_type).push(v);
  }
  const typeIdx = (t) => { const i = VIDEO_TIMELINE_ORDER.indexOf(t); return i < 0 ? VIDEO_TIMELINE_ORDER.length : i; };
  const groups = [...byType.entries()]
    .sort(([a], [b]) => typeIdx(a) - typeIdx(b))
    .map(([video_type, videos]) => ({ video_type, label: VIDEO_TYPE_LABELS[video_type] || video_type, count: videos.length, first_published_at: videos[0]?.published_at ?? null, last_published_at: videos[videos.length - 1]?.published_at ?? null, videos }));
  return {
    data: { event: compactEvent(event), videos: rows, groups },
    meta: { count: rows.length, total, limit, type, order: "chronological", groups: groups.length, timeline_order: VIDEO_TIMELINE_ORDER, published_only: true },
  };
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
    media_base_url: imageBase(env) || null,
    endpoints: {
      events: "/v1/ufc/events",
      event: "/v1/ufc/events/{id}",
      card: "/v1/ufc/events/{id}/card?include=media,results,stats",
      event_articles: "/v1/ufc/events/{id}/articles",
      fighters: "/v1/ufc/fighters",
      fighters_media: "/v1/ufc/fighters/media?ids=a,b,c",
      fighter: "/v1/ufc/fighters/{id}?include=media,ranking,next,history,stats",
      fighter_history: "/v1/ufc/fighters/{id}/history",
      fighter_stats: "/v1/ufc/fighters/{id}/stats",
      fighter_articles: "/v1/ufc/fighters/{id}/articles",
      bout: "/v1/ufc/bouts/{id}",
      bout_stats: "/v1/ufc/bouts/{id}/stats",
      results: "/v1/ufc/results",
      rankings: "/v1/ufc/rankings?division=MIDDLEWEIGHT",
      news: "/v1/ufc/news",
      wire: "/v1/ufc/wire?limit=20",
      article: "/v1/ufc/articles/{slug}",
      search: "/v1/ufc/search?q=volkanovski",
      counts: "/v1/ufc/counts",
      dna_metrics: "/v1/ufc/dna/metrics",
      dna_query: "/v1/ufc/dna/query?metric=pace_retention_r3_vs_r1&min=0.9&min_confidence=low&limit=50",
      fighter_dna: "/v1/ufc/fighters/{id}/dna?as_of=YYYY-MM-DD",
      fighter_splits: "/v1/ufc/fighters/{id}/splits?opponent_stance=SOUTHPAW",
      fighter_round_profile: "/v1/ufc/fighters/{id}/round-profile",
      fighter_finish_profile: "/v1/ufc/fighters/{id}/finish-profile",
      fighter_position_profile: "/v1/ufc/fighters/{id}/position-profile",
      matchup_dna: "/v1/ufc/matchups/{fighterA}/{fighterB}/dna?as_of=YYYY-MM-DD",
      bout_ledger: "/v1/ufc/bouts/{id}/ledger?limit=25",
      event_intelligence: "/v1/ufc/events/{id}/intelligence",
      videos: "/v1/ufc/videos?limit=20&type=&fighter_id=&event_id=&bout_id=",
      fighter_videos: "/v1/ufc/fighters/{id}/videos",
      event_videos: "/v1/ufc/events/{id}/videos",
      bout_videos: "/v1/ufc/bouts/{id}/videos",
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
      media_configured: Boolean(imageBase(env)),
    }, {}, 0);
  }

  const requestId = crypto.randomUUID();
  const tier = { access_tier: access.tier };
  if (path === "/v1/ufc") return ok(env, requestId, apiIndex(env), tier, 300);

  if (path === "/v1/ufc/events") {
    const out = await listEvents(env, url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, url.searchParams.get("status") === "upcoming" ? 60 : 300);
  }

  let m = path.match(/^\/v1\/ufc\/events\/([^/]+)\/card$/);
  if (m) {
    const out = await eventCard(env, decodeURIComponent(m[1]), url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 60);
  }

  m = path.match(/^\/v1\/ufc\/events\/([^/]+)\/articles$/);
  if (m) {
    const out = await articlesForEvent(env, decodeURIComponent(m[1]), url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 120);
  }

  m = path.match(/^\/v1\/ufc\/events\/([^/]+)\/videos$/);
  if (m) {
    const out = await eventVideos(env, decodeURIComponent(m[1]), url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 300);
  }

  m = path.match(/^\/v1\/ufc\/events\/([^/]+)$/);
  if (m) {
    const includes = parseIncludes(url, EVENT_INCLUDES);
    const event = await resolveEvent(env, decodeURIComponent(m[1]));
    if (!event) throw new ApiError(404, "event_not_found", "UFC event not found.");
    if (!includes.has("videos")) return ok(env, requestId, event, tier, 300);
    const videos = await compactVideosFor(env, { event_id: event.id });
    return ok(env, requestId, { ...event, videos }, { ...tier, include: [...includes], videos: videos ? videos.length : null }, 300);
  }

  if (path === "/v1/ufc/fighters") {
    const out = await listFighters(env, url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 300);
  }

  if (path === "/v1/ufc/fighters/media") {
    const out = await bulkFighterMedia(env, url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 3600);
  }

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)\/history$/);
  if (m) return ok(env, requestId, await fighterHistory(env, decodeURIComponent(m[1]), url), tier, 300);

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)\/stats$/);
  if (m) return ok(env, requestId, await fighterStats(env, decodeURIComponent(m[1])), tier, 300);

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)\/articles$/);
  if (m) {
    const out = await articlesForFighter(env, decodeURIComponent(m[1]), url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 120);
  }

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)\/videos$/);
  if (m) {
    const out = await fighterVideos(env, decodeURIComponent(m[1]), url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 300);
  }

  if (path === "/v1/ufc/videos") {
    const out = await listVideos(env, url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 300);
  }

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)$/);
  if (m) {
    const out = await fighterDetail(env, decodeURIComponent(m[1]), url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 300);
  }

  m = path.match(/^\/v1\/ufc\/bouts\/([^/]+)\/stats$/);
  if (m) return ok(env, requestId, await boutStats(env, decodeURIComponent(m[1])), tier, 300);

  m = path.match(/^\/v1\/ufc\/bouts\/([^/]+)\/videos$/);
  if (m) {
    const out = await boutVideos(env, decodeURIComponent(m[1]), url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 300);
  }

  m = path.match(/^\/v1\/ufc\/bouts\/([^/]+)$/);
  if (m) {
    const bout = await resolveBout(env, decodeURIComponent(m[1]));
    if (!bout) throw new ApiError(404, "bout_not_found", "UFC bout not found.");
    return ok(env, requestId, bout, tier, 300);
  }

  if (path === "/v1/ufc/results") {
    const data = await listResults(env, url);
    return ok(env, requestId, data, { count: data.length, ...tier }, 300);
  }

  if (path === "/v1/ufc/rankings") {
    const out = await rankingsResponse(env, url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 300);
  }

  if (path === "/v1/ufc/news") {
    const out = await listArticles(env, url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 120);
  }

  if (path === "/v1/ufc/wire") {
    const out = await wire(env, url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 30, 200, WIRE_CACHE_HEADERS);
  }

  m = path.match(/^\/v1\/ufc\/articles\/([^/]+)$/);
  if (m) {
    const article = await articleDetail(env, decodeURIComponent(m[1]));
    if (!article) throw new ApiError(404, "article_not_found", "UFC article not found.");
    return ok(env, requestId, article, tier, 300);
  }

  if (path === "/v1/ufc/search") {
    return ok(env, requestId, await searchAll(env, url), tier, 60);
  }

  if (path === "/v1/ufc/counts") {
    return ok(env, requestId, await counts(env), tier, 60);
  }

  /* Fight DNA routes: same envelope, CORS *, 60 s browser / 300 s edge / 900 s stale. */
  const dnaOk = (out) => ok(env, requestId, out.data, { ...out.meta, ...tier }, 300, 200, DNA_CACHE_HEADERS);

  if (path === "/v1/ufc/dna/metrics") return dnaOk(await dnaMetricsRegistry(env, url));
  if (path === "/v1/ufc/dna/query") return dnaOk(await dnaQuery(env, url));

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)\/dna$/);
  if (m) return dnaOk(await fighterDna(env, decodeURIComponent(m[1]), url));

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)\/splits$/);
  if (m) return dnaOk(await fighterSplits(env, decodeURIComponent(m[1]), url));

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)\/(round|finish|position)-profile$/);
  if (m) return dnaOk(await fighterDnaFamily(env, decodeURIComponent(m[1]), url, `${m[2]}_profile`));

  m = path.match(/^\/v1\/ufc\/matchups\/([^/]+)\/([^/]+)\/dna$/);
  if (m) return dnaOk(await matchupDna(env, decodeURIComponent(m[1]), decodeURIComponent(m[2]), url));

  /* Fight State Ledger reads (append-only table; same cache policy). */
  m = path.match(/^\/v1\/ufc\/bouts\/([^/]+)\/ledger$/);
  if (m) return dnaOk(await boutLedger(env, decodeURIComponent(m[1]), url));

  m = path.match(/^\/v1\/ufc\/events\/([^/]+)\/intelligence$/);
  if (m) return dnaOk(await eventIntelligence(env, decodeURIComponent(m[1]), url));

  throw new ApiError(404, "route_not_found", "UFC API route not found.");
}

export const __test = {
  clampInt, sanitizeLike, identityFilter, normalizeBout, parseIncludes,
  mediaUrls, decorateImage, primaryImage, compactImage, attachHero, heroImagesForArticles, withHeroMedia,
  rankingsFromSnapshot, rankingsFromTable, loadRankings, rankingsResponse, rankingPositionsForFighter, divisionLabel,
  sumMetrics, totalsByFighter, boutElapsedSeconds, computeFighterStats, boutOutcome, nextScheduledBout, historyRow,
  compactFighter, slugId, bulkFighterMedia, rankingsState,
  slugify, fighterSlug, eventSlug, matchupSlug, normalizeTitle, dedupeWireItems, articleMatchesItem, wireInternalUrl, wireTaxonomy, wire,
  wordCount, analysisSummaryFrom, articleAnalysis, withAnalysis,
  DNA_COMPARISONS, DNA_INSIGHT_RULES, DNA_STANCES, DNA_CACHE_HEADERS, meetsConfidence, findMetric, compareMetric, normalizeStance,
  stanceMatchupContext, parseAsOf, buildMatchupDna, snapshotView, fmtSample, fmtValue, familyHasValues,
  ledgerView, ledgerDiff, eventIntelligence, LEDGER_SOURCES, CARD_SHOCK_PLACEHOLDER,
  videoView, videoEmbedUrl, VIDEO_TYPES, VIDEO_TIMELINE_ORDER,
};

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
