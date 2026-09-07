/**
 * The product manifest.
 *
 * Shared with the news-site storefront by slug. That is the whole mechanism
 * for "one catalog, two shops": a slug is the external identity of a product
 * at the print provider, so `propbetedge-logo-tee` on this site and
 * `propbetedge-logo-tee` on propbetedge.ai resolve to the same provisioned
 * product and the same garment. Renaming a slug here creates a second product
 * at the provider; treat these strings as permanent.
 *
 * The first ten slugs are exactly the ones the news-site store already
 * defines, unchanged. The UFC collection below is additional and is featured
 * on this site only.
 *
 * On the artwork: nothing printed here uses UFC lettering, the octagon
 * trademark, or red trade dress. This site reports on the sport under its own
 * brand; merchandise carrying a rights-holder's marks would be a different
 * thing entirely, and not one we have a licence for. The type is ours.
 *
 * Prices are in cents. The browser is never trusted with them — the checkout
 * path, when it is eventually enabled, resolves every line back to this file
 * server-side.
 */
import type { ProductDef } from "./types";

export const CATALOG_VERSION = "2026-09-07.1";

/* Sizing mirrors the blanks we intend to resolve at the provider. They are
 * presentational until real variant ids exist; selectVariants reports any our
 * chosen blank cannot actually supply rather than quietly dropping them. */
const TEE = { form: "tee", sizes: ["S", "M", "L", "XL", "2XL"], colors: ["Black", "Vintage White"], retail_price: 3200 } as const;
const HOODIE = { form: "hoodie", sizes: ["S", "M", "L", "XL", "2XL"], colors: ["Black", "Charcoal"], retail_price: 6500 } as const;
const CAP = { form: "cap", sizes: ["One size"], colors: ["Black"], retail_price: 3800 } as const;
const MUG = { form: "mug", sizes: ["11oz"], colors: ["White"], retail_price: 1900 } as const;

const BOTH = ["ufc", "news"] as const;
const UFC_ONLY = ["ufc"] as const;

export const PRODUCTS: readonly ProductDef[] = [
  /* ---- shared house pieces, identical on both storefronts ---------------- */
  {
    slug: "propbetedge-logo-tee",
    name: "PropBetEdge Logo Tee",
    blurb: "The house mark, small on the chest.",
    description:
      "The house mark set small on the chest in gold on a heavyweight cotton tee. No wordmark across the back, no loud graphics. It reads as a brand, not a billboard.",
    collection: "propbetedge",
    ...TEE,
    art: "propbetedge-wordmark-gold",
    sites: BOTH,
    sort_order: 10,
  },
  {
    slug: "propbetedge-hoodie",
    name: "PropBetEdge Premium Hoodie",
    blurb: "Heavy blend, quiet mark.",
    description:
      "A heavy blend hood with the mark at the left chest. Built for a cold arena concourse and an argument about scoring afterwards.",
    collection: "propbetedge",
    ...HOODIE,
    art: "propbetedge-wordmark-gold",
    sites: BOTH,
    sort_order: 20,
  },
  {
    slug: "propbetedge-hat",
    name: "PropBetEdge Cap",
    blurb: "Embroidered mark, unstructured.",
    description: "An unstructured cap with the mark embroidered at the front panel. One size, adjustable.",
    collection: "propbetedge",
    ...CAP,
    art: "cap-mark-gold",
    sites: BOTH,
    sort_order: 30,
  },
  {
    slug: "propbetedge-mug",
    name: "PropBetEdge Mug",
    blurb: "For the morning after a late card.",
    description: "An 11oz glossy mug carrying the wordmark. For the morning after a card that finished at two.",
    collection: "propbetedge",
    ...MUG,
    art: "mug-wordmark-ink",
    sites: BOTH,
    sort_order: 40,
  },
  {
    slug: "trust-the-data-tee",
    name: "Trust the Data Tee",
    blurb: "Three words, set straight.",
    description:
      "Three words in the house serif, set straight and left alone. It is the whole editorial position of this site printed at chest height.",
    collection: "propbetedge",
    ...TEE,
    art: "trust-the-data-gold",
    sites: BOTH,
    sort_order: 50,
  },
  {
    slug: "no-vibes-just-variance-tee",
    name: "No Vibes, Just Variance Tee",
    blurb: "The distribution does not care how you feel.",
    description:
      "For people who have had the argument about a bad beat one too many times and would like the shirt to make it for them.",
    collection: "propbetedge",
    ...TEE,
    art: "no-vibes-gold",
    sites: BOTH,
    sort_order: 60,
  },
  {
    slug: "my-model-said-no-tee",
    name: "My Model Said No Tee",
    blurb: "Worn in defeat, mostly.",
    description: "Set in mono, small, lower left. Worn most often by the person who ignored it.",
    collection: "propbetedge",
    ...TEE,
    art: "my-model-said-no-gold",
    sites: BOTH,
    sort_order: 70,
  },
  {
    slug: "spreadsheet-for-this-mug",
    name: "I Have a Spreadsheet for This Mug",
    blurb: "You do. Everyone knows.",
    description: "An 11oz mug for the person at the watch party who has the tab open. You know the one.",
    collection: "propbetedge",
    ...MUG,
    art: "mug-spreadsheet-ink",
    sites: BOTH,
    sort_order: 80,
  },

  /* ---- Fight DNA: born on this site, sold on both ------------------------ */
  {
    slug: "fight-dna-tee",
    name: "Fight DNA Tee",
    blurb: "The house method, on cotton.",
    description:
      "Fight DNA is how this site reads a matchup: pace, output, defence and finishing behaviour, drawn from round evidence rather than a narrative. This is that idea set as type.",
    collection: "ufc",
    ...TEE,
    art: "fight-dna-gold",
    sites: BOTH,
    sort_order: 90,
  },
  {
    slug: "fight-dna-over-fight-takes-tee",
    name: "Fight DNA Over Fight Takes Tee",
    blurb: "Evidence over opinion.",
    description:
      "The shortest statement of what this desk does. Evidence first, and the take afterwards or not at all.",
    collection: "ufc",
    ...TEE,
    art: "fight-dna-over-takes-gold",
    sites: BOTH,
    sort_order: 100,
  },

  /* ---- UFC collection: featured on this site only ------------------------ */
  {
    slug: "round-by-round-tee",
    name: "Round by Round Tee",
    blurb: "Scored the way it was fought.",
    description:
      "A fight is not one event, it is three or five. The round strip runs small across the chest in mono, one block per round, the way the round-by-round page reads it.",
    collection: "ufc",
    ...TEE,
    art: "round-by-round-gold",
    sites: UFC_ONLY,
    sort_order: 110,
  },
  {
    slug: "significant-strikes-tee",
    name: "Significant Strikes Tee",
    blurb: "The stat that actually settles it.",
    description:
      "Two words that end more arguments than any other pair in this sport, set in the house serif with the count rule beneath them.",
    collection: "ufc",
    ...TEE,
    art: "significant-strikes-ink",
    sites: UFC_ONLY,
    sort_order: 120,
  },
  {
    slug: "tale-of-the-tape-mug",
    name: "Tale of the Tape Mug",
    blurb: "Reach, stance, and a strong opinion.",
    description:
      "The tape laid out around an 11oz mug: reach, stance, height, the fields every preview starts from before anybody says anything interesting.",
    collection: "ufc",
    ...MUG,
    art: "mug-tale-of-the-tape-ink",
    sites: UFC_ONLY,
    sort_order: 130,
  },
  {
    slug: "fight-week-cap",
    name: "Fight Week Cap",
    blurb: "Six days, one card.",
    description: "An unstructured cap with FIGHT WEEK embroidered small at the front panel. Worn Tuesday through Saturday.",
    collection: "ufc",
    ...CAP,
    art: "cap-fight-week-gold",
    sites: UFC_ONLY,
    sort_order: 140,
  },
] as const;

export const COLLECTIONS: readonly { key: "propbetedge" | "ufc"; name: string; blurb: string }[] = [
  { key: "ufc", name: "Fight Intelligence", blurb: "Made for this site: round evidence, the tape, and fight week." },
  { key: "propbetedge", name: "PropBetEdge", blurb: "The house marks, shared across the network." },
];

/** Products this storefront features, in order. */
export function productsFor(site: "ufc" | "news"): ProductDef[] {
  return PRODUCTS.filter((p) => p.sites.includes(site)).slice().sort((a, b) => a.sort_order - b.sort_order);
}

export function bySlug(slug: string): ProductDef | null {
  return PRODUCTS.find((p) => p.slug === slug) ?? null;
}
