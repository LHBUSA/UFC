# Store checkout — how it should connect, and what exists today

**Status: nothing in this repository can take money for a physical product.**
There is no cart, no checkout route, no order record, and no code path that
places an order at the print provider. This document describes what is already
here, and what a checkout would have to be to sit on top of it safely. It is
not a design that has been built, and nothing below should be read as
describing working code.

---

## What actually exists

### The one payment surface

`web/lib/site.ts` carries two **Stripe Payment Links**:

```ts
checkout: {
  monthly:  "https://buy.stripe.com/…",
  cardPass: "https://buy.stripe.com/…",
}
```

They are rendered by `web/components/ui.tsx` on `/pro`, as two anchors. That
is the entire payment integration:

- no `stripe` package in `web/package.json`, and no Stripe SDK anywhere;
- no secret key, publishable key or webhook secret in any environment file;
- no `/api/checkout`, `/api/webhooks/stripe`, or any route that could receive
  one;
- no `orders`, `order_items` or `shipments` table in `migrations/`.

A Payment Link is a hosted page for a **fixed** Stripe Price. It is the right
tool for a subscription and the wrong one for a garment: it cannot take a cart
whose contents the customer chose, cannot compute shipping for an address it
was not told about, cannot collect sales tax against a destination, and — the
part that matters most here — **produces no signal this application receives**,
so nothing on our side could know an order had been paid for, let alone hand it
to the printer.

So the honest statement is: the existing Stripe path is safe, it works, and it
is not extensible to the store. A store checkout is new work, not a wiring-up
of something already present.

### The provider client cannot order anything

`web/lib/store/printful.ts` exports read functions only. There is no
`createOrder`, no `createProduct`, and no mockup-generation call. That is a
deliberate property of the module rather than a gap: a serverless function that
can place an order is a serverless function that places two of them the first
time it is retried. Any order-placing code is new, and belongs behind the same
claim discipline `store_provisioning` already uses for product creation.

### What is already correct, and must not be undone

- **Prices live in `web/lib/store/catalog.ts`, in cents.** The browser is never
  trusted with one. A checkout resolves every line back to this file
  server-side, by slug, and ignores whatever the client said the price was.
- **`provider_costs` and `provider_variant_ids` never leave the server.**
  `toStorefront` is the single crossing into anything a page renders, and
  `FORBIDDEN_PUBLIC_KEYS` is asserted against the serialised projection. A
  checkout must read variant ids from `store_provisioning` with the service
  role, never from a request body.
- **`purchasable` is derived, never asserted.** It is true only when the
  provider has confirmed that exact product exists and the blank it prints on
  was identified. A checkout must re-derive it at the moment of purchase rather
  than trusting the flag the page was rendered with, because a page can be
  sixty seconds old and a product can have been deleted at the provider in
  between.

---

## What a checkout would have to be

Six pieces. None of them exist.

### 1. A server-side session, not a Payment Link

`POST /api/store/checkout` takes `[{ slug, size, color, qty }]` and **nothing
else** — no prices, no variant ids, no totals. It then:

1. resolves each slug in `catalog.ts` and refuses anything unknown;
2. reads `store_provisioning` with the service role and refuses any line whose
   product is not `state = 'created'` with a variant id for that exact
   `size / color` key;
3. builds Stripe line items from `retail_price` in `catalog.ts`;
4. creates a Stripe Checkout Session with `shipping_address_collection`,
   Stripe Tax, and shipping rates;
5. stores the intended order **before** redirecting, keyed by the session id,
   with the resolved variant ids;
6. returns the session URL.

Step 5 is the one that is easy to skip and expensive to skip. Without a record
written before the customer leaves, a paid webhook arrives referring to a cart
nobody kept.

This needs `stripe` as a dependency, `STRIPE_SECRET_KEY`, and — because the
existing Payment Links are configured in the same Stripe account — care that a
test-mode key is never the one deployed to production.

### 2. An order table with the same discipline as `store_provisioning`

`migrations/012_store_orders.sql`, mirroring the shape that already works:

- `stripe_session_id` unique, so a replayed webhook cannot create a second
  order;
- a state machine — `pending` → `paid` → `submitted` → `fulfilled` / `failed` —
  with `submitted_uncertain` as its own state, for exactly the reason
  `store_provisioning` has `uncertain`: a request whose outcome nobody observed
  is not a request that failed, and retrying it blind prints the order twice;
- a claim (`attempt_id`, `claimed_by`, `claimed_at`) around provider
  submission, so two workers cannot both submit;
- an `external_id` we generate per order, sent to the provider, so a duplicate
  can be detected on reconciliation rather than discovered by a customer
  receiving two parcels;
- RLS on, service role only. It holds addresses.

### 3. A webhook that verifies before it believes

`POST /api/webhooks/stripe`, `runtime = "nodejs"`, reading the **raw** body and
verifying `stripe-signature` against `STRIPE_WEBHOOK_SECRET`. An unverified
body is an unauthenticated stranger claiming an order was paid for.

It marks the order `paid` and returns 200 quickly. It does **not** call the
printer inline: a slow provider call inside a webhook handler is a timeout,
which Stripe retries, which is a second order.

### 4. Submission to Printful, out of band

A worker or cron claims a `paid` order, submits it to `POST /orders` with the
`external_id`, and records the outcome. On any unobserved outcome — timeout,
socket reset, ambiguous 5xx — the order becomes `submitted_uncertain` and is
reconciled by listing provider orders and matching on `external_id`, never
retried directly. This is the same rule, for the same reason, as
`migrations/010_store_provisioning.sql`: absence immediately after an uncertain
request is not proof of absence.

Printful order submission is also where `confirm: false` matters. Submitting a
draft and confirming it separately makes the irreversible step explicit rather
than a side effect of the first call.

### 5. Refunds and the returns policy already published

`/store/policies` already promises: a misprint, damage or a wrong item is
replaced or refunded within 30 days, and a wrong size is not returnable
because the item was made to order. Those sentences are live on the site, so
whatever is built has to honour them — including the case where Stripe has been
refunded and the printer has already shipped.

### 6. Something that proves the closed shop stays closed

The store currently renders with `purchasable: false` on every piece. That is
not a placeholder to be deleted when checkout lands; it is the correct output
of a correct derivation. The test that should exist alongside a checkout is the
one asserting a checkout request for a non-`created` slug is refused
server-side, regardless of what the page displayed.

---

## Order of work, and what each step risks

| Step | Risk if wrong |
| --- | --- |
| Order table + migration | none until something writes to it |
| Checkout session route | none while `purchasable` is false everywhere: it refuses every line |
| Stripe webhook | none until a session exists to be paid |
| Provider submission | **irreversible** — this is the first step that prints a garment and charges for it |
| Refund handling | money |

Everything up to and including the webhook can be built and tested against a
shop where nothing is purchasable, because every line resolves to "not
confirmed" and the route refuses it. That is a genuinely useful property: the
whole path can exist, be reviewed, and be exercised before a single real
product exists at the provider.

---

## Environment variables a checkout would add

None of these are set anywhere today.

| Variable | Used by | Notes |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | checkout route, refunds | sensitive; live and test keys must not be interchangeable by accident |
| `STRIPE_WEBHOOK_SECRET` | webhook route | per endpoint, not per account |
| `PRINTFUL_API_TOKEN` | order submission | **already set on preview** for the read-only canary; the same token can place orders, which is why nothing that imports it may be reachable from a page |

That last row is the one to keep in view. The token already deployed for the
canary is not read-only — the *client* is. The safety property is a property of
`web/lib/store/printful.ts` exporting no create function, and it lasts exactly
as long as that stays true.
