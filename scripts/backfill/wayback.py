"""
Internet Archive (Wayback Machine) source for the backfill.

Why: ufcstats.com fronts every live request with a JS proof-of-work
challenge (docs/scraper_notes.md). The historical backfill therefore reads
archived captures instead. Nothing here touches ufcstats.com.

Politeness: at most one request every WAYBACK_MIN_INTERVAL_SEC (default 2s),
exponential backoff on HTTP 429 starting at 30s and capped at 10 min, and a
disk cache so a failed run resumes where it stopped.

Two lookups:
  1. CDX index, one query per URL family (event-details/*, fight-details/*,
     fighter-details/*), cached to cache/_wayback_index/{kind}.json. Gives every
     capture timestamp for every archived id, newest first.
  2. Availability API fallback for a URL the CDX index does not know.

A capture that turns out to be the interstitial (archived after the challenge
went up) is skipped and the next-older capture is tried.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Optional

import requests

CDX = "http://web.archive.org/cdx/search/cdx"
AVAILABLE = "https://archive.org/wayback/available"
HEX16 = re.compile(r"/(?:event|fight|fighter)-details/([0-9a-f]{16})")


class WaybackMissing(Exception):
    """No usable capture exists for this URL. Counted, not fatal."""


class WaybackClient:
    def __init__(self, cache_dir: Path, log, min_interval: float = 2.0, user_agent: str = "ufc-propbetedge-backfill/0.1"):
        self.cache_dir = cache_dir
        self.log = log
        self.min_interval = min_interval
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent})
        self._last = 0.0
        self._index: dict[str, dict[str, list[str]]] = {}
        self.requests_made = 0

    # -- politeness ---------------------------------------------------------
    def _throttle(self):
        wait = self.min_interval - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def _get(self, url: str, params: Optional[dict] = None, max_tries: int = 8) -> requests.Response:
        delay = 30.0
        for attempt in range(max_tries):
            self._throttle()
            self.requests_made += 1
            try:
                r = self.session.get(url, params=params, timeout=120, allow_redirects=True)
            except requests.RequestException as e:
                self.log.event("wayback_retry", url=url, attempt=attempt, error=str(e)[:160])
                time.sleep(min(delay, 600)); delay *= 2
                continue
            if r.status_code == 429 or r.status_code >= 500:
                self.log.event("wayback_retry", url=url, attempt=attempt, status=r.status_code, sleep=int(min(delay, 600)))
                time.sleep(min(delay, 600)); delay *= 2
                continue
            return r
        raise RuntimeError(f"wayback gave up after {max_tries} tries: {url}")

    # -- CDX index ----------------------------------------------------------
    def _index_path(self, kind: str) -> Path:
        p = self.cache_dir / "_wayback_index" / f"{kind}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def index(self, kind: str) -> dict[str, list[str]]:
        """kind -> {id: [timestamps newest-first]} for event|fight|fighter-details."""
        if kind in self._index:
            return self._index[kind]
        p = self._index_path(kind)
        if p.exists():
            self._index[kind] = json.loads(p.read_text(encoding="utf-8"))
            return self._index[kind]
        family = {"events": "event-details", "fights": "fight-details", "fighters": "fighter-details"}[kind]
        rows: list[list[str]] = []
        page = 0
        while True:
            r = self._get(CDX, params={"url": f"ufcstats.com/{family}/*", "output": "json", "fl": "timestamp,original,statuscode",
                                       "filter": "statuscode:200", "pageSize": 5, "page": page})
            data = r.json() if r.text.strip() else []
            if not data:
                break
            rows.extend(data[1:] if data and data[0] and data[0][0] == "timestamp" else data)
            page += 1
            if len(data) < 2:
                break
        idx: dict[str, list[str]] = {}
        for ts, original, _ in rows:
            m = HEX16.search(original)
            if m:
                idx.setdefault(m.group(1), []).append(ts)
        for k in idx:
            idx[k] = sorted(set(idx[k]), reverse=True)
        p.write_text(json.dumps(idx), encoding="utf-8")
        self.log.event("wayback_index", kind=kind, ids=len(idx), captures=len(rows))
        self._index[kind] = idx
        return idx

    def _available(self, url: str) -> Optional[str]:
        r = self._get(AVAILABLE, params={"url": url})
        try:
            snap = r.json().get("archived_snapshots", {}).get("closest")
        except ValueError:
            return None
        return snap["timestamp"] if snap and snap.get("available") else None

    # -- content ------------------------------------------------------------
    def fetch(self, kind: str, key: str, original_url: str, is_bad_capture) -> tuple[str, str]:
        """Returns (html, timestamp). Tries captures newest-first; skips ones
        that is_bad_capture(html) rejects (e.g. archived interstitial)."""
        timestamps: list[str] = []
        if kind in ("events", "fights", "fighters"):
            timestamps = list(self.index(kind).get(key, []))
        if not timestamps:
            ts = self._available(original_url)
            if not ts:
                raise WaybackMissing(original_url)
            timestamps = [ts]
        for ts in timestamps[:4]:
            r = self._get(f"http://web.archive.org/web/{ts}id_/{original_url}")
            if r.status_code != 200:
                continue
            html = r.text
            if is_bad_capture(html):
                self.log.event("wayback_bad_capture", url=original_url, ts=ts)
                continue
            return html, ts
        raise WaybackMissing(original_url)
