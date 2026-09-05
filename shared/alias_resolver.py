"""
PropBetEdge UFC — fighter alias resolution (Python side).

Mirror of shared/alias_resolver.mjs. Both files MUST produce identical
normalize() and token_sort_ratio() results; shared/tests exercises the same
fixtures on both sides.

Match order for any external name (kickoff brief, "Alias resolution"):
  1. Exact ufcstats_id link if the source exposes it -> matched.
  2. Normalized name match AND a corroborating key (weight class, DOB, or
     record) agrees -> matched.
  3. Fuzzy (token-sort ratio >= 90) AND a second key (DOB or record) agrees
     -> matched.
  4. Otherwise -> review row for ufc_alias_review_queue.

Never auto-merge on name alone. UFC Stats carries several "Bruno Silva"s.

No third-party dependencies. The similarity measure is the Indel-normalised
ratio (2*LCS / (len(a)+len(b)) * 100), which is exactly what rapidfuzz.ratio
computes, so a later swap to rapidfuzz changes nothing.
"""
from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable, Optional

FUZZY_THRESHOLD = 90
REVIEW_FLOOR = 80  # candidates at/above this are listed in the review row

_DROP = re.compile(r"['’.`]")      # apostrophes and periods vanish: O'Malley -> omalley, St. Pierre -> st pierre
_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_WS = re.compile(r"\s+")


# ---------------------------------------------------------------------------
# String normalisation + similarity
# ---------------------------------------------------------------------------
def normalize(name: Optional[str]) -> str:
    """Strip accents, punctuation, case; collapse whitespace.
    'José "Scarface" Aldo Jr.' -> 'jose scarface aldo jr'
    "Sean O'Malley" -> 'sean omalley'   (apostrophes/periods dropped, not split)
    """
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", str(name))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = _DROP.sub("", s)
    s = _NON_ALNUM.sub(" ", s)
    return _WS.sub(" ", s).strip()


def token_sort(name: Optional[str]) -> str:
    return " ".join(sorted(normalize(name).split()))


def _lcs_len(a: str, b: str) -> int:
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    for ca in a:
        cur = [0]
        for j, cb in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if ca == cb else max(prev[j], cur[j - 1]))
        prev = cur
    return prev[-1]


def ratio(a: str, b: str) -> float:
    """Indel-normalised similarity on already-normalised strings, 0..100."""
    if not a and not b:
        return 100.0
    if not a or not b:
        return 0.0
    return 200.0 * _lcs_len(a, b) / (len(a) + len(b))


def token_sort_ratio(a: Optional[str], b: Optional[str]) -> float:
    return ratio(token_sort(a), token_sort(b))


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------
@dataclass
class FighterRef:
    id: str                       # ufc_fighters.id (uuid) or any stable key
    ufcstats_id: Optional[str]
    name: str
    nickname: Optional[str] = None
    dob: Optional[str] = None     # ISO date string
    record: Optional[str] = None  # "20-3-0" (w-l-d), NC excluded
    weight_classes: set = field(default_factory=set)
    aliases: set = field(default_factory=set)   # extra raw aliases from ufc_fighter_aliases


@dataclass
class Candidate:
    fighter_id: str
    score: float
    reasons: list


@dataclass
class ResolveResult:
    status: str                       # matched | review | unmatched
    fighter_id: Optional[str] = None
    method: Optional[str] = None      # ufcstats_id | exact_normalized | fuzzy_second_key
    score: Optional[float] = None
    candidates: list = field(default_factory=list)
    review_row: Optional[dict] = None


def _norm_record(rec: Optional[str]) -> Optional[str]:
    """'20-3-0 (1 NC)' -> '20-3-0'. Returns None if unparseable."""
    if not rec:
        return None
    m = re.search(r"(\d+)\s*-\s*(\d+)\s*-\s*(\d+)", str(rec))
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None


def _norm_dob(dob: Optional[str]) -> Optional[str]:
    if not dob:
        return None
    s = str(dob).strip()[:10]
    return s if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) else None


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------
class AliasResolver:
    def __init__(self, fighters: Iterable[FighterRef], threshold: float = FUZZY_THRESHOLD):
        self.threshold = threshold
        self.by_id: dict[str, FighterRef] = {}
        self.by_ufcstats: dict[str, str] = {}
        self.by_norm: dict[str, set] = defaultdict(set)      # normalized alias -> fighter ids
        self.token_index: dict[str, set] = defaultdict(set)  # token -> fighter ids (blocking)
        self._norms: dict[str, set] = defaultdict(set)       # fighter id -> normalized aliases
        for f in fighters:
            self.add(f)

    def add(self, f: FighterRef) -> None:
        self.by_id[f.id] = f
        if f.ufcstats_id:
            self.by_ufcstats[f.ufcstats_id] = f.id
        for raw in {f.name, *(f.aliases or set())}:
            n = normalize(raw)
            if not n:
                continue
            self.by_norm[n].add(f.id)
            self._norms[f.id].add(n)
            for tok in n.split():
                if len(tok) >= 2:
                    self.token_index[tok].add(f.id)

    # -- second keys --------------------------------------------------------
    def _second_key_agreement(self, f: FighterRef, weight_class, dob, record) -> tuple[list, list]:
        """Return (agreeing_keys, disagreeing_keys) among the keys the caller supplied."""
        agree, disagree = [], []
        if weight_class:
            if f.weight_classes:
                (agree if weight_class in f.weight_classes else disagree).append("weight_class")
        if dob:
            d = _norm_dob(dob)
            if d and f.dob:
                (agree if d == _norm_dob(f.dob) else disagree).append("dob")
        if record:
            r = _norm_record(record)
            if r and f.record:
                (agree if r == _norm_record(f.record) else disagree).append("record")
        return agree, disagree

    # -- public -------------------------------------------------------------
    def resolve(self, raw_name: str, source: str, *, ufcstats_id: Optional[str] = None,
                weight_class: Optional[str] = None, dob: Optional[str] = None,
                record: Optional[str] = None, context: Optional[dict] = None) -> ResolveResult:
        # 1. hard link
        if ufcstats_id and ufcstats_id in self.by_ufcstats:
            fid = self.by_ufcstats[ufcstats_id]
            return ResolveResult("matched", fid, "ufcstats_id", 100.0, [Candidate(fid, 100.0, ["ufcstats_id"])])

        n = normalize(raw_name)
        if not n:
            return ResolveResult("unmatched")

        # 2. exact normalized + corroborating key
        exact_ids = sorted(self.by_norm.get(n, ()))
        candidates: list[Candidate] = []
        for fid in exact_ids:
            agree, disagree = self._second_key_agreement(self.by_id[fid], weight_class, dob, record)
            candidates.append(Candidate(fid, 100.0, ["exact_normalized", *agree, *[f"!{d}" for d in disagree]]))
        agreeing = [c for c in candidates if any(r in ("weight_class", "dob", "record") for r in c.reasons)
                    and not any(r.startswith("!") for r in c.reasons)]
        if len(agreeing) == 1:
            c = agreeing[0]
            return ResolveResult("matched", c.fighter_id, "exact_normalized", 100.0, candidates)

        # 3. fuzzy + second key (dob or record only)
        fuzzy = self._fuzzy_candidates(n, exclude=set(exact_ids))
        for fid, score in fuzzy:
            agree, disagree = self._second_key_agreement(self.by_id[fid], None, dob, record)
            candidates.append(Candidate(fid, score, ["fuzzy", *agree, *[f"!{d}" for d in disagree]]))
        strong = [c for c in candidates if "fuzzy" in c.reasons and c.score >= self.threshold
                  and any(r in ("dob", "record") for r in c.reasons)
                  and not any(r.startswith("!") for r in c.reasons)]
        if len(strong) == 1 and not agreeing:
            c = strong[0]
            return ResolveResult("matched", c.fighter_id, "fuzzy_second_key", c.score, candidates)

        # 4. review / unmatched
        candidates.sort(key=lambda c: (-c.score, c.fighter_id))
        listed = [c for c in candidates if c.score >= REVIEW_FLOOR][:5]
        if not listed:
            return ResolveResult("unmatched", candidates=candidates)
        reason = "ambiguous" if len(listed) > 1 else "no_second_key"
        row = {
            "raw_name": raw_name,
            "source": source,
            "candidate_fighter_ids": [c.fighter_id for c in listed],
            "context": {
                "reason": reason,
                "normalized": n,
                "weight_class": weight_class,
                "dob": dob,
                "record": record,
                "candidates": [{"fighter_id": c.fighter_id, "score": round(c.score, 1), "reasons": c.reasons} for c in listed],
                **(context or {}),
            },
        }
        return ResolveResult("review", candidates=candidates, review_row=row)

    def _fuzzy_candidates(self, n: str, exclude: set) -> list[tuple[str, float]]:
        """Blocked fuzzy search: only fighters sharing at least one name token."""
        pool: set = set()
        for tok in n.split():
            pool |= self.token_index.get(tok, set())
        out = []
        for fid in pool:
            if fid in exclude:
                continue
            best = max(token_sort_ratio(n, alias) for alias in self._norms[fid])
            if best >= REVIEW_FLOOR:
                out.append((fid, best))
        out.sort(key=lambda t: (-t[1], t[0]))
        return out

    # -- internal duplicate detection (Phase 1 acceptance) ------------------
    def find_internal_duplicates(self) -> list[dict]:
        """Exact-normalized collisions and near-duplicates inside the index.
        Returns rows suitable for the verification report and, for the
        exact collisions with matching DOB, for ufc_alias_review_queue.
        """
        rows: list[dict] = []
        for n, ids in self.by_norm.items():
            if len(ids) > 1:
                fs = [self.by_id[i] for i in sorted(ids)]
                dobs = {_norm_dob(f.dob) for f in fs if f.dob}
                kind = "same_name_same_dob" if len(fs) > 1 and len(dobs) == 1 and dobs != {None} else "same_name"
                rows.append({"kind": kind, "score": 100.0, "normalized": n,
                             "fighter_ids": [f.id for f in fs],
                             "names": [f.name for f in fs], "dobs": [f.dob for f in fs], "records": [f.record for f in fs]})
        seen: set = set()
        for tok, ids in self.token_index.items():
            if len(ids) < 2 or len(ids) > 400:   # skip hyper-common tokens ("silva", "de") for the pairwise pass
                continue
            ids_sorted = sorted(ids)
            for i, a in enumerate(ids_sorted):
                for b in ids_sorted[i + 1:]:
                    key = (a, b)
                    if key in seen:
                        continue
                    seen.add(key)
                    na, nb = self._norms[a], self._norms[b]
                    if na & nb:
                        continue  # exact collision, handled above
                    best = max(token_sort_ratio(x, y) for x in na for y in nb)
                    if best >= self.threshold:
                        fa, fb = self.by_id[a], self.by_id[b]
                        rows.append({"kind": "near_duplicate", "score": round(best, 1),
                                     "normalized": f"{normalize(fa.name)} ~ {normalize(fb.name)}",
                                     "fighter_ids": [a, b], "names": [fa.name, fb.name],
                                     "dobs": [fa.dob, fb.dob], "records": [fa.record, fb.record]})
        rows.sort(key=lambda r: (-r["score"], r["normalized"]))
        return rows


def alias_rows_for_fighter(fighter_id: str, name: str, nickname: Optional[str]) -> list[dict]:
    """Rows for ufc_fighter_aliases seeded from UFC Stats name + nickname."""
    rows = []
    n = normalize(name)
    if n:
        rows.append({"fighter_id": fighter_id, "alias": name, "source": "ufcstats", "normalized": n})
    nn = normalize(nickname)
    if nn and nn != n:
        rows.append({"fighter_id": fighter_id, "alias": nickname, "source": "ufcstats_nickname", "normalized": nn})
    return rows
