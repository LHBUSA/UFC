import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, JsonLd } from "@/components/ui";
import { VoiceImage } from "@/components/VoiceImage";
import { Mark } from "@/components/Brand";
import { getVoice, VOICES, VOICES_DISCLAIMER } from "@/lib/voices";
import { SITE } from "@/lib/site";

export const revalidate = 86400;

export function generateStaticParams() {
  return VOICES.map((voice) => ({ key: voice.key }));
}

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const voice = getVoice((await params).key);
  if (!voice) return { title: "Profile not found", robots: { index: false } };
  const url = `${SITE.url}/voices/${voice.key}`;
  const image = voice.image ? `${SITE.url}${voice.image.src}` : `${SITE.url}/opengraph-image`;
  return {
    title: `${voice.name} — MMA profile, analysis & official media`,
    description: voice.seoDescription,
    alternates: { canonical: url },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } },
    openGraph: {
      type: "profile",
      url,
      title: `${voice.name} — Inside the Fight Game`,
      description: voice.seoDescription,
      images: [{ url: image, width: voice.image?.width || 1200, height: voice.image?.height || 630, alt: voice.name }],
    },
    twitter: { card: "summary_large_image", title: `${voice.name} — Inside the Fight Game`, description: voice.seoDescription, images: [image] },
  };
}

export default async function VoiceProfilePage({ params }: { params: Promise<{ key: string }> }) {
  const voice = getVoice((await params).key);
  if (!voice) notFound();
  const url = `${SITE.url}/voices/${voice.key}`;

  return (
    <article className="wrap page voice-profile">
      <Breadcrumbs items={[{ name: "Notable voices", href: "/#notable-voices" }, { name: voice.name }]} />

      <section className="voice-profile-hero">
        <div className="voice-profile-media">
          <VoiceImage src={voice.image?.src || null} width={voice.image?.width} height={voice.image?.height} focal={voice.image?.focal} alt={voice.image?.alt || voice.name} name={voice.name} label={voice.label} />
        </div>
        <div className="voice-profile-copy">
          <div className="eyebrow">Inside the Fight Game</div>
          <h1>{voice.name}</h1>
          <div className="voice-profile-role">{voice.role}</div>
          <p className="lede">{voice.descriptor}</p>
          <div className="voice-profile-actions">
            <a href={voice.href} className="btn gold" target="_blank" rel="noopener nofollow">{voice.cta} →</a>
            <Link href="/news" className="btn">PropBetEdge newsroom</Link>
          </div>
          <p className="voice-profile-disclaimer">{VOICES_DISCLAIMER}</p>
        </div>
      </section>

      <div className="voice-profile-grid">
        <section className="voice-profile-main">
          <div className="eyebrow dim">Profile</div>
          <h2>Why {voice.name} matters to MMA fans</h2>
          {voice.bio.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}

          <div className="voice-profile-topics">
            <div className="eyebrow dim">Coverage themes</div>
            <div className="chips">{voice.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>
          </div>
        </section>

        <aside className="voice-profile-side">
          <div className="card hi">
            <div className="row" style={{ alignItems: "center" }}><Mark size={30} /><div className="eyebrow">At a glance</div></div>
            <ul className="voice-highlights">{voice.highlights.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
          <div className="card">
            <div className="eyebrow mb-3">Official destination</div>
            <p className="dim sm">We link directly to the featured personality's official media destination rather than mirrors or fan pages.</p>
            <a href={voice.href} className="btn mt-4" target="_blank" rel="noopener nofollow">Open {voice.destination} →</a>
          </div>
          {voice.image && (
            <div className="card voice-profile-credit">
              <div className="eyebrow mb-3">Image provenance</div>
              <p>Photo: <a href={voice.image.source_url} rel="noopener nofollow" target="_blank">{voice.image.author}</a>{voice.image.license ? <> · {voice.image.license_url ? <a href={voice.image.license_url} rel="noopener nofollow" target="_blank">{voice.image.license}</a> : voice.image.license}</> : null} · via Wikimedia Commons.</p>
            </div>
          )}
        </aside>
      </div>

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        "@id": `${url}#profile`,
        url,
        name: `${voice.name} — MMA profile`,
        description: voice.seoDescription,
        isPartOf: { "@id": `${SITE.url}/#site` },
        mainEntity: {
          "@type": "Person",
          name: voice.name,
          description: voice.seoDescription,
          image: voice.image ? `${SITE.url}${voice.image.src}` : undefined,
          knowsAbout: voice.topics,
          subjectOf: [{ "@type": "WebPage", url, name: `${voice.name} profile on PropBetEdge UFC` }],
        },
      }} />
    </article>
  );
}
