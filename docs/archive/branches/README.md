# Branch audit and archive (2026-09-14)

Owner rule: `main` is the only development branch (no branches, no PRs, no GitHub Actions). On 2026-09-14 every UFC branch with commits not on `main` was audited against `main` at `d72bd4c` (read-only `git cherry`, `diff`, `show`, `log`, `merge-tree`). Nothing stale was merged blindly.

## Archived here, then the branch was deleted

These carry work that is not on `main` and cannot be activated without an owner decision (a migration, a Worker deploy, or a standing decision). The patches are inert: nothing builds, applies or deploys them. Apply one with `git am docs/archive/branches/<file>.patch` only after the decision, and expect conflicts against current `main`.

| Patch | Branch (base → tip) | What is unique | Why not ported now |
|---|---|---|---|
| `ufc-fighter-media-pipeline-v1.patch` | `ece242f` → `b04513d` (1 commit, 48 files) | Reviewed, rights-aware portrait pipeline: migration `20260910210000_ufc_fighter_media_pipeline.sql` (`ufc_fighter_media_assets`, `ufc_fighter_media_candidates`, `ufc_media_quarantine`, `ufc_fighter_portrait_eligible`, review RPCs), `/admin/media` review UI, candidate queue and coverage scripts, `fighterMedia*.ts` as sole portrait resolver | Standing decision: do not merge before owner review. Merging without the migration blanks every portrait; it removes the ESPN headshot fallback (standing decision: keep, confirm at merge); `main` since built `espnPortraitGate.ts`, `portraitIdentity.ts`, `displayPortraitPolicy.ts` and changed the touched pages heavily. |
| `ufc-dna-ranking-v2.patch` | `2266f94` → `398017c` (1 commit) | Fix for issue #27: DNA rankings rank the eligible population via `public.ufc_dna_metric_ranking(...)` instead of the first 1000 rows by `fighter_id` (`DNA_QUERY_CANDIDATE_LIMIT` window, still present in `workers/ufc-api/src/index.js`) | Needs the migration applied to production Supabase, a `ufc-api` Worker deploy, an `API_VERSION` bump (`2026-09-11.1` → `2026-09-12.1`) coordinated with the gateway pin. **Superseded 2026-09-14:** #27 was fixed on `main` from scratch (migration `20260914120000_ufc_dna_metric_ranking`, API `2026-09-14.1`, Cloudflare `df3ea12f`); this patch is reference only and must not be applied. |
| `ufc-round-integrity-v1.patch` | `4f34555` → `9b157e2` (4 commits) | Only one piece is not on `main`: `web/lib/db.ts` image `RIGHTS_FILTER = "&commercial_use_allowed=is.true"` together with removal of the ESPN headshot fallback | Everything else is on `main` in later form (fail-closed challenge default, queue-driven discovery, queue and identity migrations under later timestamps, `ufc_round_index` as an RPC). The remaining piece conflicts with the standing "keep the ESPN fallback" decision; add a licence filter separately if the owner wants it. Its `ufc_round_index` view migration must never be applied (name collides with `main`'s function). |

## Deleted without an archive (content verifiably on `main`, or superseded)

| Branch | Verdict | Evidence |
|---|---|---|
| `ufc-api-v1` (15 commits) | already on main | squashed as `d6079e9` (identical tree `de83082f`); `workers/ufc-api` evolved far past it; the web→API cutover was deliberately reverted in `542e206` |
| `ufc-store-v1` (12) | already on main | transplanted in `ecab455`; later store work (`IMAGE_VERSION = "v2"`, provisioning, migration header) supersedes the branch; no `-v1.svg` referenced |
| `ufc-visual-v2` (7) | already on main, retired | squashed as `04926de`; `542e206` retired `visual-v2.css`; pages rebuilt since |
| `fighter-dna-worldclass-v1` (1) | already on main | `fighter-dna-polish.css` identical; import added in `feeae79` in the intended order |
| `tuf2-gold-audit` (1) | already on main | both files byte-identical, added in `c0ab1d1` |
| `ufc-fight-dna-v1` (1) | already on main | `2a8f939` is the same patch (one line later improved), newsroom Worker imports it |
| `homepage-background-behavior-v3` (9) | superseded | `b419299` removed the switcher system; the branch would delete `main`'s live hero `home-bg-fight-night.webp` |
| `store-sales-page-fix` (3) | superseded | `main`'s multi-drop product template (`70ab871` … `02edcce`); only a 300px hoodie photo cap differs (design choice since replaced by 440px for all products) |
| `network/pbe-sibling-links` (1) | superseded | `NETWORK.sports` footer in `web/lib/network.ts`; `b5d23eb` deliberately narrowed `sameAs` |
| `ops/nfl-integrity-cross-deploy-v1` (1) | obsolete, forbidden | GitHub Actions deploying NFL Workers from the UFC repo with this repo's Cloudflare token; NFL deploys belong in the NFL repo via Wrangler |

Branches whose commits were all patch-equivalent to `main` (`git cherry` shows no `+`) were deleted as well, so `main` is the only branch left on the remote.
