#!/usr/bin/env python
"""
Copy shared/ (enums.json, alias_resolver.mjs) into each worker's src/shared/
so every worker folder is self-contained and deployable from C:\\Workers\\.
Run after any change to shared/. Also builds the numbered deploy zip when
--zip is given.

  python scripts/sync_shared.py            # sync only
  python scripts/sync_shared.py --zip 1    # sync + ufc-stats-ingest-v1.zip in dist/
"""
import argparse
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHARED_FILES = ["enums.json", "alias_resolver.mjs"]
WORKERS = [p for p in (ROOT / "workers").iterdir() if (p / "wrangler.toml").exists()]


def sync():
    for w in WORKERS:
        dst = w / "src" / "shared"
        dst.mkdir(parents=True, exist_ok=True)
        for f in SHARED_FILES:
            shutil.copyfile(ROOT / "shared" / f, dst / f)
        print(f"synced shared/ -> {dst.relative_to(ROOT)}")


def zip_worker(name: str, n: int):
    w = ROOT / "workers" / name
    out = ROOT / "dist"
    out.mkdir(exist_ok=True)
    target = out / f"{name}-v{n}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for p in w.rglob("*"):
            if p.is_dir() or "node_modules" in p.parts or ".wrangler" in p.parts or p.name.endswith(".test.mjs"):
                continue
            z.write(p, Path(name) / p.relative_to(w))
    print(f"wrote {target.relative_to(ROOT)}  (unzip into C:\\Workers\\ -> C:\\Workers\\{name}\\)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", type=int, help="build numbered zip for every worker")
    a = ap.parse_args()
    sync()
    if a.zip:
        for w in WORKERS:
            zip_worker(w.name, a.zip)
    sys.exit(0)
