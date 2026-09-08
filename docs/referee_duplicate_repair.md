# Referee duplicate repair — plan and SQL (NOT EXECUTED)

Two officials each hold more than one profile row, so each renders more than one
page and their officiating record is split across them. This documents the
repair, the evidence behind every choice, and the SQL. **Nothing here has been
run.**

## Why the rows exist

`scripts/referees/sync-profiles.mjs` creates one profile per distinct referee
name found in `ufc_bout_results.referee`. It deliberately does not merge two
spellings on its own — collapsing two officials into one is a worse error than
leaving two pages — so where the source spells one person several ways, it
produces several rows. That is the design working, not a bug in it.

Both clusters below therefore reflect inconsistency in the source data, and both
need the same fix: an alias row that maps the surplus spelling onto one
canonical identity.

## How the schema behaves (read from the DDL, not assumed)

From `supabase/migrations/20260907000008_ufc_referee_intelligence.sql`:

```sql
create table public.ufc_referee_profiles (
  canonical_name text primary key,
  slug text not null unique,
  ...
);
create table public.ufc_referee_aliases (
  raw_name text primary key,
  canonical_name text not null references public.ufc_referee_profiles(canonical_name) on delete cascade,
  ...
);
```

and both derived views normalise through the alias table before joining:

```sql
left join public.ufc_referee_aliases a on a.raw_name = btrim(r.referee)
left join public.ufc_referee_profiles p on p.canonical_name = coalesce(a.canonical_name, btrim(r.referee))
```

Three consequences decide the whole plan:

1. **An alias genuinely reroutes bouts.** Both `ufc_referee_bouts` and
   `ufc_referee_stats` coalesce through `ufc_referee_aliases`, so adding an
   alias moves the bouts AND merges the counts. No bout is lost and the
   surviving page shows the complete record.
2. **Do not rename `canonical_name`.** It is the primary key and is referenced
   by `ufc_referee_aliases.canonical_name`, whose foreign key declares
   `on delete cascade` but **not** `on update cascade`. Updating the key would
   fail against that constraint or orphan aliases. Correcting the visible
   spelling therefore goes through `display_name`, which nothing references.
3. **Order the statements alias-first.** While both the alias and the surplus
   profile exist, the `coalesce` already prefers the alias, so the bouts have
   moved before anything is deleted. Deleting first would leave them with a null
   slug in between.

The alias FK cascades on delete, so dropping a surplus profile also drops any
alias pointing *at* it. The aliases added below point at the surviving row, so
they are unaffected.

## Cluster 1 — Eric McMahon (confirmed)

| canonical_name | slug | bouts | span | origin |
|---|---|---|---|---|
| `Eric Mcmahon` | `eric-mcmahon` | 26 | 2023-10-04 → 2026-08-18 | pre-existing |
| `Eric McMahon` | `eric-mcmahon-2` | 3 | 2024-02-03 only | inserted 2026-09-08T11:37:02Z |

The three bouts on the surplus row are all from one card, UFC Fight Night:
Dolidze vs. Imavov:

```
b20e92e1-14d8-4cff-893e-aab395f763ee  http://ufcstats.com/fight-details/c28d40498150de90
3b9fcfd4-8999-489c-9c77-e942f40c1fb2  http://ufcstats.com/fight-details/df9847839c73a678
e667f599-487a-4820-8f62-c111a7c19d91  http://ufcstats.com/fight-details/ca7d61e167d7789c
```

**Canonical key: keep `Eric Mcmahon`.** It holds 26 of the 29 bouts, is the
incumbent row, already owns the clean slug, and is the majority spelling in the
source (26 occurrences across 13 events and three years, against 3 confined to a
single card).

**Display spelling: `Eric McMahon`.** The surname is conventionally capitalised
that way and the source itself prints it that way on that card, so this is
attested in our own data rather than invented. I have not checked an external
officiating roster, so this is the best reading of the evidence to hand rather
than an authoritative ruling.

## Cluster 2 — Kiselev (strong candidate, confirm before running)

All three rows were created by the same accidental run; none is incumbent.

| canonical_name | slug | bouts | span |
|---|---|---|---|
| `Kiselev Viacheslav` | `kiselev-viacheslav` | 2 | 2018-09-15 |
| `Vjacheslav Kiselev` | `vjacheslav-kiselev` | 4 | 2019-04-20 → 2019-09-07 |
| `Vyacheslav Kiselev` | `vyacheslav-kiselev` | 4 | 2019-11-09 → 2021-10-30 |

Ten bouts split three ways. The evidence that this is one official: all three
are transliterations of the same Russian name; every bout is on a Russian or
Abu Dhabi card between 2018 and 2021; the three spans are sequential with no
overlap; and `Kiselev Viacheslav` is plainly the same name written family-name
first.

**Canonical key: `Vyacheslav Kiselev`** — the most standard English
transliteration, and the spelling the source used most recently (through 2021).

This one is a judgement about a person's identity from spelling and context, not
a verified match, which is why it is written down separately and marked as
needing confirmation. If it is wrong, the cost is three officials merged into
one, which is the error this codebase most wants to avoid.

## SQL

Run as one transaction per cluster. Nothing below has been executed.

```sql
-- ── Cluster 1: Eric McMahon ────────────────────────────────────────────────
begin;

-- 1. Route the surplus spelling onto the surviving identity FIRST, so the
--    three bouts never sit without a slug.
insert into public.ufc_referee_aliases (raw_name, canonical_name, source_note)
values (
  'Eric McMahon',
  'Eric Mcmahon',
  'Capitalisation variant of one official. UFC Stats prints both: 26 bouts as "Eric Mcmahon" across 13 events 2023-2026, and 3 as "Eric McMahon" on UFC Fight Night: Dolidze vs. Imavov, 2024-02-03.'
);

-- 2. Show the conventional spelling without touching the primary key, which
--    ufc_referee_aliases.canonical_name references (on delete cascade, and
--    NO on update cascade, so renaming the key is not safe).
update public.ufc_referee_profiles
   set display_name = 'Eric McMahon'
 where canonical_name = 'Eric Mcmahon';

-- 3. Remove the now-unreferenced surplus profile.
delete from public.ufc_referee_profiles
 where canonical_name = 'Eric McMahon';

commit;

-- ── Cluster 2: Kiselev — CONFIRM IDENTITY BEFORE RUNNING ───────────────────
begin;

insert into public.ufc_referee_aliases (raw_name, canonical_name, source_note)
values
  ('Vjacheslav Kiselev', 'Vyacheslav Kiselev',
   'Transliteration variant of one Russian official; 4 bouts 2019-04-20 to 2019-09-07.'),
  ('Kiselev Viacheslav', 'Vyacheslav Kiselev',
   'Same name written family-name first, and a transliteration variant; 2 bouts 2018-09-15.');

delete from public.ufc_referee_profiles
 where canonical_name in ('Vjacheslav Kiselev', 'Kiselev Viacheslav');

commit;
```

## Verification after running

```sql
-- Expect exactly one row each, with the full merged record and no bouts lost.
select name, slug, bouts from public.ufc_referee_directory
 where name in ('Eric Mcmahon', 'Vyacheslav Kiselev');
--  Eric Mcmahon        eric-mcmahon         29
--  Vyacheslav Kiselev  vyacheslav-kiselev   10

-- Expect zero: no bout may end up without a slug.
select count(*) from public.ufc_referee_bouts where referee_slug is null;

-- Expect 249 - 3 = 246.
select count(*) from public.ufc_referee_profiles;
```

The bout totals are the point of the whole exercise: 26 + 3 = 29 and
4 + 4 + 2 = 10. If either comes out short, an alias did not take and the delete
should be rolled back.

## What is deliberately not done

The other 183 inserted profiles stay. They are real officials — every one of the
249 directory rows has at least one officiated bout — and they closed 185 broken
`/referees/[slug]` links. Deleting valid records because the insertion was
accidental would destroy good data to tidy up a process error.

Same-surname pairs are not evidence of duplication and are left alone: Fernando
and Mario Yamasaki, James and Larry Folsom, Joe and Nelson Hamilton, Jason and
Rick McCoy, Bruce and George Allen, Chris and Terry Hill, Nic and Tom Jones,
Michael and Wernei Cardoso, Mark and David Smith, Jonathan and Robert Romero,
Tyrone and Leon Roberts.
