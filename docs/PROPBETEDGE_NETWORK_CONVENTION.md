# PropBetEdge network convention

Every PropBetEdge sports product (MLB, NFL, UFC, NHL, NBA and whatever comes
next) presents the parent network the same way, and every product sells from
**one** commerce system. UFC is the reference implementation; this file is the
contract the others copy. It extends `UFC_NETWORK_LINKING_ADDENDUM.md` (linking
behaviour, canonicals, over-linking rules still apply).

Reference code: `web/lib/network.ts` (registry), `web/components/Shell.tsx`
(footer), `web/lib/site.ts` NAV (More-menu group).

## 1. Footer

Two network blocks. No more.

**PropBetEdge** column

| Link        | Destination                                            |
|-------------|--------------------------------------------------------|
| Sports News | `https://propbetedge.ai/`                              |
| Store       | the store, in this sport's collection context (§3)     |
| Discord     | `PROPBETEDGE_DISCORD_URL` = `https://discord.gg/kb5zCTHbME` (§5) |

**Sports** rail — one card per sport, in this order: MLB, NFL, UFC, NHL, NBA.
The current product is styled `here`. A sport appears only while it has a
public destination; if a product goes dark, remove the entry, never point it
at a placeholder.

Product-specific columns (UFC: Fight Intelligence, Editorial, Developers,
Official UFC) stay as they are. The footer is not a sitemap.

## 2. Header

The primary bar belongs to the product. The parent network gets **one**
entry, last, in the secondary menu:

    More ▾  …  PROPBETEDGE → Sports News

It is not in the primary bar because every product already has its own "News"
there, and two news links side by side read as a duplicate. Mobile inherits
it from the same NAV registry. The logo keeps linking to the product home.

First-party network links: same tab, no `nofollow`, no `target=_blank`.

## 3. Commerce: one system, sport collections

### Measured state (2026-09-11)

- The only live checkout in the network is the UFC app:
  `ufc.propbetedge.ai/store` — catalog (`web/lib/store/catalog.ts`), cart,
  Stripe Checkout (`/api/store/checkout`), Stripe webhook
  (`/api/webhooks/stripe`), orders, Printful fulfilment (`/api/store/fulfill`),
  customer order pages (`/store/order/[token]`), print art (`/store/print/*`).
- `propbetedge.ai/store` does **not** exist. It returns 200 only because the
  news site is an SPA with a catch-all; the live bundle has no store route.
- `LHBUSA/propbetedge-news-site` branch `propbetedge-store-v1` (unmerged, 12
  commits ahead of main) reads the UFC catalog over a signed API — good — but
  also carries its **own** `api/store/checkout.js`, `webhook.js` and
  `_lib/orders.js`. That is a second checkout/order system. It must not ship
  as-is (see §4).

### Target

    propbetedge.ai/store            ALL
    propbetedge.ai/store/ufc        UFC collection
    propbetedge.ai/store/nfl        NFL collection
    propbetedge.ai/store/mlb        MLB collection
    propbetedge.ai/store/nhl        NHL collection
    propbetedge.ai/store/nba        NBA collection
    (PBE CORE = catalog collection "propbetedge", the house pieces)

One catalog, one cart, one Stripe account and webhook, one orders table, one
fulfilment path. A sport collection is a **filter and a visual skin** on the
shared catalog, not a separate shop. Products are not duplicated per sport: a
house piece is one record that appears in ALL and PBE CORE. The catalog
already has the axis (`collection`), it just needs values beyond
`propbetedge | ufc` when non-UFC products exist.

In-store browsing tabs (ALL · UFC · NFL · MLB · NHL · NBA · PBE CORE) ship
with the central store. Tabs for sports with zero products are hidden, not
shown empty.

Recommended path: serve `propbetedge.ai/store/*` from the existing UFC
commerce engine (Vercel rewrite from the news site, or move the store module
to its own deployment on the same Supabase/Stripe/Printful config) rather
than building a second engine next to it.

### Store link per product

Until the central store is live, each product's Store link points at the one
live store; UFC uses its local `/store`. Once live, each product links to its
own collection: UFC → `propbetedge.ai/store/ufc`, NFL → `/store/nfl`, etc.
Changing that is a one-line edit of `NETWORK.store.href`.

## 4. Legacy UFC store URLs — never break

`ufc.propbetedge.ai/store/...` links are public. When commerce centralises:

| Path                               | Rule                                                        |
|------------------------------------|-------------------------------------------------------------|
| `/store`                           | 308 → `propbetedge.ai/store/ufc`, or keep serving with canonical there |
| `/store/[slug]`                    | 308 → `propbetedge.ai/store/ufc/[slug]` (slug is permanent product identity), or serve with canonical |
| `/store/cart`                      | keep working until carts are migrated; never drop a cart silently |
| `/store/order/[token]`             | **never redirect** — in customer emails and Stripe `success_url` |
| `/store/policies`                  | redirect is fine once the central page exists              |
| `/store/print/*`                   | **never redirect or move** — Printful fetches print art from these exact URLs (`lib/store/release.ts`) |
| `/store/product-photo/*`, `/store/mockup/*` | keep serving; storefront image URLs (`lib/store/display.ts`), possibly cached by social cards |
| `/api/store/*`, `/api/webhooks/stripe` | **never move without re-pointing the Stripe webhook endpoint and Printful config first** |

Every redirect ships with a test that requests the old URL and asserts the
status and `Location`. No redirect lands while an order is in flight on the
old path without that test.

## 5. Discord

One invite for the whole network, owner-confirmed 2026-09-11:

    PROPBETEDGE_DISCORD_URL = https://discord.gg/kb5zCTHbME   (non-expiring)

Every product defines it once, under that name, in its network/config module
and references the constant everywhere else. Never create a per-product or
per-campaign invite: seven of them (`HPzYDAng`, `8rMxrMG5`, `e9S6pFq9`,
`Cn57R2MG`, `QsBmfgXd`, `7AGkr9XG`, `YfQd2JkQ`) had expired independently
across sites, emails and Workers before this was consolidated. If the invite
ever changes, grep every PBE repo and Worker for `discord.gg/` and
`discord.com/invite/`, and check the live bundles, not just the source.

## 6. Open items

- **News-site store branch:** decide before merging `propbetedge-store-v1`
  that its checkout/webhook/orders are dropped in favour of the shared engine.

## Do not

- create a Stripe/checkout system per sport
- duplicate cart, customer or order logic per sport
- duplicate product records per sport
- use a different fulfilment architecture per sport without a real reason
- break `ufc.propbetedge.ai/store/...`
- redesign a product while doing network work
