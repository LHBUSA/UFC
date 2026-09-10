"""Parse normalized MMA career facts from an English Wikipedia fighter page.

This module is deliberately network/database free. The fetcher uses the
MediaWiki Action API and passes the parsed HTML here. We extract only structured
facts from the fighter's "Mixed martial arts record" table and retain page/row
provenance outside this module.
"""
from __future__ import annotations

import datetime as dt
import re
import unicodedata
from dataclasses import dataclass, asdict
from urllib.parse import unquote

from bs4 import BeautifulSoup

_TRANSLIT = str.maketrans({
    "ł": "l", "ø": "o", "đ": "d", "ð": "d", "þ": "th", "ß": "ss",
    "æ": "ae", "œ": "oe", "ı": "i", "ŋ": "n", "ħ": "h", "ŧ": "t",
})


def normalize_name(value: str | None) -> str:
    if not value:
        return ""
    value = unicodedata.normalize("NFKD", str(value).lower()).translate(_TRANSLIT)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = re.sub(r"['’.`]", "", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def clean_text(node) -> str:
    if node is None:
        return ""
    text = " ".join(node.stripped_strings)
    text = re.sub(r"\[[a-z0-9 ]+\]", "", text, flags=re.I)
    return re.sub(r"\s+", " ", text).strip()


def wiki_title_from_href(href: str | None) -> str | None:
    if not href or not href.startswith("/wiki/"):
        return None
    title = unquote(href[6:]).split("#", 1)[0]
    if not title or ":" in title:
        return None
    return title.replace("_", " ")


def first_wiki_title(cell) -> str | None:
    if cell is None:
        return None
    for a in cell.find_all("a", href=True):
        title = wiki_title_from_href(a.get("href"))
        if title:
            return title
    return None


def parse_date(cell) -> str | None:
    if cell is None:
        return None
    time_node = cell.find("time")
    if time_node and time_node.get("datetime"):
        raw = str(time_node.get("datetime"))[:10]
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            return raw
    bday = cell.find(class_="bday")
    if bday:
        raw = clean_text(bday)[:10]
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            return raw
    text = clean_text(cell)
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%Y-%m-%d", "%d %B %Y", "%d %b %Y"):
        try:
            return dt.datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    m = re.search(r"\b(19|20)\d{2}-\d{2}-\d{2}\b", text)
    return m.group(0) if m else None


def parse_clock(text: str | None) -> int | None:
    if not text:
        return None
    m = re.search(r"\b(\d{1,2}):(\d{2})\b", text)
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def result_enum(text: str) -> str | None:
    n = normalize_name(text)
    if n.startswith("win") or n == "w":
        return "win"
    if n.startswith("loss") or n == "l":
        return "loss"
    if n.startswith("draw") or n == "d":
        return "draw"
    if n in {"nc", "no contest", "no-contest"} or n.startswith("no contest"):
        return "no_contest"
    return None


def method_enum(text: str) -> str | None:
    n = normalize_name(text)
    if not n:
        return None
    if "decision" in n:
        if "split" in n:
            return "DEC_S"
        if "majority" in n:
            return "DEC_M"
        return "DEC_U"
    if "submission" in n or "technical submission" in n:
        return "SUB"
    if "disqualification" in n or n.startswith("dq"):
        return "DQ"
    if "no contest" in n:
        return "NC"
    if "draw" in n:
        return "DRAW"
    if any(k in n for k in ("ko", "tko", "knockout", "doctor stoppage", "corner stoppage")):
        return "KO_TKO"
    return "OTHER"


_PROMOTION_RULES = [
    (r"^ufc\b|ultimate fighting championship", "ufc", "Ultimate Fighting Championship"),
    (r"^pride\b|pride fighting championships", "pride", "PRIDE Fighting Championships"),
    (r"^wec\b|world extreme cagefighting", "wec", "World Extreme Cagefighting"),
    (r"^strikeforce\b", "strikeforce", "Strikeforce"),
    (r"^bellator\b", "bellator", "Bellator MMA"),
    (r"^pfl\b|professional fighters league", "pfl", "Professional Fighters League"),
    (r"^wsof\b|world series of fighting", "wsof", "World Series of Fighting"),
    (r"^one\b|one championship", "one", "ONE Championship"),
    (r"^rizin\b", "rizin", "Rizin Fighting Federation"),
    (r"^ksw\b|konfrontacja sztuk walki", "ksw", "KSW"),
    (r"^cage warriors\b|^cwfc\b", "cage-warriors", "Cage Warriors"),
    (r"^lfa\b|legacy fighting alliance", "lfa", "Legacy Fighting Alliance"),
    (r"^invicta\b", "invicta", "Invicta Fighting Championships"),
    (r"^brave\b", "brave", "BRAVE Combat Federation"),
    (r"^oktagon\b", "oktagon", "OKTAGON MMA"),
    (r"^dream\b", "dream", "DREAM"),
    (r"^shooto\b", "shooto", "Shooto"),
    (r"^pancrase\b", "pancrase", "Pancrase"),
    (r"^m-?1\b", "m1", "M-1 Global"),
]


def promotion_guess(event_name: str) -> tuple[str, str]:
    n = normalize_name(event_name)
    for pattern, slug, display in _PROMOTION_RULES:
        if re.search(pattern, n, flags=re.I):
            return slug, display
    first = re.split(r"\s*[:\-–—]\s*", event_name.strip(), maxsplit=1)[0].strip()
    slug = re.sub(r"[^a-z0-9]+", "-", normalize_name(first)).strip("-") or "unknown"
    return slug[:80], first[:160] or "Unknown"


def canonical_header(text: str) -> str:
    n = normalize_name(text).replace(" ", "_")
    aliases = {
        "res": "result", "result": "result", "record": "record",
        "opponent": "opponent", "method": "method", "event": "event",
        "date": "date", "round": "round", "time": "time",
        "location": "location", "notes": "notes",
    }
    return aliases.get(n, n)


@dataclass
class CareerRow:
    result: str
    record_text: str | None
    opponent: str
    opponent_wiki_title: str | None
    method: str | None
    method_raw: str | None
    event: str
    event_wiki_title: str | None
    event_date: str | None
    round: int | None
    time_sec: int | None
    location: str | None
    promotion_slug: str
    promotion_name: str
    row_index: int

    def as_dict(self) -> dict:
        return asdict(self)


def parse_infobox_dob(soup: BeautifulSoup) -> str | None:
    node = soup.select_one(".infobox .bday")
    if node:
        raw = clean_text(node)[:10]
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            return raw
    node = soup.select_one(".infobox time[datetime]")
    if node:
        raw = str(node.get("datetime"))[:10]
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            return raw
    return None


def _table_header_map(table) -> tuple[dict[str, int], object | None]:
    for tr in table.find_all("tr"):
        cells = tr.find_all(["th", "td"], recursive=False)
        if not cells:
            continue
        names = [canonical_header(clean_text(c)) for c in cells]
        index = {name: i for i, name in enumerate(names) if name}
        required = {"result", "opponent", "method", "event", "date", "round", "time"}
        if required.issubset(index):
            return index, tr
    return {}, None


def _mma_section_table(soup: BeautifulSoup):
    """Prefer the table immediately following the MMA-record heading.

    Fighters can have boxing/kickboxing/amateur tables with the same columns.
    Selecting the largest matching table can silently ingest the wrong sport.
    """
    for heading in soup.find_all(["h2", "h3", "h4"]):
        if "mixed martial arts record" not in normalize_name(clean_text(heading)):
            continue
        table = heading.find_next("table")
        if table is not None:
            header_map, header_row = _table_header_map(table)
            if header_map:
                return table, header_map, header_row
    return None


def parse_mma_record(html: str) -> dict:
    soup = BeautifulSoup(html or "", "lxml")
    dob = parse_infobox_dob(soup)

    selected = _mma_section_table(soup)
    candidates = []
    for table in soup.find_all("table"):
        header_map, header_row = _table_header_map(table)
        if header_map:
            candidates.append((table, header_map, header_row))
    if not candidates:
        return {"dob": dob, "rows": [], "table_count": 0}

    table, header_map, header_row = selected or max(candidates, key=lambda x: len(x[0].find_all("tr")))
    out: list[CareerRow] = []
    started = False
    row_index = 0
    for tr in table.find_all("tr"):
        if tr is header_row:
            started = True
            continue
        if not started:
            continue
        cells = tr.find_all("td", recursive=False)
        if not cells:
            continue
        row_index += 1

        def cell(key: str):
            i = header_map.get(key)
            return cells[i] if i is not None and i < len(cells) else None

        result = result_enum(clean_text(cell("result")))
        opponent = clean_text(cell("opponent"))
        event = clean_text(cell("event"))
        if not result or not opponent or not event:
            continue
        method_raw = clean_text(cell("method")) or None
        round_text = clean_text(cell("round"))
        round_no = int(round_text) if re.fullmatch(r"\d+", round_text) else None
        slug, promotion_name = promotion_guess(event)
        out.append(CareerRow(
            result=result,
            record_text=clean_text(cell("record")) or None,
            opponent=opponent,
            opponent_wiki_title=first_wiki_title(cell("opponent")),
            method=method_enum(method_raw or ""),
            method_raw=method_raw,
            event=event,
            event_wiki_title=first_wiki_title(cell("event")),
            event_date=parse_date(cell("date")),
            round=round_no,
            time_sec=parse_clock(clean_text(cell("time"))),
            location=clean_text(cell("location")) or None,
            promotion_slug=slug,
            promotion_name=promotion_name,
            row_index=row_index,
        ))
    return {"dob": dob, "rows": [r.as_dict() for r in out], "table_count": len(candidates)}
