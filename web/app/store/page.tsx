import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, JsonLd } from "@/components/ui";
import { LINES, productsFor } from "@/lib/store/catalog";
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
  "PropBetEdge UFC merchandise: Fight DNA, Tale of the Tape and analytics designs on tees, hoodies, caps and mugs. Printed on demand, shipped by our print partner.";

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
  const items = productsFor("ufc").map((d) => ({ line: d.line, pub: toStorefront(d, provisioning.get(d.slug) ?? null) }));
  const open = anyPurchasable(provisioning);
  const awaiting = items.filter((i) => i.pub.awaiting_blank);

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

      {awaiting.length > 0 && (
        <div className="wrap">
          {/* Named rather than hidden. The caps are designed and priced; what
              is missing is the blank, and several catalog hats match our
              search equally well. Picking one on a hunch prints the wrong hat
              and nobody finds out until it arrives. */}
          <p className="st-notice st-notice-quiet" role="status">
            <strong>The caps are last.</strong> {awaiting.length} pieces are drawn and priced but not yet matched to a
            blank at the printer — several candidates fit our specification equally well, and we would rather choose
            deliberately than embroider the wrong hat.
          </p>
        </div>
      )}

      {LINES.map((c) => {
        const inLine = items.filter((i) => i.line === c.key);
        if (!inLine.length) return null;
        return (
          <section className="wrap st-section" key={c.key}>
            <div className="st-section-head">
              <h2>{c.name}</h2>
              <p>{c.blurb}</p>
            </div>
            <div className="st-grid">
              {inLine.map(({ pub }) => (
                <Card key={pub.slug} p={pub} />
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
