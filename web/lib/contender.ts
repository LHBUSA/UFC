import "server-only";
import { getAllEvents, getBoutCounts, getMainEvents, type Event, type Bout } from "@/lib/db";

export type ContenderEvent = Event & { season: number; week: number | null };
export type ContenderSeason = { season: number; year: number | null; events: ContenderEvent[] };
export type IngestFreshness = { worker: string; started_at: string | null; finished_at: string | null; status: string | null } | null;

const URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export function isDanaWhiteContenderSeries(name: string | null | undefined): boolean {
  return /dana white(?:'s|’s)? contender series|contender series/i.test(String(name || "")) && !/road to ufc/i.test(String(name || ""));
}

export function contenderSeason(name: string, eventDate?: string | null): number | null {
  const direct = name.match(/season\s*(\d{1,2})/i);
  if (direct) return Number(direct[1]);
  const year = eventDate ? Number(eventDate.slice(0, 4)) : NaN;
  /* DWCS Season 1 began in 2017 and has run one numbered season per year. */
  if (Number.isFinite(year) && year >= 2017 && year <= 2035) return year - 2016;
  return null;
}

export function contenderWeek(name: string): number | null {
  const hit = name.match(/week\s*(\d{1,2})/i);
  return hit ? Number(hit[1]) : null;
}

export async function getContenderSeries(): Promise<ContenderSeason[]> {
  const all = await getAllEvents();
  const rows: ContenderEvent[] = all
    .filter((e) => isDanaWhiteContenderSeries(e.name))
    .map((e) => ({ ...e, season: contenderSeason(e.name, e.event_date) || 0, week: contenderWeek(e.name) }))
    .filter((e) => e.season > 0)
    .sort((a, b) => String(a.event_date || "").localeCompare(String(b.event_date || "")));

  const grouped = new Map<number, ContenderEvent[]>();
  for (const event of rows) {
    const list = grouped.get(event.season) || [];
    list.push(event);
    grouped.set(event.season, list);
  }
  return [...grouped.entries()]
    .map(([season, events]) => ({ season, year: events[0]?.event_date ? Number(events[0].event_date.slice(0, 4)) : null, events }))
    .sort((a, b) => b.season - a.season);
}

export async function getContenderEventContext(events: ContenderEvent[]): Promise<{ counts: Map<string, number>; mains: Map<string, Bout> }> {
  const ids = events.map((e) => e.id);
  const [counts, mains] = await Promise.all([getBoutCounts(ids), getMainEvents(ids)]);
  return { counts, mains };
}

export async function getContenderFreshness(): Promise<IngestFreshness> {
  if (!URL || !KEY) return null;
  try {
    const headers: Record<string, string> = { apikey: KEY, Accept: "application/json" };
    if (KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${KEY}`;
    const query = new URLSearchParams({
      select: "worker,started_at,finished_at,status",
      worker: "eq.ufc-stats-ingest",
      order: "started_at.desc",
      limit: "1",
    });
    const res = await fetch(`${URL}/rest/v1/ufc_ingest_runs?${query.toString()}`, { headers, next: { revalidate: 60 } });
    if (!res.ok) return null;
    const rows = await res.json() as Array<NonNullable<IngestFreshness>>;
    return rows[0] || null;
  } catch {
    return null;
  }
}

export function expectedContenderSeasons(asOfYear = new Date().getUTCFullYear()): number[] {
  const latest = Math.max(1, asOfYear - 2016);
  return Array.from({ length: latest }, (_, i) => latest - i);
}
