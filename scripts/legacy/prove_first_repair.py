"""Prove the legacy-origins migration and the first data repair on PRODUCTION,
inside one transaction that always ends in ROLLBACK.

Nothing persists. The script builds one SQL batch:

    BEGIN
      fingerprint every raw column the repair must not touch
      <migration body, its own begin/commit/notify removed>
      step 3  UFC 1: packets + review queue rows, then a SIMULATED operator
              resolution: 3 fighters, event, 8 bouts, 8 results, ledger
      step 4  period semantics for every legacy result, compared row by row
              with the Python plan
      step 5  ESPN event ids (null fills only) + ESPN venue/referee claims
      step 6  judge fields: no writes; alias resolution asserted
      guard tests (each expected failure inside its own subtransaction)
      SELECT the assertion table
    ROLLBACK

then checks from a fresh session that no new table or column exists.

    python scripts/legacy/prove_first_repair.py \
        --plan D:/Workers/_research/ufc-legacy-origins-2026-09-12/plan/first_repair_plan.json \
        --out  D:/Workers/_research/ufc-legacy-origins-2026-09-12/plan

The Management API token is read from the Supabase CLI's Windows credential
entry and never printed. Exit 0 only when every assertion passed AND the
post-rollback check finds nothing left behind.
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import hashlib
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/20260913140000_ufc_legacy_origins.sql"
PROJECT_REF = "tkmlnhmylqnttmnsnief"
OPERATOR = "proof:ufc-legacy-origins-v1"
NEW_TABLES = ["ufc_event_fact_keys", "ufc_event_fact_claims", "ufc_event_fact_resolutions", "ufc_tournaments",
              "ufc_tournament_entries", "ufc_tournament_advancements", "ufc_legacy_repair_ledger"]


# ---------------------------------------------------------------------------
def cli_token() -> str:
    class CREDENTIAL(ctypes.Structure):
        _fields_ = [("Flags", wt.DWORD), ("Type", wt.DWORD), ("TargetName", wt.LPWSTR), ("Comment", wt.LPWSTR),
                    ("LastWritten", wt.FILETIME), ("CredentialBlobSize", wt.DWORD), ("CredentialBlob", ctypes.POINTER(ctypes.c_char)),
                    ("Persist", wt.DWORD), ("AttributeCount", wt.DWORD), ("Attributes", ctypes.c_void_p),
                    ("TargetAlias", wt.LPWSTR), ("UserName", wt.LPWSTR)]
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    ptr = ctypes.POINTER(CREDENTIAL)()
    if not advapi.CredReadW("Supabase CLI:supabase", 1, 0, ctypes.byref(ptr)):
        raise SystemExit("Supabase CLI token not found")
    try:
        c = ptr.contents
        return ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize).decode("utf-8")
    finally:
        advapi.CredFree(ptr)


def run_sql(token: str, sql: str):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query",
        data=json.dumps({"query": sql}).encode(), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.load(r)
    except urllib.error.HTTPError as exc:
        return {"error": exc.code, "message": exc.read().decode("utf-8", "replace")[:4000]}


# ---------------------------------------------------------------------------
def lit(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def jlit(v) -> str:
    return lit(json.dumps(v, sort_keys=True)) + "::jsonb"


def migration_body() -> str:
    text = MIGRATION.read_text(encoding="utf-8")
    lines = text.splitlines()
    found = {"begin;": 0, "commit;": 0, "notify": 0}
    out = []
    for line in lines:
        s = line.strip().lower()
        if s == "begin;":
            found["begin;"] += 1
            continue
        if s == "commit;":
            found["commit;"] += 1
            continue
        if s.startswith("notify pgrst"):
            found["notify"] += 1
            continue
        out.append(line)
    if found != {"begin;": 1, "commit;": 1, "notify": 1}:
        raise SystemExit(f"migration transaction markers unexpected: {found}")
    return "\n".join(out)


# ---------------------------------------------------------------------------
def build(plan: dict, plan_sha: str) -> str:
    u1 = plan["ufc1"]
    sem = plan["period_semantics"]
    ids = plan["event_ids_venue"]
    P = lit(plan_sha)
    sql: list[str] = []
    add = sql.append

    add("begin;")
    add("set local lock_timeout = '5s';")
    add("set local statement_timeout = '240s';")
    add("create temp table proof (seq serial, name text not null, ok boolean not null, detail text) on commit drop;")
    add("""create temp table proof_before on commit drop as select
  (select md5(string_agg(concat_ws('|', bout_id, winner_id, method, method_raw, round, time_sec, time_format, referee, judge_1, judge_2, judge_3, scorecards::text, finish_detail, result_source, has_stats, source_url, stats_source_url), '~' order by bout_id)) from public.ufc_bout_results) as results_raw_md5,
  (select count(*) from public.ufc_bout_results) as results_n,
  (select md5(string_agg(concat_ws('|', id, ufcstats_id, espn_competition_id, event_id, fighter_a_id, fighter_b_id, weight_class, weight_class_raw, is_womens, is_title, scheduled_rounds, card_position, bout_order, status, source_url), '~' order by id)) from public.ufc_bouts) as bouts_raw_md5,
  (select count(*) from public.ufc_bouts) as bouts_n,
  (select md5(string_agg(concat_ws('|', id, ufcstats_id, name, event_date, venue, city, region, country, location_raw, commission, is_ppv, card_status, source_url), '~' order by id)) from public.ufc_events) as events_raw_md5,
  (select count(*) from public.ufc_events) as events_n,
  (select md5(string_agg(concat_ws('|', bout_id, fighter_id, round, kd, sig_str_landed, sig_str_att, total_str_landed, ctrl_sec), '~' order by bout_id, fighter_id, round)) from public.ufc_bout_round_stats) as round_stats_md5,
  (select count(*) from public.ufc_fighters) as fighters_n,
  (select md5(string_agg(concat_ws('|', id, provider, provider_video_id, video_type, link_status), '~' order by id)) from public.ufc_videos) as videos_md5,
  (select count(*) from public.ufc_bout_scorecards) as v_scorecards,
  (select count(*) from public.ufc_judge_bouts) as v_judge_bouts,
  (select count(*) from public.ufc_judge_stats) as v_judge_stats,
  (select count(*) from public.ufc_referee_bouts) as v_referee_bouts,
  (select count(*) from public.ufc_referee_stats) as v_referee_stats,
  (select count(*) from public.ufc_scorecard_coverage) as v_scorecard_coverage,
  (select count(*) from public.ufc_scorecard_gaps) as v_scorecard_gaps,
  (select count(*) from public.combat_career_bouts) as v_career_bouts,
  (select count(*) from public.ufc_weigh_in_current) as v_weigh_in_current,
  (select count(*) from public.ufc_alias_review_queue) as review_n,
  (select count(*) from public.combat_ingest_packets) as packets_n;""")
    add("create temp table proof_legacy_before on commit drop as select r.bout_id from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id join public.ufc_events e on e.id = b.event_id where e.event_date <= '2004-12-31';")

    add("-- ===================== MIGRATION BODY =====================")
    add(migration_body())
    add("-- ===================== DATA =====================")

    # ---- step 3: UFC 1 ----
    add("create temp table u1_fighter (espn_athlete_id text primary key, fighter_id uuid, review_id uuid) on commit drop;")
    for f in u1["fighters"]:
        add(f"insert into u1_fighter values ({lit(f['espn_athlete_id'])}, {lit(f['fighter_id'])}::uuid, null);")
    # combat_ingest_packets only accepts approved_ingest sources (combat_guard_fact_source);
    # these are canonical-UFC ingest packets, evidence named inside the payload.
    packet_src = "(select id from public.combat_sources where source_key = 'ufc_canonical')"
    ev = u1["event"]
    pk_event = {k: ev[k] for k in ("name", "event_date", "ufcstats_id", "espn_event_id", "city", "region", "country", "location_raw")}
    packets = [("event", f"legacy-origins:ufc1:event", ev["espn_event_id"], ev["source_url"], pk_event)]
    for b in u1["bouts"]:
        packets.append(("bout", f"legacy-origins:ufc1:bout:{b['espn_competition_id']}", b["espn_competition_id"], b["espn_source_url"], b))
    for f in u1["fighters"]:
        if f["resolver_status"] != "matched":
            packets.append(("fighter", f"legacy-origins:ufc1:fighter:{f['espn_athlete_id']}", f["espn_athlete_id"],
                            f"https://sports.core.api.espn.com/v2/sports/mma/athletes/{f['espn_athlete_id']}", f))
    for ptype, key, ext, url, payload in packets:
        payload = {"evidence_sources": ["espn_core", "ufcstats_wayback_capture"], "plan_sha256": plan_sha, "record": payload}
        body = json.dumps(payload, sort_keys=True)
        add(f"insert into public.combat_ingest_packets (source_id, ingest_key, packet_type, external_id, source_url, payload, payload_sha256, validation_state, fetched_at) "
            f"values ({packet_src}, {lit(key)}, {lit(ptype)}, {lit(ext)}, {lit(url)}, {lit(body)}::jsonb, {lit(hashlib.sha256(body.encode()).hexdigest())}, 'validated', '2026-09-12T00:00:00Z');")
    for f in u1["fighters"]:
        if f["resolver_status"] == "matched":
            continue
        ctx = {"reason": "legacy_origins_no_candidate", "event": "UFC 1: The Beginning", "espn_athlete_id": f["espn_athlete_id"],
               "ufcstats_id": f["ufcstats_id"], "dob": f["dob"], "resolver_status": f["resolver_status"], "candidates": f["candidates"],
               "plan_sha256": plan_sha, "evidence": [f"https://sports.core.api.espn.com/v2/sports/mma/athletes/{f['espn_athlete_id']}", u1["evidence"]["ufcstats_capture"]["url"]]}
        add(f"with q as (insert into public.ufc_alias_review_queue (raw_name, source, candidate_fighter_ids, context) values ({lit(f['espn_name'])}, 'legacy_origins_ufc1', '{{}}', {jlit(ctx)}) returning id) "
            f"update u1_fighter set review_id = (select id from q) where espn_athlete_id = {lit(f['espn_athlete_id'])};")
    add("-- SIMULATED operator resolution (proof only): mint the reviewed identities")
    for f in u1["fighters"]:
        if f["resolver_status"] == "matched":
            continue
        src = f"https://sports.core.api.espn.com/v2/sports/mma/athletes/{f['espn_athlete_id']}"
        add(f"with ins as (insert into public.ufc_fighters (ufcstats_id, espn_athlete_id, name, dob, source_url) values ({lit(f['ufcstats_id'])}, {lit(f['espn_athlete_id'])}, {lit(f['espn_name'])}, {lit(f['dob'])}::date, {lit(src)}) returning *), "
            f"led as (insert into public.ufc_legacy_repair_ledger (plan_sha256, step, table_name, row_key, operation, after_image, evidence, operator) select {P}, 'ufc1_ingest', 'ufc_fighters', jsonb_build_object('id', ins.id), 'insert', to_jsonb(ins), jsonb_build_object('review_id', (select review_id from u1_fighter where espn_athlete_id = {lit(f['espn_athlete_id'])})), {lit(OPERATOR)} from ins) "
            f"update u1_fighter set fighter_id = (select id from ins) where espn_athlete_id = {lit(f['espn_athlete_id'])};")
    add("update public.ufc_alias_review_queue q set status = 'resolved', resolved_fighter_id = u.fighter_id, resolved_at = now() from u1_fighter u where q.id = u.review_id;")
    add(f"""with ins as (insert into public.ufc_events (ufcstats_id, espn_event_id, name, event_date, city, region, country, location_raw, card_status, source_url)
  values ({lit(ev['ufcstats_id'])}, {lit(ev['espn_event_id'])}, {lit(ev['name'])}, {lit(ev['event_date'])}::date, {lit(ev['city'])}, {lit(ev['region'])}, {lit(ev['country'])}, {lit(ev['location_raw'])}, 'complete', {lit(ev['source_url'])}) returning *)
insert into public.ufc_legacy_repair_ledger (plan_sha256, step, table_name, row_key, operation, after_image, operator)
select {P}, 'ufc1_ingest', 'ufc_events', jsonb_build_object('id', id), 'insert', to_jsonb(ins), {lit(OPERATOR)} from ins;""")
    ufc1_event = f"(select id from public.ufc_events where ufcstats_id = {lit(ev['ufcstats_id'])})"
    for b in u1["bouts"]:
        fa = f"(select fighter_id from u1_fighter where espn_athlete_id = {lit(b['fighter_a_espn'])})"
        fb = f"(select fighter_id from u1_fighter where espn_athlete_id = {lit(b['fighter_b_espn'])})"
        fw = f"(select fighter_id from u1_fighter where espn_athlete_id = {lit(b['winner_espn'])})"
        s = b["semantics"]
        add(f"""with ins as (insert into public.ufc_bouts (ufcstats_id, espn_competition_id, event_id, fighter_a_id, fighter_b_id, weight_class, weight_class_raw, is_title, bout_order, status, source_url)
  values ({lit(b['ufcstats_fight_id'])}, {lit(b['espn_competition_id'])}, {ufc1_event}, {fa}, {fb}, 'OPEN', {lit(b['weight_class_raw'])}, {lit(b['is_title_raw'])}, {b['bout_order']}, 'complete', {lit(b['espn_source_url'])}) returning *),
res as (insert into public.ufc_bout_results (bout_id, winner_id, method, method_raw, round, time_sec, time_format, referee, finish_detail, result_source, has_stats, source_url,
                                             period_structure, ending_period_kind, ending_period_number, elapsed_fight_sec, period_semantics_basis, period_semantics_version)
  select ins.id, {fw}, {lit(b['method'])}, {lit(b['method_raw'])}, {b['round_raw']}, {b['time_sec']}, {lit(b['time_format'])}, null, {lit(b['finish_detail'])}, 'espn', false, {lit(b['espn_source_url'])},
         {lit(s[0])}, {lit(s[1])}, {s[2]}, {s[3]}, {lit(s[4])}, 1 from ins returning *),
l1 as (insert into public.ufc_legacy_repair_ledger (plan_sha256, step, table_name, row_key, operation, after_image, evidence, operator)
  select {P}, 'ufc1_ingest', 'ufc_bouts', jsonb_build_object('id', id), 'insert', to_jsonb(ins), jsonb_build_object('corroboration', {lit(b['ufcstats_source_url'])}), {lit(OPERATOR)} from ins)
insert into public.ufc_legacy_repair_ledger (plan_sha256, step, table_name, row_key, operation, after_image, evidence, operator)
  select {P}, 'ufc1_ingest', 'ufc_bout_results', jsonb_build_object('bout_id', bout_id), 'insert', to_jsonb(res), jsonb_build_object('referee', 'withheld: conflict ufc1-referee'), {lit(OPERATOR)} from res;""")

    # claims helper
    def claim(event_sql, bout_sql, key, raw, norm, url, locator, conflict_group, conflict_state, notes):
        h = f"encode(sha256(convert_to(concat_ws('|', {event_sql}::text, coalesce({bout_sql}::text, ''), {lit(key)}, {lit(raw)}, 'espn', {lit(url)}, {lit(locator)}), 'UTF8')), 'hex')"
        return (f"insert into public.ufc_event_fact_claims (event_id, bout_id, fact_key, raw_value, normalized_value, source_id, source_type, source_tier, source_name, source_url, source_locator, captured_at, conflict_group, conflict_state, notes, claim_hash) "
                f"values ({event_sql}, {bout_sql}, {lit(key)}, {lit(raw)}, {jlit(norm) if norm is not None else 'null'}, null, 'espn', 2, 'ESPN core API', {lit(url)}, {lit(locator)}, '2026-09-12T00:00:00Z', {lit(conflict_group)}, {lit(conflict_state)}, {lit(notes)}, {h});")

    for b in u1["bouts"]:
        bout_sql = f"(select id from public.ufc_bouts where espn_competition_id = {lit(b['espn_competition_id'])})"
        for ref in b["espn_referee"]:
            add(claim(ufc1_event, bout_sql, "referee", ref, {"name": ref}, b["espn_source_url"] + "/officials", "espn_ufc1/manifest.json",
                      "ufc1-referee", "open", "ESPN/UFCStats lineage lists this referee for every UFC 1 bout; a secondary source splits the card between two referees. Not resolved."))
    add(claim(ufc1_event, "null", "venue_name", ev["venue_claim"], None, ev["source_url"], "espn_ufc1/leagues_ufc_venues_2549.json",
              None, "none", "ESPN venue document. ESPN renders a venue's current name."))

    # ---- step 4: period semantics ----
    add("create temp table plan_semantics (bout_id uuid primary key, period_structure text, ending_period_kind text, ending_period_number smallint, elapsed_fight_sec int, basis text) on commit drop;")
    rows = [f"({lit(c['bout_id'])}::uuid, {lit(c['period_structure'])}, {lit(c['ending_period_kind'])}, {c['ending_period_number']}, {c['elapsed_fight_sec']}, {lit(c['period_semantics_basis'])})" for c in sem["changes"]]
    for i in range(0, len(rows), 200):
        add("insert into plan_semantics values " + ",\n".join(rows[i:i + 200]) + ";")
    add(f"""with before as (
  select r.bout_id, jsonb_build_object('period_structure', r.period_structure, 'ending_period_kind', r.ending_period_kind, 'ending_period_number', r.ending_period_number, 'elapsed_fight_sec', r.elapsed_fight_sec) as img
  from public.ufc_bout_results r join plan_semantics p on p.bout_id = r.bout_id),
upd as (
  update public.ufc_bout_results r set period_structure = p.period_structure, ending_period_kind = p.ending_period_kind,
         ending_period_number = p.ending_period_number, elapsed_fight_sec = p.elapsed_fight_sec,
         period_semantics_basis = p.basis, period_semantics_version = 1
  from plan_semantics p where p.bout_id = r.bout_id and r.period_structure is null
  returning r.bout_id, r.period_structure, r.ending_period_kind, r.ending_period_number, r.elapsed_fight_sec)
insert into public.ufc_legacy_repair_ledger (plan_sha256, step, table_name, row_key, operation, before_image, after_image, operator)
select {P}, 'period_semantics', 'ufc_bout_results', jsonb_build_object('bout_id', upd.bout_id), 'update', b.img, to_jsonb(upd), {lit(OPERATOR)}
from upd join before b on b.bout_id = upd.bout_id;""")

    # ---- step 5: ESPN event ids + venue claims ----
    add("create temp table plan_espn_ids (event_id uuid primary key, espn_event_id text not null) on commit drop;")
    add("insert into plan_espn_ids values " + ",\n".join(f"({lit(x['event_id'])}::uuid, {lit(x['espn_event_id'])})" for x in ids["espn_event_id_updates"]) + ";")
    add(f"""with before as (select e.id, e.espn_event_id from public.ufc_events e join plan_espn_ids p on p.event_id = e.id),
upd as (update public.ufc_events e set espn_event_id = p.espn_event_id from plan_espn_ids p where p.event_id = e.id and e.espn_event_id is null returning e.id, e.espn_event_id)
insert into public.ufc_legacy_repair_ledger (plan_sha256, step, table_name, row_key, operation, before_image, after_image, operator)
select {P}, 'event_ids_venue', 'ufc_events', jsonb_build_object('id', upd.id), 'update', jsonb_build_object('espn_event_id', b.espn_event_id), jsonb_build_object('espn_event_id', upd.espn_event_id), {lit(OPERATOR)}
from upd join before b on b.id = upd.id;""")
    for v in ids["venue_claims"]:
        if not v["venue_name_raw"]:
            continue
        add(claim(f"{lit(v['event_id'])}::uuid", "null", "venue_name", v["venue_name_raw"], {"address": v["address"]} if v["address"] else None,
                  f"https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/{v['espn_event_id']}", v["source_locator"], None, "none",
                  "ESPN competition venue. ESPN renders a venue's current name; not a historical name without corroboration."))

    # ---- assertions ----
    def check(name, cond_sql, detail_sql="null"):
        add(f"insert into proof (name, ok, detail) select {lit(name)}, coalesce(({cond_sql}), false), ({detail_sql})::text;")

    n_changes = len(sem["changes"])
    n_ufc1 = len(u1["bouts"])
    n_new = len([f for f in u1["fighters"] if f["resolver_status"] != "matched"])
    n_ids = len(ids["espn_event_id_updates"])
    n_venue = len([v for v in ids["venue_claims"] if v["venue_name_raw"]]) + 1

    add("-- schema")
    check("new tables exist (7)", "(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(array[" + ",".join(lit(t) for t in NEW_TABLES) + "])) = 7")
    check("new result columns exist (6)", "(select count(*) from information_schema.columns where table_schema='public' and table_name='ufc_bout_results' and column_name in ('period_structure','ending_period_kind','ending_period_number','elapsed_fight_sec','period_semantics_basis','period_semantics_version')) = 6")
    check("new bout columns exist (10)", "(select count(*) from information_schema.columns where table_schema='public' and table_name='ufc_bouts' and column_name in ('ruleset_id','ruleset_basis','historical_weight_limit_text','historical_weight_min_lbs','historical_weight_max_lbs','historical_limit_basis','historical_division_label','title_kind','title_label_raw','historical_semantics_evidence')) = 10")
    for fmt, st, secs, ot in [("No Time Limit", "untimed", None, 0), ("1 Rnd (20)", "single_period", [1200], 0), ("1 Rnd + OT (12-3)", "regulation_overtime", [720, 180], 1),
                              ("1 Rnd + 2OT (15-3-3)", "regulation_overtime", [900, 180, 180], 2), ("1 Rnd + OT (31-5)", "regulation_overtime", [1860, 300], 1),
                              ("2 Rnd (5-5)", "rounds", [300, 300], 0), ("3 Rnd (5-5-5)", "rounds", [300, 300, 300], 0), ("5 Rnd (5-5-5-5-5)", "rounds", [300] * 5, 0),
                              ("3 Rnd + OT (5-5-5-5)", "unparsed", None, None), ("Round 1", "unparsed", None, None), ("", "unparsed", None, None)]:
        secs_sql = "null::int[]" if secs is None else "array[" + ",".join(map(str, secs)) + "]"
        check(f"parser: {fmt!r} -> {st}", f"(select structure = {lit(st)} and period_secs is not distinct from {secs_sql} and overtime_count is not distinct from {lit(ot)}::int from public.ufc_time_format_structure({lit(fmt)}))",
              f"(select structure || ' ' || coalesce(period_secs::text,'-') || ' ot=' || coalesce(overtime_count::text,'-') from public.ufc_time_format_structure({lit(fmt)}))")

    add("-- privileges")
    for t in NEW_TABLES:
        check(f"anon has no privilege on {t}", f"not has_table_privilege('anon', 'public.{t}', 'select') and not has_table_privilege('anon', 'public.{t}', 'insert') and not has_table_privilege('authenticated', 'public.{t}', 'select')")
        check(f"service_role cannot delete/truncate {t}", f"not has_table_privilege('service_role', 'public.{t}', 'delete') and not has_table_privilege('service_role', 'public.{t}', 'truncate')")
    for v in ("ufc_bout_round_stats_periods", "ufc_event_fact_display"):
        check(f"view {v} is security_invoker and closed to anon", f"(select coalesce(reloptions::text like '%security_invoker=true%', false) from pg_class where oid = 'public.{v}'::regclass) and not has_table_privilege('anon', 'public.{v}', 'select')")

    add("-- raw preservation")
    check("ufc_bout_results raw columns unchanged for every pre-existing row",
          f"(select md5(string_agg(concat_ws('|', bout_id, winner_id, method, method_raw, round, time_sec, time_format, referee, judge_1, judge_2, judge_3, scorecards::text, finish_detail, result_source, has_stats, source_url, stats_source_url), '~' order by bout_id)) from public.ufc_bout_results where bout_id not in (select b.id from public.ufc_bouts b where b.event_id = {ufc1_event})) = (select results_raw_md5 from proof_before)")
    check("ufc_bouts raw columns unchanged for every pre-existing row",
          f"(select md5(string_agg(concat_ws('|', id, ufcstats_id, espn_competition_id, event_id, fighter_a_id, fighter_b_id, weight_class, weight_class_raw, is_womens, is_title, scheduled_rounds, card_position, bout_order, status, source_url), '~' order by id)) from public.ufc_bouts where event_id <> {ufc1_event}) = (select bouts_raw_md5 from proof_before)")
    check("ufc_events raw columns unchanged except espn_event_id null fills",
          f"(select md5(string_agg(concat_ws('|', id, ufcstats_id, name, event_date, venue, city, region, country, location_raw, commission, is_ppv, card_status, source_url), '~' order by id)) from public.ufc_events where id <> {ufc1_event}) = (select events_raw_md5 from proof_before)")
    check("ufc_bout_round_stats unchanged", "(select md5(string_agg(concat_ws('|', bout_id, fighter_id, round, kd, sig_str_landed, sig_str_att, total_str_landed, ctrl_sec), '~' order by bout_id, fighter_id, round)) from public.ufc_bout_round_stats) = (select round_stats_md5 from proof_before)")
    check("ufc_videos rows unchanged", "(select md5(string_agg(concat_ws('|', id, provider, provider_video_id, video_type, link_status), '~' order by id)) from public.ufc_videos) = (select videos_md5 from proof_before)")

    add("-- step 3: UFC 1")
    check("UFC 1: exactly one event row", f"(select count(*) from public.ufc_events where ufcstats_id = {lit(ev['ufcstats_id'])} or espn_event_id = {lit(ev['espn_event_id'])}) = 1")
    check(f"UFC 1: {n_ufc1} bouts and {n_ufc1} results", f"(select count(*) from public.ufc_bouts where event_id = {ufc1_event}) = {n_ufc1} and (select count(*) from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id where b.event_id = {ufc1_event}) = {n_ufc1}")
    check("UFC 1: every winner is one of the two corners", f"(select count(*) from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id where b.event_id = {ufc1_event} and r.winner_id not in (b.fighter_a_id, b.fighter_b_id)) = 0")
    appear = u1["appearances"]
    check("UFC 1: fighter appearances match the bracket (Gracie 3, Gordeau 3, Shamrock 2, Rosier 2, others 1)",
          f"(select bool_and(n = case f.name when 'Royce Gracie' then 3 when 'Gerard Gordeau' then 3 when 'Ken Shamrock' then 2 when 'Kevin Rosier' then 2 else 1 end) from (select x.fid, count(*) n from public.ufc_bouts b cross join lateral (values (b.fighter_a_id), (b.fighter_b_id)) x(fid) where b.event_id = {ufc1_event} group by x.fid) c join public.ufc_fighters f on f.id = c.fid)",
          f"(select string_agg(f.name || '=' || n, ', ' order by f.name) from (select x.fid, count(*) n from public.ufc_bouts b cross join lateral (values (b.fighter_a_id), (b.fighter_b_id)) x(fid) where b.event_id = {ufc1_event} group by x.fid) c join public.ufc_fighters f on f.id = c.fid)")
    check("UFC 1: Royce Gracie wins the final (highest bout_order) by submission at 1:44",
          f"(select f.name = 'Royce Gracie' and r.method = 'SUB' and r.time_sec = 104 from public.ufc_bouts b join public.ufc_bout_results r on r.bout_id = b.id join public.ufc_fighters f on f.id = r.winner_id where b.event_id = {ufc1_event} order by b.bout_order desc limit 1)")
    check("UFC 1: no result presented as a round (all untimed/whole_fight)", f"(select bool_and(r.period_structure = 'untimed' and r.ending_period_kind = 'whole_fight' and r.elapsed_fight_sec = r.time_sec) from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id where b.event_id = {ufc1_event})")
    check("UFC 1: referee withheld (conflict open, 8 ESPN claims)", f"(select count(*) from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id where b.event_id = {ufc1_event} and r.referee is not null) = 0 and (select count(*) from public.ufc_event_fact_claims where event_id = {ufc1_event} and fact_key = 'referee' and conflict_state = 'open') = 8")
    check(f"fighters: exactly {n_new} new rows", f"(select count(*) from public.ufc_fighters) = (select fighters_n from proof_before) + {n_new}")
    for f in u1["fighters"]:
        if f["resolver_status"] != "matched":
            nm = f["espn_name"]
            check(f"no duplicate canonical fighter: {nm}", f"(select count(*) from public.ufc_fighters where lower(regexp_replace(name, '[^A-Za-z]', '', 'g')) = lower(regexp_replace({lit(nm)}, '[^A-Za-z]', '', 'g'))) = 1",
                  f"(select string_agg(id::text, ',') from public.ufc_fighters where lower(regexp_replace(name, '[^A-Za-z]', '', 'g')) = lower(regexp_replace({lit(nm)}, '[^A-Za-z]', '', 'g')))")
    check("no duplicate espn_athlete_id / ufcstats_id anywhere", "(select count(*) from (select espn_athlete_id from public.ufc_fighters where espn_athlete_id is not null group by 1 having count(*) > 1) d) = 0 and (select count(*) from (select ufcstats_id from public.ufc_fighters where ufcstats_id is not null group by 1 having count(*) > 1) d) = 0")
    check(f"review queue: {n_new} rows created and resolved to the minted fighters", f"(select count(*) from public.ufc_alias_review_queue where source = 'legacy_origins_ufc1' and status = 'resolved' and resolved_fighter_id is not null) = {n_new} and (select count(*) from public.ufc_alias_review_queue) = (select review_n from proof_before) + {n_new}")
    check(f"packets: {len(packets)} validated legacy-origins packets", f"(select count(*) from public.combat_ingest_packets where ingest_key like 'legacy-origins:ufc1:%' and validation_state = 'validated') = {len(packets)}")
    check("matched UFC 1 corners reuse existing canonical ids", "(select count(*) from u1_fighter where fighter_id is null) = 0")

    add("-- step 4: semantics")
    check(f"semantics: {n_changes} legacy rows updated, equal to the plan row by row",
          f"(select count(*) from public.ufc_bout_results r join plan_semantics p using (bout_id) where r.period_structure = p.period_structure and r.ending_period_kind = p.ending_period_kind and r.ending_period_number = p.ending_period_number and r.elapsed_fight_sec = p.elapsed_fight_sec) = {n_changes}")
    check("semantics: the SQL parser agrees with the Python plan on every legacy row",
          "(select count(*) from public.ufc_bout_results r join plan_semantics p using (bout_id) cross join lateral public.ufc_time_format_structure(r.time_format) s where s.structure <> p.period_structure) = 0")
    check("semantics: every pre-2005 result is interpreted (none left null)", "(select count(*) from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id join public.ufc_events e on e.id = b.event_id where e.event_date <= '2004-12-31' and r.period_structure is null) = 0")
    check("semantics: no post-2004 row touched", "(select count(*) from public.ufc_bout_results r join public.ufc_bouts b on b.id = r.bout_id join public.ufc_events e on e.id = b.event_id where e.event_date > '2004-12-31' and r.period_structure is not null) = 0")
    check("semantics: 'No Time Limit' is never a round", "(select count(*) from public.ufc_bout_results where time_format = 'No Time Limit' and (ending_period_kind <> 'whole_fight' or period_structure <> 'untimed')) = 0")
    check("semantics: overtime-format raw round 2/3 reads as overtime 1/2", "(select count(*) from public.ufc_bout_results where time_format like '%OT%' and round > 1 and (ending_period_kind <> 'overtime' or ending_period_number <> round - 1)) = 0")
    check("round-stat view: legacy rows labelled; 'Round n' only where the result has rounds",
          "(select count(*) from public.ufc_bout_round_stats_periods v where v.period_structure is not null and v.period_structure <> 'rounds' and v.period_label like 'Round %') = 0",
          "(select string_agg(k || '=' || n, ', ') from (select coalesce(period_kind,'(uninterpreted)') k, count(*) n from public.ufc_bout_round_stats_periods group by 1) x)")
    check("round-stat view row count equals base table", "(select count(*) from public.ufc_bout_round_stats_periods) = (select count(*) from public.ufc_bout_round_stats)")
    check(f"ledger: {n_changes} period_semantics updates with before images", f"(select count(*) from public.ufc_legacy_repair_ledger where step = 'period_semantics' and operation = 'update' and before_image is not null) = {n_changes}")

    add("-- step 5: ids + claims")
    check(f"ESPN event ids: {n_ids} null fills, all unique", f"(select count(*) from public.ufc_legacy_repair_ledger where step = 'event_ids_venue' and before_image->>'espn_event_id' is null) = {n_ids} and (select count(*) from (select espn_event_id from public.ufc_events where espn_event_id is not null group by 1 having count(*) > 1) d) = 0")
    check("every legacy event now carries an ESPN id", "(select count(*) from public.ufc_events where event_date <= '2004-12-31' and espn_event_id is null) = 0")
    check("ufc_events.venue untouched (claims only)", "(select count(*) from public.ufc_events where event_date <= '2004-12-31' and venue is not null) = 0")
    check(f"venue claims: {n_venue} ESPN tier-2 claims", f"(select count(*) from public.ufc_event_fact_claims where fact_key = 'venue_name' and source_type = 'espn' and source_tier = 2) = {n_venue}")
    check("no claim from promotion material", "(select count(*) from public.ufc_event_fact_claims where source_type = 'promotion_official') = 0")

    add("-- step 6: judges")
    check("judge fields: every polluted legacy judge string resolves through ufc_judge_aliases",
          "(select count(*) from public.ufc_bout_scorecards s join public.ufc_bouts b on b.id = s.bout_id join public.ufc_events e on e.id = b.event_id where e.event_date <= '2004-12-31' and s.raw_judge_name ~* '\\m(by|illegal)\\M' and s.judge_name = s.raw_judge_name) = 0",
          "(select string_agg(s.raw_judge_name || ' -> ' || s.judge_name, '; ') from public.ufc_bout_scorecards s join public.ufc_bouts b on b.id = s.bout_id join public.ufc_events e on e.id = b.event_id where e.event_date <= '2004-12-31' and s.raw_judge_name ~* '\\m(by|illegal)\\M')")

    add("-- compatibility: dependent views and the web's column lists")
    for v, key in [("ufc_bout_scorecards", "v_scorecards"), ("ufc_judge_bouts", "v_judge_bouts"), ("ufc_judge_stats", "v_judge_stats"),
                   ("ufc_scorecard_coverage", "v_scorecard_coverage"), ("ufc_scorecard_gaps", "v_scorecard_gaps"), ("ufc_weigh_in_current", "v_weigh_in_current"),
                   ("ufc_referee_bouts", "v_referee_bouts"), ("ufc_referee_stats", "v_referee_stats"), ("combat_career_bouts", "v_career_bouts")]:
        check(f"view {v} still selects", f"(select count(*) from public.{v}) >= 0",
              f"(select 'before=' || (select {key} from proof_before) || ' after=' || (select count(*) from public.{v}))")
    check("web RESULT_COLS select still valid", "(select count(*) from (select bout_id,winner_id,method,method_raw,round,time_sec,time_format,referee,finish_detail,result_source,has_stats,scorecards,judge_1,judge_2,judge_3,source_url from public.ufc_bout_results limit 1) x) >= 0")

    add("-- guards (each expected failure runs in its own subtransaction)")
    ufc2 = "(select id from public.ufc_events where name like 'UFC 2:%' limit 1)"
    ufc2_bout = "(select b.id from public.ufc_bouts b join public.ufc_events e on e.id = b.event_id where e.name like 'UFC 2:%' order by b.bout_order desc limit 1)"
    ufc3_bout = "(select b.id from public.ufc_bouts b join public.ufc_events e on e.id = b.event_id where e.name like 'UFC 3:%' limit 1)"
    gracie = "(select id from public.ufc_fighters where name = 'Royce Gracie' limit 1)"
    smith = "(select id from public.ufc_fighters where name = 'Patrick Smith' limit 1)"
    add(f"""do $g$
declare v_claim uuid; v_rival uuid; v_t uuid; v_e1 uuid; v_e2 uuid; v_ok boolean;
begin
  insert into public.ufc_event_fact_claims (event_id, fact_key, raw_value, source_type, source_tier, source_name, source_locator, captured_at, claim_hash)
    values ({ufc2}, 'attendance', '2000', 'promotion_official', 3, 'guard fixture', 'fixture', now(), 'guard-fixture-promo') returning id into v_claim;
  insert into public.ufc_event_fact_claims (event_id, fact_key, raw_value, source_type, source_tier, source_name, source_locator, captured_at, claim_hash)
    values ({ufc2}, 'attendance', '3000', 'curated_secondary', 4, 'guard fixture', 'fixture', now(), 'guard-fixture-rival') returning id into v_rival;

  begin delete from public.ufc_event_fact_claims where id = v_claim; insert into proof(name, ok) values ('guard: claim delete refused', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: claim delete refused', true, sqlerrm); end;

  begin update public.ufc_event_fact_claims set raw_value = '9999' where id = v_claim; insert into proof(name, ok) values ('guard: claim raw_value is immutable', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: claim raw_value is immutable', true, sqlerrm); end;

  begin update public.ufc_event_fact_claims set verification_status = 'disputed', conflict_group = 'fixture', conflict_state = 'open' where id = v_claim; insert into proof(name, ok) values ('guard: claim review state may change', true);
  exception when others then insert into proof(name, ok, detail) values ('guard: claim review state may change', false, sqlerrm); end;

  begin insert into public.ufc_event_fact_resolutions (event_id, fact_key, selected_claim_id, resolution_rule, resolved_by) values ({ufc2}, 'attendance', v_claim, 'highest_tier', 'fixture');
        insert into proof(name, ok) values ('guard: promotion claim cannot win against a disagreeing claim', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: promotion claim cannot win against a disagreeing claim', true, sqlerrm); end;

  begin insert into public.ufc_event_fact_resolutions (event_id, fact_key, selected_claim_id, resolution_rule, resolved_by) values ({ufc2}, 'venue_name', v_rival, 'highest_tier', 'fixture');
        insert into proof(name, ok) values ('guard: resolution must select a claim for the same fact', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: resolution must select a claim for the same fact', true, sqlerrm); end;

  begin insert into public.ufc_event_fact_claims (event_id, fact_key, raw_value, source_type, source_tier, source_name, source_locator, captured_at, claim_hash)
          values ({ufc2}, 'attendance', '1', 'promotion_official', 2, 'guard fixture', 'fixture', now(), 'guard-fixture-tier');
        insert into proof(name, ok) values ('guard: promotion material cannot be tier 2', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: promotion material cannot be tier 2', true, sqlerrm); end;

  insert into public.ufc_tournaments (tournament_key, event_id, name, bracket_size, completeness, source_tier) values ('guard-fixture-ufc-2', {ufc2}, 'fixture', 16, 'partial', 5) returning id into v_t;
  insert into public.ufc_tournament_entries (tournament_id, fighter_id, raw_name, entry_role) values (v_t, {gracie}, 'Royce Gracie', 'entrant') returning id into v_e1;
  insert into public.ufc_tournament_entries (tournament_id, fighter_id, raw_name, entry_role) values (v_t, {smith}, 'Patrick Smith', 'entrant') returning id into v_e2;

  begin insert into public.ufc_tournament_advancements (tournament_id, stage, entry_id, advancement_kind, bout_id, source_tier) values (v_t, 'semifinal', v_e1, 'bye', {ufc2_bout}, 5);
        insert into proof(name, ok) values ('guard: a bye cannot carry a bout', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: a bye cannot carry a bout', true, sqlerrm); end;

  begin insert into public.ufc_tournament_advancements (tournament_id, stage, entry_id, advancement_kind, bout_id, source_tier) values (v_t, 'semifinal', v_e1, 'bye', null, 5);
        insert into proof(name, ok) values ('guard: a bye with no bout is accepted', true);
  exception when others then insert into proof(name, ok, detail) values ('guard: a bye with no bout is accepted', false, sqlerrm); end;

  begin insert into public.ufc_tournament_advancements (tournament_id, stage, entry_id, advancement_kind, bout_id, source_tier) values (v_t, 'final', v_e1, 'bout_win', null, 5);
        insert into proof(name, ok) values ('guard: a bout_win must name its bout', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: a bout_win must name its bout', true, sqlerrm); end;

  begin insert into public.ufc_tournament_advancements (tournament_id, stage, entry_id, opponent_entry_id, advancement_kind, bout_id, source_tier) values (v_t, 'final', v_e1, v_e2, 'bout_win', {ufc3_bout}, 5);
        insert into proof(name, ok) values ('guard: advancement bout must be on the tournament event', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: advancement bout must be on the tournament event', true, sqlerrm); end;

  begin insert into public.ufc_tournament_advancements (tournament_id, stage, entry_id, advancement_kind, source_tier) values (v_t, 'semifinal', v_e2, 'withdrawal_replacement', 5);
        insert into proof(name, ok) values ('guard: a replacement must name who it replaces', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: a replacement must name who it replaces', true, sqlerrm); end;

  begin insert into public.ufc_tournament_entries (tournament_id, raw_name, entry_role) values (v_t, 'Nobody', 'alternate');
        insert into proof(name, ok) values ('guard: an entry needs a canonical fighter or a review row', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: an entry needs a canonical fighter or a review row', true, sqlerrm); end;

  begin update public.ufc_bout_results set ending_period_kind = 'round' where bout_id = (select r.bout_id from public.ufc_bout_results r where r.period_structure = 'untimed' limit 1);
        insert into proof(name, ok) values ('guard: an untimed result cannot be relabelled a round', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: an untimed result cannot be relabelled a round', true, sqlerrm); end;

  begin update public.ufc_bout_results set ending_period_kind = null where bout_id = (select r.bout_id from public.ufc_bout_results r where r.period_structure = 'untimed' limit 1);
        insert into proof(name, ok) values ('guard: an interpretation cannot be half-filled (NULL kind)', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: an interpretation cannot be half-filled (NULL kind)', true, sqlerrm); end;

  begin update public.ufc_bout_results set ending_period_kind = 'regulation_period', ending_period_number = 2 where bout_id = (select r.bout_id from public.ufc_bout_results r where r.period_structure = 'regulation_overtime' limit 1);
        insert into proof(name, ok) values ('guard: regulation is period 1 only', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: regulation is period 1 only', true, sqlerrm); end;

  begin update public.ufc_bouts set historical_weight_max_lbs = 199 where id = {ufc2_bout};
        insert into proof(name, ok) values ('guard: a normalized weight limit needs a stated basis', false);
  exception when others then insert into proof(name, ok, detail) values ('guard: a normalized weight limit needs a stated basis', true, sqlerrm); end;

end
$g$;""")

    add("select jsonb_build_object('passed', (select count(*) from proof where ok), 'failed', (select count(*) from proof where not ok), "
        "'lock_wait_ms', null, 'assertions', (select jsonb_agg(jsonb_build_object('name', name, 'ok', ok, 'detail', detail) order by seq) from proof)) as proof;")
    add("rollback;")
    return "\n".join(sql)


POST_CHECK = """select jsonb_build_object(
  'tables_left', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any(array[{tables}])),
  'result_columns_left', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'ufc_bout_results' and column_name in ('period_structure','ending_period_kind','elapsed_fight_sec')),
  'bout_columns_left', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'ufc_bouts' and column_name in ('ruleset_id','title_kind','historical_weight_limit_text')),
  'function_left', to_regprocedure('public.ufc_time_format_structure(text)') is not null,
  'views_left', (select count(*) from pg_class where relname in ('ufc_bout_round_stats_periods','ufc_event_fact_display')),
  'ufc1_event_left', (select count(*) from public.ufc_events where ufcstats_id = '6420efac0578988b' or espn_event_id = '400255729'),
  'legacy_events_with_espn_id', (select count(*) from public.ufc_events where event_date <= '2004-12-31' and espn_event_id is not null),
  'review_rows_left', (select count(*) from public.ufc_alias_review_queue where source = 'legacy_origins_ufc1'),
  'packets_left', (select count(*) from public.combat_ingest_packets where ingest_key like 'legacy-origins:%'),
  'source_rows_left', (select count(*) from public.combat_sources where source_key in ('nsac','nj_sacb','pbe_legacy_curated')),
  'video_type_check_has_event_replay', (select pg_get_constraintdef(oid) like '%event_replay%' from pg_constraint where conname = 'ufc_videos_video_type_check')
) as post_rollback;"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--build-only", action="store_true")
    args = ap.parse_args()
    plan_path = pathlib.Path(args.plan)
    plan_bytes = plan_path.read_bytes()
    plan_sha = hashlib.sha256(plan_bytes).hexdigest()
    recorded = (plan_path.parent / "first_repair_plan.sha256").read_text().strip()
    if plan_sha != recorded:
        raise SystemExit(f"plan hash {plan_sha} != recorded {recorded}")
    plan = json.loads(plan_bytes)
    sql = build(plan, plan_sha)
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "first_repair_proof.sql").write_text(sql, encoding="utf-8")
    print(f"proof sql: {len(sql):,} chars, plan {plan_sha}")
    if args.build_only:
        return 0

    token = cli_token()
    result = run_sql(token, sql)
    post = run_sql(token, POST_CHECK.format(tables=",".join(f"'{t}'" for t in NEW_TABLES)))
    report = {"plan_sha256": plan_sha, "migration": MIGRATION.name,
              "migration_sha256": hashlib.sha256(MIGRATION.read_bytes()).hexdigest(),
              "proof": result, "post_rollback": post}
    (out / "first_repair_proof_result.json").write_text(json.dumps(report, indent=1), encoding="utf-8")

    if isinstance(result, dict) and result.get("error"):
        print(json.dumps(result, indent=1))
        return 2
    proof = result[0]["proof"]
    pr = post[0]["post_rollback"]
    for a in proof["assertions"]:
        print(("PASS " if a["ok"] else "FAIL ") + a["name"] + (f"  [{a['detail']}]" if a["detail"] and (not a["ok"] or "view " in a["name"] or "appearances" in a["name"] or "round-stat" in a["name"]) else ""))
    print(f"\npassed={proof['passed']} failed={proof['failed']}")
    print("post-rollback:", json.dumps(pr))
    clean = (pr["tables_left"] == 0 and pr["result_columns_left"] == 0 and pr["bout_columns_left"] == 0 and not pr["function_left"]
             and pr["views_left"] == 0 and pr["ufc1_event_left"] == 0 and pr["legacy_events_with_espn_id"] == 0
             and pr["review_rows_left"] == 0 and pr["packets_left"] == 0 and pr["source_rows_left"] == 0 and not pr["video_type_check_has_event_replay"])
    print("ROLLBACK CLEAN" if clean else "ROLLBACK NOT CLEAN")
    return 0 if proof["failed"] == 0 and clean else 1


if __name__ == "__main__":
    sys.exit(main())
