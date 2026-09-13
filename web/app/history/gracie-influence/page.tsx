import type { Metadata } from "next";
import Link from "next/link";

import { Breadcrumbs, JsonLd, Avatar, Credit } from "@/components/ui";
import { Mark } from "@/components/Brand";
import { getFighterBouts, getImagesForFighters } from "@/lib/db";
import { resolveFighter } from "@/lib/resolve";
import {
  GRACIE_ARCHIVE_FLOOR, GRACIE_FIGURES, GRACIE_MOMENTS, GRACIE_RULES_THEN_NOW,
  UFC_OFFICIAL,
} from "@/lib/heritage";
import { fmtDate, fmtTime, METHOD_LABEL } from "@/lib/format";
import { matchupSlug } from "@/lib/slug";
import { SITE } from "@/lib/site";

/* /history/gracie-influence — the deep account behind /history#gracie.
 *
 * Built on our own archive rather than on assertion: every bout on this page
 * is a row in ufc_bouts with a stored result, and each one links to the fight
 * page holding it. That is also why the page states its boundary out loud:
 * the archive begins at UFC 1 (added 2026-09-13 from ESPN's record,
 * cross-checked against the UFC Stats capture), and anything it does not hold
 * is sent to UFC.com instead of to an internal page we do not have.
 *
 * The argument is deliberately narrow: early tournament results demonstrated
 * the competitive value of grappling and changed what fighters had to train.
 * Not that the Gracies invented the sport, not that Royce won UFC 3, and not
 * that 1994 settles anything about modern MMA — which is why the UFC 60 loss
 * is on the page rather than left off it. */

export const revalidate = 86400;

/* Identity by the stable UFC Stats id, the same key the live fighter URL
 * uses. Never a hardcoded row uuid. */
const ROYCE_SLUG = "royce-gracie-429e7d3725852ce9";

const TITLE = "The Gracie Influence — Royce Gracie and the Early UFC";
const DEK =
  "How jiu-jitsu changed the early UFC, told from the bouts PropBetEdge actually holds: the early tournament wins, the finishes that produced them, and the limits of what those results prove.";

export const metadata: Metadata = {
  title: TITLE,
  description: DEK,
  alternates: { canonical: "/history/gracie-influence" },
  openGraph: { title: TITLE, description: DEK, url: `${SITE.url}/history/gracie-influence`, images: [`${SITE.url}/opengraph-image`] },
  twitter: { card: "summary_large_image", title: TITLE, description: DEK, images: [`${SITE.url}/opengraph-image`] },
};

const EARLY_EVENTS = ["UFC 1", "UFC 2", "UFC 3", "UFC 4", "UFC 5"];
const secs = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;

export default async function GracieInfluencePage() {
  const royce = await resolveFighter(ROYCE_SLUG);
  /* ONE fighter-scoped archive query, through the reader the fighter page
   * already uses. Fails closed: no archive, no invented history. */
  const bouts = royce ? await getFighterBouts(royce.id).catch(() => []) : [];
  const withResult = bouts.filter((b) => b.result && b.event);
  const chronological = [...withResult].sort((a, b) =>
    String(a.event?.event_date || "").localeCompare(String(b.event?.event_date || "")));

  const figureNames = GRACIE_FIGURES.filter((f) => f.inArchive).map((f) => f.name);
  const figureFighters = await Promise.all(
    figureNames.map((n) => resolveFighterByName(n, chronological, royce)),
  );
  const imgs = await getImagesForFighters(figureFighters.filter(Boolean).map((f) => f!.id)).catch(() => new Map());

  /* Derived from the rows on this page, never typed in by hand. */
  const early = chronological.filter((b) => EARLY_EVENTS.some((e) => (b.event?.name || "").startsWith(`${e}:`)));
  const wins = early.filter((b) => b.result?.winner_id === royce?.id);
  const subs = wins.filter((b) => b.result?.method === "SUB").length;
  const runFor = (event: string) => {
    const rows = early.filter((b) => (b.event?.name || "").startsWith(`${event}:`) && b.result?.winner_id === royce?.id);
    const t = rows.reduce((n, b) => n + (b.result?.time_sec ?? 0), 0);
    return { fights: rows.length, time: t };
  };
  const ufc2 = runFor("UFC 2");
  const ufc4 = runFor("UFC 4");

  const byEvent = new Map<string, typeof chronological>();
  for (const b of chronological) {
    const k = b.event?.name || "Unknown";
    if (!byEvent.has(k)) byEvent.set(k, []);
    byEvent.get(k)!.push(b);
  }

  return (
    <div className="wrap page heritage-page">
      <Breadcrumbs items={[{ name: "History", href: "/history" }, { name: "The Gracie Influence" }]} />

      <section className="heritage-hero gi-hero">
        <div className="heritage-hero-copy">
          <div className="row"><Mark size={34} /><span className="eyebrow">Era 02 · 1993 → 1995</span></div>
          <h1>The Gracie Influence</h1>
          <p className="lede">
            Brazilian jiu-jitsu did not win the early UFC because it was a secret. It won because the tournaments were,
            briefly, an honest test of one question: what happens when a fight reaches the ground and only one man knows
            what to do there. Royce Gracie answered it in public, repeatedly, usually as the smallest man in the bracket —
            and the answer changed what every serious fighter afterwards had to train.
          </p>
          <div className="heritage-actions">
            <Link href="/history#gracie" className="btn">← Back to the era index</Link>
            <a href={UFC_OFFICIAL.ufc1} className="btn gold" target="_blank" rel="noopener">Official UFC 1 page ↗</a>
            <a href={UFC_OFFICIAL.hallOfFame} className="btn" target="_blank" rel="noopener">UFC Hall of Fame ↗</a>
          </div>
        </div>
        <div className="heritage-hero-art gi-hero-art">
          <div className="heritage-year">1993</div>
          <div className="gi-stat-stack">
            {wins.length > 0 && <div className="gi-stat"><b>{wins.length}</b><span>early tournament wins in our archive</span></div>}
            {subs > 0 && <div className="gi-stat"><b>{subs}</b><span>of them by submission</span></div>}
            {ufc2.fights > 0 && <div className="gi-stat"><b>{secs(ufc2.time)}</b><span>total cage time across {ufc2.fights} fights at UFC 2</span></div>}
          </div>
          <div className="heritage-era">Style vs style <i /> Grappling literacy</div>
        </div>
      </section>

      {/* The boundary, stated before any claim rests on it. */}
      <section className="segment">
        <div className="gi-gap" role="note">
          <b>What this page is built on.</b>
          <p>
            Every bout below is a row in the PropBetEdge archive with a stored result, and each links to the fight page
            holding it. That archive begins at <strong>{GRACIE_ARCHIVE_FLOOR}</strong>, the first event, so both meetings
            between Royce Gracie and Ken Shamrock are on file: the UFC 1 submission and the UFC 5 draw. The early cards are
            recorded as their own rules had them — UFC 1 had no time limit — and where sources disagree, as they do on who
            refereed which UFC 1 bout, we leave the field unresolved rather than pick one.
          </p>
        </div>
      </section>

      <section className="segment" id="thesis">
        <h3>The argument <small>and its limits</small></h3>
        <div className="card gi-thesis">
          <p>
            The claim worth defending is a narrow one. Royce Gracie&rsquo;s early results demonstrated the
            <strong> competitive value of grappling</strong> and materially changed what fighters needed to train. They did
            not establish that one art is superior, and they are not evidence about modern MMA — a sport that spent the next
            decade absorbing exactly the skills these tournaments exposed.
          </p>
          <p>
            Three things this page will not tell you: that the Gracies invented mixed martial arts — cross-style contests
            long predate 1993, and what 1993 added was a televised, repeatable, public test; that Royce won UFC 3 — he beat
            Kimo Leopoldo and withdrew; or that 1994 settles anything about 2026. The last of those is why his 2006 loss to
            Matt Hughes appears here rather than being quietly left off.
          </p>
        </div>
      </section>

      <section className="segment" id="timeline">
        <h3>Key moments <small>1993 → 2006</small></h3>
        <ol className="gi-timeline">
          {GRACIE_MOMENTS.map((m) => (
            <li key={m.key} data-archived={m.archived ? "true" : "false"}>
              <div className="gi-tl-rail">
                <span className="gi-tl-event">{m.event}</span>
                <span className="gi-tl-date">{m.date}</span>
              </div>
              <div className="gi-tl-body">
                <h4>{m.title}</h4>
                <p>{m.body}</p>
                {m.archived ? null : (
                  <div className="gi-tl-gap">
                    Not in the PropBetEdge archive ·{" "}
                    <a href={m.official} target="_blank" rel="noopener">official UFC record ↗</a>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {chronological.length > 0 && (
        <section className="segment" id="archive-run">
          <h3>The run, from our archive <small>{chronological.length} bouts on file</small></h3>
          <div className="gi-runs">
            {[...byEvent.entries()].map(([eventName, rows]) => (
              <div className="gi-run" key={eventName}>
                <div className="gi-run-head">
                  <b>{eventName}</b>
                  <span>{fmtDate(rows[0].event!.event_date)}</span>
                </div>
                <ul>
                  {rows.map((b) => {
                    const opp = b.fighter_a.id === royce?.id ? b.fighter_b : b.fighter_a;
                    const won = b.result?.winner_id === royce?.id;
                    const drew = b.result?.method === "DRAW";
                    return (
                      <li key={b.id} data-outcome={drew ? "draw" : won ? "win" : "loss"}>
                        <Link href={`/fights/${matchupSlug(b.fighter_a, b.fighter_b, b.event!)}`}>
                          <span className="gi-opp">{opp.name}</span>
                          <span className="gi-meth">
                            {drew ? "Draw" : METHOD_LABEL[b.result!.method] || b.result!.method}
                            {b.result?.finish_detail ? ` · ${b.result.finish_detail}` : ""}
                          </span>
                          <span className="gi-time">
                            {b.result?.time_sec != null ? fmtTime(b.result.time_sec) : "—"}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          {ufc4.fights > 0 && (
            <p className="gi-derived">
              Derived from these rows: {ufc2.fights > 0 && <>UFC 2 was <strong>{ufc2.fights} fights in {secs(ufc2.time)}</strong> of total cage time; </>}
              UFC 4 was <strong>{ufc4.fights} fights in {secs(ufc4.time)}</strong>, nearly sixteen minutes of it in the final against Dan Severn.
              {subs > 0 && <> {subs} of the {wins.length} early wins on file ended in a submission.</>}
            </p>
          )}
        </section>
      )}

      <section className="segment" id="figures">
        <h3>Key figures</h3>
        <div className="gi-figures">
          {GRACIE_FIGURES.map((f) => {
            const fighter = figureFighters[figureNames.indexOf(f.name)] || null;
            const img = fighter ? imgs.get(fighter.id) : null;
            return (
              <article className="gi-figure" key={f.name}>
                <div className="gi-figure-head">
                  {fighter ? <Avatar f={{ name: f.name }} img={img} size={52} /> : <span className="gi-figure-nomedia" aria-hidden="true">—</span>}
                  <div>
                    <b>{f.name}</b>
                    <span>{f.role}</span>
                  </div>
                </div>
                <p>{f.body}</p>
                {img ? <Credit img={img} /> : null}
                <a href={f.official} target="_blank" rel="noopener">Official UFC record ↗</a>
              </article>
            );
          })}
        </div>
        <p className="gi-note">
          Portraits shown are openly licensed images already held in the PropBetEdge media registry, with their licence and
          author rendered beside them. No UFC, Zuffa or agency photography is reproduced here. Rorion Gracie is covered in
          text and official links only, because no reusable portrait is on file.
        </p>
      </section>

      <section className="segment" id="why">
        <h3>Why it mattered</h3>
        <div className="card gi-thesis">
          <p>
            Before 1993 a fighter could be excellent and one-dimensional. The early tournaments made that a liability in
            public: a striker who could not stop a takedown, or who did not know what a triangle felt like before it closed,
            lost to someone smaller. The lesson was not that jiu-jitsu beats striking — it was that a fight travels through
            ranges, and a fighter who cannot compete in one of them is choosing to lose there.
          </p>
          <p>
            What followed was adaptation rather than replacement. Wrestlers learned submission defence. Strikers learned to
            get up. Within a decade the phrase &ldquo;mixed martial artist&rdquo; described a single trained discipline
            rather than a meeting of separate ones — and the sport stopped asking which style wins, because the answer had
            become that no single style competes any more.
          </p>
        </div>
      </section>

      <section className="segment" id="then-now">
        <h3>How the early rules differed <small>then → now</small></h3>
        <div className="gi-rules">
          {GRACIE_RULES_THEN_NOW.map((r) => (
            <div className="gi-rule" key={r.label}>
              <span className="gi-rule-l">{r.label}</span>
              <span className="gi-rule-then">{r.then}</span>
              <span className="gi-rule-arrow" aria-hidden="true">→</span>
              <span className="gi-rule-now">{r.now}</span>
            </div>
          ))}
        </div>
        <p className="gi-note">
          The rules era that produced these changes is covered in{" "}
          <Link href="/history#rules">era 03 of the history index</Link>.
        </p>
      </section>

      <section className="segment" id="sources">
        <h3>Official sources &amp; further reading</h3>
        <div className="heritage-source-row">
          <a href={UFC_OFFICIAL.ufc1} target="_blank" rel="noopener">Official UFC 1 event page ↗</a>
          <a href={UFC_OFFICIAL.history30} target="_blank" rel="noopener">UFC&rsquo;s 30-year history ↗</a>
          <a href={UFC_OFFICIAL.hallOfFame} target="_blank" rel="noopener">UFC Hall of Fame · Pioneer Wing ↗</a>
          <a href={UFC_OFFICIAL.fightPass} target="_blank" rel="noopener">UFC Fight Pass archive ↗</a>
        </div>
        <p className="gi-note">
          UFC.com owns the official record. PropBetEdge adds independent context and the archive underneath it. No
          partnership, sponsorship or endorsement is implied.
        </p>
      </section>

      <section className="segment" id="modern">
        <h3>The line to the modern sport</h3>
        <div className="heritage-close">
          <p>
            The grappling literacy these tournaments forced is now simply assumed, which is why it is measured rather than
            argued about. Round-by-round control time, takedown and submission attempts, positional breakdowns — the things
            Royce Gracie&rsquo;s opponents had no framework for — are ordinary columns in this archive today.
          </p>
          <div className="heritage-close-actions">
            <Link href="/history" className="btn">All seven eras →</Link>
            <Link href="/hall-of-fame" className="btn gold">Hall of Fame tribute →</Link>
            <Link href={`/fighters/${ROYCE_SLUG}`} className="btn">Royce Gracie profile →</Link>
            <Link href="/round-by-round" className="btn">Round-by-Round intelligence →</Link>
          </div>
        </div>
      </section>

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Article",
          "@id": `${SITE.url}/history/gracie-influence#article`,
          headline: "The Gracie Influence — Royce Gracie and the Early UFC",
          description: DEK,
          url: `${SITE.url}/history/gracie-influence`,
          isPartOf: { "@type": "WebPage", "@id": `${SITE.url}/history`, name: "UFC History" },
          about: GRACIE_FIGURES.map((f) => ({ "@type": "Person", name: f.name })),
          mentions: GRACIE_MOMENTS.map((m) => ({ "@type": "Event", name: m.event, startDate: m.date })),
          citation: [UFC_OFFICIAL.ufc1, UFC_OFFICIAL.history30, UFC_OFFICIAL.hallOfFame],
          publisher: { "@type": "Organization", name: SITE.name, url: SITE.url },
        }}
      />
    </div>
  );
}

/* The archive fighters behind the figure cards. Resolved from the bouts we
 * already loaded where possible, so the page does not issue a query per
 * person; Royce is already in hand. */
async function resolveFighterByName(
  name: string,
  bouts: Awaited<ReturnType<typeof getFighterBouts>>,
  royce: Awaited<ReturnType<typeof resolveFighter>>,
): Promise<{ id: string; name: string } | null> {
  if (royce && royce.name === name) return { id: royce.id, name: royce.name };
  for (const b of bouts) {
    for (const f of [b.fighter_a, b.fighter_b]) if (f.name === name) return { id: f.id, name: f.name };
  }
  return null;
}
