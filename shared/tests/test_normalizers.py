"""Run: python shared/tests/test_normalizers.py  (from repo root)."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "scripts", "backfill"))
import normalizers as N  # noqa: E402
from common import SchemaAssertionError  # noqa: E402

FX = json.load(open(os.path.join(HERE, "normalizer_fixtures.json"), encoding="utf-8"))
failures = 0
U = "test://fixture"


def run(label, fn, cases, unpack=False):
    global failures
    for raw, expected in cases:
        try:
            got = fn(raw, U)
            if isinstance(got, tuple):
                got = list(got)
        except SchemaAssertionError:
            got = "raise"
        if got != expected:
            failures += 1
            print(f"FAIL {label}({raw!r}) = {got!r}, expected {expected!r}")


run("method", N.norm_method, FX["method"])
run("weight_class", N.norm_weight_class, FX["weight_class"])
run("stance", N.norm_stance, FX["stance"])
run("scheduled_rounds", N.scheduled_rounds, FX["scheduled_rounds"])
run("mmss", N.mmss_to_sec, FX["mmss"])
run("x_of_y", N.x_of_y, FX["x_of_y"])
run("height", N.height_in, FX["height"])
run("reach", N.reach_in, FX["reach"])
run("weight", N.weight_lbs, FX["weight"])
run("record", N.record, FX["record"])
run("event_date", N.event_date, FX["event_date"])
for raw, expected in FX["scorecards"]:
    got = N.scorecards(raw)
    if got != expected:
        failures += 1
        print(f"FAIL scorecards({raw!r}) = {got!r}, expected {expected!r}")

print("normalizers.py:", "OK" if failures == 0 else f"{failures} FAILURES")
sys.exit(1 if failures else 0)
