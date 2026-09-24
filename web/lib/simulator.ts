import "server-only";
/* PBE Fight Simulator data layer (server only). Reads with the service role,
 * strictly as-of, and hands rows to lib/simulatorRun.ts. Results are cached by
 * matchup + as-of date + format + simulator version: the engine is
 * deterministic, so a cached artifact is byte-identical to a recomputation on
 * the same inputs. runSimulation must only be called for a caller whose Labs
 * access allows results (lib/labsAccess.ts); paywall.test.ts pins the guard. */
import { unstable_cache } from "next/cache";
import { getEventBouts, getUpcomingEvents, type Bout, type Event } from "./db";
import { SNAPSHOT_SELECT } from "./vendor/pbe-model/features_core.mjs";
import { SIMULATOR_VERSION } from "./vendor/sim-engine/params.mjs";
import { runSimulationFromRows, type BoutFeatureRow, type CornerRows, type FighterRow, type MatchupSpec, type SimulationResult, type SnapshotRow } from "./simulatorRun";
import { isSimulatableBout } from "./simulatorView";

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function q<T>(path: string, revalidate = 900): Promise<T> {
  if (!URL_ || !KEY) throw new Error("[simulator] database not configured");
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY, authorization: `Bearer ${KEY}`, accept: "application/json" }, next: { revalidate } });
  if (!res.ok) throw new Error(`[simulator] ${path.split("?")[0]} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

const today = () => new Date().toISOString().slice(0, 10);
const FULL_SNAPSHOT = "fighter_id,as_of_date,definition_version,sample_bouts,sample_completed_bouts,sample_stat_bouts,sample_rounds,sample_seconds,coverage_status,metrics,round_profile,finish_profile,provenance";
const FIGHTER_COLS = "id,name,dob,height_in,reach_in,stance";

/* ---- coverage map for lists (latest successful full Fight DNA build) ---- */
export type CoverageEntry = { tier: string; statBouts: number; asOf: string };

async function latestFullBuildDate(): Promise<string | null> {
  const rows = await q<Array<{ as_of_date: string }>>("ufc_dna_build_runs?select=as_of_date&mode=eq.full&status=eq.success&order=started_at.desc&limit=1", 900);
  return rows[0]?.as_of_date ?? null;
}

async function coverageAt(date: string): Promise<Map<string, CoverageEntry>> {
  const out = new Map<string, CoverageEntry>();
  let after = "";
  for (let i = 0; i < 20; i += 1) {
    const page = await q<Array<{ fighter_id: string; coverage_status: string; sample_stat_bouts: number }>>(
      `ufc_fighter_dna_snapshots?select=fighter_id,coverage_status,sample_stat_bouts&definition_version=eq.1&as_of_date=eq.${date}${after}&order=fighter_id.asc&limit=1000`, 3600);
    for (const r of page) out.set(r.fighter_id, { tier: r.coverage_status, statBouts: r.sample_stat_bouts || 0, asOf: date });
    if (page.length < 1000) break;
    after = `&fighter_id=gt.${page[page.length - 1].fighter_id}`;
  }
  return out;
}

const coverageMap = unstable_cache(async () => {
  const date = await latestFullBuildDate();
  return date ? { date, entries: [...(await coverageAt(date)).entries()] } : { date: null, entries: [] as Array<[string, CoverageEntry]> };
}, ["simulator-coverage-v1"], { revalidate: 3600, tags: ["simulator"] });

export async function getCoverage(): Promise<{ date: string | null; map: Map<string, CoverageEntry> }> {
  const c = await coverageMap();
  return { date: c.date, map: new Map(c.entries) };
}

/* ---- upcoming bouts ---- */
/** A list row states pre-simulation FACTS only: each corner's Fight DNA coverage tier. FULL / LIMITED is a RESULT-level
 * state (coverage + anchor strain + validity) and exists only after a simulation has run (simGate). */
export type UpcomingSimBout = { event: Event; bout: Bout; tiers: [string | null, string | null] };

export async function getUpcomingSimulatorBouts(): Promise<UpcomingSimBout[]> {
  const [events, coverage] = await Promise.all([getUpcomingEvents(6), getCoverage()]);
  const cards = await Promise.all(events.map(async (e) => ({ e, bouts: await getEventBouts(e.id) })));
  const out: UpcomingSimBout[] = [];
  for (const { e, bouts } of cards) {
    for (const b of bouts) {
      if (!isSimulatableBout(b)) continue;
      const t1 = coverage.map.get(b.fighter_a.id)?.tier ?? null;
      const t2 = coverage.map.get(b.fighter_b.id)?.tier ?? null;
      out.push({ event: e, bout: b, tiers: [t1, t2] });
    }
  }
  return out;
}

/* ---- manual-matchup roster: active fighters with usable Fight DNA ---- */
export type RosterFighter = { id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null; tier: string };

export const getSimulatorRoster = unstable_cache(async (): Promise<RosterFighter[]> => {
  const { map } = await getCoverage();
  const fighters: Array<{ id: string; name: string; espn_athlete_id: string | null; ufcstats_id: string | null }> = [];
  let after = "";
  for (let i = 0; i < 10; i += 1) {
    const page = await q<typeof fighters>(`ufc_fighters?select=id,name,espn_athlete_id,ufcstats_id&is_active=eq.true${after}&order=id.asc&limit=1000`, 3600);
    fighters.push(...page);
    if (page.length < 1000) break;
    after = `&id=gt.${page[page.length - 1].id}`;
  }
  return fighters
    .map((f) => ({ ...f, tier: map.get(f.id)?.tier ?? "none", statBouts: map.get(f.id)?.statBouts ?? 0 }))
    .filter((f) => (f.tier === "low" || f.tier === "medium" || f.tier === "high") && f.statBouts >= 1)
    .map(({ statBouts: _s, ...f }) => f)
    .sort((x, y) => x.name.localeCompare(y.name));
}, ["simulator-roster-v1"], { revalidate: 3600, tags: ["simulator"] });

/* ---- one simulation ---- */
async function cornerRows(fighter: FighterRow, D: string): Promise<CornerRows> {
  const [snapshots, boutRows] = await Promise.all([
    q<SnapshotRow[]>(`ufc_fighter_dna_snapshots?select=${FULL_SNAPSHOT}&fighter_id=eq.${fighter.id}&definition_version=eq.1&as_of_date=lte.${D}&order=as_of_date.desc&limit=3`),
    q<BoutFeatureRow[]>(`ufc_fighter_bout_features?select=fighter_id,bout_id,opponent_id,event_date,outcome,opp_totals:raw_stats->opp_totals&fighter_id=eq.${fighter.id}&feature_version=eq.1&order=event_date.asc&limit=200`),
  ]);
  const modelSnapshots = new Map<string, Record<string, unknown>>();
  if (snapshots.length) {
    const dates = snapshots.map((s) => s.as_of_date).join(",");
    const rows = await q<Array<Record<string, unknown> & { as_of_date: string }>>(`ufc_fighter_dna_snapshots?select=${SNAPSHOT_SELECT}&fighter_id=eq.${fighter.id}&definition_version=eq.1&as_of_date=in.(${dates})`);
    for (const r of rows) modelSnapshots.set(r.as_of_date, r);
  }
  return { fighter, snapshots, modelSnapshots, boutRows };
}

async function opponentRows(a: CornerRows, b: CornerRows, D: string): Promise<BoutFeatureRow[]> {
  const own = new Set([a.fighter.id, b.fighter.id]);
  const ids = [...new Set([...a.boutRows, ...b.boutRows].filter((r) => r.event_date < D).map((r) => r.opponent_id).filter((x): x is string => Boolean(x) && !own.has(x as string)))];
  const out: BoutFeatureRow[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    out.push(...(await q<BoutFeatureRow[]>(`ufc_fighter_bout_features?select=fighter_id,bout_id,opponent_id,event_date,outcome&fighter_id=in.(${ids.slice(i, i + 40).join(",")})&feature_version=eq.1&event_date=lt.${D}&limit=1000`)));
  }
  return out;
}

async function computeSimulation(aId: string, bId: string, spec: MatchupSpec): Promise<SimulationResult> {
  const fighters = await q<FighterRow[]>(`ufc_fighters?select=${FIGHTER_COLS}&id=in.(${aId},${bId})`);
  const fa = fighters.find((f) => f.id === aId), fb = fighters.find((f) => f.id === bId);
  if (!fa || !fb) throw new Error("[simulator] fighter not found");
  const [ca, cb] = await Promise.all([cornerRows(fa, spec.asOf), cornerRows(fb, spec.asOf)]);
  return runSimulationFromRows(spec, ca, cb, await opponentRows(ca, cb, spec.asOf));
}

const cachedSimulation = unstable_cache(
  async (aId: string, bId: string, specJson: string) => computeSimulation(aId, bId, JSON.parse(specJson) as MatchupSpec),
  ["simulator-run", SIMULATOR_VERSION],
  { revalidate: 21600, tags: ["simulator"] },
);

/** Run (or load the cached) simulation for two fighters as of spec.asOf. Callers must hold Labs access. */
export async function runSimulation(aId: string, bId: string, spec: MatchupSpec): Promise<SimulationResult> {
  const [x, y] = aId < bId ? [aId, bId] : [bId, aId];
  return cachedSimulation(x, y, JSON.stringify(spec));
}

export function specForBout(b: Bout, e: Event): MatchupSpec {
  return { boutId: b.id, eventName: e.name, asOf: e.event_date || today(), scheduledRounds: b.scheduled_rounds === 5 ? 5 : 3, weightClass: b.weight_class, isTitle: Boolean(b.is_title), isWomens: Boolean(b.is_womens) };
}

export function specForManual(rounds: 3 | 5): MatchupSpec {
  return { boutId: null, eventName: "Simulated matchup", asOf: today(), scheduledRounds: rounds, weightClass: null, isTitle: false, isWomens: false };
}
