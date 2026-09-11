# UFC Pro — Founding Season Payment Cutover

Status: **SOURCE PLAN READY · STRIPE OBJECT CREATION BLOCKED BY CONNECTOR AVAILABILITY**

Production visual baseline: `main` at `769c2fb15abe165c97b9ef34ed0072e7b00b7309` before this documentation commit.

Owner direction: move UFC Pro onto the same PropBetEdge Founding Season commercial model as NFL/NBA/NHL **without importing the recent background/hero experiments that went sideways**.

## Target customer offer

- **$9.99/month** — default / Best Value
- **$3.99/week** — Flexible
- **No free trial**
- **Cancel anytime**
- Existing legacy UFC customers/subscriptions are grandfathered; do not migrate or reprice them automatically.

## Current production contract that must be replaced atomically

`web/lib/site.ts` currently exposes:
- `$14.99/mo`
- `$5.99/card`
- monthly Stripe Payment Link `https://buy.stripe.com/cNi00j0nQfKSbRX9ID7wA0r`
- one-card Stripe Payment Link `https://buy.stripe.com/eVqaEX1rUbuC09f5sn7wA0s`

`web/components/ui.tsx` → `ProPlans()` renders that monthly + card-pass model.

`web/app/pro/page.tsx` repeats the same pricing in visible access copy and Product JSON-LD.

Do **not** update the displayed prices without updating checkout to matching Stripe prices in the same release.

## Required Stripe objects

Create live Stripe product / prices / hosted Payment Links for:

- product key: `ufc_pro`
- acquired sport: `ufc`
- monthly: USD 999, recurring `month`, no trial
- weekly: USD 399, recurring `week`, no trial
- pricing era: `founding_season_2026`

Payment Link metadata must include enough exact identity for the shared billing Worker to reject cross-sport/mismatched events, following the NBA/NHL pattern:
- `acquired_sport=ufc`
- `product=propbetedge_ufc`
- monthly `plan=pro_monthly`
- weekly `plan=pro_weekly`
- `trial=none`
- `pricing_era=founding_season_2026`

Create the objects/links **inactive first**.

## Runtime architecture

New acquisition path:

`Browser → Stripe-hosted Checkout → Cloudflare propbetedge-sports-billing Worker → Supabase pbe_sport_entitlements`

Rules:
- Vercel remains frontend presentation only.
- Do not add a Next/Vercel checkout API route.
- Do not use GitHub Actions for billing/webhook runtime.
- Browser state/query params/localStorage never grant Pro.
- Existing UFC store checkout is a separate physical-commerce flow and must not be broken or conflated with UFC Pro access.

## Entitlement integration

The current UFC account stack uses `ufc_accounts.plan` through `web/lib/auth.ts`. Do not make new Stripe webhooks mutate that legacy plan field.

Instead:
1. shared Cloudflare billing writes `ufc_pro` to `pbe_sport_entitlements`;
2. UFC account access reads verified `ufc_pro` entitlement through an owned Cloudflare/session path;
3. owner/unlimited access remains supported;
4. existing legacy Pro access remains recognized during transition;
5. once the new read path is proven, remove dependency on Vercel server-side privileged Supabase access as a separate architecture cleanup.

## Customer-facing release

Preserve the current Fight DNA product story. Change only the commercial layer:
- `ProPlans()` becomes monthly + weekly, with monthly visually default/Best Value.
- remove one-card acquisition from new-customer presentation;
- replace `$14.99/mo` and `$5.99/card` everywhere customer-visible;
- update Product JSON-LD to `$9.99` monthly and `$3.99` weekly;
- signed-out state: value + two plans + existing-member sign-in;
- signed-in free state: verified account + direct upgrade;
- active Pro state: keep the existing high-quality UFC Pro account experience, entitlement period/status, primary Fight DNA/fight-card actions.

No new backgrounds, homepage hero treatment, page-backdrop engine or broad visual refactor in this cutover.

## Activation sequence

1. Create inactive UFC Stripe product/prices/Payment Links.
2. Add exact UFC price/link IDs to `propbetedge-sports-billing` allowlist + tests.
3. Verify shared multi-sport entitlement migration is applied and browser roles cannot read/write it.
4. Deploy Worker through Cloudflare's existing deployment path.
5. Configure dedicated Stripe webhook endpoint/secret as required.
6. Canary invalid signature rejection, duplicate event, out-of-order lifecycle, monthly subscription, weekly subscription, cancel-at-period-end and cancellation.
7. Verify UFC account/session recognizes `ufc_pro` without trusting browser state.
8. Update `SITE.pricing`, `SITE.checkout`, `ProPlans()` and `/pro` JSON-LD together.
9. Build + preservation check + store tests + UFC product smoke.
10. Activate the two new Payment Links.
11. Deactivate old acquisition links for new purchases only; do not alter existing subscriptions.
12. Verify production at 1440 + 390.

## Acceptance report

- MAIN SHA
- VERCEL PRODUCTION DEPLOYMENT
- UFC MONTHLY PRICE / LINK
- UFC WEEKLY PRICE / LINK
- CLOUDFLARE BILLING VERSION
- SUPABASE ENTITLEMENT CANARY
- LEGACY UFC ACCESS CANARY
- MONTHLY CHECKOUT PASS/FAIL
- WEEKLY CHECKOUT PASS/FAIL
- CANCEL/RENEWAL PASS/FAIL
- ACCOUNT STATE PASS/FAIL
- STORE REGRESSION PASS/FAIL
- DESKTOP 1440 PASS/FAIL
- MOBILE 390 PASS/FAIL
- BACKGROUND/VISUAL DELTA: MUST BE NONE outside payment/account surfaces
- ROLLBACK TARGET

Never call the cutover complete until the amount shown to the customer, amount charged by Stripe and entitlement written by the Worker all agree.