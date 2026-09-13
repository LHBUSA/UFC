/* Market matching regression. Run: node scripts/odds/market_match.test.mjs
 *
 * The corpus is REAL: 62 distinct outcome names exactly as The Odds API spelled
 * them, taken from the observations already in production, each paired with the
 * canonical fighter the shipped ingest resolved it to and the two corners of
 * the bout it was scoped by.
 *
 * It exists because the matching rules are about to be shared between the CLI
 * and a Cloudflare Worker, and a refactor that silently changes who a price
 * attaches to is the single worst failure this system can have. Every case here
 * is a decision production has already made; if a change flips one, that is a
 * regression regardless of how reasonable the new answer looks.
 *
 * The interesting rows are the six where the provider spells a fighter
 * differently from us:
 *
 *   J.J. Aldrich        -> JJ Aldrich            punctuation
 *   Edgar Chairez       -> Édgar Cháirez         accents
 *   Waldo Cortes-Acosta -> Waldo Cortes Acosta   hyphen
 *   Thomas Gantt        -> Tommy Gantt           surname within the bout
 *   Jose Delgado        -> Jose Miguel Delgado   surname within the bout
 *   Zhu Rong            -> Rongzhu               alias table
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normName, resolveOutcome, observationKey, OBS_CONFLICT_COLUMNS, buildIndex, stripNickname } from './market_match.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const corpus = JSON.parse(readFileSync(path.join(FIX, 'market_corpus.json'), 'utf8'));
const aliases = JSON.parse(readFileSync(path.join(FIX, 'market_aliases.json'), 'utf8'));

let failures = 0;
const fail = (m) => { failures += 1; console.log(`FAIL ${m}`); };
const eq = (a, b, m) => { if (a !== b) fail(`${m}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`); };

/* The index the shipped ingest builds, from the same two inputs. */
const fighters = [];
const seen = new Set();
for (const r of corpus) {
  for (const [id, name] of [[r.corner_a_id, r.corner_a], [r.corner_b_id, r.corner_b]]) {
    if (!seen.has(id)) { seen.add(id); fighters.push({ id, name }); }
  }
}
const byNorm = buildIndex(fighters, aliases);

/* ---- the corpus: every resolution production already made ---------------- */
let exact = 0, alias = 0, surname = 0;
for (const row of corpus) {
  const boutFighters = [{ id: row.corner_a_id, name: row.corner_a }, { id: row.corner_b_id, name: row.corner_b }];
  const got = resolveOutcome(row.outcome_name, boutFighters, byNorm);
  if (got.status !== 'ok') { fail(`${row.outcome_name}: ${got.status} (${got.reason}) — production resolved this to ${row.resolved_name}`); continue; }
  eq(got.fighterId, row.outcome_fighter_id, `${row.outcome_name} resolved to the wrong fighter`);
  if (got.method === 'exact') exact += 1;
  else if (got.method === 'alias') alias += 1;
  else if (got.method === 'surname_in_bout') surname += 1;
}
console.log(`corpus: ${corpus.length} names · exact ${exact} · alias ${alias} · surname-in-bout ${surname}`);

/* ---- the rules that must not loosen ------------------------------------- */

/* Scoping to the two corners is what makes a surname safe. Across a roster it
 * is not, and nothing here may ever widen the candidate set. */
{
  const bout = [{ id: 'a', name: 'Anderson Silva' }, { id: 'b', name: 'Thiago Silva' }];
  const r = resolveOutcome('Silva', bout, new Map());
  eq(r.status, 'ambiguous', 'a shared surname inside one bout must fail closed');
  eq(r.reason, 'shared_surname_in_bout', 'and say why');
}
{
  const bout = [{ id: 'a', name: 'Jon Jones' }, { id: 'b', name: 'Daniel Cormier' }];
  eq(resolveOutcome('Someone Else', bout, new Map()).status, 'unresolved', 'a name in neither corner never resolves');
  eq(resolveOutcome('', bout, new Map()).status, 'unresolved', 'an empty outcome name never resolves');
}
{
  /* Two corners that normalise identically cannot be told apart. */
  const bout = [{ id: 'a', name: 'Jose Aldo' }, { id: 'b', name: 'José Aldo' }];
  eq(resolveOutcome('Jose Aldo', bout, new Map()).status, 'ambiguous', 'identical normalised corners must fail closed');
}
{
  /* An alias that points at both corners is not a resolution. */
  const bout = [{ id: 'a', name: 'Fighter One' }, { id: 'b', name: 'Fighter Two' }];
  const idx = new Map([['the champ', new Set(['a', 'b'])]]);
  eq(resolveOutcome('The Champ', bout, idx).status, 'ambiguous', 'an alias matching both corners must fail closed');
}

/* ---- normalisation keeps identity ------------------------------------- */
eq(normName('Édgar Cháirez'), 'edgar chairez', 'accents are folded');
eq(normName("J.J. Aldrich"), 'jj aldrich', 'punctuation is dropped');
eq(normName('Waldo Cortes-Acosta'), 'waldo cortes acosta', 'hyphens become spaces');
eq(normName("O'Malley"), 'omalley', 'apostrophes are dropped, not spaced');
/* It must NOT reorder or drop name parts: that is where two people collide. */
eq(normName('Jose Miguel Delgado'), 'jose miguel delgado', 'middle names survive normalisation');
eq(stripNickname('Michael "Venom" Page'), 'Michael Page', 'a quoted nickname is removed');
eq(stripNickname('Alex Pereira'), 'Alex Pereira', 'a name without a nickname is untouched');

/* ---- observation identity ---------------------------------------------- */
{
  /* These six columns ARE the unique constraint. observed_at is deliberately
   * absent: it records when we looked, and including it would make every run
   * unique and defeat deduplication entirely. */
  eq(OBS_CONFLICT_COLUMNS.join(','), 'bout_id,bookmaker_key,market_key,outcome_name,source_last_update,price',
    'the conflict target drifted from the database constraint');
  const row = { bout_id: 'b1', bookmaker_key: 'dk', market_key: 'h2h', outcome_name: 'X', source_last_update: 't1', price: -150, observed_at: 'now' };
  const same = { ...row, observed_at: 'later' };
  eq(observationKey(row), observationKey(same), 'a re-read of an unchanged price is the same fact');
  eq(observationKey({ ...row, price: -160 }) === observationKey(row), false, 'a changed price is new history');
  eq(observationKey({ ...row, source_last_update: 't2' }) === observationKey(row), false, 'a new provider update is new history');
}

console.log(failures === 0 ? 'market_match.mjs: OK' : `market_match.mjs: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
