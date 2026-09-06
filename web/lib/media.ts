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

export function primaryFighterImage(fighter: Fighter | null | undefined): ImageRef | null {
  const images = fighter?.images || [];
  return images.find((image) => Boolean(image.image_url))
    || images.find((image) => image.kind === "wikimedia" && Boolean(image.source_url))
    || images[0]
    || null;
}

export function fighterImageUrl(fighter: Fighter | null | undefined, width = 720): string | null {
  const image = primaryFighterImage(fighter);
  if (!image) return null;
  if (image.image_url) return image.image_url;
  if (image.kind === "wikimedia" && image.source_url) return commonsRedirect(image.source_url, width);
  return null;
}

export function fighterImageCredit(fighter: Fighter | null | undefined): string | null {
  const image = primaryFighterImage(fighter);
  if (!image) return null;
  const parts = [image.author, image.license].filter(Boolean);
  return parts.length ? parts.join(" · ") : image.kind === "wikimedia" ? "Wikimedia Commons" : null;
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
