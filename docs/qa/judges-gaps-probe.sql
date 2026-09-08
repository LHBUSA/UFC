select classification, reason, count(*)::int as n from (
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
  and (r.scorecards is null or jsonb_array_length(r.scorecards) = 0)
) g group by 1, 2 order by 3 desc;
