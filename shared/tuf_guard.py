"""The Ultimate Fighter in-house events are not UFC events.

Mirror of shared/tuf_guard.mjs (read that file for why). ESPN lists TUF house
fights as events such as "The Ultimate Fighter 29 Semifinal"; stored as UFC
events their exhibition bouts would reach professional records. A finale is a
real card and never matches.
"""
from __future__ import annotations

import re

_TUF = re.compile(r"\b(the\s+)?ultimate\s+fighter\b|\btuf\b", re.I)
_IN_HOUSE = re.compile(
    r"\b(semi[\s-]?finals?|quarter[\s-]?finals?|elimination|entry\s+round|opening\s+round|"
    r"round\s+of\s+(16|sixteen|32)|wild\s?card|episode\s*\d*|house\s+fights?)\b",
    re.I,
)
_FINALE = re.compile(r"\bfinale\b", re.I)


def tuf_in_house_event_reason(name: str | None) -> str | None:
    n = str(name or "")
    if not _TUF.search(n) or _FINALE.search(n) or not _IN_HOUSE.search(n):
        return None
    return f'"{n}" is a TUF in-house stage, not a sanctioned UFC event; its bouts are exhibitions'


def is_tuf_in_house_event(name: str | None) -> bool:
    return tuf_in_house_event_reason(name) is not None
