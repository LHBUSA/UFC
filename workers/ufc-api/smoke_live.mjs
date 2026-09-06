const BASE = (process.env.UFC_API_BASE_URL || "https://ufc-api.propbetedge.ai").replace(/\/$/, "");

function assert(condition, message) {
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

const health = await get("/health");
assert(health?.ok === true, "health: ok != true");
assert(health?.data?.status === "ok", "health: status != ok");
assert(health?.data?.database_configured === true, "health: database not configured");

const counts = await get("/v1/ufc/counts");
assert(counts?.ok === true, "counts: ok != true");
for (const k of ["fighters", "events", "bouts", "results"]) {
  assert(Number.isInteger(counts?.data?.[k]) && counts.data[k] > 0, `counts: ${k} must be positive integer`);
}

const events = await get("/v1/ufc/events?status=all&limit=3");
assert(Array.isArray(events?.data) && events.data.length > 0, "events: expected rows");

const fighters = await get("/v1/ufc/fighters?limit=3");
assert(Array.isArray(fighters?.data) && fighters.data.length > 0, "fighters: expected rows");

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

const boutDetail = await get(`/v1/ufc/bouts/${encodeURIComponent(boutId)}`);
assert(boutDetail?.data?.id === boutId, "bout detail: id mismatch");

const boutStats = await get(`/v1/ufc/bouts/${encodeURIComponent(boutId)}/stats`);
assert(boutStats?.data?.bout?.id === boutId, "bout stats: bout id mismatch");
assert(Array.isArray(boutStats?.data?.rounds), "bout stats: rounds missing");

const fighter = await get(`/v1/ufc/fighters/${encodeURIComponent(fighterId)}`);
assert(fighter?.data?.id === fighterId, "fighter detail: id mismatch");

const history = await get(`/v1/ufc/fighters/${encodeURIComponent(fighterId)}/history?limit=5`);
assert(history?.data?.fighter?.id === fighterId, "fighter history: fighter id mismatch");
assert(Array.isArray(history?.data?.bouts), "fighter history: bouts missing");

const fighterStats = await get(`/v1/ufc/fighters/${encodeURIComponent(fighterId)}/stats`);
assert(fighterStats?.data?.fighter?.id === fighterId, "fighter stats: fighter id mismatch");
assert(fighterStats?.data?.career_snapshot && typeof fighterStats.data.career_snapshot === "object", "fighter stats: snapshot missing");

const query = encodeURIComponent(String(fighterName).split(/\s+/)[0].slice(0, 30));
const search = await get(`/v1/ufc/search?q=${query}&limit=3`);
assert(search?.ok === true && search?.data?.q, "search: invalid response");
assert(Array.isArray(search?.data?.fighters), "search: fighters missing");

const news = await get("/v1/ufc/news?limit=1");
assert(news?.ok === true && Array.isArray(news?.data), "news: expected array");

const rankings = await get("/v1/ufc/rankings", 501);
assert(rankings?.ok === false, "rankings: expected explicit unavailable error");
assert(rankings?.error?.code === "rankings_not_available", "rankings: unexpected error code");

console.log("UFC API LIVE SMOKE: PASS");
console.log(JSON.stringify({
  base: BASE,
  counts: counts.data,
  sample: { event_id: eventId, bout_id: boutId, fighter_id: fighterId, fighter_name: fighterName },
}, null, 2));
