#!/usr/bin/env python
"""
Deterministic reconciliation PLAN for duplicate fighter + duplicate bout pairs
created when ESPN and UFC Stats disagreed on a birth date (see
docs/scraper_notes.md, 2026-09-10). READ-ONLY: GET requests only. It writes
nothing to the database; it prints and saves the plan.

  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
    python scripts/reconcile/plan_duplicate_merges.py --bouts <espn_bout_uuid,...> \
        --out plan.json

For each ESPN bout B (the bout our schedule/result pipeline owns, with no
round rows) it derives, from data only:

  fighter X   = the corner of B with no UFC Stats id (ESPN-keyed row)
  fight id    = the UFC Stats fight whose page names X's opponent and X
                (supplied per bout in --map, from archived page evidence)
  bout B'     = the bout carrying that UFC Stats fight id (UFC Stats-keyed row)
  fighter X'  = the corner of B' that is not B's other corner

and then enumerates EVERY reference to X, X', B, B' across the schema (all FK
columns from the live PostgREST schema, uuid[] fighter arrays, and the jsonb
snapshot columns that are left untouched), checks every uniqueness collision
the merge would hit, compares the two result rows, and emits the exact ordered
operations plus the audit before-images an apply step would record.

Canonical choice (deterministic, stated): the ESPN-keyed rows survive (X, B).
ESPN is the primary source for identity, schedule and results; B already owns
espn_competition_id and the ESPN result, and X is referenced by ESPN bouts. The
UFC Stats-keyed duplicates (X', B') contribute their UFC Stats ids, round rows
and result enrichment, and are then removed with full before-images archived.
A pair is APPLY-ELIGIBLE only if every check passes; anything else is AMBIGUOUS.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from urllib.parse import quote

import requests

U = os.environ["SUPABASE_URL"].rstrip("/")
K = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": K, "Authorization": f"Bearer {K}"} if K.startswith("eyJ") else {"apikey": K}

# Relations that are views (derived; follow their base tables, never written).
VIEW_RE = re.compile(r"create\s+(?:or\s+replace\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(ufc_[a-z_]+)", re.I)
# Append-only by trigger: never UPDATE/DELETE, corrections are appended.
APPEND_ONLY = {"ufc_fight_state_ledger"}
# Derived by ufc-intelligence from bouts/results/round stats; rebuilt, not merged.
DERIVED = {"ufc_fighter_dna_snapshots", "ufc_fighter_bout_features", "ufc_fighter_stance_splits"}
ROUND_COLS = ["kd", "sig_str_landed", "sig_str_att", "total_str_landed", "total_str_att", "td_landed", "td_att", "sub_att", "rev", "ctrl_sec",
              "head_landed", "head_att", "body_landed", "body_att", "leg_landed", "leg_att", "distance_landed", "distance_att",
              "clinch_landed", "clinch_att", "ground_landed", "ground_att"]


def get(path: str) -> list:
    out, start = [], 0
    while True:
        r = requests.get(f"{U}/rest/v1/{path}", headers={**H, "Range": f"{start}-{start + 999}"}, timeout=120)
        r.raise_for_status()
        rows = r.json()
        out += rows
        if len(rows) < 1000:
            return out
        start += 1000


def schema_refs(repo_root: str) -> dict:
    spec = requests.get(f"{U}/rest/v1/", headers={**H, "Accept": "application/openapi+json"}, timeout=120).json()
    views = set()
    for d in ("supabase/migrations", "migrations"):
        p = os.path.join(repo_root, d)
        for f in sorted(os.listdir(p)) if os.path.isdir(p) else []:
            if f.endswith(".sql"):
                views |= {m.lower() for m in VIEW_RE.findall(open(os.path.join(p, f), encoding="utf-8").read())}
    refs = {"fighter_fk": [], "bout_fk": [], "fighter_arrays": [], "jsonb": [], "views": sorted(views)}
    for table, d in spec.get("definitions", {}).items():
        if not table.startswith("ufc_") or table in views:
            continue
        for col, p in d.get("properties", {}).items():
            desc = p.get("description") or ""
            fk = re.search(r"<fk table='(\w+)' column='(\w+)'/>", desc)
            if fk and fk.group(1) == "ufc_fighters":
                refs["fighter_fk"].append((table, col))
            elif fk and fk.group(1) == "ufc_bouts":
                refs["bout_fk"].append((table, col))
            elif (p.get("format") or "").startswith("uuid[]") and "fighter" in col:
                refs["fighter_arrays"].append((table, col))
            elif (p.get("format") or "") == "jsonb":
                refs["jsonb"].append((table, col))
    # ufc_bout_round_stats.fighter_id is not declared as an FK on every deployment; include explicitly.
    for extra in [("ufc_bout_round_stats", "fighter_id"), ("ufc_bout_round_stats", "bout_id")]:
        lst = refs["fighter_fk"] if extra[1] == "fighter_id" else refs["bout_fk"]
        if extra not in lst:
            lst.append(extra)
    return refs


def count_refs(refs: dict, fighter_id: str | None, bout_id: str | None) -> dict:
    found = {}
    if fighter_id:
        for t, c in refs["fighter_fk"]:
            if t == "ufc_fighters":
                continue
            rows = get(f"{t}?select=*&{c}=eq.{fighter_id}")
            if rows:
                found[f"{t}.{c}"] = rows
        for t, c in refs["fighter_arrays"]:
            rows = get(f"{t}?select=*&{c}=cs.{{{fighter_id}}}")
            if rows:
                found[f"{t}.{c}[]"] = rows
    if bout_id:
        for t, c in refs["bout_fk"]:
            if t == "ufc_bouts" and c == "id":
                continue
            rows = get(f"{t}?select=*&{c}=eq.{bout_id}")
            if rows:
                found[f"{t}.{c}"] = rows
    return found


def plan_pair(refs: dict, espn_bout_id: str, fight_id: str, known_dup_bouts: set) -> dict:
    p = {"espn_bout_id": espn_bout_id, "ufcstats_fight_id": fight_id, "checks": [], "operations": [], "audit_before_images": {}, "leave_untouched": []}
    ok = lambda name, cond, detail="": p["checks"].append({"check": name, "pass": bool(cond), "detail": detail})

    B = get(f"ufc_bouts?select=*&id=eq.{espn_bout_id}")
    ok("B exists", len(B) == 1)
    if len(B) != 1:
        return p
    B = B[0]
    Bp = get(f"ufc_bouts?select=*&ufcstats_id=eq.{fight_id}")
    ok("exactly one bout carries the UFC Stats fight id", len(Bp) == 1, f"{len(Bp)} rows")
    if len(Bp) != 1:
        return p
    Bp = Bp[0]
    ok("B' is a different row on the same event", Bp["id"] != B["id"] and Bp["event_id"] == B["event_id"], f"B'.event={Bp['event_id']}")
    fighters = {f["id"]: f for f in get(f"ufc_fighters?select=*&id=in.({','.join({B['fighter_a_id'], B['fighter_b_id'], Bp['fighter_a_id'], Bp['fighter_b_id']})})")}
    b_corners, bp_corners = {B["fighter_a_id"], B["fighter_b_id"]}, {Bp["fighter_a_id"], Bp["fighter_b_id"]}
    shared = b_corners & bp_corners
    ok("B and B' share exactly one corner (the opponent)", len(shared) == 1, f"shared={sorted(shared)}")
    if len(shared) != 1:
        return p
    Y = shared.pop()
    X = (b_corners - {Y}).pop()
    Xp = (bp_corners - {Y}).pop()
    fx, fxp, fy = fighters[X], fighters[Xp], fighters[Y]
    p.update({"canonical_fighter_id": X, "duplicate_fighter_id": Xp, "opponent_fighter_id": Y,
              "canonical_bout_id": B["id"], "duplicate_bout_id": Bp["id"],
              "names": {"canonical": fx["name"], "duplicate": fxp["name"], "opponent": fy["name"]}})
    ok("canonical fighter is the ESPN-keyed row without a UFC Stats id", fx.get("espn_athlete_id") and not fx.get("ufcstats_id"),
       f"espn={fx.get('espn_athlete_id')} ufcstats={fx.get('ufcstats_id')}")
    ok("duplicate fighter is the UFC Stats-keyed row without an ESPN id", fxp.get("ufcstats_id") and not fxp.get("espn_athlete_id"),
       f"espn={fxp.get('espn_athlete_id')} ufcstats={fxp.get('ufcstats_id')}")
    p["dob"] = {"canonical": fx.get("dob"), "duplicate": fxp.get("dob"), "conflict": bool(fx.get("dob") and fxp.get("dob") and fx["dob"] != fxp["dob"])}
    ok("canonical bout owns the ESPN competition id; duplicate bout does not", B.get("espn_competition_id") and not Bp.get("espn_competition_id"),
       f"B={B.get('espn_competition_id')} B'={Bp.get('espn_competition_id')}")

    # round rows
    rs_b = get(f"ufc_bout_round_stats?select=*&bout_id=eq.{B['id']}")
    rs_bp = get(f"ufc_bout_round_stats?select=*&bout_id=eq.{Bp['id']}")
    ok("B has no round rows", len(rs_b) == 0, f"{len(rs_b)}")
    rounds = {}
    for r in rs_bp:
        rounds.setdefault(r["round"], set()).add(r["fighter_id"])
    ok("B' has round rows for both corners in every round, rounds 1..N",
       rs_bp and sorted(rounds) == list(range(1, len(rounds) + 1)) and all(v == {Xp, Y} for v in rounds.values()),
       f"{len(rs_bp)} rows, rounds {sorted(rounds)}")

    # results
    res_b = (get(f"ufc_bout_results?select=*&bout_id=eq.{B['id']}") or [None])[0]
    res_bp = (get(f"ufc_bout_results?select=*&bout_id=eq.{Bp['id']}") or [None])[0]
    mapw = lambda w: X if w == Xp else w
    if res_b and res_bp:
        agree = {k: (res_b.get(k), mapw(res_bp.get(k)) if k == "winner_id" else res_bp.get(k)) for k in ("winner_id", "method", "round", "time_sec")}
        ok("ESPN and UFC Stats results agree (winner, method, round, time)", all(a == b for a, b in agree.values()), json.dumps(agree))
    else:
        ok("both bouts have a result row", False, f"B={bool(res_b)} B'={bool(res_bp)}")

    # every other reference
    ref_xp = count_refs(refs, Xp, None)
    ref_bp = count_refs(refs, None, Bp["id"])
    ref_x = count_refs(refs, X, None)
    p["references"] = {
        "duplicate_fighter": {k: len(v) for k, v in ref_xp.items()},
        "duplicate_bout": {k: len(v) for k, v in ref_bp.items()},
        "canonical_fighter": {k: len(v) for k, v in ref_x.items()},
    }
    # The duplicate fighter usually carries that fighter's whole UFC Stats
    # career, not just B'. Each other bout is either a TWIN of a canonical bout
    # (same event, same opponent: a duplicate bout that must be merged too) or
    # UNIQUE to the UFC Stats row (it only needs its fighter reference moved,
    # and cannot collide, because the canonical fighter has no bout there).
    cbouts = ref_x.get("ufc_bouts.fighter_a_id", []) + ref_x.get("ufc_bouts.fighter_b_id", [])
    other_bouts_xp = [r for r in ref_xp.get("ufc_bouts.fighter_a_id", []) + ref_xp.get("ufc_bouts.fighter_b_id", []) if r["id"] != Bp["id"]]
    unique_bouts, twins_unplanned = [], []
    for ob in other_bouts_xp:
        opp = ob["fighter_b_id"] if ob["fighter_a_id"] == Xp else ob["fighter_a_id"]
        twin = [c for c in cbouts if c["event_id"] == ob["event_id"] and opp in (c["fighter_a_id"], c["fighter_b_id"])]
        if twin and ob["id"] not in known_dup_bouts:
            twins_unplanned.append({"bout": ob["id"], "twin": twin[0]["id"]})
        elif not twin:
            unique_bouts.append(ob)
    ok("every other bout of the duplicate fighter is either merged in this plan or unique to it (no unplanned twin)", not twins_unplanned, json.dumps(twins_unplanned))
    p["duplicate_fighter_other_bouts"] = {"unique_repoint": [b["id"] for b in unique_bouts],
                                          "twins_in_plan": [b["id"] for b in other_bouts_xp if b["id"] in known_dup_bouts]}
    for key in ref_bp:
        t = key.split(".")[0]
        if t in APPEND_ONLY:
            p["leave_untouched"].append({"ref": key, "rows": len(ref_bp[key]), "why": "append-only ledger; historical snapshot, never rewritten"})
    unknown_bp = [k for k in ref_bp if k.split(".")[0] not in {"ufc_bout_round_stats", "ufc_bout_results", "ufc_fighter_bout_features", *APPEND_ONLY}]
    ok("duplicate bout has no references outside round stats, result, derived features and the ledger", not unknown_bp, f"{unknown_bp}")
    unknown_xp = [k for k in ref_xp if k.split(".")[0] not in {"ufc_bouts", "ufc_bout_round_stats", "ufc_bout_results", "ufc_fighter_aliases",
                                                                  "ufc_alias_review_queue", "ufc_images", "ufc_image_candidates", *DERIVED, *APPEND_ONLY}]
    ok("duplicate fighter has no references outside the handled set", not unknown_xp, f"{unknown_xp}")

    # uniqueness collisions
    al_x = {(a["source"], a["normalized"]) for a in ref_x.get("ufc_fighter_aliases.fighter_id", [])}
    al_xp = ref_xp.get("ufc_fighter_aliases.fighter_id", [])
    alias_move = [a for a in al_xp if (a["source"], a["normalized"]) not in al_x]
    alias_drop = [a for a in al_xp if (a["source"], a["normalized"]) in al_x]
    img_x, img_xp = ref_x.get("ufc_images.fighter_id", []), ref_xp.get("ufc_images.fighter_id", [])
    ok("portrait collision check (both rows having a stored image is a human decision)", not (img_x and img_xp), f"canonical={len(img_x)} duplicate={len(img_xp)}")
    other_with_ufcstats = get(f"ufc_fighters?select=id&ufcstats_id=eq.{fxp['ufcstats_id']}")
    ok("UFC Stats fighter id is held only by the duplicate row", [r["id"] for r in other_with_ufcstats] == [Xp])

    # ordered operations (an apply step runs them in ONE transaction, bout
    # phase for every pair first, then each fighter merge once)
    opp_rows = [r for r in rs_bp if r["fighter_id"] == Y]
    dup_rows = [r for r in rs_bp if r["fighter_id"] == Xp]
    unique_ids = [b["id"] for b in unique_bouts]
    unique_round_rows = sum(len(get(f"ufc_bout_round_stats?select=bout_id&bout_id=eq.{bid}&fighter_id=eq.{Xp}")) for bid in unique_ids)
    unique_wins = len([r for r in ref_xp.get("ufc_bout_results.winner_id", []) if r["bout_id"] in unique_ids])
    p["audit_before_images"] = {
        "ufc_fighters": [fxp], "ufc_bouts": [Bp], "ufc_bout_results": [res_bp] if res_bp else [],
        "ufc_bout_round_stats": rs_bp, "ufc_fighter_aliases_dropped": alias_drop, "unique_bouts_repointed": unique_bouts,
        # Derived rows are archived in full, not just counted: past as-of DNA
        # snapshots are not regenerated by the daily build.
        "derived_rows_deleted": {k: v for k, v in {**ref_xp, **ref_bp}.items() if k.split(".")[0] in DERIVED},
        "canonical_before": {"ufc_fighters": fx, "ufc_bouts": B, "ufc_bout_results": res_b},
    }
    bout_ops = []
    bout_ops.append({"op": "update", "table": "ufc_bout_round_stats", "where": f"bout_id={Bp['id']} fighter_id={Y}", "set": {"bout_id": B["id"]}, "rows": len(opp_rows)})
    bout_ops.append({"op": "update", "table": "ufc_bout_round_stats", "where": f"bout_id={Bp['id']} fighter_id={Xp}", "set": {"bout_id": B["id"], "fighter_id": X}, "rows": len(dup_rows)})
    if res_bp:
        enrich = {k: res_bp.get(k) for k in ("has_stats", "scorecards", "judge_1", "judge_2", "judge_3", "stats_source_url", "stats_captured_at") if res_bp.get(k) is not None}
        for k in ("referee", "finish_detail", "time_format"):
            if not (res_b or {}).get(k) and res_bp.get(k):
                enrich[k] = res_bp[k]
        bout_ops.append({"op": "update", "table": "ufc_bout_results", "where": f"bout_id={B['id']}", "set": enrich, "note": "ESPN result stays primary; UFC Stats enrichment copied"})
        bout_ops.append({"op": "delete", "table": "ufc_bout_results", "where": f"bout_id={Bp['id']}", "rows": 1, "archived": True})
    for key, rows in ref_bp.items():
        if key.split(".")[0] in DERIVED:
            bout_ops.append({"op": "delete", "table": key.split(".")[0], "where": key, "rows": len(rows), "note": "derived; regenerated by the next Fight DNA build"})
    bout_ops.append({"op": "delete", "table": "ufc_bouts", "where": f"id={Bp['id']}", "rows": 1, "archived": True, "note": "after its rows moved; frees the unique ufcstats_id"})
    bout_ops.append({"op": "update", "table": "ufc_bouts", "where": f"id={B['id']}", "set": {"ufcstats_id": fight_id}})

    fighter_ops = []
    if unique_ids:
        fighter_ops.append({"op": "update", "table": "ufc_bouts", "where": f"fighter_a_id|fighter_b_id={Xp} in {len(unique_ids)} unique bouts", "set": {"fighter": X}, "rows": len(unique_ids)})
        fighter_ops.append({"op": "update", "table": "ufc_bout_round_stats", "where": f"fighter_id={Xp} in those bouts", "set": {"fighter_id": X}, "rows": unique_round_rows,
                            "note": "PK (bout_id, fighter_id, round) cannot collide: the canonical fighter has no rows in these bouts"})
        if unique_wins:
            fighter_ops.append({"op": "update", "table": "ufc_bout_results", "where": f"winner_id={Xp}", "set": {"winner_id": X}, "rows": unique_wins})
    for key, rows in ref_xp.items():
        if key.split(".")[0] in DERIVED:
            fighter_ops.append({"op": "delete", "table": key.split(".")[0], "where": key, "rows": len(rows), "note": "derived; regenerated by the next Fight DNA build"})
    for a in alias_drop:
        fighter_ops.append({"op": "delete", "table": "ufc_fighter_aliases", "where": f"id={a['id']}", "note": "same (source, normalized) already on canonical", "archived": True})
    if alias_move:
        fighter_ops.append({"op": "update", "table": "ufc_fighter_aliases", "where": f"fighter_id={Xp}", "set": {"fighter_id": X}, "rows": len(alias_move)})
    for key in ("ufc_alias_review_queue.resolved_fighter_id", "ufc_alias_review_queue.candidate_fighter_ids[]"):
        if key in ref_xp:
            fighter_ops.append({"op": "update", "table": "ufc_alias_review_queue", "where": key, "rows": len(ref_xp[key]),
                                "set": {"status": "resolved", "resolved_fighter_id": X, "resolved_at": "now()"}, "note": "resolved by this reconciliation"})
    for key in ("ufc_images.fighter_id", "ufc_image_candidates.fighter_id"):
        if key in ref_xp:
            fighter_ops.append({"op": "update", "table": key.split(".")[0], "where": key, "rows": len(ref_xp[key]), "set": {"fighter_id": X}})
    fighter_ops.append({"op": "delete", "table": "ufc_fighters", "where": f"id={Xp}", "rows": 1, "archived": True, "note": "after every reference moved; frees the unique ufcstats_id"})
    fill = {"ufcstats_id": fxp["ufcstats_id"]}
    for c in ("nickname", "height_in", "reach_in", "career_slpm", "career_str_acc", "career_sapm", "career_str_def",
              "career_td_avg", "career_td_acc", "career_td_def", "career_sub_avg", "fight_history_count"):
        if fx.get(c) is None and fxp.get(c) is not None:
            fill[c] = fxp[c]
    fighter_ops.append({"op": "update", "table": "ufc_fighters", "where": f"id={X}", "set": fill,
                        "note": f"DOB kept as canonical {fx.get('dob')}; UFC Stats printed {fxp.get('dob')} (recorded in audit)"})
    fighter_ops.append({"op": "insert", "table": "ufc_fighter_aliases", "what": f"alias '{fxp['name']}' source=ufcstats for {X} if not already present"})

    for o in bout_ops:
        o["phase"] = "bout_merge"
    for o in fighter_ops:
        o["phase"] = "fighter_merge"
    p["operations"] = [{"op": "insert", "table": "ufc_identity_reconciliations", "phase": "audit", "what": "audit record: plan hash, before-images, evidence, operator"}] + bout_ops + fighter_ops
    p["resulting_state"] = {
        "fighter": {"id": X, "name": fx["name"], "espn_athlete_id": fx.get("espn_athlete_id"), "ufcstats_id": fxp["ufcstats_id"], "dob": fx.get("dob"),
                    "bouts_after": len(cbouts) + len(unique_bouts)},
        "bout": {"id": B["id"], "espn_competition_id": B.get("espn_competition_id"), "ufcstats_id": fight_id, "round_rows": len(rs_bp),
                 "rounds": sorted(rounds), "corners": sorted({X, Y})},
        "removed": {"fighter": Xp, "bout": Bp["id"]},
    }
    p["apply_eligible"] = all(c["pass"] for c in p["checks"])
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", required=True, help="JSON file: [{espn_bout_id, ufcstats_fight_id}]")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    refs = schema_refs(repo)
    pairs = json.load(open(a.map, encoding="utf-8"))
    known_dup_bouts = set()
    for x in pairs:
        known_dup_bouts |= {r["id"] for r in get(f"ufc_bouts?select=id&ufcstats_id=eq.{x['ufcstats_fight_id']}")}
    plans = [plan_pair(refs, x["espn_bout_id"], x["ufcstats_fight_id"], known_dup_bouts) for x in pairs]
    # Cross-pair consistency: one duplicate fighter can back several bouts (the
    # same person fought twice on these cards). The fighter merge then happens
    # once, after the LAST of its bouts is merged.
    by_dup = {}
    for p in plans:
        if p.get("duplicate_fighter_id"):
            by_dup.setdefault(p["duplicate_fighter_id"], []).append(p["espn_bout_id"])
    # A fighter that backs several pairs is merged once, in the last of them.
    for dup, bouts in by_dup.items():
        for p in plans:
            if p.get("duplicate_fighter_id") == dup and p["espn_bout_id"] != bouts[-1]:
                p["operations"] = [o for o in p["operations"] if o.get("phase") != "fighter_merge"] + [
                    {"op": "note", "phase": "fighter_merge", "table": "ufc_fighters", "what": f"fighter merge {dup} -> {p['canonical_fighter_id']} runs in pair {bouts[-1]}"}]
    # A pair is only as eligible as every pair sharing its fighter merge.
    for dup, bouts in by_dup.items():
        group = [p for p in plans if p.get("duplicate_fighter_id") == dup]
        if not all(p.get("apply_eligible") for p in group):
            for p in group:
                if p.get("apply_eligible"):
                    p["apply_eligible"] = False
                    p["checks"].append({"check": "every pair sharing this fighter merge is eligible", "pass": False, "detail": "a sibling pair failed"})
    body = {"generated_by": "scripts/reconcile/plan_duplicate_merges.py", "mode": "DRY RUN (GET only)", "schema_refs": {k: v for k, v in refs.items() if k != "jsonb"},
            "jsonb_snapshot_columns_left_untouched": refs["jsonb"], "fighter_merges": by_dup, "pairs": plans}
    blob = json.dumps(body, sort_keys=True, default=str)
    body["plan_sha256"] = hashlib.sha256(blob.encode()).hexdigest()
    json.dump(body, open(a.out, "w", encoding="utf-8"), indent=1, default=str)
    print(f"pairs {len(plans)}; apply-eligible {sum(1 for p in plans if p.get('apply_eligible'))}; fighter merges {len(by_dup)}; plan {body['plan_sha256'][:12]}")
    for p in plans:
        bad = [c for c in p["checks"] if not c["pass"]]
        print(f"  {p['espn_bout_id'][:8]} {p.get('names', {}).get('canonical', '?'):24} <- {p.get('names', {}).get('duplicate', '?'):24} eligible={p.get('apply_eligible')}"
              + (f"  FAILED: {[c['check'] + ' (' + str(c['detail']) + ')' for c in bad]}" if bad else ""))
    sys.exit(0)


if __name__ == "__main__":
    main()
