import type { Fighter, ImageRef } from "@/lib/db";

export type FighterMedia = {
  image: ImageRef | null;
  url: string | null;
  credit: string | null;
};

function commonsRedirect(sourceUrl: string, width: number): string | null {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.hostname !== "commons.wikimedia.org") return null;
    const path = decodeURIComponent(parsed.pathname);
    const marker = "/wiki/File:";
    const at = path.indexOf(marker);
    if (at < 0) return null;
    const filename = path.slice(at + marker.length).replace(/ /g, "_");
    if (!filename) return null;
    return `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(filename)}?width=${Math.max(160, Math.min(width, 1600))}`;
  } catch {
    return null;
  }
}

function espnMmaHeadshot(fighter: Fighter | null | undefined): string | null {
  const id = String(fighter?.espn_athlete_id || "").trim();
  if (!/^\d+$/.test(id)) return null;
  // Display-only fallback. Never insert this URL into ufc_images: ESPN media
  // must not enter the PropBetEdge redistributable media catalog by accident.
  return `https://a.espncdn.com/i/headshots/mma/players/full/${id}.png`;
}

export function primaryFighterImage(fighter: Fighter | null | undefined): ImageRef | null {
  const images = fighter?.images || [];
  return images.find((image) => Boolean(image.image_url))
    || images.find((image) => image.kind === "wikimedia" && Boolean(image.source_url))
    || images[0]
    || null;
}

export function fighterImageUrl(fighter: Fighter | null | undefined, width = 720): string | null {
  const image = primaryFighterImage(fighter);
  if (image?.image_url) return image.image_url;
  if (image?.kind === "wikimedia" && image.source_url) return commonsRedirect(image.source_url, width);
  return espnMmaHeadshot(fighter);
}

export function fighterImageCredit(fighter: Fighter | null | undefined): string | null {
  const image = primaryFighterImage(fighter);
  if (image) {
    const parts = [image.author, image.license].filter(Boolean);
    if (parts.length) return parts.join(" · ");
    if (image.kind === "wikimedia") return "Wikimedia Commons";
  }
  return espnMmaHeadshot(fighter) ? "ESPN · display fallback" : null;
}

export function fighterMedia(fighter: Fighter | null | undefined, width = 720): FighterMedia {
  const image = primaryFighterImage(fighter);
  return {
    image,
    url: fighterImageUrl(fighter, width),
    credit: fighterImageCredit(fighter),
  };
}

export function fighterInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "UFC";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] || ""}${words[words.length - 1][0] || ""}`.toUpperCase();
}
