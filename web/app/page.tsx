import Link from "next/link";
import { getNextEvent, getEventBouts, getUpcomingEvents, getRecentEvents, getArticles, getCounts, getImagesForFighters, getMainEvents, getRankings, getFightersByIds, getBoutCounts, getFightWeekVideos, getImageFraming, isContenderSeries, getTicker } from "@/lib/db";
import { CardSegments, Empty, EventCard, MatchupCard, ProPlans, SectionHead, JsonLd, Avatar, Octagon } from "@/components/ui";
import { NewsStoryCard } from "@/components/NewsStoryCard";
import { Mark } from "@/components/Brand";
import { PregameDesk } from "@/components/PregameDesk";
import { ChampionsShowcase } from "@/components/ChampionsShowcase";
import { ContenderStrip } from "@/components/ContenderStrip";
import { VideoRail } from "@/components/VideoRail";
import { OfficialDestinations } from "@/components/OfficialDestinations";
import { FightDnaShowcase } from "@/components/FightDnaShowcase";
import { buildDeskBriefs } from "@/lib/pregame";
import { intelligenceUpdated } from "@/lib/fightweek";
import { getIngestFreshness } from "@/lib/archive";
import { isDanaWhiteContenderSeries } from "@/lib/contender";
import { eventSlug, fighterSlug } from "@/lib/slug";
import { fmtDate, daysUntil, locationLine, eventBrand, eventHeadline, fmtRecord, weightClassLabel, relTime } from "@/lib/format";
import { SITE } from "@/lib/site";
import { UFC_OFFICIAL } from "@/lib/heritage";
import { storyMedia } from "@/lib/faces";
import { Voices } from "@/components/Voices";
import { ApiCta } from "@/components/ApiCta";
import { getBroadcastForEvent } from "@/lib/broadcast";
import { WatchStrip } from "@/components/HowToWatch";

export const revalidate = 300;

/* The four live archive counts, with their glyphs. A table rather than four
 * near-identical JSX blocks: adding a fifth stat is one row, and the icon and
 * the count can never drift apart. Keys are the fields getCounts() returns. */
const HERO_STATS = [
  {
    key: "events" as const,
    label: "All indexed events",
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="12" height="11" rx="2" /><path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4" />
      </svg>
    ),
  },
  {
    key: "fighters" as const,
    label: "Fighters",
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="5.2" r="2.6" /><path d="M2.8 13.6c.7-2.7 2.7-4.1 5.2-4.1s4.5 1.4 5.2 4.1" />
      </svg>
    ),
  },
  {
    key: "results" as const,
    label: "Results loaded",
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.6 13.4V8.2M6.9 13.4V3.6M11.2 13.4v-6" /><path d="M1.4 13.4h13.2" />
      </svg>
    ),
  },
  {
    key: "rounds" as const,
    label: "Round-stat rows",
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.6" y="2" width="10.8" height="12" rx="1.8" /><path d="M5.4 5.4h5.2M5.4 8h5.2M5.4 10.6h3.1" />
      </svg>
    ),
  },
];

export default async function Home() {
  const [next, upcomingRaw, recent, articlesRes, counts, rankings, wire, allUpcoming, recentAll] = await Promise.all([
    getNextEvent(), getUpcomingEvents(7), getRecentEvents(3), getArticles(7), getCounts(), getRankings(), getTicker(8),
    getUpcomingEvents(30, { includeContenderSeries: true }), getRecentEvents(20),
  ]);
  const articles = articlesRes.rows;
  const upcoming = upcomingRaw.filter((e) => e.id !== next?.id && !isContenderSeries(e.name)).slice(0, 6);
  const bouts = next ? await getEventBouts(next.id) : [];
  /* Verified start times and carriers for the next card, from our own table.
   * The homepage never waits on UFC.com; a failure renders no strip. */
  const broadcast = next ? await getBroadcastForEvent(next).catch(() => null) : null;
  const live = bouts.filter((b) => b.status !== "cancelled");
  const mainEvent = live[0] || null;
  const headline = live.slice(0, 3);
  const d = next ? daysUntil(next.event_date) : null;
  const dwcsNext = allUpcoming.find((e) => isDanaWhiteContenderSeries(e.name)) || null;
  const dwcsLast = recentAll.find((e) => isDanaWhiteContenderSeries(e.name)) || null;

  const contenderIds = (rankings?.divisions || []).filter((x) => !x.is_p4p && x.champion).flatMap((x) => x.entries.slice(0, 3).map((e) => e.fighter_id)).filter(Boolean) as string[];
  const mains = await getMainEvents([...upcoming, ...recent, ...[dwcsNext, dwcsLast].filter(Boolean).map((e) => e!)].map((e) => e.id));
  const champIds = (rankings?.divisions || []).filter((x) => !x.is_p4p && x.champion?.fighter_id).map((x) => x.champion!.fighter_id!);
  const [imgs, briefs, media, champs, contenders, dwcsCounts, freshness, videos] = await Promise.all([
    getImagesForFighters([
      ...bouts.flatMap((b) => [b.fighter_a.id, b.fighter_b.id]),
      ...[...mains.values()].flatMap((b) => [b.fighter_a.id, b.fighter_b.id]),
      ...champIds, ...contenderIds,
    ]),
    next && live.length ? buildDeskBriefs(next, live, 1).catch(() => []) : Promise.resolve([]),
    storyMedia(articles),
    getFightersByIds(champIds),
    getFightersByIds(contenderIds),
    getBoutCounts([dwcsNext?.id, dwcsLast?.id].filter(Boolean) as string[]),
    getIngestFreshness().catch(() => null),
    getFightWeekVideos(next?.id || null, 5).catch(() => []),
  ]);
  const framing = await getImageFraming(live.slice(0, 1).flatMap((b) => [imgs.get(b.fighter_a.id)?.id, imgs.get(b.fighter_b.id)?.id]).filter(Boolean) as string[]);
  const champById = new Map(champs.map((f) => [f.id, f]));
  const contenderById = new Map(contenders.map((f) => [f.id, f]));

  return (
    <>
      {/* ONE deliberate arena treatment, server-rendered.
          There is no switcher, no rotation, no timer and no post-hydration
          swap: the image is in the first byte of HTML and never changes. The
          background-selection system that used to own this was removed — it
          applied the backdrop from a root-layout effect that raced the page,
          so the hero usually rendered flat. */}
      <section className="hero hero-cinematic">
        <div
          className="hero-stage"
          aria-hidden="true"
          style={{ backgroundImage: 'url("/media/home-bg-fight-night.webp")' }}
        />
        <Octagon className="hero-oct" />
        <div className="wrap hero-in">
          <div className="hero-editorial">
            <div className="hero-copy">
            <div className="hero-net"><Mark size={32} /><span className="eyebrow">PropBetEdge Sports Network · Fight Intelligence</span></div>
            <h1 aria-label="Every card. Every fighter. Every round.">Every card. Every f{"‌"}ighter. <em>Every round.</em></h1>
            <p className="lede">
              Live UFC fight-week intelligence from first announcement to final result: full cards, the Pregame Desk, fighter dossiers, Fight DNA,
              official rankings, championship context, seven eras of history, source-linked media and a newsroom that only writes what its evidence can support.
            </p>
            {/* Three visibly different weights: one filled control, one
                outlined, one quiet. The primary is the only gold fill in the
                hero, so there is never a question which action is the action. */}
            <div className="hero-actions">
              <Link href={next ? `/events/${eventSlug(next)}` : "/events"} className="hero-cta-primary">
                {next ? "Enter fight week" : "UFC schedule"}
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                  <path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
              <Link href="/events" className="hero-cta-secondary">Schedule &amp; results</Link>
              <Link href="/history" className="hero-cta-tertiary">History</Link>
            </div>
            </div>

            {/* Same four live counts, presented as information blocks rather
                than four loose numbers. Icons are inline SVG: no request, no
                icon font, no layout cost. */}
            <div className="hero-stats-block">
            <div className="hero-stats">
              {HERO_STATS.map((stat) => (
                <div className="stat" key={stat.label}>
                  <span className="stat-ico" aria-hidden="true">{stat.icon}</span>
                  <span className="stat-val">
                    <b>{counts[stat.key]?.toLocaleString() ?? "—"}</b>
                    <span>{stat.label}</span>
                  </span>
                </div>
              ))}
            </div>
            </div>
          </div>
          <div className="hero-feature-col">
            {/* Card and broadcast panel share ONE frame, one border and one
                shadow, so the times read as the bottom third of the featured
                event rather than as a tray bolted underneath it. */}
            <div className="hero-feature">
            {next ? (
              <Link href={`/events/${eventSlug(next)}`} className="poster" aria-label={`${next.name}: full card`}>
                <div className="poster-top">
                  <span className="eyebrow">{eventBrand(next.name)}{next.is_ppv ? " · PPV" : ""}</span>
                  <span className={`tag${d != null && d <= 6 ? " gold" : ""}`}>{d == null ? "Date TBA" : d === 0 ? "Fight night" : d === 1 ? "Tomorrow" : d <= 6 ? "Fight week" : "Next card"}</span>
                </div>
                {mainEvent ? (
                  <>
                    <div className="poster-faces">
                      {[mainEvent.fighter_a, mainEvent.fighter_b].map((f, i) => {
                        const img = imgs.get(f.id);
                        return (
                          <div className={`face ${i ? "b" : "a"}`} key={f.id}>
                            {img ? <img src={img.card} alt="" width={800} height={1000} fetchPriority="high" decoding="async" /> : (
                              <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}><Avatar f={f} size={120} /></div>
                            )}
                          </div>
                        );
                      })}
                      <div className="vs" style={{ gridColumn: 2, gridRow: 1 }}>VS</div>
                    </div>
                    <div className="poster-names">
                      <div className="a"><div className="n">{mainEvent.fighter_a.name}</div><div className="r">{fmtRecord(mainEvent.fighter_a)}</div></div>
                      <div className="b"><div className="n">{mainEvent.fighter_b.name}</div><div className="r">{fmtRecord(mainEvent.fighter_b)}</div></div>
                    </div>
                  </>
                ) : (
                  <div className="poster-faces" style={{ display: "grid", placeItems: "center" }}><div className="stack" style={{ alignItems: "center", textAlign: "center", padding: 24 }}><Octagon className="" /><div className="faint sm">Card announcement pending. Bouts appear the moment they are published.</div></div></div>
                )}
                <div className="poster-foot">
                  <div>
                    <div className="t">{eventHeadline(next.name) || next.name}</div>
                    <div className="m">{fmtDate(next.event_date, { weekday: "long", month: "long", day: "numeric" })} · {locationLine(next) || "Venue TBA"}</div>
                    <div className="m">{mainEvent ? `${weightClassLabel(mainEvent.weight_class, mainEvent.is_womens)}${mainEvent.is_title ? " title" : ""} main event` : ""}{live.length ? ` · ${live.length} bouts` : ""}</div>
                  </div>
                  {d != null && d >= 0 && <div className="count"><b>{d}</b><span>{d === 1 ? "day out" : "days out"}</span></div>}
                </div>
              </Link>
            ) : (
              <div className="poster empty-poster"><div><Octagon className="" /><h2 className="serif" style={{ fontSize: 24, margin: "12px 0 8px" }}>Next card loading</h2><p className="dim sm">The schedule refreshes from the production ingest. When the next UFC event is published it appears here, main card to early prelims.</p></div></div>
            )}
            {/* Fight-day / next-event treatment: prelim and main-card times in
                the visitor's own timezone, the carrier, and a live countdown.
                Rendered from data the page already has, so it cannot shift the
                poster when it "loads" — there is nothing to load. */}
            {next && broadcast && (
              <div className="hero-watch">
                <WatchStrip b={broadcast} variant="hero" />
              </div>
            )}
            </div>
          </div>
        </div>
      </section>

      {next && briefs.length > 0 && (
        <section className="sec" id="fight-week">
          <div className="wrap"><PregameDesk event={next} briefs={briefs} imgs={imgs} framing={framing} mode="teaser" meta={{ fights: live.length, updated: intelligenceUpdated(freshness, rankings, videos) }} /></div>
        </section>
      )}

      <section className="sec">
        <div className="wrap">
          <SectionHead eyebrow={next ? `${fmtDate(next.event_date)} · ${locationLine(next) || "Venue TBA"}` : "Upcoming"} title={next ? next.name : "Upcoming card"} href={next ? `/events/${eventSlug(next)}` : "/events"} cta="Full card & matchups" />
          {bouts.length ? <CardSegments bouts={bouts} e={next!} imgs={imgs} /> : <Empty title="No bouts announced yet" cta={{ href: "/events", label: "See the schedule" }}>Bouts appear here the moment the card is published. Nothing is shown that has not been announced.</Empty>}
        </div>
      </section>

      {videos.length > 0 && (
        <section className="sec"><div className="wrap"><VideoRail variant="desk" videos={videos} title="Inside fight week" eyebrow="Video desk · latest official video" note="Official, allowlisted channels only · embedded from YouTube, not hosted by PropBetEdge · no endorsement implied" /></div></section>
      )}

      {headline.length > 0 && (
        <section className="sec">
          <div className="wrap"><SectionHead eyebrow="Tale of the tape" title="Headline matchups" href={`/events/${eventSlug(next!)}`} cta="All matchups" /><div className="grid-3">{headline.map((b) => <MatchupCard key={b.id} b={b} e={next!} imgs={imgs} />)}</div></div>
        </section>
      )}

      <section className="sec" id="fight-dna-product">
        <div className="wrap"><FightDnaShowcase exploreHref={mainEvent ? `/fighters/${fighterSlug(mainEvent.fighter_a)}#fight-dna` : "/fighters"} exploreLabel={mainEvent ? `Explore ${mainEvent.fighter_a.name.split(" ").slice(-1)[0]}’s Fight DNA →` : "Explore Fight DNA →"} /></div>
      </section>

      {rankings && champs.length > 0 && (
        <section className="sec"><div className="wrap"><ChampionsShowcase rankings={rankings} fighters={champById} contenderFighters={contenderById} imgs={imgs} /></div></section>
      )}

      <section className="sec">
        <div className="wrap">
          <SectionHead eyebrow="Newsroom · timestamped" title="Latest from the desk" href="/news" cta="All stories" />
          {articles.length ? <div className="news">{articles.slice(0, 1).map((a) => <NewsStoryCard key={a.id} a={a} feature hero={a.hero_image_ref ? media.heroes.get(a.hero_image_ref) : null} faces={media.faces.get(a.id)} />)}{articles.slice(1, 7).map((a) => <NewsStoryCard key={a.id} a={a} hero={a.hero_image_ref ? media.heroes.get(a.hero_image_ref) : null} faces={media.faces.get(a.id)} />)}</div> : <Empty title="The newsroom publishes when the data does">Fight previews, results with round stats and card changes are written from our own tables. The first stories land with the next card.</Empty>}
        </div>
      </section>

      <Voices />

      <section className="sec">
        <div className="wrap grid-side">
          <div>
            <SectionHead eyebrow="UFC schedule" title="Coming up" href="/events" cta="Full schedule" />
            {upcoming.length ? <div className="grid-2">{upcoming.slice(0, 4).map((e) => <EventCard key={e.id} e={e} main={mains.get(e.id)} imgs={imgs} />)}</div> : <Empty title="Schedule loading">Upcoming UFC events are refreshed from the production ingest and appear here as the source tables change.</Empty>}
          </div>
          <div>
            <SectionHead eyebrow="Live" title="The wire" href="/news" cta="More" />
            {/* PropBetEdge leads. An external headline appears only while our
                own coverage of that development does not yet exist; once it
                publishes, ours takes the slot and links inward. */}
            {wire.length ? <ul className="wire">{wire.map((n) => <li key={n.id} className={n.external ? undefined : "wire-own"}>{n.external ? <a href={n.href} rel="noopener nofollow" target="_blank">{n.title}{n.label ? <span className="lab">{n.label}</span> : null}</a> : <Link href={n.href}>{n.title}{n.label ? <span className="lab">{n.label}</span> : null}</Link>}<span className="src">{n.external ? n.source : <strong>PropBetEdge</strong>} &middot; {relTime(n.at)}</span></li>)}</ul> : <Empty title="Wire is quiet">External headlines are ingested continuously and attributed to their source; PropBetEdge analysis supersedes them as it publishes.</Empty>}
          </div>
        </div>
        <div className="wrap"><ContenderStrip next={dwcsNext} last={dwcsLast} mains={mains} counts={dwcsCounts} freshness={freshness?.finished_at || freshness?.started_at || null} /></div>
      </section>

      <section className="sec">
        <div className="wrap heritage-close">
          <div><div className="eyebrow">From UFC 1 to today · seven eras</div><h2>Know the fight game you are analyzing.</h2><p>The evolution from style-vs-style tournaments to modern championship MMA is part of the data story. Explore the seven eras, the Hall of Fame tribute and the historical results archive that is being rebuilt back toward UFC 1 with its coverage shown honestly.</p></div>
          <div className="heritage-close-actions"><Link href="/history" className="btn gold">Explore UFC history →</Link><Link href="/hall-of-fame" className="btn">Hall of Fame tribute</Link><a href={UFC_OFFICIAL.home} className="btn" target="_blank" rel="noopener">UFC.com ↗</a></div>
        </div>
      </section>

      {recent.length > 0 && <section className="sec"><div className="wrap"><SectionHead eyebrow="Results" title="Recent cards" href="/events" cta="Results archive" /><div className="grid-3">{recent.map((e) => <EventCard key={e.id} e={e} main={mains.get(e.id)} imgs={imgs} />)}</div></div></section>}

      <section className="sec"><div className="wrap"><OfficialDestinations title="Official UFC destinations" intro="UFC-owned pages for the official record, athletes, rankings, Hall of Fame, Fight Pass and merchandise. Clearly separate from PropBetEdge content." /></div></section>

      <section className="sec"><div className="wrap"><ApiCta /></div></section>

      <section className="sec"><div className="wrap"><SectionHead eyebrow="Free vs Pro" title="Everything public is free. The edge is Pro." /><ProPlans /></div></section>

      <JsonLd data={{ "@context": "https://schema.org", "@type": "WebPage", "@id": `${SITE.url}/#home`, url: SITE.url, name: `${SITE.name} — Live UFC Fight Intelligence`, description: SITE.description, isPartOf: { "@id": `${SITE.url}/#site` }, primaryImageOfPage: `${SITE.url}/opengraph-image`, ...(next ? { mainEntity: { "@type": "SportsEvent", name: next.name, startDate: next.event_date, url: `${SITE.url}/events/${eventSlug(next)}`, sport: "Mixed Martial Arts" } } : {}) }} />
      {articles.length > 0 && <JsonLd data={{ "@context": "https://schema.org", "@type": "ItemList", name: "Latest UFC stories", itemListElement: articles.map((a, i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "NewsArticle", url: `${SITE.url}/news/${a.slug}`, headline: a.headline, datePublished: a.published_at || undefined, dateModified: a.updated_at } })) }} />}
    </>
  );
}
