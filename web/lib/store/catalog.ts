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
 * The ten shared slugs are exactly the ones the news-site store already
 * defines, unchanged, and the set is closed. Everything added since is
 * `sites: ["ufc"]` — not because a hoodie is somehow UFC-specific, but
 * because this file is served to another site's shop and adding a slug here
 * silently puts a new product on somebody else's shelf. Widening the shared
 * set is a decision for both sites, made once, not a side effect of finishing
 * this one.
 *
 * Two axes, and they are not the same axis:
 *
 *   collection  which shop the piece belongs to. Part of the shared contract
 *               the news site reads and may switch on.
 *   line        which design family it belongs to — the house marks, Fight
 *               DNA, Tale of the Tape, the analytics jokes, fight
 *               intelligence. Ours, and only used to lay out our own store.
 *
 * On the artwork: nothing printed here uses UFC lettering, the octagon
 * trademark, or red trade dress. This site reports on the sport under its own
 * brand; merchandise carrying a rights-holder's marks would be a different
 * thing entirely, and not one we have a licence for. The type is ours.
 *
 * Prices are in cents. The browser is never trusted with them — the checkout
 * path, when it is eventually enabled, resolves every line back to this file
 * server-side. See docs/store_checkout.md.
 */
import type { Blocked, Line, ProductDef } from "./types";

export const CATALOG_VERSION = "2026-09-08.1";

/* Sizing mirrors the blanks we intend to resolve at the provider. They are
 * presentational until real variant ids exist; selectVariants reports any our
 * chosen blank cannot actually supply rather than quietly dropping them.
 *
 * The lead colour decides the preview's tone — dark cloth carries gold, light
 * cloth carries ink — so the order of this array is load-bearing. */
const TEE = { form: "tee", sizes: ["S", "M", "L", "XL", "2XL"], colors: ["Black", "Vintage White"], retail_price: 3200 } as const;
const HOODIE = { form: "hoodie", sizes: ["S", "M", "L", "XL", "2XL"], colors: ["Black", "Charcoal"], retail_price: 6500 } as const;
const CAP = { form: "cap", sizes: ["One size"], colors: ["Black"], retail_price: 3800 } as const;
const MUG = { form: "mug", sizes: ["11 oz"], colors: ["White"], retail_price: 1900 } as const;

const BOTH = ["ufc", "news"] as const;
const UFC_ONLY = ["ufc"] as const;

/**
 * Every cap carries this, because it is one finding about one blank rather
 * than five separate problems: the live catalog answers our embroidered-cap
 * search with four Otto Cap dad hats that match equally well, and no model
 * number breaks the tie. A guess there does not fail loudly — it embroiders
 * the wrong hat and nobody finds out until one arrives.
 *
 * So the caps are designed, priced and shown, and they are not provisioned
 * and cannot be bought. One read-only canary run resolves all five at once
 * (`/api/store/canary-read?probe=cap,hat,dad hat`), which is why the note is
 * shared rather than copied.
 */
const CAP_BLANK_UNRESOLVED: Blocked = {
  note: "cap blank unresolved: four Otto Cap dad hats match the embroidered-cap search equally and no model number is decisive",
  public: "The design is finished. We are still choosing the cap it prints on.",
};

export const PRODUCTS: readonly ProductDef[] = [
  /* ---- shared house pieces, identical on both storefronts ---------------- */
  {
    slug: "propbetedge-logo-tee",
    name: "PropBetEdge Logo Tee",
    blurb: "The house mark, small on the chest.",
    description:
      "The house mark set small on the chest in gold on a heavyweight cotton tee. No wordmark across the back, no loud graphics. It reads as a brand, not a billboard.",
    collection: "propbetedge",
    line: "house",
    ...TEE,
    art: "propbetedge-wordmark-gold",
    mark: "house",
    lines: ["PROPBETEDGE"],
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
    line: "house",
    ...HOODIE,
    /* Its own file: the hoodie front is 2100x2100 square, verified live, so it
     * cannot share the tee's 1800x2400 portrait print file. */
    art: "propbetedge-wordmark-gold-hoodie",
    mark: "house",
    lines: ["PROPBETEDGE"],
    sites: BOTH,
    sort_order: 20,
  },
  {
    slug: "propbetedge-hat",
    name: "PropBetEdge Cap",
    blurb: "Embroidered mark, unstructured.",
    description: "An unstructured cap with the mark embroidered at the front panel. One size, adjustable.",
    collection: "propbetedge",
    line: "house",
    ...CAP,
    art: "cap-mark-gold",
    mark: "house",
    lines: [],
    sites: BOTH,
    sort_order: 30,
    blocked: CAP_BLANK_UNRESOLVED,
  },
  {
    slug: "propbetedge-mug",
    name: "PropBetEdge Mug",
    blurb: "For the morning after a late card.",
    description: "An 11oz glossy mug carrying the wordmark. For the morning after a card that finished at two.",
    collection: "propbetedge",
    line: "house",
    ...MUG,
    art: "mug-wordmark-ink",
    mark: "house",
    lines: ["PROPBETEDGE"],
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
    line: "analytics",
    ...TEE,
    art: "trust-the-data-gold",
    mark: "type",
    lines: ["TRUST", "THE DATA"],
    sites: BOTH,
    sort_order: 50,
  },
  {
    slug: "no-vibes-just-variance-tee",
    name: "No Vibes, Just Variance Tee",
    blurb: "The distribution does not care how you feel.",
    description:
      "For people who have had the argument about a bad beat one too many times and would like the shirt to make it for them. The curve is a real one: the bars are a gaussian, not a shape that looked about right.",
    collection: "propbetedge",
    line: "analytics",
    ...TEE,
    art: "no-vibes-gold",
    mark: "variance",
    lines: ["NO VIBES,", "JUST VARIANCE"],
    sites: BOTH,
    sort_order: 60,
  },
  {
    slug: "my-model-said-no-tee",
    name: "My Model Said No Tee",
    blurb: "Worn in defeat, mostly.",
    description:
      "Set small and straight in the house serif. Worn most often by the person who ignored it, which is the point of the shirt.",
    collection: "propbetedge",
    line: "analytics",
    ...TEE,
    art: "my-model-said-no-gold",
    mark: "type",
    lines: ["MY MODEL", "SAID NO"],
    sites: BOTH,
    sort_order: 70,
  },
  {
    slug: "spreadsheet-for-this-mug",
    name: "I Have a Spreadsheet for This Mug",
    blurb: "You do. Everyone knows.",
    description:
      "An 11oz mug for the person at the watch party who has the tab open. One cell is picked out, because there is always one cell.",
    collection: "propbetedge",
    line: "analytics",
    ...MUG,
    art: "mug-spreadsheet-ink",
    mark: "grid",
    lines: ["I HAVE A", "SPREADSHEET FOR THIS"],
    sites: BOTH,
    sort_order: 80,
  },

  /* ---- Fight DNA: born on this site, the two originals sold on both ------ */
  {
    slug: "fight-dna-tee",
    name: "Fight DNA Tee",
    blurb: "The house method, on cotton.",
    description:
      "Fight DNA is how this site reads a matchup: pace, output, defence and finishing behaviour, drawn from round evidence rather than a narrative. The helix is that idea, set as a mark.",
    collection: "ufc",
    line: "fight-dna",
    ...TEE,
    art: "fight-dna-gold",
    mark: "dna",
    lines: ["FIGHT DNA"],
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
    line: "fight-dna",
    ...TEE,
    art: "fight-dna-over-takes-gold",
    mark: "dna",
    lines: ["FIGHT DNA", "OVER FIGHT TAKES"],
    sites: BOTH,
    sort_order: 100,
  },
  {
    slug: "fight-dna-hoodie",
    name: "Fight DNA Hoodie",
    blurb: "The helix, at chest height, in gold.",
    description:
      "The Fight DNA mark on a heavy blend hood. The same strand and rungs the tee carries, sized for a garment that gets worn to the arena rather than in it.",
    collection: "ufc",
    line: "fight-dna",
    ...HOODIE,
    art: "fight-dna-gold-hoodie",
    mark: "dna",
    lines: ["FIGHT DNA"],
    sites: UFC_ONLY,
    sort_order: 105,
  },
  {
    slug: "fight-dna-cap",
    name: "Fight DNA Cap",
    blurb: "The helix, embroidered small.",
    description:
      "An unstructured cap with the Fight DNA strand embroidered across the front panel. One size, adjustable, and quiet enough to wear somewhere that is not a fight.",
    collection: "ufc",
    line: "fight-dna",
    ...CAP,
    art: "cap-fight-dna-gold",
    mark: "dna",
    lines: [],
    sites: UFC_ONLY,
    sort_order: 106,
    blocked: CAP_BLANK_UNRESOLVED,
  },
  {
    slug: "fight-dna-mug",
    name: "Fight DNA Mug",
    blurb: "Read the matchup before the coffee goes cold.",
    description:
      "The helix wrapped round an 11oz glossy mug in ink. For reading a card the morning of, which is when the method is actually worth anything.",
    collection: "ufc",
    line: "fight-dna",
    ...MUG,
    art: "mug-fight-dna-ink",
    mark: "dna",
    lines: ["FIGHT DNA"],
    sites: UFC_ONLY,
    sort_order: 107,
  },

  /* ---- Tale of the Tape -------------------------------------------------- */
  {
    slug: "tale-of-the-tape-mug",
    name: "Tale of the Tape Mug",
    blurb: "Reach, stance, and a strong opinion.",
    description:
      "The tape laid out around an 11oz mug: reach, stance, height, the fields every preview starts from before anybody says anything interesting.",
    collection: "ufc",
    line: "tale-of-the-tape",
    ...MUG,
    art: "mug-tale-of-the-tape-ink",
    mark: "tape",
    lines: ["TALE OF THE TAPE"],
    sites: UFC_ONLY,
    sort_order: 130,
  },
  {
    slug: "tale-of-the-tape-tee",
    name: "Tale of the Tape Tee",
    blurb: "The rule, graduated, with the reach span under it.",
    description:
      "A measuring rule set across the chest with its graduations drawn properly and the reach span beneath. Everything a preview knows before the fight starts, and nothing it only thinks it knows.",
    collection: "ufc",
    line: "tale-of-the-tape",
    ...TEE,
    art: "tale-of-the-tape-gold",
    mark: "tape",
    lines: ["TALE OF THE TAPE"],
    sites: UFC_ONLY,
    sort_order: 131,
  },
  {
    slug: "tale-of-the-tape-hoodie",
    name: "Tale of the Tape Hoodie",
    blurb: "The measurements, on something warm.",
    description:
      "The tape mark on a heavy blend hood. Reach and stance settle more arguments in the first round than anything said about them in the week before.",
    collection: "ufc",
    line: "tale-of-the-tape",
    ...HOODIE,
    art: "tale-of-the-tape-gold-hoodie",
    mark: "tape",
    lines: ["TALE OF THE TAPE"],
    sites: UFC_ONLY,
    sort_order: 132,
  },
  {
    slug: "tale-of-the-tape-cap",
    name: "Tale of the Tape Cap",
    blurb: "Graduations across the front panel.",
    description:
      "An unstructured cap carrying the rule and its graduations embroidered across the front panel. One size, adjustable.",
    collection: "ufc",
    line: "tale-of-the-tape",
    ...CAP,
    art: "cap-tale-of-the-tape-gold",
    mark: "tape",
    lines: [],
    sites: UFC_ONLY,
    sort_order: 133,
    blocked: CAP_BLANK_UNRESOLVED,
  },

  /* ---- the analytics line, extended on this site only -------------------- */
  {
    slug: "trust-the-data-hoodie",
    name: "Trust the Data Hoodie",
    blurb: "Three words, warmer.",
    description:
      "The same three words in the house serif, on a heavy blend hood. It is still the editorial position of this site, now with a pocket.",
    collection: "ufc",
    line: "analytics",
    ...HOODIE,
    art: "trust-the-data-gold-hoodie",
    mark: "type",
    lines: ["TRUST", "THE DATA"],
    sites: UFC_ONLY,
    sort_order: 141,
  },
  {
    slug: "no-vibes-just-variance-cap",
    name: "No Vibes, Just Variance Cap",
    blurb: "The distribution, embroidered.",
    description:
      "The curve embroidered small across the front panel of an unstructured cap. Says the whole thing without saying any of it out loud.",
    collection: "ufc",
    line: "analytics",
    ...CAP,
    art: "cap-no-vibes-gold",
    mark: "variance",
    lines: [],
    sites: UFC_ONLY,
    sort_order: 142,
    blocked: CAP_BLANK_UNRESOLVED,
  },
  {
    slug: "no-vibes-just-variance-mug",
    name: "No Vibes, Just Variance Mug",
    blurb: "A bell curve you can drink out of.",
    description:
      "The distribution printed in ink around an 11oz glossy mug. For the morning you look at a card that went badly and would like to be reminded that one card is not a sample.",
    collection: "ufc",
    line: "analytics",
    ...MUG,
    art: "mug-no-vibes-ink",
    mark: "variance",
    lines: ["NO VIBES,", "JUST VARIANCE"],
    sites: UFC_ONLY,
    sort_order: 143,
  },

  /* ---- fight intelligence: this site's own reading of a card ------------- */
  {
    slug: "round-by-round-tee",
    name: "Round by Round Tee",
    blurb: "Scored the way it was fought.",
    description:
      "A fight is not one event, it is three or five. The round strip runs across the chest, one block per round, filled for the rounds that were scored and open for the ones that never happened.",
    collection: "ufc",
    line: "fight-intelligence",
    ...TEE,
    art: "round-by-round-gold",
    mark: "rounds",
    lines: ["ROUND BY ROUND"],
    sites: UFC_ONLY,
    sort_order: 110,
  },
  {
    slug: "round-by-round-hoodie",
    name: "Round by Round Hoodie",
    blurb: "Five blocks, three usually used.",
    description:
      "The round strip on a heavy blend hood. Worn by people who will tell you which round it actually turned, and be right about it.",
    collection: "ufc",
    line: "fight-intelligence",
    ...HOODIE,
    art: "round-by-round-gold-hoodie",
    mark: "rounds",
    lines: ["ROUND BY ROUND"],
    sites: UFC_ONLY,
    sort_order: 111,
  },
  {
    slug: "significant-strikes-tee",
    name: "Significant Strikes Tee",
    blurb: "The stat that actually settles it.",
    description:
      "Two words that end more arguments than any other pair in this sport, set in the house serif over the landed-against-attempted rule.",
    collection: "ufc",
    line: "fight-intelligence",
    ...TEE,
    art: "significant-strikes-gold",
    mark: "strikes",
    lines: ["SIGNIFICANT STRIKES"],
    sites: UFC_ONLY,
    sort_order: 120,
  },
  {
    slug: "fight-week-cap",
    name: "Fight Week Cap",
    blurb: "Six days, one card.",
    description:
      "An unstructured cap with FIGHT WEEK embroidered small at the front panel. Worn Tuesday through Saturday, and quietly on Sunday.",
    collection: "ufc",
    line: "fight-intelligence",
    ...CAP,
    art: "cap-fight-week-gold",
    mark: "type",
    lines: ["FIGHT WEEK"],
    sites: UFC_ONLY,
    sort_order: 140,
    blocked: CAP_BLANK_UNRESOLVED,
  },
] as const;

/** The sections this storefront lays itself out in, in order. */
export const LINES: readonly { key: Line; name: string; blurb: string }[] = [
  { key: "fight-dna", name: "Fight DNA", blurb: "The house method: pace, output, defence and finishing, read from round evidence." },
  { key: "tale-of-the-tape", name: "Tale of the Tape", blurb: "Reach, stance and height — where every preview starts." },
  { key: "fight-intelligence", name: "Fight Intelligence", blurb: "How this desk reads a card: round by round, and the strikes that settle it." },
  { key: "analytics", name: "PropBetEdge Analytics", blurb: "Distributions, spreadsheets, and models nobody listened to." },
  { key: "house", name: "The House Marks", blurb: "PropBetEdge itself, shared across the network." },
];

/**
 * Products this storefront features, in order.
 *
 * Blocked pieces are included. They are designed, priced and real, and the
 * only thing missing is the blank they print on — which `toStorefront` turns
 * into "not purchasable" with the reason attached, unconditionally. Leaving
 * them out gave a shop with no hats in it and no explanation, which reads as
 * a shop that forgot hats rather than one that refused to guess at a blank.
 */
export function productsFor(site: "ufc" | "news"): ProductDef[] {
  return PRODUCTS.filter((p) => p.sites.includes(site))
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * Products provisioning may actually create. Blocked pieces are excluded here
 * and only here — this is the list the operator script walks, and it is the
 * boundary that keeps an unresolved blank from reaching a create call.
 */
export function provisionable(): ProductDef[] {
  return PRODUCTS.filter((p) => !p.blocked)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
}

/** Forms an offered product actually needs. A blank nothing offers does not
 * need resolving, and must not fail a run. */
export function activeForms(): string[] {
  return [...new Set(PRODUCTS.filter((p) => !p.blocked).map((p) => p.form))];
}

export function bySlug(slug: string): ProductDef | null {
  return PRODUCTS.find((p) => p.slug === slug) ?? null;
}
