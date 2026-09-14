import { notFound } from "next/navigation";
import { seasonBySlug } from "@/lib/tuf";

/* Existence gate. A layout above this segment's loading boundary, so it runs
 * before the response starts streaming: a missing TUF season is a real HTTP 404
 * (root not-found page, no canonical), not a streamed 200. The lookup is
 * strict, so an upstream failure throws (5xx) instead of posing as missing. */
export default async function Gate({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!seasonBySlug(slug)) notFound();
  return children;
}
