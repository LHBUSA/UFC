/* /round-by-round — the fight-night command center and the post-card handoff.
 *
 * Which card this renders is decided in lib/roundLive.ts (lib/roundRollover.ts):
 *
 *   LIVE CARD              the broadcast window is open.
 *   LATEST COMPLETED CARD  the most recent card that has been fought (stored
 *                          results), kept on the deck after its window closes —
 *                          including while its round observations still land.
 *   NEXT EVENT             a small, separate panel. Never round intelligence:
 *                          nothing on that card has happened.
 *
 * THE TRUTH LABEL
 * ---------------
 * "EVENT LIVE" and "ROUND DATA" are separate, differently coloured signals,
 * because they are two different facts. Red is spent ONLY on a genuinely live
 * broadcast; round-data state is gold. A completed card says how many results
 * are recorded and how many have round data — it never says "archived" or
 * "verified rounds" before the rows exist.
 *
 * Nothing here renders a current round, a live strike count, a clock or a
 * fighter "in the cage". No such field exists upstream and none is invented.
 */
import Link from "next/link";
import {
  startLines, linkableBroadcasts, providerList, localTime, zoneLabel, localDay,
  verifiedAgo, isStale,
} from "@/lib/broadcast-display";
import { LocalTime, Countdown, VerifiedAgo } from "@/components/HowToWatchClient";
import { RoundLiveRefresh } from "@/components/RoundLiveRefresh";
import { RoundResultCard } from "@/components/RoundResultCard";
import type { NextCard, RoundLiveState } from "@/lib/roundLive";
import { livePollMs } from "@/lib/roundLive";
import { coverageLine } from "@/lib/roundRollover";
import { fmtDate } from "@/lib/format";
import { eventSlug } from "@/lib/slug";
import styles from "@/app/round-by-round/round-live.module.css";

const SERVER_ZONE = "America/New_York";
const DAY: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" };

/** The next scheduled card, on its own. Says when, not what happened. */
export function NextEventPanel({ next }: { next: NextCard }) {
  const b = next.broadcast;
  const lines = startLines(b);
  const main = lines.find((l) => l.key === "main_card") ?? lines[0] ?? null;
  return (
    <aside className={styles.nextPanel} aria-label="Next event">
      <span className={styles.nextKicker}>Next event</span>
      <b className={styles.nextName}>{b.event_name}</b>
      <span className={styles.nextWhen}>
        {main ? (
          <>
            {localDay(main.utc, SERVER_ZONE)} · {main.label}{" "}
            <LocalTime utc={main.utc} initial={localTime(main.utc, SERVER_ZONE)} initialZone={zoneLabel(main.utc, SERVER_ZONE)} />
          </>
        ) : next.eventDate ? fmtDate(next.eventDate, DAY) : "Start time to be announced"}
      </span>
      <span className={styles.nextNote}>Round intelligence for this card begins after its first completed fight.</span>
      {next.eventDate ? <Link href={`/events/${eventSlug({ name: next.name, event_date: next.eventDate })}`} className={styles.nextLink} prefetch={false}>Event details →</Link> : null}
    </aside>
  );
}

export function RoundLiveDeck({ state, now = Date.now() }: { state: RoundLiveState; now?: number }) {
  const focus = state.focus;
  if (!focus) return state.next ? <NextEventPanel next={state.next} /> : null;

  const b = focus.broadcast;
  const live = focus.kind === "live";
  const c = focus.coverage;
  const lines = b ? startLines(b) : [];
  const providers = b ? providerList(b.broadcasts ?? []) : "";
  const primary = b ? linkableBroadcasts(b)[0] ?? null : null;
  const pollMs = livePollMs(state);
  const finalizing = !live && c.results > 0 && (c.roundPending > 0 || c.phase === "results_arriving");

  const primaryLabel = live ? "Event live" : "Latest completed event";
  const roundLabel = live
    ? (state.roundReady.length > 0 ? `Round intelligence · ${state.roundReady.length} bout${state.roundReady.length === 1 ? "" : "s"}` : "Round intelligence · pending")
    : c.phase === "rounds_complete" ? "Round archive complete" : "Round archive finalizing";
  /* Our own dated slug: UFC.com's ufc_slug carries no date, and lib/resolve resolves events by date. */
  const eventHref = focus.eventDate ? `/events/${eventSlug({ name: focus.name, event_date: focus.eventDate })}` : null;

  return (
    <>
      <section className={styles.deck} aria-label={live ? "Fight night coverage" : "Latest completed event"} data-focus={focus.kind}>
        {/* Polls ONLY while the broadcast window is open. */}
        {pollMs ? <RoundLiveRefresh intervalMs={pollMs} /> : null}

        <div className={styles.stage} aria-hidden="true" />

        <div className={styles.deckIn}>
          <div className={styles.signals}>
            <span className={live ? styles.sigLive : styles.sigIdle}>
              {live && <span className={styles.dot} aria-hidden="true" />}
              {primaryLabel}
            </span>
            {/* Two counts, never merged: results are ESPN, rounds are UFC Stats. */}
            <span className={styles.sigResults}>
              {c.results > 0
                ? `Results · ${c.results}${c.cardSize ? ` of ${c.cardSize}` : ""} bouts`
                : "Results · awaiting first completed fight"}
            </span>
            <span className={styles.sigData}>{roundLabel}</span>
          </div>

          <h2 className={styles.eventName}>{focus.name}</h2>

          <p className={styles.where}>
            {b ? [b.venue, b.location_raw].filter(Boolean).join(" · ") || "Venue to be announced" : null}
            {live
              ? (lines.length > 0 ? ` · ${localDay(lines[0].utc, SERVER_ZONE)}` : "")
              : focus.eventDate ? `${b ? " · " : ""}${fmtDate(focus.eventDate, DAY)}` : ""}
          </p>

          {live ? (
            <p className={styles.thesis}>
              Round intelligence publishes as each fight is completed and its official round
              observations are verified. This page is where the analytical story of the card
              assembles itself, bout by bout.
            </p>
          ) : (
            <p className={styles.thesis} data-status={finalizing ? "finalizing" : "complete"}>
              <b className={styles.coverageLine}>{coverageLine(c)}</b>
              {finalizing
                ? " Official round observations are still being finalized. Fights move into the permanent archive below once their round rows are stored; nothing is estimated in the meantime."
                : c.roundReady > 0
                  ? " This card's available round data is in the permanent archive below."
                  : ""}
            </p>
          )}

          {live && lines.length > 0 && b && (
            <div className={styles.clocks}>
              {lines.map((l) => (
                <div key={l.key} className={styles.clock} data-main={l.key === "main_card" ? "true" : undefined}>
                  <span className={styles.clockLabel}>{l.label}</span>
                  <LocalTime utc={l.utc} initial={localTime(l.utc, SERVER_ZONE)} initialZone={zoneLabel(l.utc, SERVER_ZONE)} />
                </div>
              ))}
              <div className={styles.clock} data-count="true">
                <span className={styles.clockLabel}>Status</span>
                <span className={styles.clockCount}>
                  <Countdown event={b} initialState={state.eventState ?? "live"} initialLabel="Live now" />
                </span>
              </div>
            </div>
          )}

          <div className={styles.actions}>
            {eventHref && (
              <Link href={eventHref} className={styles.actionGhost} prefetch={false}>
                Event details
              </Link>
            )}
            {b && (
              <a className={styles.actionGhost} href={b.ufc_event_url} target="_blank" rel="noopener noreferrer">
                UFC.com event page ↗
              </a>
            )}
            {live && primary && (
              <a className={styles.actionWatch} href={primary.watch_url!} target="_blank" rel="noopener noreferrer">
                Watch on {primary.provider} ↗
              </a>
            )}
          </div>

          {live && b && (
            <div className={styles.provenance}>
              <VerifiedAgo iso={b.verified_at} initial={verifiedAgo(b.verified_at, now)} stale={isStale(b.verified_at, now)} />
              {providers && primary && providers !== primary.provider ? <span className={styles.alsoOn}>Also on {providers}</span> : null}
            </div>
          )}
        </div>

        <div className={styles.tonight}>
          <div className={styles.tonightHead}>
            <h3>{live ? <>Tonight&rsquo;s completed-fight round intelligence</> : "Completed fights from this card"}</h3>
            <span>
              {state.completedResults.length > 0
                ? "Newest completed bout first · results from ESPN, round observations from UFC Stats"
                : "Updates as official completed-fight data becomes available"}
            </span>
          </div>

          {state.completedResults.length > 0 ? (
            <ol className={styles.resultList}>
              {state.completedResults.map((entry, i) => (
                <RoundResultCard
                  key={entry.bout.id}
                  entry={entry}
                  images={state.images}
                  ranks={state.ranks}
                  eventName={focus.name}
                  eventDate={focus.eventDate}
                  latest={live && i === 0}
                />
              ))}
            </ol>
          ) : (
            <div className={styles.waiting}>
              <span className={styles.waitingMark} aria-hidden="true" />
              <div>
                <b>{live ? "Fight night is live." : "No completed bouts from this card yet."}</b>
                <p>
                  Round intelligence appears here as each fight finishes and its official round
                  observations are verified. Nothing is estimated in the meantime.
                  {state.cardSize > 0 ? ` ${state.cardSize} bouts are booked on this card.` : ""}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>
      {state.next && state.next.eventId !== focus.eventId ? <NextEventPanel next={state.next} /> : null}
    </>
  );
}
