import "server-only";

/* Fight-night state for /round-by-round.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ----------------------------------------
 * "The event is live" and "we have round data" are DIFFERENT FACTS, from
 * different sources, and this module keeps them apart:
 *
 *   event live   <- ufc_event_broadcasts (UFC.com start times, verified by the
 *                   ufc-broadcast-schedule Worker). Says the BROADCAST is on.
 *   round data   <- ufc_bout_round_stats via getRoundCoverageFor. Only exists
 *                   once a fight has finished and its stats have been ingested.
 *
 * There is NO in-fight telemetry anywhere in this system. No current round, no
 * live strike count, no clock, no "who is in the cage". Nothing in this file
 * returns such a field, and nothing downstream may invent one. What the page
 * can truthfully say during a card is: the event is live, and here are the
 * fights from it whose round observations have landed so far.
 */
import { getEventBouts, type Bout, type Event, type PortraitSet } from "@/lib/db";
import { getVerifiedDisplayImagesForFighters } from "@/lib/verifiedPortraits";
import { buildBoutScorecard, type BoutScorecard } from "@/lib/judgeScoring";
import { getRoundCoverageFor, isEligible, type RoundCoverage } from "@/lib/roundIndex";
import { getNextBroadcast, watchState, type EventBroadcast, type WatchState } from "@/lib/broadcast";
import { getRankingMap } from "@/lib/rankings";
import type { FighterRankingContext } from "@/lib/rankingContext";

/* Fight-night cache TTL. Short enough that a completed bout surfaces on the
 * next poll, long enough that traffic during a card costs one read a minute
 * rather than one per visitor. The client polls at 90s (livePollMs), so the
 * worst case a reader sees is ~60s-old round coverage. */
const LIVE_TTL = 60;

/* A completed bout and, SEPARATELY, whether its round observations exist.
 *
 * `coverage: null` is the normal mid-card state: ESPN has marked the fight
 * final and stored the result, and UFCStats has not published its round rows
 * yet. The two facts have different sources and different latencies, so they
 * are two fields, never one collapsed "is this fight ready" boolean. */
export type TonightBout = {
  bout: Bout;
  /** Round observations, or null when none have landed for this bout yet. */
  coverage: RoundCoverage | null;
  /** True only when coverage exists and clears the eligibility rule. */
  roundReady: boolean;
  /* The official scorecard read, built by the SAME function the fight page
   * uses (lib/judgeScoring). There is deliberately one scorecard
   * interpretation in this codebase; this surface consumes it rather than
   * re-deriving orientation or totals of its own. Null for anything that did
   * not go to the judges. */
  scorecard: BoutScorecard | null;
};

export type RoundLiveState = {
  /* The card the broadcast layer says is current, if any. */
  broadcast: EventBroadcast | null;
  /* Broadcast state only. Never a statement about round data. */
  eventState: WatchState | null;
  /* True only while the broadcast window is open. */
  isLive: boolean;
  /* Ranking identity for every fighter on the card, resolved ONCE here from
   * the official snapshot. Attached to the state so the deck renders a rank
   * without any card reaching for rankings on its own. */
  ranks: Map<string, FighterRankingContext>;
  /* Our own event row, when the broadcast row is matched to one. */
  event: Event | null;
  /* Every bout from tonight's card with a STORED RESULT, newest first —
   * whether or not its round data has landed. This is the ESPN-backed fact. */
  completedResults: TonightBout[];
  /* The subset whose round observations have landed. Derived, never a
   * separate read: `completedResults.filter(b => b.roundReady)`. */
  roundReady: TonightBout[];
  /* Portraits for every fighter on a completed bout, fetched in ONE batched
   * call for the whole set rather than per card. Empty map when the resolver
   * has nothing approved; the cards fall back to the branded Avatar. */
  images: Map<string, PortraitSet>;
  /* How many bouts are on the card at all, for an honest "3 of 13" line. */
  cardSize: number;
  checkedAt: string;
};

const EMPTY: RoundLiveState = {
  broadcast: null, eventState: null, isLive: false, event: null,
  completedResults: [], roundReady: [], images: new Map(), ranks: new Map(), cardSize: 0, checkedAt: new Date(0).toISOString(),
};

/**
 * Resolve tonight's state.
 *
 * `revalidate` is threaded so the page can use the normal 5-minute ISR cache
 * while the polling route asks for a fresh read — see app/api/ufc/round-live.
 */
export async function getRoundLiveState(now = Date.now()): Promise<RoundLiveState> {
  let broadcast: EventBroadcast | null = null;
  try {
    broadcast = await getNextBroadcast(now, LIVE_TTL);
  } catch {
    /* The broadcast layer being unavailable must not take the archive page
     * down with it. No banner is better than a wrong one. */
    return { ...EMPTY, checkedAt: new Date(now).toISOString() };
  }
  if (!broadcast) return { ...EMPTY, checkedAt: new Date(now).toISOString() };

  const eventState = watchState(broadcast, now);
  const isLive = eventState === "live";

  /* Only reach for bouts when there is an event row to reach with. An
   * unmatched broadcast row still powers the hero; it just cannot list bouts. */
  let completedResults: TonightBout[] = [];
  let cardSize = 0;
  if (broadcast.event_id) {
    try {
      const bouts = await getEventBouts(broadcast.event_id, LIVE_TTL);
      const live = bouts.filter((b) => b.status !== "cancelled");
      cardSize = live.length;
      /* A stored RESULT is enough to list a bout. Round coverage is looked up
       * alongside it and attached, but its absence no longer hides the fight:
       * ESPN marks a bout final within seconds and UFCStats publishes its round
       * rows much later, so requiring both meant the page stayed empty for most
       * of a card while we already knew who had won. */
      const finished = live.filter((b) => b.result);
      if (finished.length) {
        const cover = await getRoundCoverageFor(finished.map((b) => b.id), LIVE_TTL);
        completedResults = finished
          .map((b) => {
            const coverage = cover.get(b.id) ?? null;
            const r = b.result;
            /* Scorecards only where the bout actually went to the judges. A
             * KO has no card to show, and rendering an empty one would imply
             * we lost something we never had. */
            const scorecard = r
              ? buildBoutScorecard({
                method: r.method, scorecards: r.scorecards, winnerId: r.winner_id,
                fighterAId: b.fighter_a.id, fighterBId: b.fighter_b.id,
              })
              : null;
            return { bout: b, coverage, roundReady: isEligible(coverage), scorecard };
          })
          /* Newest first: bout_order descends down the card, so the most
           * recently contested bout is the LOWEST order still completed. */
          .sort((x, y) => (x.bout.bout_order ?? 0) - (y.bout.bout_order ?? 0));
      }
    } catch {
      completedResults = [];
    }
  }

  /* ONE image read for every fighter on every completed bout. Per-card reads
   * would be an N+1 against a table this page hits on a 90-second refresh. */
  let images = new Map<string, PortraitSet>();
  if (completedResults.length) {
    try {
      images = await getVerifiedDisplayImagesForFighters(
        [...new Set(completedResults.flatMap((x) => [x.bout.fighter_a.id, x.bout.fighter_b.id]))],
      );
    } catch {
      images = new Map();
    }
  }

  /* One snapshot read for the whole card, like the image batch above. */
  const ranks = await getRankingMap().catch(() => new Map<string, FighterRankingContext>());

  return {
    broadcast,
    eventState,
    isLive,
    ranks,
    event: null,
    completedResults,
    images,
    roundReady: completedResults.filter((b) => b.roundReady),
    cardSize,
    checkedAt: new Date(now).toISOString(),
  };
}

/**
 * How often the page should re-check while a card is running.
 *
 * Only ever polls during a live broadcast window. Outside one the answer is
 * `null` and the client stops entirely — there is nothing to discover between
 * cards, and a page that polls all week to learn nothing is just cost.
 */
export function livePollMs(state: Pick<RoundLiveState, "isLive">): number | null {
  return state.isLive ? 90_000 : null;
}
