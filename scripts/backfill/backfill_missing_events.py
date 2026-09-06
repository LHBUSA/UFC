#!/usr/bin/env python
"""Targeted / incremental UFC Stats historical gap repair.

This is deliberately a thin selector around backfill_ufcstats.Backfill so the
same parsers, identity resolver, result reconciliation, round-stat writer and
run ledger are used for repairs.

Examples:
  python scripts/backfill/backfill_missing_events.py --source wayback \
    --event-id 026b4f7049085842 --event-id 5a558ba1ff5e9121

  python scripts/backfill/backfill_missing_events.py --source wayback \
    --missing-limit 2

The automatic mode only selects completed, UFCStats-linked events that have
zero bout rows. That makes it safe to run repeatedly: once an event is filled,
it falls out of the queue. Partial-event reconciliation remains the job of the
normal backfill path.
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from backfill_ufcstats import Backfill  # noqa: E402


class MissingEventsBackfill(Backfill):
    def __init__(self, args, event_ids: list[str], missing_limit: int | None,
                 verify_fighter: str | None, expected_bouts: int | None):
        super().__init__(args)
        self.target_event_ids = list(dict.fromkeys(event_ids))
        self.missing_limit = missing_limit
        self.verify_fighter = verify_fighter
        self.expected_bouts = expected_bouts

        # A bounded explicit repair should never spend minutes building the
        # full event/fight/fighter CDX family indexes. An empty in-memory index
        # tells WaybackClient to fall straight through to exact-URL CDX lookup
        # for each requested page, preserving the normal capture validation and
        # fallback behavior while making canaries fast and deterministic.
        if self.target_event_ids and getattr(self.fetch, "wayback", None):
            for kind in ("events", "fights", "fighters"):
                self.fetch.wayback._index[kind] = {}
            self.log.event("wayback_lookup_mode", mode="exact_url", reason="explicit_event_targets")

    def phase_fights(self):
        if self.target_event_ids:
            missing_ids = [x for x in self.target_event_ids if x not in self.event_by_ufcstats]
            if missing_ids:
                raise RuntimeError(f"target UFCStats event ids are not in ufc_events: {missing_ids}")
            targets = [self.event_by_ufcstats[x] for x in self.target_event_ids]
        else:
            event_ids_with_bouts = {b["event_id"] for b in self.bouts}
            targets = [
                e for e in self.events
                if e.get("ufcstats_id")
                and e.get("card_status") == "complete"
                and e["id"] not in event_ids_with_bouts
            ]
            targets.sort(key=lambda e: e.get("event_date") or "", reverse=True)
            if self.args.since:
                targets = [e for e in targets if e.get("event_date") and e["event_date"] >= self.args.since]
            if self.missing_limit:
                targets = targets[: self.missing_limit]

        self.log.event(
            "missing_events_phase",
            selection="explicit" if self.target_event_ids else "zero_bout_events",
            events=len(targets),
            ids=[e.get("ufcstats_id") for e in targets],
        )
        for ev in targets:
            self._ingest_event(ev)

        if self.verify_fighter and self.expected_bouts is not None:
            fighter = self.fighter_by_ufcstats.get(self.verify_fighter)
            if fighter is None:
                raise RuntimeError(f"verify fighter {self.verify_fighter} is not linked")
            count = sum(
                1 for b in self.bouts
                if b.get("fighter_a_id") == fighter["id"] or b.get("fighter_b_id") == fighter["id"]
            )
            self.log.event(
                "fighter_history_verify",
                fighter_id=fighter["id"],
                ufcstats_id=self.verify_fighter,
                bouts=count,
                expected=self.expected_bouts,
            )
            if count < self.expected_bouts:
                raise RuntimeError(
                    f"fighter history incomplete after repair: {count}/{self.expected_bouts} bouts"
                )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["wayback", "live"], default="wayback")
    ap.add_argument("--event-id", action="append", default=[], help="UFCStats event id; repeatable")
    ap.add_argument("--missing-limit", type=int, help="when no --event-id is supplied, process this many zero-bout completed events")
    ap.add_argument("--since", help="YYYY-MM-DD lower bound for automatic zero-bout selection")
    ap.add_argument("--verify-fighter", help="UFCStats fighter id to verify after the repair")
    ap.add_argument("--expected-bouts", type=int, help="minimum bout count required for --verify-fighter")
    ap.add_argument("--raw-to-r2", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ns = ap.parse_args()
    if ns.since:
        dt.date.fromisoformat(ns.since)
    if not ns.event_id and not ns.missing_limit:
        ap.error("supply at least one --event-id or --missing-limit")
    if (ns.verify_fighter is None) != (ns.expected_bouts is None):
        ap.error("--verify-fighter and --expected-bouts must be supplied together")

    # Backfill expects these standard selection fields even though this wrapper
    # overrides phase_fights and owns the target selection itself.
    ns.phase = "fights"
    ns.limit = None
    sys.exit(MissingEventsBackfill(
        ns,
        event_ids=ns.event_id,
        missing_limit=ns.missing_limit,
        verify_fighter=ns.verify_fighter,
        expected_bouts=ns.expected_bouts,
    ).run())


if __name__ == "__main__":
    main()
