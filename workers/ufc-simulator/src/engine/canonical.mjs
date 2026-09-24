// Canonical JSON: sorted object keys, no whitespace, arrays in order, numbers
// via JSON's shortest round-trip form. Used for every hash the engine emits so
// the hash depends on content, never on insertion order or formatting.
//
// Rounding helpers live here too: every number that reaches an artifact is
// rounded BEFORE hashing (probabilities to 4 dp, seconds and counts to
// integers), so floating-point minutiae between runtimes cannot change bytes.

export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}

export function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      if (v === undefined) continue;
      out[k] = sortDeep(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`non-finite number in canonical payload`);
  return value;
}

export const round4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
export const round2 = (v) => (v == null ? null : Math.round(v * 1e2) / 1e2);
export const int = (v) => (v == null ? null : Math.round(v));
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
