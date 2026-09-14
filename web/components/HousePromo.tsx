import { HousePromoLink } from "@/components/HousePromoLink";
import type { PromoSelection } from "@/lib/housePromo";

/* PropBetEdge house promo card, after the story. One campaign owns the card:
 * eyebrow, one headline, one or two sentences, one CTA; the rest of the
 * network is a quiet text row. Server rendered, text only (no image request,
 * no layout shift), no third-party script. Only the links hydrate, to record a
 * click. Which campaign renders is decided in lib/housePromo.ts. */
export function HousePromo({ selection, slug, track }: { selection: PromoSelection; slug: string; track: boolean }) {
  const { campaign: c, headline, network } = selection;
  return (
    <aside className="house-promo" aria-label="From PropBetEdge" data-house-promo="end" data-promo-campaign={c.id}>
      <div className="hp-main">
        <div className="hp-copy">
          <div className="hp-eyebrow">{c.eyebrow}</div>
          <div className="hp-headline">{headline}</div>
          <p>{c.body}</p>
        </div>
        <HousePromoLink href={c.href} placement="end" campaign={c.id} dest={c.dest} slug={slug} track={track} className="btn gold hp-cta" newTab={c.external}>{c.cta} →</HousePromoLink>
      </div>
      {network.length > 0 && (
        <p className="hp-network">
          <span>Also from PropBetEdge</span>
          {network.map((s) => (
            <HousePromoLink key={s.key} href={s.href} placement="end" campaign={c.id} dest={s.key} slug={slug} track={track}>{s.label}</HousePromoLink>
          ))}
        </p>
      )}
    </aside>
  );
}
