/* Which failures may be repaired in place, and which must force a rewrite.
 *
 * Getting this boundary wrong is expensive in one direction and dangerous in
 * the other. Too narrow and every number slip costs a full regeneration, which
 * is the waste this exists to remove. Too wide and we try to fix a document-
 * level problem -- an article 200 words short, or a headline that never names
 * its subject -- by swapping a sentence, which cannot work and burns a call to
 * discover it.
 *
 * The rule is simple and is asserted here: a failure qualifies only if it names
 * the sentence it is about, and ONE unqualified failure disqualifies the whole
 * set, because the rewrite has to happen anyway.
 */
import { sentenceScopedForTest as sentenceScoped } from "../src/editorial.mjs";

const CLASS_C = 'class C number "28" is in no part of the packet — remove it or replace it with a packet value. In: "Gaethje has 28 finishes in the promotion."';
const CLASS_B = 'class B number "12" comes only from Sherdog, so that sentence must name Sherdog. In: "He has been out for 12 weeks."';
const TOO_SHORT = "too short: 412 words < 500";
const NO_H2 = "fewer than 3 H2 sections";
const HEADLINE = "headline and dek never name the primary subject (Roberto Soldić)";
const MARKETS = "unknown market(s): No actionable market";

const cases = [
  ["single class C", [CLASS_C], 1],
  ["single class B", [CLASS_B], 1],
  ["both number classes", [CLASS_C, CLASS_B], 2],
  ["word count alone", [TOO_SHORT], null],
  ["missing sections alone", [NO_H2], null],
  ["headline alone", [HEADLINE], null],
  ["unknown markets alone", [MARKETS], null],
  ["number failure MIXED with a structural one", [CLASS_C, TOO_SHORT], null],
  ["structural first, then number", [HEADLINE, CLASS_B], null],
  ["empty", [], null],
];

let bad = 0;
for (const [name, failures, expected] of cases) {
  const got = sentenceScoped(failures);
  const n = got ? got.length : null;
  const ok = n === expected;
  if (!ok) bad += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(44)} -> ${n === null ? "rewrite" : `repair ${n}`} (expected ${expected === null ? "rewrite" : `repair ${expected}`})`);
}

/* The extracted sentence must be the sentence, not the reason wrapped around it:
 * a repair is applied by string replacement into the body, so a sloppy capture
 * would fail to locate its target and silently leave the failing text in place. */
const one = sentenceScoped([CLASS_C]);
const sentenceOk = one?.[0]?.sentence === "Gaethje has 28 finishes in the promotion.";
const reasonOk = one?.[0]?.reason.startsWith("class C number") && !one[0].reason.includes("In: ");
if (!sentenceOk) { bad += 1; console.log(`  FAIL sentence capture -> ${JSON.stringify(one?.[0]?.sentence)}`); }
if (!reasonOk) { bad += 1; console.log(`  FAIL reason strips the quoted sentence -> ${JSON.stringify(one?.[0]?.reason)}`); }
if (sentenceOk && reasonOk) console.log("  ok   sentence and reason are separated cleanly");

console.log(bad ? `\n${bad} FAILURE(S)` : "\nrepair boundary holds");
if (bad) process.exit(1);
