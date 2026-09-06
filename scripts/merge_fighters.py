#!/usr/bin/env python
"""
Merge two ufc_fighters rows that are the same person (resolving a review-queue item).

  python scripts/merge_fighters.py --keep <uuid> --drop <uuid> [--apply]

Without --apply it prints what would change. With --apply it, in one FK-safe
order:
  1. re-points ufc_bouts.fighter_a_id / fighter_b_id, ufc_bout_results.winner_id,
     ufc_bout_round_stats.fighter_id, ufc_images.fighter_id from drop -> keep
  2. copies any source id / DOB / physicals the kept row lacks from the dropped row
  3. moves aliases (skipping ones the kept row already has), resolves review
     queue rows that list the dropped row, deletes the dropped row
Refuses if both rows carry different non-null values for the same source id.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
U = os.environ["SUPABASE_URL"].rstrip("/")
K = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": K, "Authorization": f"Bearer {K}", "Content-Type": "application/json"}


def get(path):
    r = requests.get(f"{U}/rest/v1/{path}", headers=H, timeout=60); r.raise_for_status(); return r.json()


def patch(path, body):
    r = requests.patch(f"{U}/rest/v1/{path}", headers={**H, "Prefer": "return=representation"}, data=json.dumps(body), timeout=60); r.raise_for_status(); return r.json()


def delete(path):
    r = requests.delete(f"{U}/rest/v1/{path}", headers={**H, "Prefer": "return=representation"}, timeout=60); r.raise_for_status(); return r.json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", required=True); ap.add_argument("--drop", required=True); ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    keep = get(f"ufc_fighters?id=eq.{a.keep}")[0]; drop = get(f"ufc_fighters?id=eq.{a.drop}")[0]
    print("KEEP:", {k: keep[k] for k in ("id", "name", "dob", "ufcstats_id", "espn_athlete_id")})
    print("DROP:", {k: drop[k] for k in ("id", "name", "dob", "ufcstats_id", "espn_athlete_id")})
    for col in ("ufcstats_id", "espn_athlete_id"):
        if keep[col] and drop[col] and keep[col] != drop[col]:
            sys.exit(f"refusing: both rows carry different {col} ({keep[col]} vs {drop[col]})")
    if keep["dob"] and drop["dob"] and keep["dob"] != drop["dob"]:
        sys.exit(f"refusing: DOB differs ({keep['dob']} vs {drop['dob']}) — not the same person")
    fill = {c: drop[c] for c in ("ufcstats_id", "espn_athlete_id", "dob", "nickname", "height_in", "reach_in", "weight_lbs", "stance",
                                 "career_slpm", "career_str_acc", "career_sapm", "career_str_def", "career_td_avg", "career_td_acc", "career_td_def", "career_sub_avg",
                                 "fight_history_count") if keep.get(c) is None and drop.get(c) is not None}
    refs = {
        "ufc_bouts a": get(f"ufc_bouts?select=id&fighter_a_id=eq.{a.drop}"), "ufc_bouts b": get(f"ufc_bouts?select=id&fighter_b_id=eq.{a.drop}"),
        "ufc_bout_results winner": get(f"ufc_bout_results?select=bout_id&winner_id=eq.{a.drop}"),
        "ufc_bout_round_stats": get(f"ufc_bout_round_stats?select=bout_id,round&fighter_id=eq.{a.drop}"),
        "ufc_images": get(f"ufc_images?select=id&fighter_id=eq.{a.drop}"),
        "aliases": get(f"ufc_fighter_aliases?select=id,alias,source,normalized&fighter_id=eq.{a.drop}"),
        "queue": get(f"ufc_alias_review_queue?select=id,raw_name,status&candidate_fighter_ids=cs.{{{a.drop}}}"),
    }
    print("fill on keep:", fill); print("references:", {k: len(v) for k, v in refs.items()})
    if not a.apply:
        print("dry run; add --apply to merge"); return
    patch(f"ufc_bouts?fighter_a_id=eq.{a.drop}", {"fighter_a_id": a.keep}); patch(f"ufc_bouts?fighter_b_id=eq.{a.drop}", {"fighter_b_id": a.keep})
    patch(f"ufc_bout_results?winner_id=eq.{a.drop}", {"winner_id": a.keep})
    # round stats have a PK on (bout_id, fighter_id, round): move row by row to surface conflicts
    for r in refs["ufc_bout_round_stats"]:
        patch(f"ufc_bout_round_stats?bout_id=eq.{r['bout_id']}&fighter_id=eq.{a.drop}&round=eq.{r['round']}", {"fighter_id": a.keep})
    patch(f"ufc_images?fighter_id=eq.{a.drop}", {"fighter_id": a.keep})
    have = {(x["source"], x["normalized"]) for x in get(f"ufc_fighter_aliases?select=source,normalized&fighter_id=eq.{a.keep}")}
    for al in refs["aliases"]:
        if (al["source"], al["normalized"]) in have:
            delete(f"ufc_fighter_aliases?id=eq.{al['id']}")
        else:
            patch(f"ufc_fighter_aliases?id=eq.{al['id']}", {"fighter_id": a.keep})
    for qrow in refs["queue"]:
        patch(f"ufc_alias_review_queue?id=eq.{qrow['id']}", {"status": "resolved", "resolved_fighter_id": a.keep, "resolved_at": "now()"})
    # delete the dropped row BEFORE copying its unique source ids onto the kept row
    # (unique constraint; and the at-least-one-source-id check forbids nulling them in place)
    delete(f"ufc_fighters?id=eq.{a.drop}")
    if fill:
        patch(f"ufc_fighters?id=eq.{a.keep}", fill)
    print("merged", a.drop, "->", a.keep, "filled", list(fill))


if __name__ == "__main__":
    main()
