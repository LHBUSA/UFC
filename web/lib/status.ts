import "server-only";
import type { StatusType, StatusState, StatusEvent, CardChange } from "./status-display";
export type { StatusType, StatusState, StatusEvent, CardChange } from "./status-display";
export {
  STATUS_LABEL, UNAVAILABLE, SOURCE_KIND_LABEL,
  diagnosisLine, hasDiagnosis, statusHeadline, fighterRef,
} from "./status-display";


/* Fighter availability read path.
 *
 * Reads ufc_fighter_status_feed / ufc_event_card_changes, which the migration
 * in supabase/migrations/20260908000010_ufc_fighter_status.sql defines and
 * which HAS NOT BEEN APPLIED. Every reader below therefore returns an empty
 * result rather than throwing: the pages that use them render their empty
 * state today and fill in the moment the migration lands, with no code change.
 * That is the same contract lib/db.ts keeps for a fresh database — a missing
 * table is a gap in the data, never a 500.
 *
 * NOTHING HERE INVENTS A CONDITION. `injury_type` and `body_part` arrive null
 * far more often than not, and the display helpers below are written so that
 * the null case reads as the honest sentence it is ("no diagnosis stated")
 * rather than a blank that looks like missing UI.
 */

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function headers() {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json" };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

/* Availability is the fastest-moving thing on the site: a main-event
 * withdrawal is stale the minute it is stale. 120s, against 300s elsewhere. */
export const STATUS_REVALIDATE = 120;

async function read<T>(path: string, fallback: T, revalidate = STATUS_REVALIDATE): Promise<T> {
  if (!URL_ || !KEY) return fallback;
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: headers(), next: { revalidate } });
    if (!res.ok) {
      /* 404 is the expected answer until the migration is applied; anything
       * else is worth a line in the log without becoming a page failure. */
      if (res.status !== 404) console.error(`[status] ${path.split("?")[0]} -> HTTP ${res.status}`);
      return fallback;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.error(`[status] ${path.split("?")[0]} failed: ${String((e as Error)?.message || e).slice(0, 120)}`);
    return fallback;
  }
}

const FEED = "*";

/** The availability feed, newest first. `state` filters active vs resolved. */
export async function getStatusEvents(opts: {
  state?: StatusState | "all";
  statusType?: StatusType;
  fighterId?: string;
  eventId?: string;
  limit?: number;
} = {}): Promise<StatusEvent[]> {
  const q = [`select=${FEED}`, "order=occurred_at.desc.nullslast", `limit=${opts.limit ?? 120}`];
  if (opts.state && opts.state !== "all") q.push(`state=eq.${opts.state}`);
  if (opts.statusType) q.push(`status_type=eq.${opts.statusType}`);
  if (opts.fighterId) q.push(`fighter_id=eq.${encodeURIComponent(opts.fighterId)}`);
  if (opts.eventId) q.push(`event_id=eq.${encodeURIComponent(opts.eventId)}`);
  return read<StatusEvent[]>(`ufc_fighter_status_feed?${q.join("&")}`, []);
}

/** One fighter's full status history, newest first. */
export async function getFighterStatusHistory(fighterId: string, limit = 20): Promise<StatusEvent[]> {
  return getStatusEvents({ fighterId, state: "all", limit });
}

/** Card changes for one event. */
export async function getEventCardChanges(eventId: string): Promise<CardChange[]> {
  return read<CardChange[]>(
    `ufc_event_card_changes?select=*&event_id=eq.${encodeURIComponent(eventId)}&order=occurred_at.desc.nullslast&limit=40`,
    [],
  );
}

/** Card changes affecting specific bouts, for the matchup-page alert. */
export async function getBoutStatusEvents(boutIds: string[]): Promise<Map<string, StatusEvent[]>> {
  const ids = boutIds.filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await read<StatusEvent[]>(
    `ufc_fighter_status_feed?select=*&bout_id=in.(${ids.join(",")})&order=occurred_at.desc.nullslast&limit=60`,
    [],
  );
  const out = new Map<string, StatusEvent[]>();
  for (const r of rows) {
    if (!r.bout_id) continue;
    if (!out.has(r.bout_id)) out.set(r.bout_id, []);
    out.get(r.bout_id)!.push(r);
  }
  return out;
}

