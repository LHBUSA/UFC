import Link from "next/link";
import { fmtDateTime } from "@/lib/format";

type RelatedArticle = { id: string; slug: string; headline: string; published_at: string | null };

/** "More on this story": the lead story's own follow-ups as text links (lib/newsClusters heroRelated). */
export function StoryRelated({ items, limit, moreHref }: { items: RelatedArticle[]; limit?: number; moreHref?: string }) {
  if (!items.length) return null;
  const shown = limit ? items.slice(0, limit) : items;
  const hidden = items.length - shown.length;
  return (
    <aside className="story-related" aria-label="More on this story">
      <div className="eyebrow">More on this story · {items.length}</div>
      <ul>
        {shown.map((a) => (
          <li key={a.id}>
            <Link href={`/news/${a.slug}`}>{a.headline}</Link>
            {a.published_at && <time dateTime={a.published_at}>{fmtDateTime(a.published_at)}</time>}
          </li>
        ))}
      </ul>
      {hidden > 0 && moreHref && <Link className="story-related-more" href={moreHref}>{hidden} more in the newsroom →</Link>}
    </aside>
  );
}
