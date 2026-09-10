#!/usr/bin/env python3
"""Direct Wikipedia MMA career ingestion for UFC-linked fighters.

Why this exists:
- do not pay a downstream aggregator for UFCStats/Wikipedia-derived facts;
- use Wikimedia's official Action API with an identifying User-Agent;
- validate the fighter page against our canonical UFC history before writing;
- write only non-UFC career rows into combat_*; canonical UFC stays in ufc_*;
- preserve page/revision provenance and never copy article prose wholesale.

Default is audit-only. `--write` is required for database writes.

Examples:
  python scripts/combat/wikipedia_mma_ingest.py --fighter "Kayla Harrison"
  python scripts/combat/wikipedia_mma_ingest.py --pilot logs/combat-pilot.json --limit 10
  python scripts/combat/wikipedia_mma_ingest.py --pilot logs/combat-pilot.json --limit 10 --write
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "backfill"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import Config, RunLog, Supabase  # noqa: E402
from wikipedia_mma_parser import normalize_name, parse_mma_record  # noqa: E402

load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "web" / ".env.local")

WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKI_BASE = "https://en.wikipedia.org/wiki/"
DEFAULT_UA = "PropBetEdge-MMA-Ingest/1.0 (+https://ufc.propbetedge.ai/)"
KNOWN_PROMOTIONS = {
    "pride", "wec", "strikeforce", "bellator", "pfl", "wsof", "one", "rizin",
    "ksw", "cage-warriors", "lfa", "invicta", "brave", "oktagon", "dream",
    "shooto", "pancrase", "m1",
}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def qv(value: str) -> str:
    return quote(str(value), safe="")


def wiki_url(title: str) -> str:
    return WIKI_BASE + quote(title.replace(" ", "_"), safe="()',-._~")


def sha(*parts: object) -> str:
    raw = "\x1f".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class WikiClient:
    def __init__(self, max_requests: int = 300, delay: float = 0.75):
        self.max_requests = max_requests
        self.delay = max(0.0, delay)
        self.requests = 0
        self._last = 0.0
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": os.getenv("WIKIMEDIA_USER_AGENT", DEFAULT_UA),
            "Accept": "application/json",
        })

    def _throttle(self):
        wait = self.delay - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def get(self, params: dict) -> dict:
        self.requests += 1
        if self.requests > self.max_requests:
            raise RuntimeError(f"Wikimedia request cap exceeded ({self.max_requests})")
        base = {
            "format": "json",
            "formatversion": "2",
            "maxlag": "5",
            "origin": "*",
        }
        for attempt in range(5):
            self._throttle()
            try:
                r = self.session.get(WIKI_API, params={**base, **params}, timeout=30)
            except requests.RequestException as e:
                if attempt == 4:
                    raise RuntimeError(f"Wikipedia request failed: {e}") from e
                time.sleep(2 ** attempt)
                continue
            if r.status_code in (429, 500, 502, 503, 504):
                if attempt == 4:
                    raise RuntimeError(f"Wikipedia API HTTP {r.status_code}")
                retry = r.headers.get("Retry-After")
                time.sleep(float(retry) if retry and retry.isdigit() else 2 ** attempt)
                continue
            if r.status_code != 200:
                raise RuntimeError(f"Wikipedia API HTTP {r.status_code}: {r.text[:160]}")
            body = r.json()
            if body.get("error"):
                code = body["error"].get("code")
                if code == "maxlag" and attempt < 4:
                    time.sleep(2 ** attempt)
                    continue
                raise RuntimeError(f"Wikipedia API error: {body['error']}")
            return body
        raise RuntimeError("Wikipedia API retries exhausted")

    def exact_page(self, name: str) -> dict | None:
        body = self.get({
            "action": "query",
            "titles": name,
            "redirects": "1",
            "prop": "info|pageprops",
            "inprop": "url",
        })
        pages = body.get("query", {}).get("pages", [])
        if not pages or pages[0].get("missing"):
            return None
        return pages[0]

    def search_pages(self, name: str) -> list[dict]:
        body = self.get({
            "action": "query",
            "list": "search",
            "srsearch": f'"{name}" mixed martial arts fighter',
            "srlimit": "5",
            "srnamespace": "0",
        })
        return body.get("query", {}).get("search", [])

    def parse_page(self, pageid: int) -> dict:
        body = self.get({
            "action": "parse",
            "pageid": str(pageid),
            "prop": "text|revid|displaytitle",
            "disableeditsection": "1",
        })
        p = body.get("parse") or {}
        if not p.get("text"):
            raise RuntimeError(f"Wikipedia page {pageid} returned no parsed HTML")
        return p

    def resolve_fighter(self, name: str) -> dict | None:
        seen: set[int] = set()
        exact = self.exact_page(name)
        candidates = [exact] if exact else []
        if not exact:
            candidates.extend(self.search_pages(name))
        for c in candidates:
            pageid = int(c.get("pageid") or 0)
            if not pageid or pageid in seen:
                continue
            seen.add(pageid)
            parsed = self.parse_page(pageid)
            record = parse_mma_record(parsed["text"])
            if record["rows"]:
                return {
                    "pageid": pageid,
                    "title": c.get("title") or parsed.get("title") or name,
                    "revid": parsed.get("revid"),
                    "displaytitle": parsed.get("displaytitle"),
                    "url": wiki_url(c.get("title") or parsed.get("title") or name),
                    "record": record,
                }
        return None


class Store:
    def __init__(self, sb: Supabase, log: RunLog, dry_run: bool):
        self.sb = sb
        self.log = log
        self.dry_run = dry_run
        self.source = self._one("combat_sources", "source_key=eq.wikipedia_en")
        if not self.source:
            raise RuntimeError("combat_sources.wikipedia_en is missing; apply direct-source migration first")
        if self.source.get("access_mode") != "approved_ingest" or not self.source.get("enabled"):
            raise RuntimeError("combat_sources.wikipedia_en is not enabled as approved_ingest")
        self.source_id = self.source["id"]
        self.fighters = self.sb.select_all(
            "combat_fighters",
            "id,ufc_fighter_id,display_name,dob,career_status,identity_state",
        )
        self.fighter_by_id = {f["id"]: f for f in self.fighters}
        self.by_norm: dict[str, list[dict]] = {}
        for f in self.fighters:
            self.by_norm.setdefault(normalize_name(f["display_name"]), []).append(f)
        self.wiki_identities = self.sb.select_all(
            "combat_fighter_identities",
            "id,combat_fighter_id,external_id,verification_state,confidence",
            f"source_id=eq.{self.source_id}",
        )
        self.wiki_by_external = {x["external_id"]: x for x in self.wiki_identities}

    def _one(self, table: str, filters: str, columns: str = "*") -> dict | None:
        rows = self.sb.select_all(table, columns, filters, page=10)
        return rows[0] if rows else None

    def target_by_name(self, name: str) -> dict:
        candidates = self.by_norm.get(normalize_name(name), [])
        ufc = [f for f in candidates if f.get("ufc_fighter_id")]
        if len(ufc) != 1:
            raise RuntimeError(f"{name!r} resolved to {len(ufc)} UFC-linked combat fighters; use pilot ids instead")
        return ufc[0]

    def canonical_ufc(self, fighter_id: str) -> list[dict]:
        rows = self.sb.select_all(
            "combat_career_bouts",
            "career_bout_key,fighter_a_id,fighter_b_id,winner_id,event_name,event_date,method,method_raw,round,time_sec",
            f"source_scope=eq.ufc&or=(fighter_a_id.eq.{fighter_id},fighter_b_id.eq.{fighter_id})",
        )
        out = []
        for row in rows:
            other = row["fighter_b_id"] if row["fighter_a_id"] == fighter_id else row["fighter_a_id"]
            row = dict(row)
            row["opponent_name"] = self.fighter_by_id.get(other, {}).get("display_name")
            out.append(row)
        return out

    def verify_page(self, target: dict, page: dict) -> dict:
        wiki_rows = [r for r in page["record"]["rows"] if r["promotion_slug"] == "ufc"]
        canonical = self.canonical_ufc(target["id"])
        matched = []
        conflicts = []
        for row in wiki_rows:
            possible = [c for c in canonical
                        if c.get("event_date") == row.get("event_date")
                        and normalize_name(c.get("opponent_name")) == normalize_name(row.get("opponent"))]
            if len(possible) == 1:
                matched.append((row, possible[0]))
            else:
                conflicts.append({
                    "opponent": row.get("opponent"),
                    "event_date": row.get("event_date"),
                    "matches": len(possible),
                })
        db_dob = target.get("dob")
        wiki_dob = page["record"].get("dob")
        dob_conflict = bool(db_dob and wiki_dob and db_dob != wiki_dob)
        dob_match = bool(db_dob and wiki_dob and db_dob == wiki_dob)
        required = min(2, len(canonical))
        verified = (not dob_conflict and not conflicts and (
            len(matched) >= max(2, required) or (dob_match and len(matched) >= 1)
        ))
        # A fighter with one UFC bout is only auto-verified with DOB + exact bout overlap.
        if len(canonical) == 1:
            verified = bool(dob_match and len(matched) == 1 and not conflicts)
        return {
            "verified": verified,
            "canonical_ufc_appearances": len(canonical),
            "wikipedia_ufc_rows": len(wiki_rows),
            "exact_ufc_matches": len(matched),
            "ufc_conflicts": conflicts,
            "db_dob": db_dob,
            "wikipedia_dob": wiki_dob,
            "dob_match": dob_match,
            "dob_conflict": dob_conflict,
        }

    def register_main_identity(self, target: dict, page: dict, proof: dict) -> bool:
        external = page["title"]
        existing = self.wiki_by_external.get(external)
        if existing and existing["combat_fighter_id"] != target["id"]:
            self.queue_review(external, target["display_name"],
                              [existing["combat_fighter_id"], target["id"]],
                              "wikipedia_identity_collision",
                              {"page": page["url"], "proof": proof})
            return False
        row = {
            "combat_fighter_id": target["id"],
            "source_id": self.source_id,
            "external_id": external,
            "external_url": page["url"],
            "display_name": target["display_name"],
            "dob": page["record"].get("dob"),
            "verification_state": "verified",
            "confidence": 100,
            "evidence": {
                "method": "canonical_ufc_history_crosscheck",
                "page_id": page["pageid"],
                "revision_id": page["revid"],
                **proof,
            },
            "last_observed_at": now_iso(),
        }
        self.sb.upsert("combat_fighter_identities", [row], "source_id,external_id")
        alias = {
            "combat_fighter_id": target["id"],
            "source_id": self.source_id,
            "alias": target["display_name"],
            "normalized": normalize_name(target["display_name"]),
            "kind": "name",
            "verification_state": "verified",
            "evidence": {"wikipedia_title": external, "revision_id": page["revid"]},
        }
        self.sb.upsert("combat_fighter_aliases", [alias], "combat_fighter_id,source_id,normalized")
        self.wiki_by_external[external] = {
            "combat_fighter_id": target["id"], "external_id": external,
            "verification_state": "verified", "confidence": 100,
        }
        return True

    def stage(self, target: dict, page: dict, proof: dict):
        payload = {
            "schema": "combat.wikipedia-career/v1",
            "fighter": {"combat_fighter_id": target["id"], "display_name": target["display_name"]},
            "source": {
                "page_id": page["pageid"], "revision_id": page["revid"],
                "page_title": page["title"], "url": page["url"],
            },
            "identity_proof": proof,
            "career_rows": page["record"]["rows"],
        }
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        row = {
            "source_id": self.source_id,
            "ingest_key": f"wikipedia:{page['pageid']}:career",
            "packet_version": int(page.get("revid") or 1),
            "packet_type": "career",
            "external_id": page["title"],
            "source_url": page["url"],
            "payload": payload,
            "payload_sha256": hashlib.sha256(encoded).hexdigest(),
            "validation_state": "validated",
            "validation_errors": [],
            "fetched_at": now_iso(),
            "updated_at": now_iso(),
        }
        self.sb.upsert("combat_ingest_packets", [row], "source_id,ingest_key,packet_version")

    def queue_review(self, external_id: str | None, name: str, candidates: list[str], reason: str, context: dict):
        ext_filter = f"raw_external_id=eq.{qv(external_id)}&" if external_id else ""
        existing = self.sb.select_all(
            "combat_identity_review_queue", "id",
            f"source_id=eq.{self.source_id}&status=eq.pending&{ext_filter}reason=eq.{qv(reason)}",
            page=10,
        )
        if existing:
            return
        self.sb.insert("combat_identity_review_queue", [{
            "source_id": self.source_id,
            "raw_external_id": external_id,
            "raw_name": name,
            "candidate_fighter_ids": candidates,
            "reason": reason,
            "context": context,
        }])

    def ensure_opponent(self, row: dict, page: dict) -> dict | None:
        external = row.get("opponent_wiki_title")
        name = row.get("opponent")
        if not external:
            self.queue_review(None, name, [], "wikipedia_opponent_has_no_stable_page_link",
                              {"source_page": page["url"], "row_index": row["row_index"]})
            return None
        existing = self.wiki_by_external.get(external)
        if existing:
            return self.fighter_by_id.get(existing["combat_fighter_id"])

        # Never connect a Wikipedia opponent to an existing UFC identity on name alone.
        candidates = self.by_norm.get(normalize_name(name), [])
        if candidates:
            self.queue_review(external, name, [c["id"] for c in candidates],
                              "wikipedia_opponent_matches_existing_name_without_identity_proof",
                              {"source_page": page["url"], "row_index": row["row_index"]})
            return None

        fighter_id = str(uuid.uuid4())
        fighter = {
            "id": fighter_id,
            "display_name": name,
            "normalized_name": normalize_name(name),
            "career_status": "unknown",
            "identity_state": "source_native",
        }
        self.sb.upsert("combat_fighters", [fighter], "id")
        ident = {
            "combat_fighter_id": fighter_id,
            "source_id": self.source_id,
            "external_id": external,
            "external_url": wiki_url(external),
            "display_name": name,
            "verification_state": "verified",
            "confidence": 100,
            "evidence": {
                "method": "linked_opponent_on_verified_wikipedia_career_row",
                "source_page_id": page["pageid"],
                "source_revision_id": page["revid"],
                "row_index": row["row_index"],
            },
            "last_observed_at": now_iso(),
        }
        self.sb.upsert("combat_fighter_identities", [ident], "source_id,external_id")
        self.fighters.append(fighter)
        self.fighter_by_id[fighter_id] = fighter
        self.by_norm.setdefault(normalize_name(name), []).append(fighter)
        self.wiki_by_external[external] = {"combat_fighter_id": fighter_id, "external_id": external}
        return fighter

    def ensure_promotion(self, row: dict) -> dict | None:
        slug = row["promotion_slug"]
        if slug not in KNOWN_PROMOTIONS:
            return None
        existing = self._one("combat_promotions", f"slug=eq.{qv(slug)}")
        if existing:
            return existing
        pid = str(uuid.uuid4())
        data = {
            "id": pid,
            "slug": slug,
            "name": row["promotion_name"],
            "source_id": self.source_id,
            "source_url": wiki_url(row["event_wiki_title"]) if row.get("event_wiki_title") else None,
        }
        self.sb.upsert("combat_promotions", [data], "slug")
        return data

    def ingest_external_rows(self, target: dict, page: dict) -> dict:
        counters = {"candidate_external_rows": 0, "written_bouts": 0, "review_rows": 0, "unknown_promotion": 0}
        main_external = page["title"]
        for row in page["record"]["rows"]:
            if row["promotion_slug"] == "ufc":
                continue
            counters["candidate_external_rows"] += 1
            promotion = self.ensure_promotion(row)
            if not promotion:
                counters["unknown_promotion"] += 1
                continue
            opponent = self.ensure_opponent(row, page)
            if not opponent:
                counters["review_rows"] += 1
                continue
            if not row.get("event_date"):
                counters["review_rows"] += 1
                self.queue_review(row.get("event_wiki_title"), row["opponent"], [opponent["id"]],
                                  "wikipedia_career_row_missing_event_date",
                                  {"source_page": page["url"], "row_index": row["row_index"]})
                continue

            event_key = "wikipedia:" + sha(row["promotion_slug"], row["event"], row["event_date"])[:32]
            event = self._one("combat_events", f"source_id=eq.{self.source_id}&external_event_id=eq.{qv(event_key)}")
            if not event:
                event_id = str(uuid.uuid4())
                event = {
                    "id": event_id,
                    "promotion_id": promotion["id"],
                    "source_id": self.source_id,
                    "external_event_id": event_key,
                    "name": row["event"],
                    "event_date": row["event_date"],
                    "status": "complete",
                    "source_url": wiki_url(row["event_wiki_title"]) if row.get("event_wiki_title") else page["url"],
                    "source_record": {
                        "wikipedia_event_title": row.get("event_wiki_title"),
                        "career_page_id": page["pageid"], "career_revision_id": page["revid"],
                        "location_raw": row.get("location"),
                    },
                }
                self.sb.upsert("combat_events", [event], "source_id,external_event_id")

            opponent_external = row.get("opponent_wiki_title")
            pair = sorted([main_external, opponent_external])
            bout_key = "wikipedia:" + sha(event_key, pair[0], pair[1])[:32]
            bout = self._one("combat_bouts", f"source_id=eq.{self.source_id}&external_bout_id=eq.{qv(bout_key)}")
            if not bout:
                bout_id = str(uuid.uuid4())
                bout = {
                    "id": bout_id,
                    "event_id": event["id"],
                    "source_id": self.source_id,
                    "external_bout_id": bout_key,
                    "fighter_a_id": target["id"],
                    "fighter_b_id": opponent["id"],
                    "competition_class": "professional",
                    "is_title": False,
                    "status": "complete",
                    "source_url": page["url"],
                    "source_record": {
                        "career_page_id": page["pageid"], "career_revision_id": page["revid"],
                        "row_index": row["row_index"], "record_text": row.get("record_text"),
                        "wikipedia_event_title": row.get("event_wiki_title"),
                        "wikipedia_opponent_title": opponent_external,
                    },
                }
                self.sb.upsert("combat_bouts", [bout], "source_id,external_bout_id")

            result = row["result"]
            if result == "win":
                outcome, winner = "win", target["id"]
            elif result == "loss":
                outcome, winner = "win", opponent["id"]
            elif result == "draw":
                outcome, winner = "draw", None
            elif result == "no_contest":
                outcome, winner = "no_contest", None
            else:
                outcome, winner = "unknown", None
            result_row = {
                "bout_id": bout["id"],
                "source_id": self.source_id,
                "outcome": outcome,
                "winner_id": winner,
                "method": row.get("method"),
                "method_raw": row.get("method_raw"),
                "round": row.get("round"),
                "time_sec": row.get("time_sec"),
                "source_url": page["url"],
                "source_record": {
                    "career_page_id": page["pageid"], "career_revision_id": page["revid"],
                    "row_index": row["row_index"],
                },
            }
            self.sb.upsert("combat_bout_results", [result_row], "bout_id")
            counters["written_bouts"] += 1
        return counters


def load_targets(store: Store, args) -> list[dict]:
    if args.pilot:
        data = json.loads(Path(args.pilot).read_text(encoding="utf-8"))
        queue = data.get("queue") if isinstance(data, dict) else data
        if not isinstance(queue, list):
            raise RuntimeError("pilot JSON must contain a queue array")
        out = []
        for item in queue[:args.limit]:
            cid = item.get("combat_fighter_id")
            if cid and cid in store.fighter_by_id:
                out.append(store.fighter_by_id[cid])
            else:
                out.append(store.target_by_name(item["name"]))
        return out
    if args.fighter:
        return [store.target_by_name(name) for name in args.fighter[:args.limit]]
    raise RuntimeError("provide --fighter NAME (repeatable) or --pilot FILE")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fighter", action="append", help="Exact UFC-linked fighter name; repeatable")
    ap.add_argument("--pilot", help="JSON from build_pilot_queue.mjs")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--write", action="store_true", help="Actually write verified non-UFC career rows")
    ap.add_argument("--max-requests", type=int, default=300)
    ap.add_argument("--delay", type=float, default=0.75)
    ap.add_argument("--json", dest="json_out")
    args = ap.parse_args()
    args.limit = max(1, min(args.limit, 100))

    cfg = Config()
    cfg.require_supabase()
    log = RunLog("wikipedia_mma", ROOT / "logs" / "combat")
    sb = Supabase(cfg, log, dry_run=not args.write)
    store = Store(sb, log, dry_run=not args.write)
    wiki = WikiClient(max_requests=args.max_requests, delay=args.delay)
    targets = load_targets(store, args)

    report = {
        "generated_at": now_iso(), "mode": "write" if args.write else "audit",
        "targets": len(targets), "wikipedia_requests": 0, "fighters": [],
        "totals": {"resolved_pages": 0, "verified_pages": 0, "candidate_external_rows": 0,
                   "written_bouts": 0, "review_rows": 0, "unknown_promotion": 0},
    }

    # Pass 1: resolve every target and prove its Wikipedia identity against UFC.
    resolved: list[tuple[dict, dict, dict]] = []
    for target in targets:
        page = wiki.resolve_fighter(target["display_name"])
        if not page:
            report["fighters"].append({"name": target["display_name"], "status": "no_mma_record_page"})
            continue
        report["totals"]["resolved_pages"] += 1
        proof = store.verify_page(target, page)
        item = {
            "name": target["display_name"], "wikipedia_title": page["title"],
            "revision_id": page["revid"], "career_rows": len(page["record"]["rows"]),
            "external_rows": sum(1 for r in page["record"]["rows"] if r["promotion_slug"] != "ufc"),
            "identity": proof,
        }
        report["fighters"].append(item)
        if not proof["verified"]:
            if args.write:
                store.queue_review(page["title"], target["display_name"], [target["id"]],
                                   "wikipedia_fighter_page_failed_ufc_crosscheck",
                                   {"page": page["url"], "proof": proof})
            item["status"] = "identity_review"
            continue
        report["totals"]["verified_pages"] += 1
        item["status"] = "verified"
        resolved.append((target, page, proof))
        if args.write:
            if not store.register_main_identity(target, page, proof):
                item["status"] = "identity_collision"
                resolved.pop()
                continue
            store.stage(target, page, proof)

    # Pass 2: after target identities are registered, non-UFC rows can safely
    # link target-vs-target fights by stable Wikipedia identity instead of name.
    if args.write:
        for target, page, _proof in resolved:
            counts = store.ingest_external_rows(target, page)
            for k, v in counts.items():
                report["totals"][k] += v
            for item in report["fighters"]:
                if item.get("name") == target["display_name"] and item.get("wikipedia_title") == page["title"]:
                    item["ingest"] = counts
                    break
    else:
        for _target, page, _proof in resolved:
            n = sum(1 for r in page["record"]["rows"] if r["promotion_slug"] != "ufc")
            report["totals"]["candidate_external_rows"] += n

    report["wikipedia_requests"] = wiki.requests
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if args.json_out:
        out = Path(args.json_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
