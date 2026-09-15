// D1: authoritative current card truth for official PBE Algo processing. PURE.
//
// The newest ufc_event_card_observations row for an event (written by the
// ufc-stats-ingest ESPN pass, migration 029) says which competitions the card
// currently lists. A bout whose ufc_bouts.status still says 'announced' but is
// not a listed competition must not regenerate or lock: it is treated exactly
// like a bout with an active sourced withdrawal/replacement (existing
// eligibility reason BOUT_NOT_SCHEDULED). Nothing here makes any bout MORE
// callable than before; it can only remove one.
//
//   confirmed    listed as a bout on the newest complete observation  -> unchanged V1 behaviour
//   unobserved   no observation for this event yet                    -> unchanged V1 behaviour
//   missing      observed card no longer lists this competition        -> not scheduled
//   placeholder  listed only without a complete matchup                -> not scheduled (ambiguous)
//   no_source_id bout has no ESPN competition id on an observed card   -> not scheduled (ambiguous)
//   incomplete   newest observation did not read the whole card        -> not scheduled (ambiguous)

export const CARD_TRUTH_BLOCKING = Object.freeze(['missing', 'placeholder', 'no_source_id', 'incomplete']);

export function cardTruth(bout, observation) {
  if (!observation) return { state: 'unobserved', blocking: false, observed_at: null };
  const base = { observed_at: observation.observed_at ?? null, source: observation.source ?? null };
  let state;
  if (observation.complete !== true) state = 'incomplete';
  else if (!bout.espn_competition_id) state = 'no_source_id';
  else if ((observation.competition_ids || []).map(String).includes(String(bout.espn_competition_id))) state = 'confirmed';
  else if ((observation.placeholder_ids || []).map(String).includes(String(bout.espn_competition_id))) state = 'placeholder';
  else state = 'missing';
  return { ...base, state, blocking: CARD_TRUTH_BLOCKING.includes(state) };
}
