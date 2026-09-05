import type { Metadata } from "next";
import { getFighters } from "@/lib/db";
import { Empty, FighterCard } from "@/components/ui";

export const revalidate = 300;
export const metadata: Metadata = { title: "UFC Fighters", description: "Fighter pages with records, physicals, fight history and round-level stats for every UFC fighter in the archive.", alternates: { canonical: "/fighters" } };

export default async function FightersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q || "").slice(0, 60);
  const fighters = await getFighters(q, 96);
  return (
    <div className="wrap" style={{ padding: "48px 24px" }}>
      <div className="eyebrow">Archive</div>
      <h1 className="serif" style={{ fontSize: "var(--fs-display)", margin: "10px 0 24px" }}>Fighters</h1>
      <form className="search" action="/fighters" method="get" role="search">
        <input type="search" name="q" defaultValue={q} placeholder="Search by name" aria-label="Search fighters" />
        <button type="submit" className="btn gold">Search</button>
      </form>
      {fighters.length ? (
        <div className="grid-3">{fighters.map((f) => <FighterCard key={f.id} f={f} />)}</div>
      ) : q ? (
        <Empty title={`No fighter matches “${q}”`}>Try a shorter name. The archive keys fighters by source id, so spelling variants resolve once the alias table grows.</Empty>
      ) : (
        <Empty title="Fighter archive loading">Fighters populate from ESPN card data and the UFC Stats backfill. Every fighter page carries record, physicals and full fight history.</Empty>
      )}
    </div>
  );
}
