# Unified release inventory

Collapsing every live UFC branch into one source of truth, and ending the
long-lived feature-branch workflow.

- **Baseline:** `ufc-store-v2` @ `5b4751988e3507671caaf2280ff12eea6ad665b0` (the
  current production/store lineage)
- **Unified branch:** `ufc-unified-v1` (local only, not pushed)
- **Generated:** 2026-09-09

Every classification below is **computed**, never inferred from a branch name.
`--cherry-pick` drops patch-equivalent commits, so a change that was cherry-picked
into production does not read as unmerged work. "Head-side files" is
`git diff BASE...HEAD`, which is the diff from the merge base forward — the only
measure that answers "what does this branch actually add".

---

## Corrections to the stated branch heads

Three of the heads in the brief were out of date or misleading. Working from
them unchecked would have lost or double-counted work.

| Stated | Actual | Consequence |
|---|---|---|
| judges `11bff515` | **`198aa786`** | The judges branch advanced by 3 commits after the stated head. `11bff515` is still what production runs; `198aa786` is what was merged. |
| main `b6b54641` | `b6b54641` (origin) — but **local `main` is `542e2064`** | Local main is an *ancestor of production*. The 12 "main-side" commits live only on `origin/main`. |
| weigh-ins "not yet a finished pushed branch" | **pushed at `ec00fb9d`** | It exists and is complete. It also *contains* `ufc-injuries-v1`, so merging it carries both. |

**The main-only work is not at risk.** `origin/main`'s 12 commits touch exactly
two files (HISTORICAL: newsroom.yml no longer schedules production) — `.github/workflows/newsroom.yml` and
`newsroom-editorial-provider-canary.yml` — and `git diff BASE origin/main`
over those two files shows production is already a **superset** (it carries one
extra line, `workflow_dispatch:`). So there is no main-only content to lose. The
merge was still performed to record ancestry, which is what lets `main` fast-forward
to unified later instead of needing a force-push.

---

## Classification

### Merged — unique work

| Branch | Head | Merge base | Unique commits | Head-side files | Action |
|---|---|---|--:|--:|---|
| `origin/main` | `b6b5464` | `542e206` | 12 | 2 | Merged for ancestry; content already in BASE |
| `ufc-fight-dna-v1` (local) | `5104799` | `7bcd442` | 2 | 3 | Merged — media registry migration + DNA data-quality verifier |
| `origin/ufc-fight-dna-v1` | `6ff4c6e` | `7bcd442` | 3 | 3 | Merged — Commons image search, referee dossier ingest, TUF weight-class rescue |
| `origin/ufc-newsroom-worker-v2` | `416b825` | `2a2cbf8` | 4 | 21 | Merged — newsroom v2 Worker architecture |
| `referee-identity-repair-v1` | `e85d61a` | `6eccc78` | 15 | 63 | Merged — carries `hof-fighter-links`, `backfill-tournament-era-fix`, `finalize-safety` |
| `origin/ufc-weigh-ins-v1` | `ec00fb9` | `2a2cbf8` | 3 | 42 | Merged — **carries `ufc-injuries-v1` as an ancestor** |
| `origin/ufc-judges-scorecards-v1` | `198aa78` | `2a2cbf8` | 3 | 26 | Merged — judge intelligence + judge view security |
| `ufc-fight-model-v1` | `f8e7ddc` | `2a2cbf8` | 2 | 38 | Merged — PBE Fight Model v1 |
| `ufc-referee-view-security-v1` | `26052ab` | `2a2cbf8` | 3 | 31 | Merged — referee RLS bypass repair |

### Already contained — nothing to merge

Each is an ancestor of the baseline. `git merge-base --is-ancestor` returns true.

| Branch | Head | Note |
|---|---|---|
| `main` (local) | `542e206` | Ancestor of production |
| `ufc-odds-integration-v1` | `327718b` | Odds market UI + 12h stale handling already in BASE |
| `ufc-tuf-v1` | `a7a8829` | TUF archive already in BASE |
| `ufc-tale-of-the-tape-v1` | `2a2cbf8` | **No unique implementation at its head** — it is exactly the DNA repair commit |
| `fight-dna-repair-v1` | `2a2cbf8` | Same commit as above |
| `fight-dna-tale-brand-v1` | `2a2cbf8` | Same commit as above |
| `referee-packet-refresh-v1` | `19f5584` | Contained |
| `ufc-fight-week-changelog-v1` | `2888e03` | Contained |
| `ufc-preservation-guard` | `2888e03` | Same commit; contained |
| `ufc-production-v3` | `a58f746` | Contained |
| `ufc-visual-lock-2026-09-06` | `aca56f8` | Contained |
| `ufc-injuries-v1` | `3405a12` | Ancestor of `ufc-weigh-ins-v1`; merged through it |
| `hof-fighter-links` | `7e672da` | Ancestor of `referee-identity-repair-v1` |
| `backfill-tournament-era-fix` | `5fb156b` | Ancestor of `referee-identity-repair-v1` |
| `finalize-safety` | `877b240` | Ancestor of `referee-identity-repair-v1` |

### Superseded — deliberately not merged

| Branch | Head | Evidence |
|---|---|---|
| `ufc-store-v1` | `8fee6a1` | Its only content not in BASE is **14 v1 product SVGs that store-v2 deliberately deleted** ("v1 image files are removed rather than kept"). Merging would resurrect retired artwork. |
| `ufc-newsroom-worker-v1` | `ec78da8` | `git log --cherry-pick --right-only v2...v1` scoped to `workers/ufc-newsroom` and `scripts/news` is **empty**. Fully superseded. |
| `ufc-odds-repair-v1` | `9f0bd77` | Same test over `scripts/odds`, `lib/market.ts`, `components/Market.tsx` is **empty**. Its odds work is already in BASE in a later form. |
| `ufc-api-v1` | `40a9ef6` | BASE already contains every file it touches (`workers/ufc-api/**`, `docs/openapi.ufc-v1.yaml`, the live-smoke workflow) in a newer form. Its `web/lib/db.ts` change — routing web reads through the API origin — was **deliberately reversed**: the web app reads Supabase server-side. |
| `ufc-visual-v2` | `1ce4fe9` | Its `web/app/visual-v2.css` is not loaded by BASE; the design system replaced it with `depth.css`, `product-polish.css`, `expansion.css` and nine others. Merging its 2026-09-06 `page.tsx`/`layout.tsx`/`ui.tsx` would revert three days of design work. |
| `network/pbe-sibling-links` | `d91daba` | BASE already carries `network.mlb` in `lib/site.ts` and the MLB sibling row in `Shell.tsx`. Content-contained. |

---

## Manually resolved conflicts

No blanket `--ours` or `--theirs` was used. Each was resolved by constructing
the union and verifying it.

| File | Conflict | Resolution |
|---|---|---|
| `.github/workflows/newsroom-editorial-provider-canary.yml` | add/add | Diff was a single line: BASE adds `workflow_dispatch:`. BASE is a strict superset — kept. |
| `web/app/referees/[slug]/page.tsx` | comment divergence | **Union written by hand.** Each side documented a different reason for withholding the metric distribution; the merged comment carries both. |
| `web/tsconfig.json` | comment wording only | Kept BASE. No semantic difference. |
| `data/referees/eric-mcmahon.json` | regenerated artifact | Kept BASE: newer timestamp (14:37 vs 14:11) and the more precise `archive_count_card_position` method. |
| `web/lib/generated/enrichment.json` | regenerated artifact | Kept BASE: same 64 referee keys, none missing on either side, BASE generated later. |
| `web/lib/site.ts` | NAV | **Union of three branches.** Store + Injuries & Withdrawals + Weigh-Ins all placed in the primary bar, Store last because it is the only commercial item. |
| `web/package.json` (judges) | test script | Union: `test:store` **and** `test:judges`. |
| `web/package.json` (model) | test script | Union: added `test:model`. Dropping either would silently stop testing a feature. |
| `web/app/layout.tsx` | CSS import | Union: `store.css` **and** `model.css`. |

---

## Migration ledger

Four version collisions existed once the branches were combined:

```
migrations/006_ufc_image_candidates         vs 006_ufc_media_registry_videos
migrations/011_store_orders                 vs 011_ufc_model_predictions
supabase/20260906000006_official_videos     vs 20260906000006_media_registry_videos
supabase/20260908000011_store_orders        vs 20260908000011_ufc_fighter_status
```

The applied boundary was **measured, not assumed**. An `information_schema`
probe of production shows the UFC schema stops at `ufc_market`: every store,
status, judge, weigh-in, model and referee-security table is absent. So
`20260907000009_ufc_market` is the last applied migration and everything after
it was free to renumber.

Final pending order:

| Version | Migration | Applied |
|---|---|---|
| `20260907000010` | `store_provisioning` | no |
| `20260908000010` | `ufc_model_predictions` | no |
| `20260908000011` | `ufc_fighter_status` | no |
| `20260908000012` | `ufc_judge_intelligence` | no |
| `20260908000013` | `ufc_weigh_ins` | no |
| `20260908000014` | `referee_view_security` | no |
| `20260908000015` | `store_orders` | no (renamed from `20260908000011`) |
| `20260908000016` | `ufc_media_registry_videos` | no (renamed from `20260906000006`) |

Root `migrations/` renames: `011_store_orders` → `012_store_orders`,
`006_ufc_media_registry_videos` → `013_ufc_media_registry_videos`.

Nothing applied was touched. `20260906000007_ufc_video_channels.sql` still refers
to `006_ufc_media_registry_videos.sql` in a comment; that file is applied, so the
comment stays as historical record rather than being quietly corrected.

`node scripts/db/check_migration_ledger.mjs` fails on any duplicate version and
on any applied migration that has moved.

---

## The one-source-of-truth rule

After this branch is accepted, **main is the source of truth**. Production
deploys from main only. Feature branches may produce previews and must be
reconciled the same day and deleted; no branch may become a parallel production
lineage again.

The evidence for why: this exercise found four migration collisions, two
branches whose stated heads were stale, one branch that had been superseded
without being closed, and a production deployment running from a feature branch
tip. All four are symptoms of the same cause.
