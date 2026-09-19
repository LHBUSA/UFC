import { NextResponse } from "next/server";
import { getRankings, getFightersByIds, getImagesForFighters } from "@/lib/db";
import { fighterSlug } from "@/lib/slug";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await getRankings();
    if (!snapshot) {
      return NextResponse.json(
        { ok: false, error: "rankings_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }

    const divisions = snapshot.divisions.filter((d) => !d.is_p4p);
    const championIds = [...new Set(
      divisions.map((d) => d.champion?.fighter_id).filter(Boolean) as string[],
    )];

    const [fighters, images] = await Promise.all([
      getFightersByIds(championIds),
      getImagesForFighters(championIds),
    ]);
    const byId = new Map(fighters.map((fighter) => [fighter.id, fighter]));

    const data = divisions.map((division) => {
      const champion = division.champion;
      if (!champion) {
        const correction = (snapshot.corrections || []).find(
          (item) => item.type === "vacated_title" && item.division === division.key,
        ) || null;
        return {
          key: division.key,
          division: division.label,
          isWomen: division.is_womens,
          status: "vacant",
          champion: null,
          correction,
          href: "https://ufc.propbetedge.ai/rankings",
        };
      }

      const fighter = champion.fighter_id ? byId.get(champion.fighter_id) : null;
      const portrait = fighter ? images.get(fighter.id) : null;
      return {
        key: division.key,
        division: division.label,
        isWomen: division.is_womens,
        status: "champion",
        correction: null,
        champion: {
          name: champion.name,
          fighterId: champion.fighter_id,
          slug: champion.ufc_slug,
          href: fighter
            ? `https://ufc.propbetedge.ai/fighters/${fighterSlug(fighter)}`
            : "https://ufc.propbetedge.ai/rankings",
          image: portrait?.card || portrait?.portrait || portrait?.thumb || null,
          imageSourceFamily: portrait?.source_family || null,
          displayOnly: portrait?.stored_first_party === false || portrait?.source_family === "espn",
          attribution: portrait?.attribution_text || null,
        },
      };
    });

    return NextResponse.json(
      {
        ok: true,
        data: {
          sport: "ufc",
          source: "UFC official rankings snapshot",
          sourceUrl: snapshot.source_url,
          snapshotDate: snapshot.snapshot_date,
          capturedAt: snapshot.captured_at,
          corrections: snapshot.corrections || [],
          divisions: data,
        },
      },
      { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=900" } },
    );
  } catch (error) {
    console.error(`[api/rankings-display] ${String((error as Error)?.message || error).slice(0, 180)}`);
    return NextResponse.json(
      { ok: false, error: "rankings_display_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
