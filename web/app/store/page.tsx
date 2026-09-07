import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, JsonLd } from "@/components/ui";
import { COLLECTIONS, productsFor } from "@/lib/store/catalog";
import { getProvisioning, anyPurchasable } from "@/lib/store/provisioning";
import { formatPrice, toStorefront, type StorefrontProduct } from "@/lib/store/types";
import { SITE } from "@/lib/site";

/* /store — the shop.
 *
 * It is displayable and not purchasable, and it says so at the top rather
 * than at the button. A store that looks finished and fails at checkout is
 * worse than one that is honest about its state, because the reader has by
 * then chosen a size.
 *
 * Purchasability is not a flag anybody sets by hand. It is derived, per
 * product, from whether the print provider has confirmed that exact product
 * exists — see lib/store/provisioning.ts. Nothing here can turn it on. */
export const revalidate = 60;

const TITLE = "Store | PropBetEdge UFC";
const DESCRIPTION =
  "PropBetEdge UFC merchandise: fight-intelligence tees, hoodies, caps and mugs. Printed on demand, shipped by our print partner.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/store" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    url: `${SITE.url}/store`,
    images: [{ url: `${SITE.url}/opengraph-image`, width: 1200, height: 630, alt: "PropBetEdge UFC Store" }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

function Card({ p }: { p: StorefrontProduct }) {
  return (
    <Link href={`/store/${p.slug}`} className="st-card">
      {/* The same file the shared catalog API hands the other storefront, so
          both shops show one image rather than each drawing their own. */}
      <img className="st-art" src={p.images[0].url} alt={p.images[0].alt} width={p.images[0].width} height={p.images[0].height} loading="lazy" decoding="async" />
      <span className="st-card-body">
        <span className="st-card-name">{p.name}</span>
        <span className="st-card-blurb">{p.blurb}</span>
        <span className="st-card-foot">
          <span className="st-price">{formatPrice(p.price_cents)}</span>
          {p.purchasable ? null : <span className="st-soon">{p.unavailable_reason}</span>}
        </span>
      </span>
    </Link>
  );
}

export default async function StorePage() {
  const provisioning = await getProvisioning();
  const products = productsFor("ufc").map((d) => toStorefront(d, provisioning.get(d.slug) ?? null));
  const open = anyPurchasable(provisioning);

  return (
    <>
      <PageHead
        eyebrow="Store"
        title="Wear the method"
        lede="Fight intelligence, printed on demand. No warehouse, no overstock, nothing made until somebody asks for it."
        crumbs={[{ name: "Home", href: "/" }, { name: "Store" }]}
      />

      {!open && (
        <div className="wrap">
          <p className="st-notice" role="status">
            <strong>The collection is not open yet.</strong> These are the designs, and the prices are the real ones.
            Checkout stays closed until every piece is confirmed with our print partner — we would rather show you the
            shop early than take an order we cannot fulfil.
          </p>
        </div>
      )}

      {COLLECTIONS.map((c) => {
        const items = products.filter((p) => p.collection === c.key);
        if (!items.length) return null;
        return (
          <section className="wrap st-section" key={c.key}>
            <div className="st-section-head">
              <h2>{c.name}</h2>
              <p>{c.blurb}</p>
            </div>
            <div className="st-grid">
              {items.map((p) => (
                <Card key={p.slug} p={p} />
              ))}
            </div>
          </section>
        );
      })}

      <section className="wrap st-section">
        <p className="st-fine">
          Product images on this page are design previews drawn as vector art, not photographs. Real garment mockups
          replace them once each piece is confirmed with the printer.{" "}
          <Link href="/store/policies">Shipping, returns and print policies</Link>.
        </p>
      </section>

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: TITLE,
          description: DESCRIPTION,
          url: `${SITE.url}/store`,
          isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.url },
        }}
      />
    </>
  );
}
