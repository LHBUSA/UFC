import tee0 from "@/lib/store/mockup-data/tee-0";
import tee1 from "@/lib/store/mockup-data/tee-1";
import tee2 from "@/lib/store/mockup-data/tee-2";
import tee3 from "@/lib/store/mockup-data/tee-3";
import mug0 from "@/lib/store/mockup-data/mug-0";
import mug1 from "@/lib/store/mockup-data/mug-1";
import mug2 from "@/lib/store/mockup-data/mug-2";
import { FIGHT_DNA_TEE_SLUG, PBE_MUG_SLUG } from "@/lib/store/release-policy";

export const runtime = "nodejs";
export const dynamic = "force-static";

const MOCKUPS: Record<string, string> = {
  [FIGHT_DNA_TEE_SLUG]: tee0 + tee1 + tee2 + tee3,
  [PBE_MUG_SLUG]: mug0 + mug1 + mug2,
};

/**
 * Versioned, first-party copies of the two product mockups Justin approved.
 *
 * The originals arrived as conversation attachments, not durable public URLs,
 * so their compressed WebP bytes live with the app and this route exposes
 * them under our own domain. That keeps product pages, OG cards and cart
 * imagery from depending on an expiring attachment URL.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const encoded = MOCKUPS[slug];
  if (!encoded) return new Response("not found", { status: 404 });

  const bytes = Buffer.from(encoded, "base64");
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
