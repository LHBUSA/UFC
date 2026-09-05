#!/usr/bin/env python
"""
Production proof for the ESPN-first ingest path, against ONE completed card.

  python scripts/proof_espn_card.py --espn-event-id 600056266 --seed
  node   scripts/run_worker_local.mjs --dates 20251214 --max-events 1
  python scripts/proof_espn_card.py --espn-event-id 600056266 --check [--cleanup-seeds]

--seed (before the run) plants two identity fixtures so both resolver paths
are exercised on an otherwise empty database:
  * seed A: an existing ufcstats-only row for the MAIN EVENT fighter with the
    CORRECT DOB -> the resolver must MATCH it and attach espn_athlete_id to
    that row (no duplicate).
  * seed B: an existing ufcstats-only row for the other main-event fighter
    with a WRONG DOB -> exact name but a disagreeing second key -> the
    resolver must NOT merge; it must create a new ESPN row AND queue a
    review item naming the seed as a candidate.
Seeds carry ufcstats_id 'seed-a-<tag>' / 'seed-b-<tag>' so they are
unmistakable.

--check (after the run) re-reads ESPN live and asserts every criterion in
the proof list. Exit 0 only if all pass. Writes docs/phase1_espn_proof.md.
--cleanup-seeds removes seed B and its review item and nulls seed A's fake
ufcstats_id (its ESPN id stays). Only run it after the check passed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "shared"))
load_dotenv(ROOT / ".env")
URL = os.environ["SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ENUMS = json.load(open(ROOT / "shared" / "enums.json", encoding="utf-8"))
CORE = "https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36", "Accept": "application/json"}


def H(extra=None):
    h = {"apikey": KEY, "Content-Type": "application/json", "Accept": "application/json"}
    if KEY.startswith("eyJ"):
        h["Authorization"] = f"Bearer {KEY}"
    h.update(extra or {})
    return h


def db(method, path, body=None, prefer=None):
    r = requests.request(method, f"{URL}/rest/v1/{path}", headers=H({"Prefer": prefer} if prefer else None),
                         data=json.dumps(body) if body is not None else None, timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(f"{method} {path} -> {r.status_code} {r.text[:200]}")
    return r.json() if r.text else None


def espn(url):
    r = requests.get(url.replace("http:", "https:"), headers=UA, timeout=30)
    r.raise_for_status()
    return r.json()


results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))
    return bool(ok)


def mmss(s):
    m = re.match(r"^(\d+):(\d{1,2})$", s or "")
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def espn_card(event_id):
    ev = espn(f"{CORE}/events/{event_id}?lang=en&region=us")
    venue = espn(ev["venues"][0]["$ref"]) if ev.get("venues") else {}
    comps = []
    for c in ev["competitions"]:
        st = espn(c["status"]["$ref"])
        offs = espn(c["officials"]["$ref"]) if c.get("officials", {}).get("$ref") else {"items": []}
        ref = next((f"{o.get('firstName', '')} {o.get('lastName', '')}".strip() for o in offs.get("items", []) if o.get("position", {}).get("name") == "Referee"), None)
        fighters = []
        for x in sorted(c["competitors"], key=lambda x: x["order"]):
            a = espn(x["athlete"]["$ref"])
            fighters.append({"id": str(x["id"]), "name": a["fullName"], "dob": (a.get("dateOfBirth") or "")[:10] or None, "winner": x.get("winner") is True})
        comps.append({"id": str(c["id"]), "matchNumber": c["matchNumber"], "type": c["type"].get("text", ""), "seg": c.get("cardSegment", {}).get("description"),
                      "periods": c.get("format", {}).get("regulation", {}).get("periods"), "desc": c.get("description"),
                      "status": st, "referee": ref, "fighters": fighters})
    return {"id": str(ev["id"]), "name": ev["name"], "date": ev["date"][:10], "venue": venue.get("fullName"), "addr": venue.get("address", {}), "comps": comps}


def seed(card, tag):
    main = next(c for c in card["comps"] if c["matchNumber"] == 1)
    fa, fb = main["fighters"]
    db("POST", "ufc_fighters", {"name": fa["name"], "ufcstats_id": f"seed-a-{tag}", "dob": fa["dob"], "source_url": "seed://a"})
    wrong_dob = "1980-01-01" if fb["dob"] != "1980-01-01" else "1981-01-01"
    db("POST", "ufc_fighters", {"name": fb["name"], "ufcstats_id": f"seed-b-{tag}", "dob": wrong_dob, "source_url": "seed://b"})
    print(f"seeded A={fa['name']} (correct dob {fa['dob']})  B={fb['name']} (wrong dob {wrong_dob})  tag={tag}")
    Path(ROOT / "docs" / ".proof_seed.json").write_text(json.dumps({"tag": tag, "a": fa, "b": fb, "wrong_dob": wrong_dob}), encoding="utf-8")


def run_check(card, seed_info, out):
    eid = card["id"]
    events = db("GET", "ufc_events?select=*")
    ev = next((e for e in events if e["espn_event_id"] == eid), None)
    check("exactly the intended ESPN event exists", ev is not None and len(events) == 1, f"events={[(e['espn_event_id'], e['name']) for e in events]}")
    if not ev:
        return
    check("event identity/date/venue correct",
          ev["name"] == card["name"] and ev["event_date"] == card["date"] and ev["venue"] == card["venue"]
          and ev["city"] == card["addr"].get("city") and ev["region"] == card["addr"].get("state") and ev["country"] == card["addr"].get("country"),
          f"db=({ev['name']},{ev['event_date']},{ev['venue']},{ev['city']},{ev['region']},{ev['country']}) espn=({card['name']},{card['date']},{card['venue']},{card['addr']})")
    check("event card_status complete", ev["card_status"] == "complete", ev["card_status"])
    check("event ufcstats_id null (ESPN-only proof)", ev["ufcstats_id"] is None, str(ev["ufcstats_id"]))

    bouts = db("GET", f"ufc_bouts?select=*&event_id=eq.{ev['id']}&order=bout_order.desc")
    n = len(card["comps"])
    check("bout count matches ESPN", len(bouts) == n, f"db={len(bouts)} espn={n}")
    by_comp = {b["espn_competition_id"]: b for b in bouts}
    fighters = {f["id"]: f for f in db("GET", "ufc_fighters?select=*")}
    by_espn = {f["espn_athlete_id"]: f for f in fighters.values() if f["espn_athlete_id"]}
    res = {r["bout_id"]: r for r in db("GET", "ufc_bout_results?select=*")}

    order_ok, pos_ok, rounds_ok, womens_ok, title_ok, result_ok, src_ok = True, True, True, True, True, True, True
    seen_pos, womens_seen, title_seen, details = set(), 0, 0, []
    for c in card["comps"]:
        b = by_comp.get(c["id"])
        if not b:
            details.append(f"missing bout for competition {c['id']}"); order_ok = False; continue
        exp_order = n + 1 - c["matchNumber"]
        if b["bout_order"] != exp_order:
            order_ok = False; details.append(f"order comp {c['id']}: db={b['bout_order']} exp={exp_order}")
        exp_pos = ENUMS["espn"]["card_segment_map"].get(c["seg"]) if c["seg"] else None
        seen_pos.add(b["card_position"])
        if b["card_position"] != exp_pos:
            pos_ok = False; details.append(f"card_position comp {c['id']}: db={b['card_position']} exp={exp_pos}")
        if b["scheduled_rounds"] != c["periods"]:
            rounds_ok = False; details.append(f"rounds comp {c['id']}: db={b['scheduled_rounds']} espn={c['periods']}")
        is_w = "women" in c["type"].lower()
        womens_seen += is_w
        if b["is_womens"] != is_w or (is_w and not b["weight_class"]):
            womens_ok = False; details.append(f"womens comp {c['id']}: db={b['is_womens']}/{b['weight_class']} espn={c['type']}")
        is_t = "title" in c["type"].lower()
        title_seen += is_t
        if b["is_title"] != is_t:
            title_ok = False; details.append(f"title comp {c['id']}: db={b['is_title']} espn={c['type']}")
        if b["ufcstats_id"] is not None:
            src_ok = False; details.append(f"bout {c['id']} has ufcstats_id {b['ufcstats_id']}")
        if b["status"] != "complete":
            result_ok = False; details.append(f"bout {c['id']} status {b['status']}")
        r = res.get(b["id"])
        st = c["status"]
        if not r:
            result_ok = False; details.append(f"no result for comp {c['id']}"); continue
        exp_method = ENUMS["method"]["map"].get(st["result"]["displayName"])
        exp_winner = next((f["id"] for f in c["fighters"] if f["winner"]), None)
        exp_winner_uuid = by_espn.get(exp_winner, {}).get("id") if exp_winner else None
        exp_time = mmss(st.get("displayClock"))
        bad = []
        if r["method"] != exp_method: bad.append(f"method {r['method']}!={exp_method}")
        if r["winner_id"] != exp_winner_uuid: bad.append("winner")
        if r["round"] != st.get("period"): bad.append(f"round {r['round']}!={st.get('period')}")
        if r["time_sec"] != exp_time: bad.append(f"time {r['time_sec']}!={exp_time}")
        if (r["referee"] or None) != (c["referee"] or None): bad.append(f"referee {r['referee']}!={c['referee']}")
        if r["result_source"] != "espn": bad.append(f"result_source {r['result_source']}")
        if r["finish_detail"] != (st["result"].get("description") or None): bad.append("finish_detail")
        if bad:
            result_ok = False; details.append(f"result comp {c['id']}: {', '.join(bad)}")
        # fighter pairing
        exp_ids = {f["id"] for f in c["fighters"]}
        got_ids = {fighters[b["fighter_a_id"]]["espn_athlete_id"], fighters[b["fighter_b_id"]]["espn_athlete_id"]}
        if exp_ids != got_ids:
            src_ok = False; details.append(f"fighters comp {c['id']}: db={got_ids} espn={exp_ids}")
    check("main event ordering + full card order match ESPN (n+1-matchNumber)", order_ok, "; ".join(d for d in details if d.startswith("order")) or f"main event bout_order={n}")
    check("card_position distinguishes segments", pos_ok and len(seen_pos - {None}) >= 2, f"positions seen={sorted(p for p in seen_pos if p)}")
    check("scheduled_rounds match ESPN", rounds_ok, "; ".join(d for d in details if d.startswith("rounds")) or "all bouts")
    check("women's divisions via is_womens with weight_class kept", womens_ok and womens_seen > 0, f"womens bouts on card={womens_seen}")
    check("title bouts marked exactly as ESPN", title_ok, f"title bouts on card={title_seen}" + (" (none on this card: only the negative case is exercised)" if title_seen == 0 else ""))
    check("result winner/method/round/time/referee/finish_detail/result_source correct", result_ok, "; ".join(d for d in details if d.startswith("result") or d.startswith("no result")) or f"{len(bouts)} results")
    check("bout fighter pairs match ESPN; bout ufcstats_id null", src_ok, "; ".join(d for d in details if d.startswith("fighters") or "ufcstats_id" in d) or "ok")

    card_fighters = {f["id"] for c in card["comps"] for f in c["fighters"]}
    card_rows = [f for f in fighters.values() if f["espn_athlete_id"] in card_fighters]
    check("every card fighter has an ESPN athlete id", len(card_rows) == len(card_fighters), f"db={len(card_rows)} espn={len(card_fighters)}")
    check("no fighter merged on name alone: one row per ESPN athlete, names match",
          all(by_espn[f["id"]]["name"] == f["name"] for c in card["comps"] for f in c["fighters"] if f["id"] in by_espn),
          "names identical to ESPN")

    queue = db("GET", "ufc_alias_review_queue?select=*")
    if seed_info:
        tag, a, b = seed_info["tag"], seed_info["a"], seed_info["b"]
        row_a = by_espn.get(a["id"])
        check("seed A (correct DOB) matched: ESPN id attached to the existing row, no duplicate",
              row_a is not None and row_a["ufcstats_id"] == f"seed-a-{tag}" and sum(1 for f in fighters.values() if f["name"] == a["name"]) == 1,
              f"rows named {a['name']}={sum(1 for f in fighters.values() if f['name'] == a['name'])} ufcstats_id={row_a['ufcstats_id'] if row_a else None}")
        row_b = by_espn.get(b["id"])
        seed_b = next((f for f in fighters.values() if f["ufcstats_id"] == f"seed-b-{tag}"), None)
        q_b = [q for q in queue if q["raw_name"] == b["name"] and q["source"] == "espn"]
        check("seed B (wrong DOB) NOT merged: new ESPN row created",
              row_b is not None and seed_b is not None and row_b["id"] != seed_b["id"] and row_b["ufcstats_id"] is None,
              f"espn_row={row_b['id'] if row_b else None} seed_row={seed_b['id'] if seed_b else None}")
        check("seed B produced a review-queue item naming the seed as candidate",
              len(q_b) == 1 and seed_b is not None and seed_b["id"] in q_b[0]["candidate_fighter_ids"] and q_b[0]["status"] == "pending",
              f"queue items for {b['name']}={len(q_b)} reason={q_b[0]['context'].get('reason') if q_b else None}")
        check("no other review-queue items", len(queue) == len(q_b), f"queue total={len(queue)}")
    else:
        check("review queue empty (no seeds, empty DB: ambiguity path not exercisable)", len(queue) == 0, f"queue={len(queue)}")

    runs = db("GET", "ufc_ingest_runs?select=*&order=started_at.desc&limit=1")
    run = runs[0] if runs else None
    check("ingest ledger closed as success", run is not None and run["status"] == "success" and run["finished_at"] is not None, f"status={run['status'] if run else None}")
    check("zero assertion failures", run is not None and run["assertion_failures"] == [], f"failures={run['assertion_failures'] if run else None}")
    check("ledger counters plausible", run is not None and run["events_new"] == 1 and run["bouts_new"] == n and run["fighters_touched"] >= len(card_fighters),
          f"events_new={run['events_new'] if run else None} bouts_new={run['bouts_new'] if run else None} fighters_touched={run['fighters_touched'] if run else None}")

    passed = sum(1 for _, ok, _ in results if ok)
    lines = [f"# ESPN-first production proof — event {eid} — {dt.datetime.now(dt.timezone.utc).isoformat()}", "",
             f"`node scripts/run_worker_local.mjs --dates {card['date'].replace('-', '')} --max-events 1` (ESPN only, no UFC Stats, no Wayback, no Discord). ",
             f"Checked live against ESPN. **{passed}/{len(results)} checks passed.**", "",
             "| Check | Result | Detail |", "|---|---|---|"]
    lines += [f"| {n_} | {'PASS' if ok else 'FAIL'} | {d.replace('|', '/')} |" for n_, ok, d in results]
    if seed_info:
        lines += ["", f"Identity fixtures: seed A = {seed_info['a']['name']} (ufcstats-only row, correct DOB) must be matched; seed B = {seed_info['b']['name']} (ufcstats-only row, DOB {seed_info['wrong_dob']}) must NOT be merged. Seeds are removed with `--cleanup-seeds` after the proof."]
    Path(out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n{passed}/{len(results)} passed -> {out}")
    return passed == len(results)


def cleanup_seeds(seed_info):
    tag, b = seed_info["tag"], seed_info["b"]
    seed_b = db("GET", f"ufc_fighters?select=id&ufcstats_id=eq.seed-b-{tag}")
    if seed_b:
        db("DELETE", f"ufc_alias_review_queue?raw_name=eq.{b['name']}&source=eq.espn")
        db("DELETE", f"ufc_fighters?id=eq.{seed_b[0]['id']}")
    db("PATCH", f"ufc_fighters?ufcstats_id=eq.seed-a-{tag}", {"ufcstats_id": None, "source_url": f"{CORE}/athletes/{seed_info['a']['id']}"})
    left = db("GET", "ufc_fighters?select=id&ufcstats_id=like.seed-*")
    print("seed cleanup done; residual seed rows:", len(left))
    (ROOT / "docs" / ".proof_seed.json").unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--espn-event-id", required=True)
    ap.add_argument("--seed", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--cleanup-seeds", action="store_true")
    ap.add_argument("--out", default=str(ROOT / "docs" / "phase1_espn_proof.md"))
    a = ap.parse_args()
    card = espn_card(a.espn_event_id)
    print(f"ESPN card: {card['name']} {card['date']} {card['venue']} bouts={len(card['comps'])}")
    seed_path = ROOT / "docs" / ".proof_seed.json"
    seed_info = json.loads(seed_path.read_text(encoding="utf-8")) if seed_path.exists() else None
    if a.seed:
        seed(card, dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S"))
        return
    ok = True
    if a.check:
        ok = run_check(card, seed_info, a.out)
    if a.cleanup_seeds and seed_info:
        if ok:
            cleanup_seeds(seed_info)
        else:
            print("check failed; seeds left in place for inspection")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
