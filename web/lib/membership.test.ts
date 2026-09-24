/* The shared PropBetEdge membership contract, as UFC applies it.
 *
 * Four states, four labels, derived server-side from the billing verdict's
 * access_source and nothing else. Plan names and prices never decide the
 * state; the browser receives only the browser-safe object. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_ACCESS_OFFER, ALL_ACCESS_URL, CONTRACT_VERSION, MANAGE_URL, NETWORK, STATES,
  deriveMembership, membershipLabel, planText, readMembership, allAccessCardHtml, manageLinkHtml, membershipBadgeHtml,
} from "./pbe-membership.js";
import { decideUfcAccess, FREE_SIGNED_OUT, type AccountInput, type LedgerRead } from "./accessDecision.ts";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

const OWNER = "owner@propbetedge.example";
const future = "2026-10-14T12:00:00Z";
const past = "2026-09-01T12:00:00Z";
const account = (over: Partial<AccountInput> = {}): AccountInput => ({ email: "fan@example.com", role: "member", plan: "free", unlimited: false, access_expires_at: null, ...over });
const ownerRow = () => account({ email: OWNER, role: "owner", plan: "owner", unlimited: true });
const verdict = (over: Partial<Extract<LedgerRead, { state: "ok" }>> & { plan?: string | null; status?: string; product_key?: string | null } = {}): LedgerRead => {
  const { plan = "monthly", status = "active", product_key = "ufc_pro", entitled = true, accessSource = "sport", ...rest } = over;
  return { state: "ok", entitled, accessSource, subscription: { plan, status, product_key, current_period_end: entitled ? future : past, cancel_at_period_end: false }, ...rest };
};

/* ---- the contract itself ---------------------------------------------- */

test("contract: version, states and the four labels exactly", () => {
  assert.equal(CONTRACT_VERSION, "1.1.0");
  assert.deepEqual([...STATES], ["free", "sport_pro", "all_access", "owner"]);
  assert.equal(membershipLabel("free", "ufc"), "FREE");
  assert.equal(membershipLabel("sport_pro", "ufc"), "UFC PRO ACTIVE");
  assert.equal(membershipLabel("all_access", "ufc"), "ALL ACCESS ACTIVE");
  assert.equal(membershipLabel("owner", "ufc"), "OWNER");
});

test("contract: the copy of pbe-membership.js and .css is byte-identical to the canonical source when it is present", () => {
  for (const [local, canonical] of [["lib/pbe-membership.js", "shared/membership/pbe-membership.js"], ["app/pbe-membership.css", "shared/membership/pbe-membership.css"]]) {
    let src: string | null = null;
    try { src = readFileSync(join(WEB, "..", "..", "propbetedge-workers", canonical), "utf8"); } catch { /* other repo not checked out here */ }
    if (src != null) assert.equal(read(local), src, `${local} drifted from ${canonical}`);
  }
});

test("contract: All Access commercial facts and links are the shared ones", () => {
  assert.equal(ALL_ACCESS_OFFER.price, "$29/month");
  assert.equal(ALL_ACCESS_OFFER.tagline, "Every current and future PropBetEdge Pro sport.");
  assert.equal(ALL_ACCESS_OFFER.promoLine, "25% off while active with code THEEDGE25");
  assert.equal(ALL_ACCESS_OFFER.checkoutUrl, "https://buy.stripe.com/8x2eVdgmOaqy4pv8Ez7wA0N");
  assert.equal(ALL_ACCESS_URL, "https://propbetedge.ai/pro");
  assert.equal(MANAGE_URL, "https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00");
  assert.deepEqual(NETWORK.map((s) => s.key), ["mlb", "nfl", "nba", "nhl", "wnba", "ufc"]);
});

/* ---- deriving the UFC state from the verdict ------------------------------ */

test("access_source drives the state, never the plan: plan 'monthly' with access_source 'all_access' is ALL ACCESS", () => {
  const a = decideUfcAccess(account(), verdict({ plan: "monthly", accessSource: "all_access", product_key: "pbe_all_access" }), OWNER);
  assert.equal(a.pro, true);
  assert.equal(a.membership.state, "all_access");
  assert.equal(a.membership.label, "ALL ACCESS ACTIVE");
  assert.equal(a.membership.access_source, "all_access");
  assert.equal(a.membership.product_key, "pbe_all_access");
  assert.equal(a.membership.plan, "monthly");
  assert.deepEqual([a.membership.show_purchase_cta, a.membership.show_all_access_upgrade, a.membership.show_manage], [false, false, true]);
});

test("sport_pro: a ufc_pro grant (monthly or weekly) is UFC PRO ACTIVE with manage + upgrade", () => {
  for (const plan of ["monthly", "weekly"]) {
    const a = decideUfcAccess(account(), verdict({ plan, accessSource: "sport" }), OWNER);
    assert.equal(a.membership.state, "sport_pro", plan);
    assert.equal(a.membership.label, "UFC PRO ACTIVE");
    assert.equal(a.membership.plan, plan);
    assert.equal(a.membership.email, "fan@example.com");
    assert.equal(a.membership.current_period_end, future);
    assert.deepEqual([a.membership.show_purchase_cta, a.membership.show_all_access_upgrade, a.membership.show_manage], [false, true, true]);
    assert.equal(planText(a.membership), `UFC Pro · ${plan}`);
  }
});

test("a verdict without access_source (older ledger) that is entitled is the sport's own plan", () => {
  const a = decideUfcAccess(account(), { state: "ok", entitled: true, subscription: { plan: "monthly", status: "active", current_period_end: future, cancel_at_period_end: false } }, OWNER);
  assert.equal(a.membership.state, "sport_pro");
});

test("owner: the canonical owner path is access_source 'owner' → OWNER, no purchase CTA, no manage link, whatever the ledger says", () => {
  for (const ledger of [{ state: "skipped" } as LedgerRead, { state: "unavailable" } as LedgerRead, verdict({ entitled: false, status: "canceled" }), verdict({ accessSource: "all_access" })]) {
    const a = decideUfcAccess(ownerRow(), ledger, OWNER);
    assert.equal(a.tier, "owner");
    assert.equal(a.membership.state, "owner");
    assert.equal(a.membership.label, "OWNER");
    assert.equal(a.membership.access_source, "owner");
    assert.deepEqual([a.membership.show_purchase_cta, a.membership.show_all_access_upgrade, a.membership.show_manage], [false, false, false]);
    assert.equal(planText(a.membership), "Owner access");
  }
});

test("free: canceled / expired / past_due / unpaid verdicts (entitled:false) are FREE with a purchase CTA and no manage link", () => {
  for (const status of ["canceled", "past_due", "unpaid", "incomplete"]) {
    for (const accessSource of ["sport", "all_access", null] as const) {
      const a = decideUfcAccess(account(), verdict({ entitled: false, status, accessSource }), OWNER);
      assert.equal(a.pro, false, status);
      assert.equal(a.membership.state, "free", `${status}/${accessSource}`);
      assert.equal(a.membership.label, "FREE");
      assert.equal(a.membership.access_source, null, "a lapsed grant reveals no source");
      assert.equal(a.membership.plan, null);
      assert.deepEqual([a.membership.show_purchase_cta, a.membership.show_all_access_upgrade, a.membership.show_manage], [true, false, false]);
      assert.equal(planText(a.membership), "");
    }
  }
  assert.equal(FREE_SIGNED_OUT.membership.state, "free");
  assert.equal(decideUfcAccess(null, verdict(), OWNER).membership.label, "FREE");
  assert.equal(decideUfcAccess(account(), { state: "unavailable" }, OWNER).membership.state, "free", "billing outage fails closed to FREE");
});

test("all_access / owner never see a purchase CTA or the All Access card; free and sport_pro do", () => {
  const free = deriveMembership({ sport: "ufc", entitled: false });
  const sport = deriveMembership({ sport: "ufc", entitled: true, accessSource: "sport" });
  const all = deriveMembership({ sport: "ufc", entitled: true, accessSource: "all_access" });
  const owner = deriveMembership({ sport: "ufc", entitled: true, accessSource: "owner" });
  assert.match(allAccessCardHtml(free), /All Access<\/h3>/);
  assert.match(allAccessCardHtml(sport), /Upgrade to All Access<\/h3>/);
  assert.equal(allAccessCardHtml(all), "");
  assert.equal(allAccessCardHtml(owner), "");
  assert.equal(manageLinkHtml(free), "");
  assert.match(manageLinkHtml(sport), /pbe-mbr-manage/);
  assert.match(manageLinkHtml(all), /pbe-mbr-manage/);
  assert.equal(manageLinkHtml(owner), "");
  assert.match(membershipBadgeHtml(all), /class="pbe-mbr-badge is-all_access"[^>]*>ALL ACCESS ACTIVE</);
  assert.equal(planText(all), "All Access · every PropBetEdge sport");
});

test("browser side never widens access: a malformed or self-asserted object reads as FREE", () => {
  assert.equal(readMembership({ state: "all_access", entitled: false }, "ufc").state, "free");
  assert.equal(readMembership({ state: "owner" }, "ufc").state, "free");
  assert.equal(readMembership("all_access", "ufc").state, "free");
  const all = deriveMembership({ sport: "ufc", entitled: true, accessSource: "all_access", email: "b@example.com" });
  assert.deepEqual(readMembership(all, "ufc"), all);
});

/* ---- pass-through and surfaces ------------------------------------------ */

test("entitlement read keeps access_source and subscription.product_key and still checks product_key === ufc_pro", () => {
  const src = read("lib/entitlement.ts");
  assert.match(src, /body\.product_key !== PRODUCT_KEY/);
  assert.match(src, /body\.access_source === "sport" \|\| body\.access_source === "all_access" \|\| body\.access_source === "owner"/);
  assert.match(src, /subscription\.product_key/);
  assert.match(src, /return \{ state: "ok", entitled: body\.entitled, accessSource, subscription \}/);
});

test("the session route returns the browser-safe membership object and nothing ledger-internal", () => {
  const src = read("app/api/auth/session/route.ts");
  assert.match(src, /membership: access\.membership/);
  assert.doesNotMatch(src, /stripe|webhook|ledger_id|service_role/i);
  /* The object itself carries no secrets: exactly the contract's keys. */
  const keys = Object.keys(deriveMembership({ sport: "ufc", entitled: true, accessSource: "all_access" })).sort();
  assert.deepEqual(keys, ["access_source", "cancel_at_period_end", "contract", "current_period_end", "email", "entitled", "label", "legacy_tier", "manage_url", "network_url", "plan", "product_key", "show_all_access_upgrade", "show_manage", "show_purchase_cta", "sport", "state", "sublabel"]);
});

test("UI reads the derived flags, never re-derives from plan names or prices", () => {
  const shell = read("components/Shell.tsx");
  assert.match(shell, /<MembershipBadge m=\{access\.membership\} href="\/account"/);
  assert.equal((shell.match(/access\.membership\.show_purchase_cta && <Link href="\/pro" className="btn gold">Go Pro<\/Link>/g) || []).length, 2, "header and drawer both gate Go Pro on show_purchase_cta");
  assert.doesNotMatch(shell, /access\.tier === "owner" \? "Owner" : access\.pro \? "Pro"/);
  /* Owner decision: the header and drawer carry no All Access item; the footer does. */
  assert.doesNotMatch(shell, /hdr-aa|mnav-aa|data-ufc-all-access="nav/);
  assert.match(shell, /data-ufc-footer-all-access=""/);
  assert.match(shell, /data-ufc-footer-all-access-included=""/);
  assert.doesNotMatch(read("lib/site.ts"), /place: "network"/);
  const acct = read("app/account/page.tsx");
  assert.match(acct, /<MembershipBadge m=\{m\} className="account-plan" \/>/);
  assert.match(acct, /m\.show_purchase_cta && <Link href="\/pro"/);
  /* All Access first (lib/allAccessHero.test.ts pins the order and the copy):
   * the account page offers UFC Pro members the UPGRADE TO ALL ACCESS hero. */
  assert.match(acct, /m\.show_all_access_upgrade && <div className="mt-5"><AllAccessHero m=\{m\} variant="panel" email=\{m\.email\} \/><\/div>/);
  assert.match(acct, /<NetworkRow current="ufc" \/>/);
  assert.match(acct, /planText\(m\)/);
  const plans = read("components/ui.tsx");
  assert.match(plans, /membership\.state === "all_access" \|\| membership\.state === "owner"/);
  assert.match(plans, /<AllAccessHero m=\{membership\} variant="surface" email=\{email\} \/>/);
  assert.match(plans, /membership\.state === "sport_pro" && <div className="pro-offer-aa mt-4"><AllAccessHero m=\{membership\} variant="panel"/);
  const pro = read("app/pro/page.tsx");
  assert.match(pro, /<ProPlans email=\{account\?\.email \?\? null\} membership=\{membership\} \/>/);
  assert.match(pro, /<MembershipBadge m=\{membership\} className="account-plan" \/>/);
  assert.match(read("app/page.tsx"), /<ProPlans membership=\{access\.membership\} \/>/);
  assert.match(read("app/layout.tsx"), /import "\.\/pbe-membership\.css";/);
  /* House promo: readerPro is the server decision, so All Access members (pro) are never sold UFC Pro. */
  assert.match(read("components/StoryView.tsx"), /readerPro: access\.pro/);
  /* Fight Week rail sells UFC Pro, by its own name, only inside the locked branch. */
  const fw = read("components/FightWeek.tsx");
  assert.match(fw, /\{locked && \(\s*<section className="fw-rail-card fw-rail-pro"[^]*?<div className="fw-h">UFC Pro<\/div>/);
  assert.doesNotMatch(fw, /PBE Pro/);
});

test("no Stripe state words or sport-only language on member surfaces", () => {
  for (const f of ["components/Membership.tsx", "components/Shell.tsx", "app/account/page.tsx", "app/pro/page.tsx", "components/ui.tsx"]) {
    const src = read(f);
    assert.doesNotMatch(src, /Stripe subscription active|verified against Stripe|separate from other sports/i, f);
    assert.doesNotMatch(src, /"STRIPE"|>Stripe</, `${f} renders Stripe as a state word`);
  }
});
