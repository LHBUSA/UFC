"""
String -> enum normalizers driven by shared/enums.json. These depend only on
the raw strings UFC Stats prints, not on page structure, so they are written
and tested now. Every unknown value raises SchemaAssertionError.

Mirror: workers/ufc-stats-ingest/src/normalizers.mjs (same enums.json, same
fixtures in shared/tests/normalizer_fixtures.json).
"""
from __future__ import annotations

import re
from typing import Optional

from common import ENUMS, SchemaAssertionError

_RND = re.compile(r"^\s*(\d+)\s*Rnd", re.I)
_MMSS = re.compile(r"^\s*(\d+):(\d{1,2})\s*$")
_X_OF_Y = re.compile(r"^\s*(\d+)\s+of\s+(\d+)\s*$", re.I)
_HEIGHT = re.compile(r"^\s*(\d+)'\s*(\d+)\"?\s*$")
_RECORD = re.compile(r"Record:\s*(\d+)-(\d+)-(\d+)(?:\s*\((\d+)\s*NC\))?", re.I)


def norm_method(raw: str, url: str) -> str:
    """'Decision - Unanimous' -> DEC_U. First line of a two-line method cell only."""
    key = (raw or "").strip().splitlines()[0].strip() if raw and raw.strip() else ""
    m = ENUMS["method"]["map"]
    if key in m:
        return m[key]
    raise SchemaAssertionError(url, f"unknown method {raw!r}")


# "TUF <edition> <side A> vs. <side B> " where a division follows. Anchored at
# the start and requiring the TUF prefix, so it matches the international
# seasons' verified label format and nothing else. Only the formats we have
# actually seen in source data belong here; more are added when a fixture
# proves them, not in anticipation.
_TUF_MATCHUP_PREFIX = re.compile(
    r"^\s*TUF\s+"
    r"[A-Za-z][A-Za-z.'\-]*(?:\s+[A-Za-z][A-Za-z.'\-]*)*?"
    r"\s+vs\.?\s+"
    r"[A-Za-z][A-Za-z.'\-]*(?:\s+[A-Za-z][A-Za-z.'\-]*)*?"
    r"\s+(?=\S)",
    re.I,
)

# The tournament era, 1993-1999. Four windows failed on it — B-1995, B-1996,
# B-1997 and B-1999 — and the four events they died on say what the two
# leftovers are:
#
#   Ultimate Ultimate '95, Ultimate Ultimate '96   the EVENT SERIES name lands
#   Ultimate Japan, Ultimate Japan 2               in the division slot, the
#                                                  same way Brazil and China
#                                                  already do above.
#
#   "Tournament Semifinal Bout", "Alternate Bout"  the BRACKET POSITION lands
#                                                  there too. Where a fighter
#                                                  stood in a tournament is not
#                                                  what weight he stood at.
#
# Both lists are closed: only strings our own failing events produced. A new
# series or a new round word is added when a window proves it, not in
# anticipation of one.
_EARLY_SERIES = re.compile(r"\b(Ultimate Ultimate|Ultimate Japan|Japan)\b", re.I)
_BRACKET_ROUND = re.compile(r"\b(Semifinals?|Quarterfinals?|Alternate|Final)\b", re.I)

# What is left once a series name goes. The real label is
#   "Ultimate Ultimate '96 Tournament Title Bout"
# and the generic numeric strip above has already taken the 96, so removing the
# series leaves a lone apostrophe. It is punctuation from a year that no longer
# exists, not a division, and without dropping it the rescue sees a non-empty
# remainder and refuses a label it has in fact fully resolved. Confined to this
# rescue, where the result must still match a known division or be empty, so it
# cannot make anything else resolve.
_ORPHAN_PUNCT = re.compile(r"[‘’'`.,\-]+")


def norm_weight_class(raw: str, url: str) -> dict:
    """'UFC Women's Bantamweight Title Bout' -> {weight_class: BANTAMWEIGHT, is_womens: True, is_title: True}.
    Empty string (some very old bouts) -> weight_class None."""
    wc = ENUMS["weight_class"]
    s = (raw or "").strip()
    if not s:
        return {"weight_class": None, "is_womens": False, "is_title": False}
    is_womens = wc["womens_marker"].lower() in s.lower()
    is_title = any(t.lower() in s.lower() for t in wc["title_markers"])
    core = s
    # Feeder-series prefix. "Road to UFC 3 Bantamweight Tournament Title Bout"
    # is an ordinary Bantamweight title bout staged inside a regional series,
    # and the series name is not part of the division. It has to go before the
    # generic token pass, which would otherwise remove "UFC" and the season
    # number and leave the unmatchable remainder "Road to Bantamweight".
    # The raw label is still stored verbatim in weight_class_raw, so the
    # tournament context is preserved rather than discarded.
    core = re.sub(r"^\s*Road to UFC\b\s*\d*", " ", core, flags=re.I)
    core = re.sub(re.escape(wc["womens_marker"]), " ", core, flags=re.I)
    for tok in wc["strip_tokens"]:
        core = re.sub(r"\b" + re.escape(tok) + r"\b", " ", core, flags=re.I)
    core = re.sub(r"\b\d+\b", " ", core)                      # "Ultimate Fighter 1 ..."
    core = re.sub(r"\b(Latin America|Brazil|China|Nations|Australia vs\.? UK|Team [A-Za-z]+)\b", " ", core, flags=re.I)
    core = re.sub(r"\s+", " ", core).strip()
    if not core:   # e.g. "UFC 2 Tournament Title Bout": early tournaments carried no weight class
        return {"weight_class": None, "is_womens": is_womens, "is_title": is_title}
    for k, v in wc["map"].items():
        if core.lower() == k.lower():
            return {"weight_class": v, "is_womens": is_womens, "is_title": is_title}

    # Last chance, and only for a TUF label whose matchup leaked into the
    # division. B-2014 stopped on
    #   "TUF Nations Canada vs. Australia Middleweight Tournament Title Bout"
    # which reduces to "TUF Canada vs. Australia Middleweight": the country
    # pairing is part of the SEASON's name, not of the weight class.
    #
    # Deliberately a rescue rather than another pass over every label. It runs
    # only after normal resolution has already failed, and it is accepted only
    # if what remains is a division we recognise, so it cannot change the
    # outcome of any label that resolves today and cannot turn an unknown
    # division into a known one. The anchor is the literal "TUF" prefix plus an
    # "X vs. Y" pairing followed by something else; a label that merely
    # contains a country name is untouched and still fails closed.
    rescued = _TUF_MATCHUP_PREFIX.sub(" ", core, count=1).strip()
    if rescued and rescued != core:
        for k, v in wc["map"].items():
            if rescued.lower() == k.lower():
                return {"weight_class": v, "is_womens": is_womens, "is_title": is_title}

    # Second rescue, on the same terms as the first: it runs only after normal
    # resolution has failed, it strips only the closed lists above, and it is
    # accepted only if what remains is a division we recognise or nothing at
    # all. So it cannot change any label that resolves today, and it cannot
    # invent a division — "Japan Featherweight" is still not a weight class and
    # still fails closed.
    #
    # Resolving to nothing is a real answer here, not a failure to find one.
    # "Alternate Bout" and "UFC Japan Tournament Title Bout" carry no division
    # because those bouts had none, which is exactly what the empty-core branch
    # above already concludes for "UFC 2 Tournament Title Bout".
    early = _BRACKET_ROUND.sub(" ", _EARLY_SERIES.sub(" ", core))
    early = _ORPHAN_PUNCT.sub(" ", early)
    early = re.sub(r"\s+", " ", early).strip()
    if early != core:
        if not early:
            return {"weight_class": None, "is_womens": is_womens, "is_title": is_title}
        for k, v in wc["map"].items():
            if early.lower() == k.lower():
                return {"weight_class": v, "is_womens": is_womens, "is_title": is_title}

    raise SchemaAssertionError(url, f"unknown weight class {raw!r} (core={core!r})")


def norm_stance(raw: Optional[str], url: str) -> Optional[str]:
    s = (raw or "").strip()
    st = ENUMS["stance"]
    if s in st["null_values"]:
        return None
    if s in st["map"]:
        return st["map"][s]
    raise SchemaAssertionError(url, f"unknown stance {raw!r}")


def scheduled_rounds(time_format: Optional[str], url: str) -> Optional[int]:
    s = (time_format or "").strip()
    sr = ENUMS["scheduled_rounds"]
    if any(s.startswith(nv) for nv in sr["null_values"] if nv) or s == "":
        return None
    m = _RND.match(s)
    if m:
        return int(m.group(1))
    raise SchemaAssertionError(url, f"unknown time format {time_format!r}")


def mmss_to_sec(raw: Optional[str], url: str) -> Optional[int]:
    s = (raw or "").strip()
    if s in ("", "--"):
        return None
    m = _MMSS.match(s)
    if not m:
        raise SchemaAssertionError(url, f"bad mm:ss {raw!r}")
    return int(m.group(1)) * 60 + int(m.group(2))


def x_of_y(raw: Optional[str], url: str) -> tuple[Optional[int], Optional[int]]:
    s = (raw or "").strip()
    if s in ("", "--", "---"):
        return None, None
    m = _X_OF_Y.match(s)
    if not m:
        raise SchemaAssertionError(url, f"bad 'x of y' {raw!r}")
    return int(m.group(1)), int(m.group(2))


def int_or_none(raw: Optional[str], url: str) -> Optional[int]:
    s = (raw or "").strip()
    if s in ("", "--", "---"):
        return None
    if not s.isdigit():
        raise SchemaAssertionError(url, f"bad int {raw!r}")
    return int(s)


def pct_or_none(raw: Optional[str], url: str) -> Optional[float]:
    s = (raw or "").strip().rstrip("%")
    if s in ("", "--"):
        return None
    try:
        return float(s)
    except ValueError:
        raise SchemaAssertionError(url, f"bad percent {raw!r}")


def num_or_none(raw: Optional[str], url: str) -> Optional[float]:
    s = (raw or "").strip()
    if s in ("", "--"):
        return None
    try:
        return float(s)
    except ValueError:
        raise SchemaAssertionError(url, f"bad number {raw!r}")


def height_in(raw: Optional[str], url: str) -> Optional[float]:
    s = (raw or "").strip()
    if s in ("", "--"):
        return None
    m = _HEIGHT.match(s)
    if not m:
        raise SchemaAssertionError(url, f"bad height {raw!r}")
    return int(m.group(1)) * 12 + int(m.group(2))


def reach_in(raw: Optional[str], url: str) -> Optional[float]:
    s = (raw or "").strip().rstrip('"').strip()
    return num_or_none(s, url)


def weight_lbs(raw: Optional[str], url: str) -> Optional[float]:
    s = re.sub(r"\s*lbs\.?$", "", (raw or "").strip(), flags=re.I)
    return num_or_none(s, url)


def record(raw: str, url: str) -> dict:
    """'Record: 20-3-0 (1 NC)' -> {record_w:20, record_l:3, record_d:0, record_nc:1}"""
    m = _RECORD.search(raw or "")
    if not m:
        raise SchemaAssertionError(url, f"bad record {raw!r}")
    return {"record_w": int(m.group(1)), "record_l": int(m.group(2)), "record_d": int(m.group(3)),
            "record_nc": int(m.group(4)) if m.group(4) else 0}


def event_date(raw: str, url: str) -> str:
    """'February 15, 2026' -> '2026-02-15'"""
    import datetime as dt
    s = (raw or "").strip()
    for fmt in ("%B %d, %Y", "%b %d, %Y"):
        try:
            return dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    raise SchemaAssertionError(url, f"bad event date {raw!r}")


def dob(raw: Optional[str], url: str) -> Optional[str]:
    s = (raw or "").strip()
    if s in ("", "--"):
        return None
    return event_date(s, url)


def scorecards(details: str) -> Optional[list[dict]]:
    """'Sal D'Amato 29-28. Derek Cleary 29-28. Chris Lee 28-29.' -> [{judge, score}, ...]; None if no scores."""
    found = re.findall(r"([A-Za-z][A-Za-z .'\-]+?)\s+(\d{1,3}\s*-\s*\d{1,3})\s*\.?", details or "")
    if not found:
        return None
    return [{"judge": j.strip(), "score": re.sub(r"\s+", "", sc)} for j, sc in found]
