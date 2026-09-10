#!/usr/bin/env python
"""
UFC Stats -> Supabase backfill. Resumable, batched, fails loudly.

  python backfill_ufcstats.py --phase {events|fighters|fights|all}
                              [--source wayback|live] [--since YYYY-MM-DD] [--limit N]
                              [--raw-to-r2] [--force] [--dry-run] [--offline]

Source defaults to wayback (Internet Archive captures, <=1 req/2s, backoff on
429, resumable via the local cache). ufcstats.com is not contacted in that
mode. A page with no archived capture is a COVERAGE GAP (counted, skipped);
Wayback answering 429/5xx past the retry budget is a SOURCE OUTAGE (the run
stops, the reason is persisted in ufc_ingest_runs.notes.last_error).

ESPN is the primary source for events/bouts/fighters/results (Worker). This
script LINKS UFC Stats ids onto rows that already exist and ENRICHES results:
  * event  : existing row without ufcstats_id dated within +-1 day -> patch
             ufcstats_id + location; two candidates -> EventMatchAmbiguous, skip
  * fighter: page parsed (name + DOB + record) -> shared/alias_resolver.
             matched -> patch ufcstats_id onto that row; review -> new
             ufcstats-first row AND ufc_alias_review_queue; unmatched -> new row.
  * bout   : existing bout on the event with the same fighter pair and no
             ufcstats_id -> patch; else insert.
  * result : existing ESPN result -> keep ESPN winner/method/round/time/
             result_source; add round stats, judges/scorecards, has_stats,
             stats_source_url/stats_captured_at (migration 002); log
             ResultMismatch loudly if UFC Stats disagrees. No result -> insert
             with result_source='ufcstats'. A fight page with no stats tables
             still counts as enriched (has_stats=false).

On any SchemaAssertionError: stop, print the URL, post to Discord, exit 2.
On WaybackUnavailable / AccessGateError: stop, persist the reason, exit 3.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))

from common import (AccessGateError, Config, Fetcher, RunLog, SchemaAssertionError,  # noqa: E402
                    Supabase, discord, now_iso)
from wayback import WaybackMissing, WaybackUnavailable  # noqa: E402
import parsers  # noqa: E402
import normalizers  # noqa: E402  (imported for the capability guard in main())
from alias_resolver import AliasResolver, FighterRef, alias_rows_for_fighter, normalize  # noqa: E402

WORKER = "backfill_ufcstats"
DEFERRED = object()   # identity deferred: do not create a fighter, do not write the bout
FIGHTER_COLS = "id,ufcstats_id,espn_athlete_id,name,nickname,dob,record_w,record_l,record_d"
RESULT_COLS = "bout_id,winner_id,method,round,time_sec,result_source,has_stats,referee,scorecards,finish_detail,time_format"


def _daydiff(a: str, b: str) -> int:
    return abs((dt.date.fromisoformat(a) - dt.date.fromisoformat(b)).days)


class Backfill:
    def __init__(self, args):
        self.args = args
        self.cfg = Config()
        self.log = RunLog(WORKER)
        self.fetch = Fetcher(self.cfg, self.log, raw_to_r2=args.raw_to_r2, offline=args.offline, source=args.source)
        self.missing: list[dict] = []
        self.db = Supabase(self.cfg, self.log, dry_run=args.dry_run)
        self.fighters: dict[str, dict] = {}
        self.fighter_by_ufcstats: dict[str, dict] = {}
        self.events: list[dict] = []
        self.event_by_ufcstats: dict[str, dict] = {}
        self.bouts: list[dict] = []
        self.bout_by_ufcstats: dict[str, dict] = {}
        self.results: dict[str, dict] = {}            # bout_id -> result row (RESULT_COLS)
        self.resolver = AliasResolver([])
        self.run_id = None
        self.enrich_cols = False                       # migration 002 applied?
        self.last_error: dict | None = None

    # -- run ledger ---------------------------------------------------------
    def start_run(self):
        if self.args.dry_run:
            return
        self.cfg.require_supabase()
        r = self.db._request("POST", "ufc_ingest_runs", headers=self.db._headers({"Prefer": "return=representation"}),
                             data=json.dumps({"worker": WORKER, "status": "running", "notes": {"phase": self.args.phase, "log": str(self.log.path)}}))
        self.run_id = r.json()[0]["id"]

    def finish_run(self, status: str):
        if self.args.dry_run or not self.run_id:
            return
        c = self.log.counters
        wb = self.fetch.wayback.status() if self.fetch.wayback else None
        notes = {"phase": self.args.phase, "source": self.args.source, "since": self.args.since, "limit": self.args.limit,
                 "counters": c, "log": str(self.log.path), "wayback": wb, "wayback_missing": self.missing[:2000],
                 "enrichment_columns": self.enrich_cols}
        if self.last_error:
            notes["last_error"] = self.last_error
        try:
            self.db.patch("ufc_ingest_runs", f"id=eq.{self.run_id}", {
                "finished_at": now_iso(), "status": status,
                "events_new": c.get("events_new", 0), "bouts_new": c.get("bouts_new", 0), "fighters_touched": c.get("fighters_touched", 0),
                "assertion_failures": self.log.assertion_failures, "notes": notes,
            })
        except Exception as e:  # the ledger must never be the reason a reason is lost
            self.log.event("LEDGER_WRITE_FAILED", error=str(e)[:300])

    def _record_error(self, e: BaseException, cls: str | None = None):
        wb = self.fetch.wayback
        self.last_error = {
            "class": cls or type(e).__name__,
            "message": str(e)[:500],
            "url": getattr(e, "url", None),
            "http_status": getattr(e, "http_status", None) or (wb.last_status if wb else None),
            "retries": getattr(e, "retries", None) or (wb.retries if wb else None),
            "last_source_response_class": wb.last_response_class if wb else None,
            "log_path": str(self.log.path),
            "at": now_iso(),
            "traceback_tail": traceback.format_exc()[-1200:],
        }

    # -- context ------------------------------------------------------------
    def load_existing(self):
        if not self.cfg.supabase_key:
            self.log.event("dry_run", note="no Supabase key; linking against an empty archive")
            return
        self.enrich_cols = self.db.has_column("ufc_bout_results", "stats_captured_at")
        for row in self.db.select_all("ufc_fighters", FIGHTER_COLS):
            self._register_fighter(row)
        self.events = self.db.select_all("ufc_events", "id,ufcstats_id,espn_event_id,name,event_date,card_status")
        self.event_by_ufcstats = {e["ufcstats_id"]: e for e in self.events if e["ufcstats_id"]}
        self.bouts = self.db.select_all("ufc_bouts", "id,ufcstats_id,espn_competition_id,event_id,fighter_a_id,fighter_b_id,status")
        self.bout_by_ufcstats = {b["ufcstats_id"]: b for b in self.bouts if b["ufcstats_id"]}
        cols = RESULT_COLS + (",stats_captured_at,stats_source_url" if self.enrich_cols else "")
        self.results = {r["bout_id"]: r for r in self.db.select_all("ufc_bout_results", cols)}
        self.log.event("existing", fighters=len(self.fighters), events=len(self.events), bouts=len(self.bouts), results=len(self.results),
                       enrichment_columns=self.enrich_cols)

    def _register_fighter(self, row: dict):
        self.fighters[row["id"]] = row
        if row.get("ufcstats_id"):
            self.fighter_by_ufcstats[row["ufcstats_id"]] = row
        rec = None if row.get("record_w") is None else f"{row['record_w']}-{row.get('record_l') or 0}-{row.get('record_d') or 0}"
        self.resolver.add(FighterRef(id=row["id"], ufcstats_id=row.get("ufcstats_id"), name=row["name"], nickname=row.get("nickname"),
                                     dob=row.get("dob"), record=rec))

    def _missing(self, kind: str, key: str, url: str):
        self.missing.append({"kind": kind, "id": key, "url": url})
        self.log.bump(f"wayback_missing_{kind}")
        self.log.event("wayback_missing", page_kind=kind, id=key, url=url)

    def _get(self, kind: str, key: str, url: str, refresh: bool = False, bad_capture=None, min_ts: str | None = None):
        """HTML or None (coverage gap). WaybackUnavailable propagates: an outage stops the run."""
        try:
            return self.fetch.get(kind, key, url, refresh=refresh, bad_capture=bad_capture, min_ts=min_ts)[0]
        except WaybackMissing:
            self._missing(kind, key, url)
            return None

    def _enriched(self, res: dict | None) -> bool:
        """Has the UFC Stats fight page been ingested for this result?"""
        if not res:
            return False
        if self.enrich_cols:
            return res.get("stats_captured_at") is not None
        return bool(res.get("has_stats")) or res.get("result_source") == "ufcstats"

    # -- fighters -----------------------------------------------------------
    def phase_fighters(self):
        listed, rows = 0, []
        for ch in "abcdefghijklmnopqrstuvwxyz":
            url = f"{self.cfg.base}/statistics/fighters?char={ch}&page=all"
            html = self._get("lists", f"fighters_{ch}", url, refresh=self.args.force and self.args.source == "live")
            if html is None:
                continue
            for f in parsers.parse_fighter_list(html, url):
                listed += 1
                if f["ufcstats_id"] in self.fighter_by_ufcstats and not self.args.force:
                    continue
                name = f"{f['first']} {f['last']}".strip()
                if any(self.fighters[i].get("ufcstats_id") is None for i in self.resolver.by_norm.get(normalize(name), ())):
                    self.log.bump("fighters_deferred_to_page")   # same-name ESPN-first row: resolve with DOB at page level
                    continue
                rows.append({"ufcstats_id": f["ufcstats_id"], "name": name, "nickname": f.get("nickname"),
                             "height_in": f.get("height_in"), "weight_lbs": f.get("weight_lbs"), "reach_in": f.get("reach_in"), "stance": f.get("stance"),
                             "record_w": f.get("record_w"), "record_l": f.get("record_l"), "record_d": f.get("record_d"),
                             "source_url": url, "captured_at": now_iso(), "updated_at": now_iso()})
        self.log.event("fighter_list", listed=listed, new=len(rows))
        self.db.upsert("ufc_fighters", rows, on_conflict="ufcstats_id")
        self.log.bump("fighters_touched", len(rows))
        if self.args.dry_run or not rows:
            return
        ids = {r["ufcstats_id"] for r in rows}
        for row in self.db.select_all("ufc_fighters", FIGHTER_COLS):
            if row["ufcstats_id"] in ids and row["id"] not in self.fighters:
                self._register_fighter(row)
        alias_rows = []
        for r in rows:
            fid = self.fighter_by_ufcstats.get(r["ufcstats_id"], {}).get("id")
            if fid:
                alias_rows += alias_rows_for_fighter(fid, r["name"], r.get("nickname"))
        self.db.upsert("ufc_fighter_aliases", alias_rows, on_conflict="fighter_id,source,normalized")

    def _ingest_fighter(self, fighter_id: str, event_scope: list | None = None):
        """Row, None (no page), or DEFERRED (identity blocked only by a DOB
        disagreement: never a reason to create a second fighter)."""
        known = self.fighter_by_ufcstats.get(fighter_id)
        if known and known.get("dob") is not None and not self.args.force:
            return known
        url = f"{self.cfg.base}/fighter-details/{fighter_id}"
        html = self._get("fighters", fighter_id, url, refresh=self.args.force)
        if html is None:
            return known
        p = parsers.parse_fighter_page(html, url)
        history_ids = p.pop("history_fight_ids")
        upcoming_rows = p.pop("upcoming_rows", 0)
        self.log.event("fighter_page", id=fighter_id, name=p["name"], history_rows=len(history_ids), upcoming_rows=upcoming_rows)
        fields = {k: v for k, v in p.items() if k != "ufcstats_id"}
        fields["updated_at"] = now_iso()
        target = known
        if target is None:
            record = f"{p['record_w']}-{p['record_l']}-{p['record_d']}"
            res = self.resolver.resolve(p["name"], "ufcstats", ufcstats_id=fighter_id, dob=p["dob"], record=record,
                                        event_scope=event_scope)
            target = self.fighters.get(res.fighter_id) if res.status == "matched" else None
            if res.status == "matched":
                self.log.event("fighter_linked", ufcstats_id=fighter_id, fighter_id=res.fighter_id, method=res.method, name=p["name"],
                               dob_conflict=res.dob_conflict, ufcstats_dob=p["dob"], stored_dob=(target or {}).get("dob"))
                if res.dob_conflict:
                    self.log.bump("dob_conflicts_linked_on_bout_evidence")
            if res.status == "review" and res.review_row:
                res.review_row["context"].update({"ufcstats_id": fighter_id, "url": url})
                self._queue_review_once(res.review_row)
                if res.dob_conflict:
                    # ESPN and UFC Stats disagree on the birth date of a fighter
                    # the name already matches. Creating a second row here is how
                    # the duplicate fighters (and then duplicate bouts) were made.
                    self.log.event("fighter_deferred_dob_conflict", ufcstats_id=fighter_id, name=p["name"], dob=p["dob"])
                    self.log.bump("fighters_deferred_dob_conflict")
                    return DEFERRED
        if self.args.dry_run:
            self.log.event("dry_run_fighter", id=fighter_id, action="link" if target else "insert", name=p["name"])
            row = target or {"id": f"dry-{fighter_id}", "ufcstats_id": fighter_id, "name": p["name"], "dob": p["dob"],
                             "record_w": p["record_w"], "record_l": p["record_l"], "record_d": p["record_d"]}
            if not target:
                self._register_fighter(row)
            else:
                target["ufcstats_id"] = fighter_id
                self.fighter_by_ufcstats[fighter_id] = target
            return row
        if target:
            self.db.patch("ufc_fighters", f"id=eq.{target['id']}", {"ufcstats_id": fighter_id, **fields})
            target.update({"ufcstats_id": fighter_id, **fields})
            self.fighter_by_ufcstats[fighter_id] = target
            self.log.bump("fighters_linked")
            row = target
        else:
            r = self.db._request("POST", "ufc_fighters", headers=self.db._headers({"Prefer": "return=representation"}),
                                 data=json.dumps({"ufcstats_id": fighter_id, **fields, "source_url": url, "captured_at": now_iso()}, default=str))
            row = r.json()[0]
            self._register_fighter(row)
            self.log.bump("fighters_inserted")
        self.db.upsert("ufc_fighter_aliases", alias_rows_for_fighter(row["id"], p["name"], p.get("nickname")), on_conflict="fighter_id,source,normalized")
        self.log.bump("fighters_touched")
        return row

    def _stub_fighter(self, fighter_id: str, name: str, from_url: str, event_scope: list | None = None) -> dict:
        """The fighter page has no archived capture. Create a ufcstats-keyed row from the
        event page (name only) so the bout can exist. NEVER merged by name alone: a
        same-name row without a ufcstats_id goes to the review queue instead, and the stub
        stays separate until a human (or a later page capture with DOB) resolves it.
        The exception is bout evidence: exactly one fighter on this card carries the
        name, which is identity, so that row is linked instead of stubbing a duplicate."""
        res = self.resolver.resolve(name, "ufcstats", ufcstats_id=fighter_id, event_scope=event_scope)
        if res.status == "matched" and res.method == "event_scoped_name":
            target = self.fighters[res.fighter_id]
            if not self.args.dry_run:
                self.db.patch("ufc_fighters", f"id=eq.{target['id']}", {"ufcstats_id": fighter_id, "updated_at": now_iso()})
            target["ufcstats_id"] = fighter_id
            self.fighter_by_ufcstats[fighter_id] = target
            self.log.event("fighter_linked", ufcstats_id=fighter_id, fighter_id=target["id"], method=res.method, name=name, stub=True)
            self.log.bump("fighters_linked")
            return target
        if res.status == "review" and res.review_row:
            res.review_row["context"].update({"ufcstats_id": fighter_id, "url": from_url, "reason": "stub_without_page"})
            self._queue_review_once(res.review_row)
        row = {"ufcstats_id": fighter_id, "name": name, "source_url": from_url, "captured_at": now_iso(), "updated_at": now_iso()}
        if self.args.dry_run:
            row = {**row, "id": f"dry-{fighter_id}"}
        else:
            r = self.db._request("POST", "ufc_fighters", headers=self.db._headers({"Prefer": "return=representation"}), data=json.dumps(row))
            row = r.json()[0]
        self._register_fighter(row)
        self.log.bump("fighters_stubbed")
        self.log.event("fighter_stub", ufcstats_id=fighter_id, name=name, review=res.status == "review")
        return row

    def _queue_review_once(self, row: dict):
        """One open review item per (name, source): re-runs must not bury the
        queue in copies of one question."""
        if self.args.dry_run or not self.cfg.supabase_key:
            self.log.bump("review_queued")
            return
        from urllib.parse import quote
        existing = self.db.select_all("ufc_alias_review_queue", "id",
                                      f"raw_name=eq.{quote(row['raw_name'])}&source=eq.{quote(row['source'])}&resolved_at=is.null")
        if existing:
            self.log.bump("review_deduplicated")
            return
        self.db.insert("ufc_alias_review_queue", [row])
        self.log.bump("review_queued")

    def _corner(self, fighter_id: str, name: str, url: str, scope: list):
        """Our fighter row for one corner of a UFC Stats bout, or None when identity
        is deferred (the bout is then skipped, not written against a duplicate)."""
        row = self._ingest_fighter(fighter_id, event_scope=scope)
        if row is DEFERRED:
            return None
        return row or self._stub_fighter(fighter_id, name, url, event_scope=scope)

    # -- events -------------------------------------------------------------
    def phase_events(self):
        for status, path, slug in (("complete", "/statistics/events/completed?page=all", "completed"),
                                   ("announced", "/statistics/events/upcoming", "upcoming")):
            url = f"{self.cfg.base}{path}"
            html = self._get("lists", slug, url, refresh=self.args.source == "live")
            if html is None:
                continue
            events = parsers.parse_event_list(html, url)
            if self.args.since:
                events = [e for e in events if e["event_date"] and e["event_date"] >= self.args.since]
            if self.args.limit:
                events = events[: self.args.limit]
            new, linked = [], 0
            for e in events:
                if e["ufcstats_id"] in self.event_by_ufcstats and not self.args.force:
                    continue
                cands = [x for x in self.events if not x.get("ufcstats_id") and x.get("event_date") and _daydiff(x["event_date"], e["event_date"]) <= 1]
                if len(cands) == 1:
                    x = cands[0]
                    self.db.patch("ufc_events", f"id=eq.{x['id']}", {"ufcstats_id": e["ufcstats_id"], "location_raw": e["location_raw"], "updated_at": now_iso()})
                    x["ufcstats_id"] = e["ufcstats_id"]
                    self.event_by_ufcstats[e["ufcstats_id"]] = x
                    linked += 1
                    self.log.event("event_linked", ufcstats_id=e["ufcstats_id"], espn_event_id=x.get("espn_event_id"), name=e["name"])
                elif len(cands) > 1:
                    self.log.assertion_failures.append({"class": "EventMatchAmbiguous", "url": url,
                                                        "detail": f"{e['name']} {e['event_date']} matches {len(cands)} ESPN events", "at": now_iso()})
                    self.log.event("event_ambiguous", name=e["name"], candidates=len(cands))
                else:
                    new.append({**self._event_row(e), "card_status": status})
            self.log.event("event_list", which=slug, listed=len(events), new=len(new), linked=linked)
            self.db.upsert("ufc_events", new, on_conflict="ufcstats_id")
            self.log.bump("events_new", len(new))
            self.log.bump("events_linked", linked)
            if self.args.dry_run:
                for row in new:
                    self.events.append({**row, "id": f"dry-{row['ufcstats_id']}"})
                    self.event_by_ufcstats[row["ufcstats_id"]] = self.events[-1]
        if not self.args.dry_run and self.cfg.supabase_key:
            self.events = self.db.select_all("ufc_events", "id,ufcstats_id,espn_event_id,name,event_date,card_status")
            self.event_by_ufcstats = {e["ufcstats_id"]: e for e in self.events if e["ufcstats_id"]}

    def _event_row(self, e: dict) -> dict:
        parts = [p.strip() for p in (e.get("location_raw") or "").split(",")]
        return {"ufcstats_id": e["ufcstats_id"], "name": e["name"], "event_date": e["event_date"],
                "city": parts[0] if parts and parts[0] else None, "region": parts[1] if len(parts) >= 3 else None,
                "country": parts[-1] if len(parts) >= 2 else None, "location_raw": e.get("location_raw"),
                "source_url": f"{self.cfg.base}/event-details/{e['ufcstats_id']}", "captured_at": now_iso(), "updated_at": now_iso()}

    # -- fights -------------------------------------------------------------
    def phase_fights(self):
        events = [e for e in self.events if e.get("ufcstats_id")]
        events.sort(key=lambda e: e.get("event_date") or "", reverse=True)
        if self.args.since:
            events = [e for e in events if e["event_date"] and e["event_date"] >= self.args.since]
        if getattr(self.args, "until", None):
            events = [e for e in events if e["event_date"] and e["event_date"] <= self.args.until]
        if self.args.limit:
            events = events[: self.args.limit]
        self.log.event("fights_phase", events=len(events))
        for ev in events:
            self._ingest_event(ev)

    def _event_needs_work(self, bouts: list[dict]) -> bool:
        for b in bouts:
            row = self.bout_by_ufcstats.get(b.get("ufcstats_id"))
            if row is None or not self._enriched(self.results.get(row["id"])):
                return True
        return False

    def _ingest_event(self, ev: dict):
        url = f"{self.cfg.base}/event-details/{ev['ufcstats_id']}"
        html = self._get("events", ev["ufcstats_id"], url, refresh=self.args.force or ev.get("card_status") != "complete")
        if html is None:
            return
        page = parsers.parse_event_page(html, url)
        bouts = page["bouts"]
        if not self.args.force and not self._event_needs_work(bouts):
            self.log.event("event_skip", id=ev["ufcstats_id"], reason="every bout present and UFC Stats-enriched")
            self.log.bump("events_skipped_enriched")
            return
        event_bouts = [b for b in self.bouts if b["event_id"] == ev["id"]]
        # Bout evidence for identity: the fighters already on this card (ESPN-first
        # rows). A UFC Stats fighter whose name matches exactly one of them IS that
        # fighter, whatever the two sources say about a birth date.
        scope = sorted({fid for x in event_bouts for fid in (x["fighter_a_id"], x["fighter_b_id"]) if fid})
        new_rows, linked = [], 0
        for b in bouts:
            if b.get("ufcstats_id") in self.bout_by_ufcstats and not self.args.force:
                continue
            fa = self._corner(b["fighter_a_ufcstats_id"], b["fighter_a_name"], url, scope)
            fb = self._corner(b["fighter_b_ufcstats_id"], b["fighter_b_name"], url, scope)
            if fa is None or fb is None:
                self.log.bump("bouts_deferred_identity")
                self.log.event("bout_deferred_identity", ufcstats_id=b.get("ufcstats_id"), fighters=[b["fighter_a_name"], b["fighter_b_name"]])
                continue
            wc = parsers.normalize_weight_class(b["weight_class_raw"], url)
            existing = next((x for x in event_bouts if not x.get("ufcstats_id") and {x["fighter_a_id"], x["fighter_b_id"]} == {fa["id"], fb["id"]}), None)
            if existing:
                self.db.patch("ufc_bouts", f"id=eq.{existing['id']}", {"ufcstats_id": b["ufcstats_id"], "weight_class_raw": b["weight_class_raw"], "updated_at": now_iso()})
                existing["ufcstats_id"] = b["ufcstats_id"]
                self.bout_by_ufcstats[b["ufcstats_id"]] = existing
                linked += 1
                self.log.event("bout_linked", ufcstats_id=b["ufcstats_id"], espn_competition_id=existing.get("espn_competition_id"))
            else:
                new_rows.append({
                    "ufcstats_id": b.get("ufcstats_id"), "event_id": ev["id"], "fighter_a_id": fa["id"], "fighter_b_id": fb["id"],
                    "weight_class": wc["weight_class"], "weight_class_raw": b["weight_class_raw"], "is_womens": wc["is_womens"], "is_title": wc["is_title"],
                    "bout_order": b["bout_order"], "status": "complete" if ev.get("card_status") == "complete" else "announced",
                    "source_url": url, "captured_at": now_iso(), "updated_at": now_iso(),
                })
        self.db.upsert("ufc_bouts", new_rows, on_conflict="ufcstats_id")
        self.log.bump("bouts_new", len(new_rows))
        self.log.bump("bouts_linked", linked)
        if self.args.dry_run:
            for row in new_rows:
                self.bout_by_ufcstats[row["ufcstats_id"]] = {**row, "id": f"dry-{row['ufcstats_id']}"}
        elif new_rows:
            for row in self.db.select_all("ufc_bouts", "id,ufcstats_id,espn_competition_id,event_id,fighter_a_id,fighter_b_id,status", f"event_id=eq.{ev['id']}"):
                if row["ufcstats_id"] and row["ufcstats_id"] not in self.bout_by_ufcstats:
                    self.bouts.append(row)
                    self.bout_by_ufcstats[row["ufcstats_id"]] = row
        if ev.get("card_status") != "complete":
            return
        for b in bouts:
            if b.get("ufcstats_id"):
                self._ingest_fight(b["ufcstats_id"], event_date=ev.get("event_date"))
        self.log.event("event_done", id=ev["ufcstats_id"], bouts=len(bouts), new=len(new_rows), linked=linked)

    def _ingest_fight(self, fight_id: str, event_date: str | None = None):
        bout = self.bout_by_ufcstats.get(fight_id)
        if bout is None:
            self.log.bump("fights_without_bout_row")
            return
        existing = self.results.get(bout["id"])
        if self._enriched(existing) and not self.args.force:
            self.log.bump("fights_skipped_enriched")
            return
        url = f"{self.cfg.base}/fight-details/{fight_id}"
        # A capture older than the event is a matchup preview, never a result.
        min_ts = event_date.replace("-", "") if event_date else None
        html = self._get("fights", fight_id, url, refresh=self.args.force,
                         bad_capture=parsers.is_pre_result_fight_page, min_ts=min_ts)
        if html is None:
            return
        if parsers.is_pre_result_fight_page(html):
            # Cached under the earlier rule, before previews were rejected.
            self.fetch.drop_cached("fights", fight_id)
            self.log.event("fight_preview_capture", id=fight_id, url=url)
            self._missing("fights", fight_id, url)
            return
        f = parsers.parse_fight_page(html, url)
        winner_row = self.fighter_by_ufcstats.get(f["winner_ufcstats_id"]) if f["winner_ufcstats_id"] else None
        sc = f["scorecards"] or []
        judges = {"judge_1": sc[0]["judge"] if len(sc) > 0 else None, "judge_2": sc[1]["judge"] if len(sc) > 1 else None, "judge_3": sc[2]["judge"] if len(sc) > 2 else None}
        enrich_marks = {"stats_source_url": url, "stats_captured_at": now_iso()} if self.enrich_cols else {}
        if existing and existing.get("result_source") == "espn":
            # ESPN stays primary. Reconcile, never overwrite.
            diffs = []
            if existing.get("winner_id") != (winner_row["id"] if winner_row else None):
                diffs.append(f"winner espn={existing.get('winner_id')} ufcstats={winner_row['id'] if winner_row else None}")
            if existing.get("method") != f["method"]:
                diffs.append(f"method espn={existing.get('method')} ufcstats={f['method']}")
            if existing.get("round") != f["round"]:
                diffs.append(f"round espn={existing.get('round')} ufcstats={f['round']}")
            if existing.get("time_sec") != f["time_sec"]:
                diffs.append(f"time espn={existing.get('time_sec')} ufcstats={f['time_sec']}")
            if diffs:
                self.log.assertion_failures.append({"class": "ResultMismatch", "url": url, "detail": "; ".join(diffs), "at": now_iso()})
                self.log.event("RESULT_MISMATCH", url=url, detail="; ".join(diffs))
                self.log.bump("result_mismatches")
            patch = {"has_stats": f["has_stats"], "scorecards": f["scorecards"], **judges, **enrich_marks}
            if not existing.get("referee") and f["referee"]:
                patch["referee"] = f["referee"]
            if not existing.get("finish_detail") and f["finish_detail"]:
                patch["finish_detail"] = f["finish_detail"]
            if not existing.get("time_format") and f["time_format"]:
                patch["time_format"] = f["time_format"]
            self.db.patch("ufc_bout_results", f"bout_id=eq.{bout['id']}", patch)
            existing.update(patch)
            self.log.bump("results_enriched")
        else:
            row = {
                "bout_id": bout["id"], "winner_id": winner_row["id"] if winner_row else None,
                "method": f["method"], "method_raw": f["method_raw"], "round": f["round"], "time_sec": f["time_sec"], "time_format": f["time_format"],
                "referee": f["referee"], **judges, "scorecards": f["scorecards"], "finish_detail": f["finish_detail"],
                "has_stats": f["has_stats"], "result_source": "ufcstats", "source_url": url, "captured_at": now_iso(), **enrich_marks,
            }
            self.db.upsert("ufc_bout_results", [row], on_conflict="bout_id")
            self.results[bout["id"]] = row
            self.log.bump("results_written")
        self.db.patch("ufc_bouts", f"id=eq.{bout['id']}", {"scheduled_rounds": f["scheduled_rounds"], "is_title": f["is_title"], "status": "complete", "updated_at": now_iso()})
        rounds = []
        for r in f["rounds"]:
            fr = self.fighter_by_ufcstats.get(r["fighter_ufcstats_id"])
            if fr is None:
                raise SchemaAssertionError(url, f"round stats for unknown fighter {r['fighter_ufcstats_id']}")
            rounds.append({**{k: v for k, v in r.items() if k != "fighter_ufcstats_id"}, "bout_id": bout["id"], "fighter_id": fr["id"],
                           "source_url": url, "captured_at": now_iso()})
        self.db.upsert("ufc_bout_round_stats", rounds, on_conflict="bout_id,fighter_id,round")
        self.log.bump("round_rows", len(rounds))
        self.log.bump("fights_enriched")
        if not f["has_stats"]:
            self.log.bump("results_without_stats")

    # -- main ---------------------------------------------------------------
    def run(self) -> int:
        self.log.event("start", phase=self.args.phase, source=self.args.source, since=self.args.since, limit=self.args.limit,
                       dry_run=self.args.dry_run, offline=self.args.offline, r2=self.args.raw_to_r2)
        status, code = "success", 0
        try:
            self.start_run()
            self.load_existing()
            if self.args.phase in ("fighters", "all"):
                self.phase_fighters()
            if self.args.phase in ("events", "all"):
                self.phase_events()
            if self.args.phase in ("fights", "all"):
                self.phase_fights()
        except SchemaAssertionError as e:
            self.log.assertion(e.url, e.detail)
            self._record_error(e, "SchemaAssertionError")
            discord(self.cfg, f"**{WORKER} STOPPED** schema assertion failed\n`{e.detail}`\n{e.url}", loud=True)
            status, code = "failed", 2
        except (WaybackUnavailable, AccessGateError) as e:
            self._record_error(e)
            self.log.event("SOURCE_UNAVAILABLE", **{k: v for k, v in self.last_error.items() if k != "traceback_tail"})
            discord(self.cfg, f"**{WORKER} STOPPED** source unavailable: {str(e)[:300]}", loud=True)
            status, code = "failed", 3
        except Exception as e:
            self._record_error(e)
            self.log.event("CRASH", traceback=traceback.format_exc())
            discord(self.cfg, f"**{WORKER} CRASHED**\n```{traceback.format_exc()[-800:]}```", loud=True)
            status, code = "failed", 1
        finally:
            self.finish_run(status)
            s = self.log.summary()
            self.log.event("end", status=status, **s["counters"])
            if code == 0 and not self.args.dry_run:
                c = s["counters"]
                discord(self.cfg, f"{WORKER} ok: events_new={c.get('events_new', 0)} bouts_new={c.get('bouts_new', 0)} "
                                  f"fighters_touched={c.get('fighters_touched', 0)} fights_enriched={c.get('fights_enriched', 0)} rounds={c.get('round_rows', 0)} "
                                  f"no_stats={c.get('results_without_stats', 0)} mismatches={c.get('result_mismatches', 0)} "
                                  f"missing={sum(v for k, v in c.items() if k.startswith('wayback_missing'))}")
        return code


def _assert_normalizer_capable() -> None:
    """Refuse to run against a normaliser that cannot resolve labels we know about.

    The guard belongs here rather than in a launcher script. There are four
    copies of this tree on a working machine and Python imports the
    normalizers.py sitting beside whichever copy of this file is executed, so
    the launcher is not what decides which normaliser gets used - this file's
    location is. A guard in one launcher protects one launcher; a guard here
    protects every way of starting a run, including a hand-typed one.

    What it prevents: a run that fetches for an hour and then dies on
    "Ultimate Ultimate '96 Tournament Title Bout" or the TUF Nations final,
    labels that four windows already died on and that are fixed in the copies
    which declare these capabilities. Failing on the first line with the reason
    is strictly better than failing on the sixth window without it.

    Absence of the declaration is itself the failure: a normaliser too old to
    say what it can do is too old to have the rescues.
    """
    required = {
        "tuf-matchup-prefix": "TUF international finals; stopped window B-2014",
        "early-series": "Ultimate Ultimate / Ultimate Japan cards; stopped B-1995, B-1996, B-1997, B-1999",
        "bracket-round": "tournament round labels such as 'Alternate Bout'",
    }
    have = set(getattr(normalizers, "NORMALIZER_CAPABILITIES", ()) or ())
    missing = sorted(name for name in required if name not in have)
    if not missing:
        return
    where = getattr(normalizers, "__file__", "<unknown>")
    print(f"[normalizer_check] FAIL {where}", file=sys.stderr)
    print("  missing capabilities this repository depends on:", file=sys.stderr)
    for name in missing:
        print(f"    - {name}: {required[name]}", file=sys.stderr)
    print("  refusing to start: this run would fail on labels that are already fixed elsewhere.", file=sys.stderr)
    sys.exit(2)


def main():
    _assert_normalizer_capable()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", choices=["events", "fighters", "fights", "all"], required=True)
    ap.add_argument("--source", choices=["wayback", "live"], default="wayback",
                    help="wayback (default): Internet Archive captures; live: ufcstats.com (aborts on JS challenge)")
    ap.add_argument("--since", help="YYYY-MM-DD; only events on/after this date")
    ap.add_argument("--until", help="YYYY-MM-DD; only events on/before this date. Events are walked newest-first, so a closed window is the only way to target a specific historical year without paying for newer, often un-archived pages first.")
    ap.add_argument("--limit", type=int, help="max events to process")
    ap.add_argument("--raw-to-r2", action="store_true", help="also store raw HTML to R2 ufc-raw/{kind}/{id}.html")
    ap.add_argument("--force", action="store_true", help="re-fetch and re-write rows that already exist")
    ap.add_argument("--dry-run", action="store_true", help="parse and count, write nothing")
    ap.add_argument("--offline", action="store_true", help="never hit the network; parse the local cache only")
    args = ap.parse_args()
    if args.since:
        dt.date.fromisoformat(args.since)
    sys.exit(Backfill(args).run())


if __name__ == "__main__":
    main()
