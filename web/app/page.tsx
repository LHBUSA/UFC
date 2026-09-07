import Link from "next/link";
import { getNextEvent, getEventBouts, getUpcomingEvents, getRecentEvents, getArticles, getCounts, getImagesForFighters, getMainEvents, getRankings, getNewsItems, getFightersByIds, getBoutCounts, getFightWeekVideos, getImageFraming, isContenderSeries } from "@/lib/db";
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

export const revalidate = 300;

export default async function Home() {
  const [next, upcomingRaw, recent, articlesRes, counts, rankings, wire, allUpcoming, recentAll] = await Promise.all([
    getNextEvent(), getUpcomingEvents(7), getRecentEvents(3), getArticles(7), getCounts(), getRankings(), getNewsItems(8),
    getUpcomingEvents(30, { includeContenderSeries: true }), getRecentEvents(20),
  ]);
  const articles = articlesRes.rows;
  const upcoming = upcomingRaw.filter((e) => e.id !== next?.id && !isContenderSeries(e.name)).slice(0, 6);
  const bouts = next ? await getEventBouts(next.id) : [];
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
      <section className="hero">
        <Octagon className="hero-oct" />
        <div className="wrap hero-in">
          <div>
            <div className="hero-net"><Mark size={32} /><span className="eyebrow">PropBetEdge Sports Network · Fight Intelligence</span></div>
            <h1 aria-label="Every card. Every fighter. Every round.">Every card. Every f{"‌"}ighter. <em>Every round.</em></h1>
            <p className="lede">
              Live UFC fight-week intelligence from first announcement to final result: full cards, the Pregame Desk, fighter dossiers, Fight DNA,
              official rankings, championship context, seven eras of history, source-linked media and a newsroom that only writes what its evidence can support.
            </p>
            <div className="hero-actions">
              <Link href={next ? `/events/${eventSlug(next)}` : "/events"} className="btn gold lg">{next ? "Enter fight week" : "UFC schedule"}</Link>
              <Link href="/events" className="btn lg">Schedule & results</Link>
              <Link href="/history" className="btn lg hide-m">History</Link>
            </div>
            <div className="hero-stats">
              <div className="stat"><b>{counts.events?.toLocaleString() ?? "—"}</b><span>Events indexed</span></div>
              <div className="stat"><b>{counts.fighters?.toLocaleString() ?? "—"}</b><span>Fighters</span></div>
              <div className="stat"><b>{counts.results?.toLocaleString() ?? "—"}</b><span>Results loaded</span></div>
              <div className="stat"><b>{counts.rounds?.toLocaleString() ?? "—"}</b><span>Rounds of stats</span></div>
            </div>
          </div>
          <div>
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
            <SectionHead eyebrow="Around MMA" title="The wire" href="/news?type=external" cta="More" />
            {wire.length ? <ul className="wire">{wire.map((n) => <li key={n.id}><a href={n.url || "#"} rel="noopener nofollow" target="_blank">{n.title}{n.taxonomy?.labels?.[0] && n.taxonomy.labels[0] !== "other" ? <span className="lab">{n.taxonomy.labels[0].replace("_", " ")}</span> : null}</a><span className="src">{n.source?.name || "Source"} · {relTime(n.published_at)}</span></li>)}</ul> : <Empty title="Wire is quiet">External headlines are ingested on the card-week cadence and attributed to their source.</Empty>}
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

      <section className="sec"><div className="wrap"><SectionHead eyebrow="Free vs Pro" title="Everything public is free. The edge is Pro." /><ProPlans /></div></section>

      <JsonLd data={{ "@context": "https://schema.org", "@type": "WebPage", "@id": `${SITE.url}/#home`, url: SITE.url, name: `${SITE.name} — Live UFC Fight Intelligence`, description: SITE.description, isPartOf: { "@id": `${SITE.url}/#site` }, primaryImageOfPage: `${SITE.url}/opengraph-image`, ...(next ? { mainEntity: { "@type": "SportsEvent", name: next.name, startDate: next.event_date, url: `${SITE.url}/events/${eventSlug(next)}`, sport: "Mixed Martial Arts" } } : {}) }} />
      {articles.length > 0 && <JsonLd data={{ "@context": "https://schema.org", "@type": "ItemList", name: "Latest UFC stories", itemListElement: articles.map((a, i) => ({ "@type": "ListItem", position: i + 1, item: { "@type": "NewsArticle", url: `${SITE.url}/news/${a.slug}`, headline: a.headline, datePublished: a.published_at || undefined, dateModified: a.updated_at } })) }} />}
    </>
  );
}
