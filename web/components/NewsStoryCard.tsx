import Link from "next/link";
import type { Article, Fighter, PortraitSet } from "@/lib/db";
import { fmtDateTime } from "@/lib/format";
import { SITE, STORY_TYPE_LABEL } from "@/lib/site";
import { Avatar, Octagon } from "@/components/ui";

function impactOf(a: Article): number | null {
  const v = (a.fact_block as { bettor_angle?: { impact_score?: number } } | null | undefined)?.bettor_angle?.impact_score;
  return typeof v === "number" && v > 0 ? Math.min(5, Math.round(v)) : null;
}

function materiallyUpdated(a: Article): boolean {
  if (!a.published_at || !a.updated_at) return false;
  const published = Date.parse(a.published_at);
  const updated = Date.parse(a.updated_at);
  return Number.isFinite(published) && Number.isFinite(updated) && updated - published >= 5 * 60 * 1000;
}

export function NewsStoryCard({ a, hero, feature, faces, kicker }: {
  a: Article;
  hero?: PortraitSet | null;
  feature?: boolean;
  faces?: Array<{ f: Pick<Fighter, "name">; img?: PortraitSet | null }>;
  kicker?: string;
}) {
  const updated = materiallyUpdated(a);
  return (
    <Link href={`/news/${a.slug}`} className={`story${feature ? " feature" : ""}`}>
      <div className="img">
        {hero ? <img src={hero.card} alt="" width={800} height={1000} loading={feature ? "eager" : "lazy"} decoding="async" /> : (
          <div className="gen">
            <Octagon className="oc" />
            {faces && faces.length > 0 && (
              <div className="faces">
                <Avatar f={faces[0].f} img={faces[0].img} size={feature ? 72 : 48} />
                {faces[1] && <><span className="vs">vs</span><Avatar f={faces[1].f} img={faces[1].img} size={feature ? 72 : 48} /></>}
              </div>
            )}
            <small>{a.published_at ? fmtDateTime(a.published_at) : SITE.desk}</small>
            <b>{kicker || STORY_TYPE_LABEL[a.story_type] || a.story_type}</b>
          </div>
        )}
      </div>
      <div className="body">
        <span className="eyebrow">{STORY_TYPE_LABEL[a.story_type] || a.story_type}{impactOf(a) ? <span className="impact" title="Bettor's Edge impact score (analysis)"> · Edge {impactOf(a)}/5</span> : null}</span>
        <h3>{a.headline}</h3>
        {a.dek && <p>{a.dek}</p>}
        <div className="foot story-freshness">
          <span>
            {a.published_at ? <><span className="story-time-label">Published</span> <time dateTime={a.published_at}>{fmtDateTime(a.published_at)}</time></> : ""}
            {updated ? <><br /><span className="story-time-label">Updated</span> <time dateTime={a.updated_at}>{fmtDateTime(a.updated_at)}</time></> : null}
          </span>
          <span>{SITE.desk}</span>
        </div>
      </div>
    </Link>
  );
}
