/* Turning internal provenance into something a reader can use.
 *
 * The content plan records where every number came from, and it records it in
 * our own vocabulary -- table names, definition versions, column paths -- because
 * that is the form in which the claim can actually be checked by us. That
 * precision is worth keeping. It just isn't what a reader needs.
 *
 * "Source: ufc_fighter_dna_snapshots round_profile" tells a reader nothing
 * except that they are looking at somebody's console. "PropBetEdge Fight DNA,
 * round-by-round profile" tells them exactly the same fact in language they can
 * evaluate. Nothing is hidden by this translation: the claim is identical, and
 * the stored plan keeps the precise form for our own auditing.
 *
 * TRANSLATION IS THE DEFAULT, NOT AN OPT-IN.
 *
 * Every caller gets the reader-facing string. There is no "show raw" flag on
 * the public path, because a flag is a thing that can be left off -- and the
 * failure mode of forgetting is publishing an engineering receipt. The precise
 * provenance still exists in the stored content plan and in telemetry, which is
 * where it belongs.
 */

/** Ordered: the first pattern that matches wins, so specific beats general. */
const RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  /* Fight DNA, with its as-of date. The definition version is ours, not the
   * reader's -- the date is the part that tells them how current this is. */
  [
    /ufc_fighter_dna_snapshots\s*\(definition v[\w.]+,\s*as of ([\d-]+)\)/i,
    (m) => `PropBetEdge Fight DNA, as of ${friendlyDate(m[1])}`,
  ],
  [/ufc_fighter_dna_snapshots\s+round_profile/i, () => "PropBetEdge Fight DNA, round-by-round profile"],
  [/ufc_fighter_dna_snapshots/i, () => "PropBetEdge Fight DNA"],

  /* Market. The observation time is a real caveat and must survive: a price is
   * only true as of when it was seen. */
  [
    /ufc_market_observations,\s*(\d+)\s*prices observed\s*(\S+)/i,
    (m) => `${m[1]} verified sportsbook prices, observed ${friendlyDate(m[2])}`,
  ],
  [/ufc_market_observations/i, () => "verified sportsbook prices"],

  [/ufc_fighters\s+career averages/i, () => "PropBetEdge fighter profiles, career averages"],
  [/ufc_bout_round_stats/i, () => "PropBetEdge round-by-round statistics"],
  [/ufc_bout_results\s+archive/i, () => "PropBetEdge bout history"],
  [/ufc_bout_results/i, () => "PropBetEdge bout history"],
  [/ufc_rankings/i, () => "PropBetEdge rankings"],
  [/ufc_fighters/i, () => "PropBetEdge fighter profiles"],
  [/ufc_bouts/i, () => "PropBetEdge bout records"],
  [/ufc_events/i, () => "PropBetEdge event records"],
  [/ufc_videos/i, () => "official UFC video channels"],
  [/ufc_images|ufc_media/i, () => "rights-cleared image library"],
];

/** Plain-English name for one internal data family. */
export function readableSource(raw: string | null | undefined): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  for (const [re, out] of RULES) {
    const m = s.match(re);
    if (m) return out(m);
  }
  /* Unknown provenance string. Rather than print something that might be a
   * table name we have not mapped yet, say the honest general thing. A new
   * chart source should be added to RULES; until it is, the reader gets a true
   * statement instead of a leak. */
  return /^[a-z0-9_]+$/i.test(s.replace(/\s+/g, "")) ? "PropBetEdge first-party data" : s;
}

/** The reader-facing names of the data families an article drew on. */
const FAMILY_LABELS: Record<string, string> = {
  ufc_fighters: "Fighter profiles",
  ufc_bouts: "Bout history",
  ufc_bout_results: "Bout history",
  ufc_bout_round_stats: "Round statistics",
  ufc_rankings: "Rankings",
  ufc_fighter_dna_snapshots: "Fight DNA",
  ufc_market_observations: "Market data",
  ufc_videos: "Official video",
  ufc_events: "Event records",
};

export function readableFamilies(tables: string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const t of tables || []) {
    const label = FAMILY_LABELS[String(t).trim()];
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

function friendlyDate(raw: string): string {
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return raw;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/* The same families as a natural sentence fragment.
 *
 * Lowercasing the label list wholesale turned "Fight DNA" into "fight dna",
 * which reads as a typo in the one place the page is asking to be trusted. So
 * inline phrasing is declared rather than derived: generic families are
 * lowercase because they are common nouns, and Fight DNA keeps its capitals
 * because it is a name. */
const FAMILY_INLINE: Record<string, string> = {
  "Fighter profiles": "fighter profiles",
  "Bout history": "bout history",
  "Round statistics": "round-by-round statistics",
  Rankings: "rankings",
  "Fight DNA": "Fight DNA",
  "Market data": "recorded market prices",
  "Official video": "official video",
  "Event records": "event records",
};

export function familiesSentence(tables: string[] | null | undefined): string | null {
  const parts = readableFamilies(tables).map((f) => FAMILY_INLINE[f] || f.toLowerCase());
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
