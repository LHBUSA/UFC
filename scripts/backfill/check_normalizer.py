"""Refuse to start a backfill against a normaliser that cannot resolve the
labels we already know about.

    python check_normalizer.py [<directory holding normalizers.py>]

Exits 0 when the normaliser in that directory declares every capability this
repository depends on, and non-zero with an explanation when it does not.

Why this exists.

There are four copies of normalizers.py on a working machine — the main
checkout and three worktrees — and Python imports whichever one sits beside the
worker being run. Two of the four have no rescues at all. The original launcher
does `Set-Location $PSScriptRoot` and then `python backfill_ufcstats.py`, so
starting it from the main checkout silently selects a normaliser that fails on
exactly the labels four windows already failed on: the Ultimate Ultimate and
Ultimate Japan cards, and the TUF Nations final. The run does not announce
this. It gets several windows in and dies with an assertion that reads like a
new problem rather than an old one running from the wrong directory.

Capabilities are checked by name rather than by comparing a version string,
because the question a launcher needs answered is "can this resolve the labels
I am about to feed it", and a version number only answers it if you already
know which version introduced what. A missing capability names the failure it
would have caused.
"""
from __future__ import annotations

import importlib.util
import os
import sys

# What any run against this repository's data requires. Adding a rescue means
# adding its name here, so a worktree that has not picked it up says so instead
# of failing mid-run.
REQUIRED = {
    "tuf-matchup-prefix": "TUF international finals; stopped window B-2014",
    "early-series": "Ultimate Ultimate / Ultimate Japan cards; stopped B-1995, B-1996, B-1997, B-1999",
    "bracket-round": "tournament round labels such as 'Alternate Bout'",
}


def load(directory: str):
    path = os.path.join(directory, "normalizers.py")
    if not os.path.exists(path):
        print(f"[normalizer_check] FAIL no normalizers.py in {directory}", file=sys.stderr)
        return None, path
    # common.py sits beside it and normalizers imports from it.
    if directory not in sys.path:
        sys.path.insert(0, directory)
    spec = importlib.util.spec_from_file_location("_normalizers_under_check", path)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:                      # noqa: BLE001 - reported, not raised
        print(f"[normalizer_check] FAIL {path} did not import: {exc}", file=sys.stderr)
        return None, path
    return module, path


def main() -> int:
    directory = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__)))
    module, path = load(directory)
    if module is None:
        return 2

    have = set(getattr(module, "NORMALIZER_CAPABILITIES", ()) or ())
    missing = [name for name in REQUIRED if name not in have]

    if missing:
        print(f"[normalizer_check] FAIL {path}", file=sys.stderr)
        print("  this normaliser is missing capabilities this repository depends on:", file=sys.stderr)
        for name in missing:
            print(f"    - {name}: {REQUIRED[name]}", file=sys.stderr)
        print("  a run started here would fail on labels that are already fixed elsewhere.", file=sys.stderr)
        print("  use the worktree whose normalizers.py declares them, or bring this copy up to date.", file=sys.stderr)
        return 1

    print(f"[normalizer_check] ok {path}")
    print(f"  capabilities: {', '.join(sorted(have))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
