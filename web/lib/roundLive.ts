import "server-only";

/* Fight-night and handoff state for /round-by-round.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ----------------------------------------
 * "The event is live" and "we have round data" are DIFFERENT FACTS, from
 * different sources, and this module keeps them apart:
 *
 *   event live   <- ufc_event_broadcasts (UFC.com start times, verified by the
 *                   ufc-broadcast-schedule Worker). Says the BROADCAST is on.
 *   fought       <- ufc_bout_results. A card with stored results has happened,
 *                   whatever the clock says.
 *   round data   <- ufc_bout_round_stats via getRoundCoverageFor. Only exists
 *                   once a fight has finished and its stats have been ingested.
 *
 * WHICH CARD OWNS THE DECK (lib/roundRollover.ts)
 * -----------------------------------------------
 *   live card  >  latest completed card  >  nothing.
 * The next scheduled card is carried separately and is never the focus, so a
 * card whose broadcast window has closed stays on the deck until a later card
 * is fought or goes live — including while its round observations are still
 * landing. (It used to be replaced by next week's card the moment its window
 * closed; see roundRollover.ts.)
 *
 * There is NO in-fight telemetry anywhere in this system. No current round, no
 * live strike count, no clock, no "who is in the cage". Nothing in this file
 * returns such a field, and nothing downstream may invent one.
 */
import { getEventBouts, getRolloverEvents, getRoundQueueStates, type Bout, type PortraitSet, type RolloverEventRow } from "@/lib/db";
import { getVerifiedDisplayImagesForFighters } from "@/lib/verifiedPortraits";
import { buildBoutScorecard, type BoutScorecard } from "@/lib/judgeScoring";
import { getRoundCoverageFor, isEligible, type RoundCoverage } from "@/lib/roundIndex";
import { getBroadcastsSince, type EventBroadcast, type WatchState } from "@/lib/broadcast";
import { getRankingMap } from "@/lib/rankings";
import type { FighterRankingContext } from "@/lib/rankingContext";
import { cardCoverage, selectRoundForRound, LATEST_COMPLETED_RETENTION_DAYS, type CardCoverage } from "@/lib/roundRollover";

/* Fight-night cache TTL. Result ingestion now runs every minute during an
 * active card; keep the shared server read tight enough that the next client
 * poll sees a newly stored result without waiting behind a minute-long cache. */
const LIVE_TTL = 15;
/* How far ahead to look for the next card. */
const NEXT_LOOKAHEAD_DAYS = 45;

/* A completed bout and, SEPARATELY, whether its round observations exist.
 *
 * `coverage: null` is the normal state between a result landing and its round
 * rows landing. `noRoundDetail` is the source's explicit answer that the fight
 * page carries no round tables (ufc_round_stat_queue) — it is not zero rows and
 * it is not "still waiting". */
export type TonightBout = {
  bout: Bout;
  /** Round observations, or null when none have landed for this bout yet. */
  coverage: RoundCoverage | null;
  /** True only when coverage exists and clears the eligibility rule. */
  roundReady: boolean;
  /** The source published no round detail for this fight. */
  noRoundDetail: boolean;
  /* The official scorecard read, built by the SAME function the fight page
   * uses (lib/judgeScoring). Null for anything that did not go to the judges. */
  scorecard: BoutScorecard | null;
};

/** The card that owns the deck. */
export type FocusCard = {
  kind: "live" | "latest_completed";
  eventId: string | null;
  name: string;
  eventDate: string | null;
  broadcast: EventBroadcast | null;
  eventState: WatchState | null;
  coverage: CardCoverage;
};

/** The next scheduled card, shown on its own. Never round intelligence. */
export type NextCard = {
  eventId: string | null;
  name: string;
  eventDate: string | null;
  broadcast: EventBroadcast;
  eventState: WatchState | null;
};

export type RoundLiveState = {
  focus: FocusCard | null;
  next: NextCard | null;
  /* The focus card's broadcast row, when it has one. */
  broadcast: EventBroadcast | null;
  /* Broadcast state of the focus card only. Never a statement about round data. */
  eventState: WatchState | null;
  /* True only while the focus card's broadcast window is open. */
  isLive: boolean;
  ranks: Map<string, FighterRankingContext>;
  /* Every bout from the focus card with a STORED RESULT, newest first. */
  completedResults: TonightBout[];
  /* Derived: `completedResults.filter(b => b.roundReady)`. */
  roundReady: TonightBout[];
  images: Map<string, PortraitSet>;
  /* How many bouts are on the focus card at all, for an honest "3 of 13" line. */
  cardSize: number;
  checkedAt: string;
};

const EMPTY_COVERAGE: CardCoverage = { cardSize: 0, results: 0, roundReady: 0, noRoundDetail: 0, roundPending: 0, phase: "results_arriving" };
const emptyState = (now: number): RoundLiveState => ({
  focus: null, next: null, broadcast: null, eventState: null, isLive: false,
  completedResults: [], roundReady: [], images: new Map(), ranks: new Map(), cardSize: 0, checkedAt: new Date(now).toISOString(),
});
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Resolve the deck: the live card, else the latest completed card, plus the next
 * card on its own. All selection facts are stored data; `now` only decides which
 * broadcast windows are open and how far back "recent" reaches.
 */
export async function getRoundForRoundState(now = Date.now()): Promise<RoundLiveState> {
  let broadcasts: EventBroadcast[] = [];
  let events: RolloverEventRow[] = [];
  try {
    const from = dayKey(now - (LATEST_COMPLETED_RETENTION_DAYS + 1) * 86400e3);
    [broadcasts, events] = await Promise.all([
      getBroadcastsSince(from, LIVE_TTL),
      getRolloverEvents(from, dayKey(now + NEXT_LOOKAHEAD_DAYS * 86400e3), LIVE_TTL),
    ]);
  } catch {
    /* The schedule layer being unavailable must not take the archive page down
     * with it. No banner is better than a wrong one. */
    return emptyState(now);
  }

  const sel = selectRoundForRound({ broadcasts, events, now });
  const next: NextCard | null = sel.next?.broadcast
    ? { eventId: sel.next.broadcast.event_id, name: sel.next.broadcast.event_name, eventDate: sel.next.broadcast.event_date, broadcast: sel.next.broadcast, eventState: sel.next.state }
    : null;
  const ref = sel.focus === "live" ? sel.live : sel.focus === "latest_completed" ? sel.latestCompleted : null;
  if (!ref) return { ...emptyState(now), next };

  const eventId = ref.event?.id ?? ref.broadcast?.event_id ?? null;
  let completedResults: TonightBout[] = [];
  let cardSize = ref.event?.bouts ?? 0;
  if (eventId) {
    try {
      const bouts = await getEventBouts(eventId, LIVE_TTL);
      const onCard = bouts.filter((b) => b.status !== "cancelled");
      cardSize = onCard.length;
      /* A stored RESULT is enough to list a bout; round coverage is attached
       * alongside it and its absence never hides the fight. */
      const finished = onCard.filter((b) => b.result);
      if (finished.length) {
        const ids = finished.map((b) => b.id);
        const [cover, queue] = await Promise.all([
          getRoundCoverageFor(ids, LIVE_TTL),
          getRoundQueueStates(ids, LIVE_TTL).catch(() => new Map<string, string>()),
        ]);
        completedResults = finished
          .map((b) => {
            const coverage = cover.get(b.id) ?? null;
            const r = b.result;
            const roundReady = isEligible(coverage);
            const scorecard = r
              ? buildBoutScorecard({ method: r.method, scorecards: r.scorecards, winnerId: r.winner_id, fighterAId: b.fighter_a.id, fighterBId: b.fighter_b.id })
              : null;
            return { bout: b, coverage, roundReady, noRoundDetail: !roundReady && queue.get(b.id) === "no_round_detail", scorecard };
          })
          /* Newest completed bout first. Canonical UFC card ordering is
           * chronological here: early prelims start at low bout_order values
           * and the card advances toward the main event at higher values. */
          .sort((x, y) => (y.bout.bout_order ?? 0) - (x.bout.bout_order ?? 0));
      }
    } catch {
      completedResults = [];
    }
  }

  const coverage = eventId
    ? cardCoverage(cardSize, completedResults.map((x) => ({ hasResult: true, roundReady: x.roundReady, noRoundDetail: x.noRoundDetail })))
    : EMPTY_COVERAGE;

  let images = new Map<string, PortraitSet>();
  if (completedResults.length) {
    try {
      images = await getVerifiedDisplayImagesForFighters([...new Set(completedResults.flatMap((x) => [x.bout.fighter_a.id, x.bout.fighter_b.id]))]);
    } catch {
      images = new Map();
    }
  }
  const ranks = await getRankingMap().catch(() => new Map<string, FighterRankingContext>());

  const focus: FocusCard = {
    kind: sel.focus === "live" ? "live" : "latest_completed",
    eventId,
    name: ref.broadcast?.event_name ?? ref.event?.name ?? "UFC event",
    eventDate: ref.event?.event_date ?? ref.broadcast?.event_date ?? null,
    broadcast: ref.broadcast,
    eventState: ref.state,
    coverage,
  };

  return {
    focus,
    next,
    broadcast: ref.broadcast,
    eventState: ref.state,
    isLive: focus.kind === "live",
    ranks,
    completedResults,
    images,
    roundReady: completedResults.filter((b) => b.roundReady),
    cardSize,
    checkedAt: new Date(now).toISOString(),
  };
}

/**
 * How often the page should re-check.
 *
 * Only ever polls during a live broadcast window. A completed card whose round
 * observations are still landing is served by the page's normal 5-minute cache;
 * rows arrive over hours, and a page that polls all week to learn that is cost.
 */
export function livePollMs(state: Pick<RoundLiveState, "isLive">): number | null {
  return state.isLive ? 30_000 : null;
}
