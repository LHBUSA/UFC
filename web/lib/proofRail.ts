/* Homepage Live Intelligence Proof Rail. Pure: no I/O.
 *
 * Answers "what is PropBetEdge covering right now?" in the order current card
 * → current intelligence → historical depth, from values the homepage already
 * holds plus one current-card Fight DNA readiness read. Nothing is hard-coded
 * and nothing is estimated: when a value cannot be established the cell says
 * so instead of printing a number. */

export type ProofCell = { key: "card" | "dna" | "archive" | "rounds"; kicker: string; value: string; unit?: string; sub: string; href: string | null; unavailable: boolean };
export type ProofRail = { cells: ProofCell[]; line: string | null };

export type ProofInput = {
  next: { name: string; event_date: string; slug: string } | null;
  /** Non-cancelled bouts on the next card. */
  liveBouts: Array<{ fighter_a: { id: string }; fighter_b: { id: string } }>;
  /** Current-card fighters with a usable Fight DNA profile; null when the read failed. */
  dnaReady: Set<string> | null;
  counts: { fighters: number | null; events: number | null; bouts: number | null; rounds: number | null };
  earliestEventDate: string | null;
  freshness: { finished_at: string | null; status: string | null } | null;
  now: number;
};

const n = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const plural = (x: number, one: string, many = `${one}s`) => `${x.toLocaleString("en-US")} ${x === 1 ? one : many}`;

/** 9,425 · 42K+ · 1.2M+. Rounds DOWN so a "+" is always true. */
export function compactCount(v: number): string {
  if (v >= 1_000_000) return `${(Math.floor(v / 100_000) / 10).toString()}M+`;
  if (v >= 10_000) return `${Math.floor(v / 1000)}K+`;
  return v.toLocaleString("en-US");
}

/** "UFC 331" from "UFC 331: Van vs. Pantoja 2"; a Fight Night keeps its date. */
export function shortCardName(name: string, eventDate: string): string {
  const head = name.split(":")[0].trim();
  if (/^UFC \d+$/.test(head)) return head;
  if (!eventDate) return head;
  const d = new Date(`${eventDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${head} · ${d}`;
}

export function relativeAge(iso: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} hr${h === 1 ? "" : "s"} ago`;
}

export function buildProofRail(i: ProofInput): ProofRail {
  const cells: ProofCell[] = [];
  const fighterIds = [...new Set(i.liveBouts.flatMap((b) => [b.fighter_a.id, b.fighter_b.id]))];

  // 1. CURRENT CARD
  if (i.next && i.liveBouts.length) {
    cells.push({ key: "card", kicker: "Current card", value: i.liveBouts.length.toLocaleString("en-US"), unit: i.liveBouts.length === 1 ? "bout" : "bouts", sub: `${shortCardName(i.next.name, i.next.event_date)} · full card tracked`, href: `/events/${i.next.slug}`, unavailable: false });
  } else if (i.next) {
    cells.push({ key: "card", kicker: "Current card", value: "Card forming", sub: `${shortCardName(i.next.name, i.next.event_date)} · bouts not yet announced`, href: `/events/${i.next.slug}`, unavailable: false });
  } else {
    cells.push({ key: "card", kicker: "Current card", value: "Between cards", sub: "Next UFC card not yet scheduled", href: "/events", unavailable: true });
  }

  // 2. FIGHT DNA on the current card — readiness only when it was actually read.
  if (fighterIds.length && i.dnaReady) {
    const ready = fighterIds.filter((id) => i.dnaReady!.has(id)).length;
    cells.push({ key: "dna", kicker: "Fight DNA", value: `${ready} / ${fighterIds.length}`, sub: "Current-card profiles ready", href: "/learn/fight-dna", unavailable: false });
  } else if (fighterIds.length) {
    cells.push({ key: "dna", kicker: "Fight DNA", value: fighterIds.length.toLocaleString("en-US"), unit: fighterIds.length === 1 ? "fighter" : "fighters", sub: "Current-card dossiers", href: "/fighters", unavailable: false });
  } else if (n(i.counts.fighters)) {
    cells.push({ key: "dna", kicker: "Fighter dossiers", value: compactCount(i.counts.fighters), sub: "Fighter identities indexed", href: "/fighters", unavailable: false });
  } else {
    cells.push({ key: "dna", kicker: "Fight DNA", value: "—", sub: "Coverage unavailable", href: "/learn/fight-dna", unavailable: true });
  }

  // 3. HISTORICAL ARCHIVE
  const from = i.earliestEventDate ? i.earliestEventDate.slice(0, 4) : null;
  cells.push(n(i.counts.events)
    ? { key: "archive", kicker: "Historical archive", value: i.counts.events.toLocaleString("en-US"), unit: i.counts.events === 1 ? "event" : "events", sub: from ? `Fight archive · ${from} → today` : "Fight archive indexed", href: "/history", unavailable: false }
    : { key: "archive", kicker: "Historical archive", value: "—", sub: "Archive count unavailable", href: "/history", unavailable: true });

  // 4. ROUND INTELLIGENCE
  cells.push(n(i.counts.rounds)
    ? { key: "rounds", kicker: "Round intelligence", value: compactCount(i.counts.rounds), sub: "Source-linked round-stat rows", href: "/round-by-round", unavailable: false }
    : { key: "rounds", kicker: "Round intelligence", value: "—", sub: "Round-stat count unavailable", href: "/round-by-round", unavailable: true });

  // Supporting line: only real counts; the freshness phrase only for a recent,
  // successful run of the production schedule/results ingest.
  const parts: string[] = [];
  if (n(i.counts.fighters) && fighterIds.length) parts.push(plural(i.counts.fighters, "fighter identity", "fighter identities"));
  if (n(i.counts.bouts)) parts.push(`${i.counts.bouts.toLocaleString("en-US")} bouts indexed`);
  const f = i.freshness;
  const fresh = f?.finished_at && f.status === "success" && i.now - Date.parse(f.finished_at) >= 0 && i.now - Date.parse(f.finished_at) < 36 * 3600e3;
  if (parts.length) parts.push(fresh ? `Data checked ${relativeAge(f!.finished_at!, i.now)}` : "live data layer");
  return { cells, line: parts.length ? parts.join(" · ") : null };
}
