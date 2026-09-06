import Link from "next/link";
import { getNextEvent, getEventBouts, getUpcomingEvents, getRecentEvents, getArticles, getCounts } from "@/lib/db";
import { CardSegments, Empty, EventCard, FightPoster, MatchupCard, ProPlans, SectionHead, StoryCard, JsonLd } from "@/components/ui";
import { eventSlug } from "@/lib/slug";
import { fmtDate } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 300;

export default async function Home() {
  const [next, upcoming, recent, articles, counts] = await Promise.all([getNextEvent(), getUpcomingEvents(4), getRecentEvents(3), getArticles(3), getCounts()]);
  const bouts = next ? await getEventBouts(next.id) : [];
  const main = bouts.slice(0, 3);

  return (
    <>
      <section className="hero">
        <div className="wrap hero-grid">
          <div>
            <div className="eyebrow">PropBetEdge · Fight Intelligence OS</div>
            <h1>Every card. Every change. <em>Priced before the market moves.</em></h1>
            <p className="lede">
              UFC cards change 15 to 20 percent of the time before fight night and there is no injury report. PropBetEdge UFC
              tracks the card, archives every fighter and round, and grades its model on calibration and closing-line value, never hit rate.
            </p>
            <div className="hero-actions">
              <Link href={next ? `/events/${eventSlug(next)}` : "/events"} className="btn gold lg">{next ? "Open next card" : "Browse events"}</Link>
              <Link href="/pro" className="btn lg">What ships with Pro</Link>
            </div>
            <div className="hero-stats">
              <div className="stat"><b>{counts.fighters ?? "—"}</b><span>Fighters archived</span></div>
              <div className="stat"><b>{counts.events ?? "—"}</b><span>Events</span></div>
              <div className="stat"><b>{counts.results ?? "—"}</b><span>Graded results</span></div>
            </div>
          </div>
          <div>
            {next ? (
              <Link href={`/events/${eventSlug(next)}`} style={{ display: "block" }} aria-label={`Open ${next.name}`}>
                <FightPoster e={next} bouts={bouts} />
              </Link>
            ) : (
              <Empty title="Next card loading">
                The schedule populates from the ingest worker. When the next UFC event is announced it appears here with the full card, main to early prelims.
              </Empty>
            )}
          </div>
        </div>
      </section>

      <section className="sec">
        <div className="wrap">
          <SectionHead eyebrow={next ? fmtDate(next.event_date) : "Upcoming"} title={next ? next.name : "Upcoming card"} href={next ? `/events/${eventSlug(next)}` : "/events"} cta="Full card" />
          {bouts.length ? (
            <CardSegments bouts={bouts} e={next!} />
          ) : (
            <Empty title="No bouts announced yet">Bouts appear here the moment ESPN publishes the card. Nothing is shown that has not been announced.</Empty>
          )}
        </div>
      </section>

      {main.length > 0 && (
        <section className="sec">
          <div className="wrap">
            <SectionHead eyebrow="Matchups" title="Headline matchups" />
            <div className="grid-3">
              {main.map((b) => <MatchupCard key={b.id} b={b} e={next!} />)}
            </div>
          </div>
        </section>
      )}

      <section className="sec">
        <div className="wrap">
          <SectionHead eyebrow="Schedule" title="Coming up" href="/events" />
          {upcoming.length ? (
            <div className="grid-2">{upcoming.map((e) => <EventCard key={e.id} e={e} />)}</div>
          ) : (
            <Empty title="Schedule loading">Upcoming events are pulled from ESPN's public schedule and refreshed nightly.</Empty>
          )}
        </div>
      </section>

      <section className="sec">
        <div className="wrap">
          <SectionHead eyebrow="Newsroom" title="Latest intelligence" href="/news" />
          {articles.length ? (
            <div className="news">{articles.map((a) => <StoryCard key={a.id} a={a} />)}</div>
          ) : (
            <Empty title="Newsroom opens with the first card">Card changes, weigh-in reports, results and previews are written from our own tables, so nothing runs until the data does.</Empty>
          )}
        </div>
      </section>

      {recent.length > 0 && (
        <section className="sec">
          <div className="wrap">
            <SectionHead eyebrow="Results" title="Recent events" href="/events" />
            <div className="grid-3">{recent.map((e) => <EventCard key={e.id} e={e} />)}</div>
          </div>
        </section>
      )}

      <section className="sec">
        <div className="wrap">
          <SectionHead eyebrow="Free vs Pro" title="Everything public is free. The edge is Pro." />
          <ProPlans />
        </div>
      </section>

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "WebPage", "@id": `${SITE.url}/#home`, url: SITE.url, name: `${SITE.name} — ${SITE.tagline}`,
        description: SITE.description, isPartOf: { "@id": `${SITE.url}/#site` },
      }} />
    </>
  );
}
