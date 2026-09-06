"""
Internet Archive (Wayback Machine) source for the backfill.

Why: ufcstats.com fronts every live request with a JS proof-of-work
challenge (docs/scraper_notes.md). The historical backfill therefore reads
archived captures instead. Nothing here touches ufcstats.com.

Politeness: at most one request every WAYBACK_MIN_INTERVAL_SEC (default 2s),
exponential backoff on HTTP 429/5xx starting at 30s and capped at 10 min, and
a disk cache so a failed run resumes where it stopped.

Two failure classes, never confused:
  WaybackMissing      - lookups succeeded and no usable capture exists
                        (a COVERAGE GAP: counted, skipped)
  WaybackUnavailable  - Wayback/CDX kept answering 429/5xx or timing out
                        (a SOURCE OUTAGE: the run stops with a persisted reason)

Lookup order for a page:
  1. the per-family CDX index (event-details/*, fight-details/*,
     fighter-details/*), built once per run and cached on disk. If building it
     fails after retries, the failure is recorded ONCE and the run continues
     without it - a bounded canary never depends on the bulk index.
  2. an exact-URL CDX query (cheap, one row per capture)
  3. the Availability API
If 2 and 3 are both unavailable the page raises WaybackUnavailable.

A capture that turns out to be the interstitial (archived after the challenge
went up) is skipped and the next-older capture is tried.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Callable, Optional

import requests

CDX = "http://web.archive.org/cdx/search/cdx"
AVAILABLE = "https://archive.org/wayback/available"
HEX16 = re.compile(r"/(?:event|fight|fighter)-details/([0-9a-f]{16})")
FAMILY = {"events": "event-details", "fights": "fight-details", "fighters": "fighter-details"}


class WaybackMissing(Exception):
    """No usable capture exists for this URL. Counted, not fatal."""


class WaybackUnavailable(Exception):
    """Wayback/CDX is not answering. Fatal for the run; the reason is persisted."""
    def __init__(self, url: str, http_status: Optional[int], retries: int, detail: str = ""):
        super().__init__(f"wayback unavailable ({detail or http_status}) after {retries} tries: {url}")
        self.url, self.http_status, self.retries, self.detail = url, http_status, retries, detail


class WaybackClient:
    def __init__(self, cache_dir: Path, log, min_interval: float = 2.0, user_agent: str = "ufc-propbetedge-backfill/0.1", max_tries: int = 6):
        self.cache_dir = cache_dir
        self.log = log
        self.min_interval = min_interval
        self.max_tries = max_tries
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent})
        self._last = 0.0
        self._index: dict[str, dict[str, list[str]]] = {}
        self.index_failed: dict[str, dict] = {}     # kind -> {url, http_status, retries}
        self.requests_made = 0
        self.retries = 0
        self.last_status: Optional[int] = None
        self.last_response_class: Optional[str] = None

    # -- politeness ---------------------------------------------------------
    def _throttle(self):
        wait = self.min_interval - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def _get(self, url: str, params: Optional[dict] = None) -> requests.Response:
        """GET with backoff. Raises WaybackUnavailable after max_tries of 429/5xx/transport errors."""
        delay = 30.0
        status = None
        for attempt in range(self.max_tries):
            self._throttle()
            self.requests_made += 1
            try:
                r = self.session.get(url, params=params, timeout=120, allow_redirects=True)
            except requests.RequestException as e:
                status = None
                self.last_status, self.last_response_class = None, type(e).__name__
                self.retries += 1
                self.log.event("wayback_retry", url=url, attempt=attempt, error=str(e)[:160], sleep=int(min(delay, 600)))
                time.sleep(min(delay, 600)); delay *= 2
                continue
            status = r.status_code
            self.last_status, self.last_response_class = status, f"http_{status}"
            if status == 429 or status >= 500:
                self.retries += 1
                self.log.event("wayback_retry", url=url, attempt=attempt, status=status, sleep=int(min(delay, 600)))
                time.sleep(min(delay, 600)); delay *= 2
                continue
            return r
        raise WaybackUnavailable(url, status, self.max_tries)

    # -- CDX family index (best effort) --------------------------------------
    def _index_path(self, kind: str) -> Path:
        p = self.cache_dir / "_wayback_index" / f"{kind}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def index(self, kind: str) -> Optional[dict[str, list[str]]]:
        """kind -> {id: [timestamps newest-first]}; None when the bulk index could not be built this run."""
        if kind in self._index:
            return self._index[kind]
        if kind in self.index_failed:
            return None
        p = self._index_path(kind)
        if p.exists():
            self._index[kind] = json.loads(p.read_text(encoding="utf-8"))
            return self._index[kind]
        rows: list[list[str]] = []
        try:
            page = 0
            while True:
                r = self._get(CDX, params={"url": f"ufcstats.com/{FAMILY[kind]}/*", "output": "json", "fl": "timestamp,original,statuscode",
                                           "filter": "statuscode:200", "pageSize": 5, "page": page})
                data = r.json() if r.text.strip() else []
                if not data:
                    break
                rows.extend(data[1:] if data[0] and data[0][0] == "timestamp" else data)
                page += 1
                if len(data) < 2:
                    break
        except (WaybackUnavailable, ValueError) as e:
            info = {"url": getattr(e, "url", CDX), "http_status": getattr(e, "http_status", None), "retries": getattr(e, "retries", None), "error": str(e)[:200]}
            self.index_failed[kind] = info
            self.log.event("wayback_index_failed", family=kind, **{k: v for k, v in info.items() if k != "error"})
            return None
        idx: dict[str, list[str]] = {}
        for ts, original, _ in rows:
            m = HEX16.search(original)
            if m:
                idx.setdefault(m.group(1), []).append(ts)
        for k in idx:
            idx[k] = sorted(set(idx[k]), reverse=True)
        p.write_text(json.dumps(idx), encoding="utf-8")
        self.log.event("wayback_index", family=kind, ids=len(idx), captures=len(rows))
        self._index[kind] = idx
        return idx

    # -- per-URL lookups ------------------------------------------------------
    def _exact_cdx(self, original_url: str) -> Optional[list[str]]:
        """Timestamps newest-first for one URL, or None if CDX is unavailable."""
        try:
            r = self._get(CDX, params={"url": original_url, "output": "json", "fl": "timestamp,statuscode", "filter": "statuscode:200", "limit": "-25"})
        except WaybackUnavailable:
            return None
        try:
            data = r.json() if r.text.strip() else []
        except ValueError:
            return None
        ts = [row[0] for row in data if row and row[0] != "timestamp"]
        return sorted(set(ts), reverse=True)

    def _available(self, url: str) -> Optional[list[str]]:
        try:
            r = self._get(AVAILABLE, params={"url": url})
            snap = r.json().get("archived_snapshots", {}).get("closest")
        except (WaybackUnavailable, ValueError):
            return None
        return [snap["timestamp"]] if snap and snap.get("available") else []

    # -- content ------------------------------------------------------------
    def fetch(self, kind: str, key: str, original_url: str, is_bad_capture: Callable[[str], bool]) -> tuple[str, str]:
        """Returns (html, timestamp). Raises WaybackMissing (gap) or WaybackUnavailable (outage)."""
        timestamps: Optional[list[str]] = None
        if kind in FAMILY:
            idx = self.index(kind)
            if idx is not None:
                timestamps = list(idx.get(key, []))
        if not timestamps:
            timestamps = self._exact_cdx(original_url)
            if timestamps is None:
                timestamps = self._available(original_url)
            if timestamps is None:
                raise WaybackUnavailable(original_url, self.last_status, self.max_tries, "cdx and availability lookups both unavailable")
        if not timestamps:
            raise WaybackMissing(original_url)
        for ts in timestamps[:4]:
            r = self._get(f"http://web.archive.org/web/{ts}id_/{original_url}")
            if r.status_code != 200:
                self.log.event("wayback_capture_http", url=original_url, ts=ts, status=r.status_code)
                continue
            if is_bad_capture(r.text):
                self.log.event("wayback_bad_capture", url=original_url, ts=ts)
                continue
            return r.text, ts
        raise WaybackMissing(original_url)

    def status(self) -> dict:
        return {"requests": self.requests_made, "retries": self.retries, "last_status": self.last_status,
                "last_response_class": self.last_response_class, "index_failed": self.index_failed}
