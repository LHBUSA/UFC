#!/usr/bin/env python
"""
Render a reviewed reconciliation plan (plan_duplicate_merges.py output) into
ONE guarded SQL transaction. It executes nothing.

  python scripts/reconcile/render_merge_sql.py --plan plan.json --out merge.sql [--operator NAME]

Only APPLY-ELIGIBLE pairs are rendered; a fighter merge is rendered only if
every pair sharing it is eligible. Order: audit rows, then every bout merge,
then every fighter merge (a fighter behind two bouts is merged once, after
both bouts). Each pair opens with a DO block asserting the database still
matches the plan (row counts, ids); any drift raises and the whole transaction
rolls back. Run it through scripts/db/apply_supabase_migration.ps1 -Mode proof
(BEGIN ... ROLLBACK) before -Mode apply.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "shared"))
from alias_resolver import normalize  # noqa: E402


def lit(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, (dict, list)):
        return "$j$" + json.dumps(v, ensure_ascii=False) + "$j$::jsonb"
    return "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--operator", default="reconcile/render_merge_sql.py")
    ap.add_argument("--preserve-bouts", help="JSON {bout_ids:[...], round_rows:N}: assert these bouts keep exactly N round rows")
    a = ap.parse_args()
    plan = json.load(open(a.plan, encoding="utf-8"))
    sha = plan["plan_sha256"]
    pairs = [p for p in plan["pairs"] if p.get("apply_eligible")]
    groups = {}
    for p in plan["pairs"]:
        if p.get("duplicate_fighter_id"):
            groups.setdefault(p["duplicate_fighter_id"], []).append(p)
    fighter_ok = {d: all(x.get("apply_eligible") for x in g) for d, g in groups.items()}
    skipped = [p for p in plan["pairs"] if not p.get("apply_eligible")]

    out = [f"-- Rendered from plan {sha}", f"-- Eligible bout merges: {len(pairs)}; skipped: {[p['espn_bout_id'] for p in skipped]}",
           "-- Executes nothing by itself. Proof first: BEGIN ... ROLLBACK.", "begin;", ""]
    # 1. audit. Before-images are captured BY THE DATABASE, inside this
    # transaction, before any row changes: exact at execution time, and the
    # SQL stays small. Evidence (checks, DOB disagreement, names) comes from
    # the reviewed plan.
    snap = lambda table, where: f"coalesce((select jsonb_agg(to_jsonb(t)) from public.{table} t where {where}), '[]'::jsonb)"
    for p in pairs:
        B, Bp = p["canonical_bout_id"], p["duplicate_bout_id"]
        ev = {"checks": p["checks"], "dob": p["dob"], "names": p["names"], "ufcstats_fight_id": p["ufcstats_fight_id"]}
        imgs = ("jsonb_build_object("
                f"'ufc_bouts', {snap('ufc_bouts', f'id in ({lit(B)}, {lit(Bp)})')}, "
                f"'ufc_bout_results', {snap('ufc_bout_results', f'bout_id in ({lit(B)}, {lit(Bp)})')}, "
                f"'ufc_bout_round_stats', {snap('ufc_bout_round_stats', f'bout_id = {lit(Bp)}')}, "
                f"'ufc_fighter_bout_features', {snap('ufc_fighter_bout_features', f'bout_id = {lit(Bp)}')})")
        out.append(f"insert into public.ufc_identity_reconciliations (plan_sha256, kind, canonical_id, duplicate_id, evidence, before_images, operator) "
                   f"select {lit(sha)}, 'bout_merge', {lit(B)}, {lit(Bp)}, {lit(ev)}, {imgs}, {lit(a.operator)};")
    for dup, g in groups.items():
        if not fighter_ok[dup]:
            continue
        last = g[-1]
        X, Xp = last["canonical_fighter_id"], dup
        ev = {"dob": last["dob"], "names": last["names"], "pairs": [x["espn_bout_id"] for x in g],
              "unique_bouts_repointed": last.get("duplicate_fighter_other_bouts", {}).get("unique_repoint", [])}
        imgs = ("jsonb_build_object("
                f"'ufc_fighters', {snap('ufc_fighters', f'id in ({lit(X)}, {lit(Xp)})')}, "
                f"'ufc_fighter_aliases', {snap('ufc_fighter_aliases', f'fighter_id in ({lit(X)}, {lit(Xp)})')}, "
                f"'ufc_bouts', {snap('ufc_bouts', f'fighter_a_id = {lit(Xp)} or fighter_b_id = {lit(Xp)}')}, "
                f"'ufc_bout_results_won', {snap('ufc_bout_results', f'winner_id = {lit(Xp)}')}, "
                f"'ufc_bout_round_stats', {snap('ufc_bout_round_stats', f'fighter_id = {lit(Xp)}')}, "
                f"'ufc_fighter_dna_snapshots', {snap('ufc_fighter_dna_snapshots', f'fighter_id = {lit(Xp)}')}, "
                f"'ufc_fighter_stance_splits', {snap('ufc_fighter_stance_splits', f'fighter_id = {lit(Xp)}')}, "
                f"'ufc_fighter_bout_features', {snap('ufc_fighter_bout_features', f'fighter_id = {lit(Xp)} or opponent_id = {lit(Xp)}')}, "
                f"'ufc_alias_review_queue', {snap('ufc_alias_review_queue', f'resolved_at is null and {lit(Xp)}::uuid = any(candidate_fighter_ids)')})")
        out.append(f"insert into public.ufc_identity_reconciliations (plan_sha256, kind, canonical_id, duplicate_id, evidence, before_images, operator) "
                   f"select {lit(sha)}, 'fighter_merge', {lit(X)}, {lit(Xp)}, {lit(ev)}, {imgs}, {lit(a.operator)};")
    out.append("")
    # 2. bout merges
    for p in pairs:
        B, Bp, X, Xp, Y, F = p["canonical_bout_id"], p["duplicate_bout_id"], p["canonical_fighter_id"], p["duplicate_fighter_id"], p["opponent_fighter_id"], p["ufcstats_fight_id"]
        nrows = len(p["audit_before_images"]["ufc_bout_round_stats"])
        out += [f"-- bout merge {Bp} -> {B} ({p['names']['canonical']} v {p['names']['opponent']}, UFC Stats {F})",
                "do $g$ begin",
                f"  if (select count(*) from public.ufc_bout_round_stats where bout_id = {lit(B)}) <> 0 then raise exception 'plan drift: canonical bout {B} has round rows'; end if;",
                f"  if (select count(*) from public.ufc_bout_round_stats where bout_id = {lit(Bp)}) <> {nrows} then raise exception 'plan drift: duplicate bout {Bp} round rows'; end if;",
                f"  if (select ufcstats_id from public.ufc_bouts where id = {lit(Bp)}) is distinct from {lit(F)} then raise exception 'plan drift: duplicate bout id'; end if;",
                f"  if (select ufcstats_id from public.ufc_bouts where id = {lit(B)}) is not null then raise exception 'plan drift: canonical bout already linked'; end if;",
                "end $g$;"]
        out.append(f"update public.ufc_bout_round_stats set bout_id = {lit(B)} where bout_id = {lit(Bp)} and fighter_id = {lit(Y)};")
        out.append(f"update public.ufc_bout_round_stats set bout_id = {lit(B)}, fighter_id = {lit(X)} where bout_id = {lit(Bp)} and fighter_id = {lit(Xp)};")
        enrich = next((o["set"] for o in p["operations"] if o["table"] == "ufc_bout_results" and o["op"] == "update" and o.get("phase") == "bout_merge"), None)
        if enrich:
            sets = ", ".join(f"{k} = {lit(v)}" for k, v in enrich.items())
            out.append(f"update public.ufc_bout_results set {sets} where bout_id = {lit(B)};")
            out.append(f"delete from public.ufc_bout_results where bout_id = {lit(Bp)};")
        out.append(f"delete from public.ufc_fighter_bout_features where bout_id = {lit(Bp)};")
        out.append(f"delete from public.ufc_bouts where id = {lit(Bp)};")
        out.append(f"update public.ufc_bouts set ufcstats_id = {lit(F)}, updated_at = now() where id = {lit(B)};")
        out += ["do $g$ begin",
                f"  if (select count(*) from public.ufc_bout_round_stats where bout_id = {lit(B)}) <> {nrows} then raise exception 'post: canonical bout {B} round rows'; end if;",
                f"  if exists (select 1 from public.ufc_bouts where id = {lit(Bp)}) then raise exception 'post: duplicate bout {Bp} still present'; end if;",
                f"  if exists (select 1 from public.ufc_bout_results where bout_id = {lit(Bp)}) then raise exception 'post: duplicate result still present'; end if;",
                f"  if (select ufcstats_id from public.ufc_bouts where id = {lit(B)}) is distinct from {lit(F)} then raise exception 'post: canonical bout not linked'; end if;",
                f"  if (select count(distinct fighter_id) from public.ufc_bout_round_stats where bout_id = {lit(B)}) <> 2 then raise exception 'post: canonical bout corners'; end if;",
                "end $g$;", ""]
    # 3. fighter merges
    for dup, g in groups.items():
        if not fighter_ok[dup]:
            continue
        last = g[-1]
        X, Xp = last["canonical_fighter_id"], dup
        dup_row = last["audit_before_images"]["ufc_fighters"][0]
        fill = next(o["set"] for o in last["operations"] if o["table"] == "ufc_fighters" and o["op"] == "update")
        out += [f"-- fighter merge {Xp} -> {X} ({last['names']['duplicate']} -> {last['names']['canonical']}; DOB kept {last['dob']['canonical']}, UFC Stats printed {last['dob']['duplicate']})",
                "do $g$ begin",
                f"  if (select ufcstats_id from public.ufc_fighters where id = {lit(Xp)}) is distinct from {lit(dup_row['ufcstats_id'])} then raise exception 'plan drift: duplicate fighter'; end if;",
                f"  if (select ufcstats_id from public.ufc_fighters where id = {lit(X)}) is not null then raise exception 'plan drift: canonical fighter already linked'; end if;",
                "end $g$;",
                f"update public.ufc_bouts set fighter_a_id = {lit(X)}, updated_at = now() where fighter_a_id = {lit(Xp)};",
                f"update public.ufc_bouts set fighter_b_id = {lit(X)}, updated_at = now() where fighter_b_id = {lit(Xp)};",
                f"update public.ufc_bout_round_stats set fighter_id = {lit(X)} where fighter_id = {lit(Xp)};",
                f"update public.ufc_bout_results set winner_id = {lit(X)} where winner_id = {lit(Xp)};",
                f"delete from public.ufc_fighter_bout_features where fighter_id = {lit(Xp)} or opponent_id = {lit(Xp)};",
                f"delete from public.ufc_fighter_dna_snapshots where fighter_id = {lit(Xp)};",
                f"delete from public.ufc_fighter_stance_splits where fighter_id = {lit(Xp)};",
                f"delete from public.ufc_fighter_aliases a where a.fighter_id = {lit(Xp)} and exists (select 1 from public.ufc_fighter_aliases b where b.fighter_id = {lit(X)} and b.source = a.source and b.normalized = a.normalized);",
                f"update public.ufc_fighter_aliases set fighter_id = {lit(X)} where fighter_id = {lit(Xp)};",
                f"update public.ufc_alias_review_queue set status = 'resolved', resolved_fighter_id = {lit(X)}, resolved_at = now() where resolved_at is null and {lit(Xp)}::uuid = any(candidate_fighter_ids);",
                # The image system is out of scope: a duplicate that carries any
                # image row aborts the transaction instead of being repointed.
                "do $g$ begin",
                f"  if exists (select 1 from public.ufc_images where fighter_id = {lit(Xp)}) or exists (select 1 from public.ufc_image_candidates where fighter_id = {lit(Xp)}) then raise exception 'image rows on duplicate {Xp}: out of scope for this pass'; end if;",
                "end $g$;",
                f"delete from public.ufc_fighters where id = {lit(Xp)};",
                f"update public.ufc_fighters set {', '.join(f'{k} = {lit(v)}' for k, v in fill.items())}, updated_at = now() where id = {lit(X)};",
                f"insert into public.ufc_fighter_aliases (fighter_id, alias, source, normalized) values ({lit(X)}, {lit(dup_row['name'])}, 'ufcstats', {lit(normalize(dup_row['name']))}) on conflict (fighter_id, source, normalized) do nothing;",
                "do $g$ begin",
                f"  if exists (select 1 from public.ufc_fighters where id = {lit(Xp)}) then raise exception 'post: duplicate fighter still present'; end if;",
                f"  if exists (select 1 from public.ufc_bouts where fighter_a_id = {lit(Xp)} or fighter_b_id = {lit(Xp)}) then raise exception 'post: bouts still reference duplicate'; end if;",
                f"  if exists (select 1 from public.ufc_bout_round_stats where fighter_id = {lit(Xp)}) then raise exception 'post: round rows still reference duplicate'; end if;",
                f"  if (select ufcstats_id from public.ufc_fighters where id = {lit(X)}) is distinct from {lit(dup_row['ufcstats_id'])} then raise exception 'post: canonical fighter not linked'; end if;",
                f"  if (select count(*) from public.ufc_bouts where fighter_a_id = {lit(X)} or fighter_b_id = {lit(X)}) <> {last['resulting_state']['fighter']['bouts_after']} then raise exception 'post: canonical fighter bout count'; end if;",
                "end $g$;",
                ""]
    n_audit = len(pairs) + sum(1 for d, ok in fighter_ok.items() if ok)
    out += ["do $g$ begin",
            f"  if (select count(*) from public.ufc_identity_reconciliations where plan_sha256 = {lit(sha)}) <> {n_audit} then raise exception 'post: audit rows'; end if;"]
    if a.preserve_bouts:
        keep = json.load(open(a.preserve_bouts, encoding="utf-8"))
        ids = ",".join(lit(b) for b in keep["bout_ids"])
        out.append(f"  if (select count(*) from public.ufc_bout_round_stats where bout_id in ({ids})) <> {keep['round_rows']} then raise exception 'post: previously repaired bouts changed'; end if;")
    out += ["end $g$;", "", "commit;"]
    open(a.out, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
    nb = len(pairs)
    nf = sum(1 for d, ok in fighter_ok.items() if ok)
    print(f"rendered {nb} bout merges and {nf} fighter merges from plan {sha[:12]} -> {a.out}; skipped pairs: {len(skipped)}")


if __name__ == "__main__":
    main()
