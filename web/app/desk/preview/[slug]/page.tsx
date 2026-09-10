/* Desk preview: look at a story the pipeline WROTE but did not publish.
 *
 * WHY THIS ROUTE HAS TO EXIST
 *
 * ufc-news-enrich writes every article it can and publishes only the ones that
 * clear the green path; everything else lands at status='review' with its
 * blockers recorded. That design is only honest if the held articles can be
 * inspected. Without a preview the two available moves are both bad: publish a
 * story in order to look at it, which turns the gate into a formality, or judge
 * it from a JSON blob, which cannot show what a reader would actually see.
 *
 * WHAT IT IS NOT
 *
 * It is not a second way to publish. It renders through the same StoryView as
 * the public page, it never changes a row, and the article's status is printed
 * at the top of the page it renders. Publication remains one-way and remains
 * the pipeline's decision.
 *
 * ACCESS
 *
 * A token in the query string, compared in constant time against
 * DESK_PREVIEW_TOKEN, plus noindex/nofollow on every response. With no token
 * configured the route is dead - it 404s rather than falling open, because a
 * preview that defaults to public would expose exactly the articles the gate
 * decided were not fit to publish.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StoryView } from "@/components/StoryView";
import { getArticleBySlugAnyStatus } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Desk preview",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

function authorized(presented: string): boolean {
  const expected = String(process.env.DESK_PREVIEW_TOKEN || "");
  if (!expected || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

export default async function DeskPreview({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const k = (await searchParams).k;
  /* 404, not 403: an unauthenticated caller should not learn that a slug is
   * real and merely held. */
  if (!authorized(Array.isArray(k) ? k[0] || "" : k || "")) notFound();
  const a = await getArticleBySlugAnyStatus((await params).slug);
  if (!a) notFound();
  return <StoryView a={a} preview />;
}
