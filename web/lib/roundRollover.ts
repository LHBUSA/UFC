/* Round-for-Round card selection. Pure: no server import, no network, no clock
 * of its own (the caller passes `now`).
 *
 * THE BUG THIS REPLACES
 * ---------------------
 * The deck used to show "the soonest card that has not finished its broadcast
 * window". The moment a card's window closed, that answer became NEXT WEEK's
 * card, so the page forgot the event that had just happened before its round
 * observations had necessarily landed (Noche UFC, 2026-09-12: 13 results, 0
 * round rows, gone from the deck by Sunday).
 *
 * THREE CARDS, NEVER ONE OBJECT
 * -----------------------------
 *   live             a card inside its stored broadcast window.
 *   latestCompleted  the most recent card that has actually been fought — known
 *                    from STORED RESULTS, not from the clock — inside the
 *                    retention window.
 *   next             the soonest card that has not started. Shown on its own,
 *                    never as round intelligence: nothing has happened yet.
 *
 * FOCUS (who owns the deck)
 *   1. live
 *   2. latestCompleted
 *   3. nothing — `next` is never the focus.
 *
 * A card stops being "latest" only when a later card has been fought (it has
 * results) or goes live. There is no Sunday-midnight boundary; the retention
 * window only stops a months-old card from owning the deck through a long break.
 */
import { watchState, type EventBroadcast, type WatchState } from "./broadcast-display.ts";

/** How long a completed card may own the deck if nothing newer is fought. */
export const LATEST_COMPLETED_RETENTION_DAYS = 10;

export type RolloverBroadcast = Pick<EventBroadcast,
  "ufc_slug" | "event_id" | "event_name" | "event_date" | "early_prelims_start_utc" | "prelims_start_utc" | "main_card_start_utc">;

/** An event row with the counts the selection needs, all from stored data. */
export type RolloverEvent = {
  id: string;
  name: string;
  event_date: string | null;
  card_status: string;
  /** Bouts on the card, cancelled bouts excluded. */
  bouts: number;
  /** Bouts with a stored result. */
  results: number;
};

export type RoundArchivePhase =
  | "results_arriving"      // fought, but not every bout has a stored result yet
  | "rounds_pending"        // every bout has a result; round observations still landing
  | "rounds_complete";      // every result bout has its round rows or an explicit no-detail answer

export type CardRef<E = RolloverEvent, B = RolloverBroadcast> = { event: E | null; broadcast: B | null; state: WatchState | null };

export type RoundForRoundSelection<E = RolloverEvent, B = RolloverBroadcast> = {
  live: CardRef<E, B> | null;
  latestCompleted: CardRef<E, B> | null;
  next: CardRef<E, B> | null;
  focus: "live" | "latest_completed" | null;
};

const DAY_MS = 86400e3;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function selectRoundForRound<E extends RolloverEvent, B extends RolloverBroadcast>({
  broadcasts, events, now, retentionDays = LATEST_COMPLETED_RETENTION_DAYS,
}: { broadcasts: B[]; events: E[]; now: number; retentionDays?: number }): RoundForRoundSelection<E, B> {
  const eventById = new Map(events.map((e) => [e.id, e]));
  const broadcastFor = (eventId: string | null | undefined) => (eventId ? broadcasts.find((b) => b.event_id === eventId) ?? null : null);

  /* 1. LIVE: stored broadcast window. The earliest-opening live card wins if two
   *    overlap (they do not in practice; the rule is only here to be explicit). */
  const liveRows = broadcasts
    .map((b) => ({ b, state: watchState(b, now) }))
    .filter((x) => x.state === "live");
  const liveRow = liveRows[0] ?? null;
  const live: CardRef<E, B> | null = liveRow
    ? { event: liveRow.b.event_id ? eventById.get(liveRow.b.event_id) ?? null : null, broadcast: liveRow.b, state: "live" }
    : null;

  /* 2. LATEST COMPLETED: fought = at least one stored result. Dated no later than
   *    today (UTC) and no earlier than the retention window. Never the live card. */
  const today = dayKey(now);
  const oldest = dayKey(now - retentionDays * DAY_MS);
  const fought = events
    .filter((e) => e.results > 0 && e.event_date && e.event_date <= today && e.event_date >= oldest)
    .filter((e) => !live || live.event?.id !== e.id)
    .sort((x, y) => String(y.event_date).localeCompare(String(x.event_date)) || y.results - x.results);
  const latest = fought[0] ?? null;
  const latestCompleted: CardRef<E, B> | null = latest
    ? { event: latest, broadcast: broadcastFor(latest.id), state: (() => { const b = broadcastFor(latest.id); return b ? watchState(b, now) : null; })() }
    : null;

  /* 3. NEXT: the soonest card that has not started. Not live, not finished, and
   *    not a card that already has results. */
  const nextRow = broadcasts
    .map((b) => ({ b, state: watchState(b, now) }))
    .filter((x) => x.state === "upcoming" || x.state === "today" || x.state === "time_tba")
    .filter((x) => !x.b.event_id || !((eventById.get(x.b.event_id)?.results ?? 0) > 0))
    .sort((x, y) => String(x.b.main_card_start_utc || x.b.event_date || "9999").localeCompare(String(y.b.main_card_start_utc || y.b.event_date || "9999")))[0] ?? null;
  const next: CardRef<E, B> | null = nextRow
    ? { event: nextRow.b.event_id ? eventById.get(nextRow.b.event_id) ?? null : null, broadcast: nextRow.b, state: nextRow.state }
    : null;

  return { live, latestCompleted, next, focus: live ? "live" : latestCompleted ? "latest_completed" : null };
}

/** Round-archive coverage for one card, from per-bout facts. */
export type BoutRoundFact = { hasResult: boolean; roundReady: boolean; noRoundDetail: boolean };
export type CardCoverage = {
  cardSize: number;
  results: number;
  roundReady: number;
  /** Results whose source has explicitly published no round detail. Not zero rows. */
  noRoundDetail: number;
  /** Results still waiting for round observations. */
  roundPending: number;
  phase: RoundArchivePhase;
};

export function cardCoverage(cardSize: number, bouts: BoutRoundFact[]): CardCoverage {
  const withResult = bouts.filter((b) => b.hasResult);
  const roundReady = withResult.filter((b) => b.roundReady).length;
  const noRoundDetail = withResult.filter((b) => !b.roundReady && b.noRoundDetail).length;
  const roundPending = withResult.length - roundReady - noRoundDetail;
  const phase: RoundArchivePhase = withResult.length < cardSize ? "results_arriving" : roundPending > 0 ? "rounds_pending" : "rounds_complete";
  return { cardSize, results: withResult.length, roundReady, noRoundDetail, roundPending, phase };
}

/** The public status line. Never claims archived/verified rounds before rows exist. */
export function coverageLine(c: CardCoverage): string {
  const results = `${c.results} result${c.results === 1 ? "" : "s"} recorded`;
  if (c.results === 0) return "No completed bouts recorded yet";
  if (c.roundReady === 0 && c.roundPending > 0) return `${results} · round data pending`;
  const parts = [results, `${c.roundReady} with round data`];
  if (c.roundPending) parts.push(`${c.roundPending} pending`);
  if (c.noRoundDetail) parts.push(`${c.noRoundDetail} without published round detail`);
  return parts.join(" · ");
}
