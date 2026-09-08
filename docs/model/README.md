# PBE Fight Model

| Document | What it is |
|---|---|
| [METHODOLOGY.md](METHODOLOGY.md) | How the model is built, what it can and cannot see, and what v1 is honestly worth |
| [LEAKAGE.md](LEAKAGE.md) | The six checks that prove the model could not read the future, with their results |
| [BACKTEST_v1.md](BACKTEST_v1.md) | Generated results: every metric, every slice, every fold |
| [LIVE_CONTRACT.md](LIVE_CONTRACT.md) | What has to be true for a published pick to mean anything, and where each rule is enforced |

Code lives in `scripts/model/`. Schema lives in
`migrations/011_ufc_model_predictions.sql`, with behavioural tests in
`migrations/tests/011_ufc_model_predictions.test.sql`. The web surfaces are
`web/app/model/page.tsx` (also reachable at `/picks`) and
`web/components/ModelProbability.tsx`.

Status: **candidate**. No prediction has been published, locked, or written to a
database. Migration 011 has not been applied.
