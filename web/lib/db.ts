/* Server-only UFC API client.
 *
 * The website is intentionally a first-party client of the same read contract
 * we expose to PropSports customers and future MCP tools. Supabase service-role
 * credentials no longer belong in the web data layer. Every reader keeps the
 * existing fail-empty behavior so an API outage renders intentional empty
 * states rather than a white screen.
 */
import "server-only";

const API_BASE = (process.env.UFC_API_BASE_URL || "").replace(/\/$/, "");
const API_KEY = process.env.UFC_API_KEY || "";

export const REVALIDATE = 300;

export type ImageRef = {
  id: string;
  kind: "statcard" | "wikimedia" | string;
  r2_key: string;
  image_url: string | null;
  license: string | null;
  author: string | null;
  source_url: string | null;
  fighter_id: string | null;
  created_at: string;
};

export type Fighter = {
  id: string;
  ufcstats_id: string | null;
  espn_athlete_id: string | null;
  name: string;
  nickname: string | null;
  dob: string | null;
  height_in: number | null;
  reach_in: number | null;
  weight_lbs: number | null;
  stance: string | null;
  record_w: number | null;
  record_l: number | null;
  record_d: number | null;
  record_nc: number | null;
  is_active: boolean | null;
  career_slpm?: number | null;
  career_str_acc?: number | null;
  career_sapm?: number | null;
  career_str_def?: number | null;
  career_td_avg?: number | null;
  career_td_acc?: number | null;
  career_td_def?: number | null;
  career_sub_avg?: number | null;
  fight_history_count?: number | null;
  updated_at?: string;
  images?: ImageRef[];
};

export type Event = {
  id: string;
  ufcstats_id: string | null;
  espn_event_id: string | null;
  name: string;
  event_date: string | null;
  venue: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  commission?: string | null;
  is_ppv?: boolean | null;
  card_status: string;
  updated_at?: string;
};

export type Result = {
  bout_id: string;
  winner_id: string | null;
  method: string;
  method_raw: string;
  round: number | null;
  time_sec: number | null;
  time_format: string | null;
  referee: string | null;
  judge_1?: string | null;
  judge_2?: string | null;
  judge_3?: string | null;
  scorecards?: unknown;
  finish_detail: string | null;
  result_source: string;
  has_stats: boolean;
  captured_at?: string;
};

export type Bout = {
  id: string;
  ufcstats_id: string | null;
  espn_competition_id: string | null;
  event_id: string;
  weight_class: string | null;
  weight_class_raw?: string | null;
  is_womens: boolean;
  is_title: boolean;
  scheduled_rounds: number | null;
  card_position: string | null;
  bout_order: number;
  status: string;
  replaced_bout_id?: string | null;
  short_notice_days?: number | null;
  fighter_a: Fighter;
  fighter_b: Fighter;
  result: Result | null;
};

export type Article = {
  id: string;
  slug: string;
  headline: string;
  dek: string | null;
  body_md: string;
  story_type: string;
  status: string;
  hero_image_ref: string | null;
  hero_credit: { author?: string; license?: string; source_url?: string } | null;
  event_id: string | null;
  bout_id: string | null;
  fighter_ids: string[];
  published_at: string | null;
  updated_at: string;
  sources?: unknown;
  fact_block?: unknown;
  model_version?: string | null;
  needs_human?: boolean;
};

type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; detail?: unknown };
  meta?: Record<string, unknown>;
};

export function apiConfigured(): boolean {
  return Boolean(API_BASE);
}

// Kept as a compatibility alias for any older server code. It now means
// "UFC API configured", not "Supabase configured".
export function dbConfigured(): boolean {
  return apiConfigured();
}

function apiHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
  };
}

async function api<T>(path: string, fallback: T, revalidate = REVALIDATE): Promise<T> {
  if (!apiConfigured()) return fallback;
  try {
    const res = await fetch(`${API_BASE}/v1/ufc${path}`, {
      headers: apiHeaders(),
      next: { revalidate },
    });
    const text = await res.text();
    let payload: ApiEnvelope<T> | null = null;
    if (text) {
      try { payload = JSON.parse(text) as ApiEnvelope<T>; } catch { payload = null; }
    }
    if (!res.ok || !payload?.ok) {
      console.error(`[ufc-api] ${path.split("?")[0]} -> HTTP ${res.status} ${payload?.error?.code || "invalid_response"}`);
      return fallback;
    }
    return payload.data === undefined ? fallback : payload.data;
  } catch (e) {
    console.error(`[ufc-api] ${path.split("?")[0]} failed: ${String((e as Error)?.message || e).slice(0, 160)}`);
    return fallback;
  }
}

export async function getUpcomingEvents(limit = 6): Promise<Event[]> {
  return api<Event[]>(`/events?status=upcoming&limit=${limit}`, [], 60);
}

export async function getNextEvent(): Promise<Event | null> {
  return (await getUpcomingEvents(1))[0] || null;
}

export async function getRecentEvents(limit = 6): Promise<Event[]> {
  return api<Event[]>(`/events?status=recent&limit=${limit}`, [], 300);
}

export async function getAllEvents(): Promise<Event[]> {
  return api<Event[]>("/events?status=all&limit=1000", [], 300);
}

export async function getEventsOnDate(date: string): Promise<Event[]> {
  return api<Event[]>(`/events?date=${encodeURIComponent(date)}&limit=25`, [], 300);
}

export async function getEventBouts(eventId: string): Promise<Bout[]> {
  const out = await api<{ event: Event; bouts: Bout[] }>(`/events/${encodeURIComponent(eventId)}/card`, { event: null as unknown as Event, bouts: [] }, 60);
  return out.bouts || [];
}

export async function getFighters(q = "", limit = 60): Promise<Fighter[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (q) params.set("q", q);
  return api<Fighter[]>(`/fighters?${params.toString()}`, [], 300);
}

export async function getFighterBySourceId(id: string): Promise<Fighter | null> {
  return api<Fighter | null>(`/fighters/${encodeURIComponent(id)}`, null, 300);
}

export async function getFighterBouts(fighterId: string): Promise<Array<Bout & { event: Event }>> {
  const out = await api<{ fighter: Fighter; bouts: Array<Bout & { event: Event }> }>(
    `/fighters/${encodeURIComponent(fighterId)}/history?limit=200`,
    { fighter: null as unknown as Fighter, bouts: [] },
    300,
  );
  return out.bouts || [];
}

export async function getArticles(limit = 20, storyType?: string): Promise<Article[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (storyType) params.set("story_type", storyType);
  return api<Article[]>(`/news?${params.toString()}`, [], 120);
}

export async function getArticleBySlug(slug: string): Promise<Article | null> {
  return api<Article | null>(`/articles/${encodeURIComponent(slug)}`, null, 300);
}

export async function getCounts(): Promise<{ fighters: number | null; events: number | null; bouts: number | null; results: number | null }> {
  const out = await api<Record<string, number | null>>("/counts", {}, 60);
  return {
    fighters: out.fighters ?? null,
    events: out.events ?? null,
    bouts: out.bouts ?? null,
    results: out.results ?? null,
  };
}
