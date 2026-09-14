import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { ProPreview } from "@/components/ProPreview";
import { AlgoPick } from "@/components/AlgoPick";
import { getUfcAccess } from "@/lib/access";
import { getAlgoCards } from "@/lib/algo";
import { lockedText } from "@/lib/algoView";

/* UFC Pro: the active PBE Algo card. Entitlement is decided before any read,
 * and getAlgoCards refuses a non-Pro caller on its own, so a free render never
 * holds a pick. Not indexed: the content is paid and changes hourly. */

export const metadata: Metadata = {
  title: "PBE Algo Card — UFC Pro",
  description: "PBE Algo calls for the upcoming UFC cards. UFC Pro.",
  alternates: { canonical: "/algo/card" },
  robots: { index: false, follow: true },
};

const LOCK_HOURS_BEFORE_EVENT_DAY = 8;

export default async function AlgoCardPage() {
  const access = await getUfcAccess();
  const cards = access.pro ? await getAlgoCards(access) : [];

  return (
    <div className="wrap page algo-page">
      <PageHead
        crumbs={[{ name: "PBE Algo", href: "/algo" }, { name: "Card" }]}
        eyebrow="UFC Pro · PBE Algo"
        title="The PBE Algo card"
        lede="Every UFC bout inside the next 14 days: the call and its probability where the bout is eligible, and the exact reason where it is not."
      >
        {access.pro && <div className="row mt-3"><Link href="/algo/record" className="btn">Full track record</Link><Link href="/algo" className="btn">Method</Link></div>}
      </PageHead>

      {!access.pro ? (
        <ProPreview feature="algo" access={access} returnPath="/algo/card" />
      ) : cards.length === 0 ? (
        <section className="card"><p className="dim">No UFC card is inside the 14-day horizon right now.</p></section>
      ) : cards.map((c) => {
        const cutoff = Date.parse(`${c.event_date}T00:00:00Z`);
        const lockAt = new Date(cutoff - LOCK_HOURS_BEFORE_EVENT_DAY * 3600e3).toISOString();
        const calls = c.bouts.filter((b) => b.decision === "ELIGIBLE").length;
        const noCalls = c.bouts.filter((b) => b.decision === "NO_MODEL_CALL").length;
        const locked = c.bouts.filter((b) => b.prediction?.locked_at).length;
        return (
          <section key={c.event_id} className="algo-event" aria-labelledby={`ev-${c.event_id}`}>
            <header className="algo-event-head">
              <div>
                <div className="eyebrow">{c.event_date}</div>
                <h2 id={`ev-${c.event_id}`}><Link href={`/events/${c.event_slug}`}>{c.event_name}</Link></h2>
              </div>
              <div className="algo-event-meta">
                <span><b>{calls}</b> call{calls === 1 ? "" : "s"}</span>
                <span><b>{noCalls}</b> no call</span>
                <span><b>{locked}</b> locked</span>
                <span>Lock pass from {lockedText(lockAt)}</span>
              </div>
            </header>
            <div className="algo-list">{c.bouts.map((b) => <AlgoPick key={b.bout_id} b={b} />)}</div>
          </section>
        );
      })}
    </div>
  );
}
