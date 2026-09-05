import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getArticleBySlug } from "@/lib/db";
import { JsonLd, ProLock } from "@/components/ui";
import { renderMarkdown } from "@/lib/markdown";
import { SITE } from "@/lib/site";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const a = await getArticleBySlug((await params).slug);
  if (!a) return { title: "Story not found" };
  return {
    title: a.headline, description: a.dek || undefined, alternates: { canonical: `/news/${a.slug}` },
    openGraph: { type: "article", title: a.headline, description: a.dek || undefined, publishedTime: a.published_at || undefined, modifiedTime: a.updated_at, authors: ["PropBetEdge UFC Desk"] },
  };
}

export default async function StoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const a = await getArticleBySlug((await params).slug);
  if (!a) notFound();
  return (
    <article className="wrap" style={{ padding: "48px 24px" }}>
      <div className="eyebrow">{a.story_type.replace("_", " ")}</div>
      <h1 className="serif" style={{ fontSize: "var(--fs-display)", margin: "10px 0 8px", maxWidth: "24ch" }}>{a.headline}</h1>
      {a.dek && <p className="dim" style={{ fontSize: 18, maxWidth: "60ch" }}>{a.dek}</p>}
      <div className="mono faint" style={{ fontSize: "var(--fs-label)", margin: "16px 0 32px" }}>
        {a.published_at ? new Date(a.published_at).toUTCString() : ""} · PropBetEdge UFC Desk
      </div>
      {a.hero_credit?.author && (
        <div className="faint" style={{ fontSize: "var(--fs-label)", marginBottom: 16 }}>Image: {a.hero_credit.author}{a.hero_credit.license ? ` · ${a.hero_credit.license}` : ""}{a.hero_credit.source_url ? <> · <a href={a.hero_credit.source_url} rel="nofollow noopener">source</a></> : null}</div>
      )}
      <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.body_md) }} />
      <div style={{ maxWidth: 720, marginTop: 32 }}><ProLock /></div>
      <JsonLd data={{
        "@context": "https://schema.org", "@type": "NewsArticle", headline: a.headline, description: a.dek || undefined,
        datePublished: a.published_at || undefined, dateModified: a.updated_at, url: `${SITE.url}/news/${a.slug}`,
        author: { "@type": "Organization", name: "PropBetEdge UFC Desk", url: SITE.url },
        publisher: { "@type": "Organization", name: "PropBetEdge", logo: { "@type": "ImageObject", url: SITE.logo.full600 } },
        mainEntityOfPage: `${SITE.url}/news/${a.slug}`, isAccessibleForFree: true,
      }} />
    </article>
  );
}
