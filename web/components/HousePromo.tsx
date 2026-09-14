import { Mark } from "@/components/Brand";
import { HousePromoLink } from "@/components/HousePromoLink";
import { PROMO_COPY, networkLinks, type PromoCampaign } from "@/lib/housePromo";
import { SITE } from "@/lib/site";

/* PropBetEdge house promotion: a restrained editorial module, not an ad slot.
 * Server-rendered, fixed-size inline SVG mark (no image request, no layout
 * shift), no third-party script. Only the links hydrate, to record a click.
 * See lib/housePromo.ts for selection and placement rules. */

export function HousePromoInline({ campaign, slug, track }: { campaign: PromoCampaign; slug: string; track: boolean }) {
  const c = PROMO_COPY[campaign];
  return (
    <aside className="house-promo house-promo-inline" aria-label={c.eyebrow} data-house-promo="inline">
      <span className="hp-mark" aria-hidden="true"><Mark size={40} title="" /></span>
      <div className="hp-body">
        <div className="hp-eyebrow">{c.eyebrow}</div>
        <div className="hp-title">{c.title}</div>
        <p>{c.body}</p>
      </div>
      <HousePromoLink href={c.href} placement="inline" dest={campaign} slug={slug} track={track} className="btn hp-cta" newTab>{c.cta} →</HousePromoLink>
    </aside>
  );
}

export function HousePromoNetwork({ slug, track, showApi }: { slug: string; track: boolean; showApi: boolean }) {
  const links = networkLinks();
  if (!links.length) return null;
  return (
    <aside className="house-promo house-promo-network" aria-label="Explore PropBetEdge" data-house-promo="end">
      <div className="hp-head">
        <div>
          <div className="hp-eyebrow">Explore PropBetEdge</div>
          <div className="hp-title">More from the PropBetEdge network</div>
        </div>
        {showApi && <HousePromoLink href={SITE.ufcApi} placement="end" dest="ufc_api" slug={slug} track={track} className="hp-api" newTab>UFC Intelligence API →</HousePromoLink>}
      </div>
      <ul className="hp-sports">
        {links.map((s) => (
          <li key={s.key}>
            <HousePromoLink href={s.href} placement="end" dest={s.key} slug={slug} track={track}>
              <b>{s.label}</b><span>{s.name}</span>
            </HousePromoLink>
          </li>
        ))}
      </ul>
    </aside>
  );
}
