import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead, JsonLd } from "@/components/ui";
import { HoodieProductPreview } from "@/components/store/HoodieProductPreview";
import { liveBySlug } from "@/lib/store/live-products";
import { approvedMockup } from "@/lib/store/display";
import { getProvisioning } from "@/lib/store/provisioning";
import { drop001RuntimeStatus } from "@/lib/store/release";
import {
  DROP001_SLUG,
  FIGHT_DNA_TEE_SLUG,
  PBE_MUG_SLUG,
  TALE_OF_TAPE_HOODIE_SLUG,
  PBE_CLASSIC_HAT_SLUG,
  TRUST_DATA_MUG_SLUG,
  isActiveReleaseSlug,
  releaseOptions,
  releaseProvisioningReady,
} from "@/lib/store/release-policy";
import { formatPrice, toStorefront } from "@/lib/store/types";
import { AddToCart } from "@/components/store/AddToCart";
import { SITE } from "@/lib/site";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DROP002_SLUGS = new Set([FIGHT_DNA_TEE_SLUG, PBE_MUG_SLUG]);
const DROP003_SLUGS = new Set([TALE_OF_TAPE_HOODIE_SLUG, PBE_CLASSIC_HAT_SLUG, TRUST_DATA_MUG_SLUG]);

const DESCRIPTION: Record<string, string> = {
  [DROP001_SLUG]: "A premium black Cotton Heritage M2580 pullover built for fight night: full metallic PBE / PropBetEdge.ai logo across the chest, gold fight mark on the sleeve, 8.5 oz fleece, 65% ring-spun cotton and 35% polyester with a 100% cotton face.",
  [FIGHT_DNA_TEE_SLUG]: "A black Fight DNA tee built around the way PropBetEdge reads a matchup: pace, output, defence and finishing behaviour. The metallic DNA mark carries PropBetEdge directly in the design.",
  [PBE_MUG_SLUG]: "An 11 oz black glossy ceramic mug carrying the same full metallic PBE / PropBetEdge.ai house logo used on the premium hoodie.",
  [TALE_OF_TAPE_HOODIE_SLUG]: "A black premium Cotton Heritage M2580 hoodie carrying the Tale of the Tape fight-intelligence graphic: striking, grappling, cardio, defense and intangibles, finished with Different Fighters. Same Data. and PropBetEdge branding.",
  [PBE_CLASSIC_HAT_SLUG]: "A black Yupoong 6245CM classic dad hat with the PropBetEdge house identity embroidered in gold across the front. One size, adjustable, clean enough for every day and unmistakably PBE.",
  [TRUST_DATA_MUG_SLUG]: "An 11 oz black glossy ceramic mug built around the PropBetEdge editorial position: Trust the Data. Gold-and-white fight intelligence artwork wraps the cup with Less Opinions. More Winning. and the PBE mark.",
};

function drop003Image(slug: string) {
  if (!DROP003_SLUGS.has(slug)) return null;
  return { url: `/store/product-photo/${slug}`, width: 720, height: 900, alt: `${liveBySlug(slug)?.name ?? "PropBetEdge product"} product image` };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const def = liveBySlug(slug);
  if (!def) return { title: { absolute: "Not found | PropBetEdge UFC" } };
  const title = `${def.name} | PropBetEdge UFC Store`;
  const description = DESCRIPTION[slug] ?? def.description;
  const productPhoto = drop003Image(slug);
  const mockup = approvedMockup(slug);
  const image = productPhoto
    ? { url: `${SITE.url}${productPhoto.url}`, width: productPhoto.width, height: productPhoto.height, alt: productPhoto.alt }
    : slug === DROP001_SLUG
      ? { url: `${SITE.url}/store/img/propbetedge-premium-hoodie.jpg`, width: 400, height: 500, alt: def.name }
      : mockup
        ? { url: `${SITE.url}${mockup.url}`, width: mockup.width, height: mockup.height, alt: mockup.alt }
        : { url: `${SITE.url}/store/img/${def.slug}-v2.svg`, width: 480, height: 600, alt: def.name };
  return {
    title: { absolute: title }, description, alternates: { canonical: `/store/${def.slug}` },
    openGraph: { title, description, type: "website", url: `${SITE.url}/store/${def.slug}`, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const def = liveBySlug(slug);
  if (!def || !def.sites.includes("ufc")) notFound();

  const [provisioning, runtime] = await Promise.all([getProvisioning(), Promise.resolve(drop001RuntimeStatus())]);
  const rec = provisioning.get(def.slug) ?? null;
  const p = toStorefront(def, rec);
  const hoodie = p.slug === DROP001_SLUG;
  const drop002 = DROP002_SLUGS.has(p.slug);
  const drop003 = DROP003_SLUGS.has(p.slug);
  const release = releaseOptions(p.slug);
  const sizes = release?.sizes ?? p.sizes;
  const colors = release?.colors ?? p.colors;
  const description = DESCRIPTION[p.slug] ?? p.description;
  const saleOpen = isActiveReleaseSlug(p.slug) && runtime.ready && releaseProvisioningReady(p.slug, rec);
  const eyebrow = hoodie ? "PropBetEdge Store · Drop 001" : drop002 ? "PropBetEdge Store · Drop 002" : drop003 ? "PropBetEdge Store · Drop 003" : "PropBetEdge Store · Merch Lab";
  const lede = p.slug === TALE_OF_TAPE_HOODIE_SLUG
    ? "Different fighters. Same data. The full Tale of the Tape read, built into a premium black hoodie."
    : p.slug === PBE_CLASSIC_HAT_SLUG
      ? "Clean look. Sharp mind. Gold PBE embroidery on the classic black dad hat."
      : p.slug === TRUST_DATA_MUG_SLUG
        ? "Trust the data. Less opinions. More winning. Black ceramic for the bettor's desk."
        : p.slug === FIGHT_DNA_TEE_SLUG
          ? "Fight DNA in black and gold — the matchup method turned into the strongest wearable in the collection."
          : p.slug === PBE_MUG_SLUG
            ? "The full PBE house mark on black ceramic — built for the desk, the recap and the next card."
            : p.blurb;

  const productPhoto = drop003Image(p.slug);
  const mockup = approvedMockup(p.slug);
  const displayImage = productPhoto ?? mockup ?? p.images[0];

  return (
    <>
      <div className="wrap"><div className="page"><PageHead eyebrow={eyebrow} title={p.name} lede={lede} crumbs={[{ name: "Store", href: "/store" }, { name: p.name }]} /></div></div>
      <section className="wrap st-detail">
        <div className="st-detail-art">
          {hoodie ? <HoodieProductPreview /> : <img className="st-art" src={displayImage.url} alt={displayImage.alt} width={displayImage.width} height={displayImage.height} />}
          <p className="st-fine">Product image shows the released design. Final print or embroidery position can vary slightly in production.</p>
        </div>
        <div className="st-detail-body">
          <p className={saleOpen ? "st-state st-state-open" : "st-state"}>{saleOpen ? "On sale" : "Checkout temporarily unavailable"}</p>
          <p className="st-price st-price-lg">{formatPrice(p.price_cents)}</p>
          <p className="st-desc">{description}</p>

          {(hoodie || p.slug === TALE_OF_TAPE_HOODIE_SLUG) && <p className="st-meta"><span>Cotton Heritage M2580</span><span>8.5 oz fleece</span><span>Black</span><span>S-2XL</span><span>Front print</span></p>}
          {p.slug === FIGHT_DNA_TEE_SLUG && <p className="st-meta"><span>Bella + Canvas 3001</span><span>Black</span><span>S-2XL</span><span>Front print</span></p>}
          {(p.slug === PBE_MUG_SLUG || p.slug === TRUST_DATA_MUG_SLUG) && <p className="st-meta"><span>Black glossy ceramic</span><span>11 oz</span><span>Full-colour wrap</span></p>}
          {p.slug === PBE_CLASSIC_HAT_SLUG && <p className="st-meta"><span>Yupoong 6245CM</span><span>Black</span><span>One size · adjustable</span><span>Front embroidery</span></p>}

          <AddToCart slug={p.slug} sizes={sizes} colors={colors} purchasable={saleOpen} reason={saleOpen ? null : isActiveReleaseSlug(p.slug) ? "Checkout is temporarily unavailable for this release item." : (p.unavailable_reason ?? null)} />

          {!saleOpen && <p className="st-notice" role="status"><strong>Live product, checkout temporarily unavailable.</strong> Refresh shortly while the live fulfillment state catches up.</p>}

          <p className="st-meta"><span>Made on demand</span><span>{sizes.length > 1 ? `${sizes.length} sizes` : sizes[0]}</span><span>{colors.join(" / ")}</span>{isActiveReleaseSlug(p.slug) && <span>Ships direct from our print partner</span>}</p>
          <p className="st-fine">Made and shipped on demand by our fulfillment partner. <Link href="/store/policies">Shipping and returns</Link>.</p>
        </div>
      </section>
      <JsonLd data={{ "@context": "https://schema.org", "@type": "Product", name: p.name, description, url: `${SITE.url}/store/${p.slug}`, brand: { "@type": "Brand", name: "PropBetEdge" }, image: [`${SITE.url}${displayImage.url}`], offers: { "@type": "Offer", price: (p.price_cents / 100).toFixed(2), priceCurrency: "USD", url: `${SITE.url}/store/${p.slug}`, availability: saleOpen ? "https://schema.org/InStock" : "https://schema.org/OutOfStock" } }} />
    </>
  );
}
