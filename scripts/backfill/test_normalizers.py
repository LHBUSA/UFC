"""Run: python scripts/backfill/test_normalizers.py  (from repo root).

Pins weight-class normalisation, and in particular the TUF international label
format that stopped window B-2014.

The bout was

    TUF Nations Canada vs. Australia Middleweight Tournament Title Bout

which reduces to "TUF Canada vs. Australia Middleweight". The country pairing
belongs to the season's name, not to the division, and the normaliser had no
way to tell — so it did the right thing and refused to guess. The rescue added
for it is deliberately narrow: it runs only after normal resolution has already
failed, it is anchored on the literal "TUF" prefix plus an "X vs. Y" pairing,
and it is accepted only when what remains is a division already in the map.

The two properties that matter are tested here rather than described: nothing
that resolved before resolves differently now, and a label that merely contains
a country name is untouched and still fails closed.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import normalizers as N  # noqa: E402
from common import SchemaAssertionError  # noqa: E402

URL = "http://ufcstats.com/fight-details/273f9520d75f3dac"
failures = 0


def expect(label, weight_class, womens=None, title=None):
    global failures
    try:
        got = N.norm_weight_class(label, URL)
    except SchemaAssertionError as e:
        failures += 1
        print(f"FAIL: {label!r} raised {e}")
        return
    if got["weight_class"] != weight_class:
        failures += 1
        print(f"FAIL: {label!r} -> {got['weight_class']!r}, wanted {weight_class!r}")
        return
    if womens is not None and got["is_womens"] != womens:
        failures += 1
        print(f"FAIL: {label!r} is_womens={got['is_womens']}, wanted {womens}")
        return
    if title is not None and got["is_title"] != title:
        failures += 1
        print(f"FAIL: {label!r} is_title={got['is_title']}, wanted {title}")


def expect_raises(label):
    global failures
    try:
        got = N.norm_weight_class(label, URL)
    except SchemaAssertionError:
        return
    failures += 1
    print(f"FAIL: {label!r} resolved to {got} but an unknown division must fail closed")


# The exact label that failed B-2014, and the other division on that card.
expect("TUF Nations Canada vs. Australia Middleweight Tournament Title Bout", "MIDDLEWEIGHT", title=True)
expect("TUF Nations Canada vs. Australia Welterweight Tournament Title Bout", "WELTERWEIGHT", title=True)

# Regressions. None of these may change.
expect("Middleweight Bout", "MIDDLEWEIGHT", title=False)
expect("UFC Middleweight Title Bout", "MIDDLEWEIGHT", title=True)
expect("UFC Women's Bantamweight Title Bout", "BANTAMWEIGHT", womens=True, title=True)
expect("Women's Strawweight Bout", "STRAWWEIGHT", womens=True)
expect("Light Heavyweight Bout", "LIGHT_HEAVYWEIGHT")
expect("Road to UFC 3 Bantamweight Tournament Title Bout", "BANTAMWEIGHT", title=True)
expect("Catch Weight Bout", "CATCHWEIGHT")
expect("Open Weight Bout", "OPEN")
expect("UFC 2 Tournament Title Bout", None)   # early tournaments carried no division
expect("", None)

# Unknown divisions still fail closed, including inside a TUF label.
expect_raises("TUF Nations Canada vs. Australia Fictionalweight Tournament Title Bout")
expect_raises("Ultraweight Bout")
expect_raises("TUF Nations Canada vs. Australia Tournament Title Bout")

# The rescue is anchored on TUF. A label that merely contains a country name or
# a "vs" is NOT rescued — country names are never stripped globally.
expect_raises("Canada vs. Australia Middleweight Bout")
expect_raises("Brazil vs. USA Welterweight Bout")
expect_raises("Nations Canada vs. Australia Middleweight Bout")

# Other TUF editions are NOT added speculatively. When a real fixture shows
# "TUF Brazil 3 Middleweight ..." or a Smashes label in the wild, it gets a
# test here and, if it needs one, a rule. Until then it fails closed like
# anything else we have not seen.

# ---------------------------------------------------------------------------
# The tournament era, 1993-1999.
#
# Four windows failed here: B-1995 and B-1996 on the Ultimate Ultimate cards,
# B-1997 and B-1999 on the two Ultimate Japan cards. Two different things were
# landing in the division slot — the event series name, and where a fighter
# stood in the bracket. Neither is a weight.

# The series name is stripped and the real division survives.
expect("UFC Japan Openweight Bout", "OPEN")
expect("UFC Japan Heavyweight Bout", "HEAVYWEIGHT")
expect("UFC Japan Lightweight Bout", "LIGHTWEIGHT")
expect("Ultimate Japan Openweight Bout", "OPEN")
expect("UFC Japan Middleweight Tournament Title Bout", "MIDDLEWEIGHT", title=True)
expect("UFC Ultimate Ultimate 96 Openweight Bout", "OPEN")

# A bracket position is not a division, and a bout that had no division still
# resolves to None rather than failing — the same answer "UFC 2 Tournament
# Title Bout" already gets, for the same reason.
expect("Tournament Semifinal Bout", None)
expect("Tournament Quarterfinal Bout", None)
expect("Alternate Bout", None)
expect("UFC Ultimate Ultimate 95 Tournament Title Bout", None, title=True)
expect("UFC Japan Tournament Title Bout", None, title=True)

# Both leftovers can appear at once.
expect("Openweight Tournament Semifinal Bout", "OPEN")
expect("Heavyweight Tournament Alternate Bout", "HEAVYWEIGHT")

# The two labels that actually stopped B-1995 and B-1996, verbatim from the
# worker's own assertion output. The year is written "'96", the generic numeric
# strip takes the digits, and a lone apostrophe is left behind — enough to make
# the rescue reject a label it had otherwise resolved completely.
expect("Ultimate Ultimate '96 Tournament Title Bout", None, title=True)
expect("Ultimate Ultimate '95 Tournament Title Bout", None, title=True)
expect("Ultimate Ultimate '96 Openweight Bout", "OPEN")

# And it still cannot invent a division. Stripping the series name off a label
# whose remainder is not a real weight leaves it failing closed, exactly as
# before.
expect_raises("Ultimate Ultimate Bogusweight Bout")
expect_raises("UFC Japan Ultraweight Bout")

# The lists are closed on purpose. Another country or another round word is
# added when a window actually fails on it, not in anticipation of one.
expect_raises("UFC Ireland Openweight Bout")

# The invariant that makes the rescue safe, asserted rather than described:
# every label it accepts comes back either as a division already in the map or
# as None. An unknown weight stays unknown. There is no input for which the
# rescue produces a division the label did not name.
_ALLOWED = set(N.ENUMS["weight_class"]["map"].values()) | {None}
for _label in [
    "Ultimate Ultimate '96 Tournament Title Bout",
    "Ultimate Ultimate '95 Tournament Title Bout",
    "UFC Japan Openweight Bout",
    "UFC Japan Tournament Title Bout",
    "Alternate Bout",
    "Tournament Semifinal Bout",
    "Heavyweight Tournament Alternate Bout",
    "'96 Bout",
]:
    _got = N.norm_weight_class(_label, "https://example.invalid/invariant")["weight_class"]
    if _got not in _ALLOWED:
        print(f"FAIL invariant: {_label!r} produced {_got!r}, which is not a known division nor None")
        failures += 1

if failures:
    print(f"\n{failures} failure(s)")
    sys.exit(1)
print("normalizer tests passed")
