/* Card truth for the web: which bouts are still on the card, and the story of the ones that are not.
 *
 * Pure: no imports with side effects, no I/O, no clock, so it is directly testable.
 *
 * WHY THIS EXISTS. `ufc_bouts.status` is not the whole truth. When ESPN drops a
 * competition from a card the ingest does NOT rewrite the bout (migration 029,
 * defect D1, written for UFC 331 Moicano vs Ortega): the row stays `announced`
 * and the fact lives in `ufc_event_card_observations`, the append-only ledger of
 * what the card listed on each pass. PBE Algo has read that ledger since D1. The
 * web never did, so the weigh-in desk kept counting both men as "expected" and
 * "pending" for a fight that had been off the card for three days.
 *
 * A bout is OFF the card when any of these is true:
 *   status            ufc_bouts.status is cancelled / replaced / withdrawn
 *   card_observation  the newest COMPLETE observation no longer lists its competition
 *   withdrawal        an active sourced `withdrawal` status event names this bout (or this
 *                     event and one of its two fighters) and the bout has no result
 * `cardTruth()` is the same rule workers/ufc-algo/src/cardTruth.js applies (parity is
 * tested). Unlike the Algo, the web only ACTS on `missing`: an incomplete read, a
 * placeholder or a bout without a source id is ambiguous, and an ambiguous card must
 * not make fighters vanish from a public page.
 *
 * Nothing here deletes or rewrites a bout. A removed bout stays a bout: it moves from
 * the active card to the card-changes list, with the reason the SOURCES gave. The
 * reason is assembled only from structured status events — a withdrawal, and an
 * injury / illness / visa / suspension event for the same fighter and card. Where no
 * such event exists the story says so. It never guesses. */

export type CardObservation = { observed_at: string | null; source?: string | null; competition_ids: string[] | null; placeholder_ids: string[] | null; complete: boolean | null };

export type TruthState = "confirmed" | "unobserved" | "missing" | "placeholder" | "no_source_id" | "incomplete";
export const CARD_TRUTH_BLOCKING: readonly TruthState[] = ["missing", "placeholder", "no_source_id", "incomplete"];

export function cardTruth(bout: { espn_competition_id?: string | null }, observation: CardObservation | null | undefined): { state: TruthState; blocking: boolean; observed_at: string | null; source?: string | null } {
  if (!observation) return { state: "unobserved", blocking: false, observed_at: null };
  const base = { observed_at: observation.observed_at ?? null, source: observation.source ?? null };
  let state: TruthState;
  if (observation.complete !== true) state = "incomplete";
  else if (!bout.espn_competition_id) state = "no_source_id";
  else if ((observation.competition_ids || []).map(String).includes(String(bout.espn_competition_id))) state = "confirmed";
  else if ((observation.placeholder_ids || []).map(String).includes(String(bout.espn_competition_id))) state = "placeholder";
  else state = "missing";
  return { ...base, state, blocking: CARD_TRUTH_BLOCKING.includes(state) };
}

/* ---- inputs ------------------------------------------------------------ */

export type CardBout = {
  id: string;
  espn_competition_id?: string | null;
  status: string | null;
  fighter_a_id: string | null;
  fighter_b_id: string | null;
  card_position?: string | null;
  bout_order?: number | null;
  weight_class?: string | null;
  has_result?: boolean;
};

/** The subset of a fighter status event this module reads (lib/status-display StatusEvent satisfies it). */
export type CardStatusEvent = {
  id: string;
  fighter_id: string;
  fighter_name: string;
  status_type: string;
  state: string;
  event_id: string | null;
  bout_id: string | null;
  replacement_fighter_name?: string | null;
  source_url: string;
  source_name: string;
  source_kind: "official" | "commission" | "news" | "manual";
  source_published_at?: string | null;
  confidence: number;
  occurred_at: string;
};

const OFF_STATUSES = new Set(["cancelled", "canceled", "replaced", "withdrawn"]);
/* What a sourced reason may be built from, and the words it licenses. `injury` licenses the
 * word "injury" and nothing more: no body part, no diagnosis (see lib/status-display). */
const REASON_WORDS: Record<string, string> = {
  injury: "due to injury", illness: "due to illness", visa_travel: "due to a visa or travel issue",
  suspension: "following a suspension", weight_miss: "after a weight issue",
};
const SOURCE_RANK: Record<CardStatusEvent["source_kind"], number> = { official: 0, commission: 1, manual: 2, news: 3 };

export type RemovalBasis = "status" | "card_observation" | "withdrawal";

export type CardChange = {
  bout: CardBout;
  /** Every independent reason this bout is off the card, strongest first. */
  basis: RemovalBasis[];
  /** true: the canonical status or the official card listing says it is gone. false: a withdrawal has been
   *  REPORTED and the official card still lists the bout. The desk stops expecting it either way (as PBE Algo
   *  does), but it never calls a reported withdrawal a removal. */
  confirmed: boolean;
  /** The fighter the sources say withdrew, if any. */
  withdrew: { fighter_id: string; fighter_name: string } | null;
  /** "due to injury" etc., or null when no source gave a reason. */
  reasonWords: string | null;
  /** One sentence for the desk. Built only from the fields above. */
  story: string;
  /** Best receipt for the change (official > commission > desk > news, then confidence, then recency). */
  source: { name: string; url: string; kind: CardStatusEvent["source_kind"]; published_at: string | null; reported_at: string } | null;
  receipts: number;
  /** When the withdrawal was first reported, and when the official card stopped listing the bout. */
  reported_at: string | null;
  off_card_since: string | null;
  replacement_fighter_name: string | null;
  /** Fighters of this bout who are still on the active card in another bout (a replacement was found). */
  still_on_card: string[];
};

export type CardSplit = { active: CardBout[]; changes: CardChange[] };

const ts = (s: string | null | undefined) => { const n = s ? Date.parse(s) : NaN; return Number.isFinite(n) ? n : 0; };

/**
 * `observations` newest first. Only the newest decides whether a bout is on the card; the
 * older ones date the change ("not listed since").
 */
export function splitCard(
  bouts: readonly CardBout[],
  observations: readonly CardObservation[],
  statusEvents: readonly CardStatusEvent[],
  ctx: { eventId: string; eventName?: string | null },
): CardSplit {
  const newest = observations[0] || null;
  const active: CardBout[] = [];
  const off: Array<{ bout: CardBout; basis: RemovalBasis[] }> = [];

  for (const b of bouts) {
    const basis: RemovalBasis[] = [];
    const settled = b.has_result === true || b.status === "complete";
    if (b.status && OFF_STATUSES.has(b.status)) basis.push("status");
    /* A fought bout is history, whatever a later observation of an old card says. */
    if (!settled && cardTruth(b, newest).state === "missing") basis.push("card_observation");
    if (!settled && withdrawalsFor(b, statusEvents, ctx.eventId).length) basis.push("withdrawal");
    if (basis.length) off.push({ bout: b, basis }); else active.push(b);
  }

  const activeFighters = new Set(active.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]).filter(Boolean) as string[]);
  const changes = off.map(({ bout, basis }) => describe(bout, basis, observations, statusEvents, ctx, activeFighters));
  changes.sort((x, y) => (y.bout.bout_order ?? -1) - (x.bout.bout_order ?? -1) || x.bout.id.localeCompare(y.bout.id));
  return { active, changes };
}

/** Active, sourced withdrawals that are about THIS bout: linked to it, or to this event and one of its corners. */
function withdrawalsFor(b: CardBout, events: readonly CardStatusEvent[], eventId: string): CardStatusEvent[] {
  const corners = new Set([b.fighter_a_id, b.fighter_b_id].filter(Boolean) as string[]);
  return events.filter((e) => e.status_type === "withdrawal" && e.state === "active" && corners.has(e.fighter_id)
    && (e.bout_id ? e.bout_id === b.id : e.event_id === eventId));
}

function describe(bout: CardBout, basis: RemovalBasis[], observations: readonly CardObservation[], events: readonly CardStatusEvent[], ctx: { eventId: string; eventName?: string | null }, activeFighters: Set<string>): CardChange {
  const corners = new Set([bout.fighter_a_id, bout.fighter_b_id].filter(Boolean) as string[]);
  /* Everything the sources said about either corner ON THIS CARD. Never another card's injury. */
  const about = events.filter((e) => corners.has(e.fighter_id) && (e.bout_id ? e.bout_id === bout.id : e.event_id === ctx.eventId));
  const withdrawals = about.filter((e) => e.status_type === "withdrawal");
  const byPriority = (a: CardStatusEvent, b: CardStatusEvent) =>
    SOURCE_RANK[a.source_kind] - SOURCE_RANK[b.source_kind] || Number(b.confidence || 0) - Number(a.confidence || 0) || ts(b.occurred_at) - ts(a.occurred_at) || a.id.localeCompare(b.id);
  const primary = [...withdrawals].sort(byPriority)[0] || null;

  /* Who withdrew: only when every withdrawal names the same corner. Two different names is a conflict, and a conflict says less. */
  const who = [...new Set(withdrawals.map((e) => e.fighter_id))];
  const withdrew = who.length === 1 && primary ? { fighter_id: primary.fighter_id, fighter_name: primary.fighter_name } : null;

  /* Why: a cause event for the SAME fighter on the SAME card, and only when the sources agree on the kind. */
  const causes = withdrew ? [...new Set(about.filter((e) => e.fighter_id === withdrew.fighter_id && REASON_WORDS[e.status_type]).map((e) => e.status_type))] : [];
  const reasonWords = causes.length === 1 ? REASON_WORDS[causes[0]] : null;

  const where = ctx.eventName ? `from ${ctx.eventName}` : "from the card";
  const confirmed = basis.includes("status") || basis.includes("card_observation");
  const why = reasonWords ? ` ${reasonWords}` : "";
  const story = confirmed
    ? (withdrew
      ? `Bout removed ${where} after ${withdrew.fighter_name} withdrew${why}.${reasonWords ? "" : " The sources do not state a reason."}`
      : `Bout removed ${where}. A specific reason is not recorded in our verified sources.`)
    : (withdrew
      ? `${withdrew.fighter_name} is reported to have withdrawn ${where}${why}.${reasonWords ? "" : " The sources do not state a reason."} The official card still lists this bout.`
      : `A withdrawal from this bout has been reported. The official card still lists this bout.`);

  /* Since when: the run of newest observations, read backwards, that do not list this competition. */
  let offCardSince: string | null = null;
  if (basis.includes("card_observation")) {
    for (const o of observations) { if (cardTruth(bout, o).state === "missing") offCardSince = o.observed_at; else break; }
  }
  const replacement = [...about].sort((a, b) => ts(b.occurred_at) - ts(a.occurred_at)).find((e) => e.replacement_fighter_name)?.replacement_fighter_name ?? null;

  return {
    bout, basis, confirmed, withdrew, reasonWords, story,
    source: primary ? { name: primary.source_name, url: primary.source_url, kind: primary.source_kind, published_at: primary.source_published_at ?? null, reported_at: primary.occurred_at } : null,
    receipts: new Set(about.filter((e) => e.status_type === "withdrawal" || REASON_WORDS[e.status_type]).map((e) => e.source_url.replace(/[?#].*$/, ""))).size,
    reported_at: withdrawals.length ? [...withdrawals].sort((a, b) => ts(a.occurred_at) - ts(b.occurred_at))[0].occurred_at : null,
    off_card_since: offCardSince,
    replacement_fighter_name: replacement,
    still_on_card: [...corners].filter((id) => activeFighters.has(id)),
  };
}

/** Fighters a weigh-in is expected from: the corners of ACTIVE bouts, each once. */
export function expectedFighterIds(active: readonly CardBout[]): string[] {
  return [...new Set(active.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]).filter(Boolean) as string[])];
}

export const BASIS_LABEL: Record<RemovalBasis, string> = {
  status: "Marked cancelled on the canonical card",
  card_observation: "No longer listed on the official card",
  withdrawal: "Sourced withdrawal",
};
