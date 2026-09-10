import { ImageResponse } from "next/og";
import { getArticleBySlug, getFightersByIds, getBoutById } from "@/lib/db";
import { resolveFighterPortraits, resolveArticleHero } from "@/lib/fighterMedia";
import { ogFonts, OG_SIZE } from "@/lib/og";
import { OgFrame, OgFace } from "@/components/og";
import { fmtDateTime } from "@/lib/format";
import { STORY_TYPE_LABEL, GOLD, DIM, PAPER } from "@/lib/site";

export const runtime = "edge";
export const alt = "PropBetEdge UFC story";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OG({ params }: { params: Promise<{ slug: string }> }) {
  const [fonts, a] = await Promise.all([ogFonts(), getArticleBySlug((await params).slug)]);
  const hero = a?.hero_image_ref ? await resolveArticleHero(a.hero_image_ref, { surface: "high_visibility" }) : null;
  const bout = a?.bout_id ? await getBoutById(a.bout_id) : null;
  const fighters = bout ? [bout.fighter_a, bout.fighter_b] : a ? (await getFightersByIds(a.fighter_ids || [])).slice(0, 2) : [];
  const imgs = await resolveFighterPortraits(fighters.map((f) => f.id), { surface: "high_visibility" });
  const label = a ? STORY_TYPE_LABEL[a.story_type] || a.story_type : "Story";
  const long = (a?.headline.length || 0) > 70;
  return new ImageResponse(
    (
      <OgFrame kicker={`${label}${a?.published_at ? ` · ${fmtDateTime(a.published_at)}` : ""}`} footer="FROM THE PROPBETEDGE UFC DESK">
        <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
          {hero ? <OgFace src={hero.card} name={fighters[0]?.name || "?"} size={280} /> : fighters.length ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <OgFace src={imgs.get(fighters[0].id)?.card} name={fighters[0].name} size={200} />
              {fighters[1] && <><div style={{ fontSize: 40, fontStyle: "italic", color: GOLD, fontWeight: 800 }}>vs</div><OgFace src={imgs.get(fighters[1].id)?.card} name={fighters[1].name} size={200} /></>}
            </div>
          ) : null}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1 }}>
            <div style={{ fontSize: long ? 40 : 50, fontWeight: 800, letterSpacing: -1.2, lineHeight: 1.08, color: PAPER }}>{a?.headline || "PropBetEdge UFC"}</div>
            {a?.dek && !long && <div style={{ fontSize: 22, color: DIM, lineHeight: 1.35, fontFamily: "Inter, sans-serif" }}>{a.dek.length > 140 ? `${a.dek.slice(0, 138)}…` : a.dek}</div>}
          </div>
        </div>
      </OgFrame>
    ),
    { ...size, fonts },
  );
}
