"""
UFC Stats HTML parsers. NOT YET WRITTEN.

Per the kickoff brief: "Do not write parsers until you've confirmed" the live
page structure. As of 2026-09-05 no live page could be fetched (JS challenge
interstitial; see docs/scraper_notes.md) and the Internet Archive rate-limited
every attempt. The signatures below are the contract backfill_ufcstats.py and
the Worker's parsers.mjs will honour once the structure is verified.

Every function:
  * takes (html, source_url) and returns plain dicts/lists shaped for the
    ufc_* tables (no uuids; entities are keyed by ufcstats_id and the caller
    resolves ids),
  * raises common.SchemaAssertionError on ANY unexpected header, column
    count, or enum value. Never guesses. Never returns partial rows.
"""
from __future__ import annotations

from common import SchemaAssertionError  # noqa: F401

PENDING = "parsers pending live structure verification — see docs/scraper_notes.md"


def parse_event_list(html: str, source_url: str) -> list[dict]:
    """-> [{ufcstats_id, name, event_date (ISO), location_raw}] newest first."""
    raise NotImplementedError(PENDING)


def parse_fighter_list(html: str, source_url: str) -> list[dict]:
    """-> [{ufcstats_id, first, last, nickname, height_in, weight_lbs, reach_in, stance, record_w, record_l, record_d, belt}]"""
    raise NotImplementedError(PENDING)


def parse_event_page(html: str, source_url: str) -> dict:
    """-> {ufcstats_id, name, event_date, location_raw,
           bouts: [{ufcstats_id|None, fighter_a_ufcstats_id, fighter_b_ufcstats_id, fighter_a_name, fighter_b_name,
                    weight_class_raw, result_flag_a, bout_order, method_raw, round, time}]}"""
    raise NotImplementedError(PENDING)


def parse_fight_page(html: str, source_url: str) -> dict:
    """-> {ufcstats_id, event_ufcstats_id, fighters: [{ufcstats_id, name, flag}], weight_class_raw,
           method_raw, round, time_sec, time_format, referee, details_raw, scorecards, finish_detail,
           has_stats, rounds: [{fighter_ufcstats_id, round, kd, sig_str_landed, ...}]}"""
    raise NotImplementedError(PENDING)


def parse_fighter_page(html: str, source_url: str) -> dict:
    """-> {ufcstats_id, name, nickname, record_w, record_l, record_d, record_nc, height_in, weight_lbs,
           reach_in, stance, dob, career_slpm, ..., fight_history_count}"""
    raise NotImplementedError(PENDING)
