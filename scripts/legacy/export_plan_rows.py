"""Flatten a first-repair plan into one reviewable CSV row per change.

    python scripts/legacy/export_plan_rows.py \
        --plan D:/Workers/_research/ufc-legacy-origins-2026-09-12/plan/first_repair_plan.json \
        --out docs/legacy/first_repair_rows.csv
"""
import argparse
import csv
import hashlib
import json
import pathlib


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    raw = pathlib.Path(args.plan).read_bytes()
    plan = json.loads(raw)
    sha = hashlib.sha256(raw).hexdigest()
    rows = []
    u1 = plan["ufc1"]
    names = {f["espn_athlete_id"]: f["espn_name"] for f in u1["fighters"]}

    for f in u1["fighters"]:
        if f["resolver_status"] == "matched":
            rows.append(("3 ufc1", "(none: existing fighter reused)", f["fighter_id"], f["espn_name"], "resolver", "", f"matched by {f['resolver_method']}"))
            continue
        rows.append(("3 ufc1", "ufc_alias_review_queue", "new", f["espn_name"], "insert pending review row", "",
                     f"source=legacy_origins_ufc1 espn={f['espn_athlete_id']} ufcstats={f['ufcstats_id']} candidates={len(f['candidates'])}"))
        rows.append(("3 ufc1", "ufc_fighters", "after review", f["espn_name"], "insert", "",
                     f"ufcstats_id={f['ufcstats_id']} espn_athlete_id={f['espn_athlete_id']} dob={f['dob']}"))
    ev = u1["event"]
    rows.append(("3 ufc1", "ufc_events", "new", ev["name"], "insert", "",
                 f"date={ev['event_date']} ufcstats={ev['ufcstats_id']} espn={ev['espn_event_id']} {ev['location_raw']} venue=NULL"))
    for b in u1["bouts"]:
        label = f"{names[b['fighter_a_espn']]} v {names[b['fighter_b_espn']]}"
        rows.append(("3 ufc1", "ufc_bouts", "new", label, "insert", "",
                     f"bout_order={b['bout_order']} ufcstats={b['ufcstats_fight_id']} espn={b['espn_competition_id']} {b['weight_class_raw']} is_title={b['is_title_raw']}"))
        s = b["semantics"]
        rows.append(("3 ufc1", "ufc_bout_results", "new", label, "insert", "",
                     f"winner={names[b['winner_espn']]} {b['method_raw']} ({b['finish_detail']}) raw_round={b['round_raw']} time={b['time_sec']}s "
                     f"format={b['time_format']} referee=NULL -> {s[0]}/{s[1]} {s[2]} elapsed={s[3]}s"))
        state = "open" if b.get("referee_conflict") else "none"
        for ref in b["espn_referee"]:
            rows.append(("3 ufc1", "ufc_event_fact_claims", "new", label, "insert referee claim", "", f"{ref} (espn tier 2, group ufc1-referee, {state})"))
        if b.get("sherdog_referee"):
            rows.append(("3 ufc1", "ufc_event_fact_claims", "new", label, "insert referee claim", "", f"{b['sherdog_referee']} (sherdog tier 4, group ufc1-referee, {state})"))
    rows.append(("3 ufc1", "ufc_event_fact_claims", "new", ev["name"], "insert venue_name claim", "", f"{ev['venue_claim']} (espn tier 2)"))
    rows.append(("3 ufc1", "combat_ingest_packets", "new", ev["name"], "insert 12 validated packets", "", "1 event + 8 bouts + 3 fighters, source ufc_canonical"))

    for c in plan["period_semantics"]["changes"]:
        rows.append(("4 period_semantics", "ufc_bout_results", c["bout_id"], c["label"], "period_structure/ending_period_kind/number/elapsed",
                     "NULL", f"{c['period_structure']}/{c['ending_period_kind']} {c['ending_period_number']} elapsed={c['elapsed_fight_sec']}s "
                             f"(raw round={c['raw']['round']} time={c['raw']['time_sec']}s format={c['raw']['time_format']})"))
    for x in plan["event_ids_venue"]["espn_event_id_updates"]:
        rows.append(("5 event_ids", "ufc_events", x["event_id"], x["event"], "espn_event_id", "NULL", x["espn_event_id"]))
    for v in plan["event_ids_venue"]["venue_claims"]:
        rows.append(("5 venue_claims", "ufc_event_fact_claims", v["event_id"], v["event"], "insert venue_name claim", "",
                     f"{v['venue_name_raw']} (espn tier 2; ufc_events.venue stays NULL)" if v["venue_name_raw"] else "SKIPPED: ESPN has no venue"))
    for p in plan["judge_fields"]["polluted_slots"]:
        rows.append(("6 judge_fields", "(none: alias layer)", p["bout_id"], p["slot"], "no row change", p["raw"], f"{p['canonical_via_alias']} | note: {p['card_note']}"))

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow([f"# plan_sha256={sha}"])
        w.writerow(["step", "table", "row_key", "label", "change", "before", "after"])
        w.writerows(rows)
    print(f"{len(rows)} rows -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
