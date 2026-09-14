import { notFound, permanentRedirect } from "next/navigation";
import { canonicalSlugFor, getJudgeArchive } from "@/lib/judges";

/* Existence gate. A layout above this segment's loading boundary, so it runs
 * before the response starts streaming: a missing judge is a real HTTP 404
 * (root not-found page, no canonical), not a streamed 200. The lookup is
 * strict, so an upstream failure throws (5xx) instead of posing as missing. */
export default async function Gate({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const archive = await getJudgeArchive();
  if (archive.bySlug.has(slug)) return children;
  /* A merged spelling keeps its old URL alive as a redirect. */
  const canonical = canonicalSlugFor(slug);
  if (canonical && canonical !== slug) permanentRedirect(`/judges/${canonical}`);
  /* A scorecard walk that failed part-way cannot prove absence. */
  if (!archive.complete) throw new Error("[judges] scorecard archive incomplete; cannot decide existence");
  notFound();
  return children;
}
