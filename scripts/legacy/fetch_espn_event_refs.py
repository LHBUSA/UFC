"""Capture the ESPN core-API documents one legacy event's competitions point at.

Read-only and bounded: one event, the $ref documents its competitions name
(status, officials, athletes, venue), one request per second, each document
written once to an evidence directory OUTSIDE the repo with its URL, HTTP
status and sha256. Nothing is written to the database.

    python scripts/legacy/fetch_espn_event_refs.py \
        --event-json D:/Workers/_research/ufc-legacy-origins-2026-09-12/feeds/raw/espn_core_event_400255729.json \
        --out D:/Workers/_research/ufc-legacy-origins-2026-09-12/espn_ufc1

A document that already exists in --out is not re-fetched.
"""
import argparse
import hashlib
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

UA = "PropBetEdge-legacy-origins/0.1 (evidence capture; low volume)"
ALLOWED = re.compile(r"^https?://sports\.core\.api\.espn\.com/v2/sports/mma/")


def slug(url: str) -> str:
    path = re.sub(r"^https?://sports\.core\.api\.espn\.com/v2/sports/mma/", "", url.split("?")[0])
    return re.sub(r"[^A-Za-z0-9]+", "_", path).strip("_") + ".json"


def refs_for(event: dict) -> list[str]:
    urls = []
    for comp in event.get("competitions", []):
        for key in ("status", "officials"):
            ref = (comp.get(key) or {}).get("$ref")
            if ref:
                urls.append(ref)
        venue = (comp.get("venue") or {}).get("$ref")
        if venue:
            urls.append(venue)
        for competitor in comp.get("competitors", []):
            ref = (competitor.get("athlete") or {}).get("$ref")
            if ref:
                urls.append(ref)
    for venue in event.get("venues", []) or []:
        if venue.get("$ref"):
            urls.append(venue["$ref"])
    seen, out = set(), []
    for url in urls:
        key = url.split("?")[0].replace("http://", "https://")
        if key not in seen:
            seen.add(key)
            out.append(key + "?lang=en&region=us")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--event-json", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-requests", type=int, default=40)
    args = ap.parse_args()

    event = json.loads(pathlib.Path(args.event_json).read_text(encoding="utf-8"))
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    urls = refs_for(event)
    if len(urls) > args.max_requests:
        print(f"refusing: {len(urls)} refs exceeds --max-requests {args.max_requests}", file=sys.stderr)
        return 2

    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    fetched = 0
    for url in urls:
        if not ALLOWED.match(url):
            print(f"refusing non-ESPN-core url {url}", file=sys.stderr)
            return 2
        name = slug(url)
        if (out / name).exists():
            continue
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body, status = resp.read(), resp.status
        except urllib.error.HTTPError as exc:
            body, status = exc.read(), exc.code
        if status != 200:
            print(f"FAILED {status} {url}", file=sys.stderr)
            return 3
        json.loads(body)  # fail loudly on a non-JSON body
        (out / name).write_bytes(body)
        manifest[name] = {
            "url": url,
            "status": status,
            "sha256": hashlib.sha256(body).hexdigest(),
            "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        fetched += 1
        time.sleep(1.0)
    manifest_path.write_text(json.dumps(manifest, indent=1, sort_keys=True), encoding="utf-8")
    print(f"refs={len(urls)} fetched={fetched} already_present={len(urls) - fetched}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
