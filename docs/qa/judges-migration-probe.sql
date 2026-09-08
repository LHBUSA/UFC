with card as (
with _alias(raw_name, canonical_name, kind, card_note) as (values
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
('Technical decision after clash of heads Ben Cartlidge', 'Ben Cartlidge', 'deduction_annotation', 'Technical decision after clash of heads'),
('Mamunah Querido', 'Maimunah Querido', 'spelling_variant', null),
('Ritchie Gerard', 'Richie Gerrard', 'spelling_variant', null)
), raw as (
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
  left join _alias a on a.raw_name = raw.raw_judge_name
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
from oriented o
)
select
  count(*)::int as card_rows,
  count(distinct bout_id)::int as bouts,
  count(*) filter (where orientation_basis = 'derived_from_result')::int as attributed_cards,
  count(*) filter (where orientation_basis = 'unresolved_no_winner')::int as unresolved_no_winner,
  count(*) filter (where orientation_basis = 'unresolved_conflicting_cards')::int as unresolved_conflicting_cards,
  count(*) filter (where is_dissent)::int as dissent_cards,
  count(*) filter (where is_even_card)::int as even_cards,
  count(distinct judge_name)::int as canonical_judges,
  count(distinct raw_judge_name)::int as raw_judge_strings,
  count(*) filter (where fighter_a_score is null)::int as unattributed_cards
from card;
