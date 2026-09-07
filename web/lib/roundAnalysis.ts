/* Round-by-Round Analysis — deterministic derivation from stored round
 * observations. No inference, no narrative generation, no scoring.
 *
 * Three rules shape everything below.
 *
 * A missing observation is null, never zero. UFC Stats reporting a fighter
 * landed nothing is a fact; the row not existing is an absence. Rendering
 * both as "0" would quietly invent data, so every accessor here returns null
 * when the input is null and every consumer must handle it.
 *
 * Nothing here claims a fighter won a round. There is no judge feed, so the
 * product may describe what the numbers show — more output, more control —
 * and may not translate that into a score. The labels are deliberately
 * "output edge" and "control edge" rather than anything resembling 10-9.
 *
 * Every signal is a threshold on an arithmetic comparison, computed the same
 * way every time from the same inputs. A signal that cannot be computed
 * because a denominator is missing or a sample is too small is omitted, not
 * softened into prose.
 */
import type { RoundStat } from "@/lib/db";
import type { Confidence, DnaSnapshot, MetricObject } from "@/lib/dna";

export type Corner = "a" | "b";

/* A round the source actually reported, for one or both corners. */
export type RoundView = {
  round: number;
  a: RoundStat | null;
  b: RoundStat | null;
  /* Observed length of this round in seconds, or null when it cannot be known
   * without guessing. Only the final round of a finished fight has a length
   * the result states; earlier rounds ran their full scheduled length. */
  seconds: number | null;
};

export type Ratio = { landed: number; attempted: number; pct: number } | null;
export type Share = { value: number; total: number; pct: number } | null;

const n = (v: number | null | undefined): number | null => (typeof v === "number" ? v : null);
const sum = (...xs: Array<number | null>): number | null =>
  xs.every((x) => x === null) ? null : xs.reduce<number>((acc, x) => acc + (x ?? 0), 0);

/* landed / attempted, null unless both are present and attempts are non-zero.
 * An accuracy of "0%" from zero attempts is not a fact about the fighter. */
export function ratio(landed: number | null | undefined, attempted: number | null | undefined): Ratio {
  const l = n(landed), a = n(attempted);
  if (l === null || a === null || a <= 0) return null;
  return { landed: l, attempted: a, pct: (l / a) * 100 };
}

export function share(part: number | null | undefined, whole: number | null): Share {
  const p = n(part);
  if (p === null || whole === null || whole <= 0) return null;
  return { value: p, total: whole, pct: (p / whole) * 100 };
}

/* Strikes landed per minute of observed round time. */
export function pacePerMin(landed: number | null | undefined, seconds: number | null): number | null {
  const l = n(landed);
  if (l === null || seconds === null || seconds <= 0) return null;
  return (l / seconds) * 60;
}

/* Round lengths. A regulation round is five minutes; the round a fight ends in
 * is as long as the result says. Rounds after the finish did not happen. */
export function roundSeconds(round: number, finishRound: number | null, finishTimeSec: number | null): number | null {
  if (finishRound != null && round === finishRound) return finishTimeSec ?? null;
  if (finishRound != null && round > finishRound) return null;
  return 300;
}

export function buildRounds(
  stats: RoundStat[],
  fighterAId: string,
  fighterBId: string,
  finishRound: number | null,
  finishTimeSec: number | null,
): RoundView[] {
  const byRound = new Map<number, RoundView>();
  for (const s of stats) {
    if (typeof s.round !== "number") continue;
    let v = byRound.get(s.round);
    if (!v) { v = { round: s.round, a: null, b: null, seconds: roundSeconds(s.round, finishRound, finishTimeSec) }; byRound.set(s.round, v); }
    if (s.fighter_id === fighterAId) v.a = s;
    else if (s.fighter_id === fighterBId) v.b = s;
  }
  return [...byRound.values()].sort((x, y) => x.round - y.round);
}

/* ---------------------------------------------------------------- profiles */

export type TargetProfile = { head: Share; body: Share; leg: Share; total: number | null };
export type PhaseProfile = { distance: Share; clinch: Share; ground: Share; total: number | null };

export function targetProfile(s: RoundStat | null): TargetProfile {
  if (!s) return { head: null, body: null, leg: null, total: null };
  const total = sum(n(s.head_landed), n(s.body_landed), n(s.leg_landed));
  return { head: share(s.head_landed, total), body: share(s.body_landed, total), leg: share(s.leg_landed, total), total };
}

export function phaseProfile(s: RoundStat | null): PhaseProfile {
  if (!s) return { distance: null, clinch: null, ground: null, total: null };
  const total = sum(n(s.distance_landed), n(s.clinch_landed), n(s.ground_landed));
  return { distance: share(s.distance_landed, total), clinch: share(s.clinch_landed, total), ground: share(s.ground_landed, total), total };
}

/* Control is only meaningful as a share of the control actually recorded in
 * the round, so it needs both corners. */
export function controlShare(v: RoundView, corner: Corner): Share {
  const mine = n(v[corner]?.ctrl_sec), theirs = n(v[corner === "a" ? "b" : "a"]?.ctrl_sec);
  if (mine === null || theirs === null) return null;
  return share(mine, mine + theirs);
}

/* ----------------------------------------------------------------- signals */

export type SignalTone = "up" | "down" | "neutral";
export type RoundSignal = {
  key: string;
  corner: Corner;
  label: string;
  detail: string;
  tone: SignalTone;
};

/* Thresholds are stated once, here, so a signal is reproducible and arguable
 * rather than a matter of taste. They are intentionally wide: a small change
 * between two five-minute rounds is noise, and calling it a shift would make
 * the feature untrustworthy in exactly the fights people care about. */
export const THRESHOLDS = {
  pacePct: 15,          // % change in significant strikes landed per minute
  accuracyPoints: 10,   // percentage-point change in significant strike accuracy
  targetPoints: 12,     // percentage-point change in head share of landed strikes
  phasePoints: 12,      // percentage-point change in ground or clinch share
  controlPoints: 20,    // percentage-point change in control share
  controlSeconds: 60,   // absolute control seconds gained round over round
  takedownAttempts: 2,  // additional takedown attempts
  absorbedPct: 20,      // % change in significant strikes absorbed per minute
} as const;

const pctChange = (cur: number | null, prev: number | null): number | null =>
  cur === null || prev === null || prev <= 0 ? null : ((cur - prev) / prev) * 100;

const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`;
const fmtPts = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(0)} pts`;

/* Round-over-round comparison for one corner. Returns only the signals whose
 * inputs exist and whose movement clears the stated threshold. */
export function roundOverRound(cur: RoundView, prev: RoundView, corner: Corner, name: string): RoundSignal[] {
  const out: RoundSignal[] = [];
  const c = cur[corner], p = prev[corner];
  if (!c || !p) return out;

  const curPace = pacePerMin(c.sig_str_landed, cur.seconds);
  const prevPace = pacePerMin(p.sig_str_landed, prev.seconds);
  const dPace = pctChange(curPace, prevPace);
  if (dPace !== null && Math.abs(dPace) >= THRESHOLDS.pacePct) {
    out.push({
      key: "pace", corner, tone: dPace > 0 ? "up" : "down",
      label: dPace > 0 ? "Pace up" : "Pace down",
      detail: `${name}'s significant-strike pace moved ${fmtPct(dPace)} from R${prev.round} to R${cur.round}, ${curPace!.toFixed(1)} against ${prevPace!.toFixed(1)} per minute.`,
    });
  }

  const curAcc = ratio(c.sig_str_landed, c.sig_str_att), prevAcc = ratio(p.sig_str_landed, p.sig_str_att);
  if (curAcc && prevAcc) {
    const d = curAcc.pct - prevAcc.pct;
    if (Math.abs(d) >= THRESHOLDS.accuracyPoints) {
      out.push({
        key: "accuracy", corner, tone: d > 0 ? "up" : "down",
        label: "Accuracy shift",
        detail: `${name}'s significant-strike accuracy moved ${fmtPts(d)}, ${curAcc.pct.toFixed(0)}% against ${prevAcc.pct.toFixed(0)}%.`,
      });
    }
  }

  const curT = targetProfile(c), prevT = targetProfile(p);
  if (curT.head && prevT.head) {
    const d = curT.head.pct - prevT.head.pct;
    if (Math.abs(d) >= THRESHOLDS.targetPoints) {
      out.push({
        key: "target", corner, tone: "neutral",
        label: "Target shift",
        detail: `${name}'s head share of landed strikes moved ${fmtPts(d)}, to ${curT.head.pct.toFixed(0)}% head with ${curT.body?.pct.toFixed(0) ?? "—"}% body and ${curT.leg?.pct.toFixed(0) ?? "—"}% leg.`,
      });
    }
  }

  const curP = phaseProfile(c), prevP = phaseProfile(p);
  if (curP.ground && prevP.ground) {
    const d = curP.ground.pct - prevP.ground.pct;
    if (Math.abs(d) >= THRESHOLDS.phasePoints) {
      out.push({
        key: "phase", corner, tone: "neutral",
        label: "Phase shift",
        detail: `${name}'s ground share of landed strikes moved ${fmtPts(d)}, to ${curP.ground.pct.toFixed(0)}% on the ground against ${curP.distance?.pct.toFixed(0) ?? "—"}% at distance.`,
      });
    }
  }

  const dTdAtt = (n(c.td_att) ?? 0) - (n(p.td_att) ?? 0);
  const dCtrl = (n(c.ctrl_sec) ?? 0) - (n(p.ctrl_sec) ?? 0);
  if (n(c.td_att) !== null && n(p.td_att) !== null && dTdAtt >= THRESHOLDS.takedownAttempts) {
    out.push({
      key: "grappling", corner, tone: "up",
      label: "Grappling pressure",
      detail: `${name} attempted ${dTdAtt} more takedown${dTdAtt === 1 ? "" : "s"} than in R${prev.round}, ${n(c.td_att)} against ${n(p.td_att)}.`,
    });
  }
  if (n(c.ctrl_sec) !== null && n(p.ctrl_sec) !== null && Math.abs(dCtrl) >= THRESHOLDS.controlSeconds) {
    out.push({
      key: "control", corner, tone: dCtrl > 0 ? "up" : "down",
      label: "Control swing",
      detail: `${name}'s control time moved ${dCtrl > 0 ? "+" : ""}${Math.round(dCtrl)}s, ${Math.round(n(c.ctrl_sec)!)}s against ${Math.round(n(p.ctrl_sec)!)}s.`,
    });
  }

  /* Absorbed pace is the opponent's output, so it is read off the other corner. */
  const other: Corner = corner === "a" ? "b" : "a";
  const curAbs = pacePerMin(cur[other]?.sig_str_landed, cur.seconds);
  const prevAbs = pacePerMin(prev[other]?.sig_str_landed, prev.seconds);
  const dAbs = pctChange(curAbs, prevAbs);
  if (dAbs !== null && dAbs >= THRESHOLDS.absorbedPct) {
    out.push({
      key: "defensive", corner, tone: "down",
      label: "Defensive drift",
      detail: `${name} absorbed significant strikes ${fmtPct(dAbs)} faster than in R${prev.round}, ${curAbs!.toFixed(1)} against ${prevAbs!.toFixed(1)} per minute.`,
    });
  }

  return out;
}

/* ------------------------------------------------------------------- edges */

export type RoundEdge = { key: string; label: string; corner: Corner; detail: string };

/* Descriptive statistical edges. These are explicitly NOT round scores: they
 * say who did more of a measurable thing, which is all the data supports. */
export function roundEdges(v: RoundView, nameA: string, nameB: string): RoundEdge[] {
  const out: RoundEdge[] = [];
  const names = { a: nameA, b: nameB };

  const sa = n(v.a?.sig_str_landed), sb = n(v.b?.sig_str_landed);
  if (sa !== null && sb !== null && sa !== sb) {
    const lead: Corner = sa > sb ? "a" : "b";
    const hi = Math.max(sa, sb), lo = Math.min(sa, sb);
    if (hi - lo >= 5 || (lo > 0 && hi / lo >= 1.2)) {
      out.push({ key: "output", label: "Output edge", corner: lead, detail: `${names[lead]} landed ${hi} significant strikes to ${lo}.` });
    }
  }

  const ca = n(v.a?.ctrl_sec), cb = n(v.b?.ctrl_sec);
  if (ca !== null && cb !== null && Math.abs(ca - cb) >= THRESHOLDS.controlSeconds) {
    const lead: Corner = ca > cb ? "a" : "b";
    out.push({ key: "control", label: "Control edge", corner: lead, detail: `${names[lead]} held ${Math.round(Math.max(ca, cb))}s of control to ${Math.round(Math.min(ca, cb))}s.` });
  }

  const aa = ratio(v.a?.sig_str_landed, v.a?.sig_str_att), ab = ratio(v.b?.sig_str_landed, v.b?.sig_str_att);
  if (aa && ab && Math.abs(aa.pct - ab.pct) >= THRESHOLDS.accuracyPoints) {
    const lead: Corner = aa.pct > ab.pct ? "a" : "b";
    out.push({ key: "striking", label: "Striking edge", corner: lead, detail: `${names[lead]} struck at ${Math.max(aa.pct, ab.pct).toFixed(0)}% accuracy to ${Math.min(aa.pct, ab.pct).toFixed(0)}%.` });
  }

  return out;
}

/* ------------------------------------------------ observed vs historical DNA */

export type DnaCompare = {
  key: string;
  label: string;
  unit: string;
  observed: number;
  baseline: number;
  deltaPct: number | null;
  deltaPoints: number | null;
  confidence: Confidence;
  sample: string;
};

const usable = (m?: MetricObject | null): m is MetricObject =>
  Boolean(m && typeof m.value === "number" && m.confidence && m.confidence !== "insufficient");

/* Compares what happened in this fight against the fighter's pre-fight Fight
 * DNA. Skipped entirely when the baseline's sample is insufficient, because a
 * comparison against one prior bout is a coincidence, not a deviation. */
export function compareToDna(
  rounds: RoundView[],
  corner: Corner,
  snapshot: DnaSnapshot | null | undefined,
): DnaCompare[] {
  if (!snapshot?.metrics) return [];
  const out: DnaCompare[] = [];

  const totalSeconds = rounds.reduce<number>((acc, r) => acc + (r.seconds ?? 0), 0);
  if (totalSeconds <= 0) return [];

  const landed = rounds.reduce<number | null>((acc, r) => sum(acc, n(r[corner]?.sig_str_landed)), null);
  const attempted = rounds.reduce<number | null>((acc, r) => sum(acc, n(r[corner]?.sig_str_att)), null);
  const other: Corner = corner === "a" ? "b" : "a";
  const absorbed = rounds.reduce<number | null>((acc, r) => sum(acc, n(r[other]?.sig_str_landed)), null);
  const tdAtt = rounds.reduce<number | null>((acc, r) => sum(acc, n(r[corner]?.td_att)), null);

  const sampleOf = (m: MetricObject) =>
    m.sample_bouts ? `${m.sample_bouts} bout${m.sample_bouts === 1 ? "" : "s"}` : m.sample_rounds ? `${m.sample_rounds} rounds` : "sampled";

  const paceBase = snapshot.metrics.sig_landed_per_min;
  if (landed !== null && usable(paceBase)) {
    const observed = (landed / totalSeconds) * 60;
    out.push({
      key: "pace", label: "Significant strikes landed / min", unit: "per min",
      observed, baseline: paceBase.value as number,
      deltaPct: (paceBase.value as number) > 0 ? ((observed - (paceBase.value as number)) / (paceBase.value as number)) * 100 : null,
      deltaPoints: null, confidence: paceBase.confidence, sample: sampleOf(paceBase),
    });
  }

  const accBase = snapshot.metrics.sig_accuracy;
  const accObs = ratio(landed, attempted);
  if (accObs && usable(accBase)) {
    const base = (accBase.value as number) <= 1 ? (accBase.value as number) * 100 : (accBase.value as number);
    out.push({
      key: "accuracy", label: "Significant strike accuracy", unit: "%",
      observed: accObs.pct, baseline: base, deltaPct: null, deltaPoints: accObs.pct - base,
      confidence: accBase.confidence, sample: sampleOf(accBase),
    });
  }

  const absBase = snapshot.metrics.sig_absorbed_per_min;
  if (absorbed !== null && usable(absBase)) {
    const observed = (absorbed / totalSeconds) * 60;
    out.push({
      key: "absorbed", label: "Significant strikes absorbed / min", unit: "per min",
      observed, baseline: absBase.value as number,
      deltaPct: (absBase.value as number) > 0 ? ((observed - (absBase.value as number)) / (absBase.value as number)) * 100 : null,
      deltaPoints: null, confidence: absBase.confidence, sample: sampleOf(absBase),
    });
  }

  /* Attempts must be compared against an attempts baseline. Falling back to
   * the landed-per-15 metric would silently compare two different quantities
   * and report a deviation that is an artefact of the mismatch. */
  const tdBase = snapshot.metrics.td_attempts_per_15;
  if (tdAtt !== null && usable(tdBase)) {
    const observed = (tdAtt / totalSeconds) * 900;
    out.push({
      key: "takedowns", label: "Takedown attempts / 15 min", unit: "per 15",
      observed, baseline: tdBase.value as number,
      deltaPct: (tdBase.value as number) > 0 ? ((observed - (tdBase.value as number)) / (tdBase.value as number)) * 100 : null,
      deltaPoints: null, confidence: tdBase.confidence, sample: sampleOf(tdBase),
    });
  }

  return out;
}

/* ------------------------------------------------------------------- state */

/* The product's status vocabulary. "Live" is deliberately absent: the source
 * publishes after an event completes, so claiming live would be a lie about
 * the data rather than a description of it. If a source canary later proves
 * rounds appear during a card, a state is added here and nothing else in the
 * feature has to change. */
export type AnalysisState = "prefight" | "pending" | "unavailable" | "final";

export function analysisState(args: {
  hasResult: boolean;
  hasRounds: boolean;
  eventDate: string | null;
  cancelled: boolean;
}): AnalysisState {
  const { hasResult, hasRounds, eventDate, cancelled } = args;
  if (hasRounds) return "final";
  if (cancelled) return "unavailable";
  if (!hasResult) {
    if (!eventDate) return "prefight";
    /* A card that has not happened yet cannot have round data missing. */
    return new Date(`${eventDate}T00:00:00Z`).getTime() > Date.now() ? "prefight" : "pending";
  }
  /* Result exists but no rounds: either the source has not published them yet
   * or it never will. Recent fights get the benefit of the doubt. */
  if (!eventDate) return "pending";
  const age = Date.now() - new Date(`${eventDate}T00:00:00Z`).getTime();
  return age < 7 * 86400000 ? "pending" : "unavailable";
}

export const STATE_COPY: Record<AnalysisState, { label: string; body: string }> = {
  prefight: {
    label: "Round data not yet available",
    body: "This bout has not taken place. Round-by-round analysis appears once verified round-level observations are published.",
  },
  pending: {
    label: "Round data pending",
    body: "This bout is complete but its round-level observations have not been published to our source yet. Nothing is estimated in the meantime.",
  },
  unavailable: {
    label: "Round data unavailable",
    body: "No round-level observations could be sourced for this bout. Older and non-televised bouts frequently have no per-round record at all.",
  },
  final: {
    label: "Final",
    body: "Reconstructed from verified round-level observations.",
  },
};

/* Fight-level summary for the permanent archive view. */
export type FightSummary = {
  totalSig: { a: number | null; b: number | null };
  paceByRound: Array<{ round: number; a: number | null; b: number | null }>;
  controlByRound: Array<{ round: number; a: number | null; b: number | null }>;
  biggestSwing: { corner: Corner; from: number; to: number; deltaPct: number } | null;
};

export function fightSummary(rounds: RoundView[]): FightSummary {
  const totalSig = {
    a: rounds.reduce<number | null>((acc, r) => sum(acc, n(r.a?.sig_str_landed)), null),
    b: rounds.reduce<number | null>((acc, r) => sum(acc, n(r.b?.sig_str_landed)), null),
  };
  const paceByRound = rounds.map((r) => ({ round: r.round, a: pacePerMin(r.a?.sig_str_landed, r.seconds), b: pacePerMin(r.b?.sig_str_landed, r.seconds) }));
  const controlByRound = rounds.map((r) => ({ round: r.round, a: n(r.a?.ctrl_sec), b: n(r.b?.ctrl_sec) }));

  let biggestSwing: FightSummary["biggestSwing"] = null;
  for (const corner of ["a", "b"] as Corner[]) {
    for (let i = 1; i < paceByRound.length; i += 1) {
      const prev = paceByRound[i - 1][corner], cur = paceByRound[i][corner];
      if (prev === null || cur === null || prev <= 0) continue;
      const d = ((cur - prev) / prev) * 100;
      if (!biggestSwing || Math.abs(d) > Math.abs(biggestSwing.deltaPct)) {
        biggestSwing = { corner, from: paceByRound[i - 1].round, to: paceByRound[i].round, deltaPct: d };
      }
    }
  }
  return { totalSig, paceByRound, controlByRound, biggestSwing };
}
