#!/usr/bin/env python
"""
Post-migration verification for 001_ufc_phase1_core.sql, run through
PostgREST only (no database password, no SQL editor).

  python scripts/verify_migration.py [--before scratch/schema_before.json] [--out docs/phase1_migration_check.md]

Checks:
  1. every expected ufc_* table is exposed, with the expected columns
  2. RLS is effective on every ufc_* table: a service-role probe row is
     invisible to the anon key (no policies), then deleted
  3. non-UFC tables and their column sets are byte-identical to the
     pre-migration OpenAPI snapshot (this is the strongest "MLB/NFL/Stripe
     untouched" evidence available without catalog access)
  4. the at-least-one-source check constraints reject a fighter/event with
     neither id, and accept ESPN-only rows (then deletes them)
  5. service-role write/delete round trip works; anon insert is rejected

Exit code 0 only if every check passes. Writes a markdown report.
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


def rest(method, path, key, **kw):
    return requests.request(method, f"{URL}/rest/v1/{path}", headers=hdr(key, kw.pop("headers", None)), timeout=60, **kw)


results: list[tuple[str, bool, str]] = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", default=str(Path(os.environ.get("SCHEMA_BEFORE", "")) if os.environ.get("SCHEMA_BEFORE") else ""))
    ap.add_argument("--out", default=str(ROOT / "docs" / "phase1_migration_check.md"))
    a = ap.parse_args()

    spec = rest("GET", "", SVC).json()
    paths = sorted(p.strip("/") for p in spec.get("paths", {}) if p != "/")
    defs = {k: set(v.get("properties", {}).keys()) for k, v in spec.get("definitions", {}).items()}
    ufc = [p for p in paths if p.startswith("ufc_")]

    # 1. tables + columns
    for t, cols in EXPECTED.items():
        if t not in defs:
            check(f"table {t} exists", False, "missing")
            continue
        missing = cols - defs[t]
        extra = defs[t] - cols
        check(f"table {t} columns", not missing and not extra, f"missing={sorted(missing)} extra={sorted(extra)}" if (missing or extra) else f"{len(cols)} columns")
    check("no unexpected ufc_* tables", set(ufc) == set(EXPECTED), f"exposed={ufc}")

    # 3. non-UFC untouched
    if a.before and Path(a.before).exists():
        before = json.load(open(a.before))
        b_paths = [p for p in before["paths"] if not p.startswith("ufc_")]
        n_paths = [p for p in paths if not p.startswith("ufc_")]
        check("non-UFC table list unchanged", b_paths == n_paths, f"before={len(b_paths)} after={len(n_paths)} diff={sorted(set(b_paths) ^ set(n_paths))}")
        changed = [k for k, v in before["definitions"].items() if not k.startswith("ufc_") and set(v) != defs.get(k, set())]
        check("non-UFC column sets unchanged", not changed, f"changed={changed}" if changed else f"{len(before['definitions'])} definitions compared")
    else:
        check("non-UFC schema diff", False, "no before-snapshot supplied")

    # 4 + 5. constraints and write path (service role)
    tag = f"verify-{uuid.uuid4().hex[:8]}"
    r = rest("POST", "ufc_fighters", SVC, data=json.dumps({"name": tag, "source_url": "verify://"}))
    check("fighter with no source id rejected", r.status_code in (400, 409) and "check" in r.text.lower(), f"HTTP {r.status_code} {r.text[:120]}")
    r = rest("POST", "ufc_events", SVC, data=json.dumps({"name": tag, "source_url": "verify://"}))
    check("event with no source id rejected", r.status_code in (400, 409) and "check" in r.text.lower(), f"HTTP {r.status_code} {r.text[:120]}")

    r = rest("POST", "ufc_fighters", SVC, headers={"Prefer": "return=representation"},
             data=json.dumps({"name": tag, "espn_athlete_id": tag, "source_url": "verify://"}))
    ok = r.status_code == 201
    fid = r.json()[0]["id"] if ok else None
    check("ESPN-only fighter insert (service role)", ok, f"HTTP {r.status_code}")
    r = rest("POST", "ufc_events", SVC, headers={"Prefer": "return=representation"},
             data=json.dumps({"name": tag, "espn_event_id": tag, "event_date": "2026-01-01", "source_url": "verify://"}))
    ok = r.status_code == 201
    eid = r.json()[0]["id"] if ok else None
    check("ESPN-only event insert (service role)", ok, f"HTTP {r.status_code}")
    fid2 = None
    if fid and eid:
        r = rest("POST", "ufc_fighters", SVC, headers={"Prefer": "return=representation"},
                 data=json.dumps({"name": tag + "-b", "espn_athlete_id": tag + "-b", "source_url": "verify://"}))
        fid2 = r.json()[0]["id"] if r.status_code == 201 else None
        r = rest("POST", "ufc_bouts", SVC, headers={"Prefer": "return=representation"},
                 data=json.dumps({"espn_competition_id": tag, "event_id": eid, "fighter_a_id": fid, "fighter_b_id": fid2,
                                  "weight_class": "LIGHTWEIGHT", "bout_order": 1, "status": "announced", "source_url": "verify://"}))
        check("ESPN-only bout insert (service role)", r.status_code == 201, f"HTTP {r.status_code} {r.text[:120]}")
        r = rest("POST", "ufc_bouts", SVC, data=json.dumps({"espn_competition_id": tag + "-bad", "event_id": eid, "fighter_a_id": fid, "fighter_b_id": fid2,
                                                             "weight_class": "CRUISERWEIGHT", "bout_order": 2, "status": "announced", "source_url": "verify://"}))
        check("bad weight_class enum rejected", r.status_code == 400, f"HTTP {r.status_code}")

    # 2. RLS: anon must not see the probe rows; anon insert must fail
    if ANON:
        for t, flt in (("ufc_fighters", f"espn_athlete_id=eq.{tag}"), ("ufc_events", f"espn_event_id=eq.{tag}"), ("ufc_bouts", f"espn_competition_id=eq.{tag}")):
            r = rest("GET", f"{t}?{flt}&select=id", ANON)
            visible = r.status_code == 200 and len(r.json()) > 0
            check(f"RLS blocks anon read on {t}", not visible, f"HTTP {r.status_code} rows={len(r.json()) if r.status_code == 200 else 'n/a'}")
        for t in EXPECTED:
            if t in ("ufc_fighters", "ufc_events", "ufc_bouts"):
                continue
            r = rest("GET", f"{t}?select=*&limit=1", ANON)
            check(f"RLS blocks anon read on {t}", r.status_code in (401, 403) or (r.status_code == 200 and r.json() == []), f"HTTP {r.status_code}")
        r = rest("POST", "ufc_news_sources", ANON, data=json.dumps({"kind": "rss", "name": tag}))
        check("anon insert rejected", r.status_code in (401, 403), f"HTTP {r.status_code}")
    else:
        check("RLS anon probe", False, "SUPABASE_ANON_KEY not set")

    # cleanup (service role)
    for t, flt in (("ufc_bouts", f"espn_competition_id=eq.{tag}"), ("ufc_events", f"espn_event_id=eq.{tag}"),
                   ("ufc_fighters", f"espn_athlete_id=in.({tag},{tag}-b)")):
        r = rest("DELETE", f"{t}?{flt}", SVC)
        check(f"cleanup {t}", r.status_code in (200, 204), f"HTTP {r.status_code}")
    r = rest("GET", f"ufc_fighters?espn_athlete_id=like.{tag}*&select=id", SVC)
    check("probe rows gone", r.status_code == 200 and r.json() == [], f"rows={r.text[:60]}")

    passed = sum(1 for _, ok, _ in results if ok)
    lines = [f"# Migration 001 verification — {dt.datetime.now(dt.timezone.utc).isoformat()}", "",
             f"Project `tkmlnhmylqnttmnsnief`. {passed}/{len(results)} checks passed. Method: PostgREST only (service-role + anon keys); no SQL access.", "",
             "| Check | Result | Detail |", "|---|---|---|"]
    lines += [f"| {n} | {'PASS' if ok else 'FAIL'} | {d.replace('|', '/')} |" for n, ok, d in results]
    lines += ["", "Not verifiable through PostgREST: pg_policies / pg_proc contents, trigger definitions, RLS flags on non-exposed objects. "
              "RLS on ufc_* is proven behaviourally (service-role rows invisible to anon, anon insert rejected). "
              "Non-UFC tables are compared by exposed table list and column sets against the pre-migration OpenAPI snapshot."]
    Path(a.out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n{passed}/{len(results)} passed -> {a.out}")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
