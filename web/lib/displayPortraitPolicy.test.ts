/* Display portrait preference. Run: npm run test:display-portrait
 *
 * This decides whose face appears on every fighter surface on the site, so
 * the cases worth pinning are the ones where it must DECLINE. A preference
 * that fails open puts a stranger's headshot under a fighter's name.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DISPLAY_ESPN_PREFERRED, prefersEspnDisplay, preferredDisplayFighterIds } from "./displayPortraitPolicy.ts";
import { espnVerifiedPortrait, ESPN_DISPLAY_QUARANTINE } from "./espnPortraitGate.ts";
import type { PortraitSet } from "./db";

const PANTOJA = {
  id: "13eebfea-dbd0-4110-a41a-200b8a73051d",
  name: "Alexandre Pantoja",
  espn_athlete_id: "2560746",
  dob: "1990-04-16",
};
const STORED = {
  id: "9db8a7c9-7d62-45dd-8d4b-12cb4ea62270",
  portrait: "https://cdn/wikimedia.jpg", card: "https://cdn/wikimedia.jpg", thumb: "https://cdn/wikimedia.jpg",
  license: "CC BY 3.0", author: "Sexto Round", source_url: "https://commons.wikimedia.org/x",
  kind: "wikimedia", source_family: "wikimedia",
} as unknown as PortraitSet;

/* Scripted ESPN transport: no network, exact payload control. */
function withEspn(payload: unknown, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as never;
  return () => { globalThis.fetch = original; };
}
const espnOk = {
  id: "2560746", fullName: "Alexandre Pantoja", dateOfBirth: "1990-04-16T07:00Z",
  headshot: { href: "https://a.espncdn.com/i/headshots/mma/players/full/2560746.png", alt: "Alexandre Pantoja" },
};

/* ---- 1. the preference applies ---------------------------------------- */
test("correct fighter_id + ESPN id prefers the verified ESPN portrait", async () => {
  assert.equal(prefersEspnDisplay(PANTOJA), true);
  const restore = withEspn(espnOk);
  try {
    const got = await espnVerifiedPortrait(PANTOJA, STORED);
    assert.equal(got?.source_family, "espn");
    assert.equal(got?.portrait, espnOk.headshot.href);
    assert.equal(got?.kind, "display_fallback");
    assert.equal(got?.rights_label, "display_only");
    assert.equal(got?.stored_first_party, false);
    /* The stored photograph's licence must NOT be carried onto a different
       image — that would assert a reuse right we do not have. */
    assert.equal(got?.license, null);
    assert.equal(got?.author, "ESPN");
    assert.match(String(got?.attribution_text), /identity-verified display portrait/);
  } finally { restore(); }
});

/* ---- 2 & 3. the preference declines ----------------------------------- */
test("wrong ESPN id falls back to the stored portrait", () => {
  assert.equal(prefersEspnDisplay({ ...PANTOJA, espn_athlete_id: "9999999" }), false);
  assert.equal(prefersEspnDisplay({ ...PANTOJA, espn_athlete_id: null }), false);
});

test("wrong canonical fighter_id falls back to the stored portrait", () => {
  assert.equal(prefersEspnDisplay({ ...PANTOJA, id: "00000000-0000-4000-8000-000000000000" }), false);
});

/* ---- 4. identity verification failure ---------------------------------- */
test("ESPN identity verification failure falls back, never swaps", async () => {
  /* Disagreeing date of birth: same id, different person. */
  let restore = withEspn({ ...espnOk, dateOfBirth: "1988-01-01T07:00Z" });
  try {
    assert.equal(await espnVerifiedPortrait(PANTOJA, STORED), null, "a DOB mismatch must fail closed");
  } finally { restore(); }

  /* Different name behind the same id. */
  restore = withEspn({ ...espnOk, fullName: "Someone Else", headshot: { ...espnOk.headshot, alt: "Someone Else" } });
  try {
    assert.equal(await espnVerifiedPortrait(PANTOJA, STORED), null, "a name mismatch must fail closed");
  } finally { restore(); }

  /* Headshot alt naming a different fighter, even when the record matches. */
  restore = withEspn({ ...espnOk, headshot: { ...espnOk.headshot, alt: "Brandon Moreno" } });
  try {
    assert.equal(await espnVerifiedPortrait(PANTOJA, STORED), null, "a mismatched alt must fail closed");
  } finally { restore(); }

  /* The id ESPN answers with is not the one we asked about. */
  restore = withEspn({ ...espnOk, id: "1111111" });
  try {
    assert.equal(await espnVerifiedPortrait(PANTOJA, STORED), null, "an id mismatch must fail closed");
  } finally { restore(); }

  /* The standing quarantine still applies to anyone on it. */
  const quarantined = { ...PANTOJA, espn_athlete_id: [...ESPN_DISPLAY_QUARANTINE][0] };
  assert.equal(await espnVerifiedPortrait(quarantined, STORED), null, "a quarantined asset is never served");
});

/* ---- 5. ESPN unavailable ---------------------------------------------- */
test("ESPN unavailable keeps the stored Wikimedia portrait", async () => {
  /* A transient outage must never blank a portrait. */
  let restore = withEspn({}, 503);
  try {
    const got = await espnVerifiedPortrait(PANTOJA, STORED);
    assert.equal(got?.portrait, STORED.portrait, "a 5xx keeps the stored image");
    assert.equal(got?.license, "CC BY 3.0", "and keeps its licence");
  } finally { restore(); }

  /* A thrown request is the same case. */
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("network down"); }) as never;
  try {
    const got = await espnVerifiedPortrait(PANTOJA, STORED);
    assert.equal(got?.portrait, STORED.portrait);
  } finally { globalThis.fetch = original; }

  /* A 404 means the athlete is gone: no ESPN image, and the caller keeps
     whatever it already had rather than rendering nothing. */
  restore = withEspn({}, 404);
  try {
    assert.equal(await espnVerifiedPortrait(PANTOJA, STORED), null);
  } finally { restore(); }
});

/* ---- 6. nobody else changes -------------------------------------------- */
test("no other fighter is affected", () => {
  for (const f of [
    { id: "e204408f-aee9-4987-83ca-8a43e8802e3f", espn_athlete_id: "5120301" }, // Joshua Van
    { id: "45ef3e8d-571c-4dee-910b-3d8254f89689", espn_athlete_id: "3332412" }, // Makhachev
    { id: "0c629145-29ee-4d40-b060-2d6476164ea8", espn_athlete_id: "4683740" }, // Topuria
    { id: "6929497f-df9e-45ca-914e-f39645721735", espn_athlete_id: null },      // Royce Gracie
  ]) assert.equal(prefersEspnDisplay(f), false, `${f.id} must not be affected`);

  assert.equal(DISPLAY_ESPN_PREFERRED.size, 1, "this is a narrow exception, not a roster-wide rule");
  assert.deepEqual(preferredDisplayFighterIds(), [PANTOJA.id]);
});

test("there is exactly one display-preference policy", () => {
  /* A second allowlist elsewhere is how one surface drifts from another. */
  assert.equal(typeof prefersEspnDisplay, "function");
  assert.ok(DISPLAY_ESPN_PREFERRED.has(PANTOJA.id));
  assert.equal(DISPLAY_ESPN_PREFERRED.get(PANTOJA.id), "2560746");
});
