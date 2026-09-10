-- Combat graph privilege hardening.
--
-- Supabase default grants can leave service_role with table-owner-like DELETE,
-- TRUNCATE, REFERENCES and TRIGGER privileges even when an earlier migration
-- only grants SELECT/INSERT/UPDATE. Make the intended operational contract
-- explicit: writers may select/insert/update canonical combat rows; views are
-- read-only; destructive table privileges are not granted to service_role.

begin;

revoke all on table
  public.combat_sources,
  public.combat_fighters,
  public.combat_fighter_identities,
  public.combat_fighter_aliases,
  public.combat_identity_review_queue,
  public.combat_promotions,
  public.combat_rulesets,
  public.combat_events,
  public.combat_bouts,
  public.combat_bout_results,
  public.combat_round_stats,
  public.combat_source_claims,
  public.combat_import_runs,
  public.combat_ingest_packets,
  public.combat_officials,
  public.combat_official_identities,
  public.combat_bout_officials,
  public.combat_scorecards,
  public.combat_weigh_ins,
  public.combat_titles,
  public.combat_title_bouts,
  public.combat_rankings,
  public.combat_status_events,
  public.combat_awards,
  public.combat_career_bouts,
  public.combat_fighter_career_summary,
  public.combat_ufc_bridge_coverage
from service_role;

grant select, insert, update on table
  public.combat_sources,
  public.combat_fighters,
  public.combat_fighter_identities,
  public.combat_fighter_aliases,
  public.combat_identity_review_queue,
  public.combat_promotions,
  public.combat_rulesets,
  public.combat_events,
  public.combat_bouts,
  public.combat_bout_results,
  public.combat_round_stats,
  public.combat_source_claims,
  public.combat_import_runs,
  public.combat_ingest_packets,
  public.combat_officials,
  public.combat_official_identities,
  public.combat_bout_officials,
  public.combat_scorecards,
  public.combat_weigh_ins,
  public.combat_titles,
  public.combat_title_bouts,
  public.combat_rankings,
  public.combat_status_events,
  public.combat_awards
to service_role;

grant select on table
  public.combat_career_bouts,
  public.combat_fighter_career_summary,
  public.combat_ufc_bridge_coverage
to service_role;

commit;
