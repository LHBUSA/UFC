"""Run: python scripts/backfill/test_capability_guard.py  (from repo root).

Proves the worker refuses to start against a normaliser that cannot resolve
labels this repository already depends on.

The guard lives in backfill_ufcstats.main() rather than in a launcher because
the launcher is not what selects the normaliser — the location of the worker
is. Python imports the normalizers.py beside whichever copy of the worker runs,
and there are four copies of this tree on a working machine that do not agree.
A guard in one launcher protects one launcher. This protects every way of
starting a run, including one typed by hand.

The test swaps the normalizers module for a stand-in, because the alternative —
copying a whole tree to get an old normaliser onto the path — tests the copying
more than it tests the guard.
"""
from __future__ import annotations

import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

failures = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global failures
    if condition:
        return
    failures += 1
    print(f"FAIL: {name}{(' - ' + detail) if detail else ''}")


def guard_with(capabilities) -> int | None:
    """Run the guard against a stand-in normaliser. Returns the exit code, or None."""
    stub = types.ModuleType("normalizers")
    if capabilities is not None:
        stub.NORMALIZER_CAPABILITIES = capabilities
    stub.__file__ = "<stand-in normalizers.py>"

    saved = sys.modules.get("normalizers")
    sys.modules["normalizers"] = stub
    try:
        import importlib
        import backfill_ufcstats
        importlib.reload(backfill_ufcstats)
        backfill_ufcstats.normalizers = stub
        try:
            backfill_ufcstats._assert_normalizer_capable()
        except SystemExit as exc:
            return int(exc.code)
        return None
    finally:
        if saved is None:
            sys.modules.pop("normalizers", None)
        else:
            sys.modules["normalizers"] = saved


FULL = {"tuf-matchup-prefix", "early-series", "bracket-round"}

check("a fully capable normaliser is accepted", guard_with(FULL) is None)

check(
    "a normaliser missing the tournament-era rescue is refused",
    guard_with(FULL - {"early-series"}) == 2,
)
check(
    "a normaliser missing the TUF rescue is refused",
    guard_with(FULL - {"tuf-matchup-prefix"}) == 2,
)
check(
    "a normaliser missing the bracket-round rescue is refused",
    guard_with(FULL - {"bracket-round"}) == 2,
)
check(
    "a normaliser declaring nothing is refused",
    guard_with(set()) == 2,
)
check(
    "a normaliser too old to declare anything at all is refused",
    guard_with(None) == 2,
    "absence of the declaration is itself the failure",
)
check(
    "extra capabilities we do not require are not a problem",
    guard_with(FULL | {"something-added-later"}) is None,
)

# And the real normaliser beside this test must pass, or the guard would block
# every run in this worktree.
import normalizers as real_normalizers  # noqa: E402

check(
    "the normaliser shipped in this worktree satisfies the guard",
    set(getattr(real_normalizers, "NORMALIZER_CAPABILITIES", ())) >= FULL,
    f"declares {sorted(getattr(real_normalizers, 'NORMALIZER_CAPABILITIES', ()))}",
)

if failures:
    print(f"\n{failures} failure(s)")
    sys.exit(1)
print("capability guard tests passed")
