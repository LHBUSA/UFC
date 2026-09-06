"""
Shared infrastructure for the UFC Stats backfill: config, fetch layer with
local cache + optional R2, batched Supabase writer, run log, Discord.

Parsers live in parsers.py and are the ONLY place HTML is interpreted.
Nothing here knows what a page looks like beyond "is this the interstitial".
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import datetime as dt
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")
load_dotenv(Path(__file__).resolve().parent / ".env")

ENUMS = json.load(open(ROOT / "shared" / "enums.json", encoding="utf-8"))

HEX16 = re.compile(r"([0-9a-f]{16})(?:/|$|\?)")


# ---------------------------------------------------------------------------
# Errors. SchemaAssertionError is the one that stops the world.
# ---------------------------------------------------------------------------
class SchemaAssertionError(Exception):
    """Page structure did not match expectations. Carries the offending URL."""
    def __init__(self, url: str, detail: str):
        super().__init__(f"{detail} @ {url}")
        self.url = url
        self.detail = detail


class AccessGateError(Exception):
    """The source returned its JS challenge interstitial instead of content."""


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
@dataclass
class Config:
    supabase_url: str = os.getenv("SUPABASE_URL", "").rstrip("/")
    supabase_key: str = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    discord_webhook: str = os.getenv("DISCORD_WEBHOOK_URL", "")
    base: str = os.getenv("UFCSTATS_BASE", "http://ufcstats.com").rstrip("/")
    user_agent: str = os.getenv("UFCSTATS_USER_AGENT", "Mozilla/5.0")
    min_interval: float = float(os.getenv("UFCSTATS_MIN_INTERVAL_SEC", "1.0"))
    cache_dir: Path = Path(os.getenv("HTML_CACHE_DIR", "./cache"))
    wayback_min_interval: float = float(os.getenv("WAYBACK_MIN_INTERVAL_SEC", "2.0"))
    r2_account: str = os.getenv("R2_ACCOUNT_ID", "")
    r2_key: str = os.getenv("R2_ACCESS_KEY_ID", "")
    r2_secret: str = os.getenv("R2_SECRET_ACCESS_KEY", "")
    r2_bucket: str = os.getenv("R2_BUCKET", "ufc-raw")
    batch_size: int = 500

    def require_supabase(self):
        if not self.supabase_url or not self.supabase_key:
            raise SystemExit("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (see .env.example)")


# ---------------------------------------------------------------------------
# Run log: stdout + JSONL
# ---------------------------------------------------------------------------
class RunLog:
    def __init__(self, name: str, log_dir: Path = Path("./logs")):
        log_dir.mkdir(parents=True, exist_ok=True)
        self.started = dt.datetime.now(dt.timezone.utc)
        self.path = log_dir / f"{name}_{self.started.strftime('%Y%m%dT%H%M%SZ')}.jsonl"
        self._fh = open(self.path, "a", encoding="utf-8")
        self.counters: dict[str, int] = {}
        self.assertion_failures: list[dict] = []

    def event(self, kind: str, **fields):
        rec = {"ts": dt.datetime.now(dt.timezone.utc).isoformat(), "kind": kind, **fields}
        self._fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self._fh.flush()
        line = " ".join(f"{k}={v}" for k, v in fields.items() if k != "traceback")
        print(f"[{kind}] {line}", flush=True)

    def bump(self, key: str, n: int = 1):
        self.counters[key] = self.counters.get(key, 0) + n

    def assertion(self, url: str, detail: str):
        self.assertion_failures.append({"url": url, "detail": detail,
                                        "at": dt.datetime.now(dt.timezone.utc).isoformat()})
        self.event("ASSERTION_FAILURE", url=url, detail=detail)

    def summary(self) -> dict:
        return {"started": self.started.isoformat(), "counters": self.counters,
                "assertion_failures": self.assertion_failures, "log": str(self.path)}


# ---------------------------------------------------------------------------
# Discord
# ---------------------------------------------------------------------------
def discord(cfg: Config, content: str, loud: bool = False) -> None:
    if not cfg.discord_webhook:
        return
    if loud:
        content = "@here " + content
    try:
        requests.post(cfg.discord_webhook, json={"content": content[:1900]}, timeout=15)
    except Exception as e:  # never let alerting kill the run
        print(f"[discord] failed: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Fetch layer
# ---------------------------------------------------------------------------
INTERSTITIAL_MARKERS = ("Checking your browser", "/__c", "This site requires JavaScript")


def is_interstitial(html: str) -> bool:
    head = html[:4000]
    return all(m in head for m in ("Checking your browser", "/__c")) or (
        len(html) < 6000 and "This site requires JavaScript" in head)


def extract_id(url: str) -> str:
    m = HEX16.search(url.rstrip("/") + "/")
    if not m:
        raise ValueError(f"no 16-hex id in {url}")
    return m.group(1)


class Fetcher:
    """Serial, rate-limited, cache-first HTML fetcher.

    kind in {"events", "fights", "fighters", "lists"}; cache key is the entity
    id (or a slug for list pages). On first fetch the raw HTML goes to
    cache_dir/{kind}/{key}.html and, if enabled, to R2 at ufc-raw/{kind}/{key}.html.

    source = "wayback" (default; decision 2026-09-05): every page comes from
    the Internet Archive via scripts/backfill/wayback.py. ufcstats.com is never
    contacted. A page with no usable capture raises WaybackMissing, which the
    pipeline counts and skips (a coverage gap, not a schema failure).

    source = "live": plain HTTP to ufcstats.com. Aborts on the JS challenge
    interstitial; the backfill does not solve it (only the Worker does).
    """

    def __init__(self, cfg: Config, log: RunLog, raw_to_r2: bool = False, offline: bool = False, source: str = "wayback"):
        self.cfg, self.log = cfg, log
        self.offline = offline
        self.source = source
        self.wayback = None
        if source == "wayback":
            from wayback import WaybackClient
            self.wayback = WaybackClient(cfg.cache_dir, log, min_interval=cfg.wayback_min_interval,
                                         user_agent="ufc-propbetedge-backfill/0.1 (+https://github.com/LHBUSA/UFC)")
        self.capture_ts: dict[str, str] = {}   # cache key -> wayback timestamp used
        self._last = 0.0
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": cfg.user_agent, "Accept": "text/html,*/*;q=0.8",
                                     "Accept-Language": "en-US,en;q=0.9"})
        self.r2 = self._r2_client() if raw_to_r2 else None

    def _r2_client(self):
        c = self.cfg
        if not (c.r2_account and c.r2_key and c.r2_secret):
            raise SystemExit("--raw-to-r2 needs R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY")
        import boto3  # optional dependency
        return boto3.client("s3", endpoint_url=f"https://{c.r2_account}.r2.cloudflarestorage.com",
                            aws_access_key_id=c.r2_key, aws_secret_access_key=c.r2_secret, region_name="auto")

    def _cache_path(self, kind: str, key: str) -> Path:
        p = self.cfg.cache_dir / kind / f"{key}.html"
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def _throttle(self):
        wait = self.cfg.min_interval - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def _http_get(self, url: str) -> str:
        """The one place a network request to the source is made."""
        for attempt in range(5):
            self._throttle()
            try:
                r = self.session.get(url, timeout=30)
            except requests.RequestException as e:
                self.log.event("fetch_retry", url=url, attempt=attempt, error=str(e)[:200])
                time.sleep(2 ** attempt)
                continue
            if r.status_code in (429, 500, 502, 503, 504):
                self.log.event("fetch_retry", url=url, attempt=attempt, status=r.status_code)
                time.sleep(5 * (2 ** attempt))
                continue
            if r.status_code != 200:
                raise SchemaAssertionError(url, f"HTTP {r.status_code}")
            html = r.text
            if is_interstitial(html):
                raise AccessGateError(
                    f"{url} returned the JS challenge interstitial. The fetch strategy in "
                    f"docs/scraper_notes.md has not been decided/implemented. Nothing was written.")
            return html
        raise SchemaAssertionError(url, "gave up after 5 attempts")

    def get(self, kind: str, key: str, url: str, refresh: bool = False) -> tuple[str, bool]:
        """Returns (html, from_cache)."""
        path = self._cache_path(kind, key)
        if path.exists() and not refresh:
            return path.read_text(encoding="utf-8"), True
        if self.offline:
            from wayback import WaybackMissing   # offline: an uncached page is a coverage gap, never fatal
            raise WaybackMissing(url)
        if self.wayback is not None:
            html, ts = self.wayback.fetch(kind, key, url, is_interstitial)
            self.capture_ts[f"{kind}/{key}"] = ts
            path.with_suffix(".meta.json").write_text(
                json.dumps({"source": "wayback", "timestamp": ts, "url": url, "captured_at": now_iso()}), encoding="utf-8")
        else:
            html = self._http_get(url)
        path.write_text(html, encoding="utf-8")
        if self.r2 is not None:
            self.r2.put_object(Bucket=self.cfg.r2_bucket, Key=f"ufc-raw/{kind}/{key}.html",
                               Body=html.encode("utf-8"), ContentType="text/html; charset=utf-8")
        self.log.bump(f"fetched_{kind}")
        return html, False


# ---------------------------------------------------------------------------
# Supabase (PostgREST) writer. Batches of 500, fresh session per batch,
# backoff on 5xx/429. Upserts on a named conflict target.
# ---------------------------------------------------------------------------
class Supabase:
    def __init__(self, cfg: Config, log: RunLog, dry_run: bool = False):
        cfg.require_supabase() if not dry_run else None
        self.cfg, self.log, self.dry_run = cfg, log, dry_run

    def _headers(self, extra: Optional[dict] = None) -> dict:
        key = self.cfg.supabase_key
        h = {"apikey": key, "Content-Type": "application/json", "Accept": "application/json"}
        if key.startswith("eyJ"):  # legacy JWT service key; sb_secret_* keys go on apikey only
            h["Authorization"] = f"Bearer {key}"
        h.update(extra or {})
        return h

    def _request(self, method: str, path: str, **kw) -> requests.Response:
        url = f"{self.cfg.supabase_url}/rest/v1/{path}"
        for attempt in range(6):
            with requests.Session() as s:  # fresh connection per call, per the brief
                try:
                    r = s.request(method, url, timeout=120, **kw)
                except requests.RequestException as e:
                    self.log.event("supabase_retry", path=path.split("?")[0], attempt=attempt, error=str(e)[:200])
                    time.sleep(2 ** attempt)
                    continue
            if r.status_code in (429, 500, 502, 503, 504, 520, 521, 522, 524):
                self.log.event("supabase_retry", path=path.split("?")[0], attempt=attempt, status=r.status_code)
                time.sleep(3 * (2 ** attempt))
                continue
            if r.status_code >= 400:
                raise RuntimeError(f"supabase {method} {path.split('?')[0]} -> {r.status_code}: {r.text[:300]}")
            return r
        raise RuntimeError(f"supabase {method} {path.split('?')[0]}: gave up")

    def select_all(self, table: str, columns: str = "*", filters: str = "", page: int = 1000) -> list[dict]:
        out, start = [], 0
        while True:
            q = f"{table}?select={columns}" + (f"&{filters}" if filters else "")
            r = self._request("GET", q, headers=self._headers({"Range-Unit": "items", "Range": f"{start}-{start + page - 1}"}))
            rows = r.json() or []
            out.extend(rows)
            if len(rows) < page:
                return out
            start += page

    def upsert(self, table: str, rows: list[dict], on_conflict: str) -> int:
        if not rows:
            return 0
        if self.dry_run:
            self.log.event("dry_run_upsert", table=table, rows=len(rows))
            return len(rows)
        n = 0
        for i in range(0, len(rows), self.cfg.batch_size):
            chunk = rows[i:i + self.cfg.batch_size]
            self._request("POST", f"{table}?on_conflict={on_conflict}",
                          headers=self._headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
                          data=json.dumps(chunk, ensure_ascii=False, default=str).encode("utf-8"))
            n += len(chunk)
            self.log.event("upsert", table=table, rows=len(chunk), total=n)
        return n

    def insert(self, table: str, rows: list[dict]) -> int:
        if not rows:
            return 0
        if self.dry_run:
            self.log.event("dry_run_insert", table=table, rows=len(rows))
            return len(rows)
        for i in range(0, len(rows), self.cfg.batch_size):
            chunk = rows[i:i + self.cfg.batch_size]
            self._request("POST", table, headers=self._headers({"Prefer": "return=minimal"}),
                          data=json.dumps(chunk, ensure_ascii=False, default=str).encode("utf-8"))
        return len(rows)

    def patch(self, table: str, filters: str, values: dict) -> None:
        if self.dry_run:
            self.log.event("dry_run_patch", table=table, filters=filters)
            return
        self._request("PATCH", f"{table}?{filters}", headers=self._headers({"Prefer": "return=minimal"}),
                      data=json.dumps(values, default=str).encode("utf-8"))


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()
