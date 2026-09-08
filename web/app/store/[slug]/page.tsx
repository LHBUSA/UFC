import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead, JsonLd } from "@/components/ui";
import { HoodieProductPreview } from "@/components/store/HoodieProductPreview";
import { bySlug, productsFor } from "@/lib/store/catalog";
import { getProvisioning } from "@/lib/store/provisioning";
import { DROP001_COLOR, DROP001_SIZES, DROP001_SLUG, drop001RuntimeStatus } from "@/lib/store/release";
import { formatPrice, toStorefront } from "@/lib/store/types";
import { AddToCart } from "@/components/store/AddToCart";
import { SITE } from "@/lib/site";
import styles from "./product.module.css";

export const revalidate = 60;
export const dynamicParams = false;

const HOODIE_IMAGE = "/store/img/propbetedge-premium-hoodie.jpg";
const HOODIE_DESCRIPTION =
  "The first PropBetEdge hoodie is built on the Cotton Heritage M2580: substantial 8.5 oz fleece, a soft 100% cotton face, 3-panel hood and front pouch pocket. Finished in black with the full metallic PBE / PropBetEdge.ai chest logo and a smaller gold fight mark on the sleeve.";

export function generateStaticParams() {
  return productsFor("ufc").map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const def = bySlug(slug);
  if (!def) return { title: { absolute: "Not found | PropBetEdge UFC" } };
  const title = slug === DROP001_SLUG ? "PropBetEdge Premium Hoodie | Drop 001" : `${def.name} | PropBetEdge UFC Store`;
  const description = slug === DROP001_SLUG ? HOODIE_DESCRIPTION : def.description;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: `/store/${def.slug}` },
    openGraph: {
      title,
      description,
      type: "website",
      url: `${SITE.url}/store/${def.slug}`,
      images: slug === DROP001_SLUG
        ? [{ url: `${SITE.url}${HOODIE_IMAGE}`, width: 400, height: 500, alt: "PropBetEdge Premium Hoodie" }]
        : [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630, alt: def.name }],
    },
    twitter: { card: "summary_large_image", title, description },
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
  const p = toStorefront(def, provisioning.get(def.slug) ?? null);
  const hoodie = p.slug === DROP001_SLUG;
  const sizes = hoodie ? p.sizes.filter((s) => DROP001_SIZES.includes(s as (typeof DROP001_SIZES)[number])) : p.sizes;
  const colors = hoodie ? [DROP001_COLOR] : p.colors;
  const description = hoodie ? HOODIE_DESCRIPTION : p.description;
  const saleOpen = hoodie ? p.purchasable && runtime.ready : false;

  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow={hoodie ? "PropBetEdge Premium Hoodie · Drop 001" : "Store"}
            title={hoodie ? "Built for fight night." : p.name}
            lede={hoodie
              ? "Premium black fleece, metallic PBE across the chest and the gold fight mark on the sleeve. Made on demand and built to be worn."
              : p.blurb}
            crumbs={[{ name: "Store", href: "/store" }, { name: p.name }]}
          />
        </div>
      </div>

      <section className={`wrap st-detail${hoodie ? ` ${styles.hoodieDetail}` : ""}`}>
        <div className={`st-detail-art${hoodie ? ` ${styles.hoodieArt}` : ""}`}>
          {hoodie ? (
            <HoodieProductPreview />
          ) : (
            <img className="st-art" src={p.images[0].url} alt={p.images[0].alt} width={p.images[0].width} height={p.images[0].height} />
          )}
          <p className="st-fine">
            {hoodie ? "Product preview. Final print placement may vary slightly by size." : "Design preview, not a photograph."}
          </p>
        </div>

        <div className="st-detail-body">
          <p className={saleOpen ? "st-state st-state-open" : "st-state"}>
            {saleOpen ? "Ready to order" : hoodie ? "Drop 001 coming soon" : p.awaiting_blank ? "Blank not chosen" : "Not released"}
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

          <AddToCart
            slug={p.slug}
            sizes={sizes}
            colors={colors}
            purchasable={saleOpen}
            reason={hoodie && !saleOpen ? "We’re finishing the final production check before opening Drop 001 orders." : p.unavailable_reason}
          />

          {!saleOpen && hoodie && (
            <p className="st-notice st-notice-quiet" role="status">
              <strong>Drop 001 is almost ready.</strong>{" "}
              We are finishing the last production check before taking orders so the first hoodie ships exactly as shown.
            </p>
          )}

          <p className="st-meta">
            <span>Printed on demand</span>
            <span>{sizes.length > 1 ? `${sizes.length} sizes` : sizes[0]}</span>
            <span>{colors.join(" / ")}</span>
            {hoodie && <span>Ships from our print partner</span>}
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
        image: hoodie ? [`${SITE.url}${HOODIE_IMAGE}`] : p.images.map((i) => `${SITE.url}${i.url}`),
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
