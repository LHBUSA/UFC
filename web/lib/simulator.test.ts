/* PBE Fight Simulator product surface (/simulator).
 *
 *   - end to end on real production rows (UFC 333 Volkanovski vs Evloev,
 *     captured read-only): the web pipeline reproduces the live PBE Fight
 *     Model anchor and the Phase 3 simulation id byte for byte;
 *   - the exclusive as-of cutoff: a contaminated snapshot is skipped;
 *   - FULL / LIMITED / INSUFFICIENT_DATA render correctly, INSUFFICIENT never
 *     renders a number;
 *   - method shares normalise, goes-distance is the artifact's own value;
 *   - no finish-round, finish-time, round-winner or unvalidated point claim is
 *     ever rendered;
 *   - Labs gate: results only for access.pro, decided before any read. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { register } from "node:module";
import { runSimulationFromRows, pickValidSnapshot, type CornerRows, type SnapshotRow } from "./simulatorRun.ts";
import { simulate } from "./vendor/sim-engine/simulate.mjs";
import { simGate, methodRows, winView, pathView, roundRanges, expectedGate, MODEL_CARD, UNAVAILABLE_COPY } from "./simulatorView.ts";
import { labsSimulatorAccess } from "./labsAccess.ts";

register("../scripts/test-tsx-hooks.mjs", import.meta.url);

const web = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, web), "utf8");
const json = (rel: string) => JSON.parse(read(rel));

type Fx = { spec: Parameters<typeof runSimulationFromRows>[0]; corners: Array<Omit<CornerRows, "modelSnapshots"> & { modelSnapshots: Record<string, Record<string, unknown>> }>; opponentRows: Parameters<typeof runSimulationFromRows>[3] };
const FX = json("lib/fixtures/simulator-ufc333-volkanovski-evloev.json") as Fx;
const corner = (c: Fx["corners"][number]): CornerRows => ({ ...c, modelSnapshots: new Map(Object.entries(c.modelSnapshots)) });
const LIVE = runSimulationFromRows(FX.spec, corner(FX.corners[0]), corner(FX.corners[1]), FX.opponentRows);

/* Engine fixtures from the Phase 2/3 package: FULL, LIMITED and an insufficient corner. */
const eng = (name: string) => json(`../workers/ufc-simulator/fixtures/${name}.json`);
const run = (fx: ReturnType<typeof eng>, other?: { fighter: unknown; snapshot: unknown; ladder: unknown }) => simulate({
  fighter_a: fx.fighter_a, fighter_b: other ?? fx.fighter_b, anchor: fx.anchor,
  settings: { scheduled_rounds: fx.bout.scheduled_rounds, weight_class: fx.bout.weight_class, is_title: fx.bout.is_title, is_womens: fx.bout.is_womens }, n_sims: 4000,
} as never).artifact;
const LIMITED = run(eng("ufc331_aswell_yoo"));
const insuff = eng("tier_insufficient");
const INSUFFICIENT = run(eng("ufc331_aswell_yoo"), { fighter: insuff.fighter, snapshot: insuff.snapshot, ladder: insuff.ladder });

test("end to end on real rows: live PBE Fight Model anchor and the Phase 3 simulation id are reproduced exactly", () => {
  assert.ok(LIVE.anchor, "anchor assembled");
  assert.equal(LIVE.anchor!.model_version, "pbe-fight-model-v1");
  assert.equal(Number(LIVE.anchor!.prob.toFixed(4)), 0.5212, "same probability the ufc-algo Worker computes for Evloev");
  assert.equal(LIVE.anchor!.eligibility.decision, "ELIGIBLE");
  assert.equal(LIVE.anchor!.available_count, 33);
  const a = LIVE.artifact;
  assert.equal(a.status, "OFFICIAL");
  assert.equal(simGate(a), "FULL");
  assert.equal(a.simulator_version, "pbe-fight-simulator-v1.0-rc1");
  assert.equal(a.simulation_id!.slice(0, 12), "aff152b32ee4", "same identity as the Phase 3 fixture: the vendored engine is the engine");
  assert.equal(a.n_sims, 10000);
  assert.ok(Math.abs(a.anchor!.post_anchor_probability - a.anchor!.champion_probability) <= 0.015, "winner split agrees with the champion");
});

test("a rerun on the same rows is byte-identical (deterministic, cache-safe)", () => {
  const again = runSimulationFromRows(FX.spec, corner(FX.corners[0]), corner(FX.corners[1]), FX.opponentRows);
  assert.equal(again.artifact.artifact_sha256, LIVE.artifact.artifact_sha256);
});

test("exclusive as-of cutoff: a snapshot listing a bout dated on/after its as_of is skipped for the previous valid one", () => {
  const good = { fighter_id: "f", as_of_date: "2026-09-18", provenance: { bouts: ["b1"] } } as SnapshotRow;
  const bad = { fighter_id: "f", as_of_date: "2026-09-19", provenance: { bouts: ["b1", "b2"] } } as SnapshotRow;
  const dates = new Map([["b1", "2026-09-10"], ["b2", "2026-09-19"]]);
  const r = pickValidSnapshot([bad, good], dates, "2026-10-01");
  assert.equal(r.snapshot?.as_of_date, "2026-09-18");
  assert.deepEqual(r.rejected, ["2026-09-19"]);
  assert.equal(pickValidSnapshot([{ ...good, as_of_date: "2026-10-02" } as SnapshotRow], dates, "2026-10-01").snapshot, null, "never after the fight date");
});

test("gates: FULL, LIMITED and INSUFFICIENT_DATA; insufficient carries no distribution or path", () => {
  assert.equal(simGate(LIVE.artifact), "FULL");
  assert.equal(simGate(LIMITED), "LIMITED");
  assert.equal(simGate(INSUFFICIENT), "INSUFFICIENT_DATA");
  assert.equal(INSUFFICIENT.probabilities, null);
  assert.equal(INSUFFICIENT.canonical_projection, null);
  assert.equal(simGate(null), "INSUFFICIENT_DATA");
  assert.equal(expectedGate("high", "medium"), "FULL");
  assert.equal(expectedGate("low", "high"), "LIMITED");
  assert.equal(expectedGate(null, "high"), "INSUFFICIENT_DATA");
  assert.equal(expectedGate("insufficient", "high"), "INSUFFICIENT_DATA");
});

test("method shares come from artifact.methods and normalise with the draw share; goes-distance is the artifact's value", () => {
  for (const a of [LIVE.artifact, LIMITED]) {
    const m = methodRows(a);
    assert.ok(Math.abs(m.sum - 1) < 2e-3, `method shares + draw sum to 1 (${m.sum})`);
    const dec = m.rows.find((r) => r.key === "DEC")!.total;
    assert.ok(Math.abs(dec + m.draw - a.probabilities!.goes_distance) < 2e-3, "goes distance = decisions + draws, straight from the engine");
    const w = winView(a);
    assert.ok(Math.abs(w.f1 + w.f2 + w.draw - 1) < 2e-3);
  }
});

test("representative path exposes only winner, method and strike / takedown-attempt counts", () => {
  const p = pathView(LIVE.artifact)!;
  assert.ok(p.rounds.length >= 1);
  for (const r of p.rounds) for (const side of [r.f1, r.f2]) assert.deepEqual(Object.keys(side).sort(), ["sig_a", "sig_l", "td_a"]);
  assert.equal("end_time_sec" in p, false);
  for (const r of roundRanges(LIVE.artifact)) assert.deepEqual(Object.keys(r.f1).sort(), ["sig_a", "sig_l", "td_a"], "ranges only for strike volume and takedown attempts");
});

test("model card figures are the exact Phase 3 report values", () => {
  const report = read("../docs/FIGHT_SIMULATOR_PHASE3.md");
  for (const r of MODEL_CARD.rows) { assert.ok(report.includes(r.simulator), `${r.metric} ${r.simulator} is in the report`); assert.ok(report.includes(r.baseline), `${r.metric} baseline ${r.baseline} is in the report`); }
  assert.ok(report.includes("4,519"));
});

test("Labs access: results only for a verified member decision (access.pro); signed-out and free readers get the locked state", () => {
  assert.deepEqual(labsSimulatorAccess({ pro: true, signedIn: true }), { allowed: true, policy: "labs-preview-members-v1", reason: "member" });
  assert.equal(labsSimulatorAccess({ pro: false, signedIn: true }).allowed, false);
  assert.equal(labsSimulatorAccess({ pro: false, signedIn: false }).reason, "signed_out");
  const labs = read("lib/labsAccess.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(labs, /plan ===|unlimited|stripe|price_/i, "code never re-derives entitlement or touches billing");
  const page = read("app/simulator/page.tsx");
  const gateAt = page.indexOf("const labs = labsSimulatorAccess(access);");
  const runAt = page.indexOf("await runSimulation(");
  assert.ok(gateAt > 0 && runAt > gateAt, "the Labs decision is made before the simulation read");
  assert.match(page, /if \(selection && labs\.allowed\) \{\s*try \{ result = await runSimulation\(/);
  assert.equal((page.match(/runSimulation\(/g) || []).length, 1, "exactly one simulation read");
});

/* ---- rendered output ---- */
async function html(el: unknown) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  return renderToStaticMarkup(el as never);
}
async function views() { return import("../components/simulator/SimulatorViews.tsx"); }
const names = (a: typeof LIVE.artifact) => ({ fighter_1: a.fighters!.fighter_1.name, fighter_2: a.fighters!.fighter_2.name });

async function renderResult(a: typeof LIVE.artifact) {
  const { createElement: h } = await import("react");
  const V = await views();
  const n = names(a);
  return html(h("div", null,
    simGate(a) === "LIMITED" ? h(V.LimitedNote, { a }) : null,
    h(V.WinProbability, { a, left: "fighter_1", names: n }), h(V.GoesDistance, { a }), h(V.OutcomeDistribution, { a, left: "fighter_1", names: n }),
    h(V.VolumeRanges, { a, left: "fighter_1", names: n }), h(V.RepresentativePath, { a, left: "fighter_1", names: n }),
    h(V.Provenance, { a, trainingWindow: { start: "2015-01-03", end: "2026-09-19" }, asOfNames: n })));
}

test("FULL renders win probability, outcome distribution, goes distance and provenance from the artifact", async () => {
  const a = LIVE.artifact;
  const out = await renderResult(a);
  assert.match(out, new RegExp(`data-sim-win="fighter_1">${(a.probabilities!.fighter_1_win * 100).toFixed(1)}%`));
  assert.match(out, new RegExp(`data-sim-distance="">${(a.probabilities!.goes_distance * 100).toFixed(1)}%`));
  for (const k of ["KO_TKO", "SUB", "DEC", "DRAW"]) assert.match(out, new RegExp(`data-sim-method="${k}"`));
  assert.match(out, /Outcome distribution/);
  assert.match(out, /Representative simulated path/);
  assert.match(out, /pbe-fight-simulator-v1\.0-rc1/);
  assert.match(out, /pbe-fight-model-v1/);
  assert.doesNotMatch(out, /data-sim-limited/);
});

test("LIMITED renders probabilities with the LIMITED state and its reasons", async () => {
  const out = await renderResult(LIMITED);
  assert.match(out, /data-sim-limited=""/);
  assert.match(out, /data-sim-gate="LIMITED"/);
  assert.match(out, /data-sim-win="fighter_1">\d+\.\d%/);
});

test("INSUFFICIENT_DATA renders the unavailable state and no fabricated number", async () => {
  const { createElement: h } = await import("react");
  const V = await views();
  const out = await html(h(V.Unavailable, { a: INSUFFICIENT }));
  assert.ok(out.includes(UNAVAILABLE_COPY));
  assert.match(out, /data-sim-gate="INSUFFICIENT_DATA"/);
  assert.doesNotMatch(out, /\d+\.\d%/, "no probability rendered");
});

test("no finish-round, finish-time, round-winner or unvalidated point claim appears anywhere in the rendered results or page copy", async () => {
  const outs = [await renderResult(LIVE.artifact), await renderResult(LIMITED)];
  const { createElement: h } = await import("react");
  const V = await views();
  outs.push(await html(h(V.ModelCard, null)), await html(h(V.HowItWorks, null)));
  const page = read("app/simulator/page.tsx");
  for (const out of outs) {
    /* The model card's own "Not shown because they are not yet validated: ..." disclaimer names the excluded outputs; it is the one place they may be named. */
    const text = out.replace(/<[^>]+>/g, " ").replace(/Not shown because they are not yet validated:[^.]*\./, "");
    assert.equal((text.match(/Not shown because/g) || []).length, 0);
    assert.doesNotMatch(text, /\b\d{1,2}:\d{2}\b/, "no clock time (finish time)");
    assert.doesNotMatch(text, /\b(wins|finish(es)?|stopped|ends?) (in|at|by the end of) round \d/i, "no finish-round claim");
    assert.doesNotMatch(text, /PBE ROUND|10-9|10-8|round winner/i, "no round-winner / round-score claims");
    assert.doesNotMatch(text, /\b(knockdowns?|control time|takedowns landed|submission attempts)\b[^.]*\d/i, "no point estimates for unvalidated stats");
    assert.doesNotMatch(text, /\bwill (win|finish|knock)|guarantee|lock of|AI\b/i, "no certainty or AI-magic language");
  }
  assert.doesNotMatch(page, /time_window|end_time|elapsed_sec|finish_time|ending_line|\.read\b/, "the page never reads the engine's time fields or narrative lines");
});

test("the locked panel renders no simulation output and sells membership only through existing /pro", async () => {
  const { createElement: h } = await import("react");
  const V = await views();
  const out = await html(h(V.LockedPanel, { reason: "signed_out", loginHref: "/login?next=%2Fsimulator" }));
  assert.match(out, /data-sim-locked=""/);
  assert.match(out, /href="\/pro"/);
  assert.doesNotMatch(out, /\d+\.\d%|stripe\.com/);
});

test("route exists and is not pending", () => {
  assert.ok(existsSync(new URL("app/simulator/page.tsx", web)));
  assert.match(read("lib/site.ts"), /\{ href: "\/simulator", label: "FIGHT SIMULATOR", place: "primary", flagship: true, badge: "LABS" \}/);
});
