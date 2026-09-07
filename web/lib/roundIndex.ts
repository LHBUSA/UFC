import "server-only";

/* Discovery data for /round-by-round.
 *
 * The index only ever lists bouts that actually have round observations
 * stored. It does not list "fights we might have data for", because the whole
 * point of the surface is that everything on it can be opened and read. A
 * category with nothing behind it is omitted rather than shown empty.
 *
 * One paged read of the round-stat table gives coverage for every bout at
 * once, which is far cheaper than asking per bout and keeps this page a
 * single round trip regardless of how far the backfill has advanced.
 */
const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export type RoundIndexBout = {
  boutId: string;
  eventId: string;
  eventName: string;
  eventDate: string | null;
  fighterA: { id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null };
  fighterB: { id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null };
  weightClass: string | null;
  isWomens: boolean;
  isTitle: boolean;
  boutOrder: number | null;
  method: string | null;
  finishRound: number | null;
  winnerId: string | null;
  /* How many distinct rounds we hold observations for, and whether both
   * corners are present in every one of them. */
  roundsCovered: number;
  bothCorners: boolean;
  scheduledRounds: number | null;
};

type BoutRow = {
  id: string; event_id: string; fighter_a_id: string; fighter_b_id: string;
  weight_class: string | null; is_womens: boolean | null; is_title: boolean | null;
  bout_order: number | null; scheduled_rounds: number | null; status: string | null;
};
type EventRow = { id: string; name: string; event_date: string | null };
type FighterRow = { id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null };
type ResultRow = { bout_id: string; method: string | null; round: number | null; winner_id: string | null };
type StatRow = { bout_id: string; fighter_id: string; round: number };

/* Paged reader. PostgREST caps rows per response, so coverage for the whole
 * archive is walked with range headers rather than requested in one go. */
async function all<T>(path: string, pageSize = 1000): Promise<T[]> {
  if (!URL_ || !KEY) return [];
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    try {
      const res = await fetch(`${URL_}/rest/v1/${path}`, {
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`,
          Accept: "application/json",
          Range: `${from}-${from + pageSize - 1}`,
        },
        next: { revalidate: 300 },
      });
      if (!res.ok) return out;
      const rows = (await res.json()) as T[];
      if (!Array.isArray(rows)) return out;
      out.push(...rows);
      if (rows.length < pageSize) break;
    } catch {
      return out;
    }
  }
  return out;
}

export type RoundIndex = {
  bouts: RoundIndexBout[];
  totals: { eligible: number; byRounds: Record<number, number>; bothCorners: number };
};

export async function getRoundIndex(): Promise<RoundIndex> {
  const [stats, bouts, events, results, fighters] = await Promise.all([
    all<StatRow>("ufc_bout_round_stats?select=bout_id,fighter_id,round"),
    all<BoutRow>("ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,weight_class,is_womens,is_title,bout_order,scheduled_rounds,status"),
    all<EventRow>("ufc_events?select=id,name,event_date"),
    all<ResultRow>("ufc_bout_results?select=bout_id,method,round,winner_id"),
    all<FighterRow>("ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id"),
  ]);

  /* Coverage per bout: which rounds exist, and how many corners in each. */
  const cover = new Map<string, Map<number, Set<string>>>();
  for (const s of stats) {
    let byRound = cover.get(s.bout_id);
    if (!byRound) { byRound = new Map(); cover.set(s.bout_id, byRound); }
    let corners = byRound.get(s.round);
    if (!corners) { corners = new Set(); byRound.set(s.round, corners); }
    corners.add(s.fighter_id);
  }

  const evById = new Map(events.map((e) => [e.id, e]));
  const fById = new Map(fighters.map((f) => [f.id, f]));
  const resByBout = new Map(results.map((r) => [r.bout_id, r]));

  const out: RoundIndexBout[] = [];
  for (const b of bouts) {
    const byRound = cover.get(b.id);
    if (!byRound || byRound.size === 0) continue;      // nothing to open
    const e = evById.get(b.event_id);
    const a = fById.get(b.fighter_a_id);
    const z = fById.get(b.fighter_b_id);
    if (!e || !a || !z) continue;                       // cannot render a name
    const r = resByBout.get(b.id) || null;
    out.push({
      boutId: b.id,
      eventId: e.id,
      eventName: e.name,
      eventDate: e.event_date,
      fighterA: a,
      fighterB: z,
      weightClass: b.weight_class,
      isWomens: Boolean(b.is_womens),
      isTitle: Boolean(b.is_title),
      boutOrder: b.bout_order,
      method: r?.method || null,
      finishRound: r?.round ?? null,
      winnerId: r?.winner_id || null,
      roundsCovered: byRound.size,
      bothCorners: [...byRound.values()].every((c) => c.size >= 2),
      scheduledRounds: b.scheduled_rounds,
    });
  }

  out.sort((x, y) => String(y.eventDate || "").localeCompare(String(x.eventDate || "")) || (x.boutOrder ?? 0) - (y.boutOrder ?? 0));

  const byRounds: Record<number, number> = {};
  for (const b of out) byRounds[b.roundsCovered] = (byRounds[b.roundsCovered] || 0) + 1;

  return {
    bouts: out,
    totals: { eligible: out.length, byRounds, bothCorners: out.filter((b) => b.bothCorners).length },
  };
}

/* ---- discovery sections -------------------------------------------------
 * Every section is defined by canonical data, never by editorial taste, so a
 * category cannot quietly become a list of fights someone liked. A section
 * with no members is dropped by the page rather than rendered empty. */

export type Section = { key: string; title: string; blurb: string; bouts: RoundIndexBout[] };

export function buildSections(index: RoundIndex): Section[] {
  const { bouts } = index;

  /* A fighter appearing more than once on one event is a same-night bracket.
   * That is the tournament signature, and it must not be collapsed: each bout
   * keeps its own analysis and its own place in the progression. */
  const perEventFighter = new Map<string, number>();
  for (const b of bouts) {
    for (const fid of [b.fighterA.id, b.fighterB.id]) {
      const k = `${b.eventId}|${fid}`;
      perEventFighter.set(k, (perEventFighter.get(k) || 0) + 1);
    }
  }
  const isTournament = (b: RoundIndexBout) =>
    (perEventFighter.get(`${b.eventId}|${b.fighterA.id}`) || 0) > 1 ||
    (perEventFighter.get(`${b.eventId}|${b.fighterB.id}`) || 0) > 1;

  const sections: Section[] = [
    {
      key: "recent",
      title: "Recent analysis",
      blurb: "The most recent completed bouts with verified round observations.",
      bouts: bouts.slice(0, 12),
    },
    {
      key: "five-round",
      title: "Five-round fights",
      blurb: "Championship and main-event distance, where round-over-round change has the most room to show.",
      bouts: bouts.filter((b) => b.roundsCovered >= 5).slice(0, 12),
    },
    {
      key: "title",
      title: "Championship fights",
      blurb: "Bouts the canonical record marks as title fights.",
      bouts: bouts.filter((b) => b.isTitle).slice(0, 12),
    },
    {
      key: "tournament",
      title: "Tournament nights",
      blurb: "Same-night brackets, where a fighter has more than one bout on the card. Each bout keeps its own analysis.",
      bouts: bouts.filter(isTournament).slice(0, 12),
    },
    {
      key: "historic",
      title: "Historic fights",
      blurb: "The oldest bouts the archive can reconstruct, recovered from archived captures.",
      bouts: bouts.slice().sort((a, b) => String(a.eventDate || "").localeCompare(String(b.eventDate || ""))).slice(0, 12),
    },
  ];

  return sections.filter((s) => s.bouts.length > 0);
}
