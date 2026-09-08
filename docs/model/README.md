# PBE Fight Model

| Document | What it is |
|---|---|
| [METHODOLOGY.md](METHODOLOGY.md) | How the model is built, what it can and cannot see, and what v1 is honestly worth |
| [LEAKAGE.md](LEAKAGE.md) | The six checks that prove the model could not read the future, with their results |
| [BACKTEST_v1.md](BACKTEST_v1.md) | Generated results: every metric, every slice, every fold |

Code lives in `scripts/model/`. Schema lives in `migrations/010_ufc_model_predictions.sql`.
The web surfaces are `web/app/model/page.tsx` (also reachable at `/picks`) and
`web/components/ModelProbability.tsx`.

Status: **candidate**. No prediction has been published, locked, or written to a
database. Migration 010 has not been applied.
