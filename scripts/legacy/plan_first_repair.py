"""Plan the first UFC Legacy / Origins data repair. READ-ONLY.

Reads the canonical archive through PostgREST (GET only, paged with Range) and
the evidence captured for the 2026-09-12 source scout, and writes a plan: the
exact rows the first repair would insert or change, and the evidence for each.
It writes nothing to the database. Applying is a separate, reviewed step.

Steps planned (the approved execution order, steps 3-6):
  3  UFC 1: event, 8 bouts, 8 results from ESPN core (fetched once) cross-checked
     against the UFCStats event page capture; the three fighters with no
     canonical row become ufc_alias_review_queue rows, never ad-hoc ids.
  4  Period semantics for every result on an event dated <= 2004-12-31.
  5  ESPN event ids for events that lack one. Venues become CLAIMS only: ESPN
     renders current venue names, which are wrong for historical events.
  6  Judge fields: verify every polluted legacy judge string already resolves
     through ufc_judge_aliases (raw kept, canonical by alias). No row changes.

UFC.com material is not read here (decision 2026-09-12: no UFC.com ingestion).

    UFC_ENV_FILE=C:/Workers/ufc-propbetedge/.env \
    python scripts/legacy/plan_first_repair.py \
        --evidence D:/Workers/_research/ufc-legacy-origins-2026-09-12 \
        --out D:/Workers/_research/ufc-legacy-origins-2026-09-12/plan
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import hashlib
import html
import json
import os
import pathlib
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "shared"))
from alias_resolver import AliasResolver, FighterRef, normalize  # noqa: E402

LEGACY_CUTOFF = "2004-12-31"
UFC1_ESPN_EVENT = "400255729"
UFC1_UFCSTATS_EVENT = "6420efac0578988b"
UFC1_CAPTURE = "event_6420efac0578988b_UFC1_20250914141747.html"
UFC1_CAPTURE_URL = "https://web.archive.org/web/20250914141747/http://ufcstats.com/event-details/6420efac0578988b"
ESPN_SHELL_EVENTS = {"400254579"}  # empty duplicate UFC 49 document, no competitions


class PlanError(Exception):
    pass


def fail(msg: str) -> None:
    raise PlanError(msg)


# ---------------------------------------------------------------------------
# PostgREST, GET only
# ---------------------------------------------------------------------------
def load_env(path: str) -> dict:
    env = {}
    for line in open(path, encoding="utf-8-sig"):
        m = re.match(r"^\s*(?:export\s+)?([A-Z_]+)=(.*)$", line.strip())
        if m:
            env[m.group(1)] = m.group(2).strip().strip('"')
    return env


class Rest:
    def __init__(self, url: str, key: str):
        self.url, self.key = url.rstrip("/"), key

    def all(self, table: str, select: str, filters: str = "", page: int = 1000) -> list[dict]:
        rows, start = [], 0
        while True:
            q = f"{self.url}/rest/v1/{table}?select={urllib.parse.quote(select, safe=',()*:!')}"
            if filters:
                q += "&" + filters
            req = urllib.request.Request(q, headers={
                "apikey": self.key, "Authorization": f"Bearer {self.key}",
                "Range-Unit": "items", "Range": f"{start}-{start + page - 1}", "Prefer": "count=exact"})
            with urllib.request.urlopen(req, timeout=120) as r:
                batch = json.load(r)
                total = r.headers.get("Content-Range", "*/*").split("/")[-1]
            rows += batch
            if len(batch) < page:
                break
            start += page
        if total not in ("*", "") and int(total) != len(rows):
            fail(f"{table}: paged {len(rows)} rows but Content-Range says {total}")
        return rows


# ---------------------------------------------------------------------------
# Period semantics (mirrors public.ufc_time_format_structure; the proof
# asserts the SQL function and this function agree row by row)
# ---------------------------------------------------------------------------
FMT = re.compile(r"^(\d+)\s*Rnds?\s*(?:\+\s*(\d*)\s*OT\s*)?\(([\d\s-]+)\)$", re.I)


def structure(fmt: str | None):
    if not fmt or not fmt.strip():
        return ("unparsed", None, None)
    if re.fullmatch(r"no time limit", fmt.strip(), re.I):
        return ("untimed", None, 0)
    m = FMT.match(fmt.strip())
    if not m:
        return ("unparsed", None, None)
    n_rounds = int(m.group(1))
    n_ot = 0 if m.group(2) is None else (1 if m.group(2) == "" else int(m.group(2)))
    secs = [int(x) * 60 for x in re.sub(r"\s", "", m.group(3)).split("-")]
    if len(secs) != n_rounds + n_ot:
        return ("unparsed", None, None)
    if n_ot:
        return ("regulation_overtime", secs, n_ot) if n_rounds == 1 else ("unparsed", None, None)
    return ("single_period", secs, 0) if n_rounds == 1 else ("rounds", secs, 0)


def semantics(fmt: str | None, raw_round: int | None, time_sec: int | None):
    """Return (period_structure, ending_period_kind, ending_period_number, elapsed_fight_sec, basis) or a reason."""
    st, secs, n_ot = structure(fmt)
    if st == "unparsed":
        return None, f"time_format unparsed: {fmt!r}"
    if raw_round is None or time_sec is None:
        return None, "raw round or time_sec missing"
    basis = f"time_format={fmt!r} raw_round={raw_round} time_sec={time_sec}"
    if st == "untimed":
        if raw_round != 1:
            return None, f"untimed bout with raw round {raw_round}"
        return ("untimed", "whole_fight", 1, time_sec, basis), None
    if raw_round < 1 or raw_round > len(secs):
        return None, f"raw round {raw_round} outside {len(secs)} periods"
    if time_sec > secs[raw_round - 1]:
        return None, f"time_sec {time_sec} exceeds period length {secs[raw_round - 1]}"
    elapsed = sum(secs[: raw_round - 1]) + time_sec
    if st == "single_period":
        return ("single_period", "regulation_period", 1, elapsed, basis), None
    if st == "regulation_overtime":
        if raw_round == 1:
            return ("regulation_overtime", "regulation_period", 1, elapsed, basis), None
        return ("regulation_overtime", "overtime", raw_round - 1, elapsed, basis), None
    return ("rounds", "round", raw_round, elapsed, basis), None


# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------
def sha256_file(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def parse_ufcstats_event(page: str) -> list[dict]:
    rows = re.findall(r'<tr class="b-fight-details__table-row[^"]*"[^>]*data-link="[^"]*fight-details/([0-9a-f]{16})"(.*?)</tr>', page, re.S)
    out = []
    for fight_id, body in rows:
        cells = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", c))).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", body, re.S)]
        fighters = re.findall(r'fighter-details/([0-9a-f]{16})"[^>]*>\s*([^<]+?)\s*<', body)
        if len(fighters) != 2 or len(cells) < 10:
            fail(f"UFCStats capture row {fight_id} does not parse ({len(fighters)} fighters, {len(cells)} cells)")
        mins, secs = cells[9].split(":")
        out.append({
            "ufcstats_fight_id": fight_id,
            "outcome_first_corner": cells[0].split()[0].lower(),
            "fighters": [{"ufcstats_id": i, "name": html.unescape(n)} for i, n in fighters],
            "weight_class_raw": cells[6],
            "method_cell": cells[7],
            "round": int(cells[8]),
            "time_sec": int(mins) * 60 + int(secs),
            "title_belt": "belt.png" in body,
        })
    return out


def espn_method(result: dict) -> tuple[str, str]:
    name = (result or {}).get("name")
    if name == "submission":
        return "SUB", "Submission"
    if name == "kotko":
        return "KO_TKO", "KO/TKO"
    fail(f"unmapped ESPN result type {name!r}")


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--evidence", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    ev_dir = pathlib.Path(args.evidence)
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    env = load_env(os.environ.get("UFC_ENV_FILE", "C:/Workers/ufc-propbetedge/.env"))
    db = Rest(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])

    fighters = db.all("ufc_fighters", "id,ufcstats_id,espn_athlete_id,name,nickname,dob,record_w,record_l,record_d")
    aliases = db.all("ufc_fighter_aliases", "fighter_id,alias")
    events = db.all("ufc_events", "id,ufcstats_id,espn_event_id,name,event_date,venue,city,region,country", f"event_date=lte.{LEGACY_CUTOFF}&order=event_date.asc")
    all_espn_ids = {e["espn_event_id"] for e in db.all("ufc_events", "espn_event_id", "espn_event_id=not.is.null")}
    event_ids = [e["id"] for e in events]
    bouts, results = [], []
    for i in range(0, len(event_ids), 40):
        bouts += db.all("ufc_bouts", "id,event_id,ufcstats_id,espn_competition_id,fighter_a_id,fighter_b_id,bout_order,weight_class,weight_class_raw,is_title", f"event_id=in.({','.join(event_ids[i:i + 40])})")
    bout_ids = [b["id"] for b in bouts]
    for i in range(0, len(bout_ids), 80):
        results += db.all("ufc_bout_results", "bout_id,winner_id,method,method_raw,round,time_sec,time_format,referee,judge_1,judge_2,judge_3,scorecards,result_source", f"bout_id=in.({','.join(bout_ids[i:i + 80])})")
    judge_aliases = db.all("ufc_judge_aliases", "raw_name,canonical_name,card_note")
    open_review = db.all("ufc_alias_review_queue", "id,raw_name,source,status", "status=eq.pending")

    by_fighter = {f["id"]: f for f in fighters}
    alias_map = defaultdict(set)
    for a in aliases:
        alias_map[a["fighter_id"]].add(a["alias"])
    resolver = AliasResolver(FighterRef(
        id=f["id"], ufcstats_id=f["ufcstats_id"], name=f["name"], nickname=f["nickname"], dob=f["dob"],
        record=f"{f['record_w']}-{f['record_l']}-{f['record_d']}" if f["record_w"] is not None else None,
        aliases=alias_map.get(f["id"], set())) for f in fighters)

    plan: dict = {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                  "db_counts": {"fighters": len(fighters), "legacy_events": len(events), "legacy_bouts": len(bouts), "legacy_results": len(results)},
                  "evidence_root": str(ev_dir)}

    # ---- step 3: UFC 1 ------------------------------------------------------
    if any(e["ufcstats_id"] == UFC1_UFCSTATS_EVENT or e["espn_event_id"] == UFC1_ESPN_EVENT for e in events):
        fail("UFC 1 already present in ufc_events; plan is stale")
    espn_event_path = ev_dir / "feeds/raw" / f"espn_core_event_{UFC1_ESPN_EVENT}.json"
    capture_path = ev_dir / "feeds/raw" / UFC1_CAPTURE
    espn_ev = json.loads(espn_event_path.read_text(encoding="utf-8"))
    ufcstats_rows = parse_ufcstats_event(capture_path.read_text(encoding="utf-8", errors="ignore"))
    if len(ufcstats_rows) != 8 or len(espn_ev["competitions"]) != 8:
        fail("UFC 1 evidence must hold 8 bouts in both sources")
    ath = {}
    for p in glob.glob(str(ev_dir / "espn_ufc1" / "athletes_*.json")):
        a = json.loads(pathlib.Path(p).read_text(encoding="utf-8"))
        ath[a["id"]] = a

    ufc1_fighters: dict[str, dict] = {}   # espn athlete id -> identity decision
    ufc1_bouts = []
    for comp in espn_ev["competitions"]:
        cid = comp["id"]
        status = json.loads((ev_dir / "espn_ufc1" / f"leagues_ufc_events_{UFC1_ESPN_EVENT}_competitions_{cid}_status.json").read_text(encoding="utf-8"))
        officials = json.loads((ev_dir / "espn_ufc1" / f"leagues_ufc_events_{UFC1_ESPN_EVENT}_competitions_{cid}_officials.json").read_text(encoding="utf-8"))
        corners = sorted(comp["competitors"], key=lambda c: c["order"])
        names = [ath[c["id"]]["fullName"] for c in corners]
        winners = [c for c in corners if c.get("winner")]
        if len(winners) != 1:
            fail(f"ESPN competition {cid} has {len(winners)} winners")
        # match the UFCStats capture row by name pair (Patrick Trey Smith = Patrick Smith)
        def key(n):
            toks = normalize(n).split()
            return toks[-1]
        match = [r for r in ufcstats_rows if {key(f["name"]) for f in r["fighters"]} == {key(n) for n in names}]
        if len(match) != 1:
            fail(f"ESPN competition {cid} {names} matches {len(match)} UFCStats rows")
        row = match[0]
        mins, secs = status["displayClock"].split(":")
        espn_time = int(mins) * 60 + int(secs)
        if (status["period"], espn_time) != (row["round"], row["time_sec"]):
            fail(f"{names}: ESPN {status['period']}/{espn_time}s vs UFCStats {row['round']}/{row['time_sec']}s")
        winner_name = ath[winners[0]["id"]]["fullName"]
        ufcstats_winner = row["fighters"][0]["name"] if row["outcome_first_corner"] == "win" else None
        if ufcstats_winner is None or key(ufcstats_winner) != key(winner_name):
            fail(f"{names}: winner disagreement ESPN {winner_name} vs UFCStats {ufcstats_winner}")
        method, method_raw = espn_method(status.get("result"))
        refs = [f"{o.get('firstName', '')} {o.get('lastName', '')}".strip() for o in officials.get("items", []) if (o.get("position") or {}).get("name") == "Referee"]
        corner_ids = []
        for c in corners:
            a = ath[c["id"]]
            us = next(f for f in row["fighters"] if key(f["name"]) == key(a["fullName"]))
            decision = ufc1_fighters.get(c["id"])
            if decision is None:
                res = resolver.resolve(a["fullName"], "espn", ufcstats_id=us["ufcstats_id"], dob=(a.get("dateOfBirth") or "")[:10] or None)
                espn_holder = next((f for f in fighters if f["espn_athlete_id"] == c["id"]), None)
                decision = {
                    "espn_athlete_id": c["id"], "ufcstats_id": us["ufcstats_id"], "espn_name": a["fullName"], "ufcstats_name": us["name"],
                    "dob": (a.get("dateOfBirth") or "")[:10] or None,
                    "resolver_status": res.status, "resolver_method": res.method, "fighter_id": res.fighter_id,
                    "candidates": [{"fighter_id": x.fighter_id, "name": by_fighter[x.fighter_id]["name"], "score": round(x.score, 1), "reasons": x.reasons} for x in res.candidates[:5]],
                    "espn_athlete_id_already_on": espn_holder["id"] if espn_holder else None,
                    "open_review_rows_same_name": [q["id"] for q in open_review if normalize(q["raw_name"]) == normalize(a["fullName"])],
                }
                if res.status == "matched" and res.method != "ufcstats_id":
                    fail(f"{a['fullName']}: matched by {res.method}, not by UFCStats id; needs a human")
                ufc1_fighters[c["id"]] = decision
            corner_ids.append(c["id"])
        ufc1_bouts.append({
            "espn_competition_id": cid, "espn_match_number": comp["matchNumber"],
            "bout_order": 9 - comp["matchNumber"],
            "ufcstats_fight_id": row["ufcstats_fight_id"],
            "fighter_a_espn": corner_ids[0], "fighter_b_espn": corner_ids[1],
            "winner_espn": winners[0]["id"],
            "method": method, "method_raw": method_raw,
            "finish_detail": (status.get("result") or {}).get("description"),
            "round_raw": status["period"], "time_sec": espn_time,
            "time_format": comp["description"], "weight_class_raw": comp["type"]["text"],
            "is_title_raw": row["title_belt"],
            "espn_referee": refs,
            "espn_source_url": f"https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/{UFC1_ESPN_EVENT}/competitions/{cid}",
            "ufcstats_source_url": f"http://ufcstats.com/fight-details/{row['ufcstats_fight_id']}",
            "semantics": semantics(comp["description"], status["period"], espn_time)[0],
        })
        if row["weight_class_raw"] != comp["type"]["text"] or comp["description"] != "No Time Limit":
            fail(f"{names}: weight class / format disagreement")
    ufc1_bouts.sort(key=lambda b: -b["bout_order"])
    appearances = Counter()
    for b in ufc1_bouts:
        appearances[b["fighter_a_espn"]] += 1
        appearances[b["fighter_b_espn"]] += 1
    new_identities = [d for d in ufc1_fighters.values() if d["resolver_status"] != "matched"]
    for d in new_identities:
        if d["espn_athlete_id_already_on"]:
            fail(f"{d['espn_name']}: ESPN athlete id already on fighter {d['espn_athlete_id_already_on']}")
        if any(f["ufcstats_id"] == d["ufcstats_id"] for f in fighters):
            fail(f"{d['espn_name']}: UFCStats id already canonical")
    venue = json.loads((ev_dir / "espn_ufc1" / "leagues_ufc_venues_2549.json").read_text(encoding="utf-8"))
    plan["ufc1"] = {
        "event": {
            "name": "UFC 1: The Beginning", "event_date": "1993-11-12",
            "ufcstats_id": UFC1_UFCSTATS_EVENT, "espn_event_id": UFC1_ESPN_EVENT,
            "city": venue["address"]["city"], "region": "Colorado", "country": "USA",
            "location_raw": "Denver, Colorado, USA", "card_status": "complete",
            "source_url": f"https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/{UFC1_ESPN_EVENT}",
            "venue_claim": venue["fullName"],
        },
        "fighters": list(ufc1_fighters.values()),
        "new_identities": [d["espn_name"] for d in new_identities],
        "bouts": ufc1_bouts,
        "appearances": {ath[k]["fullName"]: v for k, v in appearances.items()},
        "evidence": {
            "espn_event": {"path": str(espn_event_path), "sha256": sha256_file(espn_event_path)},
            "ufcstats_capture": {"path": str(capture_path), "sha256": sha256_file(capture_path), "url": UFC1_CAPTURE_URL},
            "espn_refs_manifest": json.loads((ev_dir / "espn_ufc1" / "manifest.json").read_text(encoding="utf-8")),
        },
        "referee_conflict": "ESPN and the UFCStats lineage name Joao Alberto Barreto on all 8 bouts; Sherdog (secondary, research only) splits UFC 1 between Helio Vigio and Barreto. ufc_bout_results.referee stays NULL; ESPN referee claims are stored with conflict_state=open.",
    }

    # ---- step 4: period semantics ------------------------------------------
    ev_by = {e["id"]: e for e in events}
    bout_by = {b["id"]: b for b in bouts}
    changes, refused = [], []
    for r in results:
        sem, why = semantics(r["time_format"], r["round"], r["time_sec"])
        b = bout_by[r["bout_id"]]
        e = ev_by[b["event_id"]]
        label = f"{e['name']} | {by_fighter[b['fighter_a_id']]['name']} v {by_fighter[b['fighter_b_id']]['name']}"
        if sem is None:
            refused.append({"bout_id": r["bout_id"], "label": label, "reason": why})
            continue
        changes.append({"bout_id": r["bout_id"], "event_date": e["event_date"], "label": label,
                        "raw": {"round": r["round"], "time_sec": r["time_sec"], "time_format": r["time_format"]},
                        "period_structure": sem[0], "ending_period_kind": sem[1], "ending_period_number": sem[2],
                        "elapsed_fight_sec": sem[3], "period_semantics_basis": sem[4]})
    plan["period_semantics"] = {
        "rows_to_update": len(changes),
        "by_structure": Counter(c["period_structure"] for c in changes),
        "by_kind": Counter(f"{c['period_structure']}/{c['ending_period_kind']}" for c in changes),
        "no_longer_presented_as_round": [c for c in changes if c["ending_period_kind"] != "round"],
        "rounds_rows": len([c for c in changes if c["ending_period_kind"] == "round"]),
        "refused": refused,
        "changes": changes,
    }

    # ---- step 5: ESPN event ids + venue claims ------------------------------
    espn_docs = {}
    for p in glob.glob(str(ev_dir / "feeds/raw" / "espn_core_event_*.json")):
        d = json.loads(pathlib.Path(p).read_text(encoding="utf-8"))
        if d["id"] in ESPN_SHELL_EVENTS:
            continue
        espn_docs[d["id"]] = (d, p)
    def number(name):
        m = re.search(r"UFC\s*(\d+(?:\.5)?)\b", name)
        if m:
            return m.group(1)
        n = name.lower()
        for k in ("ultimate ultimate 95", "ultimate ultimate '95", "ultimate ultimate 96", "ultimate ultimate '96", "ultimate japan", "ultimate brazil"):
            if k in n:
                return k.replace("'", "")
        return None
    id_updates, venue_claims, unmatched = [], [], []
    bout_count = Counter(b["event_id"] for b in bouts)
    for e in events:
        want = number(e["name"])
        cands = []
        for eid, (d, p) in espn_docs.items():
            local_date = (dt.datetime.fromisoformat(d["date"].replace("Z", "+00:00")) - dt.timedelta(hours=12)).date().isoformat()
            if local_date == e["event_date"] and (number(d["name"]) == want or (want and want.startswith("ultimate") and want in d["name"].lower().replace("'", ""))):
                cands.append((eid, d, p))
        if e["name"].startswith("UFC - Ultimate Brazil"):
            cands = [(eid, d, p) for eid, (d, p) in espn_docs.items() if "Ultimate Brazil" in d["name"]]
        if len(cands) != 1:
            unmatched.append({"event": e["name"], "candidates": [c[0] for c in cands]})
            continue
        eid, d, p = cands[0]
        if len(d["competitions"]) != bout_count[e["id"]]:
            fail(f"{e['name']}: ESPN {len(d['competitions'])} competitions vs {bout_count[e['id']]} canonical bouts")
        if e["espn_event_id"] and e["espn_event_id"] != eid:
            fail(f"{e['name']}: already carries a different espn_event_id {e['espn_event_id']}")
        if not e["espn_event_id"]:
            if eid in all_espn_ids:
                fail(f"{e['name']}: ESPN id {eid} already used by another event")
            id_updates.append({"event_id": e["id"], "event": e["name"], "espn_event_id": eid, "espn_name": d["name"]})
        venues = Counter((c.get("venue") or {}).get("fullName") for c in d["competitions"])
        vname = venues.most_common(1)[0][0]
        addr = next(((c.get("venue") or {}).get("address") for c in d["competitions"] if (c.get("venue") or {}).get("address")), None)
        venue_claims.append({"event_id": e["id"], "event": e["name"], "venue_name_raw": vname, "address": addr,
                             "espn_event_id": eid, "source_locator": f"{pathlib.Path(p).name} sha256={sha256_file(pathlib.Path(p))}"})
    if unmatched:
        fail(f"events without a unique ESPN match: {unmatched}")
    plan["event_ids_venue"] = {"espn_event_id_updates": id_updates, "venue_claims": venue_claims,
                               "venue_claims_missing": [v["event"] for v in venue_claims if not v["venue_name_raw"]]}

    # ---- step 6: judge fields ----------------------------------------------
    alias_raw = {a["raw_name"]: a for a in judge_aliases}
    polluted = []
    for r in results:
        for slot, name in [("judge_1", r["judge_1"]), ("judge_2", r["judge_2"]), ("judge_3", r["judge_3"])] + [(f"scorecards[{i}]", s.get("judge")) for i, s in enumerate(r["scorecards"] or [])]:
            if name and re.search(r"\b(by|illegal|point|deduct|foul)\b", name, re.I):
                a = alias_raw.get(name)
                polluted.append({"bout_id": r["bout_id"], "slot": slot, "raw": name,
                                 "canonical_via_alias": a["canonical_name"] if a else None, "card_note": a["card_note"] if a else None})
    plan["judge_fields"] = {"polluted_slots": polluted, "unaliased": [p for p in polluted if not p["canonical_via_alias"]], "rows_to_update": 0}

    body = json.dumps(plan, indent=1, sort_keys=True, default=list)
    digest = hashlib.sha256(body.encode()).hexdigest()
    (out_dir / "first_repair_plan.json").write_bytes(body.encode("utf-8"))  # bytes: the hash covers exactly these
    (out_dir / "first_repair_plan.sha256").write_text(digest + "\n", encoding="utf-8")
    print(json.dumps({
        "plan_sha256": digest,
        "ufc1_new_identities": plan["ufc1"]["new_identities"],
        "ufc1_matched": [f"{d['espn_name']} -> {d['fighter_id']} ({d['resolver_method']})" for d in plan["ufc1"]["fighters"] if d["resolver_status"] == "matched"],
        "ufc1_review_candidates": {d["espn_name"]: d["candidates"] for d in plan["ufc1"]["fighters"] if d["resolver_status"] != "matched"},
        "period_semantics": {k: plan["period_semantics"][k] for k in ("rows_to_update", "by_kind", "rounds_rows")},
        "period_refused": len(refused),
        "espn_event_id_updates": len(id_updates),
        "venue_claims": len(venue_claims),
        "venue_claims_missing": plan["event_ids_venue"]["venue_claims_missing"],
        "judge_polluted_slots": len(polluted), "judge_unaliased": len(plan["judge_fields"]["unaliased"]),
    }, indent=1, default=list))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PlanError as exc:
        print(f"PLAN REFUSED: {exc}", file=sys.stderr)
        sys.exit(2)
