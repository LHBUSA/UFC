import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, JsonLd } from "@/components/ui";
import { HoodieProductPreview } from "@/components/store/HoodieProductPreview";
import { LINES } from "@/lib/store/catalog";
import { liveProductsFor } from "@/lib/store/live-products";
import { approvedMockup } from "@/lib/store/display";
import { getProvisioning } from "@/lib/store/provisioning";
import { drop001RuntimeStatus } from "@/lib/store/release";
import {
  DROP001_SLUG, FIGHT_DNA_TEE_SLUG, PBE_MUG_SLUG,
  TALE_OF_TAPE_HOODIE_SLUG, PBE_CLASSIC_HAT_SLUG, TRUST_DATA_MUG_SLUG,
  releaseProvisioningReady,
} from "@/lib/store/release-policy";
import { formatPrice, toStorefront, type StorefrontProduct } from "@/lib/store/types";
import { SITE } from "@/lib/site";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TITLE = "PropBetEdge Store | Premium Fight-Night Gear";
const DESCRIPTION = "Shop live PropBetEdge fight-night gear: premium hoodies, Fight DNA, Tale of the Tape, PBE headwear and bettor-first mugs built around the same intelligence platform.";
const DROP002_SLUGS = new Set([FIGHT_DNA_TEE_SLUG, PBE_MUG_SLUG]);
const DROP003_SLUGS = new Set([TALE_OF_TAPE_HOODIE_SLUG, PBE_CLASSIC_HAT_SLUG, TRUST_DATA_MUG_SLUG]);
const DROP003_PHOTOS: Record<string, { url: string; width: number; height: number; alt: string }> = {
  [TALE_OF_TAPE_HOODIE_SLUG]: { url: "/store/img/tale-of-the-tape-hoodie.webp", width: 640, height: 800, alt: "Tale of the Tape Hoodie" },
  [PBE_CLASSIC_HAT_SLUG]: { url: "/store/img/pbe-classic-hat.webp", width: 480, height: 600, alt: "PBE Classic Hat" },
  [TRUST_DATA_MUG_SLUG]: { url: "/store/img/trust-the-data-mug.webp", width: 480, height: 600, alt: "Trust the Data Mug" },
};
const STORE_HERO = `${SITE.url}${DROP003_PHOTOS[TALE_OF_TAPE_HOODIE_SLUG].url}`;

export const metadata: Metadata = {
  title: { absolute: TITLE }, description: DESCRIPTION, alternates: { canonical: "/store" },
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", url: `${SITE.url}/store`, images: [{ url: STORE_HERO, width: 640, height: 800, alt: "Tale of the Tape Hoodie" }] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [STORE_HERO] },
};

const FORM_LABEL: Record<string, string> = { tee: "Tee", hoodie: "Hoodie", cap: "Hat", mug: "Mug" };

function Card({ p, enabled = false }: { p: StorefrontProduct; enabled?: boolean }) {
  const hoodie = p.slug === DROP001_SLUG;
  const mockup = approvedMockup(p.slug);
  const image = DROP003_PHOTOS[p.slug] ?? mockup ?? p.images[0];
  return (
    <Link href={`/store/${p.slug}`} className="st-card">
      <span className="st-art-frame">
        {hoodie ? <HoodieProductPreview compact /> : <img className="st-art" src={image.url} alt={image.alt} width={image.width} height={image.height} loading="lazy" decoding="async" />}
        <span className="st-form-tag">{FORM_LABEL[p.form] ?? p.form}</span>
      </span>
      <span className="st-card-body">
        <span className="st-card-name">{p.name}</span>
        <span className="st-card-blurb">{p.slug === TALE_OF_TAPE_HOODIE_SLUG ? "Different fighters. Same data. The matchup read on premium black fleece." : p.slug === PBE_CLASSIC_HAT_SLUG ? "Gold PBE embroidery on a black Yupoong classic dad hat." : p.slug === TRUST_DATA_MUG_SLUG ? "Trust the Data. Less opinions. More winning. Black glossy ceramic." : hoodie ? "Premium black fleece. Metallic PBE chest logo. Gold fight mark on the sleeve." : p.slug === FIGHT_DNA_TEE_SLUG ? "Black-and-gold Fight DNA. PropBetEdge built directly into the mark." : p.slug === PBE_MUG_SLUG ? "Black glossy ceramic with the full metallic PBE house logo." : p.blurb}</span>
        <span className="st-card-foot"><span className="st-price">{formatPrice(p.price_cents)}</span>{enabled ? <span className="st-state st-state-open">On sale</span> : <span className="st-soon">Coming soon</span>}</span>
      </span>
    </Link>
  );
}

export default async function StorePage() {
  const [provisioning, runtime] = await Promise.all([getProvisioning(), Promise.resolve(drop001RuntimeStatus())]);
  const all = liveProductsFor("ufc").map((d) => ({ line: d.line, pub: toStorefront(d, provisioning.get(d.slug) ?? null) }));
  const firstDrop = all.filter(({ pub }) => pub.slug === DROP001_SLUG);
  const drop002 = all.filter(({ pub }) => DROP002_SLUGS.has(pub.slug));
  const drop003 = all.filter(({ pub }) => DROP003_SLUGS.has(pub.slug));
  const later = all.filter(({ pub }) => pub.slug !== DROP001_SLUG && !DROP002_SLUGS.has(pub.slug) && !DROP003_SLUGS.has(pub.slug)).sort((a,b)=>a.pub.name.localeCompare(b.pub.name));
  const ready = (slug: string) => runtime.ready && releaseProvisioningReady(slug, provisioning.get(slug));
  const liveSlugs = [DROP001_SLUG, FIGHT_DNA_TEE_SLUG, PBE_MUG_SLUG, TALE_OF_TAPE_HOODIE_SLUG, PBE_CLASSIC_HAT_SLUG, TRUST_DATA_MUG_SLUG];
  const liveCount = liveSlugs.filter(ready).length;

  return <>
    <div className="wrap"><div className="page"><PageHead eyebrow="PropBetEdge Store · Fight-night gear" title="Built for fight night." lede="Six live pieces. Fight DNA, Tale of the Tape, the PBE house mark and Trust the Data — turned into premium fight-night gear that actually ships." crumbs={[{ name: "Store" }]} /></div></div>
    <div className="wrap"><p className="st-notice st-notice-quiet" role="status"><strong>{liveCount} of 6 products are live.</strong> Secure Stripe checkout · made on demand · shipped direct from our fulfillment partner.</p></div>

    <section className="wrap st-section"><div className="st-section-head"><h2>Drop 001 · PropBetEdge Premium Hoodie</h2><p>8.5 oz premium fleece · black · S-2XL.</p></div><div className="st-grid st-grid-launch" style={{ maxWidth: 320, gridTemplateColumns: "minmax(0,1fr)" }}>{firstDrop.map(({pub})=><Card key={pub.slug} p={pub} enabled={ready(pub.slug)} />)}</div></section>

    <section className="wrap st-section"><div className="st-section-head"><div className="eyebrow">Drop 002 · Fight DNA + House Mark</div><h2>Fight DNA Tee + PBE Black Mug</h2><p>The bettor-first method on black cotton and the house identity on black ceramic.</p></div><div className="st-grid st-grid-launch">{drop002.map(({pub})=><Card key={pub.slug} p={pub} enabled={ready(pub.slug)} />)}</div></section>

    <section className="wrap st-section"><div className="st-section-head"><div className="eyebrow">Drop 003 · Live now</div><h2>Tale of the Tape Hoodie + PBE Classic Hat + Trust the Data Mug</h2><p>The strongest second wave: the matchup framework on premium fleece, clean gold PBE embroidery, and the editorial philosophy on black ceramic.</p></div><div className="st-grid st-grid-launch">{drop003.map(({pub})=><Card key={pub.slug} p={pub} enabled={ready(pub.slug)} />)}</div></section>

    {later.length > 0 && <section className="wrap st-section"><div className="st-section-head"><h2>More from the merch lab</h2><p>The rest of the design system stays visible until it earns a production slot.</p></div>{LINES.map((c)=>{const inLine=later.filter((i)=>i.line===c.key);if(!inLine.length)return null;return <div className="st-later" key={c.key}><h3 className="st-later-head">{c.name}</h3><div className="st-grid st-grid-later">{inLine.map(({pub})=><Card key={pub.slug} p={pub} />)}</div></div>;})}</section>}

    <section className="wrap st-section"><p className="st-fine">Released designs are manufactured on demand. Final print or embroidery position may vary slightly. <Link href="/store/policies">Shipping and returns</Link>.</p></section>
    <JsonLd data={{ "@context":"https://schema.org", "@type":"CollectionPage", name:TITLE, description:DESCRIPTION, url:`${SITE.url}/store`, isPartOf:{"@type":"WebSite",name:SITE.name,url:SITE.url} }} />
  </>;
}
