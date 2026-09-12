/* /round-by-round — the fight-night command center.
 *
 * Three bands, in the order the night actually unfolds:
 *
 *   1. LIVE EVENT      what the broadcast layer knows: which card, where, when
 *                      each segment started, who carries it, when we last
 *                      verified it against UFC.com.
 *   2. TONIGHT'S ROUNDS which fights from that card have round observations
 *                      stored so far — or an intentional waiting state.
 *   3. ARCHIVE          the existing page, unchanged, below this.
 *
 * THE TRUTH LABEL
 * ---------------
 * "EVENT LIVE" and "ROUND DATA" are rendered as two separate, differently
 * coloured signals, because they are two different facts. The broadcast being
 * on air says nothing about whether a fight has finished and been ingested.
 * Red is spent ONLY on a genuinely live broadcast; round-data state is gold.
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
import { fmtRecord, METHOD_LABEL, weightClassLabel } from "@/lib/format";
import { matchupSlug } from "@/lib/slug";
import type { RoundLiveState } from "@/lib/roundLive";
import { livePollMs } from "@/lib/roundLive";
import styles from "@/app/round-by-round/round-live.module.css";

const SERVER_ZONE = "America/New_York";

export function RoundLiveDeck({ state, now = Date.now() }: { state: RoundLiveState; now?: number }) {
  const b = state.broadcast;
  if (!b) return null;

  const lines = startLines(b);
  const live = state.isLive;
  const today = state.eventState === "today";
  const providers = providerList(b.broadcasts ?? []);
  const primary = linkableBroadcasts(b)[0] ?? null;
  const pollMs = livePollMs(state);

  return (
    <section className={styles.deck} aria-label="Fight night coverage">
      {/* Polls ONLY while the broadcast window is open. */}
      {pollMs ? <RoundLiveRefresh intervalMs={pollMs} /> : null}

      <div className={styles.stage} aria-hidden="true" />

      <div className={styles.deckIn}>
        {/* ---- band 1: the live event ---- */}
        <div className={styles.signals}>
          <span className={live ? styles.sigLive : styles.sigIdle}>
            {live && <span className={styles.dot} aria-hidden="true" />}
            {live ? "Event live" : today ? "Event today" : "Next event"}
          </span>
          <span className={styles.sigData}>
            {state.completed.length > 0
              ? `Round data · ${state.completed.length}${state.cardSize ? ` of ${state.cardSize}` : ""} bouts`
              : "Round data · awaiting first completed fight"}
          </span>
        </div>

        <h2 className={styles.eventName}>{b.event_name}</h2>

        <p className={styles.where}>
          {[b.venue, b.location_raw].filter(Boolean).join(" · ") || "Venue to be announced"}
          {lines.length > 0 ? ` · ${localDay(lines[0].utc, SERVER_ZONE)}` : ""}
        </p>

        <p className={styles.thesis}>
          Round intelligence publishes as each fight is completed and its official round
          observations are verified. This page is where the analytical story of the card
          assembles itself, bout by bout.
        </p>

        {lines.length > 0 && (
          <div className={styles.clocks}>
            {lines.map((l) => (
              <div key={l.key} className={styles.clock} data-main={l.key === "main_card" ? "true" : undefined}>
                <span className={styles.clockLabel}>{l.label}</span>
                <LocalTime
                  utc={l.utc}
                  initial={localTime(l.utc, SERVER_ZONE)}
                  initialZone={zoneLabel(l.utc, SERVER_ZONE)}
                />
              </div>
            ))}
            <div className={styles.clock} data-count="true">
              <span className={styles.clockLabel}>{live ? "Status" : "Countdown"}</span>
              <span className={styles.clockCount}>
                <Countdown
                  event={b}
                  initialState={state.eventState ?? "upcoming"}
                  initialLabel={live ? "Live now" : ""}
                />
              </span>
            </div>
          </div>
        )}

        <div className={styles.actions}>
          {b.event_id && (
            <Link href={`/events/${b.ufc_slug}`} className={styles.actionGhost} prefetch={false}>
              Event details
            </Link>
          )}
          <a className={styles.actionGhost} href={b.ufc_event_url} target="_blank" rel="noopener noreferrer">
            UFC.com event page ↗
          </a>
          {primary && (
            <a className={styles.actionWatch} href={primary.watch_url!} target="_blank" rel="noopener noreferrer">
              Watch on {primary.provider} ↗
            </a>
          )}
        </div>

        <div className={styles.provenance}>
          <VerifiedAgo
            iso={b.verified_at}
            initial={verifiedAgo(b.verified_at, now)}
            stale={isStale(b.verified_at, now)}
          />
          {providers && primary && providers !== primary.provider ? (
            <span className={styles.alsoOn}>Also on {providers}</span>
          ) : null}
        </div>
      </div>

      {/* ---- band 2: tonight's completed-fight round intelligence ---- */}
      <div className={styles.tonight}>
        <div className={styles.tonightHead}>
          <h3>Tonight&rsquo;s completed-fight round intelligence</h3>
          <span>
            {state.completed.length > 0
              ? "Newest completed bout first · official round observations"
              : "Updates as official completed-fight data becomes available"}
          </span>
        </div>

        {state.completed.length > 0 ? (
          <ol className={styles.boutList}>
            {state.completed.map(({ bout, coverage }, i) => {
              const winner = bout.result?.winner_id;
              const wc = weightClassLabel(bout.weight_class, bout.is_womens);
              const method = bout.result?.method ? METHOD_LABEL[bout.result.method] ?? bout.result.method : null;
              return (
                <li key={bout.id} className={styles.boutRow} data-newest={i === 0 ? "true" : undefined}>
                  <Link
                    href={`/fights/${matchupSlug(bout.fighter_a, bout.fighter_b, { name: b.event_name, event_date: b.event_date })}`}
                    className={styles.boutLink}
                  >
                    {i === 0 && <span className={styles.newest}>Latest</span>}
                    <span className={styles.boutFighters}>
                      <span className={winner === bout.fighter_a.id ? styles.win : undefined}>
                        {bout.fighter_a.name}
                        <small>{fmtRecord(bout.fighter_a)}</small>
                      </span>
                      <i>vs</i>
                      <span className={winner === bout.fighter_b.id ? styles.win : undefined}>
                        {bout.fighter_b.name}
                        <small>{fmtRecord(bout.fighter_b)}</small>
                      </span>
                    </span>
                    <span className={styles.boutMeta}>
                      {wc && <span>{wc}</span>}
                      {bout.is_title && <span className={styles.title}>Title</span>}
                      {method && (
                        <span>
                          {method}
                          {bout.result?.round ? ` · R${bout.result.round}` : ""}
                        </span>
                      )}
                    </span>
                    <span className={styles.boutRounds}>
                      <span className={styles.pips} aria-hidden="true">
                        {Array.from({ length: Math.max(1, coverage.rounds) }, (_, n) => <i key={n} />)}
                      </span>
                      <b>
                        {coverage.rounds} round{coverage.rounds === 1 ? "" : "s"} recorded
                      </b>
                      <em>{coverage.bothCorners ? "Both corners verified" : "One-corner coverage"}</em>
                    </span>
                    <span className={styles.boutCta}>Open round intelligence →</span>
                  </Link>
                </li>
              );
            })}
          </ol>
        ) : (
          /* The waiting state. Deliberately designed, not an error card: early
           * in a card this is the CORRECT state and will be what most visitors
           * see. It says what is true and what happens next. */
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
  );
}
