/* node shared/tests/test_tuf_guard.mjs
 *
 * The names that must be refused are ESPN's own, as listed on 2026-09-12; the
 * names that must pass are real cards, including every finale naming style. */
import assert from 'node:assert/strict';
import { tufInHouseEventReason, isTufInHouseEvent } from '../tuf_guard.mjs';

const REFUSE = [
  'The Ultimate Fighter 26 Semifinal',
  'The Ultimate Fighter 29 Semifinal',
  'The Ultimate Fighter 30 Semifinal',
  'The Ultimate Fighter 31 Semifinal',
  'The Ultimate Fighter 30 Semifinal: Nunes vs. Peña',
  'The Ultimate Fighter 31 Semifinal: McGregor vs. Chandler',
  'The Ultimate Fighter 34 Quarterfinal',
  'The Ultimate Fighter: Team Cormier vs Team Bisping Quarter-Final',
  'TUF 33 Episode 4',
  'The Ultimate Fighter Elimination Round',
  'Ultimate Fighter Wild Card Fight',
];
const ALLOW = [
  'The Ultimate Fighter 28 Finale',
  'The Ultimate Fighter: Team Liddell vs Team Ortiz Finale',
  'TUF Brazil Finale',
  'The Ultimate Fighter: A Champion Will Be Crowned Finale',
  'UFC Fight Night: Santos vs. Hill',
  'UFC 292: Sterling vs. O\'Malley',
  "Dana White's Contender Series: Brazil 2",
  'UFC 300: Pereira vs. Hill',
  'Noche UFC',
  'The Ultimate Fighter Nations Finale: Bisping vs. Kennedy',
];

for (const n of REFUSE) assert.ok(isTufInHouseEvent(n), `must refuse: ${n}`);
for (const n of ALLOW) assert.equal(tufInHouseEventReason(n), null, `must allow: ${n}`);

console.log(`tuf_guard: ${REFUSE.length} refused, ${ALLOW.length} allowed — ok`);
