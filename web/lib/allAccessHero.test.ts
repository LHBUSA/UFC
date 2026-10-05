/* PropBetEdge "All Access first" commercial hierarchy, as UFC applies it.
 *
 *   FREE        ALL ACCESS hero -> "ONLY WANT UFC?" -> UFC Pro plan (unchanged prices/links)
 *   UFC PRO     member panel + UPGRADE TO ALL ACCESS hero, no UFC purchase
 *   ALL ACCESS  no hero, no CTA, no Stripe link
 *   OWNER       no hero, no CTA, no Stripe link
 *
 * Three layers are pinned: the pure decision (lib/allAccessHero.ts), the
 * rendered HTML of the hero / seam / mini entry (react-dom/server through the
 * SWC hooks in scripts/test-tsx-hooks.mjs) and the source order of every
 * surface that mounts them (ui.tsx, ProPreview, FightWeek, account, pro,
 * Shell nav + footer). */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_ACCESS_OFFER, ALL_ACCESS_URL, deriveMembership, type Membership } from "./pbe-membership.js";
import { LOCAL_ALL_ACCESS_PATH } from "./accountSurface.ts";
import { ALL_ACCESS_BADGE, ALL_ACCESS_CAPABILITIES, ALL_ACCESS_DIVIDER, ALL_ACCESS_PREDICTIONS, ALL_ACCESS_SPORTS, ALL_ACCESS_SPORTS_LINE, ALL_ACCESS_SPORT_COUNT, ALL_ACCESS_VALUE_LINE, allAccessHeroModel, promoParts, shouldRenderAllAccessHero } from "./allAccessHero.ts";
import { NAV } from "./site.ts";

register("../scripts/test-tsx-hooks.mjs", import.meta.url);

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");
const STRIPE_ALL_ACCESS = "https://buy.stripe.com/8x2eVdgmOaqy4pv8Ez7wA0N";
/* Owner 2026-10-05: WHAT'S INCLUDED stays on the sport site (native /all-access). */
const LEARN = "/all-access";

const free = deriveMembership({ sport: "ufc", entitled: false });
const sportPro = deriveMembership({ sport: "ufc", entitled: true, accessSource: "sport", plan: "monthly", email: "pro@example.com" });
const allAccess = deriveMembership({ sport: "ufc", entitled: true, accessSource: "all_access", email: "aa@example.com" });
const owner = deriveMembership({ sport: "ufc", entitled: true, accessSource: "owner", email: "owner@example.com" });

/* ---- the decision ------------------------------------------------------- */

test("model: free gets ALL ACCESS, UFC Pro gets UPGRADE TO ALL ACCESS, All Access and owner get nothing", () => {
  const f = allAccessHeroModel(free)!;
  assert.equal(f.title, "ALL ACCESS");
  assert.equal(f.upgrade, false);
  const s = allAccessHeroModel(sportPro)!;
  assert.equal(s.title, "UPGRADE TO ALL ACCESS");
  assert.equal(s.upgrade, true);
  assert.equal(allAccessHeroModel(allAccess), null);
  assert.equal(allAccessHeroModel(owner), null);
  assert.equal(allAccessHeroModel(null)!.title, "ALL ACCESS", "no membership object reads as FREE");
  assert.equal(allAccessHeroModel(undefined)!.state, "free");
  assert.equal(allAccessHeroModel({ ...free, state: "bogus" } as unknown as Membership)!.state, "free", "an unknown state never widens");
  assert.deepEqual([free, sportPro, allAccess, owner].map(shouldRenderAllAccessHero), [true, true, false, false]);
});

test("model: every commercial fact is the shared contract's, verbatim", () => {
  const m = allAccessHeroModel(free)!;
  assert.equal(m.checkoutUrl, STRIPE_ALL_ACCESS);
  assert.equal(m.checkoutUrl, ALL_ACCESS_OFFER.checkoutUrl);
  assert.equal(m.learnUrl, LEARN);
  assert.equal(m.learnUrl, LOCAL_ALL_ACCESS_PATH);
  assert.notEqual(m.learnUrl, ALL_ACCESS_URL, "informational All Access links never leave the sport site");
  assert.equal(m.price, "$29/month");
  assert.deepEqual([m.amount, m.cadence], ["$29", "month"]);
  assert.equal(m.promoCode, "THEEDGE25");
  assert.equal(m.promoLine, "25% off while active with code THEEDGE25");
  assert.deepEqual(promoParts(m), { before: "25% off while active with code ", code: "THEEDGE25", after: "" });
  assert.equal(m.eyebrow, "PROPBETEDGE NETWORK");
  assert.equal(m.badge, "BEST VALUE · MOST COMPLETE");
  assert.equal(ALL_ACCESS_BADGE, m.badge);
  assert.equal(ALL_ACCESS_DIVIDER, "ONLY WANT UFC?");
  assert.deepEqual([m.ctaLabel, m.learnLabel], ["GET ALL ACCESS", "WHAT'S INCLUDED"]);
});

/* ---- the current network offer (owner brief 2026-10-05) ------------------- */

const family = JSON.parse(readFileSync(join(WEB, "lib", "family.json"), "utf8")) as { sports: Array<{ key: string }>; products: Array<{ key: string; name: string }> };

test("offer: $29/month, exactly 10 sports incl. Golf and F1 Intelligence, Predictions included but never counted as a sport", () => {
  const m = allAccessHeroModel(free)!;
  assert.equal(m.price, "$29/month");                                                   // 1
  assert.equal(ALL_ACCESS_SPORT_COUNT, 10);                                            // 2
  assert.equal(m.sports.length, 10);
  assert.deepEqual(ALL_ACCESS_SPORTS.map((s) => s.key), family.sports.map((s) => s.key), "sports come from the vendored family registry, in order");
  assert.ok(ALL_ACCESS_SPORTS.some((s) => s.key === "golf" && s.label === "Golf"));     // 3
  assert.ok(ALL_ACCESS_SPORTS.some((s) => s.key === "f1" && s.label === "F1 Intelligence")); // 4
  assert.equal(ALL_ACCESS_PREDICTIONS.name, "PropBetEdge Predictions");                  // 5
  assert.equal(m.predictions.name, "PropBetEdge Predictions");
  assert.ok(family.products.some((p) => p.key === "predictions"));
  assert.ok(!ALL_ACCESS_SPORTS.some((s) => s.key === "predictions" || /predictions/i.test(s.label)), "Predictions is not a sport"); // 6
  assert.equal(ALL_ACCESS_VALUE_LINE, "10 sports + PropBetEdge Predictions.");          // 7
  assert.equal(m.valueLine, ALL_ACCESS_VALUE_LINE);
  assert.equal(ALL_ACCESS_SPORTS_LINE, "MLB · NFL · NBA · WNBA · NHL · UFC · Tennis · Soccer · Golf · F1 Intelligence");
  assert.equal(allAccessHeroModel(sportPro)!.title, "UPGRADE TO ALL ACCESS");          // 8
  assert.equal(allAccessHeroModel(allAccess), null);                                    // 9
  assert.equal(allAccessHeroModel(owner), null);                                        // 10
  assert.equal(m.checkoutUrl, ALL_ACCESS_OFFER.checkoutUrl);                            // 11
  assert.equal(m.promoCode, "THEEDGE25");                                               // 12
  assert.equal(m.promoLine, ALL_ACCESS_OFFER.promoLine);
  assert.equal(m.promoLine, "25% off while active with code THEEDGE25");
  assert.ok(ALL_ACCESS_CAPABILITIES.length >= 6 && ALL_ACCESS_CAPABILITIES.every((c) => !/predictions/i.test(c.name)), "capabilities are features, Predictions has its own block");
});

test("no customer-facing UFC source still carries the stale eight-sport offer", () => {
  const files = ["components/Membership.tsx", "lib/allAccessHero.ts", "app/pro/page.tsx", "app/account/page.tsx", "components/ProPreview.tsx", "components/ui.tsx", "components/FightWeek.tsx", "components/Shell.tsx"];
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /MLB · NFL · NBA · NHL · WNBA · UFC · Tennis · Soccer(?! ·)/, `${f}: stale sport list`);
    assert.doesNotMatch(src, /every Pro sport →|plus every Pro sport added next|11 sports/, `${f}: stale or wrong offer copy`);
  }
});

test("active All Access account: navigation line, never an upsell; others get nothing from it", async () => {
  const { M, html } = await render();
  assert.equal(html(M.AllAccessActive, { m: allAccess }), '<p class="ufc-aa-active" data-ufc-all-access="active"><b>◆ PLATINUM MEMBER</b><span>PropBetEdge All Access · active · 10 sports + Predictions included</span></p>');
  for (const m of [free, sportPro, owner]) assert.equal(html(M.AllAccessActive, { m }), "", m.state);
  assert.doesNotMatch(html(M.AllAccessActive, { m: allAccess }), /buy\.stripe|GET ALL ACCESS/);
  assert.match(read("app/account/page.tsx"), /<AllAccessActive m=\{m\} \/>/);
});

/* ---- rendered HTML (react-dom/server) ------------------------------------ */

async function render() {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const M = await import("../components/Membership.tsx");
  const html = (type: unknown, props: Record<string, unknown>) => renderToStaticMarkup(createElement(type as never, props as never));
  return { M, html };
}

test("hero HTML (free): identity, $29/month, THEEDGE25 chip, exact Stripe checkout, WHAT'S INCLUDED, no Labs", async () => {
  const { M, html } = await render();
  const out = html(M.AllAccessHero, { m: free });
  assert.match(out, /^<aside class="ufc-aa-hero is-surface" aria-label="PropBetEdge All Access" data-ufc-all-access="hero" data-ufc-all-access-state="free">/);
  assert.match(out, /<span class="ufc-aa-eyebrow">PROPBETEDGE NETWORK<\/span>/);
  assert.match(out, /<span class="ufc-aa-badge">BEST VALUE · MOST COMPLETE<\/span>/);
  assert.match(out, /<h3 class="ufc-aa-title">ALL ACCESS<\/h3>/);
  assert.match(out, /<span class="ufc-aa-price" aria-label="\$29\/month"><strong>\$29<\/strong>\/month<\/span>/);
  assert.match(out, /<p class="ufc-aa-value">10 sports \+ PropBetEdge Predictions\.<\/p>/);
  assert.match(out, /<p class="ufc-aa-secondary">One membership across the PropBetEdge intelligence network\.<\/p>/);
  assert.equal((out.match(/<li[^>]*data-sport="/g) || []).length, 10, "ten sport chips");
  assert.match(out, /data-sport="golf">Golf<\/li>/);
  assert.match(out, /data-sport="f1">F1 Intelligence<\/li>/);
  assert.match(out, /data-ufc-all-access-group="intelligence"[^]*?<a class="ufc-aa-predictions" href="https:\/\/predictions\.propbetedge\.ai\/"[^]*?PropBetEdge Predictions<\/b><span>Independent, source-backed forecasts/);
  assert.doesNotMatch(out, /data-sport="predictions"/, "Predictions is not a sport chip");
  assert.doesNotMatch(out, /free|11 sports|eleven sports|Boxing/i, "no FREE Predictions, no 11 sports, no unreleased sport");
  assert.match(out, /Where supported — features vary by sport\./);
  assert.match(out, /Future PropBetEdge Pro sports join All Access at launch\./);
  assert.doesNotMatch(out, /MLB · NFL · NBA · NHL · WNBA · UFC · Tennis · Soccer(?! ·)/, "the stale eight-sport list is gone");
  assert.match(out, /<p class="ufc-aa-promo">Launch offer: 25% off while active with code <b class="ufc-aa-code">THEEDGE25<\/b><\/p>/);
  assert.match(out, new RegExp(`<a class="ufc-aa-cta" href="${STRIPE_ALL_ACCESS.replace(/[.\/]/g, "\\$&")}" rel="noopener" data-pbe-placement="all_access_checkout" data-ufc-all-access-cta="checkout">GET ALL ACCESS</a>`));
  assert.match(out, /<a class="ufc-aa-learn" data-ufc-all-access-cta="learn" href="\/all-access">WHAT(&#x27;|')S INCLUDED<\/a>/);
  assert.doesNotMatch(out, /Labs|computational/i);
  assert.equal((out.match(/buy\.stripe\.com/g) || []).length, 1, "exactly one Stripe link, the All Access one");
  /* the signed-in email rides along so the grant lands on the reader's account */
  assert.match(html(M.AllAccessHero, { m: free, email: "fan@example.com" }), new RegExp(`href="${STRIPE_ALL_ACCESS.replace(/[.\/]/g, "\\$&")}\\?prefilled_email=fan%40example\\.com"`));
  assert.match(html(M.AllAccessHero, { m: free, variant: "home" }), /class="ufc-aa-hero is-home"/);
});

test("hero HTML (sport_pro): UPGRADE TO ALL ACCESS with the same exact checkout; nothing UFC is sold", async () => {
  const { M, html } = await render();
  const out = html(M.AllAccessHero, { m: sportPro, variant: "panel", email: sportPro.email });
  assert.match(out, /class="ufc-aa-hero is-panel is-upgrade"[^>]*data-ufc-all-access-state="sport_pro"/);
  assert.match(out, /<h3 class="ufc-aa-title">UPGRADE TO ALL ACCESS<\/h3>/);
  assert.match(out, /<p class="ufc-aa-secondary">Add the entire PropBetEdge network — 10 sports plus PropBetEdge Predictions — under one membership\.<\/p>/);
  assert.match(out, /<li class="is-owned" data-sport="ufc">UFC<small> · yours<\/small><\/li>/, "UFC is marked as already owned, not sold back");
  assert.equal((out.match(/class="is-owned"/g) || []).length, 1);
  assert.match(out, /THEEDGE25/);
  assert.match(out, /href="https:\/\/buy\.stripe\.com\/8x2eVdgmOaqy4pv8Ez7wA0N\?prefilled_email=pro%40example\.com"/);
  assert.doesNotMatch(out, /\$9\.99|\$3\.99|Unlock PBE Picks|Unlock UFC Pro/);
});

test("hero / divider / mini HTML (all_access, owner): nothing renders — no CTA, no Stripe link", async () => {
  const { M, html } = await render();
  for (const m of [allAccess, owner]) {
    assert.equal(html(M.AllAccessHero, { m }), "", m.state);
    assert.equal(html(M.AllAccessHero, { m, variant: "panel", email: m.email }), "", m.state);
    assert.equal(html(M.AllAccessMini, { m }), "", m.state);
  }
  /* the seam is inert markup; it is only ever mounted next to a rendered hero */
  assert.equal(html(M.AllAccessDivider, {}), '<div class="ufc-aa-divider" role="separator" aria-label="ONLY WANT UFC?" data-ufc-all-access="divider"><span>ONLY WANT UFC?</span></div>');
});

test("mini HTML: one gold line, the canonical Stripe checkout (owner link policy), the price", async () => {
  const { M, html } = await render();
  const out = html(M.AllAccessMini, { className: "fw-rail-aa" });
  assert.equal(out, `<a class="ufc-aa-mini fw-rail-aa" href="${STRIPE_ALL_ACCESS}" rel="noopener" data-pbe-placement="all_access_checkout" data-ufc-all-access="mini"><span>ALL ACCESS</span><b>$29/month</b><i>10 sports + Predictions →</i></a>`);
  assert.match(html(M.AllAccessMini, { m: sportPro }), /<span>UPGRADE TO ALL ACCESS<\/span>/);
});

/* ---- surfaces: source order ------------------------------------------------ */

test("ProPlans (ui.tsx): hero -> ONLY WANT UFC? -> UFC Pro plan -> $0 card, in that source order, for FREE", () => {
  const src = read("components/ui.tsx");
  const body = src.slice(src.indexOf("export function ProPlans("));
  const at = (s: string) => { const i = body.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };
  const memberBranch = at('membership.state === "all_access" || membership.state === "owner" || membership.state === "sport_pro"');
  const freeSurface = at('data-ufc-purchase-surface="free"');
  const hero = at('<AllAccessHero m={membership} variant="surface" email={email} />');
  const divider = at("<AllAccessDivider />");
  const proPlan = at('data-ufc-plan="ufc_pro"');
  const freePlan = at('data-ufc-plan="free"');
  const proCheckout = at("<a href={checkout(monthly.checkoutUrl)}");
  assert.ok(memberBranch < freeSurface && freeSurface < hero && hero < divider && divider < proPlan && proPlan < proCheckout && proCheckout < freePlan, "All Access first, then the seam, then UFC Pro, then Free");
  /* the UFC plan is untouched: same offer object, same checkout URLs, same displays */
  assert.match(body, /<a href=\{checkout\(monthly\.checkoutUrl\)\} className="btn gold" data-plan="monthly">Unlock PBE Picks · \{monthly\.display\}\/mo<\/a>/);
  assert.match(body, /<a href=\{checkout\(weekly\.checkoutUrl\)\} className="btn" data-plan="weekly">Fight Week · \{weekly\.display\}\/wk<\/a>/);
  /* "Best value" belongs to All Access: no UFC plan renders the monthly badge */
  assert.doesNotMatch(body, /\{monthly\.badge\}|Best value|BEST VALUE/i);
  assert.match(body, /<span className="plan-badge">UFC ONLY<\/span>/);
  /* UFC Pro members: member panel + the upgrade hero, never a UFC checkout */
  const member = body.slice(memberBranch, freeSurface);
  assert.match(member, /<MembershipBadge m=\{membership\} \/>/);
  assert.match(member, /membership\.state === "sport_pro" && <div className="pro-offer-aa mt-4"><AllAccessHero m=\{membership\} variant="panel" email=\{email \?\? membership\.email\} \/><\/div>/);
  assert.doesNotMatch(member, /checkoutUrl|buy\.stripe/);
  /* the legacy contract card is no longer mounted on the purchase surface */
  assert.doesNotMatch(src, /<AllAccessCard/);
});

test("every page that mounts a purchase surface leads with All Access", () => {
  const pro = read("app/pro/page.tsx");
  assert.match(pro, /<ProPlans email=\{account\?\.email \?\? null\} membership=\{membership\} \/>\}\s*\{\/\*[^]*?\*\/\}\s*\{active && <div className="mt-4"><AllAccessHero m=\{membership\} variant="panel" email=\{account\?\.email \?\? null\} \/><\/div>\}/);
  assert.match(read("app/page.tsx"), /<ProPlans membership=\{access\.membership\} \/>/);
  assert.match(read("app/account/page.tsx"), /view === "sport_pro" && m\.show_all_access_upgrade && <NetworkExpansion \/>/);
  /* locked-module preview: the mini entry precedes the single-sport unlock */
  const preview = read("components/ProPreview.tsx");
  assert.ok(preview.indexOf("<AllAccessMini />") < preview.indexOf('className="btn gold pro-preview-cta">Unlock UFC Pro'), "ProPreview: All Access before Unlock UFC Pro");
  /* fight-week rail: inside the locked branch, before Go Pro */
  const fw = read("components/FightWeek.tsx");
  const locked = fw.slice(fw.indexOf("{locked && ("), fw.indexOf("Go Pro <span"));
  assert.match(locked, /<AllAccessMini className="fw-rail-aa" \/>/);
  assert.match(read("app/layout.tsx"), /import "\.\/all-access\.css";/);
  assert.match(read("app/all-access.css"), /\.ufc-aa-hero \{/);
});

test("purchase surfaces are inline: no nested scroll container wraps them", () => {
  for (const f of ["app/all-access.css", "app/pro-gate.css", "app/pbe-membership.css"]) {
    const css = read(f);
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, sel, body] = m;
      if (!/pro-offer|ufc-aa|plans|\.plan\b|pro-preview/.test(sel)) continue;
      assert.doesNotMatch(body, /overflow(-y)?\s*:\s*(auto|scroll)/, `${f}: ${sel.trim()} scrolls internally`);
      assert.doesNotMatch(body, /max-height\s*:\s*\d/, `${f}: ${sel.trim()} caps its height`);
    }
  }
});

/* ---- nav + footer ----------------------------------------------------------- */

test("NAV: All Access has no header slot; it is sold on /pro, the account page, the purchase surfaces and the footer; every required href kept", () => {
  assert.equal(NAV.find((n) => n.href === ALL_ACCESS_URL), undefined, "no All Access entry in the nav registry");
  assert.ok(!NAV.some((n) => (n as { place?: string }).place === "network"), "the 'network' nav place is gone");
  for (const h of ["/", "/fight-week", "/events", "/contender-series", "/fighters", "/rankings", "/history", "/news", "/pro", "/store"]) assert.ok(NAV.some((n) => n.href === h), `NAV kept ${h}`);
  assert.ok(NAV.some((n) => n.href === "/pro" && n.place === "cta"), "Go Pro stays the CTA");
  assert.ok(NAV.some((n) => n.href === "/store" && n.place === "more"), "Store lives in More");
});

test("Shell: no ALL ACCESS button in the header or the drawer; footer still carries ALL ACCESS + WHAT'S INCLUDED; /pro and the purchase surfaces still sell it", () => {
  const shell = read("components/Shell.tsx");
  assert.doesNotMatch(shell, /hdr-aa|mnav-aa|data-ufc-all-access="nav/);
  assert.doesNotMatch(shell, /allAccessNav|showAllAccess/);
  const footer = shell.slice(shell.indexOf("export function Footer"));
  assert.match(footer, /<Link href=\{LOCAL_ALL_ACCESS_PATH\} className="ftr-aa-link" data-ufc-footer-all-access="">All Access<\/Link>/);
  assert.match(footer, /<Link href=\{LOCAL_ALL_ACCESS_PATH\} data-ufc-footer-all-access-included="">What&apos;s included<\/Link>/);
  assert.doesNotMatch(read("components/NavLinks.tsx"), /propbetedge\.ai\/pro|All Access/);
  const css = read("app/all-access.css");
  assert.doesNotMatch(css, /\.hdr-aa|\.mnav-aa/);
  /* the commercial surfaces are untouched */
  assert.match(read("app/pro/page.tsx"), /<ProPlans email=\{account\?\.email \?\? null\} membership=\{membership\} \/>/);
  assert.match(read("components/ui.tsx"), /<AllAccessHero m=\{membership\} variant="surface" email=\{email\} \/>/);
  assert.match(read("app/account/page.tsx"), /view === "sport_pro" && m\.show_all_access_upgrade && <NetworkExpansion \/>/);
});

