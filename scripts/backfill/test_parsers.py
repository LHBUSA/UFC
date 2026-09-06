"""Run: python scripts/backfill/test_parsers.py  (from repo root). Pins parser output to the archived fixtures."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import parsers as P  # noqa: E402
from common import SchemaAssertionError  # noqa: E402

FX = os.path.join(HERE, "fixtures")
failures = 0


def check(cond, msg):
    global failures
    if not cond:
        failures += 1
        print("FAIL:", msg)


def load(n):
    return open(os.path.join(FX, n), encoding="utf-8").read()


# completed list
ev = P.parse_event_list(load("completed_list_20260216.html"), "http://ufcstats.com/statistics/events/completed?page=all")
check(len(ev) == 762, f"completed list count {len(ev)}")
check(ev[0] == {"ufcstats_id": "79ab17db3b40831a", "name": "UFC Fight Night: Strickland vs. Hernandez", "event_date": "2026-02-21", "location_raw": "Houston, Texas, USA"}, f"first event {ev[0]}")
check(ev[-1]["name"] == "UFC 2: No Way Out" and ev[-1]["event_date"] == "1994-03-11", f"last event {ev[-1]}")
check(len({e["ufcstats_id"] for e in ev}) == 762, "event ids unique")

# fighters list
fl = P.parse_fighter_list(load("fighters_a_20260219.html"), "http://ufcstats.com/statistics/fighters?char=a&page=all")
check(len(fl) == 230, f"fighter list count {len(fl)}")
ab = next(f for f in fl if f["last"] == "Abbadi")
check(ab["ufcstats_id"] == "15df64c02b6b0fde" and ab["first"] == "Danny" and ab["nickname"] == "The Assassin" and ab["height_in"] == 71
      and ab["weight_lbs"] == 155 and ab["reach_in"] is None and ab["stance"] == "ORTHODOX" and (ab["record_w"], ab["record_l"], ab["record_d"]) == (4, 6, 0), f"Abbadi {ab}")
aa = next(f for f in fl if f["last"] == "Aaron")
check(aa["height_in"] is None and aa["stance"] is None and aa["nickname"] is None, f"Aaron {aa}")

# event page (recent)
e = P.parse_event_page(load("event_c337c3c85b1871e0.html"), "http://ufcstats.com/event-details/c337c3c85b1871e0")
check(e["ufcstats_id"] == "c337c3c85b1871e0" and e["name"] == "UFC Fight Night: Bautista vs. Oliveira" and e["event_date"] == "2026-02-07"
      and e["location_raw"] == "Las Vegas, Nevada, USA", f"event head {e['name']} {e['event_date']}")
check(len(e["bouts"]) == 13, f"bout count {len(e['bouts'])}")
b0 = e["bouts"][0]
check(b0["ufcstats_id"] == "fb4b1754d510b0d0" and b0["bout_order"] == 13 and b0["fighter_a_ufcstats_id"] == "bc711b6dd95c1af6" and b0["fighter_a_name"] == "Mario Bautista"
      and b0["fighter_b_ufcstats_id"] == "18d01f7f8338ae72" and b0["result_flag_a"] == "WIN" and b0["weight_class_raw"] == "Bantamweight"
      and b0["method_raw"] == "SUB" and b0["method_detail"] == "Rear Naked Choke" and b0["round"] == 2 and b0["time"] == "4:46", f"main event row {b0}")
check(e["bouts"][-1]["bout_order"] == 1, "last bout order 1")
check(all(b["method_raw"] in ("SUB", "U-DEC", "S-DEC", "KO/TKO") for b in e["bouts"]), f"methods {[b['method_raw'] for b in e['bouts']]}")

# fight page (recent)
f = P.parse_fight_page(load("fight_fb4b1754d510b0d0.html"), "http://ufcstats.com/fight-details/fb4b1754d510b0d0")
check(f["fighters"][0] == {"ufcstats_id": "bc711b6dd95c1af6", "name": "Mario Bautista", "flag": "WIN", "nickname": None}, f"person A {f['fighters'][0]}")
check(f["fighters"][1]["nickname"] == "LokDog" and f["fighters"][1]["flag"] == "LOSS", f"person B {f['fighters'][1]}")
check(f["method"] == "SUB" and f["method_raw"] == "Submission" and f["round"] == 2 and f["time_sec"] == 286 and f["time_format"] == "5 Rnd (5-5-5-5-5)"
      and f["scheduled_rounds"] == 5 and f["referee"] == "Herb Dean" and f["finish_detail"] == "Rear Naked Choke" and f["scorecards"] is None
      and f["weight_class"] == "BANTAMWEIGHT" and f["is_title"] is False and f["winner_ufcstats_id"] == "bc711b6dd95c1af6", f"result {f['method']} {f['round']} {f['time_sec']} {f['finish_detail']}")
check(f["has_stats"] and len(f["rounds"]) == 4, f"rounds {len(f['rounds'])}")
r = {(x["fighter_ufcstats_id"], x["round"]): x for x in f["rounds"]}
a1 = r[("bc711b6dd95c1af6", 1)]
check((a1["kd"], a1["sig_str_landed"], a1["sig_str_att"], a1["total_str_landed"], a1["total_str_att"], a1["td_landed"], a1["td_att"], a1["sub_att"], a1["rev"], a1["ctrl_sec"]) == (0, 3, 9, 22, 29, 1, 2, 0, 0, 138), f"Bautista R1 totals {a1}")
check((a1["head_landed"], a1["head_att"], a1["body_landed"], a1["body_att"], a1["leg_landed"], a1["leg_att"], a1["distance_landed"], a1["distance_att"], a1["clinch_landed"], a1["clinch_att"], a1["ground_landed"], a1["ground_att"]) == (1, 7, 2, 2, 0, 0, 1, 4, 0, 0, 2, 5), f"Bautista R1 sig {a1}")
b2 = r[("18d01f7f8338ae72", 2)]
check((b2["sig_str_landed"], b2["sig_str_att"], b2["td_landed"], b2["td_att"], b2["ctrl_sec"], b2["ground_landed"]) == (6, 13, 0, 1, 0, 0), f"Oliveira R2 {b2}")
# totals are recomputable from rounds
check(sum(x["sig_str_landed"] for x in f["rounds"] if x["fighter_ufcstats_id"] == "bc711b6dd95c1af6") == 15, "round sum == totals (15 of 27)")

# 1994 fight
o = P.parse_fight_page(load("fight_00835554f95fa911_ufc2.html"), "http://ufcstats.com/fight-details/00835554f95fa911")
check(o["method"] == "KO_TKO" and o["time_format"] == "No Time Limit" and o["scheduled_rounds"] is None and o["round"] == 1 and o["time_sec"] == 77
      and o["referee"] == "John McCarthy" and o["finish_detail"] == "Punches to Head From Mount Submission to Strikes", f"ufc2 result {o['method']} {o['scheduled_rounds']} {o['finish_detail']}")
check(o["weight_class"] is None or o["weight_class"] == "OPEN" or o["is_title"], f"ufc2 title/class {o['weight_class_raw']} -> {o['weight_class']} title={o['is_title']}")
check(o["has_stats"] and len(o["rounds"]) == 2 and o["rounds"][0]["ctrl_sec"] is None and o["rounds"][0]["sig_str_landed"] == 4, f"ufc2 rounds {o['rounds'][:1]}")

# 1994 event
oe = P.parse_event_page(load("event_a6a9ab5a824e8f66_ufc2.html"), "http://ufcstats.com/event-details/a6a9ab5a824e8f66")
check(oe["name"] == "UFC 2: No Way Out" and oe["event_date"] == "1994-03-11" and len(oe["bouts"]) == 15 and oe["bouts"][0]["weight_class_raw"] == "Open Weight", f"ufc2 event {oe['name']} {len(oe['bouts'])}")

# fighter pages
vo = P.parse_fighter_page(load("fighter_18d01f7f8338ae72.html"), "http://ufcstats.com/fighter-details/18d01f7f8338ae72")
check(vo["ufcstats_id"] == "18d01f7f8338ae72" and vo["name"] == "Vinicius Oliveira" and vo["nickname"] == "LokDog"
      and (vo["record_w"], vo["record_l"], vo["record_d"], vo["record_nc"]) == (23, 4, 0, 0) and vo["height_in"] == 69 and vo["weight_lbs"] == 135
      and vo["reach_in"] == 70 and vo["stance"] == "SWITCH" and vo["dob"] == "1995-11-30", f"Oliveira {vo}")
check((vo["career_slpm"], vo["career_str_acc"], vo["career_sapm"], vo["career_str_def"], vo["career_td_avg"], vo["career_td_acc"], vo["career_td_def"], vo["career_sub_avg"])
      == (4.73, 43, 2.70, 57, 1.45, 46, 70, 0.2), f"Oliveira career {vo}")
check(vo["fight_history_count"] == 6 and vo["history_fight_ids"][0] == "fb4b1754d510b0d0", f"Oliveira history {vo['fight_history_count']} {vo['history_fight_ids'][:2]}")
ta = P.parse_fighter_page(load("fighter_93fe7332d16c6ad9.html"), "http://ufcstats.com/fighter-details/93fe7332d16c6ad9")
check(ta["name"] == "Tom Aaron" and ta["nickname"] is None and ta["height_in"] is None and ta["reach_in"] is None and ta["stance"] is None
      and ta["dob"] == "1978-07-13" and ta["career_slpm"] == 0 and ta["fight_history_count"] == 2, f"Aaron {ta}")

# assertion behaviour: a mutated header must raise
bad = load("fight_fb4b1754d510b0d0.html").replace("Sub. att", "Submission attempts", 1)
try:
    P.parse_fight_page(bad, "test://mutated")
    check(False, "mutated header did not raise")
except SchemaAssertionError:
    pass

print("parsers.py:", "OK" if failures == 0 else f"{failures} FAILURES")
sys.exit(1 if failures else 0)
