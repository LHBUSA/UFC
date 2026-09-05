# ESPN-first production proof — event 600056266 — 2026-09-05T23:12:21.377907+00:00

`node scripts/run_worker_local.mjs --dates 20251214 --max-events 1` (ESPN only, no UFC Stats, no Wayback, no Discord). 
Checked live against ESPN. **21/21 checks passed.**

| Check | Result | Detail |
|---|---|---|
| exactly the intended ESPN event exists | PASS | events=[('600056266', 'UFC Fight Night: Royval vs. Kape')] |
| event identity/date/venue correct | PASS | db=(UFC Fight Night: Royval vs. Kape,2025-12-14,Meta APEX,Las Vegas,NV,USA) espn=(UFC Fight Night: Royval vs. Kape,2025-12-14,Meta APEX,{'city': 'Las Vegas', 'state': 'NV', 'country': 'USA'}) |
| event card_status complete | PASS | complete |
| event ufcstats_id null (ESPN-only proof) | PASS | None |
| bout count matches ESPN | PASS | db=12 espn=12 |
| main event ordering + full card order match ESPN (n+1-matchNumber) | PASS | main event bout_order=12 |
| card_position distinguishes segments | PASS | positions seen=['main', 'prelim'] |
| scheduled_rounds match ESPN | PASS | all bouts |
| women's divisions via is_womens with weight_class kept | PASS | womens bouts on card=2 |
| title bouts marked exactly as ESPN | PASS | title bouts on card=0 (none on this card: only the negative case is exercised) |
| result winner/method/round/time/referee/finish_detail/result_source correct | PASS | 12 results |
| bout fighter pairs match ESPN; bout ufcstats_id null | PASS | ok |
| every card fighter has an ESPN athlete id | PASS | db=24 espn=24 |
| no fighter merged on name alone: one row per ESPN athlete, names match | PASS | names identical to ESPN |
| seed A (correct DOB) matched: ESPN id attached to the existing row, no duplicate | PASS | rows named Brandon Royval=1 ufcstats_id=seed-a-20260905230954 |
| seed B (wrong DOB) NOT merged: new ESPN row created | PASS | espn_row=12f748ce-9380-4672-81b9-8755a54e4e12 seed_row=b076bb13-865f-417c-a75f-662928837055 |
| seed B produced a review-queue item naming the seed as candidate | PASS | queue items for Manel Kape=1 reason=no_second_key |
| no other review-queue items | PASS | queue total=1 |
| ingest ledger closed as success | PASS | status=success |
| zero assertion failures | PASS | failures=[] |
| ledger counters plausible | PASS | events_new=1 bouts_new=12 fighters_touched=24 |

Identity fixtures: seed A = Brandon Royval (ufcstats-only row, correct DOB) must be matched; seed B = Manel Kape (ufcstats-only row, DOB 1980-01-01) must NOT be merged. Seeds are removed with `--cleanup-seeds` after the proof.
