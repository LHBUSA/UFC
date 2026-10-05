/* Homepage Fight DNA public demo — the ONE intentional public DNA read.
 *
 * Owner decision 2026-10-05: the homepage module shows one real stored Fight
 * DNA snapshot to every visitor as a product sample. It is the same for
 * anonymous and subscribed visitors, so it never asks for the access decision.
 * Full fighter / fight DNA stays UFC Pro (paywall.test.ts pins those guards).
 *
 * What leaves this file is a reduced DemoView (lib/fightDnaDemoModel.ts), never
 * the snapshot: no provenance bout list, no context splits, no position profile. */
import "server-only";
import { getFighterDna } from "@/lib/dna";
import { getFightersByIds, getImageSourceSizes, getImagesForFighters, type Fighter } from "@/lib/db";
import { MAX_DNA_READS, buildDemoView, orderCandidates, rotationWindow, snapshotQualifies, type DemoCandidate, type DemoPortrait, type DemoView } from "@/lib/fightDnaDemoModel";

export type FightDnaDemo = {
  fighter: Pick<Fighter, "id" | "name" | "nickname" | "espn_athlete_id" | "ufcstats_id" | "record_w" | "record_l" | "record_d" | "record_nc">;
  context: string;
  image: { src: string; credit: string | null };
  view: DemoView;
  /* The rotation window this pick belongs to (inclusive UTC dates). */
  window: { start: string; end: string };
};

export async function getFightDnaDemo(candidates: DemoCandidate[]): Promise<FightDnaDemo | null> {
  const ids = [...new Set(candidates.map((c) => c.id).filter(Boolean))];
  if (!ids.length) return null;
  const images = await getImagesForFighters(ids).catch(() => new Map());
  const sizes = await getImageSourceSizes([...images.values()].map((p) => p.id)).catch(() => new Map());
  const portraits = new Map<string, DemoPortrait>();
  for (const [id, p] of images) {
    portraits.set(id, { src: p.card, firstParty: p.stored_first_party !== false && p.source_family !== "espn", sourceHeight: sizes.get(p.id)?.height ?? null });
  }

  const win = rotationWindow(Date.now());
  const ordered = orderCandidates(candidates, portraits, win.index).slice(0, MAX_DNA_READS);
  for (const c of ordered) {
    const dna = await getFighterDna(c.id).catch(() => null);
    if (dna?.status !== "ok" || !snapshotQualifies(dna.data.snapshot)) continue;
    const [fighter] = await getFightersByIds([c.id]).catch(() => []);
    if (!fighter) continue;
    const p = images.get(c.id)!;
    return {
      fighter: { id: fighter.id, name: fighter.name, nickname: fighter.nickname, espn_athlete_id: fighter.espn_athlete_id, ufcstats_id: fighter.ufcstats_id, record_w: fighter.record_w, record_l: fighter.record_l, record_d: fighter.record_d, record_nc: fighter.record_nc },
      context: c.context,
      image: { src: p.card, credit: p.attribution_text || null },
      view: buildDemoView(dna.data.snapshot),
      window: { start: win.start, end: win.end },
    };
  }
  return null;
}
