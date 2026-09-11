/* Read-only production smoke for the UFC API. Every request is a GET against
 * the live worker; nothing is written anywhere. Exits non-zero on the first
 * broken contract. Set UFC_API_BASE_URL to smoke another origin. */
const BASE = (process.env.UFC_API_BASE_URL || "https://ufc-api.propbetedge.ai").replace(/\/$/, "");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let checks = 0;
function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
}

async function get(path, expectedStatus = 200) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  assert(res.status === expectedStatus, `${path}: expected HTTP ${expectedStatus}, got ${res.status}; body=${text.slice(0, 300)}`);
  return body;
}

function isCompactImage(img, label) {
  assert(img && typeof img === "object", `${label}: primary_image must be an object`);
  for (const k of ["image_url", "card_url", "thumb_url", "author", "license", "source_url", "kind"]) {
    assert(k in img, `${label}: primary_image missing ${k}`);
  }
  assert(/^https:\/\//.test(img.image_url), `${label}: image_url must be an https URL`);
  assert(/\/portrait\.jpg$/.test(img.image_url), `${label}: image_url should point at portrait.jpg`);
  assert(/\/card\.jpg$/.test(img.card_url) && /\/thumb\.jpg$/.test(img.thumb_url), `${label}: card/thumb derivatives missing`);
  assert(img.license && img.source_url, `${label}: licensed media must carry license + source_url`);
}

/* ---- baseline (unchanged contracts) ----------------------------------- */

const health = await get("/health");
assert(health?.ok === true, "health: ok != true");
assert(health?.data?.status === "ok", "health: status != ok");
assert(health?.data?.database_configured === true, "health: database not configured");
assert(health?.data?.media_configured === true, "health: UFC_IMAGE_BASE_URL not configured");

const index = await get("/v1/ufc");
assert(index?.data?.media_base_url, "index: media_base_url missing");
for (const k of ["fighters_media", "event_articles", "fighter_articles", "rankings"]) assert(index.data.endpoints?.[k], `index: endpoint ${k} missing`);

const counts = await get("/v1/ufc/counts");
assert(counts?.ok === true, "counts: ok != true");
for (const k of ["fighters", "events", "bouts", "results", "images", "articles"]) {
  assert(Number.isInteger(counts?.data?.[k]) && counts.data[k] > 0, `counts: ${k} must be positive integer`);
}
assert(counts.data.rounds === counts.data.round_stat_rows, "counts: rounds alias mismatch");
assert(Number.isInteger(counts.data.fighters_with_media), "counts: fighters_with_media missing");

const events = await get("/v1/ufc/events?status=all&limit=3");
assert(Array.isArray(events?.data) && events.data.length > 0, "events: expected rows");

const results = await get("/v1/ufc/results?limit=1");
assert(Array.isArray(results?.data) && results.data.length === 1, "results: expected one row");
const sample = results.data[0];
const bout = sample?.bout;
assert(bout?.id, "results: sample bout missing id");
assert(bout?.event?.id, "results: sample bout missing event id");
assert(bout?.fighter_a?.id || bout?.fighter_b?.id, "results: sample bout missing fighter ids");

const eventId = bout.event.id;
const boutId = bout.id;
const fighterId = bout.fighter_a?.id || bout.fighter_b?.id;
const fighterName = bout.fighter_a?.name || bout.fighter_b?.name || "UFC";

const event = await get(`/v1/ufc/events/${encodeURIComponent(eventId)}`);
assert(event?.data?.id === eventId, "event detail: id mismatch");

const card = await get(`/v1/ufc/events/${encodeURIComponent(eventId)}/card`);
assert(card?.data?.event?.id === eventId, "event card: event id mismatch");
assert(Array.isArray(card?.data?.bouts), "event card: bouts missing");
for (const b of card.data.bouts) {
  for (const side of ["fighter_a", "fighter_b"]) {
    if (!b[side]) continue;
    assert(Array.isArray(b[side].images), `event card: ${side}.images missing`);
    assert("primary_image" in b[side], `event card: ${side}.primary_image missing`);
  }
  assert(!("round_stats" in b), "event card: default response must not carry round_stats");
}

const boutDetail = await get(`/v1/ufc/bouts/${encodeURIComponent(boutId)}`);
assert(boutDetail?.data?.id === boutId, "bout detail: id mismatch");

const boutStats = await get(`/v1/ufc/bouts/${encodeURIComponent(boutId)}/stats`);
assert(boutStats?.data?.bout?.id === boutId, "bout stats: bout id mismatch");
assert(Array.isArray(boutStats?.data?.rounds), "bout stats: rounds missing");
assert(boutStats?.data?.totals && typeof boutStats.data.totals === "object", "bout stats: totals missing");
assert("fight_time_sec" in boutStats.data && boutStats.data.provenance?.source === "ufcstats_round_stats", "bout stats: provenance missing");
if (boutStats.data.rounds.length) {
  for (const c of ["kd", "sig_str_landed", "sig_str_att", "total_str_landed", "total_str_att", "td_landed", "td_att", "sub_att", "rev", "ctrl_sec", "head_landed", "head_att", "body_landed", "body_att", "leg_landed", "leg_att", "distance_landed", "distance_att", "clinch_landed", "clinch_att", "ground_landed", "ground_att"]) {
    assert(c in boutStats.data.rounds[0], `bout stats: round row missing ${c}`);
  }
}

const fighter = await get(`/v1/ufc/fighters/${encodeURIComponent(fighterId)}`);
assert(fighter?.data?.id === fighterId, "fighter detail: id mismatch");
assert(Array.isArray(fighter.data.images) && "primary_image" in fighter.data && "slug_id" in fighter.data, "fighter detail: media/slug fields missing");

const history = await get(`/v1/ufc/fighters/${encodeURIComponent(fighterId)}/history?limit=5`);
assert(history?.data?.fighter?.id === fighterId, "fighter history: fighter id mismatch");
assert(Array.isArray(history?.data?.bouts), "fighter history: bouts missing");
if (history.data.bouts.length) assert("opponent" in history.data.bouts[0] && "outcome" in history.data.bouts[0], "fighter history: opponent/outcome missing");

const fighterStats = await get(`/v1/ufc/fighters/${encodeURIComponent(fighterId)}/stats`);
assert(fighterStats?.data?.fighter?.id === fighterId, "fighter stats: fighter id mismatch");
assert(fighterStats?.data?.career_snapshot && typeof fighterStats.data.career_snapshot === "object", "fighter stats: snapshot missing");
assert(Array.isArray(fighterStats.data.round_stats) && fighterStats.data.computed?.provenance?.source === "ufcstats_round_stats", "fighter stats: computed block missing");

const query = encodeURIComponent(String(fighterName).split(/\s+/)[0].slice(0, 30));
const search = await get(`/v1/ufc/search?q=${query}&limit=3`);
assert(search?.ok === true && search?.data?.q, "search: invalid response");
assert(Array.isArray(search?.data?.fighters) && Array.isArray(search.data.events) && Array.isArray(search.data.articles), "search: fighters/events/articles missing");
if (search.data.fighters.length) assert("primary_image" in search.data.fighters[0] && "slug_id" in search.data.fighters[0], "search: fighter hit lacks primary_image/slug_id");

/* ---- B1 media: one fighter with media, one without --------------------- */

const strickland = await get("/v1/ufc/fighters/0d8011111be000b2");
assert(strickland?.data?.name === "Sean Strickland", "media: Sean Strickland not resolvable by UFCStats id");
isCompactImage(strickland.data.primary_image, "media: Strickland");
assert(strickland.data.images.length >= 1 && strickland.data.images[0].image_url === strickland.data.primary_image.image_url, "media: images[0] and primary_image disagree");
assert(strickland.data.images[0].thumb_url === strickland.data.primary_image.thumb_url, "media: images[] must carry derived urls too");
const portraitHead = await fetch(strickland.data.primary_image.thumb_url, { method: "HEAD" });
assert(portraitHead.ok && /^image\//.test(portraitHead.headers.get("content-type") || ""), "media: thumb_url does not serve an image");

const list = await get("/v1/ufc/fighters?limit=250");
assert(Array.isArray(list?.data) && list.data.length > 0, "fighters: expected rows");
assert(list.data.every((f) => "primary_image" in f && !("images" in f)), "fighters: every list row needs primary_image and no images[]");
assert(Number.isInteger(list.meta?.with_media), "fighters: meta.with_media missing");
const noMedia = list.data.find((f) => f.primary_image === null);
const withMedia = list.data.find((f) => f.primary_image);
assert(noMedia, "fighters: expected at least one fighter without media in the first 250");
assert(withMedia, "fighters: expected at least one fighter with media in the first 250");
isCompactImage(withMedia.primary_image, `fighters list: ${withMedia.name}`);

const noMediaDetail = await get(`/v1/ufc/fighters/${noMedia.id}`);
assert(noMediaDetail.data.primary_image === null && noMediaDetail.data.images.length === 0, `media: ${noMedia.name} should have no media`);

const bulk = await get(`/v1/ufc/fighters/media?ids=${strickland.data.id},${noMedia.id}`);
assert(bulk?.data?.media && bulk.meta.requested === 2 && bulk.meta.found >= 1, "bulk media: bad meta");
assert(bulk.data.media[noMedia.id] === null, "bulk media: no-media fighter must be null");
isCompactImage(bulk.data.media[strickland.data.id], "bulk media: Strickland");
const bulkBad = await get("/v1/ufc/fighters/media?ids=nope", 400);
assert(bulkBad?.error?.code === "invalid_ids", "bulk media: invalid ids not rejected");

/* ---- B2 rankings ------------------------------------------------------ */

const rankings = await get("/v1/ufc/rankings");
assert(rankings?.ok === true, "rankings: expected a verified snapshot");
assert(rankings.data.source && rankings.data.source_url && rankings.data.snapshot_date && rankings.data.captured_at, "rankings: source/timestamps missing");
assert(Array.isArray(rankings.data.divisions) && rankings.data.divisions.length >= 10, "rankings: expected the official division lists");
assert(["snapshot", "table"].includes(rankings.meta?.store), "rankings: meta.store missing");
for (const d of rankings.data.divisions) {
  assert(d.key && d.label && typeof d.is_womens === "boolean" && typeof d.is_p4p === "boolean", `rankings: division shape broken for ${d.key}`);
  assert(d.is_p4p ? d.champion === null : true, `rankings: P4P ${d.label} must not carry a champion`);
  if (d.champion) assert(d.champion.name && "fighter" in d.champion, `rankings: champion shape broken for ${d.label}`);
  let prev = 0;
  for (const e of d.entries) {
    assert(Number.isInteger(e.rank) && e.rank >= prev, `rankings: ${d.label} entries not in stable rank order`);
    prev = e.rank;
    assert(e.name && "fighter_id" in e && "fighter" in e && "change" in e && typeof e.is_new === "boolean", `rankings: entry shape broken for ${d.label}`);
    if (e.fighter) assert(UUID_RE.test(e.fighter.id) && e.fighter.name && e.fighter.slug_id, `rankings: linked fighter identity incomplete in ${d.label}`);
    if (!e.fighter) assert(e.fighter_id === null, `rankings: fighter_id set but identity unresolved in ${d.label}`);
  }
}
const mw = await get("/v1/ufc/rankings?division=middleweight");
assert(mw.data.divisions.length === 1 && mw.data.divisions[0].key === "MIDDLEWEIGHT", "rankings: division filter broken");
const noDivision = await get("/v1/ufc/rankings?division=nope", 404);
assert(noDivision?.error?.code === "division_not_found", "rankings: unknown division should 404");

/* ---- B3 article media ------------------------------------------------- */

const news = await get("/v1/ufc/news?limit=100");
assert(news?.ok === true && Array.isArray(news?.data), "news: expected array");
assert(news.data.every((a) => "hero_image_url" in a && "hero_image" in a && "hero_image_ref" in a && "hero_credit" in a), "news: hero fields missing");
assert(news.data.every((a) => (a.hero_image_url === null) === (a.hero_image === null)), "news: hero_image_url/hero_image must agree");
assert(news.data.every((a) => a.hero_image_ref || a.hero_image === null), "news: hero fabricated without a ref");
const heroArticle = news.data.find((a) => a.hero_image_url);
const plainArticle = news.data.find((a) => !a.hero_image_ref);
if (heroArticle) {
  assert(/^https:\/\//.test(heroArticle.hero_image_url), "news: hero_image_url must be https");
  assert(heroArticle.hero_image.license && heroArticle.hero_image.source_url, "news: hero credit incomplete");
  const detail = await get(`/v1/ufc/articles/${encodeURIComponent(heroArticle.slug)}`);
  assert(detail.data.hero_image_url === heroArticle.hero_image_url && detail.data.body_md, "article detail: hero/body mismatch");
}
if (plainArticle) {
  const detail = await get(`/v1/ufc/articles/${encodeURIComponent(plainArticle.slug)}`);
  assert(detail.data.hero_image_url === null && detail.data.hero_image === null, "article detail: hero must be null without a ref");
}

/* ---- editorial analysis (editorial_contract.md) ----------------------- */

const ODDS_STATUS = ["unavailable", "snapshot", "live"];
const MODEL_STATUS = ["unavailable", "priced"];
assert(news.data.every((a) => "analysis_summary" in a && !("fact_block" in a) && !("analysis" in a) && !("body_md" in a)), "news: analysis_summary must be on every list row and fact_block/analysis/body off the list");
assert(news.data.every((a) => a.analysis_summary === null || (Number.isInteger(a.analysis_summary.impact_score) && Array.isArray(a.analysis_summary.markets) && ODDS_STATUS.includes(a.analysis_summary.odds_status) && MODEL_STATUS.includes(a.analysis_summary.model_status) && "story_class" in a.analysis_summary)), "news: analysis_summary shape broken");
assert(Number.isInteger(news.meta.with_analysis) && news.meta.with_analysis === news.data.filter((a) => a.analysis_summary).length, "news: meta.with_analysis mismatch");
const analysed = news.data.find((a) => a.analysis_summary) || null;
const analysisProbe = await get(`/v1/ufc/articles/${encodeURIComponent((analysed || news.data[0]).slug)}`);
assert("analysis" in analysisProbe.data && "analysis_summary" in analysisProbe.data, "article detail: analysis fields missing");
assert(Number.isInteger(analysisProbe.data.word_count) && analysisProbe.data.word_count > 0 && Number.isInteger(analysisProbe.data.reading_minutes) && analysisProbe.data.reading_minutes >= 1, "article detail: word_count/reading_minutes missing");
if (analysisProbe.data.analysis) {
  const an = analysisProbe.data.analysis;
  for (const k of ["version", "story_class", "generated_at", "sources", "bettor_angle", "market_watch", "matchup"]) assert(k in an, `analysis: missing ${k}`);
  assert(Number(an.version) >= 2 && an.story_class, "analysis: version/story_class invalid");
  const ba = an.bettor_angle;
  assert(ba && Array.isArray(ba.supporting_facts) && ba.supporting_facts.length >= 1, "analysis: bettor_angle needs >= 1 supporting fact");
  assert(Array.isArray(ba.risks) && ba.risks.length >= 1, "analysis: bettor_angle needs >= 1 risk");
  assert(ODDS_STATUS.includes(ba.odds_status), `analysis: odds_status ${ba.odds_status} invalid`);
  assert(MODEL_STATUS.includes(ba.model_status), `analysis: model_status ${ba.model_status} invalid`);
  assert(Number.isInteger(ba.impact_score) && ba.impact_score >= 1 && ba.impact_score <= 5, "analysis: impact_score must be 1..5");
  assert(analysisProbe.data.analysis_summary?.story_class === an.story_class && analysisProbe.data.analysis_summary.impact_score === ba.impact_score, "analysis: summary disagrees with block");
  const byClass = await get(`/v1/ufc/news?story_class=${encodeURIComponent(an.story_class)}&limit=5`);
  assert(byClass.data.length >= 1 && byClass.data.every((a) => a.analysis_summary?.story_class === an.story_class), "news: story_class filter broken");
} else {
  assert(analysisProbe.data.analysis === null && analysisProbe.data.analysis_summary === null, "article detail: legacy fact block must yield null analysis + null analysis_summary");
}
const noClass = await get("/v1/ufc/news?story_class=nope_class&limit=5");
assert(Array.isArray(noClass.data) && noClass.data.length === 0 && noClass.meta.story_class === "nope_class", "news: unknown story_class must return an empty list");

/* ---- B4 composite contracts ------------------------------------------- */

const profile = await get(`/v1/ufc/fighters/0d8011111be000b2?include=media,ranking,next,history,stats`);
const p = profile.data;
assert(p.id === strickland.data.id && p.name === strickland.data.name, "profile: base fields changed under include");
assert(p.ranking === null || (Array.isArray(p.ranking.positions) && p.ranking.snapshot_date), "profile: ranking block malformed");
assert(p.next_bout === null || (p.next_bout.event?.id && p.next_bout.opponent?.id && "primary_image" in p.next_bout.opponent), "profile: next_bout malformed");
assert(Array.isArray(p.history) && p.history.every((h) => "opponent" in h && "outcome" in h && "event" in h && "result" in h), "profile: history rows malformed");
assert(p.stats?.career_snapshot && p.stats?.computed?.provenance?.source === "ufcstats_round_stats", "profile: stats block malformed");
assert(Array.isArray(p.stats.computed.bouts) && "career_rates" in p.stats.computed && "career_totals" in p.stats.computed, "profile: computed stats malformed");
assert(Array.isArray(profile.meta.include) && profile.meta.include.length === 5, "profile: meta.include missing");
const badInclude = await get(`/v1/ufc/fighters/0d8011111be000b2?include=odds`, 400);
assert(badInclude?.error?.code === "invalid_include", "profile: unknown include not rejected");

const upcomingEvents = await get("/v1/ufc/events?status=upcoming&limit=1");
const upcomingId = upcomingEvents.data[0]?.id || eventId;
const fullCard = await get(`/v1/ufc/events/${encodeURIComponent(upcomingId)}/card?include=media,results,stats`);
assert(fullCard.data.event.id === upcomingId && Array.isArray(fullCard.data.bouts), "card include: event/bouts missing");
assert(fullCard.data.bouts.every((b) => Array.isArray(b.round_stats) && b.stat_totals && typeof b.stat_totals === "object" && "result" in b), "card include: round_stats/stat_totals missing");
assert(Number.isInteger(fullCard.meta.round_stat_rows), "card include: meta.round_stat_rows missing");
const completedCard = await get(`/v1/ufc/events/${encodeURIComponent(eventId)}/card?include=stats`);
assert(completedCard.data.bouts.every((b) => Array.isArray(b.round_stats)), "card include: completed card stats missing");

const eventArticles = await get(`/v1/ufc/events/${encodeURIComponent(upcomingId)}/articles`);
assert(eventArticles.data.event?.id === upcomingId && Array.isArray(eventArticles.data.articles), "event articles: malformed");
assert(eventArticles.data.articles.every((a) => a.event_id === upcomingId && "hero_image_url" in a), "event articles: wrong event or hero missing");
const fighterArticles = await get(`/v1/ufc/fighters/0d8011111be000b2/articles`);
assert(fighterArticles.data.fighter?.id === strickland.data.id && Array.isArray(fighterArticles.data.articles), "fighter articles: malformed");
assert(fighterArticles.data.articles.every((a) => a.fighter_ids.includes(strickland.data.id)), "fighter articles: wrong fighter");

/* ---- live wire (addendum section 2) ----------------------------------- */

const normalizeTitle = (t) => String(t || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
const wireRes = await fetch(`${BASE}/v1/ufc/wire?limit=20`, { headers: { Accept: "application/json" } });
assert(wireRes.status === 200, `wire: expected HTTP 200, got ${wireRes.status}`);
assert(wireRes.headers.get("cache-control") === "public, max-age=15, s-maxage=30, stale-while-revalidate=120", `wire: unexpected cache policy ${wireRes.headers.get("cache-control")}`);
assert(wireRes.headers.get("access-control-allow-origin") === "*", "wire: CORS must stay *");
const wire = await wireRes.json();
assert(wire?.ok === true && Array.isArray(wire.data) && wire.data.length > 0, "wire: expected attributed rows");
assert(wire.data.length <= 20, "wire: limit not honoured");
for (const item of wire.data) {
  for (const k of ["id", "title", "published_at", "summary", "taxonomy", "taxonomy_detail", "source", "source_url", "fighter_ids", "event_id", "bout_id", "internal_url"]) {
    assert(k in item, `wire: item ${item.id} missing ${k}`);
  }
  assert(item.title && item.source?.name && /^https?:\/\//.test(item.source_url || ""), `wire: attribution missing on ${item.id}`);
  assert(item.internal_url === null || /^\/(news|fights|events|fighters)\//.test(item.internal_url), `wire: bad internal_url ${item.internal_url}`);
  assert(item.taxonomy === null || typeof item.taxonomy === "string", "wire: taxonomy must be the first label string or null");
}
const wireStamps = wire.data.map((i) => i.published_at).filter(Boolean);
assert(wireStamps.join("|") === [...wireStamps].sort().reverse().join("|"), "wire: items must be newest first");
const wireKeys = wire.data.map((i) => normalizeTitle(i.title));
assert(new Set(wireKeys).size === wireKeys.length, "wire: duplicate normalized titles returned");
assert(!Number.isNaN(Date.parse(wire.meta?.generated_at)), "wire: meta.generated_at must parse");
assert(Math.abs(Date.now() - Date.parse(wire.meta.generated_at)) < 10 * 60 * 1000, "wire: generated_at is not recent");
for (const k of ["newest_published_at", "count", "freshness_minutes", "fight_week", "live"]) assert(k in wire.meta, `wire: meta missing ${k}`);
assert(wire.meta.count === wire.data.length, "wire: meta.count mismatch");
assert(wire.meta.newest_published_at === (wireStamps[0] || null), "wire: newest_published_at mismatch");
assert(typeof wire.meta.live === "boolean" && typeof wire.meta.fight_week === "boolean", "wire: live/fight_week must be booleans");
assert(wire.meta.live === (wire.meta.freshness_minutes !== null && wire.meta.freshness_minutes <= 120), "wire: live must follow the 120-minute freshness rule");
const wireSmall = await get("/v1/ufc/wire?limit=3");
assert(wireSmall.data.length <= 3 && wireSmall.meta.limit === 3, "wire: limit=3 not honoured");
const wireClamp = await get("/v1/ufc/wire?limit=999");
assert(wireClamp.meta.limit === 50, "wire: limit must clamp to 50");
const wireLinked = wire.data.filter((i) => i.internal_url);
for (const item of wireLinked.slice(0, 3)) {
  // internal_url must point at an entity we actually have
  if (item.internal_url.startsWith("/events/")) {
    const ev = await get(`/v1/ufc/events/${encodeURIComponent(item.event_id)}`);
    assert(ev.data.id === item.event_id, `wire: event link ${item.internal_url} not resolvable`);
  } else if (item.internal_url.startsWith("/news/")) {
    const art = await get(`/v1/ufc/articles/${encodeURIComponent(item.internal_url.replace("/news/", ""))}`);
    assert(art.data.slug, `wire: article link ${item.internal_url} not resolvable`);
  } else if (item.internal_url.startsWith("/fights/")) {
    const bt = await get(`/v1/ufc/bouts/${encodeURIComponent(item.bout_id)}`);
    assert(bt.data.id === item.bout_id, `wire: fight link ${item.internal_url} not resolvable`);
  } else if (item.internal_url.startsWith("/fighters/")) {
    const fid = item.internal_url.match(/-([0-9a-z]{6,20})$/)?.[1];
    const f = await get(`/v1/ufc/fighters/${encodeURIComponent(fid)}`);
    assert(f.data.id === item.fighter_ids[0], `wire: fighter link ${item.internal_url} not resolvable`);
  }
}

/* ---- Fight DNA (docs/fight_dna_api.md), production-safe --------------- */

const DNA_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=900";
const DNA_TIERS = ["low", "medium", "high"];
const NOCHE_EVENT_ID = "1d0b22df-81e7-4e5b-8fa5-8e5d03c24c52"; // Noche UFC: Silva vs. Delgado, 2026-09-12
const notes = [];
const dnaState = { schema: null, populated: null, strickland_as_of: null, zero_fighter: null, matchup: null, query_rows: null, splits: null };

async function getRaw(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { res, body, text };
}

function isMetricObject(m, label) {
  assert(m && typeof m === "object", `${label}: MetricObject expected`);
  for (const k of ["metric_key", "value", "unit", "sample_bouts", "sample_rounds", "sample_seconds", "confidence", "coverage_status", "definition_version", "origin"]) {
    assert(k in m, `${label}: MetricObject missing ${k}`);
  }
  assert(["insufficient", ...DNA_TIERS].includes(m.confidence), `${label}: confidence ${m.confidence} invalid`);
  assert(m.origin === "pbe_derived", `${label}: origin must be pbe_derived`);
  if (m.value === null) assert(m.confidence === "insufficient" || m.sample_seconds === 0 || m.sample_bouts === 0, `${label}: null value must be insufficient / zero-sample`);
}

const dnaMetrics = await getRaw("/v1/ufc/dna/metrics");
if (dnaMetrics.res.status === 503 && dnaMetrics.body?.error?.code === "dna_not_available") {
  assert(dnaMetrics.body.data === null && dnaMetrics.body.error.detail?.reason === "schema_not_applied", "dna metrics: 503 must carry data:null + schema_not_applied");
  dnaState.schema = false;
  notes.push("DNA: migration 004 is not applied on production (503 dna_not_available); DNA assertions skipped.");
} else {
  assert(dnaMetrics.res.status === 200, `dna metrics: expected 200 or 503, got ${dnaMetrics.res.status}; ${dnaMetrics.text.slice(0, 200)}`);
  assert(dnaMetrics.res.headers.get("cache-control") === DNA_CACHE, `dna metrics: cache policy ${dnaMetrics.res.headers.get("cache-control")}`);
  assert(dnaMetrics.res.headers.get("access-control-allow-origin") === "*", "dna metrics: CORS must be *");
  const d = dnaMetrics.body.data;
  assert(Array.isArray(d.metrics) && d.families && typeof d.families === "object" && d.confidence_tiers && d.origin_labels?.pbe_derived === "PBE DERIVED", "dna metrics: shape broken");
  assert(d.metrics.every((m) => m.active === true && m.public === true && m.metric_key && m.family && m.formula && Number.isInteger(m.min_bouts) && m.origin === "pbe_derived"), "dna metrics: registry row shape broken");
  assert(Object.values(d.families).flat().length === d.metrics.length, "dna metrics: families must partition metrics");
  dnaState.schema = true;
  if (!d.metrics.length) notes.push("DNA: metric registry table exists but is empty.");
}

if (dnaState.schema) {
  const s = await getRaw("/v1/ufc/fighters/0d8011111be000b2/dna");
  if (s.res.status === 404 && s.body?.error?.code === "dna_not_available") {
    assert(s.body.data === null, "fighter dna: 404 must carry data:null");
    dnaState.populated = false;
    notes.push("DNA: tables applied but no snapshot for Sean Strickland yet (404 dna_not_available); fighter/matchup/query DNA assertions skipped.");
  } else if (s.res.status === 503) {
    dnaState.populated = false;
    notes.push("DNA: ufc_fighter_dna_snapshots not applied yet (503); fighter/matchup/query DNA assertions skipped.");
  } else {
    assert(s.res.status === 200, `fighter dna: expected 200, got ${s.res.status}; ${s.text.slice(0, 200)}`);
    assert(s.res.headers.get("cache-control") === DNA_CACHE, "fighter dna: cache policy");
    dnaState.populated = true;
    const snap = s.body.data.snapshot;
    assert(s.body.data.fighter?.name === "Sean Strickland" && "primary_image" in s.body.data.fighter && "stance" in s.body.data.fighter, "fighter dna: compact fighter broken");
    for (const k of ["as_of_date", "definition_version", "sample_bouts", "sample_stat_bouts", "sample_rounds", "sample_seconds", "coverage_status", "metrics", "stance_splits", "round_profile", "finish_profile", "context_splits", "position_profile", "provenance"]) {
      assert(k in snap, `fighter dna: snapshot missing ${k}`);
    }
    assert(snap.origin === "pbe_derived", "fighter dna: origin");
    for (const [k, m] of Object.entries(snap.metrics)) isMetricObject(m, `fighter dna metrics.${k}`);
    assert(s.body.meta.resolved_as_of === snap.as_of_date && s.body.meta.requested_as_of === null && /exclusive/.test(s.body.meta.as_of_semantics), "fighter dna: meta as_of fields broken");
    dnaState.strickland_as_of = snap.as_of_date;
    const sameDay = await get(`/v1/ufc/fighters/0d8011111be000b2/dna?as_of=${snap.as_of_date}`);
    assert(sameDay.data.snapshot.as_of_date === snap.as_of_date && sameDay.meta.requested_as_of === snap.as_of_date, "fighter dna: as_of <= must resolve the same snapshot");
    const tooEarly = await get("/v1/ufc/fighters/0d8011111be000b2/dna?as_of=1990-01-01", 404);
    assert(tooEarly.error.code === "dna_not_available" && tooEarly.data === null && tooEarly.error.detail?.reason === "no_snapshot_at_or_before_as_of", "fighter dna: as_of before any snapshot must be explicit");
    const badAsOf = await get("/v1/ufc/fighters/0d8011111be000b2/dna?as_of=nope", 400);
    assert(badAsOf.error.code === "invalid_as_of", "fighter dna: invalid as_of not rejected");

    // family routes
    const rp = await get("/v1/ufc/fighters/0d8011111be000b2/round-profile");
    assert(["ok", "insufficient_coverage"].includes(rp.data.status) && rp.data.sample && "sample_stat_bouts" in rp.data.sample, "round-profile: shape broken");
    assert(rp.data.available ? rp.data.round_profile !== null : rp.data.round_profile === null, "round-profile: available/null disagree");
    const fp = await get("/v1/ufc/fighters/0d8011111be000b2/finish-profile");
    assert(["ok", "insufficient_coverage"].includes(fp.data.status), "finish-profile: status");
    const pp = await get("/v1/ufc/fighters/0d8011111be000b2/position-profile");
    assert(pp.data.available ? pp.data.status === "ok" && pp.data.origin === "licensed" : pp.data.status === "licensed_data_not_available" && pp.data.position_profile === null && /licensed/.test(pp.data.note), "position-profile: unavailable shape broken");

    // splits
    const splits = await getRaw("/v1/ufc/fighters/0d8011111be000b2/splits?opponent_stance=SOUTHPAW");
    if (splits.res.status === 404) notes.push("DNA: no stance split rows for Strickland yet (404 dna_not_available).");
    else {
      assert(splits.res.status === 200, `splits: expected 200, got ${splits.res.status}`);
      assert(splits.body.data.opponent_stance === "SOUTHPAW" && "split" in splits.body.data, "splits: shape broken");
      const sp = splits.body.data.split;
      if (sp) {
        assert(sp.record.w + sp.record.l + sp.record.d + sp.record.nc === sp.appearances, "splits: record must reconcile to appearances");
        assert(sp.ko_tko_wins + sp.submission_wins + sp.decision_wins === sp.wins, "splits: win methods must reconcile to wins");
        for (const [k, m] of Object.entries(sp.metrics)) isMetricObject(m, `splits.metrics.${k}`);
        dnaState.splits = { appearances: sp.appearances, confidence: sp.confidence };
      } else dnaState.splits = null;
    }
    const badStance = await get("/v1/ufc/fighters/0d8011111be000b2/splits?opponent_stance=karate", 400);
    assert(badStance.error.code === "invalid_stance", "splits: unknown stance not rejected");

    // zero-coverage fighter: explicit nulls, never zeros
    const q0 = await get("/v1/ufc/dna/query?metric=sig_landed_per_min&min_confidence=insufficient&order=asc&limit=200");
    assert(q0.meta.mode === "snapshot" && Array.isArray(q0.data), "dna query: shape broken");
    const zeroRow = q0.data.find((r) => r.metric?.value === null && r.sample?.sample_stat_bouts === 0);
    if (!zeroRow) notes.push("DNA: no zero-coverage fighter found among the first 200 query rows; explicit-null assertion skipped.");
    else {
      const z = await get(`/v1/ufc/fighters/${zeroRow.fighter.id}/dna`);
      const zs = z.data.snapshot;
      assert(zs.sample_stat_bouts === 0 && zs.sample_seconds === 0, "zero coverage: sample must be zero");
      for (const [k, m] of Object.entries(zs.metrics)) {
        if (["per_min", "per_15", "seconds_per_td"].includes(m.unit) || /share|accuracy|defense|retention/.test(k)) {
          assert(m.value === null && m.confidence === "insufficient", `zero coverage: ${k} must be null + insufficient, got ${m.value}/${m.confidence}`);
        }
      }
      const zr = await get(`/v1/ufc/fighters/${zeroRow.fighter.id}/round-profile`);
      assert(zr.data.status === "insufficient_coverage" && zr.data.available === false, "zero coverage: round-profile must be explicitly unavailable");
      assert(zr.data.round_profile === null || JSON.stringify(zr.data.round_profile).includes("\"value\":null"), "zero coverage: a stored round_profile may only hold null-valued metrics");
      dnaState.zero_fighter = zeroRow.fighter.name;
    }

    // north-star query
    const q = await get("/v1/ufc/dna/query?metric=pace_retention_r3_vs_r1&min=0.9&min_confidence=low&limit=20");
    assert(q.meta.metric === "pace_retention_r3_vs_r1" && q.meta.min === 0.9 && Array.isArray(q.meta.filter?.value) && typeof q.meta.truncated === "boolean", "dna query: meta broken");
    assert(q.data.every((r) => r.metric.value >= 0.9 && DNA_TIERS.includes(r.metric.confidence) && r.fighter.id && r.as_of_date), "dna query: a row violates the filter");
    dnaState.query_rows = q.data.length;
    const qBad = await get("/v1/ufc/dna/query?metric=bad%20key", 400);
    assert(qBad.error.code === "invalid_metric", "dna query: invalid metric not rejected");
  }
}

/* ---- Noche UFC card: matchup DNA + Fight State Ledger ------------------ */

let cardEvent = await getRaw(`/v1/ufc/events/${NOCHE_EVENT_ID}/card`);
if (cardEvent.res.status !== 200) {
  notes.push("Noche UFC 2026-09-12 card not resolvable; using the next upcoming event instead.");
  cardEvent = await getRaw(`/v1/ufc/events/${encodeURIComponent(upcomingId)}/card`);
}
assert(cardEvent.res.status === 200 && Array.isArray(cardEvent.body?.data?.bouts), "matchup card: could not load a card");
const isNoche = cardEvent.body.data.event.id === NOCHE_EVENT_ID;
const mainEvent = [...cardEvent.body.data.bouts].sort((a, b) => (b.bout_order ?? 0) - (a.bout_order ?? 0)).find((b) => b.fighter_a?.id && b.fighter_b?.id);
assert(mainEvent, "matchup card: no bout with two fighters");

if (dnaState.populated) {
  const m = await getRaw(`/v1/ufc/matchups/${mainEvent.fighter_a.id}/${mainEvent.fighter_b.id}/dna`);
  if (m.res.status === 404 && m.body?.error?.code === "dna_not_available") {
    assert(m.body.data === null, "matchup dna: 404 must carry data:null");
    notes.push(`DNA: neither ${mainEvent.fighter_a.name} nor ${mainEvent.fighter_b.name} has a snapshot yet; matchup assertions skipped.`);
  } else {
    assert(m.res.status === 200, `matchup dna: expected 200, got ${m.res.status}; ${m.text.slice(0, 200)}`);
    const d = m.body.data;
    const rules = m.body.meta.insight_rules;
    assert(d.fighters.length === 2 && d.comparisons.length === 18 && Array.isArray(d.insights) && Array.isArray(d.warnings) && Array.isArray(d.bettors_edge_evidence), "matchup dna: shape broken");
    assert(d.comparisons.every((c) => "a" in c && "b" in c && "delta" in c && "direction" in c && (c.comparable ? typeof c.delta === "number" : c.delta === null && c.direction === null)), "matchup dna: comparison invariants broken");
    for (const i of d.insights) {
      assert(DNA_TIERS.includes(i.confidence), `matchup dna: insight ${i.key} emitted with confidence ${i.confidence}`);
      assert(typeof i.explanation === "string" && i.explanation.length > 20 && i.origin === "pbe_derived", `matchup dna: insight ${i.key} lacks a template explanation`);
      if (/_vs_[a-z_]+_(record|finish_rate)$/.test(i.key)) assert(i.sample_bouts >= rules.stance_history.min_appearances || i.key.endsWith("finish_rate"), `matchup dna: ${i.key} below the ${rules.stance_history.min_appearances}-appearance threshold`);
      if (/pace_retention_r3_vs_r1$/.test(i.key)) assert(i.sample_bouts >= rules.pace_retention.min_bouts, `matchup dna: ${i.key} below the ${rules.pace_retention.min_bouts}-bout threshold`);
      if (i.key.endsWith("_mismatch")) {
        assert(i.samples && DNA_TIERS.includes(i.samples.a.confidence) && DNA_TIERS.includes(i.samples.b.confidence), `matchup dna: ${i.key} emitted with an insufficient side`);
        const cmp = d.comparisons.find((c) => `${c.key}_mismatch` === i.key);
        assert(cmp && Math.abs(cmp.delta) >= cmp.min_abs_delta, `matchup dna: ${i.key} below its magnitude threshold`);
      }
    }
    assert(d.bettors_edge_evidence.length === d.insights.length && d.bettors_edge_evidence.every((e) => e.origin_label === "PBE DERIVED" && typeof e.sample === "string"), "matchup dna: evidence must mirror insights");
    assert(!/\b(pick|probability|implied|fair price)\b/i.test(JSON.stringify(d.bettors_edge_evidence)), "matchup dna: evidence must not read as a pick");
    assert(/not a pick/.test(d.note), "matchup dna: note missing");
    assert(m.body.meta.resolved_as_of && "a" in m.body.meta.resolved_as_of && "b" in m.body.meta.resolved_as_of, "matchup dna: meta.resolved_as_of missing");
    dnaState.matchup = { a: mainEvent.fighter_a.name, b: mainEvent.fighter_b.name, insights: d.insights.length, warnings: d.warnings.length, comparable: m.body.meta.comparable };
  }
}

const ledgerState = { schema: null, main_event_rows: null, ad_hoc: null, intelligence_bouts: null, with_ledger: null, unavailable_sources: null };
const ledger = await getRaw(`/v1/ufc/bouts/${mainEvent.id}/ledger`);
if (ledger.res.status === 503 && ledger.body?.error?.code === "ledger_not_available") {
  ledgerState.schema = false;
  notes.push("Ledger: migration 005 is not applied on production (503 ledger_not_available); ledger assertions skipped.");
} else {
  assert(ledger.res.status === 200, `bout ledger: expected 200, got ${ledger.res.status}; ${ledger.text.slice(0, 200)}`);
  assert(ledger.res.headers.get("cache-control") === DNA_CACHE, "bout ledger: cache policy");
  ledgerState.schema = true;
  const L = ledger.body.data;
  assert(L.bout?.id === mainEvent.id && Array.isArray(L.snapshots) && Array.isArray(L.diffs), "bout ledger: shape broken");
  assert(L.card_shock?.status === "not_computed" && L.card_shock?.reason === "card_shock_engine_not_built", "bout ledger: card_shock placeholder broken");
  assert(L.diffs.length === Math.max(0, L.snapshots.length - 1), "bout ledger: one diff per consecutive pair");
  const stamps = L.snapshots.map((s) => s.captured_at);
  assert(stamps.join("|") === [...stamps].sort().reverse().join("|"), "bout ledger: snapshots must be newest first");
  for (const s of L.snapshots) {
    for (const k of ["checkpoint", "captured_at", "bout_state", "fighters", "rankings", "dna", "weigh_in", "wire", "odds", "market", "model", "result", "provenance"]) assert(k in s, `bout ledger: snapshot missing ${k}`);
    for (const src of ["weigh_in", "odds", "market", "model"]) assert(typeof s[src]?.status === "string", `bout ledger: ${src}.status missing`);
  }
  for (const df of L.diffs) assert(Array.isArray(df.changed) && Array.isArray(df.changes) && df.changed.length === df.changes.length && df.newer?.captured_at > df.older?.captured_at, "bout ledger: diff shape broken");
  assert(ledger.body.meta.append_only === true && ledger.body.meta.checkpoints && typeof ledger.body.meta.diff_rules === "string", "bout ledger: meta broken");
  ledgerState.main_event_rows = L.snapshots.length;
  ledgerState.ad_hoc = L.snapshots.filter((s) => s.checkpoint === "ad_hoc").length;
  if (isNoche) assert(ledgerState.ad_hoc >= 1, "bout ledger: the Noche UFC main event must have at least one ad_hoc baseline row");

  const intel = await getRaw(`/v1/ufc/events/${cardEvent.body.data.event.id}/intelligence`);
  assert(intel.res.status === 200, `intelligence: expected 200, got ${intel.res.status}; ${intel.text.slice(0, 200)}`);
  const I = intel.body.data;
  assert(I.event?.id === cardEvent.body.data.event.id && Array.isArray(I.bouts), "intelligence: shape broken");
  assert(I.bouts.length === cardEvent.body.data.bouts.length, "intelligence: one row per card bout");
  assert(I.card_shock?.status === "not_computed" && intel.body.meta.card_shock?.reason === "card_shock_engine_not_built", "intelligence: card_shock placeholder broken");
  for (const b of I.bouts) {
    for (const k of ["bout", "ledger_status", "latest", "hours_to_start", "checkpoints", "snapshots", "has_dna", "wire_count", "result", "sources", "diff", "card_shock"]) assert(k in b, `intelligence: bout row missing ${k}`);
    assert(["ok", "no_checkpoint"].includes(b.ledger_status), "intelligence: ledger_status");
    if (b.latest) {
      assert(b.latest.checkpoint && b.latest.captured_at && typeof b.has_dna.a === "boolean" && typeof b.has_dna.b === "boolean", "intelligence: latest row broken");
      assert(["weigh_in", "odds", "market", "model"].every((s) => typeof b.sources[s] === "string"), "intelligence: sources broken");
      assert(typeof b.result?.status === "string", "intelligence: result.status missing");
      assert(b.diff === null || Array.isArray(b.diff.changed), "intelligence: diff broken");
    } else assert(b.latest === null && b.diff === null && b.has_dna.a === null, "intelligence: no_checkpoint row must be explicit nulls");
    assert(b.card_shock?.status === "not_computed", "intelligence: per-bout card_shock placeholder");
  }
  assert(Array.isArray(intel.body.meta.unavailable_sources) && intel.body.meta.checkpoints && Number.isInteger(intel.body.meta.bouts_with_ledger), "intelligence: meta broken");
  ledgerState.intelligence_bouts = I.bouts.length;
  ledgerState.with_ledger = intel.body.meta.bouts_with_ledger;
  ledgerState.unavailable_sources = intel.body.meta.unavailable_sources;
  if (isNoche) assert(ledgerState.with_ledger >= 1, "intelligence: Noche UFC must have ledger coverage");
}

/* ---- official videos (addendum sections 5-9), production-safe ---------- */

const videoState = { schema: null, rows: null, event_groups: null, fighter_rows: null };
const videos = await getRaw("/v1/ufc/videos?limit=20");
if (videos.res.status === 503 && videos.body?.error?.code === "videos_not_available") {
  videoState.schema = false;
  notes.push("Videos: migration 006 is not applied on production (503 videos_not_available); video assertions skipped.");
} else {
  assert(videos.res.status === 200 && Array.isArray(videos.body?.data) && videos.body.meta.published_only === true, `videos: bad response ${videos.res.status}`);
  videoState.schema = true;
  videoState.rows = videos.body.data.length;
  if (!videos.body.data.length) notes.push("Videos: ufc_videos holds no published rows yet; per-row video assertions skipped.");
  const stamps = videos.body.data.map((v) => v.published_at).filter(Boolean);
  assert(stamps.join("|") === [...stamps].sort().reverse().join("|"), "videos: must be newest first");
  for (const v of videos.body.data) {
    for (const k of ["id", "provider", "provider_video_id", "url", "embed_url", "thumbnail_url", "title", "published_at", "duration_sec", "embeddable", "video_type", "channel", "links", "resolver_confidence", "attribution"]) assert(k in v, `videos: ${v.id} missing ${k}`);
    assert(!("link_status" in v) && !("description" in v), "videos: link_status/description must not be exposed");
    if (v.provider === "youtube") assert(v.embed_url === `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.provider_video_id)}`, `videos: embed_url wrong for ${v.id}`);
    assert(/^YouTube · /.test(v.attribution) || v.provider !== "youtube", `videos: attribution ${v.attribution}`);
    assert(typeof v.channel?.verified === "boolean" && "name" in v.channel && Array.isArray(v.links?.fighter_ids), "videos: channel/links broken");
    assert(v.duration_sec === null || Number.isInteger(v.duration_sec), "videos: duration_sec must be integer or null");
  }
  const badType = await get("/v1/ufc/videos?type=vlog", 400);
  assert(badType.error.code === "invalid_type", "videos: unknown type not rejected");
  const evVideos = await get(`/v1/ufc/events/${encodeURIComponent(cardEvent.body.data.event.id)}/videos`);
  assert(Array.isArray(evVideos.data.videos) && Array.isArray(evVideos.data.groups) && evVideos.meta.order === "chronological", "event videos: shape broken");
  const evStamps = evVideos.data.videos.map((v) => v.published_at).filter(Boolean);
  assert(evStamps.join("|") === [...evStamps].sort().join("|"), "event videos: must be chronological");
  assert(evVideos.data.groups.every((g) => g.video_type && g.label && g.count === g.videos.length), "event videos: groups broken");
  videoState.event_groups = evVideos.data.groups.length;
  const fVideos = await get("/v1/ufc/fighters/0d8011111be000b2/videos");
  assert(fVideos.data.fighter?.id === strickland.data.id && Array.isArray(fVideos.data.videos), "fighter videos: shape broken");
  videoState.fighter_rows = fVideos.data.videos.length;
  const withVideos = await get("/v1/ufc/fighters/0d8011111be000b2?include=videos");
  assert(Array.isArray(withVideos.data.videos) && withVideos.data.videos.length <= 6 && withVideos.meta.videos === withVideos.data.videos.length, "fighter include=videos: broken");
  const cardVideos = await get(`/v1/ufc/events/${encodeURIComponent(cardEvent.body.data.event.id)}/card?include=videos`);
  assert(Array.isArray(cardVideos.data.videos) && cardVideos.data.videos.length <= 6, "card include=videos: broken");
  const evDetail = await get(`/v1/ufc/events/${encodeURIComponent(cardEvent.body.data.event.id)}?include=videos`);
  assert(Array.isArray(evDetail.data.videos), "event include=videos: broken");
  assert(!("videos" in strickland.data), "fighter detail default must not carry videos");
}
assert("attribution_text" in strickland.data.primary_image && "rights_label" in strickland.data.primary_image, "media: primary_image must carry the 006 rights fields");

/* ---- explicit unavailable states keep the null-data envelope ----------- */

const missing = await get("/v1/ufc/fighters/00000000-0000-4000-8000-000000000000", 404);
assert(missing?.ok === false && missing.data === null && missing.error?.code === "fighter_not_found", "404 envelope must carry data:null");

for (const n of notes) console.log(`NOTE: ${n}`);
console.log("UFC API LIVE SMOKE: PASS");
console.log(JSON.stringify({
  base: BASE,
  checks,
  dna: { ...dnaState, notes: notes.length },
  ledger: ledgerState,
  videos: videoState,
  api_version: index.data.version,
  counts: counts.data,
  media: { with: strickland.data.name, without: noMedia.name, list_with_media: list.meta.with_media },
  rankings: { store: rankings.meta.store, snapshot_date: rankings.data.snapshot_date, divisions: rankings.data.divisions.length },
  articles: { hero: heroArticle?.slug || null, plain: plainArticle?.slug || null },
  analysis: { list_with_analysis: news.meta.with_analysis, probe: analysisProbe.data.slug, has_analysis: analysisProbe.data.analysis !== null, story_class: analysisProbe.data.analysis?.story_class || null, word_count: analysisProbe.data.word_count, reading_minutes: analysisProbe.data.reading_minutes },
  wire: { count: wire.meta.count, linked: wireLinked.length, live: wire.meta.live, freshness_minutes: wire.meta.freshness_minutes, fight_week: wire.meta.fight_week, newest_published_at: wire.meta.newest_published_at },
  sample: { event_id: eventId, bout_id: boutId, fighter_id: fighterId, fighter_name: fighterName, upcoming_event_id: upcomingId },
}, null, 2));
