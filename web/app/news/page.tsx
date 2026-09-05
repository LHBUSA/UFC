import type { Metadata } from "next";
import { getArticles } from "@/lib/db";
import { Empty, StoryCard } from "@/components/ui";

export const revalidate = 300;
export const metadata: Metadata = { title: "UFC News & Card Changes", description: "Card changes, injuries, weigh-in reports, rankings moves and results, written from PropBetEdge's own fight data.", alternates: { canonical: "/news" } };

export default async function NewsPage() {
  const articles = await getArticles(40);
  return (
    <div className="wrap" style={{ padding: "48px 24px" }}>
      <div className="eyebrow">Newsroom</div>
      <h1 className="serif" style={{ fontSize: "var(--fs-display)", margin: "10px 0 8px" }}>UFC intelligence</h1>
      <p className="dim" style={{ maxWidth: "60ch", marginBottom: 32 }}>Every story is built from our own tables: card changes, weigh-ins, results with stats, rankings moves. External reporting is attributed and linked, never rewritten.</p>
      {articles.length ? <div className="news">{articles.map((a) => <StoryCard key={a.id} a={a} />)}</div> : (
        <Empty title="Nothing published yet">The newsroom only publishes when there is something real to say. The first stories arrive with the first ingested card. Subscribe to the RSS feed at /feed.xml to be there when they do.</Empty>
      )}
    </div>
  );
}
