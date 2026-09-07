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
  /* When this aggregation ran. */
  lastChecked: string;
  /* When canonical data was last written. Different concept: during a
   * historical repair this moves constantly while coverage is recomputed
   * only on revalidation. */
  lastDataWrite: string | null;
};

export async function getArchiveCoverage(): Promise<ArchiveCoverage> {
  const notDwcs = "name=not.ilike.*Contender%20Series*&name=not.ilike.*Road%20to%20UFC*";
  /* Every number on this panel must describe the same set of events.
   * Previously only the event count excluded the Contender Series and Road to
   * UFC, while bouts, results and round rows counted everything, so the panel
   * read "798 UFC event records" beside a bout total that included hundreds of
   * bouts belonging to the 100 events it had just excluded. Two scopes in one
   * sentence is worse than either scope on its own. The inner join applies the
   * same filter all the way down. */
  /* PostgREST needs the filter keyed by the full embed path, so a one-level
   * embed and a two-level embed spell the same condition differently. */
  const onEvents = "ufc_events.name=not.ilike.*Contender%20Series*&ufc_events.name=not.ilike.*Road%20to%20UFC*";
  const onBoutEvents = "ufc_bouts.ufc_events.name=not.ilike.*Contender%20Series*&ufc_bouts.ufc_events.name=not.ilike.*Road%20to%20UFC*";
  const [events, bouts, results, roundRows, earliest, ufc1, lastWrite] = await Promise.all([
    count(`ufc_events?select=id&${notDwcs}`),
    count(`ufc_bouts?select=id,ufc_events!inner(name)&${onEvents}`),
    count(`ufc_bout_results?select=bout_id,ufc_bouts!inner(ufc_events!inner(name))&${onBoutEvents}`),
    count(`ufc_bout_round_stats?select=bout_id,ufc_bouts!inner(ufc_events!inner(name))&${onBoutEvents}`),
    rows<{ id: string; name: string; event_date: string | null }>(`ufc_events?select=id,name,event_date&${notDwcs}&order=event_date.asc.nullslast&limit=1`),
    rows<{ id: string; name: string; event_date: string | null }>("ufc_events?select=id,name,event_date&name=ilike.UFC%201%25&order=event_date.asc&limit=1"),
    /* When canonical data was last written, which is a different fact from
     * when coverage was last aggregated. During a historical repair the two
     * drift apart and conflating them hides an active backfill. */
    rows<{ captured_at: string }>("ufc_bout_round_stats?select=captured_at&order=captured_at.desc&limit=1"),
  ]);
  const ufc1Event = ufc1[0] || null;
  const ufc1Bouts = ufc1Event ? await count(`ufc_bouts?select=id&event_id=eq.${ufc1Event.id}`) : 0;
  return {
    events, bouts, results, roundRows,
    earliestEvent: earliest[0] || null,
    ufc1Event, ufc1Bouts,
    lastChecked: new Date().toISOString(),
    lastDataWrite: lastWrite[0]?.captured_at || null,
  };
}

/* ---- Year-by-year coverage --------------------------------------------- */
export type YearCoverage = { year: number; events: number; withBouts: number; bouts: number; results: number };

/* One request: every non-DWCS event with its bout count and result count,
 * aggregated per year. Lets the schedule/archive UI say "1997: 5 events
 * indexed, 0 cards loaded" instead of implying completeness. */
export async function getArchiveYearCoverage(): Promise<YearCoverage[]> {
  const notDwcs = "name=not.ilike.*Contender%20Series*&name=not.ilike.*Road%20to%20UFC*";
  const list = await rows<{ id: string; event_date: string | null; ufc_bouts: Array<{ count: number }> }>(
    `ufc_events?select=id,event_date,ufc_bouts(count)&${notDwcs}&event_date=not.is.null&order=event_date.asc&limit=5000`,
  );
  const byYear = new Map<number, YearCoverage>();
  for (const e of list) {
    const year = Number((e.event_date || "").slice(0, 4));
    if (!Number.isFinite(year) || year < 1993) continue;
    const bouts = Number(e.ufc_bouts?.[0]?.count || 0);
    const row = byYear.get(year) || { year, events: 0, withBouts: 0, bouts: 0, results: 0 };
    row.events += 1;
    if (bouts > 0) row.withBouts += 1;
    row.bouts += bouts;
    byYear.set(year, row);
  }
  return [...byYear.values()].sort((a, b) => b.year - a.year);
}

export type IngestFreshness = { worker: string; started_at: string | null; finished_at: string | null; status: string | null } | null;

/* Latest run of the production schedule/results ingest, for freshness stamps. */
export async function getIngestFreshness(worker = "ufc-stats-ingest"): Promise<IngestFreshness> {
  const list = await rows<NonNullable<IngestFreshness>>(`ufc_ingest_runs?select=worker,started_at,finished_at,status&worker=eq.${encodeURIComponent(worker)}&order=started_at.desc&limit=1`);
  return list[0] || null;
}
