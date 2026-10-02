/**
 * lib/imageMetadata.ts
 *
 * ONE image-rights contract for every schema.org ImageObject PropBetEdge emits.
 * Same contract and rules as propbetedge-news-site src/image-metadata.js
 * (docs/IMAGE_METADATA_CONTRACT.md there is the canonical copy of the rules).
 *
 * Rights fields (creator, copyrightNotice, creditText, license,
 * acquireLicensePage) are filled ONLY from what is actually known about the
 * pixels:
 *   owned            PropBetEdge-made art → creator PropBetEdge, "© <year> PropBetEdge".
 *   cc_licensed      Commons / CC photo with a recorded author and license →
 *                    that author, "<author> / <license>", license + source page.
 *   owned_composite  PropBetEdge card embedding other images; rights only when
 *                    every embedded part is owned or cc_licensed, else held.
 *   third_party      ESPN display-only headshots, press photos, posters → only
 *                    what the source itself published. Never "© PropBetEdge",
 *                    never a "© <host>" guessed from the URL.
 */

export const PBE_ORG_NAME = "PropBetEdge";
/** Year the PropBetEdge brand art (logos, static share cards) was created. */
export const PBE_BRAND_YEAR = 2026;

export type SourceType = "owned" | "cc_licensed" | "owned_composite" | "third_party";

export type ImageMeta = {
  url: string;
  contentUrl: string;
  width: number | null;
  height: number | null;
  caption: string | null;
  creditText: string | null;
  creator_name: string | null;
  creator_type: "Person" | "Organization" | null;
  copyrightNotice: string | null;
  license: string | null;
  acquireLicensePage: string | null;
  source_url: string | null;
  source_type: SourceType;
  license_name?: string | null;
  held?: string;
};

type Base = { url: string; contentUrl?: string | null; width?: number | null; height?: number | null; caption?: string | null; source_url?: string | null };

const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());
const num = (v: unknown): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);

function yearOf(value: unknown): number | null {
  if (!value) return null;
  const y = Number(String(value).slice(0, 4));
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : null;
}

function base(b: Base): ImageMeta {
  const u = text(b.url);
  return {
    url: u, contentUrl: text(b.contentUrl) || u, width: num(b.width), height: num(b.height), caption: text(b.caption) || null,
    creditText: null, creator_name: null, creator_type: null, copyrightNotice: null, license: null, acquireLicensePage: null,
    source_url: text(b.source_url) || null, source_type: "third_party",
  };
}

/** PropBetEdge-made art. `year` = when it was made (content date for generated cards). */
export function ownedImage(b: Base & { year?: unknown }): ImageMeta {
  const y = yearOf(b.year) || PBE_BRAND_YEAR;
  return { ...base(b), creator_name: PBE_ORG_NAME, creator_type: "Organization", copyrightNotice: `© ${y} ${PBE_ORG_NAME}`, creditText: PBE_ORG_NAME, source_type: "owned" };
}

/** Words that mark an attribution name as an organization (agency, club, outlet, government body). */
const ORG_WORDS = /\b(sports?|central|media|news|press|photo(?:graphy|s)?|images?|agency|studios?|inc|llc|ltd|corp(?:oration)?|company|co\.|club|team|league|association|federation|university|college|school|department|ministry|government|office|service|army|navy|air force|marines?|guard|police|official|foundation|institute|society|network|tv|radio|magazine|times|post|herald|journal|gazette|daily|weekly|records|commons|wikimedia|archives?|library|museum|fc|cf|sc|ac|athletics?|basketball|football|soccer|hockey|baseball|tennis|golf|racing|motorsports?|f1|nba|wnba|nfl|nhl|mlb|ufc|pga|atp|wta|fifa|uefa|ioc|olympic|government of|state of|city of|county|embassy|consulate|kremlin|white house|presidencia|casa rosada|senate|democrats|republicans|asamblea|nacional|summit|falcons|multishow|onlyfans|esporte|pixsell|télam|diario|channel|youtube|tiktok|m+anytt(?:\.se)?|[a-z0-9-]+\.(?:com|se|pe|ru|net|org))\b/i;

/** Attribution strings that do not name anyone (Commons boilerplate, placeholders). Such a photo is held. */
const NOT_A_NAME = /unknown author|please complete|this file is licensed|copyright holder release|permission is on file|^\[\d+\]$|^shared account$|^unknown/i;

export function creatorTypeFor(name: unknown, declared?: unknown): "Person" | "Organization" {
  if (declared === "Person" || declared === "Organization") return declared;
  // Flickr imports read "<name> from <place>": the part before "from" is the photographer.
  const who = text(name).split(/\s+from\s+/i)[0];
  return ORG_WORDS.test(who) ? "Organization" : "Person";
}

/** Deed URL for a Creative Commons license name ("CC BY-SA 4.0", "CC0"); null when it is not a CC license. */
export function ccLicenseUrl(name: unknown): string | null {
  const n = text(name);
  if (/^CC0\b/i.test(n)) return "https://creativecommons.org/publicdomain/zero/1.0/";
  const m = n.match(/^CC\s+(BY(?:-NC)?(?:-SA|-ND)?)\s+(\d\.\d)\b/i);
  return m ? `https://creativecommons.org/licenses/${m[1].toLowerCase()}/${m[2]}/` : null;
}

type Licensed = Base & { author?: unknown; author_type?: unknown; license?: unknown; license_url?: unknown; source_page?: unknown };

/** A Creative Commons / public-domain photo with a recorded author. Without author or license it is held. */
export function licensedImage(b: Licensed): ImageMeta {
  const raw = text(b.author);
  const who = raw && raw.length <= 120 && !NOT_A_NAME.test(raw) ? raw : "";
  const lic = text(b.license);
  const page = text(b.source_page) || null;
  if (!who || !lic) return thirdPartyImage({ ...b, source_url: page || b.source_url });
  const credit = `${who} / ${lic}`;
  return {
    ...base({ ...b, source_url: page || b.source_url }),
    creator_name: who, creator_type: creatorTypeFor(who, b.author_type),
    copyrightNotice: credit, creditText: credit,
    license: text(b.license_url) || ccLicenseUrl(lic), acquireLicensePage: page,
    source_type: "cc_licensed", license_name: lic,
  };
}

type Third = Base & { creator?: unknown; creator_type?: unknown; copyrightNotice?: unknown; creditText?: unknown; license?: unknown; acquireLicensePage?: unknown };

/** Pixels PropBetEdge did not make and holds no recorded rights metadata for. */
export function thirdPartyImage(b: Third): ImageMeta {
  const who = text(b.creator);
  return {
    ...base(b),
    creator_name: who || null, creator_type: who ? creatorTypeFor(who, b.creator_type) : null,
    copyrightNotice: text(b.copyrightNotice) || null, creditText: text(b.creditText) || null,
    license: text(b.license) || null, acquireLicensePage: text(b.acquireLicensePage) || null,
    source_type: "third_party",
  };
}

/** A PropBetEdge-rendered card embedding `parts`; rights only when every part is owned or cc_licensed. */
export function compositeImage(b: Base & { year?: unknown; parts?: Array<ImageMeta | null | undefined> }): ImageMeta {
  const list = (b.parts || []).filter(Boolean) as ImageMeta[];
  if (list.some((p) => p.source_type !== "owned" && p.source_type !== "cc_licensed")) {
    return { ...base(b), source_type: "owned_composite", held: "embedded image rights unknown" };
  }
  const photos = list.filter((p) => p.source_type === "cc_licensed");
  const owned = ownedImage(b);
  if (!photos.length) return owned;
  const credits = [...new Set(photos.map((p) => p.copyrightNotice))];
  const label = credits.length > 1 ? "Photos" : "Photo";
  // ShareAlike photos make the card an adaptation under the same license.
  const sa = [...new Set(photos.filter((p) => /-SA\b/i.test(p.license_name || p.copyrightNotice || "")).map((p) => p.license).filter(Boolean))];
  const pages = [...new Set(photos.map((p) => p.acquireLicensePage).filter(Boolean))];
  return {
    ...owned,
    copyrightNotice: `${owned.copyrightNotice}. ${label}: ${credits.join("; ")}`,
    creditText: `${PBE_ORG_NAME} · ${label}: ${credits.join("; ")}`,
    license: sa.length === 1 ? sa[0] : null,
    acquireLicensePage: pages.length === 1 ? pages[0] : null,
    source_type: "owned_composite",
  };
}

export type ImageObjectLd = Record<string, unknown> & { "@type": "ImageObject"; url: string };

/** Normalized record → schema.org ImageObject. `extra` adds @id etc. */
export function imageObject(meta: ImageMeta | null | undefined, extra: Record<string, unknown> = {}): ImageObjectLd | undefined {
  if (!meta?.url) return undefined;
  const node: ImageObjectLd = { "@type": "ImageObject", ...extra, url: meta.url, contentUrl: meta.contentUrl || meta.url };
  if (meta.width) node.width = meta.width;
  if (meta.height) node.height = meta.height;
  if (meta.caption) node.caption = meta.caption;
  if (meta.creator_name) node.creator = { "@type": meta.creator_type || "Organization", name: meta.creator_name };
  if (meta.copyrightNotice) node.copyrightNotice = meta.copyrightNotice;
  if (meta.creditText) node.creditText = meta.creditText;
  if (meta.license) node.license = meta.license;
  if (meta.acquireLicensePage) node.acquireLicensePage = meta.acquireLicensePage;
  return node;
}

/* ---- UFC fighter media (PortraitSet from lib/db) -------------------------- */

type PortraitLike = {
  portrait: string; card?: string; license: string | null; author: string | null; source_url: string | null;
  kind?: string | null; source_family?: string | null; rights_label?: string | null;
};

/**
 * One fighter image as a record. Catalog rows (ufc_images: Commons / US-gov
 * public domain, author + license recorded) are credited to their author. The
 * ESPN display-only fallback — or anything without a recorded author and
 * license — is held.
 */
export function portraitImage(set: PortraitLike | null | undefined, b: Partial<Base> & { url?: string } = {}): ImageMeta | null {
  if (!set) return null;
  const url = b.url || set.portrait;
  const displayOnly = set.source_family === "espn" || set.rights_label === "display_only";
  if (displayOnly) return thirdPartyImage({ ...b, url });
  return licensedImage({ ...b, url, author: set.author, license: set.license, source_page: set.source_url });
}

/** Is this record's rights metadata known (so a full ImageObject is worth emitting)? */
export const isKnown = (meta: ImageMeta | null | undefined): meta is ImageMeta => Boolean(meta && meta.source_type !== "third_party" && !meta.held);
