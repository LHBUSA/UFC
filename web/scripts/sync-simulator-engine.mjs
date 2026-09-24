/* Vendor the PBE Fight Simulator engine and the PBE Fight Model feature core
 * into web/lib/vendor so the Next build (which only compiles files under web/)
 * can run the exact same code as the engine package and the ufc-algo Worker.
 *
 * Same contract as lib/pbe-membership.js: the copies are byte-identical to
 * their sources (line endings normalised to LF), nothing is edited by hand,
 * and lib/simulatorEngine.test.ts fails the moment a source changes without a
 * re-sync. Run from web/:  node scripts/sync-simulator-engine.mjs  */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(WEB, "..");

/* Runtime engine modules only: tests, fixtures, the parity harness and the
 * cross-process checker stay in the engine package. */
export const ENGINE_SRC = "workers/ufc-simulator/src/engine";
export const ENGINE_FILES = [
  "aggregate.mjs", "anchor.mjs", "canonical.mjs", "dist.mjs", "fight.mjs", "fingerprint.mjs", "inputs.mjs",
  "medoid.mjs", "models.mjs", "narrative.mjs", "params.mjs", "params_fitted_v1.mjs", "rng.mjs", "sha256.mjs", "simulate.mjs",
];
/* The champion's feature assembly and scoring, as the ufc-algo Worker runs them. */
export const MODEL_SRC = "scripts/model";
export const MODEL_FILES = ["features_core.mjs", "feature_spec.mjs", "logistic.mjs", "eligibility.mjs"];

export const TARGETS = [
  { src: ENGINE_SRC, dest: "lib/vendor/sim-engine", files: ENGINE_FILES },
  { src: MODEL_SRC, dest: "lib/vendor/pbe-model", files: MODEL_FILES },
];

const lf = (t) => t.replace(/\r\n/g, "\n");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const t of TARGETS) {
    const dest = join(WEB, t.dest);
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(dest)) if (name.endsWith(".mjs")) rmSync(join(dest, name));
    for (const f of t.files) writeFileSync(join(dest, f), lf(readFileSync(join(REPO, t.src, f), "utf8")));
    console.log(`synced ${t.files.length} files ${t.src} -> web/${t.dest}`);
  }
}
