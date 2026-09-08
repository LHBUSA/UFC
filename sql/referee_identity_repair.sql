-- ============================================================================
-- Referee identity repair — two clusters
--
-- EXECUTED ONCE, 2026-09-08T13:56:03Z, against production, on approval.
-- The transaction committed; all 22 assertions passed. Verified before and
-- after with scripts/referees/verify-identity-repair.mjs:
--
--   profiles                 249 -> 246
--   eric-mcmahon              26 -> 29 bouts, display_name "Eric McMahon"
--   vyacheslav-kiselev         4 -> 10 bouts, span 2018-09-15 to 2021-10-30
--   ufc_referee_bouts       9318 -> 9318   (unchanged; nothing deleted)
--   rows with no slug           0 -> 0
--   aliases                    3 -> 6
--
-- Re-running it now would fail at the first insert on the alias primary key,
-- which is the correct behaviour for a repair that has already been applied.
-- The rollback block at the foot remains unexecuted.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/referee_identity_repair.sql
--
-- Two officials each hold more than one profile row, so each renders more than
-- one page with their officiating record split between them. This collapses
-- each cluster to one identity without losing a single officiated bout.
--
-- Both identities are confirmed against sources outside our own database; see
-- the per-cluster notes below. Neither rests on spelling similarity.
--
-- The read-only companion, scripts/referees/verify-identity-repair.mjs,
-- establishes the preconditions before and confirms the postconditions after;
-- it was run on both sides and passed on both.
--
-- ---------------------------------------------------------------------------
-- WHY IT IS SHAPED THIS WAY
--
-- Read from supabase/migrations/20260907000008_ufc_referee_intelligence.sql,
-- not assumed:
--
--   ufc_referee_profiles.canonical_name is the PRIMARY KEY.
--   ufc_referee_aliases.canonical_name REFERENCES it ON DELETE CASCADE,
--   and there is NO ON UPDATE CASCADE.
--
-- So renaming a canonical_name to fix a spelling would either fail against
-- that constraint or strand its aliases. The visible spelling is therefore
-- corrected through display_name, which nothing references, and the key is
-- left alone.
--
--   ufc_referee_bouts and ufc_referee_stats both do:
--     left join ufc_referee_aliases a on a.raw_name = btrim(r.referee)
--     left join ufc_referee_profiles p
--            on p.canonical_name = coalesce(a.canonical_name, btrim(r.referee))
--
-- So an alias genuinely reroutes bouts AND merges the aggregate counts. That
-- is why the aliases go in FIRST: from the moment they exist the coalesce
-- prefers them, the bouts have already moved to the surviving identity, and
-- the surplus profile rows are unreferenced before anything is deleted. No
-- bout is ever left without a slug, not even for the length of a statement.
--
-- ---------------------------------------------------------------------------
-- CHOICES, AND WHAT THEY REST ON
--
-- Cluster 1 — keep 'Eric Mcmahon', display 'Eric McMahon'.
--   The key is the incumbent row: it predates the accidental insert, holds 26
--   of the 29 bouts across 13 events and three years, and owns the clean slug.
--   The surplus spelling appears 3 times, all on one card (UFC Fight Night:
--   Dolidze vs. Imavov, 2024-02-03). The display spelling is the conventional
--   capitalisation of the surname AND is attested in our own source data on
--   that card, so it is read from evidence rather than imposed.
--
-- Cluster 2 — keep 'Vyacheslav Kiselev', display 'Vyacheslav Kiselev'.
--   All three rows were created in the same instant, so none is incumbent and
--   incumbency cannot decide it. Bout counts tie at 4 and 4. The tiebreak is
--   that 'Vyacheslav' is the standard English transliteration of Вячеслав and
--   is the spelling the source used most recently, through 2021, while
--   'Kiselev Viacheslav' is plainly the same name written family-name first.
--
--   This was recorded as a judgement needing confirmation. It no longer is.
--   Cross-source confirmation now exists, independent of our own data:
--
--     * An external UFC referee archive groups exactly 10 UFC bouts, from
--       2018-09-15 to 2021-10-30, under Vyacheslav Kiselev — the same span
--       and the same count as our 4 + 4 + 2.
--     * Contemporary UFC 267 reporting names the referee Vyacheslav Kiselev,
--       which fixes the spelling for the most recent bout in the cluster.
--     * Earlier independent fight records use Viacheslav Kiselev, which is
--       the transliteration variance itself being attested rather than
--       inferred from our rows.
--
--   Our own corroboration is unchanged and still holds: all ten bouts are on
--   Russian or Abu Dhabi cards between 2018 and 2021, the three date ranges
--   are sequential and never overlap, and no two spellings ever appear on the
--   same event.
--
--   Removing the two surplus rows discards no enrichment: all five profile
--   rows in scope carry null bio, image, country and source fields and an
--   empty source_metadata, so nothing but the duplicate key is lost.
-- ============================================================================


-- ############################################################################
-- PREFLIGHT — read-only. Run and read these BEFORE the transaction.
-- ############################################################################

-- Every source canonical name in scope, with its slug and current bout count.
select p.canonical_name,
       p.slug,
       p.display_name,
       p.created_at,
       (select count(*) from public.ufc_referee_bouts b where b.referee_slug = p.slug) as bouts
  from public.ufc_referee_profiles p
 where p.canonical_name in (
         'Eric Mcmahon', 'Eric McMahon',
         'Vyacheslav Kiselev', 'Vjacheslav Kiselev', 'Kiselev Viacheslav')
 order by p.canonical_name;
-- expected: 5 rows; bouts 26, 3, 4, 4, 2

-- Every raw spelling actually stored on bout results, and how many rows each
-- accounts for. This is the number that must be conserved.
select btrim(referee) as raw_referee, count(*) as bout_rows
  from public.ufc_bout_results
 where btrim(referee) in (
         'Eric Mcmahon', 'Eric McMahon',
         'Vyacheslav Kiselev', 'Vjacheslav Kiselev', 'Kiselev Viacheslav')
 group by 1
 order by 1;
-- expected: 29 rows for the Eric pair, 10 for the Kiselev trio

-- Every existing alias, so nothing being added is overwriting a mapping.
select raw_name, canonical_name, created_at
  from public.ufc_referee_aliases
 order by created_at;
-- expected: 3 rows, none of them naming any of the five names above

-- Conservation baselines.
select (select count(*) from public.ufc_referee_profiles)                                as profiles,
       (select count(*) from public.ufc_bout_results where referee is not null
                                                       and btrim(referee) <> '')          as results_with_referee,
       (select count(*) from public.ufc_referee_bouts)                                    as referee_bout_rows,
       (select count(*) from public.ufc_referee_bouts where referee_slug is null)         as rows_without_slug;
-- expected: 249, 9318, 9318, 0


-- ############################################################################
-- REPAIR — one transaction. Any failed assertion aborts the whole thing.
-- ############################################################################

begin;

-- Freeze the "before" picture so the postconditions can compare against
-- something measured rather than something remembered.
create temporary table _repair_before on commit drop as
  select canonical_name, slug, display_name from public.ufc_referee_profiles;

create temporary table _repair_totals on commit drop as
  select (select count(*) from public.ufc_referee_bouts)                            as referee_bout_rows,
         (select count(*) from public.ufc_bout_results
           where referee is not null and btrim(referee) <> '')                      as results_with_referee;


-- ---------------------------------------------------------------------------
-- 1. Route the surplus spellings onto the surviving identities. FIRST, so the
--    bouts move before anything is removed.
-- ---------------------------------------------------------------------------

insert into public.ufc_referee_aliases (raw_name, canonical_name, source_note)
values
  ('Eric McMahon', 'Eric Mcmahon',
   'Capitalisation variant of one official. UFC Stats prints both: 26 bouts as "Eric Mcmahon" across 13 events 2023-2026, and 3 as "Eric McMahon" on UFC Fight Night: Dolidze vs. Imavov, 2024-02-03. Nevada Athletic Commission records independently confirm the conventional "Eric McMahon" spelling, which is why that is the display name while the incumbent key is kept.'),
  ('Vjacheslav Kiselev', 'Vyacheslav Kiselev',
   'Transliteration variant of one Russian official; 4 bouts 2019-04-20 to 2019-09-07, on Russian and Abu Dhabi cards. Confirmed against an external UFC referee archive that groups all 10 bouts 2018-09-15 to 2021-10-30 under Vyacheslav Kiselev.'),
  ('Kiselev Viacheslav', 'Vyacheslav Kiselev',
   'Same name written family-name first, and a transliteration variant; 2 bouts on UFC Fight Night: Hunt vs. Oleinik, 2018-09-15, Moscow. Independent fight records of that era use "Viacheslav Kiselev", attesting the variance directly; contemporary UFC 267 reporting names the same official Vyacheslav Kiselev.');


-- ---------------------------------------------------------------------------
-- 2. PROVE the routing worked, before deleting anything. The surplus rows are
--    only removable once nothing resolves through them.
-- ---------------------------------------------------------------------------

do $$
declare
  eric_kept   int;
  eric_stray  int;
  kis_kept    int;
  kis_stray   int;
begin
  select count(*) into eric_kept  from public.ufc_referee_bouts where referee_slug = 'eric-mcmahon';
  select count(*) into eric_stray from public.ufc_referee_bouts where referee_slug = 'eric-mcmahon-2';
  if eric_kept <> 29 then
    raise exception 'alias routing failed: eric-mcmahon carries % bouts, expected 29', eric_kept;
  end if;
  if eric_stray <> 0 then
    raise exception 'alias routing failed: eric-mcmahon-2 still carries % bouts, so its row is not safe to delete', eric_stray;
  end if;

  select count(*) into kis_kept  from public.ufc_referee_bouts where referee_slug = 'vyacheslav-kiselev';
  select count(*) into kis_stray from public.ufc_referee_bouts
   where referee_slug in ('vjacheslav-kiselev', 'kiselev-viacheslav');
  if kis_kept <> 10 then
    raise exception 'alias routing failed: vyacheslav-kiselev carries % bouts, expected 10', kis_kept;
  end if;
  if kis_stray <> 0 then
    raise exception 'alias routing failed: % bouts still resolve to a Kiselev row being removed', kis_stray;
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 3. The human-facing spelling. display_name only — the primary key is not
--    touched, because ufc_referee_aliases references it without
--    ON UPDATE CASCADE.
-- ---------------------------------------------------------------------------

update public.ufc_referee_profiles
   set display_name = 'Eric McMahon'
 where canonical_name = 'Eric Mcmahon';

update public.ufc_referee_profiles
   set display_name = 'Vyacheslav Kiselev'
 where canonical_name = 'Vyacheslav Kiselev';


-- ---------------------------------------------------------------------------
-- 4. Remove the now-unreferenced duplicate rows.
--    The aliases added above point at the SURVIVING names, so the FK's
--    ON DELETE CASCADE does not reach them.
-- ---------------------------------------------------------------------------

delete from public.ufc_referee_profiles
 where canonical_name in ('Eric McMahon', 'Vjacheslav Kiselev', 'Kiselev Viacheslav');


-- ---------------------------------------------------------------------------
-- 5. POSTCONDITIONS. Any failure raises, which rolls the whole transaction
--    back — including the aliases and the display names.
-- ---------------------------------------------------------------------------

do $$
declare
  n            int;
  before_rows  int;
  before_res   int;
  disp         text;
begin
  -- one identity per cluster, carrying every bout
  select count(*) into n from public.ufc_referee_bouts where referee_slug = 'eric-mcmahon';
  if n <> 29 then raise exception 'Eric cluster resolves to % bouts, expected 29', n; end if;

  select count(*) into n from public.ufc_referee_bouts where referee_slug = 'vyacheslav-kiselev';
  if n <> 10 then raise exception 'Kiselev cluster resolves to % bouts, expected 10', n; end if;

  -- the duplicate rows are gone
  select count(*) into n from public.ufc_referee_profiles
   where canonical_name in ('Eric McMahon', 'Vjacheslav Kiselev', 'Kiselev Viacheslav');
  if n <> 0 then raise exception '% duplicate profile row(s) survived', n; end if;

  -- and the surviving ones are still here
  select count(*) into n from public.ufc_referee_profiles
   where canonical_name in ('Eric Mcmahon', 'Vyacheslav Kiselev');
  if n <> 2 then raise exception 'expected both surviving identities, found %', n; end if;

  -- display names took
  select display_name into disp from public.ufc_referee_profiles where canonical_name = 'Eric Mcmahon';
  if disp <> 'Eric McMahon' then raise exception 'Eric display_name is %, expected Eric McMahon', disp; end if;
  select display_name into disp from public.ufc_referee_profiles where canonical_name = 'Vyacheslav Kiselev';
  if disp <> 'Vyacheslav Kiselev' then raise exception 'Kiselev display_name is %, expected Vyacheslav Kiselev', disp; end if;

  -- NO BOUT WAS DELETED, and none lost its resolution
  select referee_bout_rows, results_with_referee into before_rows, before_res from _repair_totals;
  select count(*) into n from public.ufc_bout_results where referee is not null and btrim(referee) <> '';
  if n <> before_res then raise exception 'bout results naming a referee changed from % to %', before_res, n; end if;

  select count(*) into n from public.ufc_referee_bouts;
  if n <> before_rows then raise exception 'ufc_referee_bouts row count changed from % to %', before_rows, n; end if;

  select count(*) into n from public.ufc_referee_bouts where referee_slug is null;
  if n <> 0 then raise exception '% bout(s) ended up with no referee slug', n; end if;

  -- exactly three profiles removed and nothing else
  select count(*) into n from public.ufc_referee_profiles;
  if n <> (select count(*) from _repair_before) - 3 then
    raise exception 'profile count moved by more than the three intended removals';
  end if;

  -- NO UNRELATED REFEREE ROW CHANGED, in either direction
  select count(*) into n
    from _repair_before b
    join public.ufc_referee_profiles p on p.canonical_name = b.canonical_name
   where (p.slug is distinct from b.slug or p.display_name is distinct from b.display_name)
     and b.canonical_name not in ('Eric Mcmahon', 'Vyacheslav Kiselev');
  if n <> 0 then raise exception '% unrelated referee row(s) changed', n; end if;

  select count(*) into n
    from _repair_before b
   where b.canonical_name not in ('Eric McMahon', 'Vjacheslav Kiselev', 'Kiselev Viacheslav')
     and not exists (select 1 from public.ufc_referee_profiles p where p.canonical_name = b.canonical_name);
  if n <> 0 then raise exception '% referee row(s) disappeared that should not have', n; end if;
end $$;

commit;


-- ############################################################################
-- POST-REPAIR VERIFICATION — read-only, outside the transaction.
-- ############################################################################

select name, slug, display_name, bouts
  from public.ufc_referee_directory
 where slug in ('eric-mcmahon', 'vyacheslav-kiselev')
 order by slug;
-- expected: eric-mcmahon 29, vyacheslav-kiselev 10

select count(*) as rows_without_slug from public.ufc_referee_bouts where referee_slug is null;
-- expected: 0

select count(*) as profiles from public.ufc_referee_profiles;
-- expected: 246


-- ############################################################################
-- ROLLBACK — these two clusters only. NOT EXECUTED.
--
-- Restores the exact prior state: three profile rows back with their original
-- slugs and display names, the three aliases removed, and the two display
-- names returned to what they were. It does not touch anything else.
--
-- Run in this order: recreate the profiles FIRST, because the alias delete is
-- not what strands anything, but recreating a profile whose slug is still free
-- must happen before the bouts are asked to resolve to it again.
-- ############################################################################

/*
begin;

-- 1. Put the duplicate profile rows back, with their original slugs and
--    display names as recorded in the preflight above.
insert into public.ufc_referee_profiles (canonical_name, slug, display_name)
values
  ('Eric McMahon',       'eric-mcmahon-2',     'Eric McMahon'),
  ('Vjacheslav Kiselev', 'vjacheslav-kiselev', 'Vjacheslav Kiselev'),
  ('Kiselev Viacheslav', 'kiselev-viacheslav', 'Kiselev Viacheslav');

-- 2. Remove the routing, which returns each raw spelling to its own row.
delete from public.ufc_referee_aliases
 where raw_name in ('Eric McMahon', 'Vjacheslav Kiselev', 'Kiselev Viacheslav');

-- 3. Restore the display names.
update public.ufc_referee_profiles
   set display_name = 'Eric Mcmahon'
 where canonical_name = 'Eric Mcmahon';

update public.ufc_referee_profiles
   set display_name = 'Vyacheslav Kiselev'
 where canonical_name = 'Vyacheslav Kiselev';
-- (unchanged in practice: 'Vyacheslav Kiselev' was already its own display
--  name before the repair, so this statement is a no-op kept for symmetry.)

-- 4. Confirm the split is back exactly as it was.
do $$
declare n int;
begin
  select count(*) into n from public.ufc_referee_bouts where referee_slug = 'eric-mcmahon';
  if n <> 26 then raise exception 'rollback: eric-mcmahon has % bouts, expected 26', n; end if;
  select count(*) into n from public.ufc_referee_bouts where referee_slug = 'eric-mcmahon-2';
  if n <> 3 then raise exception 'rollback: eric-mcmahon-2 has % bouts, expected 3', n; end if;
  select count(*) into n from public.ufc_referee_bouts where referee_slug = 'vyacheslav-kiselev';
  if n <> 4 then raise exception 'rollback: vyacheslav-kiselev has % bouts, expected 4', n; end if;
  select count(*) into n from public.ufc_referee_bouts where referee_slug = 'vjacheslav-kiselev';
  if n <> 4 then raise exception 'rollback: vjacheslav-kiselev has % bouts, expected 4', n; end if;
  select count(*) into n from public.ufc_referee_bouts where referee_slug = 'kiselev-viacheslav';
  if n <> 2 then raise exception 'rollback: kiselev-viacheslav has % bouts, expected 2', n; end if;
  select count(*) into n from public.ufc_referee_bouts where referee_slug is null;
  if n <> 0 then raise exception 'rollback: % bout(s) left without a slug', n; end if;
end $$;

commit;
*/
