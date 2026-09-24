// Simulation identity.
//
// simulation_id = sha256(canonical identity). Same fighters, same resolved
// snapshot dates, same versions, same format, same engine spec, same n_sims
// -> same id -> same seed -> same artifact. Fighters are ordered by UUID so
// (A, B) and (B, A) are the same simulation.
//
// inputs_sha256 is NOT part of the identity: it is stored beside the artifact
// so a later recompute can detect that an input row was repaired (or that a
// contaminated same-day snapshot was replaced) and write a new revision
// instead of silently overwriting.

import { sha256Hex } from './sha256.mjs';
import { canonicalJson } from './canonical.mjs';
import { SIMULATOR_VERSION, RULES_VERSION, DNA_DEFINITION_VERSION, FEATURE_VERSION, DEFAULT_PARAMS } from './params.mjs';

export function engineSpec(params = DEFAULT_PARAMS, simulatorVersion = SIMULATOR_VERSION) {
  return { simulator_version: simulatorVersion, rules_version: RULES_VERSION, params };
}

export function engineSpecSha256(params = DEFAULT_PARAMS, simulatorVersion = SIMULATOR_VERSION) {
  return sha256Hex(canonicalJson(engineSpec(params, simulatorVersion)));
}

export function canonicalOrder(idA, idB) {
  return String(idA) < String(idB) ? [idA, idB] : [idB, idA];
}

/**
 * @param {object} o
 * @param {string} o.fighter_1_id  smaller UUID
 * @param {string} o.fighter_2_id
 * @param {string} o.fighter_1_as_of resolved snapshot as_of_date
 * @param {string} o.fighter_2_as_of
 * @param {number} o.scheduled_rounds
 * @param {object} o.scenario {weight_class,is_title,is_womens}
 * @param {string} o.model_version
 * @param {string} o.model_spec_sha256
 * @param {string} o.engine_spec_sha256
 * @param {number} o.n_sims
 */
export function buildIdentity(o) {
  const [f1, f2] = canonicalOrder(o.fighter_1_id, o.fighter_2_id);
  if (f1 !== o.fighter_1_id) throw new Error('buildIdentity expects fighters in canonical (UUID) order');
  return {
    simulator_version: o.simulator_version || SIMULATOR_VERSION,
    engine_spec_sha256: o.engine_spec_sha256,
    rules_version: RULES_VERSION,
    model_version: o.model_version,
    model_spec_sha256: o.model_spec_sha256,
    dna_definition_version: DNA_DEFINITION_VERSION,
    feature_version: FEATURE_VERSION,
    fighter_1_id: f1,
    fighter_1_as_of: o.fighter_1_as_of,
    fighter_2_id: f2,
    fighter_2_as_of: o.fighter_2_as_of,
    scheduled_rounds: o.scheduled_rounds,
    scenario: { weight_class: o.scenario?.weight_class ?? null, is_title: Boolean(o.scenario?.is_title), is_womens: Boolean(o.scenario?.is_womens) },
    n_sims: o.n_sims,
  };
}

export function simulationId(identity) {
  return sha256Hex(canonicalJson(identity));
}

export function inputsDigest(parts) {
  return sha256Hex(canonicalJson(parts));
}
