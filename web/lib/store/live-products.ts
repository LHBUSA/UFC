import type { ProductDef } from "./types.ts";
import { bySlug as catalogBySlug, productsFor as catalogProductsFor } from "./catalog.ts";

const TRUST_DATA_MUG: ProductDef = {
  slug: "trust-the-data-mug",
  status: "launch",
  name: "Trust the Data Mug",
  blurb: "Less opinions. More winning.",
  description: "A black 11 oz glossy ceramic mug built around the PropBetEdge editorial position: trust the data. Gold-and-white fight intelligence artwork, chart language, and PropBetEdge branding wrap the cup for the card read, model check, and morning-after recap.",
  collection: "ufc",
  line: "analytics",
  form: "mug",
  retail_price: 1900,
  sizes: ["11 oz"],
  colors: ["Black"],
  art: "drop003-trust-the-data-mug-wrap",
  mark: "type",
  lines: ["TRUST THE DATA", "LESS OPINIONS. MORE WINNING."],
  sites: ["ufc"],
  sort_order: 142,
};

function releasedOverride(def: ProductDef): ProductDef {
  if (def.slug === "propbetedge-hat") {
    return {
      ...def,
      status: "launch",
      name: "PBE Classic Hat",
      blurb: "Clean look. Sharp mind.",
      description: "A black Yupoong 6245CM classic dad hat with the PropBetEdge house mark embroidered in gold across the front. One size, adjustable, built for fight night and everywhere after it.",
      retail_price: 2800,
      colors: ["Black"],
      blocked: undefined,
    };
  }
  if (def.slug === "tale-of-the-tape-hoodie") {
    return {
      ...def,
      status: "launch",
      name: "Tale of the Tape Hoodie",
      blurb: "Different fighters. Same data.",
      description: "A black premium Cotton Heritage M2580 hoodie carrying PropBetEdge's Tale of the Tape fight-intelligence graphic: striking, grappling, cardio, defense and intangibles framed as the matchup inputs bettors actually compare.",
      colors: ["Black"],
    };
  }
  return def;
}

export function liveBySlug(slug: string): ProductDef | null {
  if (slug === TRUST_DATA_MUG.slug) return TRUST_DATA_MUG;
  const def = catalogBySlug(slug);
  return def ? releasedOverride(def) : null;
}

export function liveProductsFor(site: "ufc" | "news"): ProductDef[] {
  const products = catalogProductsFor(site).map(releasedOverride);
  if (site === "ufc") products.push(TRUST_DATA_MUG);
  return products.sort((a, b) => a.sort_order - b.sort_order);
}
