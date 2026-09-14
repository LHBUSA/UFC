import { HousePromoLink } from "@/components/HousePromoLink";
import { networkLinks, promoFor } from "@/lib/housePromo";

/* PropBetEdge first-party product module, after the story. One product, one
 * headline, one CTA; the rest of the network is a quiet text row. Server
 * rendered, text only (no image request, no layout shift), no third-party
 * script. Only the links hydrate, to record a click. */
export function HousePromo({ storyType, slug, track }: { storyType: string; slug: string; track: boolean }) {
  const c = promoFor(storyType);
  const sports = networkLinks();
  return (
    <aside className="house-promo" aria-label="From PropBetEdge" data-house-promo="end">
      <div className="hp-main">
        <div className="hp-copy">
          <div className="hp-eyebrow">{c.eyebrow}</div>
          <div className="hp-headline">{c.headline}</div>
          <p>{c.body}</p>
        </div>
        <HousePromoLink href={c.href} placement="end" dest="ufc_api" slug={slug} track={track} className="btn gold hp-cta" newTab>{c.cta} →</HousePromoLink>
      </div>
      {sports.length > 0 && (
        <p className="hp-network">
          <span>Also from PropBetEdge</span>
          {sports.map((s) => (
            <HousePromoLink key={s.key} href={s.href} placement="end" dest={s.key} slug={slug} track={track}>{s.label}</HousePromoLink>
          ))}
        </p>
      )}
    </aside>
  );
}
