#!/usr/bin/env python
"""
Post-migration verification for 001_ufc_phase1_core.sql, run through
PostgREST only (no database password, no SQL editor).

  python scripts/verify_migration.py --before <pre-migration OpenAPI snapshot> [--out docs/phase1_migration_check.md]

Checks:
  1. every expected ufc_* table is exposed with exactly the expected columns;
     no unexpected ufc_* table
  2. exposed non-UFC tables and their column sets are identical to the
     pre-migration OpenAPI snapshot
  3. the at-least-one-source check constraints reject an id-less fighter and
     event; the weight_class enum check rejects a bad value
  4. RLS proven behaviourally on ALL 12 tables: a service-role probe row is
     inserted into every table through one FK-valid graph, then
       - service role sees the probe
       - anon does not see the probe (0 rows or 401/403)
       - anon insert is rejected (401/403)
       - anon delete affects 0 rows
  5. probes are deleted in FK-safe order and zero verify-* rows remain

Exit 0 only if every check passes. Writes a markdown report.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import uuid
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
URL = os.environ["SUPABASE_URL"].rstrip("/")
SVC = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ANON = os.environ.get("SUPABASE_ANON_KEY", "")

EXPECTED = {
    "ufc_fighters": {"id", "ufcstats_id", "espn_athlete_id", "name", "nickname", "dob", "height_in", "reach_in", "weight_lbs", "stance",
                     "record_w", "record_l", "record_d", "record_nc", "career_slpm", "career_str_acc", "career_sapm", "career_str_def",
                     "career_td_avg", "career_td_acc", "career_td_def", "career_sub_avg", "is_active", "fight_history_count",
                     "source_url", "captured_at", "updated_at"},
    "ufc_fighter_aliases": {"id", "fighter_id", "alias", "source", "normalized", "created_at"},
    "ufc_alias_review_queue": {"id", "raw_name", "source", "candidate_fighter_ids", "context", "status", "resolved_fighter_id", "created_at", "resolved_at"},
    "ufc_events": {"id", "ufcstats_id", "espn_event_id", "name", "event_date", "venue", "city", "region", "country", "location_raw",
                   "commission", "is_ppv", "card_status", "source_url", "captured_at", "updated_at"},
    "ufc_bouts": {"id", "ufcstats_id", "espn_competition_id", "event_id", "fighter_a_id", "fighter_b_id", "weight_class", "weight_class_raw",
                  "is_womens", "is_title", "scheduled_rounds", "card_position", "bout_order", "status", "replaced_bout_id",
                  "short_notice_days", "source_url", "captured_at", "updated_at"},
    "ufc_bout_results": {"bout_id", "winner_id", "method", "method_raw", "round", "time_sec", "time_format", "referee", "judge_1", "judge_2",
                         "judge_3", "scorecards", "finish_detail", "result_source", "has_stats", "source_url", "captured_at"},
    "ufc_bout_round_stats": {"bout_id", "fighter_id", "round", "kd", "sig_str_landed", "sig_str_att", "total_str_landed", "total_str_att",
                             "td_landed", "td_att", "sub_att", "rev", "ctrl_sec", "head_landed", "head_att", "body_landed", "body_att",
                             "leg_landed", "leg_att", "distance_landed", "distance_att", "clinch_landed", "clinch_att", "ground_landed",
                             "ground_att", "source_url", "captured_at"},
    "ufc_ingest_runs": {"id", "worker", "started_at", "finished_at", "events_new", "bouts_new", "fighters_touched", "assertion_failures", "status", "notes"},
    "ufc_news_sources": {"id", "kind", "url", "name", "weight", "enabled", "created_at"},
    "ufc_news_items": {"id", "source_id", "url", "title", "published_at", "summary", "taxonomy", "fighter_ids", "bout_id", "event_id", "fingerprint", "captured_at"},
    "ufc_articles": {"id", "slug", "headline", "dek", "body_md", "story_type", "status", "hero_image_ref", "hero_credit", "sources", "fact_block",
                     "fighter_ids", "bout_id", "event_id", "model_version", "needs_human", "published_at", "created_at", "updated_at"},
    "ufc_images": {"id", "kind", "r2_key", "license", "author", "source_url", "fighter_id", "created_at"},
}


def hdr(key, extra=None):
    h = {"apikey": key, "Content-Type": "application/json", "Accept": "application/json"}
    if key.startswith("eyJ"):
        h["Authorization"] = f"Bearer {key}"
    h.update(extra or {})
    return h


def rest(method, path, key, body=None, prefer=None):
    extra = {"Prefer": prefer} if prefer else None
    return requests.request(method, f"{URL}/rest/v1/{path}", headers=hdr(key, extra), timeout=60,
                            data=json.dumps(body) if body is not None else None)


results: list[tuple[str, bool, str]] = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))
    return bool(ok)


def insert_probe(table, body):
    r = rest("POST", table, SVC, body, prefer="return=representation")
    ok = r.status_code == 201 and isinstance(r.json(), list) and len(r.json()) == 1
    check(f"probe insert {table} (service role)", ok, f"HTTP {r.status_code} {r.text[:120] if not ok else ''}")
    return r.json()[0] if ok else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", default=os.environ.get("SCHEMA_BEFORE", ""))
    ap.add_argument("--out", default=str(ROOT / "docs" / "phase1_migration_check.md"))
    a = ap.parse_args()

    # ---- 1. tables + columns -------------------------------------------
    spec = rest("GET", "", SVC).json()
    paths = sorted(p.strip("/") for p in spec.get("paths", {}) if p != "/")
    defs = {k: set(v.get("properties", {}).keys()) for k, v in spec.get("definitions", {}).items()}
    ufc = [p for p in paths if p.startswith("ufc_")]
    for t, cols in EXPECTED.items():
        if t not in defs:
            check(f"table {t} exists", False, "missing")
            continue
        missing, extra = cols - defs[t], defs[t] - cols
        check(f"table {t} columns", not missing and not extra,
              f"missing={sorted(missing)} extra={sorted(extra)}" if (missing or extra) else f"{len(cols)} columns")
    check("no unexpected ufc_* tables", set(ufc) == set(EXPECTED), f"exposed={ufc}")

    # ---- 2. non-UFC exposed schema unchanged ----------------------------
    if a.before and Path(a.before).exists():
        before = json.load(open(a.before))
        b_paths = [p for p in before["paths"] if not p.startswith("ufc_")]
        n_paths = [p for p in paths if not p.startswith("ufc_")]
        check("non-UFC exposed table list unchanged", b_paths == n_paths,
              f"before={len(b_paths)} after={len(n_paths)} diff={sorted(set(b_paths) ^ set(n_paths))}")
        changed = [k for k, v in before["definitions"].items() if not k.startswith("ufc_") and set(v) != defs.get(k, set())]
        check("non-UFC exposed column sets unchanged", not changed, f"changed={changed}" if changed else f"{len(b_paths)} tables compared")
    else:
        check("non-UFC exposed schema diff", False, "no before-snapshot supplied")

    # ---- 3. constraints --------------------------------------------------
    tag = f"verify-{uuid.uuid4().hex[:8]}"
    r = rest("POST", "ufc_fighters", SVC, {"name": tag, "source_url": "verify://"})
    check("fighter with no source id rejected (check constraint)", r.status_code == 400 and "check" in r.text.lower(), f"HTTP {r.status_code} {r.text[:100]}")
    r = rest("POST", "ufc_events", SVC, {"name": tag, "source_url": "verify://"})
    check("event with no source id rejected (check constraint)", r.status_code == 400 and "check" in r.text.lower(), f"HTTP {r.status_code} {r.text[:100]}")

    # ---- 4. probe graph across all 12 tables ----------------------------
    P = {}
    P["fa"] = insert_probe("ufc_fighters", {"name": f"{tag} A", "espn_athlete_id": f"{tag}-a", "source_url": "verify://"})
    P["fb"] = insert_probe("ufc_fighters", {"name": f"{tag} B", "espn_athlete_id": f"{tag}-b", "source_url": "verify://"})
    P["ev"] = insert_probe("ufc_events", {"name": tag, "espn_event_id": tag, "event_date": "2026-01-01", "source_url": "verify://"})
    if P["fa"] and P["fb"] and P["ev"]:
        P["bout"] = insert_probe("ufc_bouts", {"espn_competition_id": tag, "event_id": P["ev"]["id"], "fighter_a_id": P["fa"]["id"],
                                               "fighter_b_id": P["fb"]["id"], "weight_class": "LIGHTWEIGHT", "bout_order": 1,
                                               "status": "announced", "source_url": "verify://"})
        r = rest("POST", "ufc_bouts", SVC, {"espn_competition_id": f"{tag}-bad", "event_id": P["ev"]["id"], "fighter_a_id": P["fa"]["id"],
                                            "fighter_b_id": P["fb"]["id"], "weight_class": "CRUISERWEIGHT", "bout_order": 2,
                                            "status": "announced", "source_url": "verify://"})
        check("bad weight_class enum rejected (check constraint)", r.status_code == 400, f"HTTP {r.status_code}")
    else:
        P["bout"] = None
    if P.get("bout"):
        b, fa, fb, ev = P["bout"]["id"], P["fa"]["id"], P["fb"]["id"], P["ev"]["id"]
        P["res"] = insert_probe("ufc_bout_results", {"bout_id": b, "winner_id": fa, "method": "DEC_U", "method_raw": tag, "round": 3,
                                                     "time_sec": 300, "result_source": "espn", "source_url": "verify://"})
        P["rs"] = insert_probe("ufc_bout_round_stats", {"bout_id": b, "fighter_id": fa, "round": 1, "kd": 0, "source_url": "verify://"})
        P["al"] = insert_probe("ufc_fighter_aliases", {"fighter_id": fa, "alias": tag, "source": "verify", "normalized": tag})
        P["rq"] = insert_probe("ufc_alias_review_queue", {"raw_name": tag, "source": "verify", "candidate_fighter_ids": [fa, fb],
                                                          "context": {"reason": "verify"}})
        P["run"] = insert_probe("ufc_ingest_runs", {"worker": tag, "status": "success"})
        P["ns"] = insert_probe("ufc_news_sources", {"kind": "rss", "name": tag, "url": f"verify://{tag}"})
        P["ni"] = insert_probe("ufc_news_items", {"source_id": P["ns"]["id"] if P["ns"] else None, "url": f"verify://{tag}/item",
                                                  "title": tag, "fingerprint": tag, "fighter_ids": [fa], "bout_id": b, "event_id": ev})
        P["ar"] = insert_probe("ufc_articles", {"slug": tag, "headline": tag, "body_md": tag, "story_type": "results",
                                                "fighter_ids": [fa, fb], "bout_id": b, "event_id": ev})
        P["im"] = insert_probe("ufc_images", {"kind": "statcard", "r2_key": f"verify/{tag}.png", "fighter_id": fa})

    # identifying filter per table for read/delete checks
    FILT = {
        "ufc_fighters": f"espn_athlete_id=like.{tag}*", "ufc_events": f"espn_event_id=eq.{tag}", "ufc_bouts": f"espn_competition_id=eq.{tag}",
        "ufc_bout_results": f"method_raw=eq.{tag}", "ufc_bout_round_stats": f"bout_id=eq.{P['bout']['id']}" if P.get("bout") else "bout_id=eq.00000000-0000-0000-0000-000000000000",
        "ufc_fighter_aliases": f"alias=eq.{tag}", "ufc_alias_review_queue": f"raw_name=eq.{tag}", "ufc_ingest_runs": f"worker=eq.{tag}",
        "ufc_news_sources": f"name=eq.{tag}", "ufc_news_items": f"fingerprint=eq.{tag}", "ufc_articles": f"slug=eq.{tag}",
        "ufc_images": f"r2_key=eq.verify/{tag}.png",
    }
    # minimal anon insert bodies (would be valid rows if RLS were off)
    ANON_INSERT = {
        "ufc_fighters": {"name": f"{tag}-anon", "espn_athlete_id": f"{tag}-anon", "source_url": "verify://"},
        "ufc_events": {"name": f"{tag}-anon", "espn_event_id": f"{tag}-anon", "source_url": "verify://"},
        "ufc_bouts": {"espn_competition_id": f"{tag}-anon", "event_id": P["ev"]["id"] if P.get("ev") else None, "fighter_a_id": P["fa"]["id"] if P.get("fa") else None,
                      "fighter_b_id": P["fb"]["id"] if P.get("fb") else None, "bout_order": 9, "source_url": "verify://"},
        "ufc_bout_results": {"bout_id": P["bout"]["id"] if P.get("bout") else None, "method": "DEC_U", "method_raw": f"{tag}-anon", "source_url": "verify://"},
        "ufc_bout_round_stats": {"bout_id": P["bout"]["id"] if P.get("bout") else None, "fighter_id": P["fb"]["id"] if P.get("fb") else None, "round": 1, "source_url": "verify://"},
        "ufc_fighter_aliases": {"fighter_id": P["fa"]["id"] if P.get("fa") else None, "alias": f"{tag}-anon", "source": "verify", "normalized": f"{tag}-anon"},
        "ufc_alias_review_queue": {"raw_name": f"{tag}-anon", "source": "verify"},
        "ufc_ingest_runs": {"worker": f"{tag}-anon"},
        "ufc_news_sources": {"kind": "rss", "name": f"{tag}-anon"},
        "ufc_news_items": {"title": f"{tag}-anon", "fingerprint": f"{tag}-anon"},
        "ufc_articles": {"slug": f"{tag}-anon", "headline": tag, "body_md": tag, "story_type": "results"},
        "ufc_images": {"kind": "statcard", "r2_key": f"verify/{tag}-anon.png"},
    }
    for t in EXPECTED:
        r = rest("GET", f"{t}?{FILT[t]}&select=*", SVC)
        n = len(r.json()) if r.status_code == 200 else -1
        check(f"service role sees probe in {t}", n >= 1, f"HTTP {r.status_code} rows={n}")
        if not ANON:
            check(f"anon probe {t}", False, "SUPABASE_ANON_KEY not set")
            continue
        r = rest("GET", f"{t}?{FILT[t]}&select=*", ANON)
        hidden = r.status_code in (401, 403) or (r.status_code == 200 and r.json() == [])
        check(f"anon cannot read probe in {t}", hidden, f"HTTP {r.status_code} rows={len(r.json()) if r.status_code == 200 else 'n/a'}")
        r = rest("POST", t, ANON, ANON_INSERT[t])
        check(f"anon insert rejected on {t}", r.status_code in (401, 403), f"HTTP {r.status_code} {r.text[:80] if r.status_code < 400 else ''}")
        r = rest("DELETE", f"{t}?{FILT[t]}", ANON, prefer="return=representation")
        untouched = r.status_code in (401, 403) or (r.status_code == 200 and r.json() == [])
        check(f"anon delete affects 0 rows on {t}", untouched, f"HTTP {r.status_code} rows={len(r.json()) if r.status_code == 200 else 'n/a'}")

    # ---- 5. cleanup in FK-safe order, then zero residue ------------------
    order = ["ufc_images", "ufc_articles", "ufc_news_items", "ufc_news_sources", "ufc_ingest_runs", "ufc_alias_review_queue",
             "ufc_fighter_aliases", "ufc_bout_round_stats", "ufc_bout_results", "ufc_bouts", "ufc_events", "ufc_fighters"]
    for t in order:
        r = rest("DELETE", f"{t}?{FILT[t]}", SVC, prefer="return=representation")
        check(f"cleanup {t}", r.status_code == 200, f"deleted={len(r.json()) if r.status_code == 200 else r.status_code}")
    residue = {}
    for t in order:
        r = rest("GET", f"{t}?{FILT[t]}&select=*", SVC)
        if r.status_code != 200 or r.json():
            residue[t] = r.status_code if r.status_code != 200 else len(r.json())
    # broad sweep on text columns that could hold a verify-* value
    for t, col in (("ufc_fighters", "name"), ("ufc_events", "name"), ("ufc_ingest_runs", "worker"), ("ufc_news_sources", "name"),
                   ("ufc_articles", "slug"), ("ufc_alias_review_queue", "raw_name"), ("ufc_fighter_aliases", "alias")):
        r = rest("GET", f"{t}?{col}=like.verify-*&select={col}", SVC)
        if r.status_code == 200 and r.json():
            residue[f"{t}.{col}"] = len(r.json())
    check("zero verify-* rows remain", not residue, f"residue={residue}" if residue else "12 tables swept")

    passed = sum(1 for _, ok, _ in results if ok)
    lines = [f"# Migration 001 verification — {dt.datetime.now(dt.timezone.utc).isoformat()}", "",
             f"Project `tkmlnhmylqnttmnsnief`. **{passed}/{len(results)} checks passed.** Method: PostgREST with the service-role and anon keys only; no SQL / catalog access.", "",
             "| Check | Result | Detail |", "|---|---|---|"]
    lines += [f"| {n} | {'PASS' if ok else 'FAIL'} | {d.replace('|', '/')} |" for n, ok, d in results]
    lines += ["", "## What this does and does not prove", "",
              "- RLS on every `ufc_*` table is proven behaviourally: a service-role probe row exists in each of the 12 tables, the anon key cannot read it, cannot insert, and its delete affects zero rows. This does not enumerate `pg_policies`; it proves the effect.",
              "- The non-UFC comparison proves the set of PostgREST-exposed tables and their column sets did not change between the pre-migration snapshot and now. It does NOT prove that functions, triggers, policies, grants, sequences, or other catalog objects are byte-identical; that requires catalog access this script does not have.",
              "- Check constraints are proven by rejected inserts (at-least-one-source on fighters/events, weight_class enum on bouts).",
              "- All probe rows are deleted in FK-safe order and a final sweep confirms zero `verify-*` residue."]
    Path(a.out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n{passed}/{len(results)} passed -> {a.out}")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
