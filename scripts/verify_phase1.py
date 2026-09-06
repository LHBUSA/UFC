#!/usr/bin/env python
"""
Phase 1 verification report -> docs/phase1_verification.md

  python scripts/verify_phase1.py

Everything comes from the database (service role) plus the local HTML cache
(scripts/backfill/cache) for the per-event bout-count cross-check. Read-only.

Sections (kickoff brief, "Verification / acceptance criteria"):
  1. row counts
  2. UFC Stats completed list vs ufc_events (must be 100%)
  3. bouts per event vs event-page row count (per event, from cached pages)
  4. results with has_stats=false (listed)
  5. fighter fight-history vs our bouts: cached fighter pages, intersect
     history_fight_ids with ufc_bouts.ufcstats_id (history includes non-UFC
     promotions, so raw counts are NOT comparable)
  6. alias review queue size + top 20 near-duplicate names (resolver over
     every fighter row)
  7. assertion failures from ufc_ingest_runs
  8. spot-check table: 5 most recent fights with round stats, values printed
     for manual comparison against the archived page
"""
from __future__ import annotations

import datetime as dt
import os
import sys
from collections import Counter
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "shared"))
sys.path.insert(0, str(ROOT / "scripts" / "backfill"))
load_dotenv(ROOT / ".env")
from alias_resolver import AliasResolver, FighterRef  # noqa: E402
import parsers  # noqa: E402

URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
CACHE = ROOT / "scripts" / "backfill" / "cache"
H = {"apikey": KEY, "Accept": "application/json"}
if KEY.startswith("eyJ"):
    H["Authorization"] = f"Bearer {KEY}"


def count(table: str) -> int:
    r = requests.get(f"{URL}/rest/v1/{table}?select=*", headers={**H, "Prefer": "count=exact", "Range": "0-0", "Range-Unit": "items"}, timeout=60)
    return int(r.headers.get("content-range", "*/0").split("/")[-1])


def all_rows(table: str, select: str, filters: str = "") -> list[dict]:
    out, start = [], 0
    while True:
        r = requests.get(f"{URL}/rest/v1/{table}?select={select}{'&' + filters if filters else ''}",
                         headers={**H, "Range-Unit": "items", "Range": f"{start}-{start + 999}"}, timeout=120)
        r.raise_for_status()
        rows = r.json()
        out += rows
        if len(rows) < 1000:
            return out
        start += 1000


def main():
    L = [f"# Phase 1 verification — {dt.datetime.now(dt.timezone.utc).isoformat()}", "", "Project `tkmlnhmylqnttmnsnief`. Read-only, service role + local HTML cache.", ""]

    # 1. counts
    tables = ["ufc_fighters", "ufc_events", "ufc_bouts", "ufc_bout_results", "ufc_bout_round_stats", "ufc_fighter_aliases", "ufc_alias_review_queue", "ufc_ingest_runs"]
    counts = {t: count(t) for t in tables}
    L += ["## 1. Row counts", "", "| Table | Rows |", "|---|---|"] + [f"| {t} | {n} |" for t, n in counts.items()] + [""]

    # 2. completed list vs events
    events = all_rows("ufc_events", "id,ufcstats_id,espn_event_id,name,event_date,card_status")
    by_us = {e["ufcstats_id"]: e for e in events if e["ufcstats_id"]}
    listed = []
    cl = CACHE / "lists" / "completed.html"
    if cl.exists():
        listed = parsers.parse_event_list(cl.read_text(encoding="utf-8"), "http://ufcstats.com/statistics/events/completed?page=all")
        missing = [e for e in listed if e["ufcstats_id"] not in by_us]
        L += ["## 2. Completed list vs ufc_events", "", f"Cached completed list: {len(listed)} events. In ufc_events with a ufcstats_id: {len(by_us)}. "
              f"Missing: {len(missing)} ({'100% coverage' if not missing else 'NOT 100%'}).", ""]
        L += [f"- missing: {m['name']} ({m['event_date']}) {m['ufcstats_id']}" for m in missing[:50]] + ([""] if missing else [])
    else:
        L += ["## 2. Completed list vs ufc_events", "", "No cached completed list (scripts/backfill/cache/lists/completed.html).", ""]

    # 3. bouts per event vs cached event pages
    bouts = all_rows("ufc_bouts", "id,ufcstats_id,espn_competition_id,event_id,fighter_a_id,fighter_b_id,status")
    bouts_by_event = Counter(b["event_id"] for b in bouts)
    ev_pages = list((CACHE / "events").glob("*.html"))
    mism, checked = [], 0
    for p in ev_pages:
        ev = by_us.get(p.stem)
        if not ev:
            continue
        page = parsers.parse_event_page(p.read_text(encoding="utf-8"), f"http://ufcstats.com/event-details/{p.stem}")
        checked += 1
        if bouts_by_event.get(ev["id"], 0) != len(page["bouts"]):
            mism.append(f"{ev['name']} ({ev['event_date']}): page {len(page['bouts'])} vs db {bouts_by_event.get(ev['id'], 0)}")
    L += ["## 3. Bouts per event vs event page", "", f"Cached event pages checked: {checked}. Mismatches: {len(mism)}.", ""] + [f"- {m}" for m in mism[:100]] + ([""] if mism else [])

    # 4. has_stats=false
    results = all_rows("ufc_bout_results", "bout_id,has_stats,method,result_source")
    nostats = [r for r in results if not r["has_stats"]]
    bout_by_id = {b["id"]: b for b in bouts}
    ev_by_id = {e["id"]: e for e in events}
    L += ["## 4. Results without round stats", "", f"{len(nostats)} of {len(results)} results have has_stats=false "
          f"({sum(1 for r in nostats if r['result_source'] == 'espn')} are ESPN-sourced results whose UFC Stats page has not been ingested yet).", ""]
    for r in nostats[:100]:
        b = bout_by_id.get(r["bout_id"], {})
        e = ev_by_id.get(b.get("event_id"), {})
        L.append(f"- {e.get('name')} ({e.get('event_date')}) bout {b.get('ufcstats_id') or b.get('espn_competition_id')} [{r['result_source']}]")
    L.append("")

    # 5. fighter history vs bouts (intersection)
    fighters = all_rows("ufc_fighters", "id,ufcstats_id,espn_athlete_id,name,nickname,dob,record_w,record_l,record_d")
    f_by_us = {f["ufcstats_id"]: f for f in fighters if f["ufcstats_id"]}
    bout_ids = {b["ufcstats_id"] for b in bouts if b["ufcstats_id"]}
    bouts_of = Counter()
    for b in bouts:
        bouts_of[b["fighter_a_id"]] += 1
        bouts_of[b["fighter_b_id"]] += 1
    hist_checked, hist_mism = 0, []
    for p in (CACHE / "fighters").glob("*.html"):
        f = f_by_us.get(p.stem)
        if not f:
            continue
        page = parsers.parse_fighter_page(p.read_text(encoding="utf-8"), f"http://ufcstats.com/fighter-details/{p.stem}")
        hist_checked += 1
        ufc_hist = [h for h in page["history_fight_ids"] if h in bout_ids]
        if len(ufc_hist) != bouts_of.get(f["id"], 0):
            hist_mism.append(f"{f['name']}: history rows {page['fight_history_count']} (UFC-linked {len(ufc_hist)}) vs db bouts {bouts_of.get(f['id'], 0)}")
    L += ["## 5. Fighter history vs our bouts", "", f"Cached fighter pages checked: {hist_checked}. Mismatches (UFC-linked history vs db bouts): {len(hist_mism)}.", ""] + [f"- {m}" for m in hist_mism[:100]] + ([""] if hist_mism else [])

    # 6. alias queue + near duplicates
    queue = all_rows("ufc_alias_review_queue", "raw_name,source,status,candidate_fighter_ids,context")
    res = AliasResolver([FighterRef(id=f["id"], ufcstats_id=f["ufcstats_id"], name=f["name"], nickname=f["nickname"], dob=f["dob"],
                                    record=None if f["record_w"] is None else f"{f['record_w']}-{f['record_l']}-{f['record_d']}") for f in fighters])
    dups = res.find_internal_duplicates()
    L += ["## 6. Alias review queue and near-duplicates", "", f"Review queue: {len(queue)} rows ({sum(1 for q in queue if q['status'] == 'pending')} pending).",
          f"Fighter rows: {len(fighters)}. Exact-name collisions: {sum(1 for d in dups if d['kind'] != 'near_duplicate')}. Near-duplicates (token-sort ratio >= 90): {sum(1 for d in dups if d['kind'] == 'near_duplicate')}.", "",
          "| Kind | Score | Names | DOBs | Records |", "|---|---|---|---|---|"]
    L += [f"| {d['kind']} | {d['score']} | {' / '.join(d['names'])} | {' / '.join(str(x) for x in d['dobs'])} | {' / '.join(str(x) for x in d['records'])} |" for d in dups[:20]] + [""]
    for q in queue[:20]:
        L.append(f"- queue: {q['raw_name']} [{q['source']}] {q['status']} candidates={len(q['candidate_fighter_ids'])} reason={q['context'].get('reason')}")
    L.append("")

    # 7. assertion failures
    runs = all_rows("ufc_ingest_runs", "worker,started_at,status,events_new,bouts_new,fighters_touched,assertion_failures,notes")
    L += ["## 7. Ingest runs and assertion failures", "", "| Worker | Started | Status | events_new | bouts_new | fighters | failures |", "|---|---|---|---|---|---|---|"]
    L += [f"| {r['worker']} | {r['started_at'][:19]} | {r['status']} | {r['events_new']} | {r['bouts_new']} | {r['fighters_touched']} | {len(r['assertion_failures'])} |" for r in sorted(runs, key=lambda r: r["started_at"], reverse=True)[:20]]
    fails = [(r["worker"], f) for r in runs for f in r["assertion_failures"]]
    L += [""] + [f"- {w}: {f.get('class', 'SchemaAssertion')} {f.get('detail')} {f.get('url', '')}" for w, f in fails[:50]] + [""]
    gaps = Counter()
    for r in runs:
        for k, v in (r.get("notes") or {}).get("counters", {}).items():
            if k.startswith("wayback_missing"):
                gaps[k] += v
    if gaps:
        L += ["Wayback coverage gaps (counted, not failures): " + ", ".join(f"{k}={v}" for k, v in gaps.items()), ""]

    # 8. spot check
    rs = all_rows("ufc_bout_round_stats", "bout_id,fighter_id,round,kd,sig_str_landed,sig_str_att,total_str_landed,total_str_att,td_landed,td_att,sub_att,rev,ctrl_sec,head_landed,head_att,body_landed,body_att,leg_landed,leg_att,distance_landed,distance_att,clinch_landed,clinch_att,ground_landed,ground_att")
    f_by_id = {f["id"]: f for f in fighters}
    recent = sorted({r["bout_id"] for r in rs}, key=lambda bid: ev_by_id.get(bout_by_id.get(bid, {}).get("event_id"), {}).get("event_date") or "", reverse=True)[:5]
    L += ["## 8. Spot-check (compare by hand against the archived fight page)", ""]
    for bid in recent:
        b = bout_by_id[bid]
        e = ev_by_id.get(b["event_id"], {})
        L += [f"### {e.get('name')} ({e.get('event_date')}) — http://ufcstats.com/fight-details/{b['ufcstats_id']}", "",
              "| Fighter | Rd | KD | Sig | Total | TD | Sub | Rev | Ctrl | Head | Body | Leg | Dist | Clinch | Ground |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in sorted([x for x in rs if x["bout_id"] == bid], key=lambda x: (x["round"], x["fighter_id"] != b["fighter_a_id"])):
            L.append(f"| {f_by_id[r['fighter_id']]['name']} | {r['round']} | {r['kd']} | {r['sig_str_landed']}/{r['sig_str_att']} | {r['total_str_landed']}/{r['total_str_att']} | "
                     f"{r['td_landed']}/{r['td_att']} | {r['sub_att']} | {r['rev']} | {r['ctrl_sec']} | {r['head_landed']}/{r['head_att']} | {r['body_landed']}/{r['body_att']} | "
                     f"{r['leg_landed']}/{r['leg_att']} | {r['distance_landed']}/{r['distance_att']} | {r['clinch_landed']}/{r['clinch_att']} | {r['ground_landed']}/{r['ground_att']} |")
        L.append("")
    out = ROOT / "docs" / "phase1_verification.md"
    out.write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"wrote {out}")
    print("\n".join(L[:14]))


if __name__ == "__main__":
    main()
