import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead, JsonLd } from "@/components/ui";
import { bySlug, productsFor } from "@/lib/store/catalog";
import { getProvisioning } from "@/lib/store/provisioning";
import { formatPrice, toStorefront } from "@/lib/store/types";
import { SITE } from "@/lib/site";

/* /store/[slug] — one product.
 *
 * The size and colour controls are rendered disabled while the piece is
 * unconfirmed, rather than hidden. Hiding them would leave a page that looks
 * like a lookbook; disabling them shows exactly what will be on offer and why
 * it is not yet. */
export const revalidate = 60;
export const dynamicParams = false;

export function generateStaticParams() {
  return productsFor("ufc").map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const def = bySlug(slug);
  if (!def) return { title: { absolute: "Not found | PropBetEdge UFC" } };
  const title = `${def.name} | PropBetEdge UFC Store`;
  return {
    title: { absolute: title },
    description: def.description,
    alternates: { canonical: `/store/${def.slug}` },
    openGraph: {
      title,
      description: def.description,
      type: "website",
      url: `${SITE.url}/store/${def.slug}`,
      images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630, alt: def.name }],
    },
    twitter: { card: "summary_large_image", title, description: def.description },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const def = bySlug(slug);
  if (!def || !def.sites.includes("ufc")) notFound();

  const provisioning = await getProvisioning();
  const p = toStorefront(def, provisioning.get(def.slug) ?? null);

  return (
    <>
      <PageHead
        eyebrow="Store"
        title={p.name}
        lede={p.blurb}
        crumbs={[{ name: "Home", href: "/" }, { name: "Store", href: "/store" }, { name: p.name }]}
      />

      <section className="wrap st-detail">
        <div className="st-detail-art">
          <img className="st-art" src={p.images[0].url} alt={p.images[0].alt} width={p.images[0].width} height={p.images[0].height} />
          <p className="st-fine">Design preview, not a photograph.</p>
        </div>

        <div className="st-detail-body">
          <p className="st-price st-price-lg">{formatPrice(p.price_cents)}</p>
          <p className="st-desc">{p.description}</p>

          <fieldset className="st-opts" disabled={!p.purchasable}>
            <legend className="st-opt-label">Size</legend>
            <div className="st-chips">
              {p.sizes.map((s) => (
                <span className="st-chip" key={s}>
                  {s}
                </span>
              ))}
            </div>
            <legend className="st-opt-label">Colour</legend>
            <div className="st-chips">
              {p.colors.map((c) => (
                <span className="st-chip" key={c}>
                  {c}
                </span>
              ))}
            </div>
          </fieldset>

          {p.purchasable ? (
            <p className="st-notice" role="status">
              Checkout is being wired. This piece is confirmed with the printer.
            </p>
          ) : (
            <p className="st-notice" role="status">
              <strong>Not on sale yet.</strong> {p.unavailable_reason} We publish the design and the price before the
              button works, so nothing about this page changes when it does.
            </p>
          )}

          <p className="st-fine">
            Printed and shipped on demand by our print partner. <Link href="/store/policies">Shipping and returns</Link>.
          </p>
        </div>
      </section>

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Product",
          name: p.name,
          description: p.description,
          url: `${SITE.url}/store/${p.slug}`,
          brand: { "@type": "Brand", name: "PropBetEdge" },
          image: p.images.map((i) => `${SITE.url}${i.url}`),
          offers: {
            "@type": "Offer",
            price: (p.price_cents / 100).toFixed(2),
            priceCurrency: "USD",
            url: `${SITE.url}/store/${p.slug}`,
            /* PreOrder would promise a date we do not have. OutOfStock is the
             * accurate reading of a product that cannot currently be bought. */
            availability: p.purchasable ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          },
        }}
      />
    </>
  );
}
