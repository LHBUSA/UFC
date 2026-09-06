"""
UFC Stats HTML parsers (Python). Verified 2026-09-05 against Internet Archive
captures (docs/scraper_notes.md, "selector verification"); the captures live
in scripts/backfill/fixtures/ and test_parsers.py pins every value below.

Every function takes (html, source_url), returns plain dicts keyed by
ufcstats_id (never uuids), and raises common.SchemaAssertionError on ANY
unexpected header, column count, flag or enum value. It never guesses and
never returns a partial row.

Site quirks that are asserted AS-IS (do not "fix" them):
  * completed list has two columns: "Name/date" (link + date span) and "Location"
  * per-round Totals table labels the Td column "Td %", so "Td %" appears twice
  * list tables start with an empty spacer row
"""
from __future__ import annotations

import re
from typing import Optional

from bs4 import BeautifulSoup

import normalizers as N
from common import SchemaAssertionError

HEX16 = re.compile(r"/(?:event|fight|fighter)-details/([0-9a-f]{16})")

H_EVENT_LIST = ["Name/date", "Location"]
H_FIGHTER_LIST = ["First", "Last", "Nickname", "Ht.", "Wt.", "Reach", "Stance", "W", "L", "D", "Belt"]
H_EVENT_PAGE = ["W/L", "Fighter", "Kd", "Str", "Td", "Sub", "Weight class", "Method", "Round", "Time"]
H_TOTALS = ["Fighter", "KD", "Sig. str.", "Sig. str. %", "Total str.", "Td", "Td %", "Sub. att", "Rev.", "Ctrl"]
H_TOTALS_RND = ["Fighter", "KD", "Sig. str.", "Sig. str. %", "Total str.", "Td %", "Td %", "Sub. att", "Rev.", "Ctrl"]  # site quirk
H_SIG = ["Fighter", "Sig. str", "Sig. str. %", "Head", "Body", "Leg", "Distance", "Clinch", "Ground"]
H_SIG_RND = H_SIG
RESULT_FLAG = {"win": "WIN", "loss": "LOSS", "draw": "DRAW", "nc": "NC", "": None}
PERSON_STATUS = {"W": "WIN", "L": "LOSS", "D": "DRAW", "NC": "NC"}


def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")


def _t(x) -> str:
    return re.sub(r"\s+", " ", x.get_text(" ", strip=True)) if x is not None else ""


def _id(href: Optional[str], url: str) -> str:
    m = HEX16.search(href or "")
    if not m:
        raise SchemaAssertionError(url, f"no 16-hex id in href {href!r}")
    return m.group(1)


def _assert_headers(table, expected: list[str], url: str, label: str, allow_round_heads: bool = False):
    heads = [_t(th) for th in table.select("thead th")]
    if allow_round_heads:
        heads = [h for h in heads if not re.fullmatch(r"Round \d+", h)]
    if heads != expected:
        raise SchemaAssertionError(url, f"{label} headers {heads} != {expected}")


def _ps(td) -> list[str]:
    ps = [_t(p) for p in td.select("p")]
    return ps if ps else [_t(td)]


# ---------------------------------------------------------------------------
# Lists
# ---------------------------------------------------------------------------
def parse_event_list(html: str, source_url: str) -> list[dict]:
    """-> [{ufcstats_id, name, event_date, location_raw}] in page order (newest first)."""
    s = _soup(html)
    table = s.select_one("table.b-statistics__table-events")
    if table is None:
        raise SchemaAssertionError(source_url, "events table missing")
    _assert_headers(table, H_EVENT_LIST, source_url, "event list")
    out = []
    for tr in table.select("tbody tr"):
        a = tr.select_one("a[href*='event-details']")
        if a is None:
            if _t(tr):
                raise SchemaAssertionError(source_url, f"event row without link: {_t(tr)[:80]!r}")
            continue  # spacer row
        tds = tr.select("td")
        if len(tds) != 2:
            raise SchemaAssertionError(source_url, f"event row has {len(tds)} cells")
        date_el = tds[0].select_one("span.b-statistics__date")
        if date_el is None:
            raise SchemaAssertionError(source_url, f"event row without date span: {_t(tds[0])!r}")
        out.append({
            "ufcstats_id": _id(a.get("href"), source_url),
            "name": _t(a),
            "event_date": N.event_date(_t(date_el), source_url),
            "location_raw": _t(tds[1]) or None,
        })
    if not out:
        raise SchemaAssertionError(source_url, "event list parsed zero events")
    return out


def parse_fighter_list(html: str, source_url: str) -> list[dict]:
    s = _soup(html)
    table = s.select_one("table.b-statistics__table")
    if table is None:
        raise SchemaAssertionError(source_url, "fighters table missing")
    _assert_headers(table, H_FIGHTER_LIST, source_url, "fighter list")
    out = []
    for tr in table.select("tbody tr"):
        a = tr.select_one("a[href*='fighter-details']")
        if a is None:
            if _t(tr):
                raise SchemaAssertionError(source_url, f"fighter row without link: {_t(tr)[:80]!r}")
            continue
        c = [_t(td) for td in tr.select("td")]
        if len(c) != 11:
            raise SchemaAssertionError(source_url, f"fighter row has {len(c)} cells")
        out.append({
            "ufcstats_id": _id(a.get("href"), source_url),
            "first": c[0], "last": c[1], "nickname": c[2] or None,
            "height_in": N.height_in(c[3], source_url), "weight_lbs": N.weight_lbs(c[4], source_url),
            "reach_in": N.reach_in(c[5], source_url), "stance": N.norm_stance(c[6], source_url),
            "record_w": N.int_or_none(c[7], source_url), "record_l": N.int_or_none(c[8], source_url), "record_d": N.int_or_none(c[9], source_url),
            "belt": bool(tr.select_one("td:nth-of-type(11) img")),
        })
    return out


# ---------------------------------------------------------------------------
# Event page
# ---------------------------------------------------------------------------
def _box_items(s, url: str) -> dict[str, str]:
    items = {}
    for li in s.select("ul.b-list__box-list li"):
        t = _t(li)
        if ":" in t:
            k, v = t.split(":", 1)
            items[k.strip()] = v.strip()
    return items


def parse_event_page(html: str, source_url: str) -> dict:
    s = _soup(html)
    title = _t(s.select_one("h2"))
    if not title:
        raise SchemaAssertionError(source_url, "event title (h2) missing")
    items = _box_items(s, source_url)
    if "Date" not in items:
        raise SchemaAssertionError(source_url, f"event Date item missing: {items}")
    table = s.select_one("table.b-fight-details__table_type_event-details")
    if table is None:
        raise SchemaAssertionError(source_url, "event bouts table missing")
    _assert_headers(table, H_EVENT_PAGE, source_url, "event page")
    rows = [tr for tr in table.select("tbody tr") if tr.select("td")]
    bouts = []
    n = len(rows)
    for i, tr in enumerate(rows):
        tds = tr.select("td")
        if len(tds) != 10:
            raise SchemaAssertionError(source_url, f"bout row has {len(tds)} cells")
        link = tr.get("data-link") or (tds[0].select_one("a") or {}).get("href")
        fighters = tds[1].select("a[href*='fighter-details']")
        if len(fighters) != 2:
            raise SchemaAssertionError(source_url, f"bout row has {len(fighters)} fighter links")
        flags = [f for f in _ps(tds[0]) if f]
        for f in flags:
            if f not in RESULT_FLAG:
                raise SchemaAssertionError(source_url, f"unknown W/L flag {f!r}")
        method = _ps(tds[7])
        bouts.append({
            "ufcstats_id": _id(link, source_url) if link else None,
            "fighter_a_ufcstats_id": _id(fighters[0].get("href"), source_url), "fighter_a_name": _t(fighters[0]),
            "fighter_b_ufcstats_id": _id(fighters[1].get("href"), source_url), "fighter_b_name": _t(fighters[1]),
            "result_flag_a": RESULT_FLAG[flags[0]] if flags else None,
            "weight_class_raw": _t(tds[6]),
            "method_raw": method[0] if method and method[0] else None,
            "method_detail": method[1] if len(method) > 1 and method[1] else None,
            "round": N.int_or_none(_t(tds[8]), source_url),
            "time": _t(tds[9]) or None,
            "bout_order": n - i,
        })
    if not bouts:
        raise SchemaAssertionError(source_url, "event page parsed zero bouts")
    return {"ufcstats_id": _id(source_url, source_url), "name": title, "event_date": N.event_date(items["Date"], source_url),
            "location_raw": items.get("Location") or None, "bouts": bouts}


# ---------------------------------------------------------------------------
# Fight page
# ---------------------------------------------------------------------------
def _round_rows(table, url: str, label: str):
    """Yield (round_number, [td...]) from a per-round table: <tbody> holds
    <thead>Round N</thead> blocks each followed by one <tr>."""
    body = table.select_one("tbody")
    if body is None:
        return
    rnd = None
    for child in body.find_all(recursive=False):
        if child.name == "thead":
            m = re.fullmatch(r"Round (\d+)", _t(child))
            if not m:
                raise SchemaAssertionError(url, f"{label}: unexpected inner head {_t(child)!r}")
            rnd = int(m.group(1))
        elif child.name == "tr":
            if rnd is None:
                raise SchemaAssertionError(url, f"{label}: row before any Round head")
            yield rnd, child.select("td")


def _pair(td, url: str) -> tuple[str, str]:
    ps = _ps(td)
    if len(ps) != 2:
        raise SchemaAssertionError(url, f"stat cell does not stack two fighters: {ps}")
    return ps[0], ps[1]


def parse_fight_page(html: str, source_url: str) -> dict:
    s = _soup(html)
    persons = []
    for p in s.select(".b-fight-details__person"):
        a = p.select_one("h3 a")
        status = _t(p.select_one(".b-fight-details__person-status"))
        if a is None or status not in PERSON_STATUS:
            raise SchemaAssertionError(source_url, f"person block malformed (status {status!r})")
        persons.append({"ufcstats_id": _id(a.get("href"), source_url), "name": _t(a), "flag": PERSON_STATUS[status],
                        "nickname": _t(p.select_one(".b-fight-details__person-title")).strip('"') or None})
    if len(persons) != 2:
        raise SchemaAssertionError(source_url, f"{len(persons)} person blocks")
    title = _t(s.select_one(".b-fight-details__fight-title"))
    if not title:
        raise SchemaAssertionError(source_url, "fight title missing")
    items: dict[str, str] = {}
    for it in s.select(".b-fight-details__text-item, .b-fight-details__text-item_first"):
        t = _t(it)
        if ":" in t:
            k, v = t.split(":", 1)
            items[k.strip()] = v.strip()
    for k in ("Method", "Round", "Time", "Time format", "Referee"):
        if k not in items:
            raise SchemaAssertionError(source_url, f"result item {k!r} missing: {list(items)}")
    details = ""
    for blk in s.select(".b-fight-details__text"):
        t = _t(blk)
        if t.startswith("Details:"):
            details = t[len("Details:"):].strip()
    flags = {p["flag"] for p in persons}
    if flags == {"DRAW"}:
        method = "DRAW"
    elif "NC" in flags:
        method = "NC"
    else:
        method = N.norm_method(items["Method"], source_url)
    scorecards = N.scorecards(details) if method.startswith("DEC") or method == "DRAW" else None
    wc = N.norm_weight_class(title, source_url)

    # The Significant Strikes totals table sits outside its <section>; take
    # every table on the page in document order (there are exactly 4 or 0).
    tables = s.select("table")
    rounds: list[dict] = []
    has_stats = False
    if tables:
        if len(tables) != 4:
            raise SchemaAssertionError(source_url, f"{len(tables)} stats tables (expected 4 or 0)")
        _assert_headers(tables[0], H_TOTALS, source_url, "totals")
        _assert_headers(tables[1], H_TOTALS_RND, source_url, "totals per round", allow_round_heads=True)
        _assert_headers(tables[2], H_SIG, source_url, "sig strikes")
        _assert_headers(tables[3], H_SIG_RND, source_url, "sig strikes per round", allow_round_heads=True)
        by_key: dict[tuple[str, int], dict] = {}
        for rnd, tds in _round_rows(tables[1], source_url, "totals per round"):
            if len(tds) != 10:
                raise SchemaAssertionError(source_url, f"totals round row has {len(tds)} cells")
            names = _pair(tds[0], source_url)
            if [n for n in names] != [p["name"] for p in persons]:
                raise SchemaAssertionError(source_url, f"fighter order {names} != persons {[p['name'] for p in persons]}")
            for side in (0, 1):
                pick = lambda i: _pair(tds[i], source_url)[side]  # noqa: E731
                sl, sa = N.x_of_y(pick(2), source_url)
                tl, ta = N.x_of_y(pick(4), source_url)
                dl, da = N.x_of_y(pick(5), source_url)
                by_key[(persons[side]["ufcstats_id"], rnd)] = {
                    "fighter_ufcstats_id": persons[side]["ufcstats_id"], "round": rnd,
                    "kd": N.int_or_none(pick(1), source_url), "sig_str_landed": sl, "sig_str_att": sa,
                    "total_str_landed": tl, "total_str_att": ta, "td_landed": dl, "td_att": da,
                    "sub_att": N.int_or_none(pick(7), source_url), "rev": N.int_or_none(pick(8), source_url),
                    "ctrl_sec": N.mmss_to_sec(pick(9), source_url),
                }
        for rnd, tds in _round_rows(tables[3], source_url, "sig per round"):
            if len(tds) != 9:
                raise SchemaAssertionError(source_url, f"sig round row has {len(tds)} cells")
            for side in (0, 1):
                key = (persons[side]["ufcstats_id"], rnd)
                if key not in by_key:
                    raise SchemaAssertionError(source_url, f"sig round {rnd} without totals row")
                pick = lambda i: _pair(tds[i], source_url)[side]  # noqa: E731
                for col, idx in (("head", 3), ("body", 4), ("leg", 5), ("distance", 6), ("clinch", 7), ("ground", 8)):
                    l, a = N.x_of_y(pick(idx), source_url)
                    by_key[key][f"{col}_landed"], by_key[key][f"{col}_att"] = l, a
        rounds = [by_key[k] for k in sorted(by_key, key=lambda k: (k[1], [p["ufcstats_id"] for p in persons].index(k[0])))]
        has_stats = len(rounds) > 0
    winner = next((p for p in persons if p["flag"] == "WIN"), None)
    return {
        "ufcstats_id": _id(source_url, source_url),
        "fighters": persons, "weight_class_raw": title, "is_title": wc["is_title"], "weight_class": wc["weight_class"], "is_womens": wc["is_womens"],
        "method": method, "method_raw": items["Method"], "round": N.int_or_none(items["Round"], source_url),
        "time_sec": N.mmss_to_sec(items["Time"], source_url), "time_format": items["Time format"] or None,
        "scheduled_rounds": N.scheduled_rounds(items["Time format"], source_url),
        "referee": items["Referee"] or None, "details_raw": details or None,
        "scorecards": scorecards, "finish_detail": None if scorecards else (details or None),
        "winner_ufcstats_id": winner["ufcstats_id"] if winner else None,
        "has_stats": has_stats, "rounds": rounds,
    }


# ---------------------------------------------------------------------------
# Fighter page — capture pending (docs/scraper_notes.md)
# ---------------------------------------------------------------------------
def parse_fighter_page(html: str, source_url: str) -> dict:
    raise NotImplementedError("fighter page parser pending an archived capture — see docs/scraper_notes.md")


def normalize_weight_class(raw: str, url: str) -> dict:
    return N.norm_weight_class(raw, url)
