/* UFC Pro paywall contract: the offer agrees with itself and with Stripe
 * identities, and no premium read can happen outside the access decision. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PRO_OFFER, PRO_PLAN_ORDER, RETIRED_CHECKOUT, offerJsonLd } from "./proOffer.ts";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (n === "node_modules" || n.startsWith(".")) return [];
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const source = [...walk(join(WEB, "app")), ...walk(join(WEB, "components")), ...walk(join(WEB, "lib"))]
  .filter((f) => /\.(tsx?|mjs)$/.test(f) && !/\.test\.|test-hooks|fixtures/.test(f))
  .map((f) => ({ file: relative(WEB, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }));

test("offer: exact founding amounts, no trial, monthly is primary", () => {
  assert.equal(PRO_OFFER.productKey, "ufc_pro");
  assert.equal(PRO_OFFER.stripeProductId, "prod_VD9SH84qnOUfJ1");
  assert.equal(PRO_OFFER.trial, "none");
  assert.deepEqual(PRO_PLAN_ORDER, ["monthly", "weekly"]);
  assert.equal(PRO_OFFER.plans.monthly.amountCents, 999);
  assert.equal(PRO_OFFER.plans.monthly.display, "$9.99");
  assert.equal(PRO_OFFER.plans.monthly.cadence, "month");
  assert.equal(PRO_OFFER.plans.monthly.badge, "BEST VALUE");
  assert.equal(PRO_OFFER.plans.monthly.stripePriceId, "price_1UFbcDF3CaVzg4ORCf1e51tC");
  assert.equal(PRO_OFFER.plans.weekly.amountCents, 399);
  assert.equal(PRO_OFFER.plans.weekly.display, "$3.99");
  assert.equal(PRO_OFFER.plans.weekly.cadence, "week");
  assert.equal(PRO_OFFER.plans.weekly.badge, "FLEXIBLE");
  /* Live Stripe identities, verified by the owner in the live account 2026-09-14.
   * The billing Worker catalog (propbetedge-workers) allowlists the same four. */
  assert.equal(PRO_OFFER.plans.monthly.paymentLinkId, "plink_1UFdRLF3CaVzg4ORUQBjDiJT");
  assert.equal(PRO_OFFER.plans.monthly.checkoutUrl, "https://buy.stripe.com/7sYeVd1rU56e8FL3kf7wA0G");
  assert.equal(PRO_OFFER.plans.weekly.stripePriceId, "price_1UFdQtF3CaVzg4ORT5RYbFrL");
  assert.equal(PRO_OFFER.plans.weekly.paymentLinkId, "plink_1UFdRVF3CaVzg4OR67Ogkqkf");
  assert.equal(PRO_OFFER.plans.weekly.checkoutUrl, "https://buy.stripe.com/9B69ATgmOfKS7BHbQL7wA0H");
  assert.equal(PRO_OFFER.customerPortalLoginUrl, "https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00");
});

test("JSON-LD offers are generated from the same plan objects checkout uses", () => {
  const offers = offerJsonLd("https://ufc.propbetedge.ai");
  assert.deepEqual(offers.map((o) => o.price), ["9.99", "3.99"]);
  assert.deepEqual(offers.map((o) => o.priceSpecification.referenceQuantity.unitCode), ["MON", "WEE"]);
  const pro = source.find((s) => s.file === "app/pro/page.tsx")!.text;
  assert.match(pro, /offers: offerJsonLd\(SITE\.url\)/);
  assert.doesNotMatch(pro, /price: "\d/);
});

test("retired $14.99 / single-card acquisition is gone from every customer surface", () => {
  for (const { file, text } of source) {
    if (file === "lib/proOffer.ts") continue;
    for (const id of RETIRED_CHECKOUT) assert.ok(!text.includes(id), `${file} still references ${id}`);
    assert.doesNotMatch(text, /\$14\.99|\$5\.99\/card|cardPass|Single card pass/, file);
  }
});

test("no second Pro check exists outside the access decision", () => {
  for (const { file, text } of source) {
    assert.doesNotMatch(text, /hasProAccess\(/, file);
    if (!["lib/accessDecision.ts", "lib/access.ts"].includes(file)) {
      assert.doesNotMatch(text, /plan === "pro"|\.plan === 'pro'|account\??\.unlimited\s*(\?|&&|\|\|)/, `${file} decides Pro by itself`);
    }
  }
});

const PREMIUM_READS = /\b(getFighterDna|getMatchupDna|getMarketsFor|getEditorialMarket|marketProviderLive|unresolvedBouts)\s*\(/;
/* Data libraries define the reads; the QA fixture page 404s in production. */
const PREMIUM_READ_ALLOW = new Set(["lib/dna.ts", "lib/market.ts", "lib/editorialMarket.ts", "lib/pregame.ts", "app/qa/preview/page.tsx"]);
/* Every file that performs a premium read, with the exact guard that keeps a
 * free render from performing it. A new premium read site fails this test
 * until its guard is written down here. */
const GUARDS: Record<string, RegExp[]> = {
  "app/fighters/[slug]/page.tsx": [/access\.pro \? getFighterDna\(f\.id\) : Promise\.resolve\(null\)/],
  "app/fights/[slug]/page.tsx": [
    /access\.pro \? getMatchupDna\(b\.fighter_a\.id, b\.fighter_b\.id, b\.result \? e\.event_date : null\) : Promise\.resolve\(null\)/,
    /access\.pro \? getFighterDna\(b\.fighter_a\.id, e\.event_date\) : Promise\.resolve\(null\)/,
    /access\.pro \? getFighterDna\(b\.fighter_b\.id, e\.event_date\) : Promise\.resolve\(null\)/,
    /const \[markets, providerLive, unresolved\] = access\.pro\s*\? await Promise\.all/,
    /for \(let i = 0; access\.pro && i < rbaRounds\.length; i \+= 1\)/,
    /dnaA=\{access\.pro \? compareToDna/,
  ],
  "app/events/[slug]/page.tsx": [/const providerLive = access\.pro \? await marketProviderLive\(\) : false;/, /const marketMap = done \|\| !providerLive/, /const unresolved = done \|\| !providerLive/],
  "components/StoryView.tsx": [/const editorialMarket = access\.pro \? await getEditorialMarket/, /const dna = access\.pro && bout && a\.story_type === "fight_preview" \? await getMatchupDna/],
};
/* generateMetadata reads DNA only to say whether a profile exists in the
 * snippet; the value is never rendered. */
const METADATA_ONLY = [/const \[bouts, rounds, dna\] = await Promise\.all\(\[getFighterBouts\(f\.id\), getFighterRoundStats\(f\.id\), getFighterDna\(f\.id\)\]\)/, /getRoundStats\(b\.id\), getFightTotals\(b\.id\)\.catch\(\(\) => \[\]\), getMatchupDna\(b\.fighter_a\.id, b\.fighter_b\.id, e\.event_date\)/];

test("every premium read site asks getUfcAccess first and carries a written guard", () => {
  for (const { file, text } of source) {
    if (PREMIUM_READ_ALLOW.has(file) || !PREMIUM_READS.test(text)) continue;
    assert.ok(GUARDS[file], `${file} reads premium data but has no guard registered in paywall.test.ts`);
    assert.match(text, /getUfcAccess\(\)/, `${file} reads premium data without the access decision`);
    for (const g of GUARDS[file]) assert.match(text, g, `${file} lost guard ${g}`);
    const reads = [...text.matchAll(new RegExp(PREMIUM_READS.source, "g"))].length;
    const guarded = GUARDS[file].length + METADATA_ONLY.filter((m) => m.test(text)).length;
    assert.ok(reads <= guarded + (file === "app/events/[slug]/page.tsx" ? 1 : 0), `${file}: ${reads} premium reads but ${guarded} guards`);
  }
});

test("desk briefs fold in Fight DNA only when the caller passes its Pro decision", () => {
  const pregame = source.find((s) => s.file === "lib/pregame.ts")!.text;
  assert.match(pregame, /index === 0 && opts\.dna === true \? getMatchupDna/);
  for (const { file, text } of source) {
    if (file === "lib/pregame.ts" || file === "app/qa/preview/page.tsx") continue;
    for (const m of text.matchAll(/buildDeskBriefs\(/g)) {
      const call = text.slice(m.index!, m.index! + 260);
      assert.match(call, /dna: (access\.pro|opts\.dna === true)/, `${file}: ${call.split(/\r?\n/)[0]}`);
    }
    for (const m of text.matchAll(/loadFightWeek\(e[,)]/g)) {
      assert.match(text.slice(m.index!, m.index! + 80), /dna: access\.pro/, `${file}: loadFightWeek without dna decision`);
    }
  }
});

test("release gate: every Stripe identity and checkout URL is real, none retired", () => {
  for (const k of PRO_PLAN_ORDER) {
    const p = PRO_OFFER.plans[k];
    assert.match(p.stripePriceId, /^price_[A-Za-z0-9]+$/);
    assert.match(p.paymentLinkId, /^plink_[A-Za-z0-9]+$/);
    assert.match(p.checkoutUrl, /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9]+$/);
  }
  assert.match(PRO_OFFER.customerPortalLoginUrl, /^https:\/\/billing\.stripe\.com\/p\/login\/[A-Za-z0-9]+$/);
  const live = PRO_PLAN_ORDER.flatMap((k) => [PRO_OFFER.plans[k].stripePriceId, PRO_OFFER.plans[k].paymentLinkId, PRO_OFFER.plans[k].checkoutUrl]);
  for (const id of live) assert.ok(!(RETIRED_CHECKOUT as readonly string[]).includes(id), `${id} is a retired acquisition object`);
  assert.equal(new Set(live).size, live.length);
});

test("paid-only auth: no free-member creation path, no pre-authorization token or email", () => {
  const all = source.map((s) => ({ ...s, flat: s.text.replace(/\s+/g, " ") }));
  for (const { file, text } of all) {
    assert.doesNotMatch(text, /getOrCreateAccount/, `${file} still has the auto-create path`);
    if (file !== "lib/auth.ts") assert.doesNotMatch(text, /["'`]ufc_accounts["'`]\s*,\s*\{\s*method:\s*["']POST/, `${file} inserts ufc_accounts directly`);
  }
  const auth = source.find((s) => s.file === "lib/auth.ts")!.text;
  const posts = auth.match(/sb<Account\[\]>\("ufc_accounts", \{\s*method: "POST"/g) || [];
  assert.equal(posts.length, 1, "exactly one account insert");
  assert.match(auth, /export async function createEntitledMemberAccount\(proof: EntitlementProof\)[\s\S]{0,160}member_creation_requires_entitlement_proof/);
  const request = source.find((s) => s.file === "app/api/auth/request/route.ts")!.text;
  assert.match(request, /handleLoginRequest\(authDeps\(\)/);
  assert.doesNotMatch(request, /createLoginToken|api\.resend\.com|ufc_accounts/, "request route must not bypass the flow");
  const verify = source.find((s) => s.file === "app/api/auth/verify/route.ts")!.text;
  assert.match(verify, /handleLoginVerify\(authDeps\(\)/);
  assert.doesNotMatch(verify, /createSession|consumeLoginToken|createEntitledMemberAccount/, "verify route must not bypass the flow");
  const flow = source.find((s) => s.file === "lib/authFlow.ts")!.text;
  const body = flow.slice(flow.indexOf("export async function handleLoginRequest"), flow.indexOf("export type VerifyResult"));
  const order = ["deps.countRecentAttempts(", "deps.recordAttempt(", "decideLoginEligibility(", "deps.createLoginToken(", "deps.sendLoginEmail("].map((k) => body.indexOf(k));
  assert.ok(order.every((i) => i > 0), `request flow missing a step: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "authorization must precede token creation and email");
});
