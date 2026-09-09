import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, JsonLd } from "@/components/ui";
import { HoodieProductPreview } from "@/components/store/HoodieProductPreview";
import { LINES, launchProducts, unreleasedProducts } from "@/lib/store/catalog";
import { getProvisioning } from "@/lib/store/provisioning";
import { DROP001_SLUG, drop001ProvisioningReady, drop001RuntimeStatus } from "@/lib/store/release";
import { formatPrice, toStorefront, type StorefrontProduct } from "@/lib/store/types";
import { SITE } from "@/lib/site";

export const revalidate = 60;

const TITLE = "PropBetEdge Store | Premium Fight-Night Gear";
const DESCRIPTION =
  "Shop PropBetEdge fight-night gear: the premium PBE hoodie, Fight DNA tee, PBE mug and bettor-first designs built around the same intelligence platform.";
const DROP002_SLUGS = new Set(["fight-dna-tee", "propbetedge-mug"]);

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/store" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    url: `${SITE.url}/store`,
    images: [{ url: `${SITE.url}/store/img/propbetedge-premium-hoodie.jpg`, width: 400, height: 500, alt: "PropBetEdge Premium Hoodie" }],
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

const FORM_LABEL: Record<string, string> = { tee: "Tee", hoodie: "Hoodie", cap: "Cap", mug: "Mug" };

function Card({ p, enabled = false, stateLabel }: { p: StorefrontProduct; enabled?: boolean; stateLabel?: string }) {
  const hoodie = p.slug === DROP001_SLUG;
  const onSale = hoodie ? enabled : enabled && p.purchasable;
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
          {onSale ? <span className="st-state st-state-open">On sale</span> : <span className="st-soon">{stateLabel ?? "Coming soon"}</span>}
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

  const all = [
    ...launchProducts("ufc").map(project),
    ...unreleasedProducts("ufc").map(project),
  ];
  const firstDrop = all.filter(({ pub }) => pub.slug === DROP001_SLUG);
  const drop002 = all
    .filter(({ pub }) => DROP002_SLUGS.has(pub.slug))
    .sort((a, b) => (a.pub.slug === "fight-dna-tee" ? -1 : b.pub.slug === "fight-dna-tee" ? 1 : a.pub.name.localeCompare(b.pub.name)));
  const later = all
    .filter(({ pub }) => pub.slug !== DROP001_SLUG && !DROP002_SLUGS.has(pub.slug))
    .sort((a, b) => a.pub.name.localeCompare(b.pub.name));
  const open = runtime.ready && drop001ProvisioningReady(provisioning.get(DROP001_SLUG));

  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow="PropBetEdge Store · Fight-night gear"
            title="Built for fight night."
            lede="The premium PBE hoodie is only the start. Fight DNA gets its own black-and-gold tee, the house logo gets a desk-ready mug, and the rest of the merch line is built from the same bettor-first identity as the platform."
            crumbs={[{ name: "Store" }]}
          />
        </div>
      </div>

      <div className="wrap">
        <p className={open ? "st-notice st-notice-quiet" : "st-notice"} role="status">
          {open ? (
            <><strong>Drop 001 is live.</strong> Black · S-2XL · $65 · Secure checkout.</>
          ) : (
            <><strong>Drop 001 is coming soon.</strong> Black · S-2XL · $65.</>
          )}
        </p>
      </div>

      <section className="wrap st-section">
        <div className="st-section-head">
          <h2>Drop 001 · PropBetEdge Premium Hoodie</h2>
          <p>8.5 oz premium fleece · 65/35 ring-spun cotton blend · 100% cotton face · 3-panel hood.</p>
        </div>
        <div className="st-grid st-grid-launch" style={{ maxWidth: 320, gridTemplateColumns: "minmax(0, 1fr)" }}>
          {firstDrop.map(({ pub }) => <Card key={pub.slug} p={pub} enabled={open} />)}
        </div>
      </section>

      {drop002.length > 0 && (
        <section className="wrap st-section">
          <div className="st-section-head">
            <div className="eyebrow">Drop 002 · Next up</div>
            <h2>Fight DNA Tee + PBE Mug</h2>
            <p>The two quick wins: Fight DNA as a real wearable brand piece, plus the core PBE mark on something that lives on the desk every day.</p>
          </div>
          <div className="st-grid st-grid-launch">
            {drop002.map(({ pub }) => <Card key={pub.slug} p={pub} stateLabel="Next drop" />)}
          </div>
        </section>
      )}

      {later.length > 0 && (
        <section className="wrap st-section">
          <div className="st-section-head">
            <h2>More from the merch lab</h2>
            <p>Additional tees, mugs, Fight DNA pieces, Tale of the Tape gear and bettor-first designs stay visible while we decide what earns the next production slot.</p>
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
          Product image shown for design and placement. Final print position may vary slightly in production. <Link href="/store/policies">Shipping and returns</Link>.
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
