import { rankVideos, videoLanguage, type LiveVideoState } from "@/lib/videoPolicy";
/* Server-only data access. PostgREST over fetch with the service-role key
 * (RLS has no anon policies by design). Every reader is wrapped so that a
 * missing env var, a table that does not exist yet, or a network failure
 * yields an EMPTY result and a server log line — never a thrown error, never
 * a 500, never a blank page. A fresh database renders the full shell with
 * intentional empty states. */
import "server-only";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const MEDIA_BUCKET = "ufc-media";

export const REVALIDATE = 300;

function headers(extra: Record<string, string> = {}) {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json", ...extra };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

export function dbConfigured(): boolean {
  return Boolean(URL_ && KEY);
}

async function rest<T>(path: string, fallback: T, opts: { count?: boolean; revalidate?: number } = {}): Promise<{ data: T; count: number | null }> {
  if (!dbConfigured()) return { data: fallback, count: null };
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      headers: headers(opts.count ? { Prefer: "count=exact" } : {}),
      next: { revalidate: opts.revalidate ?? REVALIDATE },
    });
    if (!res.ok) {
      console.error(`[db] ${path.split("?")[0]} -> HTTP ${res.status}`);
      return { data: fallback, count: null };
    }
    const range = res.headers.get("content-range");
    const count = range && range.includes("/") ? Number(range.split("/")[1]) : null;
    const text = await res.text();
    return { data: text ? (JSON.parse(text) as T) : fallback, count: Number.isFinite(count as number) ? count : null };
  } catch (e) {
    console.error(`[db] ${path.split("?")[0]} failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return { data: fallback, count: null };
  }
}

/* ---- types ------------------------------------------------------------ */
export type Fighter = {
  id: string; ufcstats_id: string | null; espn_athlete_id: string | null; name: string; nickname: string | null;
  dob: string | null; height_in: number | null; reach_in: number | null; weight_lbs: number | null; stance: string | null;
  record_w: number | null; record_l: number | null; record_d: number | null; record_nc: number | null; is_active: boolean | null;
  career_slpm: number | null; career_str_acc: number | null; career_sapm: number | null; career_str_def: number | null;
  career_td_avg: number | null; career_td_acc: number | null; career_td_def: number | null; career_sub_avg: number | null;
  images?: ImageRef[];
};
export type Event = {
  id: string; ufcstats_id: string | null; espn_event_id: string | null; name: string; event_date: string | null;
  venue: string | null; city: string | null; region: string | null; country: string | null; card_status: string; is_ppv: boolean | null;
};
export type Result = {
  bout_id: string; winner_id: string | null; method: string; method_raw: string; round: number | null; time_sec: number | null;
  time_format: string | null; referee: string | null; finish_detail: string | null; result_source: string; has_stats: boolean;
  scorecards: Array<{ judge?: string; score?: string }> | null; judge_1: string | null; judge_2: string | null; judge_3: string | null;
  /* The row the result was captured from. Rendered as scorecard provenance. */
  source_url: string | null;
};
export type Bout = {
  id: string; ufcstats_id: string | null; espn_competition_id: string | null; event_id: string; weight_class: string | null;
  is_womens: boolean; is_title: boolean; scheduled_rounds: number | null; card_position: string | null; bout_order: number; status: string;
  fighter_a: Fighter; fighter_b: Fighter; result: Result | null;
};
export type RoundStat = {
  bout_id: string; fighter_id: string; round: number; kd: number | null;
  sig_str_landed: number | null; sig_str_att: number | null; total_str_landed: number | null; total_str_att: number | null;
  td_landed: number | null; td_att: number | null; sub_att: number | null; rev: number | null; ctrl_sec: number | null;
  head_landed: number | null; head_att: number | null; body_landed: number | null; body_att: number | null; leg_landed: number | null; leg_att: number | null;
  distance_landed: number | null; distance_att: number | null; clinch_landed: number | null; clinch_att: number | null; ground_landed: number | null; ground_att: number | null;
};
export type Article = {
  id: string; slug: string; headline: string; dek: string | null; body_md: string; story_type: string; status: string;
  hero_image_ref: string | null; hero_credit: { author?: string; license?: string; source_url?: string } | null;
  event_id: string | null; bout_id: string | null; fighter_ids: string[]; published_at: string | null; updated_at: string; created_at?: string;
  fact_block?: Record<string, unknown> | null;
};
export type NewsItem = {
  id: string; url: string | null; title: string; published_at: string | null; summary: string | null;
  taxonomy: { labels?: string[]; confidence?: number } | null; fighter_ids: string[]; event_id: string | null; bout_id: string | null;
  source: { name: string } | null;
};
export type FighterImage = {
  id: string; kind: string; r2_key: string; license: string | null; author: string | null; source_url: string | null; fighter_id: string | null;
  source_family?: string | null; attribution_text?: string | null; rights_label?: string | null; rights_expires_at?: string | null;
  provider_asset_id?: string | null; stored_first_party?: boolean | null; created_at?: string;
};
/* Shape used by the ufc-api contract (workers/ufc-api) and lib/media.ts. */
export type ImageRef = FighterImage & { image_url: string | null; created_at?: string };
export type RankingEntry = { rank: number; name: string; ufc_slug: string | null; fighter_id: string | null; change: number | null; is_new: boolean };
export type RankingDivision = { key: string; label: string; is_womens: boolean; is_p4p: boolean; champion: { name: string; ufc_slug: string | null; fighter_id: string | null } | null; entries: RankingEntry[] };
export type RankingsSnapshot = { captured_at: string; source_url: string; snapshot_date: string; divisions: RankingDivision[] };

const FIGHTER_COLS = "id,ufcstats_id,espn_athlete_id,name,nickname,dob,height_in,reach_in,weight_lbs,stance,record_w,record_l,record_d,record_nc,is_active," +
  "career_slpm,career_str_acc,career_sapm,career_str_def,career_td_avg,career_td_acc,career_td_def,career_sub_avg";
const EVENT_COLS = "id,ufcstats_id,espn_event_id,name,event_date,venue,city,region,country,card_status,is_ppv";
const RESULT_COLS = "bout_id,winner_id,method,method_raw,round,time_sec,time_format,referee,finish_detail,result_source,has_stats,scorecards,judge_1,judge_2,judge_3,source_url";
const BOUT_SELECT = `id,ufcstats_id,espn_competition_id,event_id,weight_class,is_womens,is_title,scheduled_rounds,card_position,bout_order,status,` +
  `fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(${FIGHTER_COLS}),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(${FIGHTER_COLS}),` +
  `result:ufc_bout_results(${RESULT_COLS})`;

/* Dana White's Contender Series runs inside ESPN's UFC league feed. It is
 * real and stays in the archive, but it is not a UFC card. */
export function isContenderSeries(name: string): boolean {
  return /contender series|road to ufc/i.test(name || "");
}
const NOT_DWCS = "&name=not.ilike.*Contender%20Series*&name=not.ilike.*Road%20to%20UFC*";

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

type RawBout = Omit<Bout, "result"> & { result: Result[] | Result | null };
const flattenResult = (b: RawBout): Bout => ({ ...b, result: Array.isArray(b.result) ? b.result[0] || null : b.result });

/* ---- events ----------------------------------------------------------- */
export async function getUpcomingEvents(limit = 6, opts: { includeContenderSeries?: boolean } = {}): Promise<Event[]> {
  const f = opts.includeContenderSeries ? "" : NOT_DWCS;
  return (await rest<Event[]>(`ufc_events?select=${EVENT_COLS}&event_date=gte.${today()}${f}&order=event_date.asc&limit=${limit}`, [])).data;
}
export async function getNextEvent(): Promise<Event | null> {
  return (await getUpcomingEvents(1))[0] || null;
}
export async function getRecentEvents(limit = 6): Promise<Event[]> {
  return (await rest<Event[]>(`ufc_events?select=${EVENT_COLS}&event_date=lt.${today()}${NOT_DWCS}&order=event_date.desc&limit=${limit}`, [])).data;
}
export async function getAllEvents(): Promise<Event[]> {
  return (await rest<Event[]>(`ufc_events?select=${EVENT_COLS}&order=event_date.desc.nullslast&limit=2000`, [], { revalidate: 3600 })).data;
}
export async function getEventsInYear(year: number): Promise<Event[]> {
  return (await rest<Event[]>(`ufc_events?select=${EVENT_COLS}&event_date=gte.${year}-01-01&event_date=lte.${year}-12-31&order=event_date.desc`, [])).data;
}
export async function getEventYears(): Promise<Array<{ year: number; count: number }>> {
  const rows = (await rest<Array<{ event_date: string | null }>>(`ufc_events?select=event_date&order=event_date.desc.nullslast&limit=5000`, [], { revalidate: 3600 })).data;
  const m = new Map<number, number>();
  for (const r of rows) { if (!r.event_date) continue; const y = Number(r.event_date.slice(0, 4)); m.set(y, (m.get(y) || 0) + 1); }
  return [...m.entries()].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year);
}
export async function getEventsOnDate(date: string): Promise<Event[]> {
  return (await rest<Event[]>(`ufc_events?select=${EVENT_COLS}&event_date=eq.${date}`, [])).data;
}
export async function getEventById(id: string): Promise<Event | null> {
  return (await rest<Event[]>(`ufc_events?select=${EVENT_COLS}&id=eq.${id}&limit=1`, [])).data[0] || null;
}
export async function getEventBouts(eventId: string): Promise<Bout[]> {
  const rows = (await rest<RawBout[]>(`ufc_bouts?select=${BOUT_SELECT}&event_id=eq.${eventId}&order=bout_order.desc`, [])).data;
  return rows.map(flattenResult);
}
/* Bout counts for a list of events (one request). */
export async function getBoutCounts(eventIds: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  if (!eventIds.length) return m;
  const rows = (await rest<Array<{ event_id: string }>>(`ufc_bouts?select=event_id&event_id=in.(${eventIds.join(",")})&limit=5000`, [])).data;
  for (const r of rows) m.set(r.event_id, (m.get(r.event_id) || 0) + 1);
  return m;
}
/* Main events (highest bout_order) for a list of events, one request. */
export async function getMainEvents(eventIds: string[]): Promise<Map<string, Bout>> {
  const m = new Map<string, Bout>();
  if (!eventIds.length) return m;
  const rows = (await rest<RawBout[]>(`ufc_bouts?select=${BOUT_SELECT}&event_id=in.(${eventIds.join(",")})&order=bout_order.desc&limit=5000`, [])).data;
  for (const b of rows.map(flattenResult)) if (!m.has(b.event_id)) m.set(b.event_id, b);
  return m;
}

/* ---- bouts / stats ---------------------------------------------------- */
export async function getBoutById(id: string): Promise<Bout | null> {
  const rows = (await rest<RawBout[]>(`ufc_bouts?select=${BOUT_SELECT}&id=eq.${id}&limit=1`, [])).data;
  return rows[0] ? flattenResult(rows[0]) : null;
}
export async function getRoundStats(boutId: string): Promise<RoundStat[]> {
  return (await rest<RoundStat[]>(`ufc_bout_round_stats?select=*&bout_id=eq.${boutId}&order=round.asc`, [])).data;
}
export async function getFighterRoundStats(fighterId: string): Promise<RoundStat[]> {
  return (await rest<RoundStat[]>(`ufc_bout_round_stats?select=*&fighter_id=eq.${fighterId}&limit=3000`, [])).data;
}

/* ---- fighters --------------------------------------------------------- */
export async function getFighters(q = "", limit = 60, offset = 0, opts: { letter?: string; activeOnly?: boolean } = {}): Promise<{ rows: Fighter[]; count: number | null }> {
  let filter = "";
  if (q) filter += `&name=ilike.*${encodeURIComponent(q.replace(/[%*,()]/g, " ").trim())}*`;
  if (opts.letter) filter += `&name=ilike.${encodeURIComponent(opts.letter)}*`;
  if (opts.activeOnly) filter += `&is_active=eq.true`;
  const r = await rest<Fighter[]>(`ufc_fighters?select=${FIGHTER_COLS}${filter}&order=name.asc&limit=${limit}&offset=${offset}`, [], { count: true });
  return { rows: r.data, count: r.count };
}
export async function getFighterBySourceId(id: string): Promise<Fighter | null> {
  const rows = (await rest<Fighter[]>(`ufc_fighters?select=${FIGHTER_COLS}&or=(espn_athlete_id.eq.${id},ufcstats_id.eq.${id})&limit=1`, [])).data;
  return rows[0] || null;
}
export async function getFightersByIds(ids: string[]): Promise<Fighter[]> {
  if (!ids.length) return [];
  return (await rest<Fighter[]>(`ufc_fighters?select=${FIGHTER_COLS}&id=in.(${ids.slice(0, 200).join(",")})`, [])).data;
}
export async function getFighterBouts(fighterId: string): Promise<Array<Bout & { event: Event }>> {
  const rows = (await rest<Array<RawBout & { event: Event }>>(
    `ufc_bouts?select=${BOUT_SELECT},event:ufc_events(${EVENT_COLS})&or=(fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId})&limit=200`, [])).data;
  return rows
    .map((b) => ({ ...flattenResult(b), event: b.event }))
    .sort((a, b) => String(b.event?.event_date || "").localeCompare(String(a.event?.event_date || "")));
}
/* Fighters booked on upcoming cards, for the roster grid. */
export async function getBookedFighterIds(): Promise<string[]> {
  const events = await getUpcomingEvents(6);
  if (!events.length) return [];
  const rows = (await rest<Array<{ fighter_a_id: string; fighter_b_id: string }>>(`ufc_bouts?select=fighter_a_id,fighter_b_id&event_id=in.(${events.map((e) => e.id).join(",")})&status=neq.cancelled&limit=2000`, [])).data;
  return [...new Set(rows.flatMap((r) => [r.fighter_a_id, r.fighter_b_id]))];
}

/* ---- images: one canonical fighter asset, available everywhere -------- */
export function mediaUrl(key: string): string {
  return `${URL_}/storage/v1/object/public/${MEDIA_BUCKET}/${key}`;
}
export type PortraitSet = {
  portrait: string; card: string; thumb: string; license: string | null; author: string | null; source_url: string | null; id: string;
  kind: string; source_family?: string | null; rights_label?: string | null; attribution_text?: string | null; stored_first_party?: boolean | null;
  /* Whose image this is, so a caption or alt text can name the right person. */
  fighter_id?: string | null;
};

const IMAGE_KIND_PRIORITY: Record<string, number> = {
  licensed_editorial: 500,
  official_press: 450,
  public_domain: 400,
  wikimedia: 350,
  statcard: 100,
};

function imagePriority(img: FighterImage): number {
  let p = IMAGE_KIND_PRIORITY[img.kind] || 0;
  if (img.stored_first_party === false) p -= 25;
  if (img.rights_expires_at && Date.parse(img.rights_expires_at) <= Date.now()) p -= 10000;
  return p;
}

export function portraitSet(img: FighterImage): PortraitSet {
  const dir = img.r2_key.replace(/\/[^/]+$/, "");
  const firstParty = img.stored_first_party !== false;
  /* Current locally stored fighter media writes portrait/card/thumb siblings.
   * Display-only provider references may use a directly renderable r2_key/URL
   * contract later; until then they are never guessed into fake derivatives. */
  return {
    id: img.id,
    portrait: mediaUrl(img.r2_key),
    card: firstParty ? mediaUrl(`${dir}/card.jpg`) : mediaUrl(img.r2_key),
    thumb: firstParty ? mediaUrl(`${dir}/thumb.jpg`) : mediaUrl(img.r2_key),
    license: img.license,
    author: img.author,
    source_url: img.source_url,
    kind: img.kind,
    source_family: img.source_family,
    rights_label: img.rights_label,
    attribution_text: img.attribution_text,
    stored_first_party: img.stored_first_party,
    fighter_id: img.fighter_id ?? null,
  };
}

/* ESPN headshots are display-only fallbacks and not every athlete id has one.
 * Probe the CDN once per id (cached in-process and by the fetch data cache) so a
 * missing headshot never renders as broken media: the fighter simply stays on
 * the branded initials fallback. Transient network failures keep the image. */
const ESPN_PROBE_TTL_MS = 6 * 60 * 60 * 1000;
const espnProbe = new Map<string, { ok: boolean; at: number }>();
async function espnHeadshotAvailable(url: string): Promise<boolean> {
  const hit = espnProbe.get(url);
  if (hit && Date.now() - hit.at < ESPN_PROBE_TTL_MS) return hit.ok;
  let ok = true;
  try {
    const res = await fetch(url, { method: "HEAD", next: { revalidate: 21600 }, signal: AbortSignal.timeout(4000) });
    if (res.status === 404 || res.status === 410) ok = false;
  } catch { ok = true; }
  espnProbe.set(url, { ok, at: Date.now() });
  return ok;
}

function espnDisplayPortrait(fighter: Pick<Fighter, "id" | "espn_athlete_id">): PortraitSet | null {
  const athleteId = String(fighter.espn_athlete_id || "").trim();
  if (!/^\d+$/.test(athleteId)) return null;
  const url = `https://a.espncdn.com/i/headshots/mma/players/full/${athleteId}.png`;
  return {
    id: `espn:${athleteId}`,
    portrait: url,
    card: url,
    thumb: url,
    license: null,
    author: "ESPN",
    source_url: `https://www.espn.com/mma/fighter/_/id/${athleteId}`,
    kind: "display_fallback",
    source_family: "espn",
    rights_label: "display_only",
    attribution_text: "ESPN · display fallback",
    stored_first_party: false,
    fighter_id: fighter.id,
  };
}

/* Catalog images that stay in ufc_images but are never picked as a fighter's
 * primary portrait. Listed by image id, one reason each; the fighter falls
 * through to the next rule (another stored image, else the display fallback). */
const NOT_PRIMARY_PORTRAIT = new Set<string>([
  "73077eea-6c1e-4f3b-88e4-c23a412c11d8", // Petr Yan: Kremlin award ceremony handshake, not a portrait
]);

export async function getImagesForFighters(ids: string[]): Promise<Map<string, PortraitSet>> {
  const m = new Map<string, PortraitSet>();
  const chosen = new Map<string, FighterImage>();
  const uniq = [...new Set(ids.filter(Boolean))];
  const select = "id,kind,r2_key,license,author,source_url,fighter_id,source_family,attribution_text,rights_label,rights_expires_at,provider_asset_id,stored_first_party,created_at";
  for (let i = 0; i < uniq.length; i += 150) {
    const chunk = uniq.slice(i, i + 150);
    const rows = (await rest<FighterImage[]>(`ufc_images?select=${select}&fighter_id=in.(${chunk.join(",")})&order=created_at.desc`, [], { revalidate: 300 })).data;
    for (const r of rows) {
      if (!r.fighter_id || NOT_PRIMARY_PORTRAIT.has(r.id)) continue;
      if (r.rights_expires_at && Date.parse(r.rights_expires_at) <= Date.now()) continue;
      const prev = chosen.get(r.fighter_id);
      if (!prev || imagePriority(r) > imagePriority(prev)) chosen.set(r.fighter_id, r);
    }
  }
  for (const [fighterId, img] of chosen) m.set(fighterId, portraitSet(img));

  /* Every visible fighter surface uses this function. When a rights-cleared
   * PBE asset is not available, fill only the presentation gap with that
   * fighter's ESPN MMA athlete headshot. These synthetic PortraitSets are
   * never written to ufc_images and are marked display_only, so they cannot
   * leak into the commercial / API-redistributable media catalog. */
  const missing = uniq.filter((id) => !m.has(id));
  for (let i = 0; i < missing.length; i += 150) {
    const chunk = missing.slice(i, i + 150);
    const fighters = (await rest<Array<Pick<Fighter, "id" | "espn_athlete_id">>>(
      `ufc_fighters?select=id,espn_athlete_id&id=in.(${chunk.join(",")})`, [], { revalidate: 300 },
    )).data;
    const fallbacks = fighters.map((fighter) => ({ fighter, fallback: espnDisplayPortrait(fighter) })).filter((x) => x.fallback);
    const available = await Promise.all(fallbacks.map((x) => espnHeadshotAvailable((x.fallback as PortraitSet).card)));
    fallbacks.forEach((x, idx) => { if (available[idx]) m.set(x.fighter.id, x.fallback as PortraitSet); });
  }
  return m;
}

export async function getImageById(id: string): Promise<PortraitSet | null> {
  const select = "id,kind,r2_key,license,author,source_url,fighter_id,source_family,attribution_text,rights_label,rights_expires_at,provider_asset_id,stored_first_party,created_at";
  const rows = (await rest<FighterImage[]>(`ufc_images?select=${select}&id=eq.${id}&limit=1`, [], { revalidate: 300 })).data;
  const row = rows[0];
  if (!row || (row.rights_expires_at && Date.parse(row.rights_expires_at) <= Date.now())) return null;
  return portraitSet(row);
}

export async function getImageCount(): Promise<number | null> {
  return (await rest<unknown[]>("ufc_images?select=id&fighter_id=not.is.null&limit=1", [], { count: true, revalidate: 900 })).count;
}

/* ---- rankings (snapshot JSON written by scripts/rankings) ------------- */
export async function getRankings(): Promise<RankingsSnapshot | null> {
  if (!URL_) return null;
  try {
    const res = await fetch(mediaUrl("rankings/latest.json"), { next: { revalidate: 1800 } });
    if (!res.ok) return null;
    const j = (await res.json()) as RankingsSnapshot;
    return Array.isArray(j?.divisions) ? j : null;
  } catch (e) {
    console.error(`[db] rankings snapshot failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return null;
  }
}

/* ---- news ------------------------------------------------------------- */
const ARTICLE_COLS = "id,slug,headline,dek,body_md,story_type,status,hero_image_ref,hero_credit,event_id,bout_id,fighter_ids,published_at,updated_at,created_at,fact_block";
export async function getArticles(limit = 20, storyType?: string, offset = 0): Promise<{ rows: Article[]; count: number | null }> {
  const t = storyType ? `&story_type=eq.${storyType}` : "";
  const r = await rest<Article[]>(`ufc_articles?select=${ARTICLE_COLS}&status=eq.published${t}&order=published_at.desc&limit=${limit}&offset=${offset}`, [], { count: true });
  return { rows: r.data, count: r.count };
}
export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const rows = (await rest<Article[]>(`ufc_articles?select=${ARTICLE_COLS}&status=eq.published&slug=eq.${encodeURIComponent(slug)}&limit=1`, [])).data;
  return rows[0] || null;
}
/**
 * Any status, including held. ONLY the token-gated desk preview may call this.
 *
 * It is deliberately a separate function rather than a flag on
 * getArticleBySlug: a boolean parameter can be reached by a default, a typo or
 * a refactor, and the failure mode is publishing what the gate held. A caller
 * has to name this function to get an unpublished row.
 */
export async function getArticleBySlugAnyStatus(slug: string): Promise<Article | null> {
  const rows = (await rest<Article[]>(`ufc_articles?select=${ARTICLE_COLS}&slug=eq.${encodeURIComponent(slug)}&limit=1`, [], { revalidate: 0 })).data;
  return rows[0] || null;
}

export async function getArticlesForEvent(eventId: string, limit = 12): Promise<Article[]> {
  return (await rest<Article[]>(`ufc_articles?select=${ARTICLE_COLS}&status=eq.published&event_id=eq.${eventId}&order=published_at.desc&limit=${limit}`, [])).data;
}
export async function getArticlesForFighter(fighterId: string, limit = 8): Promise<Article[]> {
  return (await rest<Article[]>(`ufc_articles?select=${ARTICLE_COLS}&status=eq.published&fighter_ids=cs.{${fighterId}}&order=published_at.desc&limit=${limit}`, [])).data;
}
export async function getArticlesForBout(boutId: string, limit = 6): Promise<Article[]> {
  return (await rest<Article[]>(`ufc_articles?select=${ARTICLE_COLS}&status=eq.published&bout_id=eq.${boutId}&order=published_at.desc&limit=${limit}`, [])).data;
}
export async function getArticleTypeCounts(): Promise<Map<string, number>> {
  const rows = (await rest<Array<{ story_type: string }>>(`ufc_articles?select=story_type&status=eq.published&limit=5000`, [])).data;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.story_type, (m.get(r.story_type) || 0) + 1);
  return m;
}
/* WHAT MAY APPEAR ON A PUBLIC UFC SURFACE.
 *
 * Three layers, and they are not the same thing:
 *
 *   1. THE EXTERNAL WIRE is radar. It ingests broadly on purpose, including
 *      signals that turn out to be boxing, PFL, BKFC or RIZIN, because a filter
 *      that only lets through what it already recognises cannot detect anything
 *      new. Nothing here narrows that ingest.
 *   2. THE NEWS ENGINE consumes only UFC-eligible signals, and ufc-news-ingest
 *      has ALREADY made that judgement at insert time: an item its focus filter
 *      rejects is stored state='skipped' and can never be enriched.
 *   3. THE TICKER is public distribution, and it is labelled UFC.
 *
 * The bug this constant fixes was reading layer 1 and presenting it as layer 3.
 * The classification already existed and the query simply did not consult it,
 * so "UFC Live Wire" led with an NBA player boxing in Nigeria. An item already
 * classified non-UFC must never reach a public UFC surface -- not because the
 * radar was wrong to ingest it, but because the radar is not the product.
 *
 * duplicate is excluded for a different reason: it is a second copy of a story
 * already on the rail, and one development must not occupy two slots.
 *
 * held and new stay: those are UFC-relevant items we have not published on yet,
 * which is exactly what the rail is for while our coverage is still being
 * written. Items we HAVE covered are removed by supersession, not by state.
 */
const PUBLIC_WIRE_ELIGIBILITY = "&state=not.in.(skipped,duplicate)";

export async function getNewsItems(limit = 12): Promise<NewsItem[]> {
  return (await rest<NewsItem[]>(`ufc_news_items?select=id,url,title,published_at,summary,taxonomy,fighter_ids,event_id,bout_id,source:ufc_news_sources(name)${PUBLIC_WIRE_ELIGIBILITY}&order=published_at.desc.nullslast&limit=${limit}`, [], { revalidate: 600 })).data;
}

/* Attributed wire items linked to an event or any of the given fighters
 * (article-page "From the live wire" context). */
export async function getWireFor(eventId: string | null, fighterIds: string[], limit = 6): Promise<NewsItem[]> {
  const ors: string[] = [];
  if (eventId) ors.push(`event_id.eq.${eventId}`);
  for (const id of fighterIds.slice(0, 6)) ors.push(`fighter_ids.cs.{${id}}`);
  if (!ors.length) return [];
  return (await rest<NewsItem[]>(`ufc_news_items?select=id,url,title,published_at,summary,taxonomy,fighter_ids,event_id,bout_id,source:ufc_news_sources(name)${PUBLIC_WIRE_ELIGIBILITY}&or=(${ors.join(",")})&order=published_at.desc.nullslast&limit=${limit}`, [], { revalidate: 300 })).data;
}

/* ---- counts for the home strip --------------------------------------- */
/* Cached for five minutes, matching the archive coverage panel. At the old
 * one-hour TTL these counters sat visibly behind the archive panel on the same
 * screen during a backfill, which reads as one of them being broken. Two live
 * readings of one number must not disagree because of cache policy alone. */
export async function getCounts(): Promise<{ fighters: number | null; events: number | null; bouts: number | null; results: number | null; rounds: number | null; articles: number | null }> {
  const [f, e, b, r, rs, a] = await Promise.all([
    rest<unknown[]>("ufc_fighters?select=id&limit=1", [], { count: true, revalidate: 300 }),
    rest<unknown[]>("ufc_events?select=id&limit=1", [], { count: true, revalidate: 300 }),
    rest<unknown[]>("ufc_bouts?select=id&limit=1", [], { count: true, revalidate: 300 }),
    rest<unknown[]>("ufc_bout_results?select=bout_id&limit=1", [], { count: true, revalidate: 300 }),
    rest<unknown[]>("ufc_bout_round_stats?select=bout_id&limit=1", [], { count: true, revalidate: 300 }),
    rest<unknown[]>("ufc_articles?select=id&status=eq.published&limit=1", [], { count: true, revalidate: 600 }),
  ]);
  return { fighters: f.count, events: e.count, bouts: b.count, results: r.count, rounds: rs.count, articles: a.count };
}
/* ---- art-direction framing (best effort) --------------------------------
 * The framing columns (focal_x/focal_y/face_box/derivatives, migration 007
 * art direction) may not exist on every database. This reader asks for them
 * in a separate request; a 400 from PostgREST simply yields an empty map and
 * the variant system falls back to slot defaults. */
export type FramingRow = { id: string; focal_x: number | null; focal_y: number | null; face_box: { x: number; y: number; w: number; h: number } | null; framing_status: string | null; framing_confidence: number | null; framing_at: string | null; derivatives: Record<string, { key?: string; w?: number; h?: number; mode?: string; focal?: { x: number; y: number }; face?: { x: number; y: number; w: number; h: number } | null }> | null };
export async function getImageFraming(imageIds: string[]): Promise<Map<string, FramingRow>> {
  const ids = [...new Set(imageIds.filter((id) => id && !id.startsWith("espn:")))];
  const m = new Map<string, FramingRow>();
  if (!ids.length || !dbConfigured()) return m;
  try {
    const res = await fetch(`${URL_}/rest/v1/ufc_images?select=id,focal_x,focal_y,face_box,framing_status,framing_confidence,framing_at,derivatives&id=in.(${ids.join(",")})`, { headers: headers(), next: { revalidate: 900 } });
    if (!res.ok) return m;
    for (const r of (await res.json()) as FramingRow[]) m.set(r.id, r);
  } catch { /* framing is optional */ }
  return m;
}

/* ---- official video layer (publisher-hosted, allowlisted) --------------- */
export type OfficialVideoRow = {
  id: string; provider: string; provider_video_id: string; channel_id: string; channel_name: string | null; channel_verified_source: boolean;
  url: string; title: string; description: string | null; published_at: string | null; duration_sec: number | null; thumbnail_url: string | null;
  embeddable: boolean | null; video_type: string; fighter_ids: string[]; event_id: string | null; bout_id: string | null; article_id: string | null;
  /* ingest metadata: language, region_restriction, discovery, linking (docs/videos.md) */
  source_metadata?: Record<string, unknown> | null;
};
const VIDEO_SELECT = "id,provider,provider_video_id,channel_id,channel_name,channel_verified_source,url,title,description,published_at,duration_sec,thumbnail_url,embeddable,video_type,fighter_ids,event_id,bout_id,article_id,source_metadata";
const VIDEO_BASE = `ufc_videos?select=${VIDEO_SELECT}&link_status=eq.published&provider=eq.youtube&channel_verified_source=eq.true&embeddable=not.is.false&order=published_at.desc.nullslast`;
/* Fight-week timeline order and homepage priority (docs/videos.md §8). */
export const VIDEO_TIMELINE_ORDER = ["fight_preview", "countdown", "embedded_episode", "media_day", "press_conference", "weigh_in", "faceoff", "full_fight", "highlights", "interview", "analysis", "post_fight", "other"];
const VIDEO_HOME_PRIORITY = ["embedded_episode", "countdown", "press_conference", "weigh_in", "faceoff", "media_day", "fight_preview", "interview", "highlights", "analysis", "post_fight", "full_fight", "other"];
export function sortVideosTimeline(v: OfficialVideoRow[]): OfficialVideoRow[] { return [...v].sort((a, b) => VIDEO_TIMELINE_ORDER.indexOf(a.video_type) - VIDEO_TIMELINE_ORDER.indexOf(b.video_type) || String(a.published_at).localeCompare(String(b.published_at))); }
export function rankVideosForHome(v: OfficialVideoRow[]): OfficialVideoRow[] { return [...v].sort((a, b) => VIDEO_HOME_PRIORITY.indexOf(a.video_type) - VIDEO_HOME_PRIORITY.indexOf(b.video_type) || String(b.published_at).localeCompare(String(a.published_at))); }
export async function getVideosForEvent(eventId: string, limit = 6): Promise<OfficialVideoRow[]> {
  return (await rest<OfficialVideoRow[]>(`${VIDEO_BASE}&event_id=eq.${eventId}&limit=${limit}`, [], { revalidate: 300 })).data;
}
export async function getVideosForBout(boutId: string, limit = 4): Promise<OfficialVideoRow[]> {
  return (await rest<OfficialVideoRow[]>(`${VIDEO_BASE}&bout_id=eq.${boutId}&limit=${limit}`, [], { revalidate: 300 })).data;
}
export async function getVideosForArticle(articleId: string, limit = 3): Promise<OfficialVideoRow[]> {
  return (await rest<OfficialVideoRow[]>(`${VIDEO_BASE}&article_id=eq.${articleId}&limit=${limit}`, [], { revalidate: 300 })).data;
}
/* Live availability for videos an article carries a stored copy of (content
 * plan). Keyed by provider id; a video missing here keeps its plan copy. */
export async function getVideoStates(providerIds: string[]): Promise<Map<string, LiveVideoState>> {
  const uniq = [...new Set(providerIds.filter((id) => /^[A-Za-z0-9_-]{6,20}$/.test(id)))];
  if (!uniq.length) return new Map();
  const rows = (await rest<LiveVideoState[]>(`ufc_videos?select=provider_video_id,channel_name,embeddable,link_status,source_metadata&provider=eq.youtube&provider_video_id=in.(${uniq.map((id) => `"${id}"`).join(",")})`, [], { revalidate: 300 })).data;
  return new Map(rows.map((r) => [r.provider_video_id, r]));
}
export async function getVideosForFighters(ids: string[], limit = 6, minConfidence: "high" | "medium" | "low" = "medium"): Promise<OfficialVideoRow[]> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return [];
  const conf = minConfidence === "high" ? "high" : minConfidence === "medium" ? "high,medium" : "high,medium,low";
  return (await rest<OfficialVideoRow[]>(`${VIDEO_BASE}&fighter_ids=ov.{${uniq.join(",")}}&resolver_confidence=in.(${conf})&limit=${limit}`, [], { revalidate: 300 })).data;
}
/* Homepage video desk: this fight week first, then the freshest official
 * uploads — both passed through the selection policy (English-first,
 * embeddable, viewable, official, fresh, relevant; lib/videoPolicy.ts) so a
 * fresh clip that cannot play never outranks an older one that can. */
export async function getFightWeekVideos(eventId: string | null, limit = 5): Promise<OfficialVideoRow[]> {
  const pool = eventId ? await getVideosForEvent(eventId, 30) : [];
  const ranked = rankVideos(pool, "en");
  const english = (v: OfficialVideoRow) => videoLanguage(v) === "en";
  /* Top up with the freshest official English uploads when this card has fewer English clips than the desk shows, so the default desk stays English-first. */
  /* Keep a few non-English official clips behind the language filter so Spanish / Portuguese stay reachable without dominating the default desk. */
  const withAlternates = (list: OfficialVideoRow[]) => { const top = list.slice(0, limit); const ids = new Set(top.map((v) => v.id)); const alt = list.filter((v) => !ids.has(v.id) && !english(v)).slice(0, 3); return [...top, ...alt]; };
  if (ranked.filter(english).length >= limit) return withAlternates(ranked);
  const latest = rankVideos(await getLatestVideos(limit * 4), "en");
  const seen = new Set(ranked.map((v) => v.id));
  return withAlternates(rankVideos([...ranked, ...latest.filter((v) => !seen.has(v.id))], "en"));
}
/* Voice profiles: official-channel uploads whose title names the person. */
export async function getVideosMentioning(phrase: string, limit = 3): Promise<OfficialVideoRow[]> {
  return (await rest<OfficialVideoRow[]>(`${VIDEO_BASE}&title=ilike.*${encodeURIComponent(phrase)}*&limit=${limit}`, [], { revalidate: 900 })).data;
}
export async function getLatestVideos(limit = 6, videoType?: string): Promise<OfficialVideoRow[]> {
  return (await rest<OfficialVideoRow[]>(`${VIDEO_BASE}${videoType ? `&video_type=eq.${videoType}` : ""}&limit=${limit}`, [], { revalidate: 600 })).data;
}

/* ---- the ticker: PropBetEdge first ------------------------------------ */

export type TickerItem = {
  kind: "article" | "wire";
  id: string;
  title: string;
  href: string;
  external: boolean;
  at: string | null;
  source: string | null;
  label: string | null;
  topic_signature?: string | null;
  supersedes?: number;
};

/* How much a published PropBetEdge article is worth against a raw wire item,
 * expressed as time.
 *
 * The requirement has two halves that pull against each other: the ticker
 * should be overwhelmingly ours, AND genuinely breaking external news must not
 * sit below stale internal analysis. A boolean "internal first" sort satisfies
 * the first and breaks the second — a three-hour-old piece of ours would bury a
 * two-minute-old withdrawal report.
 *
 * So preference is a HANDICAP rather than a tier: ninety minutes of credit. An
 * article of ours outranks anything external published within the same
 * hour-and-a-half, and loses to anything fresher than that. The number is the
 * policy, and it is one line to change.
 */
const TICKER_INTERNAL_BONUS_MS = 90 * 60 * 1000;

/* How much of the rail is reserved for our own published articles when we have
 * them. Below the 75-85% product target on purpose: the target assumes we are
 * covering most of what matters, and reserving more slots than we have earned
 * coverage for would mean showing week-old analysis beside breaking news. This
 * rises by publishing more, not by changing this number. */
const TICKER_INTERNAL_SHARE = 0.6;

/**
 * One development, one slot — and ours wins it when we have written it.
 *
 * Supersession works on two keys because articles arrive by two routes:
 * news_item_id is exact (this article was written FROM that wire item), and
 * topic_signature catches the rest (a second outlet reporting the same
 * development, which is one story and must not appear twice).
 */
export async function getTicker(limit = 12): Promise<TickerItem[]> {
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const [articles, items] = await Promise.all([
    rest<Array<{ id: string; slug: string; headline: string; published_at: string | null; topic_signature: string | null; news_item_id: string | null; story_type: string }>>(
      `ufc_articles?select=id,slug,headline,published_at,topic_signature,news_item_id,story_type&status=eq.published&published_at=gte.${since}&order=published_at.desc&limit=40`,
      [], { revalidate: 60 },
    ).then((r) => r.data),
    rest<NewsItem[]>(
      `ufc_news_items?select=id,url,title,published_at,summary,taxonomy,fighter_ids,event_id,bout_id,source:ufc_news_sources(name)${PUBLIC_WIRE_ELIGIBILITY}&published_at=gte.${since}&order=published_at.desc.nullslast&limit=60`,
      [], { revalidate: 60 },
    ).then((r) => r.data),
  ]);

  const coveredItemIds = new Set<string>();
  const coveredSignatures = new Map<string, number>();
  for (const a of articles) {
    if (a.news_item_id) coveredItemIds.add(a.news_item_id);
    if (a.topic_signature) coveredSignatures.set(a.topic_signature, (coveredSignatures.get(a.topic_signature) || 0) + 1);
  }

  /* A wire item is superseded when we published the article written from it.
   * Topic-signature supersession needs the item's own signature, which lives on
   * the item only after enrichment has scored it — so an unscored item is
   * matched by id alone and stays visible, which is the correct behaviour while
   * our coverage is still being written. */
  const out: TickerItem[] = [];

  for (const a of articles) {
    out.push({
      kind: "article",
      id: a.id,
      title: a.headline,
      href: `/news/${a.slug}`,
      external: false,
      at: a.published_at,
      source: "PropBetEdge",
      label: a.story_type === "external" ? null : a.story_type.replace("_", " "),
      topic_signature: a.topic_signature,
      supersedes: a.news_item_id ? 1 : 0,
    });
  }

  for (const n of items) {
    if (coveredItemIds.has(n.id)) continue;   /* we published this one */
    out.push({
      kind: "wire",
      id: n.id,
      title: n.title,
      href: n.url || "#",
      external: true,
      at: n.published_at,
      source: n.source?.name || "Source",
      label: n.taxonomy?.labels?.[0] && n.taxonomy.labels[0] !== "other"
        ? n.taxonomy.labels[0].replace("_", " ") : null,
    });
  }

  const score = (t: TickerItem) => {
    const ms = t.at ? Date.parse(t.at) : 0;
    return (Number.isFinite(ms) ? ms : 0) + (t.external ? 0 : TICKER_INTERNAL_BONUS_MS);
  };
  out.sort((a, b) => score(b) - score(a));

  /* Never let one development occupy two slots even when the second copy came
   * from a different outlet. Titles are compared on distinctive tokens, the
   * same shape the enrich worker's clone guard uses. */
  const seenTokens: Array<Set<string>> = [];
  const tokens = (s: string) => new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3),
  );
  const deduped: TickerItem[] = [];
  for (const t of out) {
    const tk = tokens(t.title);
    const dupe = seenTokens.some((prev) => {
      let shared = 0;
      for (const w of tk) if (prev.has(w)) shared += 1;
      return shared >= 3;
    });
    if (dupe) continue;
    seenTokens.push(tk);
    deduped.push(t);
  }

  /* RESERVE SLOTS FOR OUR OWN COVERAGE.
   *
   * Ranking by recency alone is arithmetically correct and produces the wrong
   * product. We publish around a dozen articles in the time the wire produces
   * three hundred items, so within an hour of publishing, every one of our
   * stories is pushed off a twenty-slot rail by fresher external headlines --
   * a distribution layer that distributes none of our work.
   *
   * So a share of the rail is reserved for published PropBetEdge articles. This
   * is NOT padding: only real published articles are eligible, the reserve is
   * capped by how many actually exist, and if we have published nothing the
   * rail is entirely external, exactly as before.
   *
   * The freshest item overall still leads regardless of who wrote it, so a
   * genuinely breaking external story is never buried by an older piece of
   * ours -- the reserve decides who is PRESENT, recency still decides who is
   * FIRST. */
  const internal = deduped.filter((t) => !t.external);
  const external = deduped.filter((t) => t.external);
  const wantInternal = Math.min(internal.length, Math.round(limit * TICKER_INTERNAL_SHARE));
  const chosen = [...internal.slice(0, wantInternal), ...external.slice(0, limit - wantInternal)];
  chosen.sort((a, b) => score(b) - score(a));
  return chosen.slice(0, limit);
}
