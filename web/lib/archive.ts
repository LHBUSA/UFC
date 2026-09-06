import "server-only";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function headers(extra: Record<string, string> = {}) {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json", ...extra };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

async function count(path: string): Promise<number> {
  if (!URL_ || !KEY) return 0;
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      headers: headers({ Prefer: "count=exact", Range: "0-0" }),
      next: { revalidate: 300 },
    });
    if (!res.ok) return 0;
    const range = res.headers.get("content-range") || "";
    const total = Number(range.split("/")[1]);
    return Number.isFinite(total) ? total : 0;
  } catch { return 0; }
}

async function rows<T>(path: string): Promise<T[]> {
  if (!URL_ || !KEY) return [];
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: headers(), next: { revalidate: 300 } });
    return res.ok ? await res.json() as T[] : [];
  } catch { return []; }
}

export type ArchiveCoverage = {
  events: number;
  bouts: number;
  results: number;
  roundRows: number;
  earliestEvent: { id: string; name: string; event_date: string | null } | null;
  ufc1Event: { id: string; name: string; event_date: string | null } | null;
  ufc1Bouts: number;
  lastChecked: string;
};

export async function getArchiveCoverage(): Promise<ArchiveCoverage> {
  const notDwcs = "name=not.ilike.*Contender%20Series*&name=not.ilike.*Road%20to%20UFC*";
  const [events, bouts, results, roundRows, earliest, ufc1] = await Promise.all([
    count(`ufc_events?select=id&${notDwcs}`),
    count("ufc_bouts?select=id"),
    count("ufc_bout_results?select=bout_id"),
    count("ufc_bout_round_stats?select=bout_id"),
    rows<{ id: string; name: string; event_date: string | null }>(`ufc_events?select=id,name,event_date&${notDwcs}&order=event_date.asc.nullslast&limit=1`),
    rows<{ id: string; name: string; event_date: string | null }>("ufc_events?select=id,name,event_date&name=ilike.UFC%201%25&order=event_date.asc&limit=1"),
  ]);
  const ufc1Event = ufc1[0] || null;
  const ufc1Bouts = ufc1Event ? await count(`ufc_bouts?select=id&event_id=eq.${ufc1Event.id}`) : 0;
  return { events, bouts, results, roundRows, earliestEvent: earliest[0] || null, ufc1Event, ufc1Bouts, lastChecked: new Date().toISOString() };
}
