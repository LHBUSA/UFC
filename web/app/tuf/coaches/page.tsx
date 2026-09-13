import type { Metadata } from "next";
import Link from "next/link";
import { Avatar, Empty, JsonLd, PageHead } from "@/components/ui";
import { getCoachHistory, type CoachSide } from "@/lib/tufGraph";
import { getVerifiedDisplayImagesForFighters } from "@/lib/verifiedPortraits";
import { getRankingIndex } from "@/lib/rankings";
import { bestRank } from "@/lib/rankingContext";
import { fighterSlug } from "@/lib/slug";
import { fmtDate } from "@/lib/format";
import { SITE } from "@/lib/site";
import { getFightersByIds, type PortraitSet } from "@/lib/db";

/* /tuf/coaches — every head-coach pairing, and what came of it.
 *
 * A coaches' fight is shown only when our own records hold a bout between the
 * two canonical fighter ids; it is dated, and placed before or after the
 * season. A pairing whose coach does not resolve to a fighter says so, rather
 * than being assumed never to have fought. Team records count in-house bouts
 * between the two rosters, so a season with no roster shows no record. */
export const revalidate = 900;

const TITLE = "TUF Coaches — Every Head-Coach Pairing | PropBetEdge UFC";
const DESCRIPTION = "Every head-coach pairing on The Ultimate Fighter: the season, the teams, in-house team records, the champions each team produced, and whether the two coaches fought in the UFC.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/tuf/coaches" },
  keywords: ["TUF coaches", "The Ultimate Fighter coaches", "TUF coaches fight", "TUF team records"],
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", url: `${SITE.url}/tuf/coaches` },
  twitter: { card: "summary_large_image", title: "TUF Coaches", description: DESCRIPTION },
};

const METHOD: Record<string, string> = { KO_TKO: "KO/TKO", SUB: "Submission", DEC_U: "Decision (unanimous)", DEC_S: "Decision (split)", DEC_M: "Decision (majority)", DQ: "DQ", NC: "No contest", DRAW: "Draw", OTHER: "Other" };

export default async function TufCoachesPage() {
  const [history, rankIndex] = await Promise.all([getCoachHistory(), getRankingIndex()]);
  if (!history) {
    return (
      <div className="wrap page">
        <PageHead eyebrow="The Ultimate Fighter" title="TUF Coaches" crumbs={[{ name: "The Ultimate Fighter", href: "/tuf" }, { name: "Coaches" }]} />
        <Empty title="Coach history unavailable" cta={{ href: "/tuf", label: "TUF archive" }}>The canonical fight database could not be read just now.</Empty>
      </div>
    );
  }
  const ids = [...new Set(history.flatMap((h) => [h.a.fighterId, h.b.fighterId]).filter(Boolean))] as string[];
  const [imgs, fighters] = await Promise.all([
    getVerifiedDisplayImagesForFighters(ids),
    getFightersByIds(ids).catch(() => []),
  ]);
  const byId = new Map(fighters.map((f) => [f.id, f]));
  const rows = [...history].sort((x, y) => y.season.year - x.season.year || y.season.number - x.season.number);
  const fought = rows.filter((h) => h.meetings.length).length;
  const resolved = rows.filter((h) => h.meetingsKnown).length;

  const Coach = ({ c, img }: { c: CoachSide; img?: PortraitSet }) => {
    const f = c.fighterId ? byId.get(c.fighterId) : null;
    const rank = c.fighterId ? bestRank(rankIndex?.byFighter.get(c.fighterId)) : null;
    return (
      <div className="tuf-coach">
        <Avatar f={{ name: c.name }} img={img} size={48} className="tuf-face" />
        <div>
          {f ? <Link className="tuf-name is-linked" href={`/fighters/${fighterSlug(f)}`}>{c.name}</Link> : <span className="tuf-name">{c.name}</span>}
          <small>
            {[c.team, c.teamW + c.teamL ? `house ${c.teamW}-${c.teamL}` : null, rank?.full].filter(Boolean).join(" · ")}
          </small>
          {c.champions.length ? <small className="tuf-coach-champ">Produced {c.champions.map((w) => `${w.name} (${w.weightClass})`).join(", ")}</small> : null}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="wrap">
        <div className="page">
          <PageHead
            eyebrow="The Ultimate Fighter"
            title="TUF Coaches"
            lede="Every head-coach pairing, the teams they ran, what their fighters did in the house, and whether the two coaches ever settled it in the Octagon."
            crumbs={[{ name: "The Ultimate Fighter", href: "/tuf" }, { name: "Coaches" }]}
          />
        </div>
      </div>

      <section className="wrap tuf-cov">
        <div className="tuf-cov-grid">
          <div className="tuf-cov-cell"><b>{rows.length}</b><span>head-coach pairings</span></div>
          <div className="tuf-cov-cell"><b>{resolved}</b><span>both coaches linked</span></div>
          <div className="tuf-cov-cell is-total"><b>{fought}</b><span>pairings that fought in the UFC</span></div>
        </div>
      </section>

      <section className="wrap tuf-section">
        <ul className="tuf-coach-list">
          {rows.map((h) => (
            <li key={h.season.slug} className="tuf-coach-row">
              <Link className="tuf-coach-season" href={`/tuf/${h.season.slug}`}>
                <b>{h.season.edition === "us" ? `TUF ${h.season.number}` : h.season.name.replace(/^The Ultimate Fighter:?\s*/i, "")}</b>
                <small>{h.season.year}</small>
              </Link>
              <div className="tuf-coach-pair">
                <Coach c={h.a} img={h.a.fighterId ? imgs.get(h.a.fighterId) : undefined} />
                <em>vs</em>
                <Coach c={h.b} img={h.b.fighterId ? imgs.get(h.b.fighterId) : undefined} />
              </div>
              <div className="tuf-coach-meet">
                {!h.meetingsKnown ? (
                  <span className="tuf-none">A coach does not resolve to a fighter record, so no meeting is shown.</span>
                ) : h.meetings.length ? (
                  h.meetings.map((m) => {
                    const winner = m.outcome === "W" ? h.a.name : m.outcome === "L" ? h.b.name : null;
                    const when = (m.eventDate || "").slice(0, 4);
                    const rel = when && Number(when) < h.season.year ? "before the season" : when && Number(when) > h.season.year ? "after the season" : "the season's year";
                    return (
                      <span key={m.boutId} className="tuf-coach-bout">
                        <b>{winner ? `${winner} won` : m.outcome === "D" ? "Draw" : "No contest"}</b>
                        {m.method && m.outcome !== "D" && m.outcome !== "NC" ? ` · ${METHOD[m.method] ?? m.method}` : ""}
                        {m.round ? ` · R${m.round}` : ""}
                        <small>{m.eventName} · {fmtDate(m.eventDate, { month: "short", day: "numeric", year: "numeric" })} · {rel}</small>
                      </span>
                    );
                  })
                ) : (
                  <span className="tuf-fine">No UFC bout between them in our records.</span>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p className="tuf-note">
          <b>How this is built.</b> Head coaches are the two named for each season; assistants and guests are listed on the season
          pages. A meeting is a stored UFC bout between the two coaches&rsquo; canonical fighter records, from the same tables as every
          event page. Team records count in-house bouts between the two rosters and are exhibitions, never professional results.
          &ldquo;Produced&rdquo; names a tournament winner who was on that coach&rsquo;s team roster.
        </p>
      </section>

      <JsonLd data={{ "@context": "https://schema.org", "@type": "CollectionPage", name: TITLE, description: DESCRIPTION, url: `${SITE.url}/tuf/coaches`, isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.url } }} />
    </>
  );
}
