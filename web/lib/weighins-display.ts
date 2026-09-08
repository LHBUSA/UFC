/* Pure display rules for the weigh-in desk.
 *
 * Its own module with no imports, for the reason the status guard needed one:
 * this is the last place a fabricated number can reach a page, so it has to be
 * directly testable, and weighins.ts imports "server-only" which a bare test
 * runner refuses to load.
 *
 * TWO RULES GOVERN EVERY FUNCTION BELOW.
 *
 * Never show a blank where something matters. A missing weight, a missing
 * limit and a missing delta are three different states of knowledge, and an
 * empty cell reads as none of them — it reads as broken UI, or worse, as zero.
 * Each one gets a sentence.
 *
 * Never show 0 for absence. A fighter who has not weighed in has not weighed
 * 0 lb, and "0.0 over" is a claim that they made weight exactly.
 */

export type WeighInResult = "pending" | "made" | "missed" | "cancelled" | "withdrawn";
export type LimitBasis = "sourced" | "division_rule" | "unsupported";
export type SourceKind = "official" | "commission" | "news" | "manual";

export type WeighIn = {
  id: string;
  event_id: string;
  event_name: string | null;
  event_date: string | null;
  bout_id: string | null;
  fighter_id: string;
  fighter_name: string;
  fighter_espn_athlete_id: string | null;
  fighter_ufcstats_id: string | null;
  weight_class: string | null;
  weight_class_raw: string | null;
  is_womens: boolean | null;
  is_title: boolean | null;
  card_position: string | null;
  bout_order: number | null;
  bout_status: string | null;
  contracted_limit_lbs: number | null;
  allowance_lbs: number | null;
  limit_basis: LimitBasis;
  applicable_limit_lbs: number | null;
  official_weight_lbs: number | null;
  attempt_number: number;
  result: WeighInResult;
  over_by_lbs: number | null;
  catchweight_lbs: number | null;
  weighed_at: string | null;
  source_url: string;
  source_name: string;
  source_kind: SourceKind;
  source_published_at: string | null;
  detected_at: string;
  first_seen_at: string;
  last_seen_at: string;
  raw_text: string | null;
  supersedes_id: string | null;
  is_correction: boolean;
};

export type WeighInSummary = {
  event_id: string;
  event_name: string;
  event_date: string | null;
  expected: number;
  weighed: number;
  made: number;
  missed: number;
  pending: number;
  withdrawn: number;
  cancelled: number;
  catchweights: number;
  corrections: number;
  limit_unsupported: number;
  last_source_update: string | null;
  newest_source_published_at: string | null;
  first_seen_at: string | null;
};

/* ---- labels ----------------------------------------------------------- */

export const RESULT_LABEL: Record<WeighInResult, string> = {
  pending: "PENDING",
  made: "MADE WEIGHT",
  missed: "MISSED WEIGHT",
  cancelled: "BOUT CANCELLED",
  withdrawn: "WITHDRAWN",
};

/** Visual weight, not colour. The page decides how to render each tone. */
export const RESULT_TONE: Record<WeighInResult, "ok" | "alert" | "neutral" | "gone"> = {
  made: "ok",
  missed: "alert",
  pending: "neutral",
  withdrawn: "alert",
  cancelled: "gone",
};

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  official: "Official UFC",
  commission: "Athletic commission",
  news: "Reported",
  manual: "Desk-entered",
};

const lb = (n: number) => {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? `${r}.0` : `${r}`;
};

/* ---- the four cells that can be empty ---------------------------------- */

/**
 * The scale reading.
 *
 * Never "0", never "—" alone. A fighter who has not stepped on the scale has
 * no weight, and the cell has to say which of the several reasons applies.
 */
export function weightCell(w: WeighIn): { text: string; known: boolean } {
  if (w.official_weight_lbs != null) return { text: `${lb(w.official_weight_lbs)} lb`, known: true };
  if (w.result === "pending") return { text: "Not yet weighed", known: false };
  if (w.result === "withdrawn") return { text: "Withdrew before the scale", known: false };
  if (w.result === "cancelled") return { text: "Bout cancelled", known: false };
  if (w.result === "missed") return { text: "Weight not published", known: false };
  return { text: "Official weigh-in result not recorded yet", known: false };
}

/**
 * The applicable limit, and why it might be absent.
 *
 * A weight class is not a limit — a lightweight title fight is 155 and a
 * non-title one is 156 — so when the limit is unsupported the cell says the
 * contracted figure has not been published rather than leaving the reader to
 * assume a division default.
 */
export function limitCell(w: WeighIn): { text: string; known: boolean; note: string | null } {
  if (w.applicable_limit_lbs != null) {
    const note = w.limit_basis === "sourced"
      ? "contracted limit as published"
      : w.is_title
        ? "championship limit, no allowance"
        : w.allowance_lbs
          ? `includes the ${lb(w.allowance_lbs)} lb non-title allowance`
          : null;
    return { text: `${lb(w.applicable_limit_lbs)} lb`, known: true, note };
  }
  return {
    text: "Limit not published",
    known: false,
    note: w.weight_class === "CATCHWEIGHT"
      ? "catchweight: the agreed figure has not been published"
      : "the contracted limit for this bout is not on file",
  };
}

/**
 * The delta.
 *
 * Only ever a number when the row carries one. This function cannot compute a
 * delta and deliberately does not try: doing the arithmetic here would let a
 * page produce a figure the database refused to store.
 */
export function deltaCell(w: WeighIn): { text: string; over: boolean } {
  if (w.over_by_lbs != null) return { text: `+${lb(w.over_by_lbs)} lb over`, over: true };
  if (w.result === "made" && w.applicable_limit_lbs != null && w.official_weight_lbs != null) {
    const under = Math.round((w.applicable_limit_lbs - w.official_weight_lbs) * 10) / 10;
    return { text: under > 0 ? `${lb(under)} lb under` : "on the limit", over: false };
  }
  if (w.result === "missed") return { text: "Amount over not published", over: true };
  return { text: "—", over: false };
}

/** The weight class as a reader recognises it, catchweight named explicitly. */
export function classCell(w: WeighIn): string {
  if (w.catchweight_lbs != null) return `Catchweight ${lb(w.catchweight_lbs)} lb`;
  if (w.weight_class === "CATCHWEIGHT") return "Catchweight";
  if (!w.weight_class) return "Weight class not on file";
  const pretty = w.weight_class.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return `${w.is_womens ? "Women's " : ""}${pretty}${w.is_title ? " title" : ""}`;
}

/* ---- ordering and grouping -------------------------------------------- */

/**
 * Card order, main event first, with the two fighters of a bout adjacent.
 *
 * Falls back to name when bout_order is absent so the table never reorders
 * itself unpredictably between polls — a live page that reshuffles while
 * someone is reading it is worse than one that is slightly out of order.
 */
export function sortForTable(rows: WeighIn[]): WeighIn[] {
  return [...rows].sort((a, b) => {
    const ao = a.bout_order ?? -1;
    const bo = b.bout_order ?? -1;
    if (ao !== bo) return bo - ao;
    if (a.bout_id !== b.bout_id) return String(a.bout_id).localeCompare(String(b.bout_id));
    return a.fighter_name.localeCompare(b.fighter_name);
  });
}

/** True when anything on this card still might change. */
export function isLive(summary: WeighInSummary | null): boolean {
  return Boolean(summary && summary.pending > 0);
}

/**
 * How stale the desk is, in words.
 *
 * Source-fetch cadence determines real freshness, not how often a browser
 * polls, so this is measured from the newest SOURCE confirmation rather than
 * from the last time this page was rendered.
 */
export function freshness(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "no source update yet";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "seconds ago";
  if (min === 1) return "1 minute ago";
  if (min < 60) return `${min} minutes ago`;
  const hr = Math.floor(min / 60);
  if (hr === 1) return "1 hour ago";
  if (hr < 24) return `${hr} hours ago`;
  const d = Math.floor(hr / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

/**
 * A wall-clock time for a reading, in words a reader can trust.
 *
 * lib/format.fmtDate deliberately truncates its input to a date and pins it to
 * 12:00Z — correct for an event date, and silently wrong here: every reading
 * on this desk rendered "12:00 PM" regardless of when the fighter actually
 * stepped on the scale. A fabricated timestamp on a live page is worse than no
 * timestamp, because it looks like information.
 *
 * Times are shown in UTC and LABELLED as UTC. Venue-local would be friendlier
 * and we do not store venue timezone, so it would have to be guessed from the
 * country — which is the same class of mistake in a different column.
 */
export function clockTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

/**
 * The deterministic one-line update. Same rule as the collector's: built from
 * stored fields, reproducible, never generated.
 */
export function updateLine(w: WeighIn): string {
  const who = w.fighter_name;
  switch (w.result) {
    case "missed":
      if (w.official_weight_lbs != null && w.over_by_lbs != null) {
        return `${who} — ${lb(w.official_weight_lbs)} lb — MISSED by ${lb(w.over_by_lbs)} lb`;
      }
      if (w.official_weight_lbs != null) return `${who} — ${lb(w.official_weight_lbs)} lb — MISSED (limit not published)`;
      return `${who} — MISSED WEIGHT (weight not published)`;
    case "made":
      return `${who} — ${w.official_weight_lbs != null ? `${lb(w.official_weight_lbs)} lb — ` : ""}made weight`;
    case "withdrawn":
      return `${who} — withdrew`;
    case "cancelled":
      return `${who} — bout cancelled`;
    default:
      return `${who} — awaiting the scale`;
  }
}

/** The timeline kind for one reading, used for the live feed's eyebrow. */
export function timelineKind(w: WeighIn): string {
  if (w.is_correction) return "OFFICIAL CORRECTION";
  if (w.result === "withdrawn") return "WITHDRAWAL";
  if (w.result === "cancelled") return "BOUT CANCELLED";
  if (w.catchweight_lbs != null) return "CATCHWEIGHT AGREED";
  if (w.attempt_number > 1) return `SECOND ATTEMPT`;
  if (w.result === "missed") return "MISSED WEIGHT";
  if (w.result === "made") return "WEIGHED IN";
  return "AWAITING SCALE";
}
