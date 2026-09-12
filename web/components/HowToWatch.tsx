/* HOW TO WATCH — the two reader-facing surfaces.
 *
 *   <HowToWatchPanel>  the full block on an event page
 *   <WatchStrip>       the compact version on the homepage next-event card
 *
 * Both are SERVER components. The broadcast row is already in the page's data —
 * it came from our own table, alongside the bouts — so the block paints with
 * the first byte of HTML. Nothing about it loads late and nothing about it can
 * shift the layout. The only client work is re-formatting the same instants in
 * the visitor's timezone and ticking the countdown.
 *
 * The ten designed states, and where each one is handled:
 *   1 upcoming, complete      the normal render
 *   2 event today             Countdown + "Today" eyebrow (viewer's day)
 *   3 live                    Countdown -> "Live now", live dot
 *   4 finished                Countdown -> "Card finished", CTAs drop away
 *   5 broadcaster unknown     `.pending` sentence; no CTA is invented
 *   6 time not announced      `.pending` sentence; the panel still renders
 *   7 multiple broadcasters   every carrier gets its own CTA + segment label
 *   8 source down, data good  nothing changes; only `verified_at` ages
 *   9 stale verification      the tick turns gold and the wording changes
 *  10 no upcoming event       the caller renders nothing (row is null)
 */
import Link from "next/link";
import {
  startLines, linkableBroadcasts, providerList, segmentSummary, watchState,
  localTime, zoneLabel, localDay, countdown, verifiedAgo, isStale, firstStartMs,
  type EventBroadcast,
} from "@/lib/broadcast-display";
import { LocalTime, LocalTimeInline, Countdown, VerifiedAgo } from "@/components/HowToWatchClient";
import styles from "@/app/how-to-watch.module.css";

/* The server renders in US Eastern — the promotion's own reference zone, and a
 * correct answer in its own right rather than a placeholder. The client swaps
 * in the visitor's zone on mount. */
const SERVER_ZONE = "America/New_York";

function serverLabel(b: EventBroadcast, now: number): string {
  const state = watchState(b, now, SERVER_ZONE);
  if (state === "live") return "Live now";
  if (state === "finished") return "Card finished";
  const first = firstStartMs(b);
  return first == null ? "" : `Starts in ${countdown(first, now)}`;
}

/** Carrier CTAs, or a stated-but-unlinked carrier, or nothing at all. */
function Carriers({ b }: { b: EventBroadcast }) {
  const all = b.broadcasts ?? [];
  const linkable = linkableBroadcasts(b);
  const unlinked = all.filter((x) => x.provider && !x.watch_url);

  if (all.length === 0) {
    /* State 5. UFC.com has not published a carrier for this card. Saying so is
     * information; inventing a network, or guessing from the last card, is not. */
    return (
      <p className={styles.pending}>
        UFC.com has not published a broadcaster for this card yet. It appears here as soon as it does.
      </p>
    );
  }

  return (
    <div className={styles.watch}>
      <span className={styles.watchLabel}>Watch on</span>
      <div className={styles.providers}>
        {linkable.map((x) => (
          <a
            key={x.provider}
            className={styles.cta}
            href={x.watch_url!}
            target="_blank"
            rel="noopener noreferrer"
          >
            <b>{x.provider}</b>
            {segmentSummary(x) && <small>{segmentSummary(x)}</small>}
          </a>
        ))}
        {unlinked.map((x) => (
          <span key={x.provider} className={styles.carrier}>
            <b>{x.provider}</b>
            <small>{segmentSummary(x) || "No official link published"}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

/** The full block for an event page. */
export function HowToWatchPanel({ b, now = Date.now() }: { b: EventBroadcast | null; now?: number }) {
  if (!b) return null;

  const lines = startLines(b);
  const state = watchState(b, now, SERVER_ZONE);
  const stale = isStale(b.verified_at, now);
  const finished = state === "finished";

  return (
    <section className="segment" id="how-to-watch">
      <div className={styles.panel}>
        <div className={styles.head}>
          <h2>How to Watch</h2>
          {!finished && <Countdown event={b} initialState={state} initialLabel={serverLabel(b, now)} />}
        </div>

        <h3 className={styles.eventName}>{b.event_name}</h3>
        <div className={styles.eventMeta}>
          {lines.length > 0 && <>{localDay(lines[0].utc, SERVER_ZONE)} · </>}
          {[b.venue, b.location_raw].filter(Boolean).join(" · ") || "Venue to be announced"}
        </div>

        {lines.length > 0 ? (
          <div className={styles.times}>
            {lines.map((l) => (
              <div key={l.key} className={styles.slot} data-main={l.key === "main_card" ? "true" : undefined}>
                <span className={styles.slotLabel}>{l.label}</span>
                <LocalTime
                  utc={l.utc}
                  initial={localTime(l.utc, SERVER_ZONE)}
                  initialZone={zoneLabel(l.utc, SERVER_ZONE)}
                />
              </div>
            ))}
          </div>
        ) : (
          /* State 6. The card is on the schedule; its start times are not
           * published yet. The panel still renders, with the carrier and the
           * official link, because both are useful before the clock is set. */
          <p className={styles.pending}>
            Start times for this card have not been published by UFC.com yet. They appear here, in your local
            timezone, as soon as they are.
          </p>
        )}

        {finished ? (
          <p className={styles.pending}>
            This card has finished.{" "}
            {(b.broadcasts?.length ?? 0) > 0 && `It was carried by ${providerList(b.broadcasts)}.`}
          </p>
        ) : (
          <Carriers b={b} />
        )}

        <div className={styles.status}>
          <VerifiedAgo iso={b.verified_at} initial={verifiedAgo(b.verified_at, now)} stale={stale} />
          <a className={styles.official} href={b.ufc_event_url} target="_blank" rel="noopener noreferrer">
            Official UFC event details →
          </a>
        </div>
      </div>
    </section>
  );
}

/**
 * The compact strip: homepage next-event card, fight-day experience.
 *
 * Two variants:
 *
 *   default  the whole strip is one link to the event page. No watch CTA — a
 *            second competing button inside a card that is already a link is a
 *            worse card, and an <a> inside an <a> is invalid markup.
 *   hero     the strip is the base of the homepage feature card, so the
 *            broadcaster becomes a REAL primary action. Nothing wraps it, so
 *            the watch anchor is a top-level link and the markup stays valid.
 *
 * The hero variant is what makes the broadcast panel read as part of the
 * featured event rather than a tray bolted underneath it.
 */
export function WatchStrip({
  b, now = Date.now(), href, variant = "default",
}: {
  b: EventBroadcast | null;
  now?: number;
  href?: string;
  variant?: "default" | "hero";
}) {
  if (!b) return null;
  const lines = startLines(b);
  const state = watchState(b, now, SERVER_ZONE);
  if (state === "finished") return null;
  if (lines.length === 0 && (b.broadcasts?.length ?? 0) === 0) return null;

  const eyebrow = state === "live" ? "Live now" : state === "today" ? "Today" : "How to watch";
  const providers = providerList(b.broadcasts ?? []);
  const hero = variant === "hero";
  /* The one carrier we promote to a button. Multiple carriers still all get
   * named in the line beneath it, so nothing is hidden by the shortcut. */
  const primary = hero ? linkableBroadcasts(b)[0] ?? null : null;
  /* Everyone else, named properly from the array rather than by cutting the
   * primary's name back out of a joined sentence. Nothing is hidden by
   * promoting one carrier to a button. */
  const secondary = primary
    ? providerList((b.broadcasts ?? []).filter((x) => x.provider !== primary.provider))
    : "";

  const body = (
    <div className={hero ? `${styles.strip} ${styles.stripHero}` : styles.strip}>
      <div className={styles.stripTop}>
        <span className={styles.stripEyebrow}>{eyebrow} · {b.event_name}</span>
        <Countdown event={b} initialState={state} initialLabel={serverLabel(b, now)} />
      </div>

      {lines.length > 0 && (
        <div className={styles.stripTimes}>
          {lines.map((l) => (
            <div key={l.key} className={styles.stripSlot}>
              <span>{l.label}</span>
              <b><LocalTimeInline utc={l.utc} initial={localTime(l.utc, SERVER_ZONE)} /></b>
            </div>
          ))}
        </div>
      )}

      {primary ? (
        <div className={styles.stripCta}>
          <a className={styles.watchBtn} href={primary.watch_url!} target="_blank" rel="noopener noreferrer">
            <span>Watch on {primary.provider}</span>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
              <path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
          <span className={styles.stripSource}>
            {secondary ? <>Also on {secondary} · </> : null}
            ✓ UFC.com · {verifiedAgo(b.verified_at, now)}
          </span>
        </div>
      ) : (
        <div className={styles.stripWatch}>
          <span>{providers ? <>Watch on <b>{providers}</b></> : "Broadcaster not yet published"}</span>
          <span>✓ UFC.com · {verifiedAgo(b.verified_at, now)}</span>
        </div>
      )}
    </div>
  );

  /* Never wrap the hero variant: it contains its own outbound anchor. */
  return href && !hero ? <Link href={href} aria-label={`${b.event_name}: how to watch`}>{body}</Link> : body;
}
