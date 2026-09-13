import "server-only";
import { getAllEvents, getBoutCounts, getMainEvents, type Event, type Bout } from "@/lib/db";
import { contenderIdentity, isDanaWhiteContenderSeries, type ContenderIdentity } from "@/lib/contenderIdentity";

export { contenderIdentity, isDanaWhiteContenderSeries, type ContenderIdentity };

export type ContenderEvent = Event & { identity: ContenderIdentity; season: number; week: number | null };
export type ContenderSeason = { season: number; year: number | null; events: ContenderEvent[] };
/* Contender Series Brazil is its own series. Its three ESPN episodes are not
 * weeks of numbered Season 2, even though they aired in the same summer. */
export type ContenderSpinoff = { key: "brazil"; label: string; year: number | null; events: ContenderEvent[] };
export type IngestFreshness = { worker: string; started_at: string | null; finished_at: string | null; status: string | null } | null;

const URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

/* Kept for callers that only need a season number. Brazil episodes have none. */
export function contenderSeason(name: string, eventDate?: string | null): number | null {
  return contenderIdentity(name, eventDate).season;
}

export function contenderWeek(name: string): number | null {
  return contenderIdentity(name).week;
}

async function contenderEvents(): Promise<ContenderEvent[]> {
  const all = await getAllEvents();
  return all
    .filter((e) => isDanaWhiteContenderSeries(e.name))
    .map((e) => {
      const identity = contenderIdentity(e.name, e.event_date);
      return { ...e, identity, season: identity.season || 0, week: identity.week };
    })
    /* Two Brazil episodes share a date; the episode/week number breaks the tie. */
    .sort((a, b) => String(a.event_date || "").localeCompare(String(b.event_date || ""))
      || ((a.identity.week ?? a.identity.episode ?? 0) - (b.identity.week ?? b.identity.episode ?? 0)));
}

export async function getContenderSeries(): Promise<ContenderSeason[]> {
  const rows = (await contenderEvents()).filter((e) => e.identity.series === "dwcs" && e.season > 0);
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

export async function getContenderSpinoffs(): Promise<ContenderSpinoff[]> {
  const events = (await contenderEvents()).filter((e) => e.identity.series === "brazil");
  if (!events.length) return [];
  return [{ key: "brazil", label: "Contender Series Brazil", year: events[0]?.event_date ? Number(events[0].event_date.slice(0, 4)) : null, events }];
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
