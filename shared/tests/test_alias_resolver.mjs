/* Run: node shared/tests/test_alias_resolver.mjs  (from repo root). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AliasResolver, normalize, tokenSortRatio, aliasRowsForFighter } from '../alias_resolver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, 'fixtures.json'), 'utf8'));
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures += 1; console.log('FAIL:', msg); } };

for (const [raw, expected] of FX.normalize) {
  const got = normalize(raw);
  check(got === expected, `normalize(${JSON.stringify(raw)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
}
for (const [a, b, expected] of FX.token_sort_ratio) {
  const got = tokenSortRatio(a, b);
  check(Math.abs(got - expected) < 1e-9, `tokenSortRatio(${a},${b}) = ${got}, expected ${expected}`);
}

const r = new AliasResolver(FX.fighters);
for (const c of FX.resolve) {
  const [name, source, kw] = c.args;
  const res = r.resolve(name, source, kw);
  const exp = c.expect;
  check(res.status === exp.status, `[${c.name}] status=${res.status} expected ${exp.status}`);
  if (exp.fighter_id) check(res.fighter_id === exp.fighter_id, `[${c.name}] fighter_id=${res.fighter_id} expected ${exp.fighter_id}`);
  if (exp.method) check(res.method === exp.method, `[${c.name}] method=${res.method} expected ${exp.method}`);
  if (exp.n_candidates !== undefined) {
    const n = res.review_row ? res.review_row.candidate_fighter_ids.length : 0;
    check(n === exp.n_candidates, `[${c.name}] n_candidates=${n} expected ${exp.n_candidates}`);
  }
  if (exp.dob_conflict !== undefined) check(res.dob_conflict === exp.dob_conflict, `[${c.name}] dob_conflict=${res.dob_conflict} expected ${exp.dob_conflict}`);
  if (exp.reason) {
    const got = res.review_row ? res.review_row.context.reason : null;
    check(got === exp.reason, `[${c.name}] reason=${got} expected ${exp.reason}`);
  }
}

const rows = aliasRowsForFighter('f-so', "Sean O'Malley", 'Sugar');
check(rows.length === 2 && rows[0].normalized === 'sean omalley' && rows[1].source === 'ufcstats_nickname', `alias rows ${JSON.stringify(rows)}`);

console.log('alias_resolver.mjs:', failures === 0 ? 'OK' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
