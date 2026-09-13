import "server-only";
import { cache } from "react";
import { contenderIdentity, isDanaWhiteContenderSeries, type ContenderIdentity } from "@/lib/contenderIdentity";
import { isContenderSeries } from "@/lib/db";

/* The Contender Series alumni graph.
 *
 *   DWCS appearance -> DWCS result -> UFC debut -> UFC career -> current rank
 *
 * Built only from canonical tables and joined only on canonical fighter_id:
 * ufc_events / ufc_bouts / ufc_bout_results / ufc_fighters. Nothing here
 * matches a fighter by name, copies a rank into a fighter row, or infers a
 * contract from a win (Diego Lopes lost on Season 5 and reached the UFC; the
 * graph records what happened, not what a win usually means). Contract and
 * opportunity outcomes appear only as sourced claims — see getOutcomeClaims.
 *
 * Activity is reported as facts ("last UFC fight Mar 2026", "14 UFC fights"),
 * never as an active/inactive/retired label: ufc_fighters.is_active is not a
 * product truth.
 *
 * PostgREST caps a response at 1000 rows, so every read pages. A truncated
 * graph would undercount alumni and nothing on the page would say so. */

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PAGE = 1000;
const REVALIDATE = 900;

function headers(): Record<string, string> {
  const h: Record<string, string> = { apikey: KEY, Accept: "application/json" };
  if (KEY.startsWith("eyJ")) h.Authorization = `Bearer ${KEY}`;
  return h;
}

/* Throws on failure. A partial graph presented as the whole one is worse than
 * an error state, so callers catch and render absence. */
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

type RawResult = { winner_id: string | null; method: string | null; round: number | null; time_sec: number | null } | null;
type RawEvent = { id: string; name: string; event_date: string | null; card_status: string | null };
type RawBout = {
  id: string; event_id: string; fighter_a_id: string; fighter_b_id: string; status: string;
  weight_class: string | null; is_womens: boolean; is_title: boolean;
  result: RawResult | RawResult[];
  event?: RawEvent | RawEvent[] | null;
};
export type GraphFighter = {
  id: string; name: string; nickname: string | null; espn_athlete_id: string | null; ufcstats_id: string | null;
  record_w: number | null; record_l: number | null; record_d: number | null; record_nc: number | null;
};

export type Outcome = "W" | "L" | "D" | "NC";
export type GraphBout = {
  boutId: string;
  event: { id: string; name: string; eventDate: string | null };
  opponentId: string;
  fighterAId: string;
  outcome: Outcome | null;      // null = not completed
  method: string | null;
  round: number | null;
  timeSec: number | null;
  weightClass: string | null;
  isWomens: boolean;
  isTitle: boolean;
  status: string;
};
export type DwcsAppearance = GraphBout & { identity: ContenderIdentity };

export type UfcCareer = {
  fights: number; w: number; l: number; d: number; nc: number;
  debut: GraphBout | null;       // earliest completed UFC-card bout
  last: GraphBout | null;        // latest completed UFC-card bout
  next: GraphBout | null;        // earliest booked, not yet fought
  titleWins: number;
  beforeDwcs: number;            // completed UFC bouts dated before the first DWCS appearance
  sinceDwcsFights: number;       // completed UFC bouts dated after it
  sinceDwcsWins: number;
};

export type DwcsAlum = {
  fighter: GraphFighter;
  appearances: DwcsAppearance[];   // chronological
  dwcsW: number; dwcsL: number;
  firstDwcs: DwcsAppearance;
  lastDwcs: DwcsAppearance;
  ufc: UfcCareer;
  /** Fought a completed UFC-card bout dated after the first DWCS appearance. */
  reachedUfc: boolean;
};

export type DwcsGraph = {
  alumni: DwcsAlum[];
  byFighter: Map<string, DwcsAlum>;
  /** Every fighter who appeared on a DWCS card — covers every DWCS opponent. */
  fighters: Map<string, GraphFighter>;
  events: Array<RawEvent & { identity: ContenderIdentity }>;
  builtAt: string;
};

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

function outcomeFor(fighterId: string, r: RawResult, status: string): Outcome | null {
  if (!r || status === "cancelled" || !r.method) return null;
  if (r.winner_id === fighterId) return "W";
  if (r.winner_id) return "L";
  return r.method === "DRAW" ? "D" : "NC";
}

function toGraphBout(b: RawBout, fighterId: string, ev: RawEvent): GraphBout {
  const r = one(b.result);
  return {
    boutId: b.id,
    event: { id: ev.id, name: ev.name, eventDate: ev.event_date },
    opponentId: b.fighter_a_id === fighterId ? b.fighter_b_id : b.fighter_a_id,
    fighterAId: b.fighter_a_id,
    outcome: outcomeFor(fighterId, r, b.status),
    method: r?.method ?? null,
    round: r?.round ?? null,
    timeSec: r?.time_sec ?? null,
    weightClass: b.weight_class,
    isWomens: b.is_womens,
    isTitle: b.is_title,
    status: b.status,
  };
}

const byDate = (a: GraphBout, b: GraphBout) => String(a.event.eventDate || "").localeCompare(String(b.event.eventDate || "")) || a.event.name.localeCompare(b.event.name);

const BOUT_COLS = "id,event_id,fighter_a_id,fighter_b_id,status,weight_class,is_womens,is_title,result:ufc_bout_results(winner_id,method,round,time_sec)";

export const getDwcsGraph = cache(async (): Promise<DwcsGraph | null> => {
  try {
    const events = (await restAll<RawEvent>(`ufc_events?select=id,name,event_date,card_status&name=ilike.*contender%20series*&order=event_date.asc`))
      .filter((e) => isDanaWhiteContenderSeries(e.name))
      .map((e) => ({ ...e, identity: contenderIdentity(e.name, e.event_date) }));
    const eventById = new Map(events.map((e) => [e.id, e]));

    const dwcsBouts: RawBout[] = [];
    const ids = events.map((e) => e.id);
    for (let i = 0; i < ids.length; i += 60) {
      dwcsBouts.push(...await restAll<RawBout>(`ufc_bouts?select=${BOUT_COLS}&event_id=in.(${ids.slice(i, i + 60).join(",")})&order=id.asc`));
    }
    const fighterIds = [...new Set(dwcsBouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))];

    const fighters = new Map<string, GraphFighter>();
    for (let i = 0; i < fighterIds.length; i += 120) {
      for (const f of await restAll<GraphFighter>(`ufc_fighters?select=id,name,nickname,espn_athlete_id,ufcstats_id,record_w,record_l,record_d,record_nc&id=in.(${fighterIds.slice(i, i + 120).join(",")})&order=id.asc`)) fighters.set(f.id, f);
    }

    /* Every bout any DWCS fighter has on record, with its event. */
    const career = new Map<string, RawBout>();
    for (let i = 0; i < fighterIds.length; i += 50) {
      const chunk = fighterIds.slice(i, i + 50).join(",");
      for (const b of await restAll<RawBout>(`ufc_bouts?select=${BOUT_COLS},event:ufc_events(id,name,event_date,card_status)&or=(fighter_a_id.in.(${chunk}),fighter_b_id.in.(${chunk}))&order=id.asc`)) career.set(b.id, b);
    }
    const boutsByFighter = new Map<string, RawBout[]>();
    for (const b of career.values()) {
      for (const f of [b.fighter_a_id, b.fighter_b_id]) {
        if (!fighters.has(f)) continue;
        const list = boutsByFighter.get(f) || [];
        list.push(b);
        boutsByFighter.set(f, list);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const alumni: DwcsAlum[] = [];
    for (const [fid, fighter] of fighters) {
      const mine = boutsByFighter.get(fid) || [];
      const appearances: DwcsAppearance[] = [];
      const ufcAll: GraphBout[] = [];
      for (const b of mine) {
        const ev = eventById.get(b.event_id) || one(b.event);
        if (!ev) continue;
        if (eventById.has(b.event_id)) {
          appearances.push({ ...toGraphBout(b, fid, ev), identity: eventById.get(b.event_id)!.identity });
        } else if (!isContenderSeries(ev.name)) {
          ufcAll.push(toGraphBout(b, fid, ev));
        }
      }
      if (!appearances.length) continue;
      appearances.sort(byDate);
      ufcAll.sort(byDate);
      const firstDwcs = appearances[0];
      const done = ufcAll.filter((b) => b.outcome);
      const since = done.filter((b) => (b.event.eventDate || "") > (firstDwcs.event.eventDate || ""));
      const upcoming = ufcAll.filter((b) => !b.outcome && b.status !== "cancelled" && (b.event.eventDate || "") >= today);
      const ufc: UfcCareer = {
        fights: done.length,
        w: done.filter((b) => b.outcome === "W").length,
        l: done.filter((b) => b.outcome === "L").length,
        d: done.filter((b) => b.outcome === "D").length,
        nc: done.filter((b) => b.outcome === "NC").length,
        debut: done[0] || null,
        last: done[done.length - 1] || null,
        next: upcoming[0] || null,
        titleWins: done.filter((b) => b.isTitle && b.outcome === "W").length,
        beforeDwcs: done.filter((b) => (b.event.eventDate || "") < (firstDwcs.event.eventDate || "")).length,
        sinceDwcsFights: since.length,
        sinceDwcsWins: since.filter((b) => b.outcome === "W").length,
      };
      alumni.push({
        fighter,
        appearances,
        dwcsW: appearances.filter((a) => a.outcome === "W").length,
        dwcsL: appearances.filter((a) => a.outcome === "L").length,
        firstDwcs,
        lastDwcs: appearances[appearances.length - 1],
        ufc,
        reachedUfc: since.length > 0,
      });
    }
    return { alumni, byFighter: new Map(alumni.map((a) => [a.fighter.id, a])), fighters, events, builtAt: new Date().toISOString() };
  } catch (e) {
    console.error(`[dwcsGraph] ${String((e as Error)?.message || e).slice(0, 160)}`);
    return null;
  }
});

/* ---- sourced outcome claims ------------------------------------------- */

export type OutcomeClaimType = "contract_awarded" | "developmental_deal" | "tuf_invite" | "other_opportunity";
export type OutcomeClaim = {
  id: string; fighter_id: string; event_id: string; bout_id: string | null;
  claim_type: OutcomeClaimType; source_url: string; source_title: string | null; source_date: string | null;
  source_family: string; source_excerpt_short: string | null; captured_at: string;
};

export const CLAIM_LABEL: Record<OutcomeClaimType, string> = {
  contract_awarded: "Contract awarded",
  developmental_deal: "Developmental deal",
  tuf_invite: "TUF invite",
  other_opportunity: "UFC opportunity",
};

/* Only published, unconflicted claims. A table that does not exist yet, or a
 * read that fails, yields no claims — never an inferred one. */
export const getOutcomeClaims = cache(async (): Promise<Map<string, OutcomeClaim[]>> => {
  const m = new Map<string, OutcomeClaim[]>();
  if (!URL_ || !KEY) return m;
  try {
    const res = await fetch(`${URL_}/rest/v1/ufc_dwcs_outcome_claims?select=id,fighter_id,event_id,bout_id,claim_type,source_url,source_title,source_date,source_family,source_excerpt_short,captured_at&claim_status=eq.published&order=source_date.asc&limit=${PAGE}`, { headers: headers(), next: { revalidate: REVALIDATE } });
    if (!res.ok) return m;
    for (const c of (await res.json()) as OutcomeClaim[]) {
      const list = m.get(c.fighter_id) || [];
      list.push(c);
      m.set(c.fighter_id, list);
    }
  } catch { /* absence, not inference */ }
  return m;
});
