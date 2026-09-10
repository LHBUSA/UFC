"""Run: python scripts/backfill/test_identity_dedupe.py

Regression for the duplicate-fighter / duplicate-bout bug: ESPN and UFC Stats
disagreeing on a birth date (1989-10-26 vs 1989-10-29) made the resolver
return "review", and the backfill then inserted a second, UFC Stats-only
fighter row. The bout pair no longer matched the ESPN bout, so a second bout
row followed. The fix: bout/card evidence decides identity, and a review that
is blocked only by a DOB disagreement defers instead of creating a fighter.
No network, no database: the Backfill is driven with stubs."""
import os
import sys
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "shared"))

import backfill_ufcstats as B  # noqa: E402
from alias_resolver import AliasResolver  # noqa: E402

failures = 0


def check(cond, msg):
    global failures
    if not cond:
        failures += 1
        print("FAIL:", msg)


class Log:
    def __init__(self):
        self.counters, self.events = {}, []

    def bump(self, k, n=1):
        self.counters[k] = self.counters.get(k, 0) + n

    def event(self, kind, **kw):
        self.events.append((kind, kw))


class Db:
    def __init__(self):
        self.inserts, self.patches = [], []

    def insert(self, table, rows):
        self.inserts.append((table, rows))

    def patch(self, table, flt, values):
        self.patches.append((table, flt, values))

    def select_all(self, *a, **k):
        return []


def make(fighters, page):
    bf = object.__new__(B.Backfill)
    bf.args = SimpleNamespace(force=False, dry_run=True)
    bf.cfg = SimpleNamespace(base="http://ufcstats.com", supabase_key=None)
    bf.log, bf.db = Log(), Db()
    bf.fighters, bf.fighter_by_ufcstats = {}, {}
    bf.resolver = AliasResolver([])
    for f in fighters:
        bf._register_fighter(dict(f))   # copies: a dry run links ids onto the row in place
    bf._get = lambda *a, **k: "<html>"
    B.parsers.parse_fighter_page = lambda html, url: dict(page)
    return bf


ESPN_REBECKI = {"id": "espn-mr", "ufcstats_id": None, "espn_athlete_id": "5000001", "name": "Mateusz Rebecki", "nickname": None,
                "dob": "1989-10-26", "record_w": 20, "record_l": 2, "record_d": 0}
OPPONENT = {"id": "espn-opp", "ufcstats_id": "bbbbbbbbbbbbbbb1", "espn_athlete_id": "5000002", "name": "Kyle Prepolec", "nickname": None,
            "dob": "1990-02-02", "record_w": 15, "record_l": 6, "record_d": 0}
PAGE = {"ufcstats_id": "aaaaaaaaaaaaaab2", "name": "Mateusz Rębecki", "nickname": "Chińczyk", "dob": "1989-10-29",
        "record_w": 20, "record_l": 2, "record_d": 0, "history_fight_ids": [], "upcoming_rows": 0}

# 1. Card evidence: the UFC Stats fighter is linked onto the ESPN row despite the DOB conflict.
bf = make([ESPN_REBECKI, OPPONENT], PAGE)
row = bf._corner("aaaaaaaaaaaaaab2", "Mateusz Rębecki", "http://ufcstats.com/event-details/x", scope=["espn-mr", "espn-opp"])
check(row is not None and row["id"] == "espn-mr", f"linked to the existing ESPN fighter, got {row and row.get('id')}")
check(not any(t == "ufc_fighters" for t, _ in bf.db.inserts), "no fighter row created")
check(bf.log.counters.get("dob_conflicts_linked_on_bout_evidence") == 1, f"conflict recorded {bf.log.counters}")
check(bf.fighter_by_ufcstats.get("aaaaaaaaaaaaaab2", {}).get("id") == "espn-mr", "UFC Stats id now resolves to the ESPN row")

# 2. No card evidence: deferred, never a second fighter.
bf = make([ESPN_REBECKI, OPPONENT], PAGE)
row = bf._corner("aaaaaaaaaaaaaab2", "Mateusz Rębecki", "http://ufcstats.com/event-details/x", scope=[])
check(row is None, f"deferred without bout evidence, got {row}")
check(not any(e[0] == "dry_run_fighter" for e in bf.log.events), "no fighter written, not even in a dry run")
check(bf.log.counters.get("fighters_deferred_dob_conflict") == 1, f"deferral counted {bf.log.counters}")

# 3. A genuinely new fighter (no candidate at all) is still created, as before.
bf = make([OPPONENT], {**PAGE, "name": "Brand New Person", "dob": "2001-01-01"})
row = bf._corner("aaaaaaaaaaaaaab3", "Brand New Person", "http://ufcstats.com/event-details/x", scope=["espn-opp"])
check(row is not None and str(row["id"]).startswith("dry-"), f"new fighter still created when nothing matches, got {row}")

# 4. Name-only stub path: card evidence links instead of stubbing a duplicate.
bf = make([ESPN_REBECKI, OPPONENT], PAGE)
bf._get = lambda *a, **k: None      # no archived fighter page -> stub path
row = bf._corner("aaaaaaaaaaaaaab2", "Mateusz Rębecki", "http://ufcstats.com/event-details/x", scope=["espn-mr", "espn-opp"])
check(row is not None and row["id"] == "espn-mr", f"stub path linked to the ESPN row, got {row and row.get('id')}")

print("identity dedupe:", "OK" if failures == 0 else f"{failures} FAILURES")
sys.exit(1 if failures else 0)
