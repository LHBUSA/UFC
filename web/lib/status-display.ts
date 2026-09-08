/* Pure display rules for fighter availability.
 *
 * Its own module, with no imports at all, for the reason the referee packet
 * guard needed one: this is the last place the "never infer a diagnosis" rule
 * can be broken, so it has to be directly testable. The extractor can be
 * perfect and the schema can hold, and a display helper that renders a null as
 * "Undisclosed injury" still puts a claim on the page that no source made.
 *
 * status.ts imports "server-only", which a bare test runner refuses to load.
 * Keeping these here means the rule is covered by tests rather than by review.
 */

export type StatusType =
  | "injury" | "illness" | "withdrawal" | "replacement" | "suspension"
  | "visa_travel" | "weight_miss" | "return" | "cleared" | "other";

export type StatusState = "active" | "resolved" | "expired";

export type StatusEvent = {
  id: string;
  fighter_id: string;
  fighter_name: string;
  fighter_espn_athlete_id: string | null;
  fighter_ufcstats_id: string | null;
  record_w: number | null; record_l: number | null; record_d: number | null;
  status_type: StatusType;
  status_detail: string | null;
  state: StatusState;
  event_id: string | null;
  event_name: string | null;
  event_date: string | null;
  bout_id: string | null;
  replacement_fighter_id: string | null;
  replacement_fighter_name: string | null;
  replaced_fighter_id: string | null;
  replaced_fighter_name: string | null;
  injury_type: string | null;
  body_part: string | null;
  injury_side: "left" | "right" | null;
  clinical_quote: string | null;
  expected_return_at: string | null;
  expected_return_note: string | null;
  source_url: string;
  source_name: string;
  source_kind: "official" | "commission" | "news" | "manual";
  source_published_at: string | null;
  detected_at: string;
  effective_at: string | null;
  confidence: number;
  occurred_at: string;
};

export type CardChange = {
  event_id: string;
  id: string;
  fighter_id: string;
  fighter_name: string;
  fighter_espn_athlete_id: string | null;
  fighter_ufcstats_id: string | null;
  status_type: StatusType;
  state: StatusState;
  bout_id: string | null;
  replacement_fighter_id: string | null;
  replacement_fighter_name: string | null;
  replaced_fighter_id: string | null;
  replaced_fighter_name: string | null;
  status_detail: string | null;
  injury_type: string | null;
  body_part: string | null;
  source_url: string;
  source_name: string;
  source_kind: StatusEvent["source_kind"];
  confidence: number;
  occurred_at: string;
};

/* ---- display ---------------------------------------------------------- */

export const STATUS_LABEL: Record<StatusType, string> = {
  injury: "Injury",
  illness: "Illness",
  withdrawal: "Withdrawal",
  replacement: "Replacement",
  suspension: "Suspension",
  visa_travel: "Visa / travel",
  weight_miss: "Missed weight",
  return: "Return",
  cleared: "Cleared",
  other: "Status change",
};

/** Which statuses mean "not available right now". */
export const UNAVAILABLE: ReadonlySet<StatusType> = new Set<StatusType>([
  "injury", "illness", "withdrawal", "suspension", "visa_travel",
]);

/**
 * What we are allowed to say about the cause.
 *
 * This is the display half of "never infer a diagnosis". When the source did
 * not name the injury the answer is a sentence saying so, NOT a blank cell and
 * NOT a placeholder like "Undisclosed injury" that reads as a fact we hold.
 * The reader should be able to tell the difference between "we know it was a
 * torn ACL" and "nobody has said what it is", because those are different
 * states of knowledge and only one of them is a claim.
 */
/* Stored lowercase because the vocabulary is a closed set of keys, not prose.
 * Casing them for display is presentation and changes no claim — "torn acl"
 * and "torn ACL" are the same stored fact. */
const ACRONYMS = /\b(acl|mcl|pcl|lcl|ufc|mma|tko|ko)\b/gi;
const titleCaseFirst = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase());

export function diagnosisLine(e: Pick<StatusEvent, "injury_type" | "body_part" | "injury_side">): string {
  const side = e.injury_side ? `${e.injury_side} ` : "";
  if (e.injury_type) {
    return titleCaseFirst(`${side}${e.injury_type}`).replace(ACRONYMS, (m) => m.toUpperCase());
  }
  if (e.body_part) {
    return titleCaseFirst(`${side}${e.body_part} — the source does not say what the injury is`)
      .replace(ACRONYMS, (m) => m.toUpperCase());
  }
  return "No diagnosis stated by the source";
}

/** True when we hold an actual named diagnosis, quoted. */
export function hasDiagnosis(e: Pick<StatusEvent, "injury_type">): boolean {
  return Boolean(e.injury_type);
}

/** How much weight the surface carries. Official is the promotion amending its own card. */
export const SOURCE_KIND_LABEL: Record<StatusEvent["source_kind"], string> = {
  official: "Official UFC",
  commission: "Athletic commission",
  news: "Reported",
  manual: "Desk-entered",
};

/** One line summarising an event, built only from fields we hold. */
export function statusHeadline(e: StatusEvent): string {
  const who = e.fighter_name;
  switch (e.status_type) {
    case "withdrawal":
      return `${who} is off ${e.event_name || "the card"}`;
    case "replacement":
      return e.replaced_fighter_name
        ? `${who} steps in for ${e.replaced_fighter_name}`
        : `${who} steps in${e.event_name ? ` at ${e.event_name}` : ""}`;
    case "weight_miss":
      return `${who} missed weight${e.event_name ? ` at ${e.event_name}` : ""}`;
    case "cleared":
      return `${who} has been cleared`;
    case "return":
      return `${who} is returning${e.event_name ? ` at ${e.event_name}` : ""}`;
    case "suspension":
      return `${who} is suspended`;
    case "visa_travel":
      return `${who} has a visa or travel issue`;
    case "illness":
      return `${who} is unavailable through illness`;
    case "injury":
      return `${who} is injured`;
    default:
      return `${who} — availability change`;
  }
}

/** The shape lib/slug.fighterSlug wants, from a status row. */
export function fighterRef(e: { fighter_name: string; fighter_espn_athlete_id: string | null; fighter_ufcstats_id: string | null }) {
  return { name: e.fighter_name, espn_athlete_id: e.fighter_espn_athlete_id, ufcstats_id: e.fighter_ufcstats_id };
}
