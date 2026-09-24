// LEAKAGE GUARD for walk-forward scoring. A bout of year Y may only be scored
// with params_fold_Y: provenance must say it was trained on years < Y, its
// training window must end before the bout date, and no component may carry
// the all-data fit. params_fold_all exists only to propose the future-facing
// frozen set (freeze.mjs) and is refused here unconditionally.
export function assertWalkForwardParams(P, year, eventDate) {
  if (!Number.isInteger(year)) throw new Error(`walk-forward params require an integer fold year, got ${year}`);
  const fold = P?.provenance?.fold || '';
  if (/^all/.test(fold) || fold !== `fold-${year}-train-lt-${year}`) throw new Error(`LEAKAGE GUARD: params provenance '${fold}' is not the walk-forward fold for ${year}`);
  const end = P.provenance?.training_window?.end;
  if (!end || !(end < eventDate)) throw new Error(`LEAKAGE GUARD: training window end ${end} is not before bout date ${eventDate}`);
  for (const [name, m] of Object.entries(P.models || {})) if (!m.provenance || /all/.test(m.provenance) || m.provenance !== fold) throw new Error(`LEAKAGE GUARD: component ${name} provenance '${m.provenance}' does not match fold '${fold}'`);
  return true;
}
