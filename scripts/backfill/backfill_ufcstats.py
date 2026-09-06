#!/usr/bin/env python
"""
UFC Stats -> Supabase backfill. Resumable, batched, fails loudly.

  python backfill_ufcstats.py --phase {events|fighters|fights|all}
                              [--source wayback|live] [--since YYYY-MM-DD] [--limit N]
                              [--raw-to-r2] [--force] [--dry-run] [--offline]

Source defaults to wayback (Internet Archive captures, <=1 req/2s, backoff on
429, resumable via the local cache). ufcstats.com is not contacted in that
mode. Pages with no archived capture are counted (wayback_missing_*) and
skipped; the verification report lists them as coverage gaps.

Order (brief): fighters list -> events list -> per event: bouts -> per bout:
fight page -> touch both fighter pages if not yet fetched.

Resumable: any ufcstats_id already present in Supabase is skipped unless
--force. --offline parses only what is in the local HTML cache (re-parse
without re-scraping). --dry-run parses and prints counts, writes nothing.

On any SchemaAssertionError: stop, print the URL, post to Discord, exit 2.
On AccessGateError (JS challenge): stop, exit 3, nothing written.
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))

from common import (AccessGateError, Config, Fetcher, RunLog, SchemaAssertionError,  # noqa: E402
                    Supabase, discord, now_iso)
from wayback import WaybackMissing  # noqa: E402
import parsers  # noqa: E402
from alias_resolver import alias_rows_for_fighter  # noqa: E402

WORKER = "backfill_ufcstats"


class Backfill:
    def __init__(self, args):
        self.args = args
        self.cfg = Config()
        self.log = RunLog(WORKER)
        self.fetch = Fetcher(self.cfg, self.log, raw_to_r2=args.raw_to_r2, offline=args.offline, source=args.source)
        self.missing: list[dict] = []   # wayback coverage gaps
        self.db = Supabase(self.cfg, self.log, dry_run=args.dry_run)
        # ufcstats_id -> uuid maps, loaded once, extended as we write
        self.fighter_ids: dict[str, str] = {}
        self.event_ids: dict[str, str] = {}
        self.bout_ids: dict[str, str] = {}
        self.fighters_detailed: set[str] = set()
        self.run_id = None

    # -- run ledger ---------------------------------------------------------
    def start_run(self):
        if self.args.dry_run:
            return
        self.cfg.require_supabase()
        r = self.db._request("POST", "ufc_ingest_runs", headers=self.db._headers({"Prefer": "return=representation"}),
                             data='{"worker":"%s","status":"running"}' % WORKER)
        self.run_id = r.json()[0]["id"]

    def finish_run(self, status: str):
        if self.args.dry_run or not self.run_id:
            return
        c = self.log.counters
        self.db.patch("ufc_ingest_runs", f"id=eq.{self.run_id}", {
            "finished_at": now_iso(), "status": status,
            "events_new": c.get("events_new", 0), "bouts_new": c.get("bouts_new", 0),
            "fighters_touched": c.get("fighters_touched", 0),
            "assertion_failures": self.log.assertion_failures,
            "notes": {"phase": self.args.phase, "source": self.args.source, "since": self.args.since,
                      "limit": self.args.limit, "counters": c, "log": str(self.log.path),
                      "wayback_missing": self.missing[:2000]},
        })

    def load_existing(self):
        if self.args.dry_run and not self.cfg.supabase_key:
            self.log.event("dry_run", note="no Supabase key; resumability check skipped")
            return
        for row in self.db.select_all("ufc_fighters", "id,ufcstats_id,dob,captured_at"):
            self.fighter_ids[row["ufcstats_id"]] = row["id"]
            if row.get("dob") is not None:      # list rows never carry dob; a dob means the fighter page was parsed
                self.fighters_detailed.add(row["ufcstats_id"])
        for row in self.db.select_all("ufc_events", "id,ufcstats_id"):
            self.event_ids[row["ufcstats_id"]] = row["id"]
        for row in self.db.select_all("ufc_bouts", "id,ufcstats_id", "ufcstats_id=not.is.null"):
            self.bout_ids[row["ufcstats_id"]] = row["id"]
        self.log.event("existing", fighters=len(self.fighter_ids), events=len(self.event_ids), bouts=len(self.bout_ids))

    # -- phases -------------------------------------------------------------
    def phase_fighters(self):
        rows = []
        for ch in "abcdefghijklmnopqrstuvwxyz":
            url = f"{self.cfg.base}/statistics/fighters?char={ch}&page=all"
            html, _ = self.fetch.get("lists", f"fighters_{ch}", url, refresh=self.args.force)
            for f in parsers.parse_fighter_list(html, url):
                rows.append({
                    "ufcstats_id": f["ufcstats_id"],
                    "name": f"{f['first']} {f['last']}".strip(),
                    "nickname": f.get("nickname") or None,
                    "height_in": f.get("height_in"), "weight_lbs": f.get("weight_lbs"),
                    "reach_in": f.get("reach_in"), "stance": f.get("stance"),
                    "record_w": f.get("record_w"), "record_l": f.get("record_l"), "record_d": f.get("record_d"),
                    "source_url": url, "captured_at": now_iso(), "updated_at": now_iso(),
                })
        self.log.event("fighter_list", rows=len(rows))
        new = [r for r in rows if self.args.force or r["ufcstats_id"] not in self.fighter_ids]
        self.db.upsert("ufc_fighters", new, on_conflict="ufcstats_id")
        self.log.bump("fighters_touched", len(new))
        self._refresh_fighter_ids()
        self._seed_aliases(new)

    def _refresh_fighter_ids(self):
        if self.args.dry_run:
            return
        for row in self.db.select_all("ufc_fighters", "id,ufcstats_id"):
            self.fighter_ids[row["ufcstats_id"]] = row["id"]

    def _seed_aliases(self, fighter_rows):
        alias_rows = []
        for r in fighter_rows:
            fid = self.fighter_ids.get(r["ufcstats_id"])
            if not fid:
                continue
            alias_rows += alias_rows_for_fighter(fid, r["name"], r.get("nickname"))
        self.db.upsert("ufc_fighter_aliases", alias_rows, on_conflict="fighter_id,source,normalized")

    def phase_events(self):
        for status, path, slug in (("complete", "/statistics/events/completed?page=all", "completed"),
                                   ("announced", "/statistics/events/upcoming", "upcoming")):
            url = f"{self.cfg.base}{path}"
            try:
                html, _ = self.fetch.get("lists", slug, url, refresh=self.args.source == "live")   # live: always re-fetch; wayback: cache is fine
            except WaybackMissing:
                self._missing("lists", slug, url)   # the upcoming list has no usable archive capture (post-challenge captures are the interstitial)
                continue
            events = parsers.parse_event_list(html, url)
            if self.args.since:
                events = [e for e in events if e["event_date"] and e["event_date"] >= self.args.since]
            if self.args.limit:
                events = events[: self.args.limit]
            rows = []
            for e in events:
                if e["ufcstats_id"] in self.event_ids and not self.args.force:
                    continue
                rows.append({**self._event_row(e, url), "card_status": status})
            self.log.event("event_list", which=slug, listed=len(events), new=len(rows))
            self.db.upsert("ufc_events", rows, on_conflict="ufcstats_id")
            self.log.bump("events_new", len(rows))
        if not self.args.dry_run:
            for row in self.db.select_all("ufc_events", "id,ufcstats_id"):
                self.event_ids[row["ufcstats_id"]] = row["id"]

    @staticmethod
    def _event_row(e: dict, url: str) -> dict:
        parts = [p.strip() for p in (e.get("location_raw") or "").split(",")]
        city = parts[0] if parts else None
        country = parts[-1] if len(parts) >= 2 else None
        region = parts[1] if len(parts) >= 3 else None
        return {"ufcstats_id": e["ufcstats_id"], "name": e["name"], "event_date": e["event_date"],
                "city": city, "region": region, "country": country, "location_raw": e.get("location_raw"),
                "source_url": f"{url.split('/statistics')[0]}/event-details/{e['ufcstats_id']}",
                "captured_at": now_iso(), "updated_at": now_iso()}

    def phase_fights(self):
        events = self.db.select_all("ufc_events", "id,ufcstats_id,event_date,card_status",
                                    "order=event_date.desc") if not self.args.dry_run else []
        if self.args.since:
            events = [e for e in events if e["event_date"] and e["event_date"] >= self.args.since]
        if self.args.limit:
            events = events[: self.args.limit]
        for ev in events:
            self._ingest_event(ev)

    def _missing(self, kind: str, key: str, url: str):
        self.missing.append({"kind": kind, "id": key, "url": url})
        self.log.bump(f"wayback_missing_{kind}")
        self.log.event("wayback_missing", kind=kind, id=key, url=url)

    def _ingest_event(self, ev: dict):
        url = f"{self.cfg.base}/event-details/{ev['ufcstats_id']}"
        try:
            html, cached = self.fetch.get("events", ev["ufcstats_id"], url,
                                          refresh=self.args.force or ev["card_status"] != "complete")
        except WaybackMissing:
            self._missing("events", ev["ufcstats_id"], url)
            return
        page = parsers.parse_event_page(html, url)
        bouts = page["bouts"]
        if all(b.get("ufcstats_id") in self.bout_ids for b in bouts) and not self.args.force:
            return
        # make sure both fighters exist as rows (list phase normally did this)
        missing = []
        for b in bouts:
            for side in ("a", "b"):
                fid = b[f"fighter_{side}_ufcstats_id"]
                if fid not in self.fighter_ids:
                    missing.append({"ufcstats_id": fid, "name": b[f"fighter_{side}_name"], "source_url": url,
                                    "captured_at": now_iso(), "updated_at": now_iso()})
        if missing:
            self.db.upsert("ufc_fighters", missing, on_conflict="ufcstats_id")
            self._refresh_fighter_ids()
        rows = []
        for b in bouts:
            wc = parsers.normalize_weight_class(b["weight_class_raw"], url)
            rows.append({
                "ufcstats_id": b.get("ufcstats_id"), "event_id": ev["id"],
                "fighter_a_id": self.fighter_ids[b["fighter_a_ufcstats_id"]],
                "fighter_b_id": self.fighter_ids[b["fighter_b_ufcstats_id"]],
                "weight_class": wc["weight_class"], "weight_class_raw": b["weight_class_raw"],
                "is_womens": wc["is_womens"], "is_title": wc["is_title"],
                "bout_order": b["bout_order"],
                "status": "complete" if ev["card_status"] == "complete" else "announced",
                "source_url": url, "captured_at": now_iso(), "updated_at": now_iso(),
            })
        new = [r for r in rows if r["ufcstats_id"] not in self.bout_ids or self.args.force]
        self.db.upsert("ufc_bouts", new, on_conflict="ufcstats_id")
        self.log.bump("bouts_new", len(new))
        if not self.args.dry_run:
            for row in self.db.select_all("ufc_bouts", "id,ufcstats_id", f"event_id=eq.{ev['id']}"):
                if row["ufcstats_id"]:
                    self.bout_ids[row["ufcstats_id"]] = row["id"]
        if ev["card_status"] != "complete":
            self.log.event("event_announced", id=ev["ufcstats_id"], bouts=len(rows))
            return
        for b in bouts:
            if b.get("ufcstats_id"):
                self._ingest_fight(b["ufcstats_id"])
        self.log.event("event_done", id=ev["ufcstats_id"], bouts=len(rows), cached=cached)

    def _ingest_fight(self, fight_id: str):
        url = f"{self.cfg.base}/fight-details/{fight_id}"
        try:
            html, _ = self.fetch.get("fights", fight_id, url, refresh=self.args.force)
        except WaybackMissing:
            self._missing("fights", fight_id, url)
            return
        f = parsers.parse_fight_page(html, url)
        bout_id = self.bout_ids.get(fight_id)
        if not bout_id and not self.args.dry_run:
            raise SchemaAssertionError(url, "fight page for a bout that is not in ufc_bouts")
        winner = next((x for x in f["fighters"] if x["flag"] == "WIN"), None)
        result = {
            "bout_id": bout_id, "winner_id": self.fighter_ids.get(winner["ufcstats_id"]) if winner else None,
            "method": f["method"], "method_raw": f["method_raw"], "round": f["round"], "time_sec": f["time_sec"],
            "time_format": f["time_format"], "referee": f["referee"],
            "judge_1": (f["scorecards"] or [{}])[0].get("judge") if f["scorecards"] else None,
            "judge_2": (f["scorecards"] or [{}, {}])[1].get("judge") if f["scorecards"] and len(f["scorecards"]) > 1 else None,
            "judge_3": (f["scorecards"] or [{}, {}, {}])[2].get("judge") if f["scorecards"] and len(f["scorecards"]) > 2 else None,
            "scorecards": f["scorecards"], "finish_detail": f["finish_detail"], "has_stats": f["has_stats"],
            "source_url": url, "captured_at": now_iso(),
        }
        self.db.upsert("ufc_bout_results", [result], on_conflict="bout_id")
        if f["scheduled_rounds"] is not None or f["is_title"] is not None:
            self.db.patch("ufc_bouts", f"ufcstats_id=eq.{fight_id}",
                          {"scheduled_rounds": f["scheduled_rounds"], "is_title": f["is_title"], "updated_at": now_iso()})
        rounds = [{**r, "bout_id": bout_id, "fighter_id": self.fighter_ids.get(r.pop("fighter_ufcstats_id")),
                   "source_url": url, "captured_at": now_iso()} for r in f["rounds"]]
        self.db.upsert("ufc_bout_round_stats", rounds, on_conflict="bout_id,fighter_id,round")
        if not f["has_stats"]:
            self.log.bump("results_without_stats")
        for x in f["fighters"]:
            if x["ufcstats_id"] not in self.fighters_detailed or self.args.force:
                self._ingest_fighter(x["ufcstats_id"])

    def _ingest_fighter(self, fighter_id: str):
        url = f"{self.cfg.base}/fighter-details/{fighter_id}"
        try:
            html, _ = self.fetch.get("fighters", fighter_id, url, refresh=self.args.force)
        except WaybackMissing:
            self._missing("fighters", fighter_id, url)
            return
        p = parsers.parse_fighter_page(html, url)
        history_ids = p.pop("history_fight_ids")          # not a column; the verification report intersects it with ufc_bouts
        self.log.event("fighter_history", id=fighter_id, rows=len(history_ids))
        row = {**p, "source_url": url, "captured_at": now_iso(), "updated_at": now_iso()}
        self.db.upsert("ufc_fighters", [row], on_conflict="ufcstats_id")
        self.fighters_detailed.add(fighter_id)
        self.log.bump("fighters_touched")
        fid = self.fighter_ids.get(fighter_id)
        if fid:
            self.db.upsert("ufc_fighter_aliases", alias_rows_for_fighter(fid, p["name"], p.get("nickname")),
                           on_conflict="fighter_id,source,normalized")

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
            discord(self.cfg, f"**{WORKER} STOPPED** schema assertion failed\n`{e.detail}`\n{e.url}", loud=True)
            status, code = "failed", 2
        except AccessGateError as e:
            self.log.event("ACCESS_GATE", detail=str(e))
            discord(self.cfg, f"**{WORKER} STOPPED** source access gate: {str(e)[:300]}", loud=True)
            status, code = "failed", 3
        except NotImplementedError as e:
            self.log.event("NOT_IMPLEMENTED", detail=str(e))
            status, code = "failed", 4
        except Exception:
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
                                  f"fighters_touched={c.get('fighters_touched', 0)} no_stats={c.get('results_without_stats', 0)}")
        return code


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phase", choices=["events", "fighters", "fights", "all"], required=True)
    ap.add_argument("--source", choices=["wayback", "live"], default="wayback",
                    help="wayback (default): Internet Archive captures; live: ufcstats.com (aborts on JS challenge)")
    ap.add_argument("--since", help="YYYY-MM-DD; only events on/after this date")
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
