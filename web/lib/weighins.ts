import { splitCard, type CardChange, type CardObservation, type CardStatusEvent } from "@/lib/cardTruth";
import "server-only";
export type { WeighIn, WeighInSummary, WeighInResult, LimitBasis, SourceKind } from "./weighins-display";
export {
  RESULT_LABEL, RESULT_TONE, SOURCE_KIND_LABEL,
  weightCell, limitCell, deltaCell, classCell,
  sortForTable, isLive, freshness, updateLine, timelineKind, clockTime,
  deskWindow, bookedCoverage, shouldPoll, pickDesk, supersessionLabel, DESK_WINDOW,
} from "./weighins-display";
import { pickDesk } from "./weighins-display";

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
  /** 'confirmation' = superseded at the same weight, 'correction' = weight changed, null = original reading. */
  supersession_kind?: "confirmation" | "correction" | null;
  superseded_weight_lbs?: number | null;
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
 * Which event the desk should show. See pickDesk: the upcoming card inside
 * its weigh-in window is the desk even with zero readings; otherwise the next
 * covered card, otherwise the most recent covered card.
 *
 * `upcoming` comes from the caller so this module does not duplicate the
 * schedule query lib/db.ts already owns.
 */
export function pickDeskEvent(
  upcoming: Array<{ id: string; name: string; event_date: string | null }>,
  covered: WeighInSummary[],
  now: number = Date.now(),
) {
  return pickDesk(upcoming, covered, now);
}

export type BookedBout = {
  id: string;
  espn_competition_id: string | null;
  fighter_a_id: string | null;
  fighter_b_id: string | null;
  weight_class: string | null;
  weight_class_raw: string | null;
  card_position: string | null;
  bout_order: number | null;
  status: string | null;
};

/** The booked card (cancelled bouts excluded) — what "expected" means before
 *  the first reading lands. Same 15-second revalidate as the readings: a
 *  cached answer to "who is on the card" must not outlive the card. */
export async function getBookedCard(eventId: string): Promise<BookedBout[]> {
  return (await getBookedCardSplit(eventId)).active;
}

/** The booked card split by CARD TRUTH (lib/cardTruth.ts): the bouts a weigh-in is expected from, and the bouts
 *  that were scheduled and then came off the card, each with the reason the sources gave. A removed bout is
 *  never expected and never pending; it is also never dropped from the page. */
export async function getBookedCardSplit(eventId: string, eventName?: string | null): Promise<{ active: BookedBout[]; changes: CardChange[]; all: BookedBout[] }> {
  const id = encodeURIComponent(eventId);
  const [bouts, observations, statusEvents] = await Promise.all([
    read<BookedBout[]>(`ufc_bouts?select=id,espn_competition_id,fighter_a_id,fighter_b_id,weight_class,weight_class_raw,card_position,bout_order,status&event_id=eq.${id}&order=bout_order.desc.nullslast`, []),
    read<CardObservation[]>(`ufc_event_card_observations?select=observed_at,source,competition_ids,placeholder_ids,complete&event_id=eq.${id}&source=eq.espn&order=observed_at.desc&limit=12`, []),
    read<CardStatusEvent[]>(`ufc_fighter_status_feed?select=id,fighter_id,fighter_name,status_type,state,event_id,bout_id,replacement_fighter_name,source_url,source_name,source_kind,source_published_at,confidence,occurred_at&event_id=eq.${id}&order=occurred_at.desc.nullslast&limit=200`, []),
  ]);
  const { active, changes } = splitCard(bouts, observations, statusEvents, { eventId, eventName });
  const activeIds = new Set(active.map((b) => b.id));
  return { active: bouts.filter((b) => activeIds.has(b.id)), changes, all: bouts };
}
