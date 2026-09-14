import { notFound, permanentRedirect } from "next/navigation";
import { resolveFighter } from "@/lib/resolve";
import { fighterSlug } from "@/lib/slug";

/* Existence gate. A layout above this segment's loading boundary, so it runs
 * before the response starts streaming: a missing fighter is a real HTTP 404
 * (root not-found page, no canonical), not a streamed 200. The lookup is
 * strict, so an upstream failure throws (5xx) instead of posing as missing. */
export default async function Gate({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const f = await resolveFighter(slug);
  if (!f) notFound();
  /* One fighter, one URL: a stale name or retired source id is a real 308
   * here, where the page's own redirect could only be a meta refresh. */
  if (slug !== fighterSlug(f)) permanentRedirect(`/fighters/${fighterSlug(f)}`);
  return children;
}
