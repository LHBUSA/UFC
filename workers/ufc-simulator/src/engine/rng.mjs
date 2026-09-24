// Deterministic PRNG for the simulator.
//
// xoshiro128** (Blackman & Vigna, public domain), seeded through splitmix32
// from a SHA-256 digest. 32-bit integer arithmetic only, so the stream is
// bit-identical in Node and workerd. Never seeded from time, Math.random,
// request data or a user.
//
// Two streams are used per simulation:
//   - per-fight streams derived as sha256(seed || fightIndex): fight i is the
//     same fight whether the run asks for 2,000 or 10,000 fights, and shards
//     can run in parallel and still reproduce the single-process result;
//   - the anchor search uses exactly those fight streams (common random
//     numbers), so the tilt bisection is a deterministic function of the seed.

import { sha256Hex } from './sha256.mjs';

export function splitmix32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** Sixteen hex bytes (32 hex chars) -> xoshiro state, scrambled through splitmix32 so no state word can be zero-heavy. */
export function stateFromHex(hex32) {
  if (!/^[0-9a-f]{32}$/.test(hex32)) throw new Error('stateFromHex expects 32 lowercase hex chars');
  const s = new Uint32Array(4);
  for (let i = 0; i < 4; i++) {
    const word = parseInt(hex32.slice(i * 8, i * 8 + 8), 16) >>> 0;
    s[i] = splitmix32(word)();
  }
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 1;
  return s;
}

export class Xoshiro128ss {
  constructor(state) { this.s = Uint32Array.from(state); }
  nextU32() {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }
  /** Uniform in [0, 1) with 53 random bits. */
  nextFloat() {
    const hi = this.nextU32() >>> 5;   // 27 bits
    const lo = this.nextU32() >>> 6;   // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;
  }
}

function rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }

/** The 64-hex master seed for a simulation id. */
export function masterSeed(simulationId) {
  return sha256Hex(`pbe-sim-seed|${simulationId}`);
}

/** An independent stream for fight `index` under a master seed. */
export function fightRng(masterSeedHex, index) {
  const hex = sha256Hex(`${masterSeedHex}|fight|${index}`);
  return new Xoshiro128ss(stateFromHex(hex.slice(0, 32)));
}
