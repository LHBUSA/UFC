/* Hero portrait override. Run: npm run test:hero
 *
 * The override exists to improve one picture on one surface. The risk it
 * carries is identity: a display swap keyed carelessly could put the wrong
 * person on the biggest image on the site. These pin the gate.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { heroPrefersEspn } from "./heroPortraitPolicy.ts";

const PANTOJA = { id: "13eebfea-dbd0-4110-a41a-200b8a73051d", espn_athlete_id: "2560746" };

test("the override applies only when BOTH ids match", () => {
  assert.equal(heroPrefersEspn(PANTOJA), true);
  /* Right fighter row, wrong ESPN linkage: decline rather than swap. If the
     linkage were ever re-pointed, this is what stops a stranger's headshot
     appearing under his name. */
  assert.equal(heroPrefersEspn({ ...PANTOJA, espn_athlete_id: "9999999" }), false);
  assert.equal(heroPrefersEspn({ ...PANTOJA, espn_athlete_id: null }), false);
  /* Right ESPN id attached to a different canonical fighter. */
  assert.equal(heroPrefersEspn({ id: "00000000-0000-4000-8000-000000000000", espn_athlete_id: "2560746" }), false);
});

test("no other fighter is affected", () => {
  /* Joshua Van is the other half of this hero and must be untouched. */
  assert.equal(heroPrefersEspn({ id: "e204408f-aee9-4987-83ca-8a43e8802e3f", espn_athlete_id: "5120301" }), false);
  for (const f of [
    { id: "45ef3e8d-571c-4dee-910b-3d8254f89689", espn_athlete_id: "3332412" }, // Makhachev
    { id: "6929497f-df9e-45ca-914e-f39645721735", espn_athlete_id: null },       // Royce Gracie
  ]) assert.equal(heroPrefersEspn(f), false);
});

test("the list stays small and deliberate", () => {
  /* A growing allowlist means the portrait pipeline has a real problem that
     should be fixed at the source instead. Kept as a tripwire, not a policy. */
  const ids = ["13eebfea-dbd0-4110-a41a-200b8a73051d"];
  for (const id of ids) assert.equal(heroPrefersEspn({ id, espn_athlete_id: "2560746" }), true);
});
