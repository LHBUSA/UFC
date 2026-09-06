#!/usr/bin/env python
"""Targeted / incremental UFC Stats historical gap repair.

This is deliberately a thin selector around backfill_ufcstats.Backfill so the
same parsers, identity resolver, result reconciliation, round-stat writer and
run ledger are used for repairs.

Examples:
  python scripts/backfill/backfill_missing_events.py --source wayback \
    --event-id 026b4f7049085842 --event-id 5a558ba1ff5e9121 \
    --target-fighter 399afbabc02376b5

  python scripts/backfill/backfill_missing_events.py --source wayback \
    --missing-limit 2

The automatic mode only selects completed, UFCStats-linked events that have
zero bout rows. Explicit mode can optionally scope each event to one fighter,
which is the preferred canary path: only that fighter's bout, result and round
stats are written while the full-card backfill remains untouched.
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
from common import SchemaAssertionError, now_iso  # noqa: E402
import parsers  # noqa: E402


class MissingEventsBackfill(Backfill):
    def __init__(self, args, event_ids: list[str], missing_limit: int | None,
                 target_fighter: str | None, verify_fighter: str | None,
                 expected_bouts: int | None):
        super().__init__(args)
        self.target_event_ids = list(dict.fromkeys(event_ids))
        self.missing_limit = missing_limit
        self.target_fighter = target_fighter
        self.verify_fighter = verify_fighter
        self.expected_bouts = expected_bouts

        # A bounded explicit repair should never spend minutes building the
        # full event/fight/fighter CDX family indexes. An empty in-memory index
        # tells WaybackClient to fall straight through to exact-URL CDX lookup
        # for each requested page, preserving capture validation and fallback.
        if self.target_event_ids and getattr(self.fetch, "wayback", None):
            for kind in ("events", "fights", "fighters"):
                self.fetch.wayback._index[kind] = {}
            self.log.event("wayback_lookup_mode", mode="exact_url", reason="explicit_event_targets")

    def _ingest_target_event(self, ev: dict):
        """Ingest one fighter's bout from an event, then enrich that fight page."""
        url = f"{self.cfg.base}/event-details/{ev['ufcstats_id']}"
        html = self._get("events", ev["ufcstats_id"], url, refresh=self.args.force)
        if html is None:
            return
        page = parsers.parse_event_page(html, url)
        matches = [
            b for b in page["bouts"]
            if self.target_fighter in (b.get("fighter_a_ufcstats_id"), b.get("fighter_b_ufcstats_id"))
        ]
        if len(matches) != 1:
            raise SchemaAssertionError(
                url,
                f"target fighter {self.target_fighter} matched {len(matches)} bouts (expected exactly 1)",
            )
        b = matches[0]
        fight_id = b.get("ufcstats_id")
        if not fight_id:
            raise SchemaAssertionError(url, f"target fighter {self.target_fighter} bout has no fight id")

        known = self.bout_by_ufcstats.get(fight_id)
        if known is not None:
            self.log.event("target_bout_present", event_id=ev["ufcstats_id"], fight_id=fight_id)
            if ev.get("card_status") == "complete":
                self._ingest_fight(fight_id)
            return

        fa = self._ingest_fighter(b["fighter_a_ufcstats_id"]) or self._stub_fighter(
            b["fighter_a_ufcstats_id"], b["fighter_a_name"], url
        )
        fb = self._ingest_fighter(b["fighter_b_ufcstats_id"]) or self._stub_fighter(
            b["fighter_b_ufcstats_id"], b["fighter_b_name"], url
        )
        wc = parsers.normalize_weight_class(b["weight_class_raw"], url)
        event_bouts = [x for x in self.bouts if x["event_id"] == ev["id"]]
        existing = next((
            x for x in event_bouts
            if not x.get("ufcstats_id")
            and {x["fighter_a_id"], x["fighter_b_id"]} == {fa["id"], fb["id"]}
        ), None)

        if existing:
            patch = {
                "ufcstats_id": fight_id,
                "weight_class": wc["weight_class"],
                "weight_class_raw": b["weight_class_raw"],
                "is_womens": wc["is_womens"],
                "is_title": wc["is_title"],
                "bout_order": b["bout_order"],
                "status": "complete" if ev.get("card_status") == "complete" else "announced",
                "updated_at": now_iso(),
            }
            self.db.patch("ufc_bouts", f"id=eq.{existing['id']}", patch)
            existing.update(patch)
            self.bout_by_ufcstats[fight_id] = existing
            bout = existing
            self.log.bump("bouts_linked")
            self.log.event("target_bout_linked", event_id=ev["ufcstats_id"], fight_id=fight_id)
        else:
            row = {
                "ufcstats_id": fight_id,
                "event_id": ev["id"],
                "fighter_a_id": fa["id"],
                "fighter_b_id": fb["id"],
                "weight_class": wc["weight_class"],
                "weight_class_raw": b["weight_class_raw"],
                "is_womens": wc["is_womens"],
                "is_title": wc["is_title"],
                "bout_order": b["bout_order"],
                "status": "complete" if ev.get("card_status") == "complete" else "announced",
                "source_url": url,
                "captured_at": now_iso(),
                "updated_at": now_iso(),
            }
            self.db.upsert("ufc_bouts", [row], on_conflict="ufcstats_id")
            self.log.bump("bouts_new")
            if self.args.dry_run:
                bout = {**row, "id": f"dry-{fight_id}"}
            else:
                rows = self.db.select_all(
                    "ufc_bouts",
                    "id,ufcstats_id,espn_competition_id,event_id,fighter_a_id,fighter_b_id,status",
                    f"ufcstats_id=eq.{fight_id}",
                )
                if len(rows) != 1:
                    raise RuntimeError(f"target bout {fight_id} was not readable after upsert")
                bout = rows[0]
            self.bouts.append(bout)
            self.bout_by_ufcstats[fight_id] = bout
            self.log.event("target_bout_inserted", event_id=ev["ufcstats_id"], fight_id=fight_id)

        if ev.get("card_status") == "complete":
            self._ingest_fight(fight_id)
        self.log.event("target_event_done", event_id=ev["ufcstats_id"], fight_id=fight_id)

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
            target_fighter=self.target_fighter,
            ids=[e.get("ufcstats_id") for e in targets],
        )
        for ev in targets:
            if self.target_fighter:
                self._ingest_target_event(ev)
            else:
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
    ap.add_argument("--target-fighter", help="when explicit event ids are supplied, ingest only this UFCStats fighter's bout from each event")
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
    if ns.target_fighter and not ns.event_id:
        ap.error("--target-fighter requires at least one --event-id")
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
        target_fighter=ns.target_fighter,
        verify_fighter=ns.verify_fighter,
        expected_bouts=ns.expected_bouts,
    ).run())


if __name__ == "__main__":
    main()
