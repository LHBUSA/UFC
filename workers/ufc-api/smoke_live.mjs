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

/* ---- explicit unavailable states keep the null-data envelope ----------- */

const missing = await get("/v1/ufc/fighters/00000000-0000-4000-8000-000000000000", 404);
assert(missing?.ok === false && missing.data === null && missing.error?.code === "fighter_not_found", "404 envelope must carry data:null");

console.log("UFC API LIVE SMOKE: PASS");
console.log(JSON.stringify({
  base: BASE,
  checks,
  api_version: index.data.version,
  counts: counts.data,
  media: { with: strickland.data.name, without: noMedia.name, list_with_media: list.meta.with_media },
  rankings: { store: rankings.meta.store, snapshot_date: rankings.data.snapshot_date, divisions: rankings.data.divisions.length },
  articles: { hero: heroArticle?.slug || null, plain: plainArticle?.slug || null },
  wire: { count: wire.meta.count, linked: wireLinked.length, live: wire.meta.live, freshness_minutes: wire.meta.freshness_minutes, fight_week: wire.meta.fight_week, newest_published_at: wire.meta.newest_published_at },
  sample: { event_id: eventId, bout_id: boutId, fighter_id: fighterId, fighter_name: fighterName, upcoming_event_id: upcomingId },
}, null, 2));
