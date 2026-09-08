import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHead, JsonLd } from "@/components/ui";
import { bySlug, productsFor } from "@/lib/store/catalog";
import { getProvisioning } from "@/lib/store/provisioning";
import { formatPrice, toStorefront } from "@/lib/store/types";
import { AddToCart } from "@/components/store/AddToCart";
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
      {/* .page is a padding shorthand declared after .wrap, so the two
          cannot share an element without losing the gutter. */}
      <div className="wrap">
        <div className="page">
        <PageHead
        eyebrow="Store"
        title={p.name}
        lede={p.blurb}
        crumbs={[{ name: "Store", href: "/store" }, { name: p.name }]}
        />
        </div>
      </div>

      <section className="wrap st-detail">
        <div className="st-detail-art">
          <img className="st-art" src={p.images[0].url} alt={p.images[0].alt} width={p.images[0].width} height={p.images[0].height} />
          <p className="st-fine">Design preview, not a photograph.</p>
        </div>

        <div className="st-detail-body">
          <p className={p.purchasable ? "st-state st-state-open" : "st-state"}>
            {p.purchasable ? "On sale" : p.awaiting_blank ? "Blank not chosen" : "Not released"}
          </p>
          <p className="st-price st-price-lg">{formatPrice(p.price_cents)}</p>
          <p className="st-desc">{p.description}</p>

          {/* The one interactive control in the shop. `purchasable` is
              derived on the server from what the provider confirmed; nothing
              in the client can turn it on, and /api/store/checkout derives it
              again on the assumption this component was bypassed. */}
          <AddToCart
            slug={p.slug}
            sizes={p.sizes}
            colors={p.colors}
            purchasable={p.purchasable}
            reason={p.unavailable_reason}
          />

          {p.purchasable ? null : p.awaiting_blank ? (
            /* Said plainly, because it is not the same as "coming soon". The
             * design is finished; what is missing is the blank it prints on,
             * and several candidates at the printer fit our specification
             * equally well. Choosing on a hunch embroiders the wrong hat. */
            <p className="st-notice" role="status">
              <strong>Not on sale yet.</strong> {p.unavailable_reason} Several blanks at our printer match this
              specification equally well, and we would rather pick deliberately than send you the wrong one.
            </p>
          ) : (
            <p className="st-notice" role="status">
              <strong>Not on sale yet.</strong> {p.unavailable_reason} We publish the design and the price before the
              button works, so nothing about this page changes when it does.
            </p>
          )}

          <p className="st-meta">
            <span>Printed on demand</span>
            <span>{p.sizes.length > 1 ? `${p.sizes.length} sizes` : p.sizes[0]}</span>
            <span>{p.colors.join(" / ")}</span>
          </p>

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
