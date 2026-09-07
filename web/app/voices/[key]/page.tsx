import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, JsonLd } from "@/components/ui";
import { VoiceImage } from "@/components/VoiceImage";
import { Mark } from "@/components/Brand";
import { OfficialDestinations } from "@/components/OfficialDestinations";
import { VideoRail, videoJsonLd } from "@/components/VideoRail";
import { getVideosMentioning } from "@/lib/db";
import { getVoice, VOICES, VOICES_DISCLAIMER } from "@/lib/voices";
import { SITE } from "@/lib/site";

export const revalidate = 3600;

export function generateStaticParams() {
  return VOICES.map((voice) => ({ key: voice.key }));
}

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const voice = getVoice((await params).key);
  if (!voice) return { title: "Profile not found", robots: { index: false } };
  const url = `${SITE.url}/voices/${voice.key}`;
  const shareImage = `${url}/opengraph-image`;
  return {
    title: `${voice.name} — ${voice.role} · profile, timeline & official media`,
    description: voice.seoDescription,
    alternates: { canonical: url },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } },
    openGraph: { type: "profile", url, title: `${voice.name} — Inside the Fight Game`, description: voice.seoDescription, images: [{ url: shareImage, width: 1200, height: 630, alt: `${voice.name} — PropBetEdge UFC` }] },
    twitter: { card: "summary_large_image", title: `${voice.name} — Inside the Fight Game`, description: voice.seoDescription, images: [shareImage] },
  };
}

export default async function VoiceProfilePage({ params }: { params: Promise<{ key: string }> }) {
  const voice = getVoice((await params).key);
  if (!voice) notFound();
  const url = `${SITE.url}/voices/${voice.key}`;
  const others = VOICES.filter((v) => v.key !== voice.key);
  const videos = voice.key === "dana-white" ? await getVideosMentioning("Dana White", 3).catch(() => []) : [];

  return (
    <article className="wrap page voice-profile">
      <Breadcrumbs items={[{ name: "Notable voices", href: "/#notable-voices" }, { name: voice.name }]} />

      <section className="voice-profile-hero">
        <div className="voice-profile-media">
          <VoiceImage src={voice.image?.hero || voice.image?.src || null} width={voice.image?.width} height={voice.image?.height} focal={voice.image?.focal} alt={voice.image?.alt || voice.name} name={voice.name} label={voice.label} />
        </div>
        <div className="voice-profile-copy">
          <div className="eyebrow">Inside the Fight Game · {voice.label}</div>
          <h1>{voice.name}</h1>
          <div className="voice-profile-role">{voice.role}</div>
          <p className="lede">{voice.lede}</p>
          <div className="voice-profile-signature">{voice.signature}</div>
          <div className="voice-profile-actions">
            <a href={voice.href} className="btn gold" target="_blank" rel="noopener nofollow">{voice.cta} ↗</a>
            {voice.key === "dana-white" && <Link href="/contender-series" className="btn">Contender Series archive</Link>}
            <Link href="/history" className="btn">UFC history</Link>
          </div>
          <p className="voice-profile-disclaimer">{VOICES_DISCLAIMER}</p>
        </div>
      </section>

      <div className="voice-profile-grid">
        <section className="voice-profile-main">
          <div className="eyebrow dim">Profile</div>
          <h2>Who {voice.name} is, and why the fight game listens</h2>
          {voice.bio.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}

          <div className="voice-why">
            <div className="desk-h">Why {voice.name.split(" ")[0]} matters</div>
            <ul>{voice.whyItMatters.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>

          <div className="voice-timeline">
            <div className="eyebrow dim">Timeline markers</div>
            <ol>{voice.timeline.map((m) => <li key={`${m.year}-${m.text}`}><b>{m.year}</b><span>{m.text}</span></li>)}</ol>
          </div>

          <div className="voice-profile-topics">
            <div className="eyebrow dim">Coverage themes</div>
            <div className="chips">{voice.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>
          </div>
        </section>

        <aside className="voice-profile-side">
          <div className="card hi">
            <div className="row" style={{ alignItems: "center" }}><Mark size={30} /><div className="eyebrow">Known for</div></div>
            <ul className="voice-known">{voice.knownFor.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
          <div className="card">
            <div className="eyebrow mb-2">Recommended {voice.key === "dana-white" ? "official destinations" : "listening & watching"}</div>
            <p className="dim sm">Direct links to the official destination — never mirrors, re-uploads or fan pages.</p>
            <ul className="voice-links">{voice.recommended.map((l) => <li key={l.href}><a href={l.href} target="_blank" rel="noopener nofollow">{l.label} ↗{l.note && <small>{l.note}</small>}</a></li>)}</ul>
          </div>
          <div className="card">
            <div className="eyebrow mb-2">At a glance</div>
            <ul className="voice-known">{voice.highlights.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
          {voice.image && (
            <div className="card voice-profile-credit">
              <div className="eyebrow mb-2">Image provenance</div>
              <p>Photo: <a href={voice.image.source_url} rel="noopener nofollow" target="_blank">{voice.image.author}</a>{voice.image.license ? <> · {voice.image.license_url ? <a href={voice.image.license_url} rel="noopener nofollow" target="_blank">{voice.image.license}</a> : voice.image.license}</> : null} · via Wikimedia Commons. {voice.image.note}</p>
            </div>
          )}
        </aside>
      </div>

      {videos.length > 0 && <VideoRail videos={videos} title="Dana White on UFC's official channel" eyebrow="Official video · title names him" feature={false} max={3} note="Publisher-hosted video from UFC's official YouTube channel · not hosted by PropBetEdge · not an endorsement" />}

      <section className="voice-more">
        <div className="sec-head"><div><div className="eyebrow">More voices</div><h2>Inside the Fight Game</h2></div><Link href="/#notable-voices" className="more">All notable voices →</Link></div>
        <div className="voice-more-grid">
          {others.map((v) => (
            <Link key={v.key} href={`/voices/${v.key}`} className="voice-more-card">
              {v.image ? <span className="avatar" style={{ width: 44, height: 44 }}><img src={v.image.src} alt="" width={44} height={44} loading="lazy" decoding="async" style={{ objectPosition: v.image.focal }} /></span> : <Mark size={40} />}
              <span><b>{v.name}</b><small>{v.label}</small></span>
            </Link>
          ))}
        </div>
      </section>

      <OfficialDestinations compact />

      <JsonLd data={{
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        "@id": `${url}#profile`,
        url,
        name: `${voice.name} — ${voice.role}`,
        description: voice.seoDescription,
        isPartOf: { "@id": `${SITE.url}/#site` },
        dateModified: new Date().toISOString().slice(0, 10),
        mainEntity: {
          "@type": "Person",
          name: voice.name,
          jobTitle: voice.role,
          description: voice.seoDescription,
          image: voice.image ? `${SITE.url}${voice.image.src}` : undefined,
          knowsAbout: voice.topics,
          sameAs: voice.official.map((l) => l.href),
          subjectOf: [{ "@type": "WebPage", url, name: `${voice.name} profile on PropBetEdge UFC` }],
        },
        video: videos.length ? videoJsonLd(videos) : undefined,
      }} />
    </article>
  );
}
