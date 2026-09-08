import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, JsonLd } from "@/components/ui";
import { LINES, launchProducts, unreleasedProducts } from "@/lib/store/catalog";
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
 * exists — see lib/store/provisioning.ts. Nothing here can turn it on.
 *
 * Sections are design lines, not collections. `collection` is part of the
 * contract the other storefront reads; how this shop lays itself out is our
 * own business, and grouping by it would have put a Fight DNA mug and a
 * spreadsheet joke under one heading because they share a shelf. */
export const revalidate = 60;

const TITLE = "Store | PropBetEdge UFC";
const DESCRIPTION =
  "PropBetEdge merchandise: the logo tee, the premium hoodie and the mug, carrying the house mark. Printed on demand, shipped by our print partner.";

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

const FORM_LABEL: Record<string, string> = { tee: "Tee", hoodie: "Hoodie", cap: "Cap", mug: "Mug" };

function Card({ p }: { p: StorefrontProduct }) {
  return (
    <Link href={`/store/${p.slug}`} className="st-card">
      {/* The same file the shared catalog API hands the other storefront, so
          both shops show one image rather than each drawing their own. */}
      <span className="st-art-frame">
        <img className="st-art" src={p.images[0].url} alt={p.images[0].alt} width={p.images[0].width} height={p.images[0].height} loading="lazy" decoding="async" />
        <span className="st-form-tag">{FORM_LABEL[p.form] ?? p.form}</span>
      </span>
      <span className="st-card-body">
        <span className="st-card-name">{p.name}</span>
        <span className="st-card-blurb">{p.blurb}</span>
        <span className="st-card-foot">
          <span className="st-price">{formatPrice(p.price_cents)}</span>
          {p.purchasable ? null : (
            <span className={p.awaiting_blank ? "st-soon st-soon-blank" : "st-soon"}>
              {p.awaiting_blank ? "Blank not chosen" : p.unavailable_reason}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}

export default async function StorePage() {
  const provisioning = await getProvisioning();
  /* Grouped on the definition, projected for rendering. `line` deliberately
   * does not exist on StorefrontProduct: it decides how this page is laid
   * out, and putting it in the projection would add it to the contract the
   * other storefront reads for no reason other than convenience here. */
  const project = (d: Parameters<typeof toStorefront>[0]) => ({
    line: d.line,
    pub: toStorefront(d, provisioning.get(d.slug) ?? null),
  });
  const launch = launchProducts("ufc").map(project);
  const later = unreleasedProducts("ufc").map(project);
  const open = anyPurchasable(provisioning);

  return (
    <>
      {/* .page is a padding shorthand declared after .wrap, so the two
          cannot share an element without losing the gutter. */}
      <div className="wrap">
        <div className="page">
        <PageHead
        eyebrow="Store"
        title="Wear the method"
        lede="Fight intelligence, printed on demand. No warehouse, no overstock, nothing made until somebody asks for it."
        crumbs={[{ name: "Store" }]}
        />
        </div>
      </div>

      {!open && (
        <div className="wrap">
          <p className="st-notice" role="status">
            <strong>The collection is not open yet.</strong> These are the designs, and the prices are the real ones.
            Checkout stays closed until every piece is confirmed with our print partner — we would rather show you the
            shop early than take an order we cannot fulfil.
          </p>
        </div>
      )}

      <section className="wrap st-section">
        <div className="st-section-head">
          <h2>The collection</h2>
          <p>Three pieces, the house mark, and nothing we cannot make.</p>
        </div>
        <div className="st-grid st-grid-launch">
          {launch.map(({ pub }) => (
            <Card key={pub.slug} p={pub} />
          ))}
        </div>
      </section>

      {later.length > 0 && (
        <section className="wrap st-section">
          <div className="st-section-head">
            <h2>In the works</h2>
            <p>
              Designed and kept. These are not part of the launch, and some are waiting on a blank we have not chosen.
            </p>
          </div>
          {/* Grouped by design family rather than shown as one long list, so
              "not yet" still reads as a plan instead of as a backlog. */}
          {LINES.map((c) => {
            const inLine = later.filter((i) => i.line === c.key);
            if (!inLine.length) return null;
            return (
              <div className="st-later" key={c.key}>
                <h3 className="st-later-head">{c.name}</h3>
                <div className="st-grid st-grid-later">
                  {inLine.map(({ pub }) => (
                    <Card key={pub.slug} p={pub} />
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}

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
