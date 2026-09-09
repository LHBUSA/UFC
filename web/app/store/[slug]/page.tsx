import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead, JsonLd } from "@/components/ui";
import { HoodieProductPreview } from "@/components/store/HoodieProductPreview";
import { bySlug } from "@/lib/store/catalog";
import { approvedMockup } from "@/lib/store/display";
import { getProvisioning } from "@/lib/store/provisioning";
import { drop001RuntimeStatus } from "@/lib/store/release";
import {
  DROP001_SLUG,
  FIGHT_DNA_TEE_SLUG,
  PBE_MUG_SLUG,
  isActiveReleaseSlug,
  releaseOptions,
  releaseProvisioningReady,
} from "@/lib/store/release-policy";
import { formatPrice, toStorefront } from "@/lib/store/types";
import { AddToCart } from "@/components/store/AddToCart";
import { SITE } from "@/lib/site";

/* Product availability depends on live provisioning state. Do not prerender a
 * stale "Final verification" state into the release pages after the exact
 * Printful variants have been reconciled. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const DROP002_SLUGS = new Set([FIGHT_DNA_TEE_SLUG, PBE_MUG_SLUG]);

const HOODIE_DESCRIPTION =
  "A premium black Cotton Heritage M2580 pullover built for fight night: full metallic PBE / PropBetEdge.ai logo across the chest, gold fight mark on the sleeve, 8.5 oz fleece, 65% ring-spun cotton and 35% polyester with a 100% cotton face, 3-panel hood and front pouch pocket.";

const DROP002_DESCRIPTION: Record<string, string> = {
  [FIGHT_DNA_TEE_SLUG]:
    "A black Fight DNA tee built around the way PropBetEdge reads a matchup: pace, output, defence and finishing behaviour. The metallic DNA mark carries PropBetEdge directly in the design instead of turning the shirt into a generic fight graphic.",
  [PBE_MUG_SLUG]:
    "An 11 oz black glossy ceramic mug carrying the same full metallic PBE / PropBetEdge.ai house logo used on the premium hoodie. Built for the morning card read, the late recap and the spreadsheet that never really closes.",
};

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const def = bySlug(slug);
  if (!def) return { title: { absolute: "Not found | PropBetEdge UFC" } };
  const title = `${def.name} | PropBetEdge UFC Store`;
  const description = slug === DROP001_SLUG ? HOODIE_DESCRIPTION : DROP002_DESCRIPTION[slug] ?? def.description;
  const mockup = approvedMockup(slug);
  const image = slug === DROP001_SLUG
    ? { url: `${SITE.url}/store/img/propbetedge-premium-hoodie.jpg`, width: 400, height: 500, alt: def.name }
    : mockup
      ? { url: `${SITE.url}${mockup.url}`, width: mockup.width, height: mockup.height, alt: mockup.alt }
      : { url: `${SITE.url}/store/img/${def.slug}-v2.svg`, width: 480, height: 600, alt: def.name };
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: `/store/${def.slug}` },
    openGraph: {
      title,
      description,
      type: "website",
      url: `${SITE.url}/store/${def.slug}`,
      images: [image],
    },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const def = bySlug(slug);
  if (!def || !def.sites.includes("ufc")) notFound();

  const [provisioning, runtime] = await Promise.all([
    getProvisioning(),
    Promise.resolve(drop001RuntimeStatus()),
  ]);
  const rec = provisioning.get(def.slug) ?? null;
  const p = toStorefront(def, rec);
  const hoodie = p.slug === DROP001_SLUG;
  const drop002 = DROP002_SLUGS.has(p.slug);
  const release = releaseOptions(p.slug);
  const sizes = release?.sizes ?? p.sizes;
  const colors = release?.colors ?? p.colors;
  const description = hoodie ? HOODIE_DESCRIPTION : DROP002_DESCRIPTION[p.slug] ?? p.description;
  const saleOpen = isActiveReleaseSlug(p.slug) && runtime.ready && releaseProvisioningReady(p.slug, rec);
  const eyebrow = hoodie ? "PropBetEdge Store · Drop 001" : drop002 ? "PropBetEdge Store · Drop 002" : "PropBetEdge Store · Merch Lab";
  const lede = hoodie
    ? "Premium fleece. Metallic PBE across the chest. Gold fight mark on the sleeve."
    : p.slug === FIGHT_DNA_TEE_SLUG
      ? "Fight DNA in black and gold — the matchup method turned into the strongest wearable in the collection."
      : p.slug === PBE_MUG_SLUG
        ? "The full PBE house mark on black ceramic — built for the desk, the recap and the next card."
        : p.blurb;
  const mockup = approvedMockup(p.slug);
  const displayImage = mockup ?? p.images[0];

  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow={eyebrow}
            title={p.name}
            lede={lede}
            crumbs={[{ name: "Store", href: "/store" }, { name: p.name }]}
          />
        </div>
      </div>

      <section className="wrap st-detail">
        <div className="st-detail-art">
          {hoodie ? (
            <HoodieProductPreview />
          ) : (
            <img className="st-art" src={displayImage.url} alt={displayImage.alt} width={displayImage.width} height={displayImage.height} />
          )}
          <p className="st-fine">
            {hoodie
              ? "Product image shown for design and placement. Final print position may vary slightly."
              : mockup
                ? "Approved product mockup. Final print position may vary slightly in production."
                : "Design preview, not a photograph."}
          </p>
        </div>

        <div className="st-detail-body">
          <p className={saleOpen ? "st-state st-state-open" : "st-state"}>
            {saleOpen ? "On sale" : drop002 ? "Drop 002 · Final verification" : "Coming soon"}
          </p>
          <p className="st-price st-price-lg">{formatPrice(p.price_cents)}</p>
          <p className="st-desc">{description}</p>

          {hoodie && (
            <p className="st-meta" aria-label="Hoodie specifications">
              <span>Cotton Heritage M2580</span>
              <span>8.5 oz fleece</span>
              <span>65/35 cotton-poly</span>
              <span>100% cotton face</span>
              <span>3-panel hood</span>
              <span>Black</span>
            </p>
          )}
          {p.slug === FIGHT_DNA_TEE_SLUG && (
            <p className="st-meta" aria-label="Fight DNA tee specifications">
              <span>Bella + Canvas 3001</span>
              <span>Black</span>
              <span>S-2XL</span>
              <span>Front print</span>
            </p>
          )}
          {p.slug === PBE_MUG_SLUG && (
            <p className="st-meta" aria-label="PBE mug specifications">
              <span>Black glossy ceramic</span>
              <span>11 oz</span>
              <span>Full-colour sublimation</span>
            </p>
          )}

          <AddToCart
            slug={p.slug}
            sizes={sizes}
            colors={colors}
            purchasable={saleOpen}
            reason={saleOpen ? null : isActiveReleaseSlug(p.slug) ? "Checkout is temporarily unavailable for this release item." : (p.unavailable_reason ?? null)}
          />

          {!saleOpen && (
            <p className="st-notice" role="status">
              <strong>{drop002 ? "Drop 002 checkout is temporarily unavailable." : hoodie ? "Drop 001 checkout is temporarily unavailable." : "Coming soon."}</strong>{" "}
              {isActiveReleaseSlug(p.slug)
                ? "This product is part of the active release. Refresh shortly while the live fulfillment state catches up."
                : p.unavailable_reason}
            </p>
          )}

          <p className="st-meta">
            <span>Printed on demand</span>
            <span>{sizes.length > 1 ? `${sizes.length} sizes` : sizes[0]}</span>
            <span>{colors.join(" / ")}</span>
            {isActiveReleaseSlug(p.slug) && <span>Ships direct from our print partner</span>}
          </p>

          <p className="st-fine">
            Printed and shipped on demand by our print partner. <Link href="/store/policies">Shipping and returns</Link>.
          </p>
        </div>
      </section>

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "Product",
        name: p.name,
        description,
        url: `${SITE.url}/store/${p.slug}`,
        brand: { "@type": "Brand", name: "PropBetEdge" },
        image: hoodie
          ? [`${SITE.url}/store/img/propbetedge-premium-hoodie.jpg`]
          : [`${SITE.url}${displayImage.url}`],
        ...(hoodie ? { material: "65% ring-spun cotton, 35% polyester; 100% cotton face" } : {}),
        offers: {
          "@type": "Offer",
          price: (p.price_cents / 100).toFixed(2),
          priceCurrency: "USD",
          url: `${SITE.url}/store/${p.slug}`,
          availability: saleOpen ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        },
      }} />
    </>
  );
}
