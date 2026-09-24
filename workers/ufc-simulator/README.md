# ufc-simulator — PBE Fight Simulator engine

Family `pbe-fight-simulator`. **Phase 2: engine only.** Pure, deterministic, no I/O. Nothing here is deployed; `wrangler.toml` exists solely so `wrangler dev` can run the runtime-parity gate.

Design and evidence: `docs/FIGHT_SIMULATOR_PHASE1_REPORT.md`, `docs/FIGHT_SIMULATOR_PHASE2.md`.

## What it does

`simulate(request)` takes two fighters' Fight DNA snapshot rows (definition_version 1) plus their per-bout ladder rows, the champion `pbe-fight-model` probability for the pair, and the fight format, and returns one immutable artifact:

- `simulation_id` = SHA-256 of the canonical identity (versions, engine spec hash, fighter ids in UUID order, resolved snapshot dates, format, scenario, n_sims). Same identity, same bytes.
- 10,000-fight distribution: winner, draw, goes-distance, method by winner, finish round, finish timing, fight totals and per-round medians / quartiles, PBE round-win shares.
- `canonical_projection`: winner = distribution leader (= champion pick by construction), method = highest conditional method, round = modal ending round for that method, trajectory = the **medoid** fight of that cell (a real sampled path, never a random roll, never stitched medians), with per-round stats, PBE round scores, and template "round reads" that only verbalise numbers in the round record.
- `anchor`: `pre_anchor_probability`, `champion_probability`, `post_anchor_probability`, `tilt_applied`, status (`ok` | `excessive_tilt` | `not_bracketed`) and the bisection trace.
- `coverage` gate: `FULL` (both corners medium+), `LIMITED` (a low corner, an ineligible anchor, or many fallbacks; projection precision drops to the round, no time window), `INSUFFICIENT_DATA` (no distribution, no projection, message "Not enough Fight DNA to produce a defensible simulation.").
- `REJECTED_SNAPSHOT` when a snapshot lists a bout dated on or after its `as_of_date` (the exclusive cutoff invariant).
- `evidence`: every metric used with observed value, league prior, shrinkage weight and confidence; every fallback; the damage-proxy and position-share disclaimers.
- `inputs_sha256` (stored beside the artifact to detect repaired inputs) and `artifact_sha256` (hash of the canonical artifact; the wall-clock lives in the envelope, outside the hash).

## Layout

```
src/engine/sha256.mjs      pure SHA-256 (identical in Node and workerd)
src/engine/canonical.mjs   canonical JSON + rounding
src/engine/rng.mjs         splitmix32 -> xoshiro128**, per-fight sub-streams
src/engine/dist.mjs        Poisson/binomial by inversion, gamma, negative binomial, multinomial
src/engine/params.mjs      engine PRIORS (documented, replaced by Phase 3 fits) + versions
src/engine/inputs.mjs      profiles from snapshot + ladder, as-of validation, coverage gate
src/engine/fingerprint.mjs identity, simulation_id, engine spec hash, inputs digest
src/engine/fight.mjs       the round-state engine (one fight)
src/engine/aggregate.mjs   batch storage + distribution summary
src/engine/anchor.mjs      runBatch + tilt bisection under common random numbers
src/engine/medoid.mjs      hierarchical cell selection + medoid
src/engine/narrative.mjs   round facts and template reads
src/engine/simulate.mjs    orchestrator -> artifact
fixtures/                  four real matchups (UFC 331 locked champion calls with results; UFC 333 Volkanovski vs Evloev with a locally computed anchor) + low/insufficient tier fighters
bench/bench.mjs            throughput and full-run timing
src/worker.js + wrangler.toml   parity harness only (not deployed)
src/parity/run_parity.mjs  Node vs workerd artifact-hash gate
```

## Run

```
npm test                 # 21 tests incl. 100 same-process runs and 3 fresh processes (~90 s)
npm run bench
npm run parity:worker    # needs wrangler; starts wrangler dev locally, compares hashes, stops it
```

## Contract notes

- Corners are canonical by UUID; `simulate(A,B)` and `simulate(B,A)` return identical bytes and id. The caller's ordering is returned in `input_order` outside the artifact.
- The anchor is a single log-odds tilt (hazards, round margin, and mildly exchange efficiency, opposite signs per corner). Beyond `params.tilt.max_tilt` (1.0) the artifact is flagged; nothing is hidden or forced silently.
- Ending rounds carry stats scaled to the elapsed time with group-consistent rounding (targets and positions always sum to landed strikes).
- Numbers are rounded before hashing (probabilities 4 dp, counts and seconds integers), so floating-point minutiae between runtimes cannot change bytes; the parity gate proves Node and workerd agree on every fixture.
- Every parameter is a prior until Phase 3 registers fitted coefficients under `ufc_model_versions` family `pbe-fight-simulator`. The engine spec hash covers the parameter object, so a parameter change is a new engine spec by construction.
