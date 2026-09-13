import "server-only";
import { cache } from "react";
import { isContenderSeries } from "@/lib/db";
import { allBouts, countsTowardsRecord, seasonBySlug, seasons, type SeasonDetail, type SeasonRow } from "@/lib/tuf";

/* The Ultimate Fighter alumni and coach graph.
 *
 *   TUF season -> house record -> winner/finalist -> UFC debut -> UFC career
 *   -> current rank
 *
 * The TUF half comes from the committed archive, joined on the canonical ids
 * stamped by scripts/tuf/resolve_identity.mjs. The UFC half comes from the
 * canonical fight tables, joined on the same ids. Nothing is matched by name.
 *
 * Two traps this is written around:
 *
 * - A TUF tournament final is flagged as a title bout in our records (the
 *   feeds call it "Ultimate Fighter Tournament Title Bout"). Winning it is not
 *   winning a UFC championship. Any bout between the two finalists' ids on
 *   their season's finale date is treated as the tournament final and never
 *   counted as a title-fight win.
 * - ufc_fighters.is_active is not a product truth. Activity is shown as the
 *   last UFC fight date and the number of UFC fights, never as a label.
 *
 * PostgREST caps responses at 1000 rows, so every read pages. */

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PAGE = 1000;
const REVALIDATE = 900;

function headers(): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json" };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

async function restAll<T>(path: string): Promise<T[]> {
  if (!URL_ || !KEY) throw new Error("database not configured");
  const out: T[] = [];
  for (let offset = 0; offset < 50000; offset += PAGE) {
    const res = await fetch(`${URL_}/rest/v1/${path}&limit=${PAGE}&offset=${offset}`, { headers: headers(), next: { revalidate: REVALIDATE } });
    if (!res.ok) throw new Error(`${path.split("?")[0]} HTTP ${res.status}`);
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/* ---- the TUF half, from committed data ------------------------------------ */

export type TufStatus = "winner" | "finalist" | "semifinalist" | "contestant";
export const STATUS_LABEL: Record<TufStatus, string> = { winner: "Winner", finalist: "Finalist", semifinalist: "Semifinalist", contestant: "Contestant" };
const STATUS_RANK: Record<TufStatus, number> = { winner: 3, finalist: 2, semifinalist: 1, contestant: 0 };

export type TufStint = {
  season: SeasonRow;
  status: TufStatus;
  weightClass: string | null;
  team: string | null;
  /** In-house bouts only: exhibitions and unverified. A professional final is a UFC fight and is counted there. */
  houseW: number;
  houseL: number;
  printedName: string;
};

type Final = { slug: string; ids: string; dates: string[]; year: number };

function tufSide(): { stints: Map<string, TufStint[]>; finals: Final[] } {
  const stints = new Map<string, TufStint[]>();
  const finals: Final[] = [];
  for (const row of seasons()) {
    const d = seasonBySlug(row.slug) as SeasonDetail | null;
    if (!d) continue;
    const bouts = d.bracket ? allBouts(d) : [];
    const people = new Map<string, TufStint>();
    const touch = (id: string | undefined, printed: string) => {
      if (!id) return null;
      let s = people.get(id);
      if (!s) {
        s = { season: row, status: "contestant", weightClass: null, team: null, houseW: 0, houseL: 0, printedName: printed };
        people.set(id, s);
      }
      return s;
    };
    for (const t of d.teams ?? []) for (const r of t.roster) {
      const s = touch(r.fighter_id, r.name);
      if (s) { s.team = t.name; if (r.weight_class && !s.weightClass) s.weightClass = r.weight_class; }
    }
    const dates = [row.finale_date, ...(row.final_bouts ?? []).map((f) => f.date)].filter(Boolean) as string[];
    for (const b of bouts) {
      for (const side of ["a", "b"] as const) {
        const id = side === "a" ? b.a_fighter_id : b.b_fighter_id;
        const printed = side === "a" ? b.a : b.b;
        const s = touch(id, printed);
        if (!s) continue;
        if (!s.weightClass && b.weight_class !== "Tournament") s.weightClass = b.weight_class;
        const reached: TufStatus = b.stage === "final" ? "finalist" : b.stage === "semi_final" ? "semifinalist" : "contestant";
        if (STATUS_RANK[reached] > STATUS_RANK[s.status]) s.status = reached;
        if (!countsTowardsRecord(b) && b.winner) {
          if (b.winner === printed) s.houseW += 1; else s.houseL += 1;
        }
      }
      if (b.stage === "final" && b.a_fighter_id && b.b_fighter_id) {
        finals.push({ slug: row.slug, ids: [b.a_fighter_id, b.b_fighter_id].sort().join("|"), dates: [...dates, ...(b.fight_date ? [b.fight_date] : [])], year: row.year });
      }
    }
    for (const w of row.winners) {
      const s = touch(w.fighter_id, w.fighter);
      if (s) { s.status = "winner"; s.weightClass = w.weight_class; }
    }
    for (const [id, s] of people) {
      const list = stints.get(id) || [];
      list.push(s);
      stints.set(id, list);
    }
  }
  return { stints, finals };
}

/* ---- the UFC half, from canonical tables ---------------------------------- */

type RawEvent = { id: string; name: string; event_date: string | null };
type RawResult = { winner_id: string | null; method: string | null; round: number | null } | null;
type RawBout = {
  id: string; fighter_a_id: string; fighter_b_id: string; status: string; is_title: boolean;
  result: RawResult | RawResult[]; event: RawEvent | RawEvent[] | null;
};

export type CareerBout = {
  boutId: string; eventName: string; eventDate: string | null; opponentId: string;
  outcome: "W" | "L" | "D" | "NC" | null; method: string | null; round: number | null;
  isTitle: boolean; isTufFinal: boolean;
};

export type UfcCareer = {
  fights: number; w: number; l: number; d: number; nc: number;
  debut: CareerBout | null; last: CareerBout | null; next: CareerBout | null;
  /** Title-bout wins that are not TUF tournament finals. */
  titleFightWins: number;
};

export type LinkedFighterRow = { id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null };

export type TufAlum = {
  fighterId: string;
  name: string;
  fighter: LinkedFighterRow;
  stints: TufStint[];
  best: TufStatus;
  ufc: UfcCareer;
};

export type TufGraph = {
  alumni: TufAlum[];
  byFighter: Map<string, TufAlum>;
  fighters: Map<string, LinkedFighterRow>;
  careerBouts: Map<string, CareerBout[]>;
  builtAt: string;
};

const BOUT_COLS = "id,fighter_a_id,fighter_b_id,status,is_title,result:ufc_bout_results(winner_id,method,round),event:ufc_events(id,name,event_date)";

async function careers(ids: string[], finals: Final[]) {
  const fighters = new Map<string, LinkedFighterRow>();
  for (let i = 0; i < ids.length; i += 120) {
    for (const f of await restAll<LinkedFighterRow>(`ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id&id=in.(${ids.slice(i, i + 120).join(",")})&order=id.asc`)) fighters.set(f.id, f);
  }
  const raw = new Map<string, RawBout>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).join(",");
    for (const b of await restAll<RawBout>(`ufc_bouts?select=${BOUT_COLS}&or=(fighter_a_id.in.(${chunk}),fighter_b_id.in.(${chunk}))&order=id.asc`)) raw.set(b.id, b);
  }
  const finalByPair = new Map<string, Final[]>();
  for (const f of finals) finalByPair.set(f.ids, [...(finalByPair.get(f.ids) || []), f]);
  const within = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 86400e3 * 1.5;
  /* With a finale date on file, the final is the bout on that date. Without
   * one (TUF 33), it is a title-flagged bout between the two finalists in the
   * season's year or the next: the tournament final, not a championship. */
  const isFinal = (pair: string, date: string | null, isTitle: boolean) => (finalByPair.get(pair) || []).some((f) =>
    date && (f.dates.length ? f.dates.some((d) => within(d, date)) : isTitle && [f.year, f.year + 1].includes(Number(date.slice(0, 4)))));

  const wanted = new Set(ids);
  const byFighter = new Map<string, CareerBout[]>();
  for (const b of raw.values()) {
    const ev = one(b.event);
    if (!ev || isContenderSeries(ev.name)) continue;
    const r = one(b.result);
    const pair = [b.fighter_a_id, b.fighter_b_id].sort().join("|");
    const isTufFinal = isFinal(pair, ev.event_date, b.is_title);
    for (const me of [b.fighter_a_id, b.fighter_b_id]) {
      if (!wanted.has(me)) continue;
      const done = b.status === "complete" && r?.method;
      const outcome: CareerBout["outcome"] = !done ? null : r!.winner_id === me ? "W" : r!.winner_id ? "L" : r!.method === "DRAW" ? "D" : "NC";
      const list = byFighter.get(me) || [];
      list.push({
        boutId: b.id, eventName: ev.name, eventDate: ev.event_date, opponentId: me === b.fighter_a_id ? b.fighter_b_id : b.fighter_a_id,
        outcome, method: r?.method ?? null, round: r?.round ?? null, isTitle: b.is_title, isTufFinal,
      });
      byFighter.set(me, list);
    }
  }
  for (const list of byFighter.values()) list.sort((x, y) => String(x.eventDate || "").localeCompare(String(y.eventDate || "")));
  return { fighters, byFighter };
}

function careerOf(bouts: CareerBout[]): UfcCareer {
  const today = new Date().toISOString().slice(0, 10);
  const done = bouts.filter((b) => b.outcome);
  return {
    fights: done.length,
    w: done.filter((b) => b.outcome === "W").length,
    l: done.filter((b) => b.outcome === "L").length,
    d: done.filter((b) => b.outcome === "D").length,
    nc: done.filter((b) => b.outcome === "NC").length,
    debut: done[0] || null,
    last: done[done.length - 1] || null,
    next: bouts.find((b) => !b.outcome && (b.eventDate || "") >= today) || null,
    titleFightWins: done.filter((b) => b.isTitle && !b.isTufFinal && b.outcome === "W").length,
  };
}

export const getTufGraph = cache(async (): Promise<TufGraph | null> => {
  try {
    const { stints, finals } = tufSide();
    const ids = [...stints.keys()];
    const { fighters, byFighter } = await careers(ids, finals);
    const alumni: TufAlum[] = ids.map((id) => {
      const list = (stints.get(id) || []).sort((a, b) => a.season.year - b.season.year || a.season.number - b.season.number);
      const best = list.reduce<TufStatus>((m, s) => (STATUS_RANK[s.status] > STATUS_RANK[m] ? s.status : m), "contestant");
      const fighter = fighters.get(id) || { id, name: list[0]?.printedName || id, espn_athlete_id: null, ufcstats_id: null };
      return { fighterId: id, name: fighter.name, fighter, stints: list, best, ufc: careerOf(byFighter.get(id) || []) };
    });
    return { alumni, byFighter: new Map(alumni.map((a) => [a.fighterId, a])), fighters, careerBouts: byFighter, builtAt: new Date().toISOString() };
  } catch (e) {
    console.error(`[tufGraph] ${String((e as Error)?.message || e).slice(0, 160)}`);
    return null;
  }
});

/* ---- coach history --------------------------------------------------------- */

export type CoachSide = { name: string; fighterId: string | null; team: string | null; teamW: number; teamL: number; champions: Array<{ name: string; fighterId: string | null; weightClass: string }> };
export type CoachSeason = {
  season: SeasonRow;
  a: CoachSide;
  b: CoachSide;
  /** Every stored UFC bout between the two head coaches, dated. Empty when either coach is unresolved. */
  meetings: CareerBout[];
  meetingsKnown: boolean;
  teamRecordBasis: "roster" | "unavailable";
};

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export const getCoachHistory = cache(async (): Promise<CoachSeason[] | null> => {
  try {
    const rows = seasons().filter((s) => s.coaches.length === 2);
    const coachIds = [...new Set(rows.flatMap((s) => s.coach_fighter_ids ?? []).filter(Boolean))] as string[];
    const { byFighter } = coachIds.length ? await careers(coachIds, tufSide().finals) : { byFighter: new Map<string, CareerBout[]>() };
    return rows.map((row) => {
      const d = seasonBySlug(row.slug) as SeasonDetail | null;
      const teams = d?.teams ?? [];
      const teamOf = (coach: string): string | null => {
        const staff = d?.coaches_full?.find((c) => c.role === "head" && fold(c.name) === fold(coach));
        if (staff?.team) return staff.team;
        const surname = fold(coach).split(" ").pop() || "";
        const hits = teams.filter((t) => fold(t.name).includes(surname));
        return hits.length === 1 ? hits[0].name : null;
      };
      const rosterOf = (coach: string) => teams.find((t) => t.name === teamOf(coach))?.roster ?? [];
      const member = (roster: Array<{ name: string; fighter_id?: string }>, printed: string, id?: string) => roster.some((r) => r.name === printed || (id && r.fighter_id === id));
      const side = (i: 0 | 1): CoachSide => {
        const name = row.coaches[i];
        const team = teamOf(name);
        const roster = rosterOf(name);
        const other = rosterOf(row.coaches[i === 0 ? 1 : 0]);
        const onTeam = (printed: string, id?: string) => member(roster, printed, id);
        /* Only bouts between the two rosters: a win over a fighter the archive
         * cannot place on the other team (a replacement, a castmate spelled
         * differently) is not a team result. */
        let teamW = 0; let teamL = 0;
        for (const b of d?.bracket ? allBouts(d) : []) {
          if (countsTowardsRecord(b) || !b.winner) continue;
          const loser = b.winner === b.a ? b.b : b.a;
          const winnerId = b.winner === b.a ? b.a_fighter_id : b.b_fighter_id;
          const loserId = b.winner === b.a ? b.b_fighter_id : b.a_fighter_id;
          if (member(roster, b.winner, winnerId) && member(other, loser, loserId)) teamW += 1;
          if (member(roster, loser, loserId) && member(other, b.winner, winnerId)) teamL += 1;
        }
        const champions = row.winners.filter((w) => onTeam(w.fighter, w.fighter_id)).map((w) => ({ name: w.fighter, fighterId: w.fighter_id ?? null, weightClass: w.weight_class }));
        return { name, fighterId: row.coach_fighter_ids?.[i] ?? null, team, teamW, teamL, champions };
      };
      const a = side(0);
      const b = side(1);
      const known = Boolean(a.fighterId && b.fighterId);
      const meetings = known ? (byFighter.get(a.fighterId!) || []).filter((x) => x.opponentId === b.fighterId && x.outcome) : [];
      return { season: row, a, b, meetings, meetingsKnown: known, teamRecordBasis: teams.length ? "roster" : "unavailable" };
    });
  } catch (e) {
    console.error(`[tufGraph] coaches ${String((e as Error)?.message || e).slice(0, 160)}`);
    return null;
  }
});
