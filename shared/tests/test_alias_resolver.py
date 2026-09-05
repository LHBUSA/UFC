"""Run: python shared/tests/test_alias_resolver.py  (from repo root). No pytest needed."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from alias_resolver import AliasResolver, FighterRef, normalize, token_sort_ratio, alias_rows_for_fighter  # noqa: E402

FX = json.load(open(os.path.join(HERE, "fixtures.json"), encoding="utf-8"))
failures = 0


def check(cond, msg):
    global failures
    if not cond:
        failures += 1
        print("FAIL:", msg)


for raw, expected in FX["normalize"]:
    got = normalize(raw)
    check(got == expected, f"normalize({raw!r}) = {got!r}, expected {expected!r}")

for a, b, expected in FX["token_sort_ratio"]:
    got = token_sort_ratio(a, b)
    check(abs(got - expected) < 1e-9, f"token_sort_ratio({a!r},{b!r}) = {got}, expected {expected}")

fighters = [FighterRef(id=f["id"], ufcstats_id=f["ufcstats_id"], name=f["name"], nickname=f.get("nickname"),
                       dob=f.get("dob"), record=f.get("record"), weight_classes=set(f.get("weight_classes", [])))
            for f in FX["fighters"]]
r = AliasResolver(fighters)

for case in FX["resolve"]:
    name, source, kw = case["args"]
    res = r.resolve(name, source, **kw)
    exp = case["expect"]
    check(res.status == exp["status"], f"[{case['name']}] status={res.status} expected {exp['status']}")
    if "fighter_id" in exp:
        check(res.fighter_id == exp["fighter_id"], f"[{case['name']}] fighter_id={res.fighter_id} expected {exp['fighter_id']}")
    if "method" in exp:
        check(res.method == exp["method"], f"[{case['name']}] method={res.method} expected {exp['method']}")
    if "n_candidates" in exp:
        n = len(res.review_row["candidate_fighter_ids"]) if res.review_row else 0
        check(n == exp["n_candidates"], f"[{case['name']}] n_candidates={n} expected {exp['n_candidates']}")
    if "reason" in exp:
        got = res.review_row["context"]["reason"] if res.review_row else None
        check(got == exp["reason"], f"[{case['name']}] reason={got} expected {exp['reason']}")

dups = r.find_internal_duplicates()
kinds = {}
for d in dups:
    kinds[d["kind"]] = kinds.get(d["kind"], 0) + 1
exp = FX["internal_duplicates"]
for k, v in exp["expect_kinds"].items():
    check(kinds.get(k, 0) == v, f"internal_duplicates kind {k}: {kinds.get(k, 0)} expected {v} (got {dups})")
near = [d for d in dups if d["kind"] == "near_duplicate"]
check(bool(near) and sorted(near[0]["fighter_ids"]) == sorted(exp["expect_near_pair"]), f"near pair {near}")

rows = alias_rows_for_fighter("f-so", "Sean O'Malley", "Sugar")
check(len(rows) == 2 and rows[0]["normalized"] == "sean omalley" and rows[1]["source"] == "ufcstats_nickname", f"alias rows {rows}")
rows = alias_rows_for_fighter("f-x", "Bruno Silva", None)
check(len(rows) == 1, f"alias rows no nickname {rows}")

print("alias_resolver.py:", "OK" if failures == 0 else f"{failures} FAILURES")
sys.exit(1 if failures else 0)
