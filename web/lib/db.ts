/* Server-only data access. PostgREST over fetch with the service-role key
 * (RLS has no anon policies by design). Every reader is wrapped so that a
 * missing env var, a table that does not exist yet, or a network failure
 * yields an EMPTY result and a server log line — never a thrown error, never
 * a 500, never a blank page. A fresh database renders the full shell with
 * intentional empty states. */
import "server-only";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const REVALIDATE = 300;

function headers(extra: Record<string, string> = {}) {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json", ...extra };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

export function dbConfigured(): boolean {
  return Boolean(URL_ && KEY);
}

async function rest<T>(path: string, fallback: T, opts: { count?: boolean } = {}): Promise<{ data: T; count: number | null }> {
  if (!dbConfigured()) return { data: fallback, count: null };
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      headers: headers(opts.count ? { Prefer: "count=exact" } : {}),
      next: { revalidate: REVALIDATE },
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
};
export type Event = {
  id: string; ufcstats_id: string | null; espn_event_id: string | null; name: string; event_date: string | null;
  venue: string | null; city: string | null; region: string | null; country: string | null; card_status: string;
};
export type Result = {
  bout_id: string; winner_id: string | null; method: string; method_raw: string; round: number | null; time_sec: number | null;
  time_format: string | null; referee: string | null; finish_detail: string | null; result_source: string; has_stats: boolean;
};
export type Bout = {
  id: string; ufcstats_id: string | null; espn_competition_id: string | null; event_id: string; weight_class: string | null;
  is_womens: boolean; is_title: boolean; scheduled_rounds: number | null; card_position: string | null; bout_order: number; status: string;
  fighter_a: Fighter; fighter_b: Fighter; result: Result | null;
};
export type Article = {
  id: string; slug: string; headline: string; dek: string | null; body_md: string; story_type: string; status: string;
  hero_image_ref: string | null; hero_credit: { author?: string; license?: string; source_url?: string } | null;
  event_id: string | null; bout_id: string | null; fighter_ids: string[]; published_at: string | null; updated_at: string;
};

const FIGHTER_COLS = "id,ufcstats_id,espn_athlete_id,name,nickname,dob,height_in,reach_in,weight_lbs,stance,record_w,record_l,record_d,record_nc,is_active";
const EVENT_COLS = "id,ufcstats_id,espn_event_id,name,event_date,venue,city,region,country,card_status";
const BOUT_SELECT = `id,ufcstats_id,espn_competition_id,event_id,weight_class,is_womens,is_title,scheduled_rounds,card_position,bout_order,status,` +
  `fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(${FIGHTER_COLS}),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(${FIGHTER_COLS}),` +
  `result:ufc_bout_results(bout_id,winner_id,method,method_raw,round,time_sec,time_format,referee,finish_detail,result_source,has_stats)`;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ---- events ----------------------------------------------------------- */
export async function getUpcomingEvents(limit = 6): Promise<Event[]> {
  return (await rest<Event[]>(`ufc_events?select=${EVENT_COLS}&event_date=gte.${today()}&order=event_date.asc&limit=${limit}`, [])).data;
}
export async function getNextEvent(): Promise<Event | null> {
  return (await getUpcomingEvents(1))[0] || null;
}
export async function getRecentEvents(limit = 6): Promise<Event[]> {
  return (await rest<Event[]>(`ufc_events?select=${EVENT_COLS}&event_date=lt.${today()}&order=event_date.desc&limit=${limit}`, [])).data;
}
export async function getAllEvents(): Promise<Event[]> {
  return (await rest<Event[]>(`ufc_events?select=${EVENT_COLS}&order=event_date.desc.nullslast&limit=1000`, [])).data;
}
export async function getEventsOnDate(date: string): Promise<Event[]> {
  return (await rest<Event[]>(`ufc_events?select=${EVENT_COLS}&event_date=eq.${date}`, [])).data;
}
export async function getEventBouts(eventId: string): Promise<Bout[]> {
  const rows = (await rest<Array<Omit<Bout, "result"> & { result: Result[] | Result | null }>>(`ufc_bouts?select=${BOUT_SELECT}&event_id=eq.${eventId}&order=bout_order.desc`, [])).data;
  return rows.map((b) => ({ ...b, result: Array.isArray(b.result) ? b.result[0] || null : b.result }));
}

/* ---- fighters --------------------------------------------------------- */
export async function getFighters(q = "", limit = 60): Promise<Fighter[]> {
  const filter = q ? `&name=ilike.*${encodeURIComponent(q.replace(/[%*,()]/g, " ").trim())}*` : "";
  return (await rest<Fighter[]>(`ufc_fighters?select=${FIGHTER_COLS}${filter}&order=name.asc&limit=${limit}`, [])).data;
}
export async function getFighterBySourceId(id: string): Promise<Fighter | null> {
  const rows = (await rest<Fighter[]>(`ufc_fighters?select=${FIGHTER_COLS}&or=(espn_athlete_id.eq.${id},ufcstats_id.eq.${id})&limit=1`, [])).data;
  return rows[0] || null;
}
export async function getFighterBouts(fighterId: string): Promise<Array<Bout & { event: Event }>> {
  const rows = (await rest<Array<Omit<Bout, "result"> & { result: Result[] | Result | null; event: Event }>>(
    `ufc_bouts?select=${BOUT_SELECT},event:ufc_events(${EVENT_COLS})&or=(fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId})&limit=200`, [])).data;
  return rows
    .map((b) => ({ ...b, result: Array.isArray(b.result) ? b.result[0] || null : b.result }))
    .sort((a, b) => String(b.event?.event_date || "").localeCompare(String(a.event?.event_date || "")));
}

/* ---- news ------------------------------------------------------------- */
const ARTICLE_COLS = "id,slug,headline,dek,body_md,story_type,status,hero_image_ref,hero_credit,event_id,bout_id,fighter_ids,published_at,updated_at";
export async function getArticles(limit = 20, storyType?: string): Promise<Article[]> {
  const t = storyType ? `&story_type=eq.${storyType}` : "";
  return (await rest<Article[]>(`ufc_articles?select=${ARTICLE_COLS}&status=eq.published${t}&order=published_at.desc&limit=${limit}`, [])).data;
}
export async function getArticleBySlug(slug: string): Promise<Article | null> {
  const rows = (await rest<Article[]>(`ufc_articles?select=${ARTICLE_COLS}&status=eq.published&slug=eq.${encodeURIComponent(slug)}&limit=1`, [])).data;
  return rows[0] || null;
}

/* ---- counts for the home strip --------------------------------------- */
export async function getCounts(): Promise<{ fighters: number | null; events: number | null; bouts: number | null; results: number | null }> {
  const [f, e, b, r] = await Promise.all([
    rest<unknown[]>("ufc_fighters?select=id&limit=1", [], { count: true }),
    rest<unknown[]>("ufc_events?select=id&limit=1", [], { count: true }),
    rest<unknown[]>("ufc_bouts?select=id&limit=1", [], { count: true }),
    rest<unknown[]>("ufc_bout_results?select=bout_id&limit=1", [], { count: true }),
  ]);
  return { fighters: f.count, events: e.count, bouts: b.count, results: r.count };
}
