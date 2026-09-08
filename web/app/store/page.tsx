import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, JsonLd } from "@/components/ui";
import { HoodieProductPreview } from "@/components/store/HoodieProductPreview";
import { LINES, launchProducts, unreleasedProducts } from "@/lib/store/catalog";
import { getProvisioning } from "@/lib/store/provisioning";
import { DROP001_SLUG, drop001RuntimeStatus } from "@/lib/store/release";
import { formatPrice, toStorefront, type StorefrontProduct } from "@/lib/store/types";
import { SITE } from "@/lib/site";

export const revalidate = 60;

const TITLE = "Store | PropBetEdge UFC";
const DESCRIPTION =
  "The first PropBetEdge merch drop: our premium black hoodie with the metallic PBE corporate logo on the chest and the fight mark on the sleeve.";

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

function Card({ p, enabled = false }: { p: StorefrontProduct; enabled?: boolean }) {
  const hoodie = p.slug === DROP001_SLUG;
  const onSale = enabled && p.purchasable;
  return (
    <Link href={`/store/${p.slug}`} className="st-card">
      <span className="st-art-frame">
        {hoodie ? (
          <HoodieProductPreview compact />
        ) : (
          <img className="st-art" src={p.images[0].url} alt={p.images[0].alt} width={p.images[0].width} height={p.images[0].height} loading="lazy" decoding="async" />
        )}
        <span className="st-form-tag">{FORM_LABEL[p.form] ?? p.form}</span>
      </span>
      <span className="st-card-body">
        <span className="st-card-name">{p.name}</span>
        <span className="st-card-blurb">
          {hoodie ? "Premium black fleece. Metallic PBE chest logo. Gold fight mark on the sleeve." : p.blurb}
        </span>
        <span className="st-card-foot">
          <span className="st-price">{formatPrice(p.price_cents)}</span>
          {onSale ? <span className="st-state st-state-open">On sale</span> : (
            <span className={p.awaiting_blank ? "st-soon st-soon-blank" : "st-soon"}>
              {p.awaiting_blank ? "Blank not chosen" : hoodie ? "Release gate" : p.unavailable_reason}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}

export default async function StorePage() {
  const [provisioning, runtime] = await Promise.all([
    getProvisioning(),
    Promise.resolve(drop001RuntimeStatus()),
  ]);
  const project = (d: Parameters<typeof toStorefront>[0]) => ({
    line: d.line,
    pub: toStorefront(d, provisioning.get(d.slug) ?? null),
  });

  const authoredLaunch = launchProducts("ufc").map(project);
  const firstDrop = authoredLaunch.filter(({ pub }) => pub.slug === DROP001_SLUG);
  const later = [
    ...unreleasedProducts("ufc").map(project),
    ...authoredLaunch.filter(({ pub }) => pub.slug !== DROP001_SLUG),
  ].sort((a, b) => a.pub.name.localeCompare(b.pub.name));
  const open = runtime.ready && firstDrop.some(({ pub }) => pub.purchasable);

  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow="Store · First drop"
            title="The hoodie first"
            lede="One piece worth shipping before we turn this into a catalog: the premium black PropBetEdge hoodie, built around the actual corporate mark."
            crumbs={[{ name: "Store" }]}
          />
        </div>
      </div>

      <div className="wrap">
        <p className={open ? "st-notice st-notice-quiet" : "st-notice"} role="status">
          {open ? (
            <><strong>The first drop is live.</strong> Black, S–2XL, $65. Checkout uses live Stripe and the exact printer-confirmed variant for the size you choose.</>
          ) : (
            <><strong>The hoodie is staged, not fake-live.</strong> The design, garment and $65 retail are locked. Checkout stays closed until the production runtime can prove Stripe, the printer credential, signed webhook, fulfilment gate, final art files and exact Black S–2XL provider variants.</>
          )}
        </p>
      </div>

      <section className="wrap st-section">
        <div className="st-section-head">
          <h2>Drop 001</h2>
          <p>Cotton Heritage M2580 · Black · S–2XL · full PBE chest logo + fight mark sleeve.</p>
        </div>
        <div className="st-grid st-grid-launch">
          {firstDrop.map(({ pub }) => <Card key={pub.slug} p={pub} enabled={runtime.ready} />)}
        </div>
      </section>

      {later.length > 0 && (
        <section className="wrap st-section">
          <div className="st-section-head">
            <h2>After the first hoodie</h2>
            <p>Designed and kept, but deliberately not part of the first paid production test.</p>
          </div>
          {LINES.map((c) => {
            const inLine = later.filter((i) => i.line === c.key);
            if (!inLine.length) return null;
            return (
              <div className="st-later" key={c.key}>
                <h3 className="st-later-head">{c.name}</h3>
                <div className="st-grid st-grid-later">
                  {inLine.map(({ pub }) => <Card key={pub.slug} p={pub} />)}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="wrap st-section">
        <p className="st-fine">
          The hoodie image is a placement preview using PropBetEdge's corporate logo and fight mark, not the printer's final garment photograph. The production file is kept separate and is only released after the printer reports the exact print areas. <Link href="/store/policies">Shipping, returns and print policies</Link>.
        </p>
      </section>

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: TITLE,
        description: DESCRIPTION,
        url: `${SITE.url}/store`,
        isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.url },
      }} />
    </>
  );
}
