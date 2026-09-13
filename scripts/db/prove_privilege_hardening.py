"""Prove, apply or verify 20260913000005_ufc_privilege_hardening on production.

  --mode proof   migration body + assertions inside BEGIN ... ROLLBACK
  --mode apply   execute the migration file exactly as committed (its own
                 BEGIN/COMMIT), then run --mode verify
  --mode verify  assertions against the live state, plus a throwaway table
                 created by the migration role inside BEGIN ... ROLLBACK

What is asserted:
  * every public.ufc_* table: anon and authenticated hold no INSERT, UPDATE,
    DELETE or TRUNCATE
  * everything else in every table's ACL (SELECT, REFERENCES, TRIGGER,
    MAINTAIN, and every service_role privilege) is byte-identical to the
    snapshot taken first
  * RLS flags and policy counts are identical
  * service_role can still insert/update/select through PostgREST's role
  * anon can still SELECT (RLS returns zero rows) and is refused an INSERT by
    privilege, not merely by RLS
  * the schema default ACL of the role that owns and creates ufc_* tables no
    longer carries anon/authenticated writes, and a table created now by that
    same role is born without them

    python scripts/db/prove_privilege_hardening.py --mode proof --out D:/Workers/_research/ufc-legacy-origins-2026-09-12/privilege
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "legacy"))
from prove_first_repair import cli_token, run_sql  # noqa: E402

MIGRATION = ROOT / "supabase/migrations/20260913000005_ufc_privilege_hardening.sql"

SNAPSHOT = r"""
create temp table priv_before on commit drop as
select c.relname,
       c.relrowsecurity as rls,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
       coalesce((select jsonb_agg(x order by x) from (
          select (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) || ':' || a.privilege_type as x
          from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
          where not (pg_get_userbyid(a.grantee) in ('anon','authenticated') and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE'))) s), '[]') as kept_acl
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p') and c.relname like 'ufc\_%';
"""

AFTER = r"""
create temp table priv_after on commit drop as
select c.relname,
       c.relrowsecurity as rls,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
       coalesce((select jsonb_agg(x order by x) from (
          select (case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) || ':' || a.privilege_type as x
          from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
          where not (pg_get_userbyid(a.grantee) in ('anon','authenticated') and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE'))) s), '[]') as kept_acl,
       (select count(*) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         where pg_get_userbyid(a.grantee) = 'anon' and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')) as anon_writes,
       (select count(*) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
         where pg_get_userbyid(a.grantee) = 'authenticated' and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')) as auth_writes
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p') and c.relname like 'ufc\_%';
"""

ASSERTIONS = r"""
insert into proof (name, ok, detail) select 'ufc_* tables audited', true, (select count(*) from priv_after)::text;
insert into proof (name, ok, detail) select 'anon INSERT/UPDATE/DELETE/TRUNCATE on every ufc_* table = 0', (select sum(anon_writes) = 0 from priv_after), (select sum(anon_writes) from priv_after)::text;
insert into proof (name, ok, detail) select 'authenticated INSERT/UPDATE/DELETE/TRUNCATE on every ufc_* table = 0', (select sum(auth_writes) = 0 from priv_after), (select sum(auth_writes) from priv_after)::text;
insert into proof (name, ok, detail) select 'every other ACL entry (SELECT, REFERENCES, TRIGGER, MAINTAIN, all service_role) unchanged',
  (select count(*) = 0 from priv_before b full join priv_after a using (relname) where b.kept_acl is distinct from a.kept_acl),
  (select string_agg(coalesce(b.relname, a.relname), ',') from priv_before b full join priv_after a using (relname) where b.kept_acl is distinct from a.kept_acl);
insert into proof (name, ok, detail) select 'RLS flags and policy counts unchanged',
  (select count(*) = 0 from priv_before b full join priv_after a using (relname) where b.rls is distinct from a.rls or b.policies is distinct from a.policies), null;
insert into proof (name, ok, detail) select 'table set unchanged', (select count(*) from priv_before) = (select count(*) from priv_after), null;
insert into proof (name, ok, detail) select 'default ACL (postgres, public, tables) has no anon/authenticated writes',
  not exists (select 1 from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a
              where pg_get_userbyid(d.defaclrole) = 'postgres' and n.nspname = 'public' and d.defaclobjtype = 'r'
                and pg_get_userbyid(a.grantee) in ('anon','authenticated') and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')),
  (select string_agg(pg_get_userbyid(a.grantee) || ':' || a.privilege_type, ',' order by 1) from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a
    where pg_get_userbyid(d.defaclrole) = 'postgres' and n.nspname = 'public' and d.defaclobjtype = 'r');
insert into proof (name, ok, detail) select 'migration role is the ufc_* table owner (default ACL targets the creating role)',
  (select bool_and(pg_get_userbyid(c.relowner) = current_user) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'ufc\_%'),
  current_user::text;

-- A table born now, by the same role that creates production migrations.
create table public.ufc_zz_default_privilege_probe (id int);
insert into proof (name, ok, detail) select 'throwaway table owner = migration role', (select pg_get_userbyid(relowner) = current_user from pg_class where oid = 'public.ufc_zz_default_privilege_probe'::regclass), current_user::text;
insert into proof (name, ok, detail) select 'throwaway table: anon/authenticated inherit NO write grant',
  not has_table_privilege('anon', 'public.ufc_zz_default_privilege_probe', 'insert') and not has_table_privilege('anon', 'public.ufc_zz_default_privilege_probe', 'update')
  and not has_table_privilege('anon', 'public.ufc_zz_default_privilege_probe', 'delete') and not has_table_privilege('anon', 'public.ufc_zz_default_privilege_probe', 'truncate')
  and not has_table_privilege('authenticated', 'public.ufc_zz_default_privilege_probe', 'insert') and not has_table_privilege('authenticated', 'public.ufc_zz_default_privilege_probe', 'update')
  and not has_table_privilege('authenticated', 'public.ufc_zz_default_privilege_probe', 'delete') and not has_table_privilege('authenticated', 'public.ufc_zz_default_privilege_probe', 'truncate'),
  (select string_agg(pg_get_userbyid(a.grantee) || ':' || a.privilege_type, ',' order by 1) from pg_class c cross join lateral aclexplode(c.relacl) a where c.oid = 'public.ufc_zz_default_privilege_probe'::regclass);
insert into proof (name, ok, detail) select 'throwaway table: service_role still born with full DML',
  has_table_privilege('service_role', 'public.ufc_zz_default_privilege_probe', 'insert') and has_table_privilege('service_role', 'public.ufc_zz_default_privilege_probe', 'update')
  and has_table_privilege('service_role', 'public.ufc_zz_default_privilege_probe', 'delete') and has_table_privilege('service_role', 'public.ufc_zz_default_privilege_probe', 'select'), null;
insert into proof (name, ok, detail) select 'throwaway table: anon/authenticated SELECT default unchanged (still granted; RLS governs rows)',
  has_table_privilege('anon', 'public.ufc_zz_default_privilege_probe', 'select') and has_table_privilege('authenticated', 'public.ufc_zz_default_privilege_probe', 'select'), null;

do $t$
declare v_id uuid; v_n bigint; v_state text; v_msg text;
begin
  -- service_role: the role every product reader/writer uses
  begin
    set local role service_role;
    insert into public.ufc_ingest_runs (worker, status) values ('privilege-proof', 'running') returning id into v_id;
    update public.ufc_ingest_runs set status = 'success', finished_at = now() where id = v_id;
    select count(*) into v_n from public.ufc_events;
    reset role;
    insert into proof (name, ok, detail) values ('service_role insert/update/select still work', v_n > 0, 'events visible=' || v_n);
  exception when others then
    reset role;
    insert into proof (name, ok, detail) values ('service_role insert/update/select still work', false, sqlstate || ' ' || sqlerrm);
  end;

  -- anon: reads remain governed by RLS (zero rows, no error)
  begin
    set local role anon;
    select count(*) into v_n from public.ufc_events;
    reset role;
    insert into proof (name, ok, detail) values ('anon SELECT still allowed; RLS returns zero rows', v_n = 0, 'rows=' || v_n);
  exception when others then
    reset role;
    insert into proof (name, ok, detail) values ('anon SELECT still allowed; RLS returns zero rows', false, sqlstate || ' ' || sqlerrm);
  end;

  -- anon/authenticated writes are refused by privilege now, not only by RLS
  begin
    set local role anon;
    insert into public.ufc_ingest_runs (worker) values ('anon-should-fail');
    reset role;
    insert into proof (name, ok, detail) values ('anon INSERT refused by privilege', false, 'insert succeeded');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    reset role;
    insert into proof (name, ok, detail) values ('anon INSERT refused by privilege', v_msg like 'permission denied%', v_state || ' ' || v_msg);
  end;
  begin
    set local role authenticated;
    delete from public.ufc_ingest_runs where worker = 'privilege-proof';
    reset role;
    insert into proof (name, ok, detail) values ('authenticated DELETE refused by privilege', false, 'delete ran');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    reset role;
    insert into proof (name, ok, detail) values ('authenticated DELETE refused by privilege', v_msg like 'permission denied%', v_state || ' ' || v_msg);
  end;
end
$t$;
"""


def body() -> str:
    lines = MIGRATION.read_text(encoding="utf-8").splitlines()
    out, seen = [], {"begin": 0, "commit": 0}
    for line in lines:
        s = line.strip().lower()
        if s in ("begin;", "commit;"):
            seen[s[:-1]] += 1
            continue
        out.append(line)
    if seen != {"begin": 1, "commit": 1}:
        raise SystemExit(f"unexpected transaction markers {seen}")
    return "\n".join(out)


def batch(include_migration: bool) -> str:
    parts = ["begin;", "set local lock_timeout = '5s';", "set local statement_timeout = '120s';",
             "create temp table proof (seq serial, name text not null, ok boolean not null, detail text) on commit drop;",
             "grant all on proof to service_role, anon, authenticated;", "grant usage on sequence proof_seq_seq to service_role, anon, authenticated;",
             SNAPSHOT]
    if include_migration:
        parts.append(body())
    parts += [AFTER, ASSERTIONS,
              "select jsonb_build_object('passed', (select count(*) from proof where ok), 'failed', (select count(*) from proof where not ok), "
              "'assertions', (select jsonb_agg(jsonb_build_object('name', name, 'ok', ok, 'detail', detail) order by seq) from proof)) as proof;",
              "rollback;"]
    return "\n".join(parts)


POST = r"""select jsonb_build_object(
  'probe_table_left', to_regclass('public.ufc_zz_default_privilege_probe') is not null,
  'proof_ingest_rows_left', (select count(*) from public.ufc_ingest_runs where worker in ('privilege-proof','anon-should-fail')),
  'anon_write_grants_live', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public' and c.relkind in ('r','p') and c.relname like 'ufc\_%' and pg_get_userbyid(a.grantee) = 'anon' and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')),
  'default_acl_postgres_public_r', (select string_agg(pg_get_userbyid(a.grantee) || ':' || a.privilege_type, ',' order by 1) from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a
      where pg_get_userbyid(d.defaclrole) = 'postgres' and n.nspname = 'public' and d.defaclobjtype = 'r' and pg_get_userbyid(a.grantee) in ('anon','authenticated'))
) as post;"""


def show(result) -> int:
    if isinstance(result, dict):
        print(json.dumps(result, indent=1))
        return 1
    proof = result[0]["proof"]
    for a in proof["assertions"]:
        print(("PASS " if a["ok"] else "FAIL ") + a["name"] + (f"  [{a['detail']}]" if a["detail"] else ""))
    print(f"passed={proof['passed']} failed={proof['failed']}")
    return 0 if proof["failed"] == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["proof", "apply", "verify"], required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    token = cli_token()
    sha = hashlib.sha256(MIGRATION.read_bytes()).hexdigest()
    print(f"migration {MIGRATION.name} sha256={sha}")
    record = {"migration_sha256": sha, "mode": args.mode}

    if args.mode == "apply":
        applied = run_sql(token, MIGRATION.read_text(encoding="utf-8"))
        record["apply_response"] = applied
        if isinstance(applied, dict) and applied.get("error"):
            print(json.dumps(applied, indent=1))
            (out / "022_apply.json").write_bytes(json.dumps(record, indent=1).encode())
            return 2
        print("applied:", json.dumps(applied))

    result = run_sql(token, batch(include_migration=(args.mode == "proof")))
    post = run_sql(token, POST)
    record.update({"result": result, "post_fresh_session": post})
    (out / f"022_{args.mode}.json").write_bytes(json.dumps(record, indent=1).encode())
    rc = show(result)
    print("post (fresh session):", json.dumps(post))
    if isinstance(post, list):
        p = post[0]["post"]
        if p["probe_table_left"] or p["proof_ingest_rows_left"]:
            print("LEFTOVER FROM PROOF TRANSACTION")
            return 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
