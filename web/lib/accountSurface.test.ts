/* UFC premium account + native All Access page (owner decisions 2026-10-05):
 * presentation-only Platinum, a real local /all-access page, separate link
 * constants, and states rendered from the server verdict. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_ACCESS_CHECKOUT_URL, LOCAL_ALL_ACCESS_PATH, NETWORK_ALL_ACCESS_URL, PLATINUM_TRUTH, UFC_CAPABILITIES, accountView, badgeLabel, designation, memberHref } from "./accountSurface.ts";
import { ALL_ACCESS_OFFER, ALL_ACCESS_URL, STATES } from "./pbe-membership.js";
import family from "./family.json" with { type: "json" };

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("three link jobs, three constants; checkout and price unchanged", () => {
  assert.equal(LOCAL_ALL_ACCESS_PATH, "/all-access");
  assert.equal(NETWORK_ALL_ACCESS_URL, ALL_ACCESS_URL);
  assert.equal(ALL_ACCESS_CHECKOUT_URL, ALL_ACCESS_OFFER.checkoutUrl);
  assert.equal(ALL_ACCESS_CHECKOUT_URL, "https://buy.stripe.com/8x2eVdgmOaqy4pv8Ez7wA0N");
  assert.equal(ALL_ACCESS_OFFER.price, "$29/month");
  assert.equal(ALL_ACCESS_OFFER.promoCode, "THEEDGE25");
});

test("designation: Platinum is presentation for all_access; Pro and owner keep their names; FREE has none", () => {
  assert.deepEqual(STATES, ["free", "sport_pro", "all_access", "owner"], "backend states unchanged");
  assert.equal(badgeLabel("all_access"), "◆ PLATINUM");
  assert.equal(designation("all_access")?.eyebrow, "UFC · PLATINUM MEMBER");
  assert.equal(designation("all_access")?.status, "PLATINUM ACCESS ACTIVE");
  assert.equal(designation("all_access")?.truth, "PropBetEdge All Access · 10 sports + Predictions");
  assert.equal(PLATINUM_TRUTH, "PropBetEdge All Access · 10 sports + Predictions");
  assert.equal(badgeLabel("sport_pro"), "UFC PRO MEMBER");
  assert.equal(badgeLabel("owner"), "VERIFIED OWNER");
  assert.equal(badgeLabel("free"), null, "a non-member is never labelled FREE");
  for (const s of STATES) assert.doesNotMatch(JSON.stringify(designation(s)), /Platinum plan|PLATINUM PLAN/i);
});

test("view machine: an unreachable ledger with a known account is the access check, never sales or signed out", () => {
  const free = { state: "free" as const };
  assert.equal(accountView({ signedIn: false, pro: false, ledger: "skipped", membership: free, hasAccount: false }), "signed_out");
  assert.equal(accountView({ signedIn: false, pro: false, ledger: "unavailable", membership: free, hasAccount: true }), "check");
  assert.equal(accountView({ signedIn: false, pro: false, ledger: "unavailable", membership: free, hasAccount: false }), "signed_out", "no account cookie: nothing to protect");
  assert.equal(accountView({ signedIn: true, pro: false, ledger: "unavailable", membership: free, hasAccount: true }), "check");
  assert.equal(accountView({ signedIn: true, pro: false, ledger: "ok", membership: free, hasAccount: true }), "signed_in");
  assert.equal(accountView({ signedIn: true, pro: true, ledger: "ok", membership: { state: "sport_pro" }, hasAccount: true }), "sport_pro");
  assert.equal(accountView({ signedIn: true, pro: true, ledger: "skipped", membership: { state: "all_access" }, hasAccount: false }), "all_access");
  assert.equal(accountView({ signedIn: true, pro: true, ledger: "ok", membership: { state: "owner" }, hasAccount: true }), "owner");
});

test("member links stay on the UFC site", () => {
  assert.equal(memberHref("all_access"), "/all-access");
  assert.equal(memberHref("owner", "network"), "/all-access", "network sessions have no UFC account row");
  assert.equal(memberHref("sport_pro", "stripe"), "/account");
  assert.equal(memberHref("owner", "owner"), "/account");
});

test("/all-access is a real local page: indexable, self-canonical, no redirect constructs", () => {
  const page = read("app/all-access/page.tsx");
  const view = strip(read("components/AllAccessView.tsx"));
  assert.match(page, /alternates: \{ canonical: LOCAL_ALL_ACCESS_PATH \}/);
  assert.doesNotMatch(page, /robots:\s*\{\s*index:\s*false/);
  for (const src of [page, view]) assert.doesNotMatch(strip(src), /redirect\(|permanentRedirect\(|window\.location|http-equiv|<iframe|propbetedge\.ai\/pro/);
  assert.doesNotMatch(read("next.config.ts").replace(/\/\*[\s\S]*?\*\//g, ""), /all-access/, "no config redirect or rewrite for /all-access");
});

test("/all-access: only the explicit purchase CTA reaches Stripe, and never for Platinum or owner", () => {
  const view = strip(read("components/AllAccessView.tsx"));
  assert.equal((view.match(/href=\{checkout\}/g) || []).length, 2, "Get All Access (prospect) and Upgrade to All Access (UFC Pro) only");
  const memberBranch = view.slice(view.indexOf('{(view === "all_access" || view === "owner") && ('), view.indexOf("</section>") > 0 ? view.indexOf('<section className="aap-section"') : undefined);
  assert.doesNotMatch(memberBranch, /href=\{checkout\}|ALL_ACCESS_CHECKOUT_URL|buy\.stripe|Get All Access|Upgrade to All Access/i, "Platinum and owner see no purchase CTA");
  assert.match(memberBranch, /<NetworkLauncher/);
  assert.match(memberBranch, /<MemberActions/);
});

test("/all-access network comes from the vendored family registry: 10 sports + Predictions, never an 11th sport", () => {
  const sports = (family as { sports: Array<{ key: string }> }).sports.map((s) => s.key);
  assert.deepEqual(sports, ["mlb", "nfl", "nba", "wnba", "nhl", "ufc", "tennis", "soccer", "golf", "f1"]);
  assert.equal((family as { products: Array<{ key: string }> }).products.some((p) => p.key === "predictions"), true);
  const view = read("components/AllAccessView.tsx");
  assert.match(view, /const SPORTS = \(family as \{ sports: Entry\[\] \}\)\.sports;/);
  assert.match(view, /\.products\.find\(\(p\) => p\.key === "predictions"\)/);
  assert.match(view, /YOU ARE HERE/);
  assert.match(view, /F1 Intelligence/);
  assert.doesNotMatch(view, /11 sports|eleven sports/i);
});

test("informational All Access links point at the local page; footer, hero and header included", () => {
  const shell = read("components/Shell.tsx");
  assert.doesNotMatch(shell, /ALL_ACCESS_URL/);
  assert.equal((shell.match(/href=\{LOCAL_ALL_ACCESS_PATH\}/g) || []).length, 2);
  const membership = read("components/Membership.tsx");
  assert.doesNotMatch(membership.replace(/import[^;]+;/g, ""), /ALL_ACCESS_URL/);
  assert.match(read("lib/allAccessHero.ts"), /learnUrl: LOCAL_ALL_ACCESS_PATH/);
});

test("capability grid lists only surfaces the UFC paywall actually gates (plus graded history)", () => {
  assert.deepEqual(UFC_CAPABILITIES.map((c) => c.href), ["/fighters", "/fight-week", "/algo", "/algo/card", "/simulator", "/events", "/news", "/algo/record"]);
  for (const c of UFC_CAPABILITIES) assert.ok(c.href.startsWith("/") && !c.href.startsWith("//"), c.key);
});

test("account and login shells: no FREE label, outage never bounces to sign-in", () => {
  const acct = read("app/account/page.tsx");
  assert.doesNotMatch(acct, />Free<|"Free"/);
  assert.match(acct, /if \(view === "signed_out"\) redirect\("\/login\?next=\/account"\);/);
  assert.match(read("app/login/page.tsx"), /if \(access\.signedIn \|\| \(account && access\.ledger === "unavailable"\)\) redirect\("\/account"\);/);
});
