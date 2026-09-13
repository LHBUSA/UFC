"""Fresh-connection fingerprints around the Legacy / Origins apply.

  --capture   before the apply: fingerprint every raw surface the repair must
              not change (read-only)
  --verify    after the apply: recompute the same fingerprints, compare, and
              check every new Origins object, grant and first-repair count

    python scripts/legacy/verify_origins_apply.py --capture --out D:/Workers/_research/ufc-legacy-origins-2026-09-12/apply
    python scripts/legacy/verify_origins_apply.py --verify  --out D:/Workers/_research/ufc-legacy-origins-2026-09-12/apply
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from prove_first_repair import NEW_TABLES, cli_token, run_sql  # noqa: E402

UFC1 = "(select id from public.ufc_events where ufcstats_id = '6420efac0578988b')"
LIKE_UFC = "'ufc" + chr(92) + "_%'"
LIKE_COMBAT = "'combat" + chr(92) + "_%'"

FINGERPRINT = f"""select jsonb_build_object(
  'results_raw_md5', (select md5(string_agg(concat_ws('|', bout_id, winner_id, method, method_raw, round, time_sec, time_format, referee, judge_1, judge_2, judge_3, scorecards::text, finish_detail, result_source, has_stats, source_url, stats_source_url), '~' order by bout_id))
                      from public.ufc_bout_results where bout_id not in (select id from public.ufc_bouts where event_id is not distinct from {UFC1})),
  'results_n_excl_ufc1', (select count(*) from public.ufc_bout_results where bout_id not in (select id from public.ufc_bouts where event_id is not distinct from {UFC1})),
  'bouts_raw_md5', (select md5(string_agg(concat_ws('|', id, ufcstats_id, espn_competition_id, event_id, fighter_a_id, fighter_b_id, weight_class, weight_class_raw, is_womens, is_title, scheduled_rounds, card_position, bout_order, status, source_url), '~' order by id))
                    from public.ufc_bouts where event_id is distinct from {UFC1}),
  'events_raw_md5_excl_espn_id', (select md5(string_agg(concat_ws('|', id, ufcstats_id, name, event_date, venue, city, region, country, location_raw, commission, is_ppv, card_status, source_url), '~' order by id))
                    from public.ufc_events where id is distinct from {UFC1}),
  'round_stats_md5', (select md5(string_agg(concat_ws('|', bout_id, fighter_id, round, kd, sig_str_landed, sig_str_att, total_str_landed, total_str_att, td_landed, td_att, sub_att, rev, ctrl_sec, source_url), '~' order by bout_id, fighter_id, round)) from public.ufc_bout_round_stats),
  'videos_md5', (select md5(string_agg(t::text, '~' order by t.id)) from public.ufc_videos t),
  'dwcs_claims_md5', (select md5(coalesce(string_agg(t::text, '~' order by t::text), '')) from public.ufc_dwcs_outcome_claims t),
  'dwcs_resolutions_md5', (select md5(coalesce(string_agg(t::text, '~' order by t::text), '')) from public.ufc_dwcs_outcome_resolutions t),
  'fighters_md5_existing', (select md5(string_agg(t::text, '~' order by t.id)) from public.ufc_fighters t where t.ufcstats_id is distinct from '279093302a6f44b3' and t.ufcstats_id is distinct from '96eff1a628adcc7f' and t.ufcstats_id is distinct from 'a5c53b3ddb31cc7d'),
  'fighters_n', (select count(*) from public.ufc_fighters),
  'legacy_espn_ids', (select count(*) from public.ufc_events where event_date <= '2004-12-31' and espn_event_id is not null),
  'legacy_venues_non_null', (select count(*) from public.ufc_events where event_date <= '2004-12-31' and venue is not null)
) as fp;"""

COUNTS = f"""do $c$ begin end $c$;
select jsonb_object_agg(relname, n) as counts from (
  select c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::bigint as n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relkind in ('r','p') and (c.relname like {LIKE_UFC} or c.relname like {LIKE_COMBAT})
) x;"""

POST = f"""select jsonb_build_object(
  'tables', (select jsonb_object_agg(t, to_regclass('public.' || t) is not null) from unnest(array[{",".join("'" + t + "'" for t in NEW_TABLES)}]) t),
  'views', jsonb_build_object('ufc_bout_round_stats_periods', to_regclass('public.ufc_bout_round_stats_periods') is not null, 'ufc_event_fact_display', to_regclass('public.ufc_event_fact_display') is not null),
  'function', to_regprocedure('public.ufc_time_format_structure(text)') is not null,
  'result_columns', (select count(*) from information_schema.columns where table_schema='public' and table_name='ufc_bout_results' and column_name in ('period_structure','ending_period_kind','ending_period_number','elapsed_fight_sec','period_semantics_basis','period_semantics_version')),
  'bout_columns', (select count(*) from information_schema.columns where table_schema='public' and table_name='ufc_bouts' and column_name in ('ruleset_id','ruleset_basis','historical_weight_limit_text','historical_weight_min_lbs','historical_weight_max_lbs','historical_limit_basis','historical_division_label','title_kind','title_label_raw','historical_semantics_evidence')),
  'ruleset_fk', (select count(*) from pg_constraint where conname = 'ufc_bouts_ruleset_id_fkey'),
  'fact_keys', (select count(*) from public.ufc_event_fact_keys),
  'sources', (select jsonb_object_agg(source_key, jsonb_build_object('access_mode', access_mode, 'enabled', enabled)) from public.combat_sources where source_key in ('nsac','nj_sacb','pbe_legacy_curated','ufc_official')),
  'video_check_event_replay', (select pg_get_constraintdef(oid) like '%event_replay%' from pg_constraint where conname = 'ufc_videos_video_type_check'),
  'triggers', (select jsonb_agg(tgname order by tgname) from pg_trigger where not tgisinternal and tgname in ('ufc_event_fact_claims_guard','ufc_event_fact_resolutions_guard','ufc_tournament_advancements_guard')),
  'new_objects_anon_auth_privileges', (select count(*) from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        where c.oid in (select to_regclass('public.' || t) from unnest(array[{",".join("'" + t + "'" for t in NEW_TABLES)}, 'ufc_bout_round_stats_periods', 'ufc_event_fact_display']) t)
          and pg_get_userbyid(a.grantee) in ('anon','authenticated')),
  'new_tables_service_role', (select jsonb_object_agg(c.relname, (select jsonb_agg(distinct a.privilege_type order by a.privilege_type) from aclexplode(c.relacl) a where pg_get_userbyid(a.grantee) = 'service_role'))
        from pg_class c where c.oid in (select to_regclass('public.' || t) from unnest(array[{",".join("'" + t + "'" for t in NEW_TABLES)}]) t)),
  'ufc_anon_auth_write_grants', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        where n.nspname = 'public' and c.relkind in ('r','p') and c.relname like {LIKE_UFC} and pg_get_userbyid(a.grantee) in ('anon','authenticated') and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')),
  'rls_disabled_ufc', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and c.relname like {LIKE_UFC} and not c.relrowsecurity),
  'ufc1', (select jsonb_build_object('events', (select count(*) from public.ufc_events where ufcstats_id = '6420efac0578988b' and espn_event_id = '400255729'),
        'bouts', (select count(*) from public.ufc_bouts where event_id = {UFC1}),
        'results', (select count(*) from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id where b.event_id = {UFC1}),
        'results_whole_fight', (select count(*) from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id where b.event_id = {UFC1} and r.ending_period_kind = 'whole_fight'),
        'referee_non_null', (select count(*) from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id where b.event_id = {UFC1} and r.referee is not null),
        'referee_claims', (select jsonb_object_agg(k, n) from (select source_type || ':' || conflict_state k, count(*) n from public.ufc_event_fact_claims where event_id = {UFC1} and fact_key = 'referee' group by 1) x),
        'referee_resolutions', (select count(*) from public.ufc_event_fact_resolutions where event_id = {UFC1}),
        'venue', (select venue from public.ufc_events where ufcstats_id = '6420efac0578988b'),
        'new_fighters', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'dob', dob, 'ufcstats_id', ufcstats_id, 'espn_athlete_id', espn_athlete_id) order by name)
                         from public.ufc_fighters where ufcstats_id in ('279093302a6f44b3','96eff1a628adcc7f','a5c53b3ddb31cc7d')),
        'review_rows', (select jsonb_agg(jsonb_build_object('name', raw_name, 'status', status, 'resolved_to', resolved_fighter_id) order by raw_name) from public.ufc_alias_review_queue where source = 'legacy_origins_ufc1'),
        'packets', (select count(*) from public.combat_ingest_packets where ingest_key like 'legacy-origins:ufc1:%'))),
  'duplicate_fighter_names_ufc1', (select count(*) from (select lower(regexp_replace(name, '[^A-Za-z]', '', 'g')) k from public.ufc_fighters
        where lower(regexp_replace(name, '[^A-Za-z]', '', 'g')) in ('gerardgordeau','teilatuli','artjimmerson') group by 1 having count(*) > 1) d),
  'duplicate_ids', (select count(*) from (select espn_athlete_id from public.ufc_fighters where espn_athlete_id is not null group by 1 having count(*) > 1) d)
        + (select count(*) from (select ufcstats_id from public.ufc_fighters where ufcstats_id is not null group by 1 having count(*) > 1) d),
  'duplicate_espn_event_ids', (select count(*) from (select espn_event_id from public.ufc_events where espn_event_id is not null group by 1 having count(*) > 1) d),
  'semantics', (select jsonb_object_agg(k, n) from (select period_structure || '/' || ending_period_kind k, count(*) n from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id join public.ufc_events e on e.id = b.event_id
        where e.event_date <= '2004-12-31' and e.ufcstats_id <> '6420efac0578988b' group by 1) x),
  'semantics_null_pre2005', (select count(*) from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id join public.ufc_events e on e.id = b.event_id where e.event_date <= '2004-12-31' and r.period_structure is null),
  'semantics_post2004', (select count(*) from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id join public.ufc_events e on e.id = b.event_id where e.event_date > '2004-12-31' and r.period_structure is not null),
  'venue_claims_espn', (select count(*) from public.ufc_event_fact_claims where fact_key = 'venue_name' and source_type = 'espn'),
  'claims_total', (select count(*) from public.ufc_event_fact_claims),
  'ledger', (select jsonb_object_agg(step || ':' || table_name || ':' || operation, n) from (select step, table_name, operation, count(*) n from public.ufc_legacy_repair_ledger group by 1,2,3) x),
  'tournaments', (select count(*) from public.ufc_tournaments),
  'resolutions', (select count(*) from public.ufc_event_fact_resolutions)
) as post;"""


def q(token, sql, key):
    r = run_sql(token, sql)
    if isinstance(r, dict):
        raise SystemExit(f"query failed: {r}")
    return r[-1][key]


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--capture", action="store_true")
    g.add_argument("--verify", action="store_true")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    token = cli_token()
    fp = q(token, FINGERPRINT, "fp")
    counts = q(token, COUNTS, "counts")
    if args.capture:
        (out / "pre_apply_fingerprint.json").write_bytes(json.dumps({"fingerprint": fp, "counts": counts}, indent=1, sort_keys=True).encode())
        print(json.dumps(fp, indent=1))
        print(f"{len(counts)} ufc_*/combat_* tables counted")
        return 0

    pre = json.loads((out / "pre_apply_fingerprint.json").read_bytes())
    post = q(token, POST, "post")
    checks = []
    for k in ("results_raw_md5", "results_n_excl_ufc1", "bouts_raw_md5", "events_raw_md5_excl_espn_id", "round_stats_md5", "videos_md5",
              "dwcs_claims_md5", "dwcs_resolutions_md5", "fighters_md5_existing"):
        checks.append((f"raw unchanged: {k}", pre["fingerprint"][k] == fp[k], f"{pre['fingerprint'][k]} -> {fp[k]}"))
    changed = {t: (pre["counts"].get(t), counts.get(t)) for t in set(pre["counts"]) | set(counts) if pre["counts"].get(t) != counts.get(t)}
    allowed = {"ufc_events": 1, "ufc_bouts": 8, "ufc_bout_results": 8, "ufc_fighters": 3, "ufc_alias_review_queue": 3, "combat_ingest_packets": 12,
               "combat_sources": 3}  # migration section 8: nsac, nj_sacb, pbe_legacy_curated
    new_tables = set(NEW_TABLES)
    bad = {t: v for t, v in changed.items() if t not in new_tables and not (t in allowed and v[0] is not None and v[1] - v[0] == allowed[t])}
    checks.append(("table row-count deltas are exactly the approved inserts", not bad, json.dumps(changed, sort_keys=True)))
    u = post["ufc1"]
    checks += [
        ("all Origins tables present", all(post["tables"].values()), json.dumps(post["tables"])),
        ("both views + parser present", all(post["views"].values()) and post["function"], None),
        ("result columns 6 / bout columns 10 / ruleset FK", post["result_columns"] == 6 and post["bout_columns"] == 10 and post["ruleset_fk"] == 1, None),
        ("fact keys seeded (21)", post["fact_keys"] == 21, str(post["fact_keys"])),
        ("sources: nsac approved, nj_sacb disabled, curated internal, UFC.com still disabled",
         post["sources"]["nsac"]["enabled"] and not post["sources"]["nj_sacb"]["enabled"] and post["sources"]["pbe_legacy_curated"]["enabled"] and not post["sources"]["ufc_official"]["enabled"], json.dumps(post["sources"])),
        ("video_type check widened", post["video_check_event_replay"], None),
        ("guard triggers present (3)", len(post["triggers"] or []) == 3, json.dumps(post["triggers"])),
        ("new Origins objects: zero anon/authenticated privileges", post["new_objects_anon_auth_privileges"] == 0, str(post["new_objects_anon_auth_privileges"])),
        ("new Origins tables: service_role has no DELETE/TRUNCATE", all(not ({"DELETE", "TRUNCATE"} & set(v or [])) for v in post["new_tables_service_role"].values()), json.dumps(post["new_tables_service_role"])),
        ("all ufc_* tables: zero anon/authenticated write grants (022 holds)", post["ufc_anon_auth_write_grants"] == 0, str(post["ufc_anon_auth_write_grants"])),
        ("RLS enabled on every ufc_* table", post["rls_disabled_ufc"] == 0, None),
        ("UFC 1: 1 event, 8 bouts, 8 whole-fight results", (u["events"], u["bouts"], u["results"], u["results_whole_fight"]) == (1, 8, 8, 8), json.dumps(u)),
        ("UFC 1: canonical referee NULL, no resolution", u["referee_non_null"] == 0 and u["referee_resolutions"] == 0, json.dumps(u["referee_claims"])),
        ("UFC 1: canonical venue NULL", u["venue"] is None, None),
        ("UFC 1: 3 new fighters, DOB NULL", len(u["new_fighters"] or []) == 3 and all(f["dob"] is None for f in u["new_fighters"]), json.dumps(u["new_fighters"])),
        ("UFC 1: review rows resolved to the new fighters", len(u["review_rows"] or []) == 3 and {r["resolved_to"] for r in u["review_rows"]} == {f["id"] for f in u["new_fighters"]}, None),
        ("UFC 1: 12 packets", u["packets"] == 12, None),
        ("duplicate identities: 0", post["duplicate_fighter_names_ufc1"] == 0 and post["duplicate_ids"] == 0, None),
        ("duplicate ESPN event ids: 0", post["duplicate_espn_event_ids"] == 0, None),
        ("semantics: 31/53/88/29/239 on the 440 pre-existing legacy results",
         post["semantics"] == {"untimed/whole_fight": 31, "single_period/regulation_period": 53, "regulation_overtime/regulation_period": 88, "regulation_overtime/overtime": 29, "rounds/round": 239},
         json.dumps(post["semantics"])),
        ("semantics: none left null pre-2005, none written post-2004", post["semantics_null_pre2005"] == 0 and post["semantics_post2004"] == 0, None),
        ("ESPN event ids: 55 legacy events carry one (54 filled + UFC 1)", fp["legacy_espn_ids"] == 55 and pre["fingerprint"]["legacy_espn_ids"] == 0, None),
        ("canonical venue writes: 0", fp["legacy_venues_non_null"] == 0 and pre["fingerprint"]["legacy_venues_non_null"] == 0, None),
        ("venue claims: 53", post["venue_claims_espn"] == 53, str(post["venue_claims_espn"])),
        ("claims total: 69 (16 referee + 53 venue)", post["claims_total"] == 69, str(post["claims_total"])),
        ("no tournaments or resolutions written yet", post["tournaments"] == 0 and post["resolutions"] == 0, None),
    ]
    (out / "post_apply_verify.json").write_bytes(json.dumps({"fingerprint": fp, "counts": counts, "post": post,
                                                              "checks": [{"name": n, "ok": ok, "detail": d} for n, ok, d in checks]}, indent=1, sort_keys=True).encode())
    for n, ok, d in checks:
        print(("PASS " if ok else "FAIL ") + n + (f"  [{d}]" if d and not ok else ""))
    print("ledger:", json.dumps(post["ledger"]))
    failed = sum(1 for _, ok, _ in checks if not ok)
    print(f"verify passed={len(checks) - failed} failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
