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
};
export type Event = {
  id: string; ufcstats_id: string | null; espn_event_id: string | null; name: string; event_date: string | null;
  venue: string | null; city: string | null; region: string | null; country: string | null; card_status: string; is_ppv: boolean | null;
};
export type Result = {
  bout_id: string; winner_id: string | null; method: string; method_raw: string; round: number | null; time_sec: number | null;
  time_format: string | null; referee: string | null; finish_detail: string | null; result_source: string; has_stats: boolean;
  scorecards: Array<{ judge?: string; score?: string }> | null; judge_1: string | null; judge_2: string | null; judge_3: string | null;
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
};
export type NewsItem = {
  id: string; url: string | null; title: string; published_at: string | null; summary: string | null;
  taxonomy: { labels?: string[]; confidence?: number } | null; fighter_ids: string[]; event_id: string | null; bout_id: string | null;
  source: { name: string } | null;
};
export type FighterImage = { id: string; kind: string; r2_key: string; license: string | null; author: string | null; source_url: string | null; fighter_id: string | null };
export type RankingEntry = { rank: number; name: string; ufc_slug: string | null; fighter_id: string | null; change: number | null; is_new: boolean };
export type RankingDivision = { key: string; label: string; is_womens: boolean; is_p4p: boolean; champion: { name: string; ufc_slug: string | null; fighter_id: string | null } | null; entries: RankingEntry[] };
export type RankingsSnapshot = { captured_at: string; source_url: string; snapshot_date: string; divisions: RankingDivision[] };

const FIGHTER_COLS = "id,ufcstats_id,espn_athlete_id,name,nickname,dob,height_in,reach_in,weight_lbs,stance,record_w,record_l,record_d,record_nc,is_active," +
  "career_slpm,career_str_acc,career_sapm,career_str_def,career_td_avg,career_td_acc,career_td_def,career_sub_avg";
const EVENT_COLS = "id,ufcstats_id,espn_event_id,name,event_date,venue,city,region,country,card_status,is_ppv";
const RESULT_COLS = "bout_id,winner_id,method,method_raw,round,time_sec,time_format,referee,finish_detail,result_source,has_stats,scorecards,judge_1,judge_2,judge_3";
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

/* ---- images (Supabase Storage, licensed Wikimedia portraits) ---------- */
export function mediaUrl(key: string): string {
  return `${URL_}/storage/v1/object/public/${MEDIA_BUCKET}/${key}`;
}
export type PortraitSet = { portrait: string; card: string; thumb: string; license: string | null; author: string | null; source_url: string | null; id: string };
export function portraitSet(img: FighterImage): PortraitSet {
  const dir = img.r2_key.replace(/\/[^/]+$/, "");
  return { id: img.id, portrait: mediaUrl(img.r2_key), card: mediaUrl(`${dir}/card.jpg`), thumb: mediaUrl(`${dir}/thumb.jpg`), license: img.license, author: img.author, source_url: img.source_url };
}
export async function getImagesForFighters(ids: string[]): Promise<Map<string, PortraitSet>> {
  const m = new Map<string, PortraitSet>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 150) {
    const chunk = uniq.slice(i, i + 150);
    const rows = (await rest<FighterImage[]>(`ufc_images?select=id,kind,r2_key,license,author,source_url,fighter_id&kind=eq.wikimedia&fighter_id=in.(${chunk.join(",")})`, [], { revalidate: 3600 })).data;
    for (const r of rows) if (r.fighter_id && !m.has(r.fighter_id)) m.set(r.fighter_id, portraitSet(r));
  }
  return m;
}
export async function getImageById(id: string): Promise<PortraitSet | null> {
  const rows = (await rest<FighterImage[]>(`ufc_images?select=id,kind,r2_key,license,author,source_url,fighter_id&id=eq.${id}&limit=1`, [], { revalidate: 3600 })).data;
  return rows[0] ? portraitSet(rows[0]) : null;
}
export async function getImageCount(): Promise<number | null> {
  return (await rest<unknown[]>("ufc_images?select=id&kind=eq.wikimedia&limit=1", [], { count: true, revalidate: 3600 })).count;
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
const ARTICLE_COLS = "id,slug,headline,dek,body_md,story_type,status,hero_image_ref,hero_credit,event_id,bout_id,fighter_ids,published_at,updated_at,created_at";
export async function getArticles(limit = 20, storyType?: string, offset = 0): Promise<{ rows: Article[]; count: number | null }> {
  const t = storyType ? `&story_type=eq.${storyType}` : "";
  const r = await rest<Article[]>(`ufc_articles?select=${ARTICLE_COLS}&status=eq.published${t}&order=published_at.desc&limit=${limit}&offset=${offset}`, [], { count: true });
  return { rows: r.data, count: r.count };
}
export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const rows = (await rest<Article[]>(`ufc_articles?select=${ARTICLE_COLS}&status=eq.published&slug=eq.${encodeURIComponent(slug)}&limit=1`, [])).data;
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
export async function getNewsItems(limit = 12): Promise<NewsItem[]> {
  return (await rest<NewsItem[]>(`ufc_news_items?select=id,url,title,published_at,summary,taxonomy,fighter_ids,event_id,bout_id,source:ufc_news_sources(name)&order=published_at.desc.nullslast&limit=${limit}`, [], { revalidate: 600 })).data;
}

/* ---- counts for the home strip --------------------------------------- */
export async function getCounts(): Promise<{ fighters: number | null; events: number | null; bouts: number | null; results: number | null; rounds: number | null; articles: number | null }> {
  const [f, e, b, r, rs, a] = await Promise.all([
    rest<unknown[]>("ufc_fighters?select=id&limit=1", [], { count: true, revalidate: 3600 }),
    rest<unknown[]>("ufc_events?select=id&limit=1", [], { count: true, revalidate: 3600 }),
    rest<unknown[]>("ufc_bouts?select=id&limit=1", [], { count: true, revalidate: 3600 }),
    rest<unknown[]>("ufc_bout_results?select=bout_id&limit=1", [], { count: true, revalidate: 3600 }),
    rest<unknown[]>("ufc_bout_round_stats?select=bout_id&limit=1", [], { count: true, revalidate: 3600 }),
    rest<unknown[]>("ufc_articles?select=id&status=eq.published&limit=1", [], { count: true, revalidate: 600 }),
  ]);
  return { fighters: f.count, events: e.count, bouts: b.count, results: r.count, rounds: rs.count, articles: a.count };
}
