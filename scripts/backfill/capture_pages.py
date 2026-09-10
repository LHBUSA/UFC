"""Capture specific UFC Stats pages through the validated backfill's Fetcher.

    python scripts/backfill/capture_pages.py want.json [--source wayback|live]

want.json: [{"kind": "fights"|"events"|"fighters", "id": "<16 hex>", "min_ts": "YYYYMMDD"?}]

Pages land in HTML_CACHE_DIR/{kind}/{id}.html exactly where backfill_ufcstats.py
would put them, with the same capture rules: a JS-challenge interstitial is
never cached, a fight page without a result (a preview) is never cached, and
Wayback captures older than min_ts are skipped. Nothing is written to the
database. The default source is Wayback, which never contacts ufcstats.com;
--source live aborts on the first challenge rather than answering it.
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from common import Config, RunLog, Fetcher  # noqa: E402
import parsers  # noqa: E402
from wayback import WaybackMissing, WaybackUnavailable  # noqa: E402

PATH = {"events": "event-details", "fights": "fight-details", "fighters": "fighter-details"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("want")
    ap.add_argument("--source", choices=["wayback", "live"], default="wayback")
    a = ap.parse_args()
    want = json.load(open(a.want, encoding="utf-8"))
    cfg = Config()
    log = RunLog("capture_pages")
    fx = Fetcher(cfg, log, raw_to_r2=False, offline=False, source=a.source)
    out = {"captured": [], "cached": 0, "missing": [], "unavailable": None}
    try:
        for w in want:
            url = f"{cfg.base}/{PATH[w['kind']]}/{w['id']}"
            bad = parsers.is_pre_result_fight_page if w["kind"] == "fights" else None
            try:
                _, cached = fx.get(w["kind"], w["id"], url, bad_capture=bad, min_ts=w.get("min_ts"))
                if cached:
                    out["cached"] += 1
                else:
                    out["captured"].append({"kind": w["kind"], "id": w["id"], "ts": fx.capture_ts.get(f"{w['kind']}/{w['id']}")})
            except WaybackMissing:
                out["missing"].append({"kind": w["kind"], "id": w["id"]})
    except WaybackUnavailable as e:
        out["unavailable"] = str(e)[:300]
    print(json.dumps({"captured": len(out["captured"]), "cached": out["cached"], "missing": len(out["missing"]),
                      "unavailable": out["unavailable"], "log": str(log.path)}, indent=1))
    json.dump(out, open(Path(a.want).with_suffix(".result.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
