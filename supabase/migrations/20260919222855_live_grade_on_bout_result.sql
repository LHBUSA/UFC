-- Grade locked PBE predictions in the same transaction boundary as verified bout results.
-- This removes fight-night dependence on a separate cron/service-binding pass while
-- preserving the append-only grading trigger as the final integrity gate.

create or replace function public.ufc_model_grade_from_bout_result()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p record;
  cur record;
  desired_result text;
  desired_winner uuid;
  reason text;
begin
  for p in
    select id, pick_fighter_id, fighter_a_id, fighter_b_id
    from public.ufc_model_predictions
    where bout_id = new.bout_id
      and locked_at is not null
  loop
    desired_result := null;
    desired_winner := null;

    if new.method = 'NC' then
      desired_result := 'NC';
    elsif new.method = 'DRAW' then
      desired_result := 'DRAW';
    elsif new.winner_id is not null and new.winner_id = p.pick_fighter_id then
      desired_result := 'WIN';
      desired_winner := new.winner_id;
    elsif new.winner_id is not null and new.winner_id in (p.fighter_a_id, p.fighter_b_id) then
      desired_result := 'LOSS';
      desired_winner := new.winner_id;
    else
      continue;
    end if;

    cur := null;
    select g.id, g.result, g.winner_id, g.revision
      into cur
      from public.ufc_model_prediction_grades g
     where g.prediction_id = p.id
     order by g.revision desc
     limit 1;

    if cur.id is not null
       and cur.result = desired_result
       and cur.winner_id is not distinct from desired_winner then
      continue;
    end if;

    reason := case
      when cur.id is not null then format('stored result changed from %s to %s', cur.result, desired_result)
      else null
    end;

    insert into public.ufc_model_prediction_grades (
      prediction_id, result, winner_id, method,
      source, source_ref, source_captured_at, graded_by, revision_reason
    ) values (
      p.id, desired_result, desired_winner, new.method,
      'ufc_bout_results', new.source_url, new.captured_at,
      'ufc-bout-result-trigger', reason
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists ufc_model_grade_from_bout_result_trg on public.ufc_bout_results;
create trigger ufc_model_grade_from_bout_result_trg
after insert or update of winner_id, method, source_url, captured_at
on public.ufc_bout_results
for each row
execute function public.ufc_model_grade_from_bout_result();

revoke all on function public.ufc_model_grade_from_bout_result() from public;

-- One-time repair for a result that landed before this trigger existed.
insert into public.ufc_model_prediction_grades (
  prediction_id, result, winner_id, method,
  source, source_ref, source_captured_at, graded_by, revision_reason
)
select
  p.id,
  case
    when br.method = 'NC' then 'NC'
    when br.method = 'DRAW' then 'DRAW'
    when br.winner_id = p.pick_fighter_id then 'WIN'
    when br.winner_id in (p.fighter_a_id, p.fighter_b_id) then 'LOSS'
  end,
  case when br.method in ('NC', 'DRAW') then null else br.winner_id end,
  br.method,
  'ufc_bout_results',
  br.source_url,
  br.captured_at,
  'ufc-bout-result-trigger',
  null
from public.ufc_model_predictions p
join public.ufc_bout_results br on br.bout_id = p.bout_id
left join public.ufc_model_prediction_current_grade cg on cg.prediction_id = p.id
where p.locked_at is not null
  and cg.prediction_id is null
  and (
    br.method in ('NC', 'DRAW')
    or br.winner_id in (p.fighter_a_id, p.fighter_b_id)
  );
