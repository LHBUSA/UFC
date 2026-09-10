import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getArticleBySlug, getImageById, getFightersByIds, getImagesForFighters, getEventById, getArticles, getBoutById, getWireFor, getVideosForArticle, getVideosForBout, getVideosForEvent } from "@/lib/db";
import { VideoRail, videoJsonLd } from "@/components/VideoRail";
import { JsonLd, ProLock, Breadcrumbs, Avatar, Octagon, FighterRow } from "@/components/ui";
import { NewsStoryCard } from "@/components/NewsStoryCard";
import { renderMarkdown, renderMarkdownBlocks, excerpt, readingMinutes } from "@/lib/markdown";
import { fighterSlug, eventSlug, matchupSlug } from "@/lib/slug";
import { fmtDateTime, fmtDate, eventStatusLabel, locationLine, relTime } from "@/lib/format";
import { SITE, STORY_TYPE_LABEL } from "@/lib/site";
import { storyMedia } from "@/lib/faces";
import { getMatchupDna } from "@/lib/dna";
import { DnaEvidence } from "@/components/dna";
import { Mark } from "@/components/Brand";
import { StoryView } from "@/components/StoryView";
import {
  BoutContextModule, ComparisonModule, DnaModule, RecentFormModule, RoundStyleModule,
  MarketModule, OfficialVideoModule, MethodologyModule, FighterCardModule,
  ArticleBody, ChartSet, CLAIMED_CHARTS,
  chartsOf, planAngle, moduleOf, type ContentPlan,
} from "@/components/plan";

export const revalidate = 300;

function materiallyUpdated(published: string | null, updated: string): boolean {
  if (!published || !updated) return false;
  const p = Date.parse(published), u = Date.parse(updated);
  return Number.isFinite(p) && Number.isFinite(u) && u - p >= 5 * 60 * 1000;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const a = await getArticleBySlug((await params).slug);
  if (!a) return { title: "Story not found", robots: { index: false } };
  const description = a.dek || excerpt(a.body_md);
  const label = STORY_TYPE_LABEL[a.story_type] || a.story_type;
  const ogImage = `${SITE.url}/news/${a.slug}/opengraph-image`;
  return {
    title: a.headline,
    description,
    category: "sports",
    authors: [{ name: SITE.desk, url: `${SITE.url}/about` }],
    keywords: ["UFC", "MMA", label, "UFC fight intelligence", "UFC analysis", "PropBetEdge UFC"],
    alternates: { canonical: `/news/${a.slug}` },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 } },
    openGraph: {
      type: "article",
      title: a.headline,
      description,
      publishedTime: a.published_at || undefined,
      modifiedTime: a.updated_at,
      authors: [SITE.desk],
      section: label,
      tags: ["UFC", "MMA", label, "Fight Intelligence"],
      url: `${SITE.url}/news/${a.slug}`,
      images: [{ url: ogImage, width: 1200, height: 630, alt: a.headline }],
    },
    twitter: {
      card: "summary_large_image",
      title: a.headline,
      description,
      images: [ogImage],
    },
  };
}
export default async function StoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const a = await getArticleBySlug((await params).slug);
  if (!a) notFound();
  return <StoryView a={a} />;
}
