-- Judge Intelligence
--
-- Canonical judge identities, alias normalization, and a fully attributed
-- scorecard layer built from the judge names and scores already stored on
-- public.ufc_bout_results.
--
-- Three things this migration is careful about.
--
-- 1. NOTHING IS INVENTED. A scorecard exists only where the archive stores
--    one. Bouts that ended by KO/TKO, submission, DQ or no contest have no
--    judges' decision, and are represented as an explicit absence
--    (ufc_bout_scorecard_summary.has_official_scorecard = false), never as a
--    zero, a blank card or an inferred score.
--
-- 2. SCORE ORIENTATION IS DERIVED, NOT ASSUMED. The stored score string
--    ("27-30") is a bare pair with no fighter attached to either number. An
--    audit of all 12,004 stored cards shows the archive's convention puts the
--    bout WINNER's score second in every resolvable bout. Rather than
--    hard-code that, these views re-derive the orientation per bout from the
--    card tally and the recorded winner: whichever position carries the
--    majority of the winning cards is the winner's. Where that test cannot
--    decide - a draw (no winner), or a card tally that does not favour the
--    recorded winner - the scores stay UNATTRIBUTED and orientation_basis
--    says so. A consumer must then render the card as a bare pair, never as
--    "fighter A 29, fighter B 28".
--
-- 3. STATISTICS ARE DESCRIPTIVE. Dissent counts, score margins and draw cards
--    describe what a judge's cards did in the loaded sample. They are not
--    evidence that a judge favours a style, a nationality or a fighter
--    archetype, and every consumer must render a sample size beside them.

-- ---------------------------------------------------------------------------
-- 1. Identity
-- ---------------------------------------------------------------------------
create table if not exists public.ufc_judge_profiles (
  canonical_name text primary key,
  slug text not null unique,
  display_name text not null,
  bio text,
  bio_source_url text,
  bio_source_name text,
  bio_verified_at timestamptz,
  country text,
  commission text,
  image_url text,
  image_source_url text,
  image_credit text,
  image_license text,
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- raw_name is the verbatim string stored inside ufc_bout_results.scorecards.
-- kind records WHY the raw form differs from the canonical one, because the
-- two reasons deserve different trust:
--   'deduction_annotation' - the upstream Details line prefixed a point
--        deduction or technical-decision note onto the judge's name, so the
--        raw string is annotation + name. card_note keeps the annotation, and
--        the card is attributed to the canonical official.
--   'spelling_variant'     - one official stored under two spellings.
create table if not exists public.ufc_judge_aliases (
  raw_name text primary key,
  canonical_name text not null references public.ufc_judge_profiles(canonical_name) on delete cascade,
  kind text not null default 'spelling_variant' check (kind in ('spelling_variant','deduction_annotation')),
  card_note text,
  source_note text,
  created_at timestamptz not null default now()
);

-- Seed canonical identities from the archive itself. A raw string that is only
-- ever an annotated form must NOT become a profile, so the alias list is
-- staged first and the profile seed runs against what it does not claim.
create temporary table _judge_alias_seed (raw_name text, canonical_name text, kind text, card_note text) on commit drop;

insert into _judge_alias_seed (raw_name, canonical_name, kind, card_note) values
  ('Eye Poke by Jardine Adalaide Byrd', 'Adalaide Byrd', 'deduction_annotation', 'Eye Poke by Jardine'),
  ('Eye Poke by Turman Derek Cleary', 'Derek Cleary', 'deduction_annotation', 'Eye Poke by Turman'),
  ('Eye Pokes by Dollaway Ruben Najera', 'Ruben Najera', 'deduction_annotation', 'Eye Pokes by Dollaway'),
  ('Grabbing Shorts by Parke Vitor Pereira', 'Vitor Pereira', 'deduction_annotation', 'Grabbing Shorts by Parke'),
  ('Groin Strike to Danho Ben Cartlidge', 'Ben Cartlidge', 'deduction_annotation', 'Groin Strike to Danho'),
  ('Groin Strike to Romanov Dave Hagen', 'Dave Hagen', 'deduction_annotation', 'Groin Strike to Romanov'),
  ('Headbutt by Quinonez Sal D''amato', 'Sal D''amato', 'deduction_annotation', 'Headbutt by Quinonez'),
  ('Holding Fence by Fabian Tony Weeks', 'Tony Weeks', 'deduction_annotation', 'Holding Fence by Fabian'),
  ('Holding Fence by Ortiz Cecil Peoples', 'Cecil Peoples', 'deduction_annotation', 'Holding Fence by Ortiz'),
  ('Holding Fence by Swick Andy Roberts', 'Andy Roberts', 'deduction_annotation', 'Holding Fence by Swick'),
  ('Holding Fence by Taisumov Richard Bertrand', 'Richard Bertrand', 'deduction_annotation', 'Holding Fence by Taisumov'),
  ('Holding Shorts by Kongo Doug Crosby', 'Doug Crosby', 'deduction_annotation', 'Holding Shorts by Kongo'),
  ('Illegal Elbows by Nakamura Glenn Trowbridge', 'Glenn Trowbridge', 'deduction_annotation', 'Illegal Elbows by Nakamura'),
  ('Illegal Elbows by Sakara Abe Belardo', 'Abe Belardo', 'deduction_annotation', 'Illegal Elbows by Sakara'),
  ('Illegal Kick by Galera Ben Cartlidge', 'Ben Cartlidge', 'deduction_annotation', 'Illegal Kick by Galera'),
  ('Illegal Kick by Thomas Cecil Peoples', 'Cecil Peoples', 'deduction_annotation', 'Illegal Kick by Thomas'),
  ('Illegal Knee and Strike to Back of Head by Marquardt Nelson Hamilton', 'Nelson Hamilton', 'deduction_annotation', 'Illegal Knee and Strike to Back of Head by Marquardt'),
  ('Illegal Knee by Jouban Mike Bell', 'Mike Bell', 'deduction_annotation', 'Illegal Knee by Jouban'),
  ('Illegal Knee by Lindland Nelson Hamilton', 'Nelson Hamilton', 'deduction_annotation', 'Illegal Knee by Lindland'),
  ('Illegal Knee by Menne Tony Weeks', 'Tony Weeks', 'deduction_annotation', 'Illegal Knee by Menne'),
  ('Illegal Knee by Papazian Roy Silbert', 'Roy Silbert', 'deduction_annotation', 'Illegal Knee by Papazian'),
  ('Illegal Knee by Silverio Richard Bertrand', 'Richard Bertrand', 'deduction_annotation', 'Illegal Knee by Silverio'),
  ('Illegal Knee by Tickle Sal D''amato', 'Sal D''amato', 'deduction_annotation', 'Illegal Knee by Tickle'),
  ('Illegal Strike to Grounded Opponent and Strike After Bell by Kim Mike Bell', 'Mike Bell', 'deduction_annotation', 'Illegal Strike to Grounded Opponent and Strike After Bell by Kim'),
  ('Illegal Strike to Grounded Opponent by Jones Sal D''amato', 'Sal D''amato', 'deduction_annotation', 'Illegal Strike to Grounded Opponent by Jones'),
  ('Illegal Strikes by Each Fighter Cecil Peoples', 'Cecil Peoples', 'deduction_annotation', 'Illegal Strikes by Each Fighter'),
  ('Kicks on Ground by Camoes Patricia Morse-Jarman', 'Patricia Morse-Jarman', 'deduction_annotation', 'Kicks on Ground by Camoes'),
  ('Kicks to Groin by Escudero Adalaide Byrd', 'Adalaide Byrd', 'deduction_annotation', 'Kicks to Groin by Escudero'),
  ('Kicks to Groin by Grant David Therien', 'David Therien', 'deduction_annotation', 'Kicks to Groin by Grant'),
  ('Kicks to Groin by Tavares Eric Colon', 'Eric Colon', 'deduction_annotation', 'Kicks to Groin by Tavares'),
  ('Losing Mouthpiece by Lucas Abe Belardo', 'Abe Belardo', 'deduction_annotation', 'Losing Mouthpiece by Lucas'),
  ('Low Blow by Blanco Richard Bertrand', 'Richard Bertrand', 'deduction_annotation', 'Low Blow by Blanco'),
  ('Low Blow by Tuck Junichiro Kamijo', 'Junichiro Kamijo', 'deduction_annotation', 'Low Blow by Tuck'),
  ('Low Blow by Watson Richard Bertrand', 'Richard Bertrand', 'deduction_annotation', 'Low Blow by Watson'),
  ('Low Blows by Caceres Sal D''amato', 'Sal D''amato', 'deduction_annotation', 'Low Blows by Caceres'),
  ('Low Blows by Prangley Cecil Peoples', 'Cecil Peoples', 'deduction_annotation', 'Low Blows by Prangley'),
  ('Low Blows by Zhang Eric Colon', 'Eric Colon', 'deduction_annotation', 'Low Blows by Zhang'),
  ('Passivity by Maia Marco Borges', 'Marco Borges', 'deduction_annotation', 'Passivity by Maia'),
  ('Repeated Low Blows by Xiao Mike Bell', 'Mike Bell', 'deduction_annotation', 'Repeated Low Blows by Xiao'),
  ('Technical Decision - Eye Poke Eric Colon', 'Eric Colon', 'deduction_annotation', 'Technical Decision - Eye Poke'),
  ('Technical Decision - Eye Poke by Song Mike Bell', 'Mike Bell', 'deduction_annotation', 'Technical Decision - Eye Poke by Song'),
  ('Technical Decision after Headbutt by Abdul-Malik Will Fisher', 'Will Fisher', 'deduction_annotation', 'Technical Decision after Headbutt by Abdul-Malik'),
  ('Technical decision after clash of heads Ben Cartlidge', 'Ben Cartlidge', 'deduction_annotation', 'Technical decision after clash of heads');

-- Spelling variants. Both are officials who appear under two forms, never on
-- the same event, and inside one commission's territory. The Querido spelling
-- is confirmed against external judging records; the Gerrard merge rests on
-- archive evidence alone and is labelled as such in source_note.
insert into _judge_alias_seed (raw_name, canonical_name, kind, card_note) values
  ('Mamunah Querido', 'Maimunah Querido', 'spelling_variant', null),
  ('Ritchie Gerard', 'Richie Gerrard', 'spelling_variant', null);

insert into public.ufc_judge_profiles (canonical_name, slug, display_name)
select distinct j.name,
       trim(both '-' from regexp_replace(lower(j.name), '[^a-z0-9]+', '-', 'g')),
       j.name
from (
  select btrim(c->>'judge') as name
  from public.ufc_bout_results r
  cross join lateral jsonb_array_elements(r.scorecards) c
  where r.scorecards is not null
) j
where j.name <> ''
  and not exists (select 1 from _judge_alias_seed s where s.raw_name = j.name)
on conflict (canonical_name) do nothing;

insert into public.ufc_judge_aliases (raw_name, canonical_name, kind, card_note, source_note)
select s.raw_name, s.canonical_name, s.kind, s.card_note,
       case s.kind
         when 'deduction_annotation' then 'Upstream Details line prefixed a point-deduction or technical-decision note to the judge name. The note is preserved in card_note and the card is attributed to the canonical official.'
         else case s.raw_name
           when 'Mamunah Querido' then 'Archive spelling variant. Canonical spelling confirmed against external judging records; both forms are New Jersey assignments (Newark, Atlantic City) and never share an event.'
           when 'Ritchie Gerard' then 'Archive spelling variant merged on archive evidence only: both forms are Oceania assignments (Auckland, Melbourne), never share an event, and differ by one letter in each name part. Not confirmed against an external judging record - review before treating the merged sample as a career record.'
           else 'Archive spelling variant.'
         end
       end
from _judge_alias_seed s
where exists (select 1 from public.ufc_judge_profiles p where p.canonical_name = s.canonical_name)
on conflict (raw_name) do update
  set canonical_name = excluded.canonical_name, kind = excluded.kind,
      card_note = excluded.card_note, source_note = excluded.source_note;

-- A spelling variant seeded as its own profile by an earlier run must not
-- survive as a second identity for the same official.
delete from public.ufc_judge_profiles p
where exists (select 1 from public.ufc_judge_aliases a where a.raw_name = p.canonical_name);

create index if not exists ufc_judge_aliases_canonical_idx on public.ufc_judge_aliases (canonical_name);

-- ---------------------------------------------------------------------------
-- 2. The attributed scorecard layer. One row per judge card.
-- ---------------------------------------------------------------------------
create or replace view public.ufc_bout_scorecards as
with raw as (
  select
    r.bout_id, r.method, r.method_raw, r.winner_id, r.result_source, r.source_url,
    b.fighter_a_id, b.fighter_b_id, b.is_title, b.scheduled_rounds, b.event_id,
    c.ord::int as card_index,
    btrim(c.value->>'judge') as raw_judge_name,
    regexp_replace(btrim(coalesce(c.value->>'score', '')), '\s+', '', 'g') as raw_score,
    nullif((regexp_match(coalesce(c.value->>'score', ''), '(\d{1,3})\s*-\s*(\d{1,3})'))[1], '')::int as score_first,
    nullif((regexp_match(coalesce(c.value->>'score', ''), '(\d{1,3})\s*-\s*(\d{1,3})'))[2], '')::int as score_second
  from public.ufc_bout_results r
  join public.ufc_bouts b on b.id = r.bout_id
  cross join lateral jsonb_array_elements(r.scorecards) with ordinality c(value, ord)
  where r.scorecards is not null and jsonb_array_length(r.scorecards) > 0
), named as (
  select raw.*,
         coalesce(a.canonical_name, raw.raw_judge_name) as judge_name,
         a.card_note
  from raw
  left join public.ufc_judge_aliases a on a.raw_name = raw.raw_judge_name
), tally as (
  -- Orientation evidence for the bout as a whole: which position won more
  -- cards. One card cannot settle this; the bout's full set can.
  select bout_id,
         count(*)::int as card_count,
         count(*) filter (where score_second > score_first)::int as second_high,
         count(*) filter (where score_first > score_second)::int as first_high,
         count(*) filter (where score_first = score_second)::int as even_cards
  from named
  group by bout_id
), oriented as (
  select n.*, t.card_count, t.second_high, t.first_high, t.even_cards,
    case
      when n.winner_id is null then null            -- draw / NC: no winner to anchor on
      when t.second_high > t.first_high then 2
      when t.first_high > t.second_high then 1
      else null                                     -- tally does not favour the recorded winner
    end as winner_position
  from named n
  join tally t on t.bout_id = n.bout_id
)
select
  o.bout_id,
  o.card_index,
  o.judge_name,
  trim(both '-' from regexp_replace(lower(o.judge_name), '[^a-z0-9]+', '-', 'g')) as judge_slug,
  o.raw_judge_name,
  o.card_note,
  o.raw_score,
  o.score_first,
  o.score_second,
  o.method,
  o.method_raw,
  o.winner_id,
  o.fighter_a_id,
  o.fighter_b_id,
  o.is_title,
  o.scheduled_rounds,
  o.event_id,
  o.card_count,
  -- Attribution. Null wherever orientation could not be derived: an
  -- unattributed pair is honest, an assumed one is a fabrication.
  case when o.winner_position is null then null
       when (o.winner_position = 2) = (o.winner_id = o.fighter_a_id) then o.score_second
       else o.score_first end as fighter_a_score,
  case when o.winner_position is null then null
       when (o.winner_position = 2) = (o.winner_id = o.fighter_a_id) then o.score_first
       else o.score_second end as fighter_b_score,
  case
    when o.winner_position is null then null
    when o.score_first = o.score_second then null                    -- an even card favours neither
    when (o.score_second > o.score_first) = (o.winner_position = 2) then o.winner_id
    when o.winner_id = o.fighter_a_id then o.fighter_b_id
    else o.fighter_a_id
  end as favored_fighter_id,
  (o.score_first = o.score_second) as is_even_card,
  abs(o.score_first - o.score_second) as score_margin,
  -- A dissent is a card that went to the fighter who did not win the bout.
  -- Undefined where there is no winner or no derived orientation.
  case
    when o.winner_id is null or o.winner_position is null then null
    when o.score_first = o.score_second then false
    else (o.score_second > o.score_first) <> (o.winner_position = 2)
  end as is_dissent,
  case
    when o.winner_id is null then 'unresolved_no_winner'
    when o.winner_position is null then 'unresolved_conflicting_cards'
    else 'derived_from_result'
  end as orientation_basis,
  o.result_source,
  o.source_url
from oriented o;

comment on view public.ufc_bout_scorecards is 'One row per stored judge scorecard, with fighter attribution derived per bout from the recorded winner and the card tally. fighter_a_score, fighter_b_score and favored_fighter_id are NULL wherever orientation could not be derived (draws, and bouts whose cards do not favour the recorded winner); consumers must render those as an unattributed pair.';

-- ---------------------------------------------------------------------------
-- 3. Per-bout summary, including the explicit absence on a finish.
-- ---------------------------------------------------------------------------
create or replace view public.ufc_bout_scorecard_summary as
with cards as (
  select bout_id,
         count(*)::int as card_count,
         count(*) filter (where is_dissent)::int as dissent_cards,
         count(*) filter (where is_even_card)::int as even_cards,
         count(*) filter (where orientation_basis = 'derived_from_result')::int as attributed_cards,
         min(orientation_basis) as orientation_basis,
         sum(fighter_a_score)::int as fighter_a_total,
         sum(fighter_b_score)::int as fighter_b_total,
         array_agg(judge_name order by card_index) as judge_names,
         array_agg(judge_name order by card_index) filter (where is_dissent) as dissenting_judges
  from public.ufc_bout_scorecards
  group by bout_id
)
select
  r.bout_id,
  r.method,
  r.method_raw,
  r.winner_id,
  -- The load-bearing flag. False means the archive holds no judges' decision
  -- for this bout, which for a KO/TKO, submission, DQ or NC is the correct
  -- and expected state rather than a coverage gap.
  (c.bout_id is not null) as has_official_scorecard,
  (r.method in ('DEC_U','DEC_S','DEC_M','DRAW')) as went_to_the_judges,
  case r.method
    when 'DEC_U' then 'unanimous'
    when 'DEC_S' then 'split'
    when 'DEC_M' then 'majority'
    when 'DRAW'  then 'draw'
    else null
  end as decision_type,
  case
    when r.method <> 'DRAW' or c.bout_id is null then null
    when c.even_cards = c.card_count then 'unanimous_draw'
    when c.even_cards = 0 then 'split_draw'
    else 'majority_draw'
  end as draw_type,
  coalesce(c.card_count, 0) as card_count,
  coalesce(c.attributed_cards, 0) as attributed_cards,
  coalesce(c.dissent_cards, 0) as dissent_cards,
  coalesce(c.even_cards, 0) as even_cards,
  c.fighter_a_total,
  c.fighter_b_total,
  c.judge_names,
  c.dissenting_judges,
  c.orientation_basis,
  -- The card shape the method implies, against the shape the cards have.
  -- A handful of archive bouts disagree; surface that rather than smooth it.
  case
    when c.bout_id is null or c.card_count <> 3 then null
    when r.method = 'DEC_U' then c.dissent_cards = 0 and c.even_cards = 0
    when r.method = 'DEC_S' then c.dissent_cards = 1 and c.even_cards = 0
    when r.method = 'DEC_M' then c.dissent_cards = 0 and c.even_cards = 1
    else null
  end as card_shape_matches_method,
  r.result_source,
  r.source_url
from public.ufc_bout_results r
left join cards c on c.bout_id = r.bout_id;

comment on view public.ufc_bout_scorecard_summary is 'Per-bout view of the official scorecard, defined for EVERY result row. has_official_scorecard is false for finishes, which is the correct representation of a fight that never reached the judges.';

-- ---------------------------------------------------------------------------
-- 4. Judge -> bout archive, mirroring ufc_referee_bouts.
-- ---------------------------------------------------------------------------
create or replace view public.ufc_judge_bouts as
select
  s.judge_name,
  p.slug as judge_slug,
  s.bout_id,
  s.card_index,
  s.raw_score,
  s.score_first,
  s.score_second,
  s.fighter_a_score,
  s.fighter_b_score,
  s.favored_fighter_id,
  s.is_even_card,
  s.is_dissent,
  s.score_margin,
  s.orientation_basis,
  s.card_note,
  s.method,
  s.method_raw,
  sm.decision_type,
  sm.draw_type,
  sm.dissent_cards,
  sm.card_count,
  sm.judge_names,
  b.weight_class,
  b.is_womens,
  b.is_title,
  b.scheduled_rounds,
  b.card_position,
  e.id as event_id,
  e.name as event_name,
  e.event_date,
  e.venue,
  e.city,
  e.region,
  e.country,
  fa.id as fighter_a_id,
  fa.name as fighter_a_name,
  fb.id as fighter_b_id,
  fb.name as fighter_b_name,
  s.winner_id,
  case when s.winner_id = fa.id then fa.name when s.winner_id = fb.id then fb.name else null end as winner_name,
  case when s.favored_fighter_id = fa.id then fa.name when s.favored_fighter_id = fb.id then fb.name else null end as favored_fighter_name,
  s.result_source,
  s.source_url
from public.ufc_bout_scorecards s
join public.ufc_bout_scorecard_summary sm on sm.bout_id = s.bout_id
join public.ufc_bouts b on b.id = s.bout_id
join public.ufc_events e on e.id = b.event_id
join public.ufc_fighters fa on fa.id = b.fighter_a_id
join public.ufc_fighters fb on fb.id = b.fighter_b_id
left join public.ufc_judge_profiles p on p.canonical_name = s.judge_name;

comment on view public.ufc_judge_bouts is 'Normalized judge-to-bout scorecard archive with event and fighter context for judge profile pages.';

-- ---------------------------------------------------------------------------
-- 5. Judge statistics. Descriptive counts with their sample sizes attached.
-- ---------------------------------------------------------------------------
create or replace view public.ufc_judge_stats as
with base as (
  select s.*, b.is_title as title_bout, b.scheduled_rounds as sched, e.event_date
  from public.ufc_bout_scorecards s
  join public.ufc_bouts b on b.id = s.bout_id
  join public.ufc_events e on e.id = b.event_id
), agg as (
  select
    judge_name as name,
    count(*)::int as cards,
    count(distinct bout_id)::int as bouts,
    count(*) filter (where method in ('DEC_U','DEC_S','DEC_M'))::int as decision_cards,
    count(*) filter (where method = 'DEC_U')::int as unanimous_cards,
    count(*) filter (where method = 'DEC_S')::int as split_cards,
    count(*) filter (where method = 'DEC_M')::int as majority_cards,
    count(*) filter (where method = 'DRAW')::int as draw_bout_cards,
    count(*) filter (where is_even_card)::int as even_cards,
    -- Dissent is only defined on cards whose orientation resolved, so the
    -- denominator has to be that subset and never the whole sample.
    count(*) filter (where is_dissent is not null)::int as attributed_cards,
    count(*) filter (where is_dissent)::int as dissent_cards,
    count(*) filter (where title_bout)::int as title_cards,
    count(*) filter (where sched = 5 or title_bout)::int as five_round_cards,
    count(*) filter (where score_margin >= 3)::int as wide_cards,
    round(avg(score_margin) filter (where score_margin is not null), 2) as avg_score_margin,
    min(event_date) as first_event_date,
    max(event_date) as last_event_date
  from base
  group by judge_name
), baseline as (
  select
    count(*) filter (where is_dissent is not null)::numeric as all_attributed,
    count(*) filter (where is_dissent)::numeric as all_dissents,
    avg(score_margin) filter (where score_margin is not null) as all_margin
  from base
)
select
  a.*,
  case when a.attributed_cards > 0 then round((a.dissent_cards::numeric / a.attributed_cards) * 100, 1) else null end as dissent_rate,
  round((baseline.all_dissents / nullif(baseline.all_attributed, 0)) * 100, 1) as archive_dissent_rate,
  round(baseline.all_margin, 2) as archive_avg_score_margin,
  baseline.all_attributed::int as archive_attributed_cards
from agg a cross join baseline;

comment on view public.ufc_judge_stats is 'Descriptive judging history from the loaded archive. dissent_rate is the share of a judge''s orientation-resolved cards that went to the fighter who did not win the bout. It is not a competence or bias measure, and must always be rendered with attributed_cards as the sample size.';

create or replace view public.ufc_judge_directory as
select
  s.*,
  p.slug,
  coalesce(p.display_name, s.name) as display_name,
  p.bio,
  p.bio_source_url,
  p.bio_source_name,
  p.bio_verified_at,
  p.country,
  p.commission,
  p.image_url,
  p.image_source_url,
  p.image_credit,
  p.image_license,
  (select count(*) from public.ufc_judge_aliases a where a.canonical_name = s.name and a.kind = 'spelling_variant')::int as merged_spellings
from public.ufc_judge_stats s
left join public.ufc_judge_profiles p on p.canonical_name = s.name;

-- ---------------------------------------------------------------------------
-- 6. Coverage and the classified gap register.
-- ---------------------------------------------------------------------------
-- Every decision or draw result carrying no scorecard, classified by what
-- closing it would take. Derived rather than seeded, so the register cannot
-- freeze today's counts and go quietly stale as the archive grows.
create or replace view public.ufc_scorecard_gaps as
select
  r.bout_id,
  e.id as event_id,
  e.name as event_name,
  e.event_date,
  fa.name as fighter_a_name,
  fb.name as fighter_b_name,
  r.method,
  r.method_raw,
  r.result_source,
  b.ufcstats_id as bout_ufcstats_id,
  e.ufcstats_id as event_ufcstats_id,
  r.finish_detail,
  (r.finish_detail ~ '\d{1,3}\s*-\s*\d{1,3}') as scores_held_without_judges,
  case
    -- A tournament-era draw recorded only as "Time Expired": there was never
    -- a three-card decision to recover.
    when r.finish_detail = 'Time Expired' then 'non_standard'
    -- The numbers are already in the archive; only the judges' names are
    -- missing from the upstream Details line.
    when r.finish_detail ~ '\d{1,3}\s*-\s*\d{1,3}' then 'recoverable'
    -- An ESPN-sourced result whose UFC Stats fight page is already identified.
    when r.result_source = 'espn' and b.ufcstats_id is not null then 'recoverable'
    -- An ESPN-sourced result at an event we HAVE ingested from UFC Stats,
    -- whose bout never matched a UFC Stats fight: a name/identity mismatch,
    -- not a missing page.
    when r.result_source = 'espn' and b.ufcstats_id is null and e.ufcstats_id is not null
         and exists (select 1 from public.ufc_bouts sib where sib.event_id = b.event_id and sib.ufcstats_id is not null)
      then 'identity_mismatch'
    else 'source_unavailable'
  end as classification,
  case
    when r.finish_detail = 'Time Expired' then 'tournament_era_time_expired_no_decision'
    when r.finish_detail ~ '\d{1,3}\s*-\s*\d{1,3}' then 'scores_present_judges_unnamed_upstream'
    when r.result_source = 'espn' and b.ufcstats_id is not null then 'ufcstats_fight_page_identified'
    when r.result_source = 'espn' and b.ufcstats_id is null and e.ufcstats_id is not null
         and exists (select 1 from public.ufc_bouts sib where sib.event_id = b.event_id and sib.ufcstats_id is not null)
      then 'espn_row_unmatched_at_ingested_event'
    when e.name ilike '%contender%' or e.name ilike '%dana white%' then 'event_series_not_covered_by_source'
    else 'no_scorecard_recorded_upstream'
  end as reason,
  r.source_url
from public.ufc_bout_results r
join public.ufc_bouts b on b.id = r.bout_id
join public.ufc_events e on e.id = b.event_id
join public.ufc_fighters fa on fa.id = b.fighter_a_id
join public.ufc_fighters fb on fb.id = b.fighter_b_id
where r.method in ('DEC_U','DEC_S','DEC_M','DRAW')
  and (r.scorecards is null or jsonb_array_length(r.scorecards) = 0);

comment on view public.ufc_scorecard_gaps is 'Decision and draw results with no stored scorecard, classified recoverable / identity_mismatch / source_unavailable / non_standard, with the evidence each classification rests on.';

create or replace view public.ufc_scorecard_coverage as
select
  count(*) filter (where r.method in ('DEC_U','DEC_S','DEC_M','DRAW'))::int as judged_results,
  count(*) filter (where r.method in ('DEC_U','DEC_S','DEC_M','DRAW') and r.scorecards is not null and jsonb_array_length(r.scorecards) > 0)::int as with_scorecards,
  count(*) filter (where r.method in ('DEC_U','DEC_S','DEC_M','DRAW') and (r.scorecards is null or jsonb_array_length(r.scorecards) = 0))::int as missing_scorecards,
  count(*) filter (where r.method not in ('DEC_U','DEC_S','DEC_M','DRAW'))::int as finishes_no_scorecard_expected,
  count(*) filter (where r.method not in ('DEC_U','DEC_S','DEC_M','DRAW') and r.scorecards is not null and jsonb_array_length(r.scorecards) > 0)::int as finishes_with_unexpected_scorecard,
  (select count(*) from public.ufc_bout_scorecards)::int as attributed_card_rows,
  (select count(*) from public.ufc_bout_scorecards where orientation_basis <> 'derived_from_result')::int as unattributed_card_rows,
  (select count(*) from public.ufc_judge_profiles)::int as canonical_judges,
  (select count(*) from public.ufc_judge_aliases)::int as judge_aliases
from public.ufc_bout_results r;

alter table public.ufc_judge_profiles enable row level security;
alter table public.ufc_judge_aliases enable row level security;

comment on table public.ufc_judge_profiles is 'Canonical MMA judge identities seeded from the stored scorecard archive, with optional sourced enrichment. Judging statistics are computed from bout rows, never hand-entered.';
comment on table public.ufc_judge_aliases is 'Raw scorecard judge strings mapped to canonical identities. deduction_annotation rows carry an upstream point-deduction note that was concatenated onto the judge name; spelling_variant rows merge two spellings of one official.';
