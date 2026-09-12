"use client";

/* The parts of How to Watch that only the visitor's browser can know: their
 * timezone, their calendar day, and the live countdown.
 *
 * HOW THIS AVOIDS BOTH HYDRATION MISMATCH AND LAYOUT SHIFT
 * -------------------------------------------------------
 * The server renders these components with `initial` — the same string it put
 * in the HTML, formatted in US Eastern, which is the promotion's own reference
 * zone and therefore a correct, meaningful value rather than a spinner. The
 * first client render returns exactly that string, so hydration matches. An
 * effect then re-formats from the SAME canonical UTC instant using the
 * browser's resolved IANA zone and re-renders.
 *
 * The swap changes glyphs inside a reserved line box (see .slotTime in
 * how-to-watch.module.css), so nothing moves. Nothing is fetched: the countdown
 * and the localization both work off a UTC timestamp the server already sent.
 */

import { useEffect, useState } from "react";
import { localTime, zoneLabel, countdown, watchState, type EventBroadcast } from "@/lib/broadcast-display";
import styles from "@/app/how-to-watch.module.css";

/** The browser's IANA zone, or undefined if the runtime will not say. */
function useViewerZone(): string | undefined {
  const [zone, setZone] = useState<string | undefined>(undefined);
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) setZone(tz);
    } catch {
      /* Leave it undefined: every formatter falls back to the runtime default,
       * which is still the visitor's own zone. */
    }
  }, []);
  return zone;
}

/** One localized clock time. `initial` is the server's Eastern render. */
export function LocalTime({ utc, initial, initialZone }: { utc: string; initial: string; initialZone: string }) {
  const zone = useViewerZone();
  const [value, setValue] = useState({ time: initial, label: initialZone });

  useEffect(() => {
    if (!zone) return;
    setValue({ time: localTime(utc, zone), label: zoneLabel(utc, zone) });
  }, [utc, zone]);

  return (
    <>
      <span className={styles.slotTime}>
        {/* The machine-readable instant stays in the DOM whatever we render. */}
        <time dateTime={utc}>{value.time}</time>
      </span>
      <span className={styles.slotZone}>{value.label}</span>
    </>
  );
}

/** Compact variant for the homepage strip: time only, no zone line. */
export function LocalTimeInline({ utc, initial }: { utc: string; initial: string }) {
  const zone = useViewerZone();
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (!zone) return;
    setValue(localTime(utc, zone));
  }, [utc, zone]);
  return <time dateTime={utc}>{value}</time>;
}

type CountdownProps = {
  event: Pick<EventBroadcast, "early_prelims_start_utc" | "prelims_start_utc" | "main_card_start_utc">;
  /** The server's state, so the first paint is never blank or wrong. */
  initialState: ReturnType<typeof watchState>;
  initialLabel: string;
};

/**
 * "Starts in 5h 12m" / "Starts in 42m" / "Live now".
 *
 * Ticks on a 30-second interval. A per-second tick would re-render the subtree
 * sixty times a minute to change a number that only moves once a minute, and
 * the countdown is never accurate to the second anyway — a broadcast start is
 * a scheduled intention, not a stopwatch.
 */
export function Countdown({ event, initialState, initialLabel }: CountdownProps) {
  const zone = useViewerZone();
  const [label, setLabel] = useState(initialLabel);
  const [state, setState] = useState(initialState);

  useEffect(() => {
    const target = Date.parse(
      event.early_prelims_start_utc || event.prelims_start_utc || event.main_card_start_utc || "",
    );
    const tick = () => {
      const now = Date.now();
      const s = watchState(event, now, zone);
      setState(s);
      if (s === "live") setLabel("Live now");
      else if (s === "finished") setLabel("Card finished");
      else if (!Number.isFinite(target)) setLabel("");
      else setLabel(`Starts in ${countdown(target, now)}`);
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [event, zone]);

  if (!label) return null;
  const live = state === "live";
  return (
    <span className={styles.countdown} data-live={live ? "true" : undefined}>
      {live && <span className={styles.liveDot} aria-hidden="true" />}
      {label}
    </span>
  );
}

/**
 * "Verified from UFC.com · Updated 18 min ago".
 *
 * Client-side only for the relative part, because "18 min ago" computed on a
 * cached server render is "18 min ago" for as long as that render is cached.
 * The absolute timestamp goes in the title attribute so the claim is auditable.
 */
export function VerifiedAgo({ iso, initial, stale }: { iso: string; initial: string; stale: boolean }) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    const tick = () => {
      const min = Math.floor((Date.now() - Date.parse(iso)) / 60000);
      if (!Number.isFinite(min)) return;
      if (min < 1) setText("just now");
      else if (min < 60) setText(`${min} min ago`);
      else if (min < 1440) { const h = Math.floor(min / 60); setText(`${h} hour${h === 1 ? "" : "s"} ago`); }
      else { const d = Math.floor(min / 1440); setText(`${d} day${d === 1 ? "" : "s"} ago`); }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, [iso]);

  return (
    <span className={styles.verified} data-stale={stale ? "true" : undefined}>
      <span className={styles.tick} aria-hidden="true">✓</span>
      <span>
        {stale ? "Last verified from UFC.com" : "Verified from UFC.com"} ·{" "}
        <time dateTime={iso} title={iso}>Updated {text}</time>
      </span>
    </span>
  );
}
