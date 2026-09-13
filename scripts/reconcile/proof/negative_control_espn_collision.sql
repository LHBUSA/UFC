-- Negative control (proof only, rolled back): give an UNRELATED fighter one of
-- the planned ESPN ids. The reconciliation must refuse with a collision.
set local reconcile.report = 'raise';
update public.ufc_fighters set espn_athlete_id = '2335522'
where id = (select id from public.ufc_fighters where espn_athlete_id is null and name = 'Rich Franklin' limit 1);
