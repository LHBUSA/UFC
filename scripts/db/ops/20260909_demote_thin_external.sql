-- Containment for the ufc-newsroom regression of 2026-09-09T21:27Z.
--
-- WHAT HAPPENED
--
-- generateExternal in scripts/news/write_articles.mjs holds an external draft
-- for review only when its qualifying label is injury or withdrawal:
--
--   const review = qualifying.some((l) => l === 'injury' || l === 'withdrawal');
--   status: review ? 'review' : 'published'
--
-- So a `contract`, `rankings`, `suspension`, `replacement`, `weight_miss` or
-- `bout_moved` item publishes immediately as ~76-101 words of deterministic
-- template. phases.mjs was edited at 21:26Z to add `external` to the writer's
-- story types and ufc-newsroom was deployed at 21:27Z; the fix that makes
-- externals unconditionally private was written at 21:36Z and never deployed.
-- The first write phase after that deploy, at 22:16Z, published one.
--
-- This is the same defect that put three of these live for about seven hours on
-- 2026-09-08 before a human demoted them.
--
-- WHAT THIS DOES
--
-- Demotes that one article to review with a hold_reason. It does not delete the
-- row, and it deliberately leaves published_at and first_published_at intact:
-- they are the record that the article really was public, and erasing them
-- would erase the evidence.
--
-- This is containment, not the fix. The fix is a one-line change in
-- generateExternal plus a redeploy of ufc-newsroom.
begin;

update public.ufc_articles
   set status = 'review',
       needs_human = true,
       hold_reason = 'thin external published by the ufc-newsroom regression of 2026-09-09T21:27Z: 101 words of deterministic template, published because generateExternal only holds injury/withdrawal labels. Demoted, not deleted; published_at and first_published_at left intact as the record that it was briefly public.'
 where slug = 'paulo-costa-says-hes-requested-his-release-over-ufc-332-snub-ahead-of-signing-wi'
   and story_type = 'external'
   and status = 'published';

commit;
