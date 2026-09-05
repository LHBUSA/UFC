#!/usr/bin/env python
"""
Print everything the ingest wrote for one event, for eyeball verification.

  python scripts/inspect_event.py --espn-event-id 600056266
  python scripts/inspect_event.py --latest

Shows: event row, bouts in bout_order (main event first) with fighters,
weight class, card position, scheduled rounds, status, result fields, source
ids; the fighters touched; the alias rows; the review queue; the ingest run
rows. Read-only, service role.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": KEY, "Accept": "application/json"}
if KEY.startswith("eyJ"):
    H["Authorization"] = f"Bearer {KEY}"


def q(path):
    r = requests.get(f"{URL}/rest/v1/{path}", headers=H, timeout=60)
    r.raise_for_status()
    return r.json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--espn-event-id")
    ap.add_argument("--latest", action="store_true")
    a = ap.parse_args()
    if a.latest:
        ev = q("ufc_events?select=*&order=captured_at.desc&limit=1")[0]
    else:
        ev = q(f"ufc_events?select=*&espn_event_id=eq.{a.espn_event_id}")[0]
    print("EVENT")
    for k in ("id", "espn_event_id", "ufcstats_id", "name", "event_date", "venue", "city", "region", "country", "card_status", "source_url"):
        print(f"  {k:16} {ev.get(k)}")

    bouts = q(f"ufc_bouts?select=*&event_id=eq.{ev['id']}&order=bout_order.desc")
    fids = sorted({b["fighter_a_id"] for b in bouts} | {b["fighter_b_id"] for b in bouts})
    fighters = {f["id"]: f for f in q(f"ufc_fighters?select=*&id=in.({','.join(fids)})")} if fids else {}
    results = {r["bout_id"]: r for r in q(f"ufc_bout_results?select=*&bout_id=in.({','.join(b['id'] for b in bouts)})")} if bouts else {}
    print(f"\nBOUTS ({len(bouts)})  order | pos | class | rounds | status | A vs B | result | src ids")
    for b in bouts:
        fa, fb = fighters[b["fighter_a_id"]], fighters[b["fighter_b_id"]]
        r = results.get(b["id"])
        res = f"{r['method']} R{r['round']} {r['time_sec']}s win={fighters.get(r['winner_id'], {}).get('name') if r['winner_id'] else '-'} ref={r['referee']} src={r['result_source']} [{r['method_raw']}|{r['finish_detail']}]" if r else "(no result)"
        print(f"  {b['bout_order']:>2} | {b['card_position'] or '-':6} | {b['weight_class']}{' W' if b['is_womens'] else ''}{' TITLE' if b['is_title'] else ''} | {b['scheduled_rounds']} | {b['status']:9} | {fa['name']} vs {fb['name']} | {res} | espn={b['espn_competition_id']} ufcstats={b['ufcstats_id']}")

    print(f"\nFIGHTERS ({len(fighters)})  name | espn | ufcstats | dob | ht/reach/wt | stance | record | active")
    for f in sorted(fighters.values(), key=lambda x: x["name"]):
        print(f"  {f['name']:28} | {f['espn_athlete_id']} | {f['ufcstats_id']} | {f['dob']} | {f['height_in']}/{f['reach_in']}/{f['weight_lbs']} | {f['stance']} | {f['record_w']}-{f['record_l']}-{f['record_d']} | {f['is_active']}")

    aliases = q(f"ufc_fighter_aliases?select=fighter_id,alias,source,normalized&fighter_id=in.({','.join(fids)})") if fids else []
    print(f"\nALIASES ({len(aliases)}) sample:")
    for al in aliases[:8]:
        print(f"  {fighters[al['fighter_id']]['name']:28} | {al['source']:14} | {al['alias']} -> {al['normalized']}")

    queue = q("ufc_alias_review_queue?select=raw_name,source,status,candidate_fighter_ids,context&order=created_at.desc&limit=20")
    print(f"\nREVIEW QUEUE ({len(queue)} most recent)")
    for r in queue:
        print(f"  {r['raw_name']} [{r['source']}] {r['status']} candidates={len(r['candidate_fighter_ids'])} reason={r['context'].get('reason')}")

    runs = q("ufc_ingest_runs?select=worker,started_at,finished_at,status,events_new,bouts_new,fighters_touched,assertion_failures,notes&order=started_at.desc&limit=3")
    print(f"\nINGEST RUNS ({len(runs)} most recent)")
    for r in runs:
        print(f"  {r['worker']} {r['status']} {r['started_at']} -> {r['finished_at']} events_new={r['events_new']} bouts_new={r['bouts_new']} fighters={r['fighters_touched']} failures={len(r['assertion_failures'])}")
        print(f"    notes={json.dumps(r['notes'])[:300]}")
        for f in r["assertion_failures"][:5]:
            print(f"    ! {f}")


if __name__ == "__main__":
    main()
