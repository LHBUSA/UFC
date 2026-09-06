# PropBetEdge Fight DNA v1

Branch: `ufc-fight-dna-v1`
Base: UFC Production V3 acceptance head `a58f746e7c004f392b11396ed3720b4f028540d4`

## Product thesis

Fight DNA is the proprietary analytics layer above the normalized UFC record.

The source facts are not the moat by themselves. The moat is the versioned, reproducible, as-of feature system that transforms fight history, opponent stance, round statistics, position data, finish detail and future action-level events into fighter-specific matchup intelligence.

Fight DNA must answer questions normal fighter pages do not:

- How does a fighter perform against southpaws, orthodox fighters and switch hitters?
- Does striking pace survive from round 1 into rounds 2, 3, 4 and 5?
- Is a fighter head-heavy, body-investing or leg-heavy?
- Does offense happen at distance, in the clinch or on the ground?
- Does a takedown create meaningful control or only score a momentary change of position?
- How does defensive performance change against opposite-stance opponents?
- Where and how do finishes occur?
- What type of opponent profile historically causes the fighter problems?
- Which matchup variables are unusually different from the fighter's historical baseline?

Every metric must carry sample size, provenance, as-of date and a definition version. No hidden magic numbers.

## Source hierarchy

### Layer 0 — normalized canonical identity / schedule / result

Current sources:

- ESPN: schedule, bout identity, results, fighter identity
- UFC Stats: historical matching and round-level stats

These remain canonical source facts.

### Layer 1 — current public-derived Fight DNA

Can be computed from existing tables now:

- result split by opponent stance
- KO/TKO, submission and decision split by opponent stance
- win/loss/finish rates by stance matchup
- target share: head/body/leg
- phase share: distance/clinch/ground
- significant-strike pace and accuracy by round
- knockdowns created / absorbed
- takedown attempts, accuracy and control yield
- submission-attempt rate
- pace retention / late-round drift
- finish round distribution
- short-notice split when `short_notice_days` exists
- five-round / championship-round profiles once round coverage reaches those fights

### Layer 2 — licensed position / finish enrichment

Potential licensed UFC data can deepen the system with:

- back-control time
- mount-control time
- side-control time
- guard / half-guard control time
- distance / standing / ground / neutral time
- finish weapon
- finish target
- finish position
- submission technique

Store licensed facts independently from derived features so the derived layer can be rebuilt if a provider changes.

### Layer 3 — action event stream

Future event-level table should support timestamped actions such as:

- strike attempt / landed
- knockdown
- takedown attempt / landed
- submission attempt
- reversal
- position change

Technique taxonomy can expand when a source legitimately supports it:

- jab / cross / hook / uppercut / overhand
- elbow / spinning elbow
- knee / flying knee
- calf kick / inside leg kick / outside leg kick
- body kick / head kick / front kick / teep / side kick
- roundhouse / spinning back kick / question-mark kick
- single leg / double leg / body lock / trip / throw
- armbar / rear naked choke / guillotine / triangle / arm triangle / heel hook / etc.

Do not label a technique more specifically than the source supports. `kick` is not `roundhouse` unless explicitly sourced or independently validated.

### Layer 4 — computer vision / human-validated technique data

Only after rights review and validation.

Any model-generated action must store:

- model/version
- confidence
- source media reference
- timestamp / round clock
- review state
- original model label
- normalized taxonomy label

Low-confidence actions never flow into public aggregate metrics.

---

# Feature-system rules

## As-of only

Historical model / matchup features must use data that existed before the target bout.

Career-to-date snapshots on `ufc_fighters` are display fields and are not historical model features. Fight DNA is rebuilt from event-dated bout and round rows.

## Every number carries evidence

Public/API feature objects must be able to expose:

- `metric_key`
- `value`
- `unit`
- `sample_bouts`
- `sample_rounds`
- `sample_seconds`
- `as_of_date`
- `definition_version`
- `confidence`
- `coverage_status`
- source families / provenance

## Confidence tiers

Initial rules, versioned in metric definitions:

- `insufficient`: sample below metric minimum
- `low`: minimum met but narrow sample
- `medium`: useful sample, not robust
- `high`: broad sample / stable result

The UI must display sample context and must not convert low-sample splits into categorical claims.

## Nulls are truthful

No stat coverage means `null` / unavailable, never zero.

---

# Metric registry — v1

## Stance DNA

### `stance_record`
W/L/D/NC by opponent listed stance.

### `stance_finish_rate`
Finishing wins / wins against the stance.

### `stance_ko_rate`
KO/TKO wins / completed appearances against the stance.

### `stance_sub_rate`
Submission wins / completed appearances against the stance.

### `open_stance_record`
Performance when one fighter is listed orthodox and the other southpaw.

### `same_stance_record`
Performance when both listed stances are the same.

### `stance_sig_diff_per_min`
Fighter significant strikes landed minus opponent landed, divided by observed minutes, grouped by opponent stance.

### `stance_kd_rate_15`
Knockdowns created per 15 observed minutes, grouped by opponent stance.

### `stance_td_rate_15`
Takedowns landed per 15 observed minutes, grouped by opponent stance.

## Striking DNA

### `sig_landed_per_min`
Significant strikes landed / observed round time.

### `sig_absorbed_per_min`
Opponent significant strikes landed / observed round time.

### `sig_accuracy`
Significant landed / significant attempted.

### `sig_defense`
1 - opponent landed / opponent attempted.

### `head_attack_share`
Head significant attempts / total significant attempts.

### `body_attack_share`
Body significant attempts / total significant attempts.

### `leg_attack_share`
Leg significant attempts / total significant attempts.

### `distance_attack_share`
Distance significant attempts / total significant attempts.

### `clinch_attack_share`
Clinch significant attempts / total significant attempts.

### `ground_attack_share`
Ground significant attempts / total significant attempts.

### `knockdowns_per_15`
Knockdowns created per 15 observed minutes.

### `knockdowns_absorbed_per_15`
Opponent knockdowns / 15 observed minutes.

## Pace / round DNA

### `r1_sig_attempts_per_min`
Round-one significant attempts per minute.

### `r2_sig_attempts_per_min`
Round-two significant attempts per minute.

### `r3_sig_attempts_per_min`
Round-three significant attempts per minute.

### `late_round_sig_attempts_per_min`
Rounds 4–5 significant attempts per minute where available.

### `pace_retention_r2_vs_r1`
R2 significant-attempt pace / R1 pace.

### `pace_retention_r3_vs_r1`
R3 significant-attempt pace / R1 pace.

### `championship_round_delta`
Rounds 4–5 pace minus rounds 1–3 pace.

### `defensive_drift_r3_vs_r1`
R3 significant strikes absorbed per minute minus R1 rate.

## Grappling DNA

### `td_attempts_per_15`
Takedown attempts per 15 observed minutes.

### `td_landed_per_15`
Takedowns landed per 15 observed minutes.

### `td_accuracy`
Takedowns landed / attempted.

### `control_seconds_per_td`
Control seconds / takedowns landed.

### `control_share`
Control seconds / observed bout seconds when reliable.

### `sub_attempts_per_15`
Submission attempts per 15 observed minutes.

### `reversals_per_15`
Reversals per 15 observed minutes.

## Finish DNA

### `finish_rate`
KO/TKO + submission wins / wins.

### `ko_finish_rate`
KO/TKO wins / wins.

### `submission_finish_rate`
Submission wins / wins.

### `finish_round_distribution`
Finish wins grouped by round.

### `finish_time_median_sec`
Median elapsed fight seconds of finish wins.

Future licensed extensions:

- `finish_weapon_distribution`
- `finish_target_distribution`
- `finish_position_distribution`
- `submission_technique_distribution`

## Context DNA

### `short_notice_record`
Performance with a verified short-notice flag / days value.

### `three_round_record`
Performance in bouts scheduled for 3 rounds.

### `five_round_record`
Performance in bouts scheduled for 5 rounds.

### `title_bout_record`
Performance in title bouts.

### `main_event_record`
Performance when bout order / card structure identifies main event.

## Opponent-adjusted v2 metrics

Do not ship these until the base archive is substantially complete.

Candidates:

- opponent-adjusted significant strike differential
- opponent-adjusted takedown efficiency
- opponent-adjusted control yield
- strength-of-schedule index
- archetype-specific record
- archetype-specific strike / grappling deltas
- residual performance versus expected opponent baseline

---

# Composite Fight DNA scores

Composite scores must remain explainable and versioned. They are presentation helpers, not source facts.

Initial candidates:

- `pace_score`
- `power_threat_score`
- `distance_striking_score`
- `grappling_pressure_score`
- `control_quality_score`
- `finish_threat_score`
- `durability_score`
- `late_round_score`
- `stance_adaptability_score`
- `volatility_score`

Do not build composites until component coverage is good enough. Publish the components first.

---

# Fighter archetypes

Phase 2 can cluster fighters from as-of feature vectors rather than hand-labeling them.

Possible human-readable labels after cluster validation:

- high-volume pressure striker
- kick-heavy distance striker
- counter southpaw
- low-volume power striker
- chain wrestler
- control grappler
- submission hunter
- clinch pressure fighter
- mixed-phase pressure fighter

Store cluster version, feature set and centroid distance. Never silently change an archetype when the clustering version changes.

---

# Matchup DNA

A matchup response should compare each fighter against the opponent's actual profile.

Examples:

- fighter A's history vs southpaws when fighter B is southpaw
- fighter B's takedown defense against opponents with similar TD attempt rates
- pace-retention difference
- target-share mismatch
- distance/clinch/ground phase mismatch
- finish vulnerability by method / round
- reach difference contextualized by historical reach-advantage performance

Every matchup insight must include evidence and sample context.

---

# API contract

Additive routes:

- `GET /v1/ufc/dna/metrics`
- `GET /v1/ufc/fighters/{id}/dna`
- `GET /v1/ufc/fighters/{id}/dna?as_of=YYYY-MM-DD`
- `GET /v1/ufc/fighters/{id}/splits?opponent_stance=SOUTHPAW`
- `GET /v1/ufc/fighters/{id}/round-profile`
- `GET /v1/ufc/fighters/{id}/finish-profile`
- `GET /v1/ufc/fighters/{id}/position-profile`
- `GET /v1/ufc/matchups/{fighterA}/{fighterB}/dna`

Future action endpoint:

- `GET /v1/ufc/bouts/{id}/actions`

Public responses must never expose provider-restricted raw fields if redistribution rights do not allow it. Derived redistribution rights require source-contract review.

---

# UI contract

Fighter dossier gets a dedicated **Fight DNA** section:

- Stance DNA
- Striking DNA
- Grappling DNA
- Round Profile
- Finish Profile
- Context Splits
- coverage/sample badge

Matchup page gets **DNA Matchup**:

- stance-specific history
- pace mismatch
- target mismatch
- phase mismatch
- grappling/control mismatch
- finish windows
- strongest evidence
- counter-case

The UI must distinguish:

- `SOURCE` facts
- `PBE DERIVED` metrics
- future `LICENSED` enrichment
- future `MODEL` outputs

---

# Acceptance bar

Fight DNA is not complete because an endpoint returns JSON.

Before production:

1. Metric definitions are versioned and documented.
2. Builder is deterministic on the same source rows.
3. Historical snapshots prove no future-data leakage.
4. Stance splits reconcile to canonical bout results.
5. Rate denominators use actual observed time where available.
6. Low-sample features are explicitly flagged.
7. Source coverage is surfaced, not hidden.
8. API tests include fighters with high, low and zero round-stat coverage.
9. Matchup DNA never fabricates an insight when sample is insufficient.
10. Web/API use the same stored snapshot definition.
11. Backfill can rerun without creating duplicate snapshots.
12. Feature build runs persist errors and input-watermark provenance.

## North star

PropBetEdge should be able to answer:

> Which active UFC fighters maintain at least 90% of their round-one pace into round three, have 70%+ takedown defense in covered fights, and have historically underperformed against southpaws?

and explain exactly how every number was produced.

That is Fight DNA.
