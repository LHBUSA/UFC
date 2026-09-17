import type { Metadata } from "next";
import Link from "next/link";
import { PbeFamilyNav } from "@/components/PbeFamilyNav";
import { Breadcrumbs } from "@/components/ui";
import { ProPreview } from "@/components/ProPreview";
import { AlgoPick, type AlgoFighterContext } from "@/components/AlgoPick";
import { getUfcAccess } from "@/lib/access";
import { getAlgoCards, getAlgoUpsetProof } from "@/lib/algo";
import { PbeUpsetRadar } from "@/components/PbeUpsetRadar";
import { getImagesForFighters, getFightersByIds, getEventById, type Event } from "@/lib/db";
import { lockedText, type AlgoBoutView } from "@/lib/algoView";
import { fmtDate, locationLine } from "@/lib/format";

/* PBE PICKS: the official PropBetEdge model selections (UFC Pro PBE Algo card).
 * Entitlement is decided before any read, and getAlgoCards refuses a non-Pro
 * caller on its own, so a free render never holds a pick. Portraits come from
 * getImagesForFighters() and records/venue from the fighter and event rows:
 * presentation reads only, fetched after the Pro gate. Not indexed: the
 * content is paid and changes hourly. */

export const metadata: Metadata = {
  title: "PBE Picks — Official PropBetEdge Model Selections · UFC Pro",
  description: "PBE Picks: the official PropBetEdge model selections (PBE Algo) for the upcoming UFC cards. UFC Pro.",
  alternates: { canonical: "/algo/card" },
  robots: { index: false, follow: true },
};

const LOCK_HOURS_BEFORE_EVENT_DAY = 8;
type View = "picks" | "nocalls" | "all";
const VIEWS: Array<[View, string]> = [["picks", "PBE Picks"], ["nocalls", "No calls"], ["all", "All"]];
const SEGMENTS: Array<[string, string]> = [["main", "Main card"], ["prelim", "Prelims"], ["early", "Early prelims"], ["", "Card"]];

const isCall = (b: AlgoBoutView) => b.decision === "ELIGIBLE" && Boolean(b.pick_fighter_id) && b.pick_probability != null;
const counts = (bouts: AlgoBoutView[]) => ({
  picks: bouts.filter(isCall).length,
  noCalls: bouts.filter((b) => b.decision === "NO_MODEL_CALL").length,
  locked: bouts.filter((b) => b.prediction?.locked_at).length,
});
const modelLabel = (v: string | null | undefined) => (v ? v.replace(/^pbe-fight-model-v/i, "PBE Fight Model V").toUpperCase() : "PBE FIGHT MODEL");

export default async function AlgoCardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await getUfcAccess();
  const [cards, upsetProof] = await Promise.all([
    access.pro ? getAlgoCards(access) : Promise.resolve([]),
    getAlgoUpsetProof(),
  ]);
  const params = await searchParams;
  const view: View = params.view === "nocalls" || params.view === "all" ? params.view : "picks";

  const fighterIds = cards.flatMap((c) => c.bouts.flatMap((b) => [b.fighter_a.id, b.fighter_b.id]));
  const [imgs, fighterRows, events] = access.pro && fighterIds.length
    ? await Promise.all([getImagesForFighters(fighterIds), getFightersByIds([...new Set(fighterIds)]), Promise.all(cards.map((c) => getEventById(c.event_id)))])
    : [new Map(), [], [] as Array<Event | null>];
  const fighters = new Map<string, AlgoFighterContext>(fighterRows.map((f) => [f.id, f]));
  const eventById = new Map(events.filter((e): e is Event => Boolean(e)).map((e) => [e.id, e]));

  const lead = cards[0];
  const leadCounts = lead ? counts(lead.bouts) : null;
  const leadLifecycle = leadCounts && leadCounts.picks > 0 && leadCounts.locked === leadCounts.picks ? "OFFICIAL PICKS LOCKED" : "PRE-LOCK";
  const leadModel = lead?.bouts.find((b) => b.model_version)?.model_version;
  const leadEvent = lead ? eventById.get(lead.event_id) : null;

  return (
    <div className="wrap page algo-page pp-page">
      <Breadcrumbs items={[{ name: "PBE Algo", href: "/algo" }, { name: "PBE Picks" }]} />

      <header className="pp-hero">
        <div className="pp-hero-eyebrow">UFC Pro · PBE Algo</div>
        <h1 className="pp-hero-title">PBE PICKS</h1>
        <p className="pp-hero-sub">Official PropBetEdge model selections</p>
        {lead && leadCounts ? (
          <>
            <div className="pp-hero-event">
              <Link href={`/events/${lead.event_slug}`}>{lead.event_name}</Link>
              <span>{fmtDate(lead.event_date)}{leadEvent && locationLine(leadEvent) ? ` · ${locationLine(leadEvent)}` : ""}</span>
            </div>
            <div className="pp-truth" aria-label="Current card state">
              <span><b>{leadCounts.picks}</b> Picks</span>
              <span><b>{leadCounts.noCalls}</b> No calls</span>
              <span><b>{leadCounts.locked}</b> Locked</span>
            </div>
            <div className="pp-chips">
              <span className="pp-chip model">{modelLabel(leadModel)}</span>
              <span className={`pp-chip ${leadLifecycle === "PRE-LOCK" ? "prelock" : "locked"}`}>{leadLifecycle}</span>
            </div>
          </>
        ) : (
          <p className="pp-hero-lede">Every eligible UFC bout gets a pick with its win probability and confidence, locked on the database clock before the fight and graded after it. A bout the model will not call shows the exact reason.</p>
        )}
        <div className="pp-hero-actions">
          <Link href="/algo/record" className="btn gold">Track Record</Link>
          <Link href="/algo" className="btn">How PBE Algo works</Link>
          <Link href="/model" className="btn ghost">Model evidence</Link>
        </div>
      </header>

      <div className="pp-picks-layout">
        <main className="pp-picks-main">
      {!access.pro ? (
        <section className="pp-free">
          <div className="pp-teaser" aria-hidden="true">
            <span className="pp-photo blank" />
            <span className="pp-teaser-mid"><i>PBE Pick</i><b /><em /></span>
            <span className="pp-photo blank" />
          </div>
          <ProPreview feature="picks" access={access} returnPath="/algo/card" />
        </section>
      ) : cards.length === 0 ? (
        <section className="card"><p className="dim">No UFC card is inside the 14-day horizon right now.</p></section>
      ) : (
        <>
          <nav className="pp-filter" aria-label="Filter picks">
            {VIEWS.map(([v, label]) => <Link key={v} href={v === "picks" ? "/algo/card" : `/algo/card?view=${v}`} aria-current={view === v ? "page" : undefined} scroll={false}>{label}</Link>)}
          </nav>

          {cards.map((c) => {
            const cutoff = Date.parse(`${c.event_date}T00:00:00Z`);
            const lockAt = new Date(cutoff - LOCK_HOURS_BEFORE_EVENT_DAY * 3600e3).toISOString();
            const n = counts(c.bouts);
            const ev = eventById.get(c.event_id);
            const shown = c.bouts.filter((b) => (view === "all" ? true : view === "picks" ? isCall(b) : !isCall(b)));
            return (
              <section key={c.event_id} className="pp-event" aria-labelledby={`ev-${c.event_id}`}>
                <header className="pp-event-head">
                  <div>
                    <div className="eyebrow">{fmtDate(c.event_date)}{ev && locationLine(ev) ? ` · ${locationLine(ev)}` : ""}</div>
                    <h2 id={`ev-${c.event_id}`}><Link href={`/events/${c.event_slug}`}>{c.event_name}</Link></h2>
                  </div>
                  <div className="pp-event-meta">
                    <span><b>{n.picks}</b> PBE Pick{n.picks === 1 ? "" : "s"}</span>
                    <span><b>{n.noCalls}</b> No call{n.noCalls === 1 ? "" : "s"}</span>
                    <span><b>{n.locked}</b> Locked</span>
                    <span>Lock pass from {lockedText(lockAt)}</span>
                  </div>
                </header>
                {shown.length === 0 ? (
                  <p className="dim pp-empty">{view === "nocalls" ? "The model has a pick on every evaluated bout of this card." : "No PBE Pick on this card yet."}</p>
                ) : SEGMENTS.map(([seg, label]) => {
                  const bouts = shown.filter((b) => (seg ? b.card_position === seg : !["main", "prelim", "early"].includes(b.card_position || "")));
                  if (!bouts.length) return null;
                  return (
                    <div key={seg || "card"} className="pp-segment">
                      <h3 className="pp-segment-head">{label}</h3>
                      <div className="pp-list">{bouts.map((b) => <AlgoPick key={b.bout_id} b={b} imgs={imgs} fighters={fighters} />)}</div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </>
      )}
        </main>

        <aside className="pp-picks-sidecar" aria-label="PBE Upset Radar">
          <PbeUpsetRadar access={access} proof={upsetProof} cards={cards} surface="picks" />
        </aside>
      </div>

      <PbeFamilyNav current="picks" />
    </div>
  );
}
