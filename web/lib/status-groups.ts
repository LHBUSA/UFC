/* Availability episodes: the presentation grouping over status receipts.
 *
 * A row in ufc_fighter_status_events is a SOURCE RECEIPT — one publisher saying
 * one thing about one fighter. Six outlets reporting that Brian Ortega is off
 * UFC 331 are six valid receipts and one real-world fact. The board shows the
 * fact once and keeps every receipt underneath it.
 *
 * Pure, with no imports beyond the display rules, for the same reason
 * status-display.ts is: this is a place the "never infer a diagnosis" rule
 * could be broken (by stitching one report's body part to another's severity),
 * so it has to be directly testable.
 *
 * NOTHING HERE WRITES. Raw StatusEvent rows pass through untouched; grouping
 * only decides which card a receipt is listed under.
 *
 * Grouping is conservative on purpose. A wrong merge hides a real, separate
 * availability problem behind another one; a missed merge costs one extra card.
 * Those are not the same size of mistake, so every ambiguous case splits.
 */
import {
  UNAVAILABLE, diagnosisLine, hasDiagnosis,
  type StatusEvent, type StatusState, type StatusType,
} from "./status-display.ts";

/** What kind of real-world thing the episode is. */
export type EpisodeKind =
  | "unavailability"   // injury / illness / withdrawal
  | "resolution"       // cleared / return
  | "suspension" | "visa_travel" | "weight_miss" | "replacement" | "other";

export type EpisodeClinical =
  /* No receipt named anything. */
  | { status: "none"; line: string; receipt: null }
  /* Exactly one receipt-backed claim, taken whole from ONE receipt. */
  | { status: "stated"; line: string; receipt: StatusEvent; diagnosed: boolean }
  /* Receipts disagree. No episode-level medical conclusion is drawn. */
  | { status: "conflict"; line: string; receipt: null };

export type AvailabilityEpisode = {
  /** Stable for a given set of receipts: safe as a React key and an anchor. */
  key: string;
  kind: EpisodeKind;
  fighter_id: string;
  fighter_name: string;
  state: StatusState;
  /** The user-facing outcome. A withdrawal outranks the injury that caused it. */
  primaryType: StatusType;
  /** Every distinct status_type among the receipts, primary first. */
  types: StatusType[];
  /** The receipt that supplies headline / date / source for the card. */
  primary: StatusEvent;
  /** All unique receipts, in primary-selection order. Never empty. */
  receipts: StatusEvent[];
  /** Exact duplicate rows folded into a receipt above (same URL, card, type). */
  suppressedDuplicates: number;
  unavailable: boolean;
  hasOfficial: boolean;
  event_id: string | null;
  event_name: string | null;
  event_date: string | null;
  bout_id: string | null;
  replacement_fighter_name: string | null;
  replaced_fighter_name: string | null;
  expected_return_note: string | null;
  clinical: EpisodeClinical;
  /** Newest occurred_at across the receipts. */
  updatedAt: string;
};

/* ---- vocabulary -------------------------------------------------------- */

const UNAVAILABILITY: ReadonlySet<StatusType> = new Set<StatusType>(["injury", "illness", "withdrawal"]);
const RESOLUTION: ReadonlySet<StatusType> = new Set<StatusType>(["cleared", "return"]);

export function episodeKind(t: StatusType): EpisodeKind {
  if (UNAVAILABILITY.has(t)) return "unavailability";
  if (RESOLUTION.has(t)) return "resolution";
  return t as EpisodeKind;
}

/* official > commission > desk correction > reporting. Same order as
 * docs/fighter_status.md; lower sorts first. */
const SOURCE_RANK: Record<StatusEvent["source_kind"], number> = {
  official: 0, commission: 1, manual: 2, news: 3,
};

/* Inside one episode, which status is the consequence the reader cares about.
 * Being off the card is the availability fact; the injury is its cause. */
const OUTCOME_RANK: Partial<Record<StatusType, number>> = {
  withdrawal: 0, injury: 1, illness: 2,
  return: 0, cleared: 1,
};

/* Reports with no card attached are only the same episode when they arrive
 * together. Two "injured" reports a year apart are two injuries. The chain is
 * gap-based: each receipt must sit within this window of its neighbour. */
export const UNLINKED_WINDOW_DAYS = 45;
const DAY_MS = 86_400_000;

/* ---- helpers ----------------------------------------------------------- */

const ts = (s: string | null | undefined) => {
  const n = s ? Date.parse(s) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Identity is the fighter_id. A name is only a fallback for rows without one,
 *  and then it is matched exactly — never fuzzily, never across an id. */
function fighterKey(e: StatusEvent): string {
  if (e.fighter_id) return `id:${e.fighter_id}`;
  return `name:${String(e.fighter_name || "").trim().toLowerCase()}`;
}

const cleanUrl = (u: string) => String(u || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

/** The deterministic receipt order; index 0 of the result is the primary. */
export function compareReceipts(a: StatusEvent, b: StatusEvent): number {
  return (
    (OUTCOME_RANK[a.status_type] ?? 9) - (OUTCOME_RANK[b.status_type] ?? 9) ||
    SOURCE_RANK[a.source_kind] - SOURCE_RANK[b.source_kind] ||
    Number(b.confidence || 0) - Number(a.confidence || 0) ||
    ts(b.occurred_at) - ts(a.occurred_at) ||
    String(a.id).localeCompare(String(b.id))
  );
}

/* Which copy of an exact-duplicate receipt survives: the better-sourced one. */
function betterDuplicate(a: StatusEvent, b: StatusEvent): StatusEvent {
  return compareReceipts(a, b) <= 0 ? a : b;
}

/** One value only when every receipt that states it agrees. */
function agreed(values: (string | null | undefined)[]): string | null {
  const distinct = [...new Set(values.map((v) => (v || "").trim()).filter(Boolean))];
  return distinct.length === 1 ? distinct[0] : null;
}

/**
 * The episode-level medical line.
 *
 * Taken WHOLE from one receipt, never assembled. If one report says "knee" and
 * another says "torn ACL", rendering "torn ACL (knee)" would be a claim neither
 * source made on its own; and if two reports name different things, picking one
 * is a medical conclusion we are not entitled to. Both cases fall back to
 * saying less, and the receipts keep exactly what each source said.
 */
function clinicalFor(receipts: StatusEvent[]): EpisodeClinical {
  const norm = (v: string | null) => (v || "").trim().toLowerCase();
  const diagnoses = new Set(receipts.map((r) => norm(r.injury_type)).filter(Boolean));
  const parts = new Set(receipts.map((r) => norm(r.body_part)).filter(Boolean));
  const sides = new Set(receipts.map((r) => norm(r.injury_side)).filter(Boolean));

  if (!diagnoses.size && !parts.size) {
    return { status: "none", line: diagnosisLine({ injury_type: null, body_part: null, injury_side: null }), receipt: null };
  }
  if (diagnoses.size > 1 || parts.size > 1 || sides.size > 1) {
    return {
      status: "conflict",
      line: "Sources differ on the medical detail — no single diagnosis is shown. Each receipt keeps what its source said.",
      receipt: null,
    };
  }
  /* receipts is already in priority order; the first one that carries the most
   * specific claim supplies the whole line, its side and its quote together. */
  const receipt = receipts.find((r) => hasDiagnosis(r)) || receipts.find((r) => r.body_part)!;
  return { status: "stated", line: diagnosisLine(receipt), receipt, diagnosed: hasDiagnosis(receipt) };
}

/* ---- grouping ---------------------------------------------------------- */

export function groupStatusEvents(events: readonly StatusEvent[]): AvailabilityEpisode[] {
  /* A bout belongs to one event. Some receipts carry only the event and some
   * carry the bout too, so resolve every bout to its event first; otherwise the
   * same withdrawal splits on which outlet happened to name the opponent. */
  const boutEvent = new Map<string, string>();
  for (const e of events) if (e.bout_id && e.event_id && !boutEvent.has(e.bout_id)) boutEvent.set(e.bout_id, e.event_id);
  const cardKey = (e: StatusEvent): string | null => {
    if (e.event_id) return `event:${e.event_id}`;
    if (e.bout_id) return boutEvent.has(e.bout_id) ? `event:${boutEvent.get(e.bout_id)}` : `bout:${e.bout_id}`;
    return null;
  };

  /* Pass 1 — buckets. Card-linked rows bucket by kind (injury + withdrawal for
   * the same card are one episode). Unlinked rows bucket by exact status_type,
   * so an unlinked injury never absorbs an unlinked illness or withdrawal. */
  const buckets = new Map<string, StatusEvent[]>();
  for (const e of events) {
    const card = cardKey(e);
    const kind = episodeKind(e.status_type);
    const what = card ? kind : kind === "resolution" ? kind : e.status_type;
    const k = [fighterKey(e), e.state, what, card ?? "no-card"].join("|");
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(e);
  }

  /* Pass 2 — unlinked buckets split wherever the reporting goes quiet. */
  const clusters: StatusEvent[][] = [];
  for (const [k, rows] of buckets) {
    if (!k.endsWith("|no-card")) { clusters.push(rows); continue; }
    const sorted = [...rows].sort((a, b) => ts(a.occurred_at) - ts(b.occurred_at));
    let run: StatusEvent[] = [];
    for (const r of sorted) {
      const prev = run[run.length - 1];
      if (prev && ts(r.occurred_at) - ts(prev.occurred_at) > UNLINKED_WINDOW_DAYS * DAY_MS) { clusters.push(run); run = []; }
      run.push(r);
    }
    if (run.length) clusters.push(run);
  }

  /* Pass 3 — fold exact duplicate receipts, pick the primary, summarise. */
  return clusters.map((rows) => {
    const unique = new Map<string, StatusEvent>();
    for (const r of rows) {
      const k = [cleanUrl(r.source_url), r.status_type, cardKey(r) ?? "no-card"].join("|");
      unique.set(k, unique.has(k) ? betterDuplicate(unique.get(k)!, r) : r);
    }
    const receipts = [...unique.values()].sort(compareReceipts);
    const primary = receipts[0];
    const types = [...new Set(receipts.map((r) => r.status_type))];
    const withCard = receipts.find((r) => r.event_id) || receipts.find((r) => r.bout_id) || null;
    const newest = [...receipts].sort((a, b) => ts(b.occurred_at) - ts(a.occurred_at) || String(a.id).localeCompare(String(b.id)));
    const kind = episodeKind(primary.status_type);

    return {
      key: `${fighterKey(primary)}|${primary.state}|${kind}|${cardKey(primary) ?? `t${newest[newest.length - 1].id}`}`,
      kind,
      fighter_id: primary.fighter_id,
      fighter_name: primary.fighter_name,
      state: primary.state,
      primaryType: primary.status_type,
      types,
      primary,
      receipts,
      suppressedDuplicates: rows.length - receipts.length,
      unavailable: primary.state === "active" && UNAVAILABLE.has(primary.status_type),
      hasOfficial: receipts.some((r) => r.source_kind === "official"),
      event_id: withCard?.event_id ?? null,
      event_name: receipts.find((r) => r.event_name)?.event_name ?? null,
      event_date: receipts.find((r) => r.event_date)?.event_date ?? null,
      bout_id: receipts.find((r) => r.bout_id)?.bout_id ?? null,
      /* A replacement can change; the newest sourced name is the current one. */
      replacement_fighter_name: newest.find((r) => r.replacement_fighter_name)?.replacement_fighter_name ?? null,
      replaced_fighter_name: newest.find((r) => r.replaced_fighter_name)?.replaced_fighter_name ?? null,
      /* A return date is a claim: shown only when every source that gives one agrees. */
      expected_return_note: agreed(receipts.map((r) => r.expected_return_note)),
      clinical: kind === "unavailability"
        ? clinicalFor(receipts)
        : { status: "none", line: "", receipt: null },
      updatedAt: newest[0].occurred_at,
    } satisfies AvailabilityEpisode;
  });
}

/* ---- filtering --------------------------------------------------------- */

export const TYPE_FILTERS = [
  { key: "all", label: "All types", types: null },
  { key: "withdrawals", label: "Withdrawals", types: ["withdrawal"] },
  { key: "medical", label: "Injury / illness", types: ["injury", "illness"] },
  { key: "suspensions", label: "Suspensions", types: ["suspension"] },
  { key: "visa", label: "Visa / travel", types: ["visa_travel"] },
  { key: "weight", label: "Weight issues", types: ["weight_miss"] },
  { key: "replacements", label: "Replacements", types: ["replacement"] },
  { key: "returns", label: "Returns / cleared", types: ["return", "cleared"] },
] as const satisfies readonly { key: string; label: string; types: readonly StatusType[] | null }[];

export type TypeFilterKey = (typeof TYPE_FILTERS)[number]["key"];

export function parseTypeFilter(raw: string | null | undefined): TypeFilterKey {
  return TYPE_FILTERS.find((f) => f.key === raw)?.key ?? "all";
}

/** Filters EPISODES. An episode matches when any of its receipts is of the
 *  type — a withdrawal caused by an injury is findable under both. */
export function filterEpisodes(episodes: readonly AvailabilityEpisode[], key: TypeFilterKey): AvailabilityEpisode[] {
  const f = TYPE_FILTERS.find((x) => x.key === key);
  if (!f || !f.types) return [...episodes];
  const want = new Set<StatusType>(f.types);
  return episodes.filter((ep) => ep.types.some((t) => want.has(t)));
}

/* ---- sorting ----------------------------------------------------------- */

export type BoardView = StatusState | "all";

/** Source count never ranks anything: five blogs do not outrank one fact. */
export function sortEpisodes(episodes: readonly AvailabilityEpisode[], view: BoardView, now: Date = new Date()): AvailabilityEpisode[] {
  const newestFirst = (a: AvailabilityEpisode, b: AvailabilityEpisode) =>
    ts(b.updatedAt) - ts(a.updatedAt) || a.key.localeCompare(b.key);
  if (view !== "active") return [...episodes].sort(newestFirst);

  const today = now.toISOString().slice(0, 10);
  const upcoming = (ep: AvailabilityEpisode) => Boolean(ep.event_date && ep.event_date.slice(0, 10) >= today);
  const tier = (ep: AvailabilityEpisode) => (ep.unavailable ? (upcoming(ep) ? 0 : 1) : 2);
  return [...episodes].sort((a, b) => {
    const d = tier(a) - tier(b);
    if (d) return d;
    if (tier(a) === 0) {
      const byCard = String(a.event_date).slice(0, 10).localeCompare(String(b.event_date).slice(0, 10));
      if (byCard) return byCard;
    }
    return newestFirst(a, b);
  });
}

/* ---- board metrics ----------------------------------------------------- */

export type BoardSummary = {
  episodes: number;
  fighters: number;
  unavailableFighters: number;
  verifiedDiagnoses: number;
  receipts: number;
};

/** Every number on the hero comes from the same episodes the board renders. */
export function summarizeEpisodes(episodes: readonly AvailabilityEpisode[]): BoardSummary {
  const who = (ep: AvailabilityEpisode) => ep.fighter_id || `name:${ep.fighter_name.trim().toLowerCase()}`;
  return {
    episodes: episodes.length,
    fighters: new Set(episodes.map(who)).size,
    unavailableFighters: new Set(episodes.filter((ep) => ep.unavailable).map(who)).size,
    verifiedDiagnoses: episodes.filter((ep) => ep.clinical.status === "stated" && ep.clinical.diagnosed).length,
    receipts: episodes.reduce((n, ep) => n + ep.receipts.length, 0),
  };
}

/** Headline state for the card: the consequence, in one or two words. */
export function episodeStateLabel(ep: AvailabilityEpisode): string {
  if (ep.state === "resolved") return "Resolved";
  if (ep.state === "expired") return "Expired";
  if (ep.unavailable) return "Unavailable";
  if (ep.kind === "resolution") return "Available";
  return "Availability change";
}
