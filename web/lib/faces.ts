/* Faces for story cards: the first two fighters tagged on each article,
 * with licensed portraits where we have them. One fighter query and one
 * image query for a whole list of articles. */
import "server-only";
import { getFightersByIds, getImagesForFighters, getImageById, type Article, type Fighter, type PortraitSet } from "@/lib/db";

export type Face = { f: Pick<Fighter, "name">; img?: PortraitSet | null };
export type StoryMedia = { faces: Map<string, Face[]>; heroes: Map<string, PortraitSet | null> };

export async function storyMedia(articles: Article[]): Promise<StoryMedia> {
  const ids = [...new Set(articles.flatMap((a) => (a.fighter_ids || []).slice(0, 2)))];
  const heroIds = [...new Set(articles.map((a) => a.hero_image_ref).filter(Boolean) as string[])];
  const [fighters, imgs, heroPairs] = await Promise.all([
    getFightersByIds(ids),
    getImagesForFighters(ids),
    Promise.all(heroIds.map(async (id) => [id, await getImageById(id)] as const)),
  ]);
  const byId = new Map(fighters.map((f) => [f.id, f]));
  const faces = new Map<string, Face[]>();
  for (const a of articles) {
    const fs = (a.fighter_ids || []).slice(0, 2).map((id) => byId.get(id)).filter(Boolean) as Fighter[];
    faces.set(a.id, fs.map((f) => ({ f, img: imgs.get(f.id) || null })));
  }
  return { faces, heroes: new Map(heroPairs) };
}
