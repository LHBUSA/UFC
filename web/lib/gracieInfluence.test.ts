/* The Gracie Influence editorial constraints. Run: npm run test:gracie
 *
 * This page makes historical claims, so the things worth pinning are the
 * claims it must NEVER make and the source boundary it must never quietly
 * cross. Prose drifts under editing; a test does not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  GRACIE_MOMENTS, GRACIE_FIGURES, GRACIE_RULES_THEN_NOW, GRACIE_ARCHIVE_FLOOR, UFC_ERAS, UFC_OFFICIAL,
} from "./heritage.ts";

/* The sentence a match sits in. A denial anywhere in the same sentence covers
 * the claim, and a fixed character window does not — the page refuses three
 * myths in one long sentence, which is exactly the shape this has to handle. */
function sentenceAround(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf(". ", index), text.lastIndexOf("\n\n", index));
  const dot = text.indexOf(". ", index);
  return text.slice(start < 0 ? 0 : start, dot < 0 ? text.length : dot + 1);
}

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const pageSource = readFileSync(join(root, "app", "history", "gracie-influence", "page.tsx"), "utf8");
const allProse = [
  ...GRACIE_MOMENTS.flatMap((m) => [m.title, m.body, m.event]),
  ...GRACIE_FIGURES.flatMap((f) => [f.name, f.role, f.body]),
  ...GRACIE_RULES_THEN_NOW.flatMap((r) => [r.label, r.then, r.now]),
  pageSource,
].join("\n");

test("the page never claims the Gracies invented MMA", () => {
  /* The single most common version of this story, and the one the brief
     explicitly rules out. Cross-style contests long predate 1993. */
  /* The phrase may appear ONLY inside an explicit denial. Banning the words
     outright would forbid the page from naming the myth it refuses, which is
     the clearest way to refuse it — so each occurrence is checked for a
     negation in the text around it instead of being banned outright. */
  const NEGATED = /\b(not|never|no|did not|didn|refus|myth)\b/i;
  for (const claim of [
    /invented (mixed martial arts|MMA|the sport)/gi,
    /(created|founded) (mixed martial arts|MMA)\b/gi,
    /father of (mixed martial arts|MMA)/gi,
    /first (mixed martial arts|MMA) (fight|contest|match) (ever|in history)/gi,
  ]) {
    for (const hit of allProse.matchAll(claim)) {
      const sentence = sentenceAround(allProse, hit.index ?? 0);
      assert.ok(NEGATED.test(sentence), `page asserts an invention claim without denying it: "${sentence.trim().slice(0, 150)}"`);
    }
  }
  /* And it says so positively somewhere, so the limit is visible to a reader
     rather than only enforced in a test. */
  assert.match(pageSource, /predate 1993/);
});

test("the page never claims Royce won UFC 3", () => {
  const ufc3 = GRACIE_MOMENTS.find((m) => m.event === "UFC 3");
  assert.ok(ufc3, "the UFC 3 moment must exist — omitting it would be its own distortion");
  assert.match(ufc3.body, /withdr(ew|aws|awal)/i, "the UFC 3 entry must say he withdrew");
  /* Same rule as the invention claim: the page is allowed to NAME the false
     claim in order to refuse it, and nowhere else. */
  const DENIED = /\b(not|never|no|did not|didn|will not tell you)\b/i;
  for (const hit of allProse.matchAll(/won UFC 3|UFC 3 (tournament )?(win|winner|champion)/gi)) {
    const sentence = sentenceAround(allProse, hit.index ?? 0);
    assert.ok(DENIED.test(sentence), `page claims a UFC 3 tournament win: "${sentence.trim().slice(0, 150)}"`);
  }
  /* The tournaments he did win are named, and UFC 3 is not among them. */
  const wonList = allProse.match(/UFC 1, UFC 2 and UFC 4/g);
  assert.ok(wonList && wonList.length > 0, "the three tournament wins should be stated as UFC 1, 2 and 4");
});

test("the page never claims early results prove BJJ supremacy today", () => {
  for (const claim of [
    /(proves|proved|demonstrates) (that )?(bjj|jiu-jitsu|grappling) is (the )?(best|superior)/i,
    /(bjj|jiu-jitsu) (is|remains) superior/i,
    /best martial art/i,
  ]) {
    assert.ok(!claim.test(allProse), `page asserts a supremacy claim matching ${claim}`);
  }
  /* The counter-evidence is carried on the page, not omitted. */
  const ufc60 = GRACIE_MOMENTS.find((m) => m.event === "UFC 60");
  assert.ok(ufc60, "the UFC 60 loss must be present as the honest bookend");
  assert.match(ufc60.body, /stopped/i);
});

test("the stated archive floor matches the earliest moment marked archived", () => {
  /* UFC 1 entered the archive on 2026-09-13 (Legacy Origins first repair).
     The floor, the moment flag and the early-event set must move together, or
     the page states a boundary its own bout list contradicts. */
  const ufc1 = GRACIE_MOMENTS.find((m) => m.event === "UFC 1");
  assert.ok(ufc1, "UFC 1 must appear");
  assert.equal(ufc1.archived, true, "UFC 1 is in the PropBetEdge archive and must say so");
  assert.equal(ufc1.official, UFC_OFFICIAL.ufc1, "the moment still carries the official UFC source");
  assert.match(GRACIE_ARCHIVE_FLOOR, /UFC 1/);
  assert.match(pageSource, /const EARLY_EVENTS = \["UFC 1",/);
  assert.ok(!/UFC 1 is not in it/.test(pageSource), "the retired coverage-gap sentence is still on the page");
});

test("the UFC 1 referee is not asserted where sources disagree", () => {
  assert.match(pageSource, /leave the field unresolved/);
  assert.ok(!/(Barreto|Vigio)/.test(allProse), "the page names a UFC 1 referee the sources have not settled");
});

test("both Royce vs Shamrock meetings are described as held", () => {
  assert.match(pageSource, /the UFC 1 submission and the UFC 5 draw/);
  const ufc5 = GRACIE_MOMENTS.find((m) => m.event === "UFC 5");
  assert.ok(ufc5 && ufc5.archived, "the UFC 5 draw is the part of that rivalry we do hold");
  assert.match(ufc5.body, /draw/i);
});

test("every unarchived moment carries an official UFC link", () => {
  const official = new Set<string>(Object.values(UFC_OFFICIAL));
  for (const m of GRACIE_MOMENTS) {
    assert.ok(m.official, `${m.event} has no official source`);
    assert.ok(official.has(m.official), `${m.event} links outside the official destination list`);
    assert.match(m.official, /^https:\/\/www\.ufc\.com\//, `${m.event} official link is not a UFC.com destination`);
  }
  for (const f of GRACIE_FIGURES) {
    assert.ok(official.has(f.official), `${f.name} links outside the official destination list`);
  }
});

test("Rorion Gracie is text and links only, with no portrait claimed", () => {
  const rorion = GRACIE_FIGURES.find((f) => f.name === "Rorion Gracie");
  assert.ok(rorion, "Rorion must be covered — he co-created the event");
  assert.equal(rorion.inArchive, false, "no reusable portrait is on file for Rorion");
  /* And his stake in the outcome is disclosed rather than smoothed over. */
  assert.match(rorion.body, /promoter|interested party/i);
});

test("the page never reproduces restricted promotional imagery", () => {
  for (const host of ["gettyimages", "zuffa", "ufc.com/images", "espncdn", "imgur"]) {
    assert.ok(!pageSource.includes(host), `page references a restricted or unapproved media host: ${host}`);
  }
  /* Portraits come from the approved resolver, and credit is rendered. */
  assert.match(pageSource, /getImagesForFighters/);
  assert.match(pageSource, /<Credit img=/);
});

test("the softened history line is in place and the old absolute is gone", () => {
  const gracieEra = UFC_ERAS.find((e) => e.key === "gracie");
  assert.ok(gracieEra);
  assert.match(gracieEra.whyItMattered, /The case for training mixed martial arts as a single discipline begins here\./);
  const eraProse = UFC_ERAS.map((e) => `${e.summary}\n${e.whyItMattered}`).join("\n");
  assert.ok(
    !/(?<!The case for training )Mixed martial arts as a single discipline begins here/.test(eraProse),
    "the unqualified version of the line is still present",
  );
});

test("the core thesis is stated, and stated narrowly", () => {
  assert.match(pageSource, /competitive value of grappling/);
  assert.match(pageSource, /changed what fighters needed to train|changed what every serious fighter afterwards had to train/i);
  /* A timeline with no rule context invites the reader to compare eras that
     are not comparable. */
  assert.ok(GRACIE_RULES_THEN_NOW.length >= 5, "the then/now rule contrast must be substantive");
  for (const r of GRACIE_RULES_THEN_NOW) assert.ok(r.then && r.now && r.label);
});
