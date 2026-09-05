import type { Metadata } from "next";
import Link from "next/link";
import { Empty } from "@/components/ui";
import { WEIGHT_LABEL } from "@/lib/format";

export const metadata: Metadata = { title: "UFC Rankings", description: "Official UFC rankings by division with movers after every card, tracked over time by PropBetEdge.", alternates: { canonical: "/rankings" } };

const DIVISIONS = ["FLYWEIGHT", "BANTAMWEIGHT", "FEATHERWEIGHT", "LIGHTWEIGHT", "WELTERWEIGHT", "MIDDLEWEIGHT", "LIGHT_HEAVYWEIGHT", "HEAVYWEIGHT"];
const WOMENS = ["STRAWWEIGHT", "FLYWEIGHT", "BANTAMWEIGHT"];

export default function RankingsPage() {
  return (
    <div className="wrap" style={{ padding: "48px 24px" }}>
      <div className="eyebrow">Divisions</div>
      <h1 className="serif" style={{ fontSize: "var(--fs-display)", margin: "10px 0 8px" }}>UFC rankings</h1>
      <p className="dim" style={{ maxWidth: "60ch", marginBottom: 32 }}>
        Rankings are tracked as a history so every move is dated and linked to the fight that caused it. The rankings ingest ships in the next phase; the divisions below are the structure it fills.
      </p>
      <Empty title="Rankings history not loaded yet">No ranking is displayed until it comes from the tracked source with a date attached. Nothing here is estimated.</Empty>
      <div className="grid-3" style={{ marginTop: 32 }}>
        {[...DIVISIONS.map((d) => ({ d, w: false })), ...WOMENS.map((d) => ({ d, w: true }))].map(({ d, w }) => (
          <div key={`${w}-${d}`} className="card">
            <div className="eyebrow dim">{w ? "Women's" : "Men's"}</div>
            <h3 style={{ fontFamily: "var(--pbe-font-display)", margin: "6px 0 10px" }}>{WEIGHT_LABEL[d]}</h3>
            <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>Champion and top 15 appear here once tracked.</div>
            <Link href="/fighters" style={{ color: "var(--pbe-gold)", fontSize: "var(--fs-sm)", fontWeight: 600, display: "inline-block", marginTop: 10 }}>Browse fighters →</Link>
          </div>
        ))}
      </div>
    </div>
  );
}
