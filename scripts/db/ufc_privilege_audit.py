"""Read-only privilege audit of every public.ufc_* table on production.

Reports, per table: owner, RLS, policy count, and the anon / authenticated /
service_role privileges from the catalog ACL (aclexplode, so a privilege held
through PUBLIC or granted twice is still counted once per grantee). Also
reports the roles involved in creating tables and the schema default ACLs
that decide what the NEXT table will be born with.

    python scripts/db/ufc_privilege_audit.py --out D:/Workers/_research/ufc-legacy-origins-2026-09-12/privilege/audit_before.json

Writes nothing to the database.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "legacy"))
from prove_first_repair import cli_token, run_sql  # noqa: E402

WRITE = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]

TABLES_SQL = r"""
with t as (
  select c.oid, c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relkind
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname like 'ufc\_%'
),
acl as (
  select t.relname, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee, a.privilege_type
  from t cross join lateral aclexplode(coalesce((select relacl from pg_class where oid = t.oid), acldefault('r', (select relowner from pg_class where oid = t.oid)))) a
)
select jsonb_agg(jsonb_build_object(
  'table', t.relname, 'owner', t.owner, 'rls', t.rls, 'kind', t.relkind::text,
  'policies', (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = t.relname),
  'anon', (select coalesce(jsonb_agg(distinct privilege_type order by privilege_type), '[]') from acl where acl.relname = t.relname and grantee = 'anon'),
  'authenticated', (select coalesce(jsonb_agg(distinct privilege_type order by privilege_type), '[]') from acl where acl.relname = t.relname and grantee = 'authenticated'),
  'service_role', (select coalesce(jsonb_agg(distinct privilege_type order by privilege_type), '[]') from acl where acl.relname = t.relname and grantee = 'service_role'),
  'public', (select coalesce(jsonb_agg(distinct privilege_type order by privilege_type), '[]') from acl where acl.relname = t.relname and grantee = 'PUBLIC')
) order by t.relname) as tables
from t;
"""

ROLES_SQL = r"""
select jsonb_build_object(
  'current_user', current_user::text,
  'session_user', session_user::text,
  'current_user_superuser', (select rolsuper from pg_roles where rolname = current_user),
  'current_user_member_of', (select coalesce(jsonb_agg(r.rolname::text order by r.rolname), '[]') from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = current_user),
  'public_schema_owner', (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'public'),
  'default_acl', (select coalesce(jsonb_agg(jsonb_build_object(
        'role', pg_get_userbyid(d.defaclrole), 'schema', coalesce(n.nspname, '(global)'), 'objtype', d.defaclobjtype::text,
        'entries', (select jsonb_agg(jsonb_build_object('grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
                                                        'grantor', pg_get_userbyid(a.grantor), 'privilege', a.privilege_type) order by 1)
                    from aclexplode(d.defaclacl) a))
      order by pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype), '[]')
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace),
  'recent_table_creators', (select coalesce(jsonb_agg(jsonb_build_object('table', relname, 'owner', owner) order by oid desc), '[]')
    from (select c.oid, c.relname, pg_get_userbyid(c.relowner) owner from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' order by c.oid desc limit 12) x)
) as roles;
"""


def audit(token: str) -> dict:
    tables = run_sql(token, TABLES_SQL)
    roles = run_sql(token, ROLES_SQL)
    if isinstance(tables, dict) or isinstance(roles, dict):
        raise SystemExit(f"audit query failed: {tables if isinstance(tables, dict) else roles}")
    rows = tables[0]["tables"]
    summary = {
        "ufc_tables": len(rows),
        "rls_disabled": [r["table"] for r in rows if not r["rls"]],
        "tables_with_policies": [r["table"] for r in rows if r["policies"]],
        "owners": sorted({r["owner"] for r in rows}),
        "tables_with_anon_or_auth_write": [r["table"] for r in rows if set(WRITE) & set(r["anon"] + r["authenticated"])],
        "anon_write_grants": sum(len(set(WRITE) & set(r["anon"])) for r in rows),
        "authenticated_write_grants": sum(len(set(WRITE) & set(r["authenticated"])) for r in rows),
        "public_grants": {r["table"]: r["public"] for r in rows if r["public"]},
    }
    return {"summary": summary, "roles": roles[0]["roles"], "tables": rows}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    result = audit(cli_token())
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(json.dumps(result, indent=1, sort_keys=True).encode("utf-8"))
    print(json.dumps({"summary": result["summary"], "roles": {k: v for k, v in result["roles"].items() if k != "default_acl"}}, indent=1))
    print("default_acl:")
    for d in result["roles"]["default_acl"]:
        writes = sorted({e["privilege"] for e in d["entries"] if e["grantee"] in ("anon", "authenticated") and e["privilege"] in WRITE})
        print(f"  role={d['role']} schema={d['schema']} objtype={d['objtype']} anon/auth write={writes}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
