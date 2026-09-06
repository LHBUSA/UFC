#!/usr/bin/env python
"""
Merge duplicate ufc_events rows that describe the same card.

The UFC Stats backfill keys events on ufcstats_id; the ESPN ingest keyed them
on espn_event_id and, before 2026-09-06, did not look for an existing UFC
Stats row on the same date. Result: one card, two rows. This tool folds the
ESPN row (E) into the UFC Stats row (U):

  * E has bouts, U has none  -> move E's bouts (and any article / news links)
                                onto U, copy venue/status/espn id, delete E.
  * both have bouts          -> pair bouts by fighter pair; fold each ESPN
                                bout into its UFC Stats twin (espn ids, card
                                position, rounds, referee / finish detail
                                where missing), merge duplicate fighter rows
                                (ESPN-first -> UFC Stats), delete E's bouts,
                                then delete E.

  python scripts/merge_events.py            # dry run, prints the plan
  python scripts/merge_events.py --apply

Two rows are twins when their dates are within one day AND either both carry
the same "UFC <number>" or their headline tokens (after the colon) overlap.
Nothing is merged on date alone.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
U = os.environ["SUPABASE_URL"].rstrip("/")
K = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": K, "Authorization": f"Bearer {K}", "Content-Type": "application/json"}
APPLY = False
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def get(path):
    r = requests.get(f"{U}/rest/v1/{path}", headers=H, timeout=60); r.raise_for_status(); return r.json()


def patch(path, body):
    if not APPLY:
        return []
    r = requests.patch(f"{U}/rest/v1/{path}", headers={**H, "Prefer": "return=representation"}, data=json.dumps(body), timeout=60); r.raise_for_status(); return r.json()


def delete(path):
    if not APPLY:
        return []
    r = requests.delete(f"{U}/rest/v1/{path}", headers={**H, "Prefer": "return=representation"}, timeout=60); r.raise_for_status(); return r.json()


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower()).strip()


def tokens(s: str) -> set[str]:
    return {t for t in norm(s).split() if t not in {"vs", "v", "ufc", "fight", "night", "on", "the", "noche", "espn", "abc", "fox", "fx", "jr", "de", "da", "dos"}}


def same_card(a: dict, b: dict) -> bool:
    na, nb = re.search(r"\bufc\s*(\d+)\b", a["name"], re.I), re.search(r"\bufc\s*(\d+)\b", b["name"], re.I)
    if na and nb:
        return na.group(1) == nb.group(1)
    if bool(na) != bool(nb):
        return False
    ha = tokens(a["name"].split(":", 1)[-1]); hb = tokens(b["name"].split(":", 1)[-1])
    return len(ha & hb) >= 2 or (len(ha & hb) >= 1 and (len(ha) <= 2 or len(hb) <= 2))


def day_diff(a: str, b: str) -> int:
    from datetime import date
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


def fighter_key(f: dict) -> str:
    return norm(f["name"])


def merge_fighter(keep: dict, drop: dict, log):
    """ESPN-first row (drop) -> UFC Stats row (keep). Mirrors scripts/merge_fighters.py."""
    for col in ("ufcstats_id", "espn_athlete_id"):
        if keep[col] and drop[col] and keep[col] != drop[col]:
            log(f"    !! refusing fighter merge {drop['name']}: both carry different {col}")
            return False
    if keep["dob"] and drop["dob"] and keep["dob"] != drop["dob"]:
        log(f"    !! refusing fighter merge {drop['name']}: DOB differs ({keep['dob']} vs {drop['dob']})")
        return False
    log(f"    fighter {drop['name']} [{drop['id'][:8]} espn={drop['espn_athlete_id']}] -> {keep['name']} [{keep['id'][:8]} us={keep['ufcstats_id']}]")
    fill = {c: drop[c] for c in ("espn_athlete_id", "ufcstats_id", "dob", "nickname", "height_in", "reach_in", "weight_lbs", "stance", "is_active") if keep.get(c) is None and drop.get(c) is not None}
    if drop.get("record_w") is not None:
        fill.update({"record_w": drop["record_w"], "record_l": drop["record_l"], "record_d": drop["record_d"]})  # ESPN record is the fresher snapshot
    if APPLY:
        for tbl, col in (("ufc_bouts", "fighter_a_id"), ("ufc_bouts", "fighter_b_id"), ("ufc_bout_results", "winner_id"), ("ufc_bout_round_stats", "fighter_id"), ("ufc_images", "fighter_id")):
            patch(f"{tbl}?{col}=eq.{drop['id']}", {col: keep["id"]})
        for a in get(f"ufc_articles?select=id,fighter_ids&fighter_ids=cs.{{{drop['id']}}}"):
            patch(f"ufc_articles?id=eq.{a['id']}", {"fighter_ids": [keep["id"] if x == drop["id"] else x for x in a["fighter_ids"]]})
        for n in get(f"ufc_news_items?select=id,fighter_ids&fighter_ids=cs.{{{drop['id']}}}"):
            patch(f"ufc_news_items?id=eq.{n['id']}", {"fighter_ids": [keep["id"] if x == drop["id"] else x for x in n["fighter_ids"]]})
        have = {(x["source"], x["normalized"]) for x in get(f"ufc_fighter_aliases?select=source,normalized&fighter_id=eq.{keep['id']}")}
        for al in get(f"ufc_fighter_aliases?select=id,source,normalized&fighter_id=eq.{drop['id']}"):
            if (al["source"], al["normalized"]) in have:
                delete(f"ufc_fighter_aliases?id=eq.{al['id']}")
            else:
                patch(f"ufc_fighter_aliases?id=eq.{al['id']}", {"fighter_id": keep["id"]})
        patch(f"ufc_alias_review_queue?resolved_fighter_id=eq.{drop['id']}", {"resolved_fighter_id": keep["id"]})
        # release unique ids on the dropped row before filling the kept row
        patch(f"ufc_fighters?id=eq.{drop['id']}", {"espn_athlete_id": None, "ufcstats_id": f"dropped-{drop['id'][:8]}"})
        delete(f"ufc_fighters?id=eq.{drop['id']}")
        if fill:
            patch(f"ufc_fighters?id=eq.{keep['id']}", fill)
    return True


BOUT_COLS = "id,event_id,fighter_a_id,fighter_b_id,ufcstats_id,espn_competition_id,card_position,scheduled_rounds,weight_class,is_womens,is_title,bout_order,status,source_url"


def main():
    global APPLY
    ap = argparse.ArgumentParser(); ap.add_argument("--apply", action="store_true"); ap.add_argument("--since", default="2015-01-01")
    args = ap.parse_args(); APPLY = args.apply
    log = print
    events = get(f"ufc_events?select=id,name,event_date,ufcstats_id,espn_event_id,venue,city,region,country,card_status,is_ppv,location_raw&event_date=gte.{args.since}&order=event_date.asc&limit=5000")
    bouts = get(f"ufc_bouts?select={BOUT_COLS}&limit=20000")
    by_event = defaultdict(list)
    for b in bouts:
        by_event[b["event_id"]].append(b)
    fighters = {f["id"]: f for f in get("ufc_fighters?select=id,name,nickname,dob,ufcstats_id,espn_athlete_id,height_in,reach_in,weight_lbs,stance,is_active,record_w,record_l,record_d&limit=20000")}
    results = {r["bout_id"]: r for r in get("ufc_bout_results?select=bout_id,winner_id,referee,finish_detail,method&limit=20000")}

    us_rows = [e for e in events if e["ufcstats_id"] and not e["espn_event_id"]]
    espn_rows = [e for e in events if e["espn_event_id"] and not e["ufcstats_id"]]
    pairs = []
    for e in espn_rows:
        cands = [u for u in us_rows if day_diff(u["event_date"], e["event_date"]) <= 1 and same_card(u, e)]
        if len(cands) == 1:
            pairs.append((cands[0], e))
        elif len(cands) > 1:
            log(f"?? {e['event_date']} {e['name']}: {len(cands)} UFC Stats candidates, skipped")
    log(f"{len(pairs)} twin pairs found (dry run)" if not APPLY else f"{len(pairs)} twin pairs found — APPLYING")
    merged_fighters = 0
    for u, e in pairs:
        ub, eb = by_event.get(u["id"], []), by_event.get(e["id"], [])
        log(f"\n== {e['event_date']}  U: {u['name']} [{u['id'][:8]} bouts={len(ub)}]  <-  E: {e['name']} [{e['id'][:8]} bouts={len(eb)}]")
        # 1. event-level fields the UFC Stats row lacks
        fill = {c: e[c] for c in ("venue", "city", "region", "country", "is_ppv") if u.get(c) is None and e.get(c) is not None}
        if e["card_status"] == "complete" and u["card_status"] != "complete" and ub == []:
            fill["card_status"] = "complete"
        if not ub:
            log(f"  move {len(eb)} bouts -> U; fill {list(fill)}")
            if APPLY:
                patch(f"ufc_bouts?event_id=eq.{e['id']}", {"event_id": u["id"]})
        else:
            # 2. pair bouts by fighter names, fold ESPN bout into UFC Stats bout
            ukeys = {}
            for b in ub:
                fa, fb = fighters.get(b["fighter_a_id"]), fighters.get(b["fighter_b_id"])
                if fa and fb:
                    ukeys[frozenset((fighter_key(fa), fighter_key(fb)))] = b
            unmatched = 0
            for b in eb:
                fa, fb = fighters.get(b["fighter_a_id"]), fighters.get(b["fighter_b_id"])
                twin = ukeys.get(frozenset((fighter_key(fa), fighter_key(fb)))) if fa and fb else None
                if not twin:
                    unmatched += 1
                    log(f"  ?? no UFC Stats twin for ESPN bout {fa and fa['name']} v {fb and fb['name']} — moving it to U as-is")
                    if APPLY:
                        patch(f"ufc_bouts?id=eq.{b['id']}", {"event_id": u["id"]})
                    continue
                # fighters: ESPN-first rows that duplicate the UFC Stats rows
                for eid in (b["fighter_a_id"], b["fighter_b_id"]):
                    ef = fighters[eid]
                    if eid in (twin["fighter_a_id"], twin["fighter_b_id"]):
                        continue
                    uf = fighters[twin["fighter_a_id"]] if fighter_key(fighters[twin["fighter_a_id"]]) == fighter_key(ef) else fighters[twin["fighter_b_id"]]
                    if merge_fighter(uf, ef, log):
                        merged_fighters += 1
                        for k in ("espn_athlete_id", "dob", "nickname", "height_in", "reach_in", "weight_lbs", "stance", "is_active"):
                            if uf.get(k) is None and ef.get(k) is not None:
                                uf[k] = ef[k]
                        ef["_merged_into"] = uf["id"]
                bfill = {"espn_competition_id": b["espn_competition_id"]}
                for c in ("card_position", "scheduled_rounds"):
                    if twin.get(c) is None and b.get(c) is not None:
                        bfill[c] = b[c]
                ur, er = results.get(twin["id"]), results.get(b["id"])
                rfill = {c: er[c] for c in ("referee", "finish_detail") if ur and er and ur.get(c) is None and er.get(c) is not None} if ur and er else {}
                log(f"  bout {fa['name']} v {fb['name']}: fold -> {twin['id'][:8]} {list(bfill)}{' result+' + str(list(rfill)) if rfill else ''}")
                if APPLY:
                    for t, col in (("ufc_articles", "bout_id"), ("ufc_news_items", "bout_id")):
                        patch(f"{t}?{col}=eq.{b['id']}", {col: twin["id"]})
                    delete(f"ufc_bouts?id=eq.{b['id']}")  # results cascade
                    patch(f"ufc_bouts?id=eq.{twin['id']}", bfill)
                    if rfill:
                        patch(f"ufc_bout_results?bout_id=eq.{twin['id']}", rfill)
            if unmatched:
                log(f"  {unmatched} ESPN bouts had no twin and were moved")
        # 3. relink articles / news items, delete E, give U the ESPN id
        if APPLY:
            for t in ("ufc_articles", "ufc_news_items"):
                patch(f"{t}?event_id=eq.{e['id']}", {"event_id": u["id"]})
            espn_id = e["espn_event_id"]
            delete(f"ufc_events?id=eq.{e['id']}")  # E carries no ufcstats_id, so its espn id cannot be nulled first (check constraint); delete releases it
            patch(f"ufc_events?id=eq.{u['id']}", {"espn_event_id": espn_id, **fill, "updated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()})
        log(f"  E deleted; U gets espn_event_id={e['espn_event_id']}")
    log(f"\ndone: {len(pairs)} events folded, {merged_fighters} fighter rows merged{' (dry run — nothing written)' if not APPLY else ''}")


if __name__ == "__main__":
    main()
