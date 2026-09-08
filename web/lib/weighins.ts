import "server-only";
export type { WeighIn, WeighInSummary, WeighInResult, LimitBasis, SourceKind } from "./weighins-display";
export {
  RESULT_LABEL, RESULT_TONE, SOURCE_KIND_LABEL,
  weightCell, limitCell, deltaCell, classCell,
  sortForTable, isLive, freshness, updateLine, timelineKind, clockTime,
} from "./weighins-display";

/* Weigh-in read path.
 *
 * Reads ufc_weigh_in_current / _event_summary / _history, defined in
 * supabase/migrations/20260908000013_ufc_weigh_ins.sql. The migration is live
 * in production; readers still fail closed to an empty result if the data
 * plane is unavailable so a transient database problem never becomes a 500.
 *
 * REVALIDATE IS 15 SECONDS, and that number needs a caveat attached to it
 * wherever it is read: it bounds how stale THIS CACHE is, not how fresh the
 * data is. A browser polling every 15 seconds against a source fetched every
 * three minutes learns nothing new for most of those polls. Source cadence is
 * the real freshness, which is why the page shows last_source_update from the
 * database rather than the time it rendered.
 */

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function headers() {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json" };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

/** Short, because this is the live desk. See the caveat above. */
export const WEIGHIN_REVALIDATE = 15;

async function read<T>(path: string, fallback: T, revalidate = WEIGHIN_REVALIDATE): Promise<T> {
  if (!URL_ || !KEY) return fallback;
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: headers(), next: { revalidate } });
    if (!res.ok) {
      if (res.status !== 404) console.error(`[weighins] ${path.split("?")[0]} -> HTTP ${res.status}`);
      return fallback;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.error(`[weighins] ${path.split("?")[0]} failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return fallback;
  }
}

import type { WeighIn, WeighInSummary } from "./weighins-display";

export type WeighInHistoryRow = {
  id: string;
  event_id: string;
  bout_id: string | null;
  fighter_id: string;
  fighter_name: string;
  official_weight_lbs: number | null;
  attempt_number: number;
  result: WeighIn["result"];
  over_by_lbs: number | null;
  catchweight_lbs: number | null;
  limit_basis: WeighIn["limit_basis"];
  contracted_limit_lbs: number | null;
  allowance_lbs: number | null;
  weighed_at: string | null;
  source_url: string;
  source_name: string;
  source_kind: WeighIn["source_kind"];
  source_published_at: string | null;
  detected_at: string;
  first_seen_at: string;
  last_seen_at: string;
  supersedes_id: string | null;
  superseded_at: string | null;
  correction_reason: string | null;
  raw_text: string | null;
  occurred_at: string;
};

/** Current readings for one event, corrections applied. */
export async function getWeighIns(eventId: string): Promise<WeighIn[]> {
  return read<WeighIn[]>(
    `ufc_weigh_in_current?select=*&event_id=eq.${encodeURIComponent(eventId)}&order=bout_order.desc.nullslast,fighter_name.asc`,
    [],
  );
}

/** Header counters for one event. Counted in the database so they cannot drift
 *  from the rows underneath them. */
export async function getWeighInSummary(eventId: string): Promise<WeighInSummary | null> {
  const rows = await read<WeighInSummary[]>(
    `ufc_weigh_in_event_summary?select=*&event_id=eq.${encodeURIComponent(eventId)}&limit=1`,
    [],
  );
  return rows[0] || null;
}

/** Every reading, newest first — the audit trail and the live timeline. */
export async function getWeighInHistory(eventId: string, limit = 60): Promise<WeighInHistoryRow[]> {
  return read<WeighInHistoryRow[]>(
    `ufc_weigh_in_history?select=*&event_id=eq.${encodeURIComponent(eventId)}&order=occurred_at.desc.nullslast&limit=${limit}`,
    [],
  );
}

/** Readings for specific bouts, for the matchup page. */
export async function getWeighInsForBouts(boutIds: string[]): Promise<Map<string, WeighIn[]>> {
  const ids = boutIds.filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await read<WeighIn[]>(
    `ufc_weigh_in_current?select=*&bout_id=in.(${ids.join(",")})&order=fighter_name.asc`,
    [],
  );
  const out = new Map<string, WeighIn[]>();
  for (const r of rows) {
    if (!r.bout_id) continue;
    if (!out.has(r.bout_id)) out.set(r.bout_id, []);
    out.get(r.bout_id)!.push(r);
  }
  return out;
}

/** Any event with weigh-in coverage, newest first — used both to select the
 * live desk and to render the recent weigh-in archive. */
export async function getWeighInEvents(limit = 8): Promise<WeighInSummary[]> {
  return read<WeighInSummary[]>(
    `ufc_weigh_in_event_summary?select=*&order=event_date.desc.nullslast&limit=${limit}`,
    [],
  );
}

/**
 * Which event the desk should show.
 *
 * The next card ONLY when it already has readings; otherwise the most recent
 * covered card. The old fallback returned upcoming[0] even when it had zero
 * readings, which hid a fully populated recent weigh-in behind an empty desk.
 *
 * `upcoming` comes from the caller so this module does not duplicate the
 * schedule query lib/db.ts already owns.
 */
export function pickDeskEvent(
  upcoming: Array<{ id: string; name: string; event_date: string | null }>,
  covered: WeighInSummary[],
): { eventId: string; eventName: string; eventDate: string | null; state: "upcoming" | "recent" } | null {
  const coveredIds = new Set(covered.map((c) => c.event_id));
  const next = upcoming.find((e) => coveredIds.has(e.id));
  if (next) return { eventId: next.id, eventName: next.name, eventDate: next.event_date, state: "upcoming" };
  const recent = covered[0];
  if (recent) return { eventId: recent.event_id, eventName: recent.event_name, eventDate: recent.event_date, state: "recent" };
  return null;
}
