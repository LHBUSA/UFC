import type { Metadata } from "next";
import Link from "next/link";
import { getUfcAccess } from "@/lib/access";
import { labsSimulatorAccess } from "@/lib/labsAccess";
import { getSimulatorRoster, getUpcomingSimulatorBouts, runSimulation, specForBout, specForManual, getCoverage, type RosterFighter, type UpcomingSimBout } from "@/lib/simulator";
import { getFightersByIds, getImagesForFighters, type Fighter } from "@/lib/db";
import { fighterIdFromSlug, fighterSlug } from "@/lib/slug";
import { fmtDate } from "@/lib/format";
import { ROUNDS_UNRESOLVED_COPY, simGate, type SimGate } from "@/lib/simulatorView";
import { FITTED_PROVENANCE_V1 } from "@/lib/vendor/sim-engine/params_fitted_v1.mjs";
import type { SimulationResult, MatchupSpec } from "@/lib/simulatorRun";
import {
  DnaCoverage, GateBadge, GoesDistance, HowItWorks, LimitedNote, LockedPanel, ModelCard, OutcomeDistribution, Provenance, RepresentativePath, RoundOutcomeMatrix, TierChip, Unavailable, VolumeRanges, WinProbability,
  type Side,
} from "@/components/simulator/SimulatorViews";
import { FighterStrip, type StripFighter } from "@/components/simulator/SimulatorStrip";
import s from "./simulator.module.css";

/* PBE FIGHT SIMULATOR (PBE Labs). The page, the upcoming-fight list, the
 * roster and the method are public; simulation RESULTS are computed only for a
 * reader whose Labs access allows them (lib/labsAccess.ts), decided before any
 * simulation read. Outputs follow docs/FIGHT_SIMULATOR_PHASE3.md section 13. */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "Fight Simulator · PBE Labs",
  description: "Model-based UFC matchup simulation from as-of Fight DNA and round-level UFC data: win probability, round-by-round finish outcomes, method distribution and goes-distance odds from 10,000 simulated fights.",
  alternates: { canonical: "/simulator" },
};

type SP = { mode?: string; bout?: string; a?: string; b?: string; r?: string };
type Selection = { kind: "scheduled" | "simulated"; aId: string; bId: string; spec: MatchupSpec | null; upcoming: UpcomingSimBout | null };

const WC = (w: string | null) => (w ? w.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : null);
const record = (f: Fighter | undefined) => (f && f.record_w != null ? `${f.record_w}-${f.record_l ?? 0}${f.record_d ? `-${f.record_d}` : ""}` : null);

function resolveRoster(value: string | undefined, roster: RosterFighter[]): RosterFighter | null {
  const v = String(value || "").trim();
  if (!v) return null;
  const sid = fighterIdFromSlug(v);
  if (sid) { const bySlug = roster.find((f) => f.espn_athlete_id === sid || f.ufcstats_id === sid); if (bySlug) return bySlug; }
  const lc = v.toLowerCase();
  return roster.find((f) => f.name.toLowerCase() === lc) ?? null;
}

export default async function SimulatorPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const access = await getUfcAccess();
  const labs = labsSimulatorAccess(access);
  const manual = sp.mode === "manual" || Boolean(sp.a || sp.b);
  const [upcoming, roster, coverage] = await Promise.all([
    getUpcomingSimulatorBouts().catch(() => [] as UpcomingSimBout[]),
    manual ? getSimulatorRoster().catch(() => [] as RosterFighter[]) : Promise.resolve([] as RosterFighter[]),
    getCoverage().catch(() => ({ date: null, map: new Map() })),
  ]);

  let selection: Selection | null = null;
  let manualError: string | null = null;
  if (sp.bout) {
    const u = upcoming.find((x) => x.bout.id === sp.bout);
    if (u) selection = { kind: "scheduled", aId: u.bout.fighter_a.id, bId: u.bout.fighter_b.id, spec: specForBout(u.bout, u.event), upcoming: u };
  } else if (manual && (sp.a || sp.b)) {
    const fa = resolveRoster(sp.a, roster), fb = resolveRoster(sp.b, roster);
    if (!fa || !fb) manualError = "Pick two fighters from the list. Only fighters with verified round-level Fight DNA are listed.";
    else if (fa.id === fb.id) manualError = "Pick two different fighters.";
    else {
      const booked = upcoming.find((u) => new Set([u.bout.fighter_a.id, u.bout.fighter_b.id]).has(fa.id) && new Set([u.bout.fighter_a.id, u.bout.fighter_b.id]).has(fb.id));
      selection = booked
        ? { kind: "scheduled", aId: booked.bout.fighter_a.id, bId: booked.bout.fighter_b.id, spec: specForBout(booked.bout, booked.event), upcoming: booked }
        : { kind: "simulated", aId: fa.id, bId: fb.id, spec: specForManual(sp.r === "5" ? 5 : 3), upcoming: null };
    }
  }

  /* Labs gate BEFORE the simulation read: a reader without access never triggers or receives a simulation. */
  let result: SimulationResult | null = null;
  let simError = false;
  if (selection && selection.spec && labs.allowed) {
    try { result = await runSimulation(selection.aId, selection.bId, selection.spec); } catch { simError = true; }
  }

  const ids = selection ? [selection.aId, selection.bId] : [];
  const [fighters, images] = ids.length ? await Promise.all([getFightersByIds(ids), getImagesForFighters(ids)]) : [[] as Fighter[], new Map()];
  const fById = new Map(fighters.map((f) => [f.id, f]));
  const strip = (id: string): StripFighter => {
    const f = fById.get(id);
    return { id, name: f?.name || "Fighter", record: record(f), stance: f?.stance ?? null, reach_in: f?.reach_in ?? null, img: images.get(id) ?? null, tier: coverage.map.get(id)?.tier ?? null, href: f ? `/fighters/${fighterSlug(f)}` : null };
  };

  const artifact = result?.artifact ?? null;
  /* FULL / LIMITED is a result: it exists only once a simulation has run. Before that the page states Fight DNA coverage. */
  const gate: SimGate | null = artifact ? simGate(artifact) : null;
  const leftSide: Side = artifact?.fighters && selection ? (artifact.fighters.fighter_1.id === selection.aId ? "fighter_1" : "fighter_2") : "fighter_1";
  const names: Record<Side, string> = { fighter_1: artifact?.fighters?.fighter_1.name || "", fighter_2: artifact?.fighters?.fighter_2.name || "" };

  const selfHref = selection?.kind === "scheduled" ? `/simulator?bout=${selection.upcoming?.bout.id ?? sp.bout}` : selection ? `/simulator?mode=manual&a=${encodeURIComponent(sp.a || "")}&b=${encodeURIComponent(sp.b || "")}&r=${selection.spec?.scheduledRounds ?? 3}` : "/simulator";
  const loginHref = `/login?next=${encodeURIComponent(selfHref)}`;

  return (
    <main className={`wrap ${s.page}`} data-sim-page="">
      <header className={s.hero}>
        <div className={s.eyebrow}>FIGHT SIMULATOR <span className={s.labs}>LABS</span></div>
        <h1 className={s.h1}>Fight Simulator</h1>
        <p className={s.lede}>Model-based matchup simulation using Fight DNA and calibrated fight-state models. Ten thousand simulated fights per matchup, anchored to the PBE Fight Model.</p>
      </header>

      <nav className={s.tabs} aria-label="Simulator mode">
        <Link href="/simulator" className={`${s.tab} ${!manual ? s.tabOn : ""}`} aria-current={!manual ? "page" : undefined}>Upcoming fights</Link>
        <Link href="/simulator?mode=manual" className={`${s.tab} ${manual ? s.tabOn : ""}`} aria-current={manual ? "page" : undefined}>Build a matchup</Link>
      </nav>

      <div className={s.layout}>
        <div className={s.selector}>
          {manual ? <ManualForm roster={roster} a={sp.a} b={sp.b} r={sp.r} error={manualError} /> : <UpcomingList rows={upcoming} selected={sp.bout || null} />}
        </div>

        <div className={s.results} id="simulation">
          {!selection && !manualError && (
            <section className={`${s.card} ${s.empty}`}>
              <h2 className={s.h2}>{manual ? "Build a matchup" : "Pick an upcoming fight"}</h2>
              <p className={s.note}>{manual ? "Choose any two fighters with verified Fight DNA. A matchup that is not on a card is labelled a simulated matchup." : "Choose a bout from the list to see how 10,000 simulated fights between the two fighters play out."}</p>
            </section>
          )}

          {selection && (
            <>
              <div className={s.matchHead} data-sim-kind={selection.kind}>
                <span className={`${s.kind} ${selection.kind === "simulated" ? s.kindSim : ""}`}>{selection.kind === "scheduled" ? "SCHEDULED BOUT" : "SIMULATED MATCHUP"}</span>
                <span className={s.matchMeta}>
                  {selection.kind === "scheduled" && selection.upcoming
                    ? [selection.upcoming.event.name, fmtDate(selection.upcoming.event.event_date), WC(selection.upcoming.bout.weight_class), selection.spec ? `${selection.spec.scheduledRounds} rounds` : "Rounds not confirmed"].filter(Boolean).join(" · ")
                    : `Not a scheduled bout · ${selection.spec?.scheduledRounds ?? 3} rounds · Fight DNA as of ${selection.spec?.asOf ?? ""}`}
                </span>
              </div>
              <FighterStrip left={strip(selection.aId)} right={strip(selection.bId)} gate={gate} />

              {!selection.spec ? (
                <section className={`${s.card} ${s.empty}`} data-sim-rounds-unresolved=""><h2 className={s.h2}>Round count not confirmed</h2><p className={s.note}>{ROUNDS_UNRESOLVED_COPY}</p></section>
              ) : !labs.allowed ? (
                <LockedPanel reason={labs.reason} loginHref={loginHref} />
              ) : simError ? (
                <Unavailable a={null} error />
              ) : !artifact || simGate(artifact) === "INSUFFICIENT_DATA" ? (
                <Unavailable a={artifact} />
              ) : (
                <div className={s.resultGrid} data-sim-result={simGate(artifact)}>
                  {simGate(artifact) === "LIMITED" && <LimitedNote a={artifact} />}
                  <WinProbability a={artifact} left={leftSide} names={names} />
                  <GoesDistance a={artifact} />
                  <OutcomeDistribution a={artifact} left={leftSide} names={names} />
                  <RoundOutcomeMatrix a={artifact} left={leftSide} names={names} />
                  <VolumeRanges a={artifact} left={leftSide} names={names} />
                  <RepresentativePath a={artifact} left={leftSide} names={names} />
                  <Provenance a={artifact} trainingWindow={FITTED_PROVENANCE_V1.training_window} asOfNames={names} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className={s.aboutGrid}>
        <HowItWorks />
        <ModelCard />
      </div>
    </main>
  );
}

function UpcomingList({ rows, selected }: { rows: UpcomingSimBout[]; selected: string | null }) {
  if (!rows.length) return <section className={`${s.card} ${s.empty}`}><h2 className={s.h2}>No upcoming UFC bouts on the schedule</h2><p className={s.note}>Build a matchup instead.</p></section>;
  const events = [...new Map(rows.map((r) => [r.event.id, r.event])).values()];
  return (
    <div className={s.list} data-sim-upcoming="">
      {events.map((e) => (
        <section key={e.id} className={s.eventGroup} aria-label={e.name}>
          <div className={s.eventHead}><span>{e.name}</span><span className={s.faint}>{fmtDate(e.event_date)}</span></div>
          {rows.filter((r) => r.event.id === e.id).map((r) => (
            <Link key={r.bout.id} href={`/simulator?bout=${r.bout.id}#simulation`} className={`${s.row} ${selected === r.bout.id ? s.rowOn : ""}`} aria-current={selected === r.bout.id ? "true" : undefined} data-sim-bout={r.bout.id}>
              <span className={s.rowNames}><span>{r.bout.fighter_a.name}</span><span className={s.faint}> vs </span><span>{r.bout.fighter_b.name}</span></span>
              <span className={s.rowMeta}>
                <span>{WC(r.bout.weight_class) || "—"}</span>
                <DnaCoverage tiers={r.tiers} />
                {r.rounds ? null : <span className={s.faint} data-sim-rounds="unresolved">ROUNDS UNCONFIRMED</span>}
              </span>
            </Link>
          ))}
        </section>
      ))}
    </div>
  );
}

function ManualForm({ roster, a, b, r, error }: { roster: RosterFighter[]; a?: string; b?: string; r?: string; error: string | null }) {
  const nameFor = (v?: string) => { const sid = v ? fighterIdFromSlug(v) : null; const f = sid ? roster.find((x) => x.espn_athlete_id === sid || x.ufcstats_id === sid) : null; return f ? f.name : v || ""; };
  return (
    <form className={`${s.card} ${s.form}`} method="get" action="/simulator#simulation" data-sim-manual="">
      <input type="hidden" name="mode" value="manual" />
      <h2 className={s.h2}>Build a matchup</h2>
      <p className={s.note}>{roster.length.toLocaleString("en-US")} active fighters with verified round-level Fight DNA.</p>
      <label className={s.field}><span>Fighter A</span><input name="a" list="sim-roster" defaultValue={nameFor(a)} autoComplete="off" required placeholder="Type a name" /></label>
      <label className={s.field}><span>Fighter B</span><input name="b" list="sim-roster" defaultValue={nameFor(b)} autoComplete="off" required placeholder="Type a name" /></label>
      <label className={s.field}><span>Format</span>
        <select name="r" defaultValue={r === "5" ? "5" : "3"}><option value="3">3 rounds</option><option value="5">5 rounds</option></select>
      </label>
      <datalist id="sim-roster">{roster.map((f) => <option key={f.id} value={f.name} />)}</datalist>
      {error && <p className={s.formError} role="alert">{error}</p>}
      <button type="submit" className="btn gold">Simulate</button>
    </form>
  );
}
