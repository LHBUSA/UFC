/**
 * Store contracts.
 *
 * Two shapes, kept apart on purpose.
 *
 * A ProductDef is what we decided to sell: name, copy, our retail price, the
 * sizes and colours we offer, which artwork it carries. It is authored, it is
 * public, and it is safe to render.
 *
 * A ProvisionRecord is what the print provider told us: its product and
 * variant ids, its cost prices, the print areas it actually requires. That is
 * operational. Provider cost is the input to our margin, variant ids are the
 * handles used to place a real order, and neither has any business reaching a
 * browser. Server-rendered pages leak by omission rather than by intent — an
 * object spread into a client component is serialised into the HTML whether
 * or not anything reads it — so the two never share a type and the crossing
 * happens in exactly one function.
 *
 * `toStorefront` is that crossing. It constructs its result field by field
 * rather than spreading and deleting, because a spread inherits every future
 * field somebody adds to the record, and the failure mode of that mistake is
 * silent publication.
 */

import { IMAGE_H, IMAGE_W, imagePath, type MarkKind } from "./art.ts";

export type Collection = "propbetedge" | "ufc";
export type Form = "tee" | "hoodie" | "cap" | "mug";
export type Site = "ufc" | "news";

/**
 * The display grouping a piece belongs to.
 *
 * Kept separate from `collection` on purpose. `collection` is part of the
 * shared contract the other storefront reads, and widening a value a consumer
 * switches on is a breaking change made quietly. `line` is ours: it decides
 * which section of our own shop a piece appears under, and a consumer that
 * has never heard of it is unaffected.
 */
export type Line = "house" | "fight-dna" | "tale-of-the-tape" | "analytics" | "fight-intelligence";

/**
 * A blank we have not been able to identify at the provider.
 *
 * Two strings because they have two audiences. `note` says which blanks
 * matched and why none was decisive; it names the provider's suppliers and
 * belongs in an operator's console, never on a page. `public` is what a
 * reader sees, and it says the honest thing without the supply chain.
 *
 * A blocked piece is still shown. Hiding it would leave a shop that quietly
 * has no hats in it, which reads as an oversight rather than as a decision;
 * showing it with the reason attached is what actually happened. What blocked
 * guarantees is stronger than invisibility: it can never be purchasable and
 * it is never provisioned, whatever any provisioning row claims.
 */
export type Blocked = { note: string; public: string };

/** Authored. Public. The single source of truth for what exists and what we charge. */
export type ProductDef = {
  slug: string;
  name: string;
  /** One line under the title. */
  blurb: string;
  /** Longer copy on the product page. */
  description: string;
  collection: Collection;
  form: Form;
  /** Cents. Ours, never the provider's. */
  retail_price: number;
  sizes: readonly string[];
  colors: readonly string[];
  /** Path under /store/print, without extension. The vector source is authoritative. */
  art: string;
  /** Which mark the preview draws. Several products share one. */
  mark: MarkKind;
  /** Type set with the mark. Empty for a piece that is mark only. */
  lines?: readonly string[];
  /** Section of our own shop. Not part of the shared contract. */
  line: Line;
  /** Which storefronts feature it. Shared pieces list both. */
  sites: readonly Site[];
  sort_order: number;
  /** Set aside: the blank could not be resolved, so this is never
   * provisioned and never purchasable. The slug stays so it keeps its
   * identity once the blank is chosen. */
  blocked?: Blocked;
};

export type ProvisionState = "unclaimed" | "in_flight" | "created" | "failed" | "uncertain";

/**
 * Server-side only. Mirrors one row of store_provisioning.
 *
 * Nothing in this type may appear in a page's props, in JSON-LD, or in a
 * client component. The leak test asserts that by key name.
 */
export type ProvisionRecord = {
  slug: string;
  state: ProvisionState;
  provider_store_id: number | null;
  provider_product_id: number | null;
  /** "M / Black" -> provider variant id. */
  provider_variant_ids: Record<string, number>;
  /** "M / Black" -> provider cost in cents. Operational. */
  provider_costs: Record<string, number>;
  /** Real print-area dimensions the provider reported, by placement. */
  print_areas: Record<string, { width: number; height: number }>;
  reconciled_at: string | null;
  reconcile_note: string | null;
  last_error: string | null;
  attempts: number;
  updated_at: string | null;
};

/** What a page may see. Everything here is safe in HTML. */
export type StorefrontProduct = {
  slug: string;
  name: string;
  blurb: string;
  description: string;
  collection: Collection;
  form: Form;
  price_cents: number;
  sizes: string[];
  colors: string[];
  art: string;
  /** Permanent, versioned image URLs. Never a provider mockup link: those
   * expire, and a URL handed to another storefront must not. */
  images: { url: string; width: number; height: number; alt: string; kind: "design_preview" | "provider_mockup" }[];
  /** True only when the provider has confirmed this exact product exists,
   * and the blank it prints on is one we have identified. */
  purchasable: boolean;
  /** Set when the design is finished but its blank is not chosen. Reader
   * facing; the operational detail behind it never leaves the server. */
  awaiting_blank: boolean;
  /** Why it is not purchasable, in words a reader can act on. Null when it is. */
  unavailable_reason: string | null;
};

/**
 * Keys that must never appear in anything a page renders. Named rather than
 * inferred, so the test fails loudly if the projection is ever rewritten as a
 * spread.
 */
export const FORBIDDEN_PUBLIC_KEYS = [
  "provider_store_id",
  "provider_product_id",
  "provider_variant_ids",
  "provider_costs",
  "cost",
  "costs",
  "variant_id",
  "variant_ids",
  "attempt_id",
  "claimed_by",
  "last_error",
] as const;

/**
 * The one crossing from operational state to public product.
 *
 * A product is purchasable only when the provider confirmed it — state
 * 'created' with a product id and at least one variant. Every other state,
 * including 'uncertain', renders as not purchasable. That is deliberate: an
 * uncertain row means we do not know whether the product exists, and offering
 * to sell something we cannot confirm is worse than saying it is not ready.
 */
export function toStorefront(def: ProductDef, rec: ProvisionRecord | null, origin = ""): StorefrontProduct {
  /* `!def.blocked` first, and it is not redundant with the provisioning
   * check. A blocked piece should have no provisioning row at all, but
   * "should" is not a guarantee: a row written by hand, or left behind after
   * a blank was set aside, would otherwise flip a piece we cannot make to
   * purchasable. The authored decision wins over the recorded state. */
  const confirmed =
    !def.blocked &&
    rec?.state === "created" &&
    typeof rec.provider_product_id === "number" &&
    Object.keys(rec.provider_variant_ids || {}).length > 0;

  return {
    slug: def.slug,
    name: def.name,
    blurb: def.blurb,
    description: def.description,
    collection: def.collection,
    form: def.form,
    price_cents: def.retail_price,
    sizes: [...def.sizes],
    colors: [...def.colors],
    art: def.art,
    images: [
      {
        url: `${origin}${imagePath(def.slug)}`,
        width: IMAGE_W,
        height: IMAGE_H,
        alt: `${def.name} — design preview, not a photograph`,
        /* Stated in the data, not only in the page copy, so a consumer cannot
         * present it as a photograph by accident. A design preview shows a
         * shape and a placement. It does not establish how a printed garment
         * looks, and it is not evidence that the printer accepted the
         * artwork. Real provider mockups replace these, as kind
         * "provider_mockup", once product creation is authorised — and they
         * must be copied into our own storage at that point, because the
         * provider's mockup URLs expire. */
        kind: "design_preview",
      },
    ],
    purchasable: confirmed,
    awaiting_blank: Boolean(def.blocked),
    /* def.blocked.public, never def.blocked.note: the note names the
     * provider's suppliers and the shape of our catalog search. */
    unavailable_reason: confirmed ? null : def.blocked ? def.blocked.public : unavailableReason(rec),
  };
}

function unavailableReason(rec: ProvisionRecord | null): string {
  if (!rec || rec.state === "unclaimed") return "Not yet released.";
  if (rec.state === "in_flight") return "Being prepared.";
  if (rec.state === "uncertain") return "Being confirmed with the printer.";
  if (rec.state === "failed") return "Not available.";
  return "Not yet released.";
}

/** Cents to display. Kept here so both storefronts round identically. */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

export function variantKey(size: string, color: string): string {
  return `${size} / ${color}`;
}
