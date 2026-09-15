// The production champion: the one live, hash-verified ufc_model_versions row
// of the family. Resolved from the registry on every cycle, never from code, so
// an owner-approved promotion takes effect on the next cycle and nothing else
// can change which model makes official calls.

import { FEATURE_KEYS, FEATURE_VERSION, MODEL_FAMILY, MODEL_VERSION } from '../../../scripts/model/feature_spec.mjs';

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Canonical spec serialisation shared by register_model.mjs, the registry check and promotion. */
export const specCanonical = ({ model_version, feature_version, beta, scale, lambda }) =>
  JSON.stringify({ model_version, feature_version, features: FEATURE_KEYS, coefficients: beta, scale, lambda });

export const VERSION_SELECT = 'model_version,model_family,feature_version,status,coefficients,feature_scale,spec_sha256,hyperparameters,training_window_start,training_window_end,training_bouts';

/** Verify one registry row. Returns the scoring spec, or why it cannot score. */
export async function verifyVersion(reg) {
  const beta = FEATURE_KEYS.map((k) => reg.coefficients?.[k]);
  const scale = FEATURE_KEYS.map((k) => reg.feature_scale?.[k]);
  const recomputed = await sha256Hex(specCanonical({ model_version: reg.model_version, feature_version: reg.feature_version, beta, scale, lambda: reg.hyperparameters?.lambda }));
  const verified = recomputed === reg.spec_sha256 && reg.feature_version === FEATURE_VERSION && beta.every(Number.isFinite) && scale.every(Number.isFinite);
  return { verified, recomputed, beta, scale };
}

/**
 * The live champion of the family, or a precise reason there is none.
 * { live, model_version, spec_sha256, beta, scale, row } | { live:false, blocked, row }
 */
export async function resolveChampion(q, family = MODEL_FAMILY) {
  const rows = await q.get(`ufc_model_versions?select=${VERSION_SELECT}&model_family=eq.${family}&order=model_version.asc`);
  const live = rows.filter((r) => r.status === 'live');
  if (live.length > 1) return { live: false, blocked: `${live.length} live versions in ${family}; exactly one is allowed`, row: null };
  const reg = live[0] || rows.find((r) => r.model_version === MODEL_VERSION) || null;
  if (!reg) return { live: false, blocked: 'no registered live model version', row: null };
  const v = await verifyVersion(reg);
  if (!v.verified) return { live: false, blocked: `registered spec_sha256 does not re-hash (${v.recomputed.slice(0, 12)} vs ${String(reg.spec_sha256).slice(0, 12)})`, row: reg };
  if (reg.status !== 'live') return { live: false, blocked: `model_version status is ${reg.status}, not live`, row: reg };
  return { live: true, model_version: reg.model_version, spec_sha256: reg.spec_sha256, beta: v.beta, scale: v.scale, row: reg };
}
