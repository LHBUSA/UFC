# PBE Fight Simulator — Phase 2 report (engine only)

Date: 2026-09-24. Repo: LHBUSA/UFC, main. Package: `workers/ufc-simulator` (pure engine; nothing deployed; no API; no UI). Phase 1 design: `docs/FIGHT_SIMULATOR_PHASE1_REPORT.md`. Prerequisite fix: `docs/fight_dna_cutoff_fix_2026-09-24.md`.

## Delivered

| Brief item | Where | Gate |
|---|---|---|
| Fight DNA same-day cutoff fixed first | `scripts/dna/build_fight_dna.mjs` v1.2, `repair_historical_snapshots.mjs`, `build_fight_dna.test.mjs` | 8 tests, mutation check fails all 8 on revert; 8 contaminated production rows identified, decision documented |
| Pure simulation module | `workers/ufc-simulator/src/engine/` | 21 tests |
| Deterministic RNG | splitmix32 → xoshiro128**, per-fight sub-streams from `sha256(seed|fight|i)` | known-answer, stream and prefix tests |
| Fingerprint contract | `fingerprint.mjs`: identity → `simulation_id`; `engine_spec_sha256` over the parameter object; `inputs_sha256` beside the artifact | canonical, order-insensitive, spec-covers-params tests |
| State model | `fight.mjs`: sequential rounds; damage proxy, knockdowns taken, fatigue, control, hazards carried; nothing resets | invariants over 10,000 fights × {3,5} rounds |
| Champion anchoring | `anchor.mjs`: single tilt by bisection under common random numbers; `pre_anchor_probability`, `champion_probability`, `post_anchor_probability`, `tilt_applied`, `status`, trace | residual within 0.015 on all fixtures; forced 98.5% anchor → `excessive_tilt`/`not_bracketed` flagged |
| 10k distribution | `aggregate.mjs`: winner/draw/distance, method by winner, finish round, finish timing, fight totals, per-round medians and quartiles, PBE round-win shares | sums-to-one tests |
| Canonical medoid selector | `medoid.mjs`: winner → highest conditional method → modal round → medoid of that cell (a real sampled fight) | projection winner = leader; cell matches; rounds coherent |
| Coverage gate | `inputs.mjs`: FULL / LIMITED / INSUFFICIENT_DATA; `REJECTED_SNAPSHOT` for a snapshot listing a bout dated ≥ its as_of | tier fixtures; poisoned bout dates |
| Tests | `primitives.test.mjs`, `engine.test.mjs`, `determinism.test.mjs` | 100 same-process runs byte-identical; 3 fresh processes; swap symmetry |
| Runtime parity | `src/parity/run_parity.mjs` + `src/worker.js` (wrangler dev, local workerd) | Node and workerd: same `simulation_id` and `artifact_sha256` on all four fixtures |
| Benchmark | `bench/bench.mjs` | below |

## Determinism results

- 100 same-process runs at n_sims 10,000 on Volkanovski vs Evloev: byte-identical artifacts.
- Three fresh Node processes on Pitbull vs Choi: identical `artifact_sha256`.
- `simulate(A,B)` and `simulate(B,A)`: identical id and bytes (corners are canonical by UUID; the caller's order is returned outside the artifact).
- Node 24.11 vs workerd (wrangler 4.131 local): identical id and hash on all four fixtures.
- Numbers are rounded before hashing (probabilities 4 dp, counts and seconds integers); the wall-clock lives in an envelope outside the hash.

## Benchmark (Windows x64, Node 24.11)

| Measure | Value |
|---|---:|
| Raw engine, 10,000 fights × 3 rounds | ~125 ms (12.5 µs per fight) |
| Raw engine, 10,000 fights × 5 rounds | ~160 ms (16 µs per fight) |
| Full `simulate()` (10k pre-anchor + bisection at 2k per evaluation + 10k final + summary + medoid), 3 rounds | 520–630 ms |
| Full `simulate()`, 5 rounds | ~850 ms |
| workerd (wrangler dev local) full run | 0.66–1.1 s |
| Artifact size | 14–17 KB |

Well inside a Worker's default 30 s CPU budget; `cpu_ms = 60000` in the harness config for headroom.

## Fixtures (real data, read 2026-09-24)

| Fixture | Corners (coverage) | Anchor source | Gate |
|---|---|---|---|
| UFC 333 Volkanovski vs Evloev (5 rd, title) | high / high | `predictOne` over `assembleBoutRow`, 33/33 features, P(Evloev) 0.5212 | FULL → OFFICIAL |
| UFC 331 Steveson vs Sharaf | low / low | locked `ufc_model_predictions` row | LIMITED |
| UFC 331 Aswell vs Yoo | medium / low | locked row | LIMITED |
| UFC 331 Pitbull vs Choi | low / medium | locked row | LIMITED |
| tier_low, tier_insufficient | single fighters | — | LIMITED / INSUFFICIENT_DATA |

## Anchor diagnostics (the audit the brief asked for)

| Fixture | pre-anchor P(f1) | champion | post-anchor | tilt | status |
|---|---:|---:|---:|---:|---|
| Evloev (f1) vs Volkanovski | 0.398 | 0.521 | 0.519 | +0.30 | ok |
| Sharaf (f1) vs Steveson | 0.403 | 0.104 | 0.109 | −0.98 | ok (at the 1.0 limit) |
| Aswell (f1) vs Yoo | 0.736 | 0.559 | 0.549 | −0.53 | ok |
| Choi (f1) vs Pitbull | 0.745 | 0.733 | 0.748 | +0.01 | ok |

Reading: the state engine, fed only Fight DNA priors, agrees with the champion where the DNA is rich (Choi/Pitbull needs almost no correction) and disagrees where the champion is leaning on features the engine does not model (Steveson: one stat bout, the champion's 0.90 comes from the ladder, physicals and experience, so the engine needs nearly the maximum tilt). That is exactly the signal `max_tilt` exists to surface. Phase 3 should reduce these tilts by fitting the engine, not by raising the limit.

## Honest read of the prior-driven outputs

- League-average check (average-vs-average, 3 rounds): finish 51% (KO/TKO 32%, SUB 19%), conditional finish hazard by round 0.22 / 0.17 / 0.13 against observed 0.27 / 0.22 / 0.15, draws 2.0% against 0.7% observed. Five rounds: 70% finish.
- The method model is visibly too KO-heavy for durable fighters (Evloev vs Volkanovski projects a KO at 64% conditional on an Evloev win). The durability inputs exist (`finished_by`, shrunk on appearances) but the prior weights are not fitted. This is the first Phase 3 target, along with the finish-hazard shape by round and the 10-8 rule.
- UFC 331 results on the three LIMITED fixtures: winner right once (Aswell), wrong twice (Steveson and Choi lost by first-round KO, both champion picks too). Three bouts say nothing about calibration; they are here as end-to-end proof, not evidence.
- No number in a round read comes from anywhere but the round record (tested).

## Not done in Phase 2, by design

No storage, no lock semantics, no API, no UI, no entitlement, no Stripe. The parity `wrangler.toml` has no routes and `workers_dev = false`; it must not be deployed.

## Owner actions before Phase 3

1. Approve redeploying `ufc-intelligence` with the fixed builder (frozen Worker) and rebuilding the 8 contaminated 2026-09-19 snapshots (`docs/fight_dna_cutoff_fix_2026-09-24.md`).
2. The central `propbetedge.ai/pro` page says "Every current and future PropBetEdge Pro **product**" (source: `propbetedge-news-site/src/pro-content.js` and `pro-seo.js`); the shared contract says "sport". Normalise to "sport" before Labs is sold. Not changed here.

## Phase 3 plan (unchanged from Phase 1 §7)

Replay 2015–2026 bouts with complete round stats (~5,885) strictly as-of, anchored on `ufc_model_backtest_predictions` fold probabilities; fit engine parameters per calendar year on prior years only; grade winner (must equal the anchor), goes-distance, method, finish round, per-round strike/takedown/control distributions, and round winners on the 782 clean-sweep decisions only; register the run under family `pbe-fight-simulator`.
