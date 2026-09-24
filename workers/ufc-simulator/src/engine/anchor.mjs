// Champion anchor: calibrate the engine's aggregate winner split to the
// champion probability with one scalar tilt, found by bisection under common
// random numbers (fight i always uses the stream derived from the master seed
// and i, whatever the tilt).
//
// The tilt is a diagnostic as much as a control: a large tilt means the state
// engine, fed the same Fight DNA, disagrees with the champion. That is
// recorded (pre_anchor_probability, champion_probability,
// post_anchor_probability, tilt_applied) and, beyond `max_tilt`, flagged as
// `excessive_tilt`. It is never hidden.

import { fightRng } from './rng.mjs';
import { simulateFight } from './fight.mjs';
import { Batch } from './aggregate.mjs';
import { round4 } from './canonical.mjs';

/** Run `n` fights under `tilt` into a fresh batch. Fight i always uses stream i. */
export function runBatch(ctx, seedHex, n, tilt) {
  const b = new Batch(n, ctx.R);
  for (let i = 0; i < n; i++) b.push(i, simulateFight(ctx, fightRng(seedHex, i), tilt));
  return b;
}

export function calibrateTilt(ctx, seedHex, target, params) {
  const T = params.tilt;
  const nCal = Math.min(T.calibration_sims, 1e6);
  const f = (tilt) => runBatch(ctx, seedHex, nCal, tilt).p1() - target;
  let lo = -T.search_max, hi = T.search_max;
  let fLo = f(lo), fHi = f(hi);
  const trace = [{ tilt: lo, p1: round4(fLo + target) }, { tilt: hi, p1: round4(fHi + target) }];
  if (Math.sign(fLo) === Math.sign(fHi)) {
    // Not bracketed: the engine cannot reach the champion probability inside the search range.
    const pick = Math.abs(fLo) < Math.abs(fHi) ? lo : hi;
    return { tilt: pick, status: 'not_bracketed', iterations: 2, calibration_sims: nCal, trace };
  }
  let mid = 0, fMid = f(0);
  trace.push({ tilt: 0, p1: round4(fMid + target) });
  if (Math.abs(fMid) <= T.tolerance) return { tilt: 0, status: 'ok', iterations: 3, calibration_sims: nCal, trace };
  if (Math.sign(fMid) === Math.sign(fLo)) { lo = 0; fLo = fMid; } else { hi = 0; fHi = fMid; }
  let it = 3;
  for (; it < T.iterations + 3; it++) {
    mid = (lo + hi) / 2;
    fMid = f(mid);
    trace.push({ tilt: round4(mid), p1: round4(fMid + target) });
    if (Math.abs(fMid) <= T.tolerance) break;
    if (Math.sign(fMid) === Math.sign(fLo)) { lo = mid; fLo = fMid; } else { hi = mid; fHi = fMid; }
  }
  const tilt = round4(mid);
  return { tilt, status: Math.abs(tilt) > T.max_tilt ? 'excessive_tilt' : 'ok', iterations: it + 1, calibration_sims: nCal, trace };
}
