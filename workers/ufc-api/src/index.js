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

const IMAGE_COLS = "id,kind,r2_key,license,author,source_url,fighter_id,created_at";

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

const FIGHTER_INCLUDES = ["media", "ranking", "next", "history", "stats"];
const CARD_INCLUDES = ["media", "results", "stats"];
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

async function sb(env, table, params, { count = false } = {}) {
  requireDb(env);
  const res = await fetch(sbUrl(env, table, params), { headers: sbHeaders(env, count) });
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
  const [imageMap, roundRows] = await Promise.all([
    imagesForFighters(env, fighterIds),
    includes.has("stats") && rows.length
      ? sb(env, "ufc_bout_round_stats", new URLSearchParams({ select: ROUND_STAT_COLS, bout_id: `in.(${rows.map((b) => b.id).join(",")})`, order: "bout_id.asc,round.asc,fighter_id.asc", limit: "5000" })).then((r) => r.data)
      : Promise.resolve(null),
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
  return { data: { event, bouts }, meta };
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
  const [ownImages, bouts, roundRows, ranking] = await Promise.all([
    imagesForFighters(env, [fighter.id]),
    needBouts ? fighterBoutRows(env, fighter.id, 250) : Promise.resolve([]),
    includes.has("stats") ? fighterRoundRows(env, fighter.id) : Promise.resolve(null),
    includes.has("ranking") ? fighterRanking(env, fighter.id) : Promise.resolve(undefined),
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
  const meta = { include: [...includes] };
  if (includes.has("history")) meta.history_count = data.history.length;
  if (includes.has("stats")) meta.round_stat_rows = (roundRows || []).length;
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

/* ---- fighter status -------------------------------------------------- */

const STATUS_TYPES = new Set(['injury', 'illness', 'withdrawal', 'replacement', 'suspension', 'visa_travel', 'weight_miss', 'return', 'cleared', 'other']);
const STATUS_STATES = new Set(['active', 'resolved', 'expired']);
/* Which statuses mean "not available". Mirrors ufc_fighter_current_status. */
const STATUS_UNAVAILABLE = new Set(['injury', 'illness', 'withdrawal', 'suspension', 'visa_travel']);

/**
 * Availability events.
 *
 * A CONTRACT NOTE THAT OUTRANKS THE SHAPE: injury_type / body_part /
 * injury_side arrive null far more often than not, and a null there means the
 * source did not say. It never means "unspecified injury" and never licenses a
 * client to fill the gap — clinical_quote exists so a consumer can show the
 * sentence a claim came from, and its absence is the signal that there is no
 * claim to show.
 */
async function listStatusEvents(env, url) {
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 100000);
  const p = new URLSearchParams({ select: "*", order: "occurred_at.desc.nullslast", limit: String(limit), offset: String(offset) });

  /* ?active=true is the shorthand the brief asked for; ?state= is the full
   * control. active wins when both are given and disagree, because it is the
   * more specific request. */
  const active = url.searchParams.get("active");
  const state = sanitizeLike(url.searchParams.get("state"));
  if (active === "true") p.set("state", "eq.active");
  else if (active === "false") p.set("state", "neq.active");
  else if (state && state !== "all") {
    if (!STATUS_STATES.has(state)) throw new ApiError(400, "invalid_state", `state must be one of ${[...STATUS_STATES].join(", ")} or all.`);
    p.set("state", `eq.${state}`);
  } else if (!state) p.set("state", "eq.active");

  const type = sanitizeLike(url.searchParams.get("status_type"));
  if (type) {
    if (!STATUS_TYPES.has(type)) throw new ApiError(400, "invalid_status_type", `status_type must be one of ${[...STATUS_TYPES].join(", ")}.`);
    p.set("status_type", `eq.${type}`);
  }
  const fighterId = sanitizeLike(url.searchParams.get("fighter_id"));
  if (fighterId) p.set("fighter_id", `eq.${fighterId}`);
  const eventId = sanitizeLike(url.searchParams.get("event_id"));
  if (eventId) p.set("event_id", `eq.${eventId}`);

  const out = await sb(env, "ufc_fighter_status_feed", p, { count: true });
  return { data: out.data, meta: { count: out.data.length, total: out.count, limit, offset } };
}

async function eventCardChanges(env, id) {
  const event = await resolveEvent(env, id);
  if (!event) throw new ApiError(404, "event_not_found", "UFC event not found.");
  const p = new URLSearchParams({ select: "*", event_id: `eq.${event.id}`, order: "occurred_at.desc.nullslast", limit: "60" });
  const rows = (await sb(env, "ufc_event_card_changes", p)).data;
  return { data: { event: { id: event.id, name: event.name, event_date: event.event_date }, changes: rows }, meta: { count: rows.length } };
}

async function fighterStatus(env, id, url) {
  const fighter = await resolveFighter(env, id);
  if (!fighter) throw new ApiError(404, "fighter_not_found", "UFC fighter not found.");
  const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
  const p = new URLSearchParams({ select: "*", fighter_id: `eq.${fighter.id}`, order: "occurred_at.desc.nullslast", limit: String(limit) });
  const history = (await sb(env, "ufc_fighter_status_feed", p)).data;
  const current = history.find((e) => e.state === "active" && STATUS_UNAVAILABLE.has(e.status_type)) || null;
  return {
    data: {
      fighter: { id: fighter.id, name: fighter.name },
      current,
      /* Said explicitly because the alternative reading is dangerous: no row
       * is no report, not a clean bill of health. */
      current_note: current ? null : "No availability event on file. This is the absence of a report, not a confirmation of fitness.",
      history,
    },
    meta: { count: history.length },
  };
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
      injuries: "/v1/ufc/injuries?active=true",
      event_card_changes: "/v1/ufc/events/{id}/card-changes",
      fighter_status: "/v1/ufc/fighters/{id}/status",
      news: "/v1/ufc/news",
      wire: "/v1/ufc/wire?limit=20",
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

  /* Sub-routes precede the bare /{id} pattern. Ordering is not load-bearing —
   * that pattern is anchored with $ and [^/]+ cannot span a slash — but an
   * edit that relaxed the anchor should not silently reroute this. */
  m = path.match(/^\/v1\/ufc\/events\/([^/]+)\/card-changes$/);
  if (m) {
    const out = await eventCardChanges(env, decodeURIComponent(m[1]));
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 60);
  }

  m = path.match(/^\/v1\/ufc\/events\/([^/]+)$/);
  if (m) {
    const event = await resolveEvent(env, decodeURIComponent(m[1]));
    if (!event) throw new ApiError(404, "event_not_found", "UFC event not found.");
    return ok(env, requestId, event, tier, 300);
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

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)\/status$/);
  if (m) {
    const out = await fighterStatus(env, decodeURIComponent(m[1]), url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 60);
  }

  m = path.match(/^\/v1\/ufc\/fighters\/([^/]+)$/);
  if (m) {
    const out = await fighterDetail(env, decodeURIComponent(m[1]), url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 300);
  }

  m = path.match(/^\/v1\/ufc\/bouts\/([^/]+)\/stats$/);
  if (m) return ok(env, requestId, await boutStats(env, decodeURIComponent(m[1])), tier, 300);

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

  if (path === "/v1/ufc/injuries") {
    const out = await listStatusEvents(env, url);
    return ok(env, requestId, out.data, { ...out.meta, ...tier }, 60);
  }

  if (path === "/v1/ufc/search") {
    return ok(env, requestId, await searchAll(env, url), tier, 60);
  }

  if (path === "/v1/ufc/counts") {
    return ok(env, requestId, await counts(env), tier, 60);
  }

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
  listStatusEvents, eventCardChanges, fighterStatus, STATUS_TYPES, STATUS_STATES, STATUS_UNAVAILABLE,
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
