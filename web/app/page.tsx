import Link from "next/link";
import { getNextEvent, getEventBouts, getUpcomingEvents, getRecentEvents, getArticles, getCounts, getImagesForFighters, getMainEvents, getRankings, getNewsItems, getFightersByIds } from "@/lib/db";
import { CardSegments, Empty, EventCard, MatchupCard, ProPlans, SectionHead, StoryCard, JsonLd, Avatar, Octagon } from "@/components/ui";
import { eventSlug, fighterSlug } from "@/lib/slug";
import { fmtDate, daysUntil, locationLine, eventBrand, eventHeadline, fmtRecord, weightClassLabel, relTime } from "@/lib/format";
import { SITE } from "@/lib/site";
import { storyMedia } from "@/lib/faces";

export const revalidate = 300;

export default async function Home() {
  const [next, upcomingRaw, recent, articlesRes, counts, rankings, wire] = await Promise.all([
    getNextEvent(), getUpcomingEvents(7), getRecentEvents(3), getArticles(7), getCounts(), getRankings(), getNewsItems(8),
  ]);
  const articles = articlesRes.rows;
  const upcoming = upcomingRaw.filter((e) => e.id !== next?.id).slice(0, 6);
  const bouts = next ? await getEventBouts(next.id) : [];
  const live = bouts.filter((b) => b.status !== "cancelled");
  const mainEvent = live[0] || null;
  const headline = live.slice(0, 3);
  const d = next ? daysUntil(next.event_date) : null;

  const mains = await getMainEvents([...upcoming, ...recent].map((e) => e.id));
  const champIds = (rankings?.divisions || []).filter((x) => !x.is_p4p && x.champion?.fighter_id).map((x) => x.champion!.fighter_id!);
  const imgs = await getImagesForFighters([
    ...bouts.flatMap((b) => [b.fighter_a.id, b.fighter_b.id]),
    ...[...mains.values()].flatMap((b) => [b.fighter_a.id, b.fighter_b.id]),
    ...champIds,
  ]);
  const media = await storyMedia(articles);
  const champs = await getFightersByIds(champIds);
  const champById = new Map(champs.map((f) => [f.id, f]));

  return (
    <>
      <section className="hero">
        <Octagon className="hero-oct" />
        <div className="wrap hero-in">
          <div>
            <div className="hero-net"><img src={SITE.logo.mark80} alt="" width={57} height={22} decoding="async" /><span className="eyebrow">PropBetEdge Sports Network · Fight Intelligence</span></div>
            <h1 aria-label="Every card. Every fighter. Every round.">Every card. Every f{"\u200C"}ighter. <em>Every round.</em></h1>
            <p className="lede">
              Live UFC fight cards from main event to early prelims, fighter profiles with complete fight history and round-by-round stats,
              official rankings by division, and a newsroom that writes only what the data can prove.
            </p>
            <div className="hero-actions">
              <Link href={next ? `/events/${eventSlug(next)}` : "/events"} className="btn gold lg">{next ? "Next card" : "Browse events"}</Link>
              <Link href="/fighters" className="btn lg">Fighter archive</Link>
              <Link href="/rankings" className="btn lg hide-m">Rankings</Link>
            </div>
            <div className="hero-stats">
              <div className="stat"><b>{counts.events?.toLocaleString() ?? "—"}</b><span>Events</span></div>
              <div className="stat"><b>{counts.fighters?.toLocaleString() ?? "—"}</b><span>Fighters</span></div>
              <div className="stat"><b>{counts.results?.toLocaleString() ?? "—"}</b><span>Results</span></div>
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
                  <div className="poster-faces" style={{ display: "grid", placeItems: "center" }}>
                    <div className="stack" style={{ alignItems: "center", textAlign: "center", padding: 24 }}>
                      <Octagon className="" />
                      <div className="faint sm">Card announcement pending. Bouts appear the moment they are published.</div>
                    </div>
                  </div>
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
              <div className="poster empty-poster">
                <div>
                  <Octagon className="" />
                  <h2 className="serif" style={{ fontSize: 24, margin: "12px 0 8px" }}>Next card loading</h2>
                  <p className="dim sm">The schedule refreshes from the ingest worker. When the next UFC event is published it appears here, main card to early prelims.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="sec">
        <div className="wrap">
          <SectionHead eyebrow={next ? `${fmtDate(next.event_date)} · ${locationLine(next) || "Venue TBA"}` : "Upcoming"} title={next ? next.name : "Upcoming card"} href={next ? `/events/${eventSlug(next)}` : "/events"} cta="Full card & matchups" />
          {bouts.length ? (
            <CardSegments bouts={bouts} e={next!} imgs={imgs} />
          ) : (
            <Empty title="No bouts announced yet" cta={{ href: "/events", label: "See the schedule" }}>Bouts appear here the moment the card is published. Nothing is shown that has not been announced.</Empty>
          )}
        </div>
      </section>

      {headline.length > 0 && (
        <section className="sec">
          <div className="wrap">
            <SectionHead eyebrow="Tale of the tape" title="Headline matchups" href={`/events/${eventSlug(next!)}`} cta="All matchups" />
            <div className="grid-3">
              {headline.map((b) => <MatchupCard key={b.id} b={b} e={next!} imgs={imgs} />)}
            </div>
          </div>
        </section>
      )}

      <section className="sec">
        <div className="wrap">
          <SectionHead eyebrow="Newsroom" title="Latest from the desk" href="/news" cta="All stories" />
          {articles.length ? (
            <div className="news">
              {articles.slice(0, 1).map((a) => <StoryCard key={a.id} a={a} feature hero={a.hero_image_ref ? media.heroes.get(a.hero_image_ref) : null} faces={media.faces.get(a.id)} />)}
              {articles.slice(1, 7).map((a) => <StoryCard key={a.id} a={a} hero={a.hero_image_ref ? media.heroes.get(a.hero_image_ref) : null} faces={media.faces.get(a.id)} />)}
            </div>
          ) : (
            <Empty title="The newsroom publishes when the data does">Fight previews, results with round stats and card changes are written from our own tables. The first stories land with the next card.</Empty>
          )}
        </div>
      </section>

      <section className="sec">
        <div className="wrap grid-side">
          <div>
            <SectionHead eyebrow="Schedule" title="Coming up" href="/events" cta="Full schedule" />
            {upcoming.length ? (
              <div className="grid-2">{upcoming.slice(0, 4).map((e) => <EventCard key={e.id} e={e} main={mains.get(e.id)} imgs={imgs} />)}</div>
            ) : (
              <Empty title="Schedule loading">Upcoming events are pulled from the public schedule and refreshed nightly.</Empty>
            )}
          </div>
          <div>
            <SectionHead eyebrow="Around MMA" title="The wire" href="/news?type=external" cta="More" />
            {wire.length ? (
              <ul className="wire">
                {wire.map((n) => (
                  <li key={n.id}>
                    <a href={n.url || "#"} rel="noopener nofollow" target="_blank">{n.title}{n.taxonomy?.labels?.[0] && n.taxonomy.labels[0] !== "other" ? <span className="lab">{n.taxonomy.labels[0].replace("_", " ")}</span> : null}</a>
                    <span className="src">{n.source?.name || "Source"} · {relTime(n.published_at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="Wire is quiet">External headlines are ingested on the card-week cadence and attributed to their source.</Empty>
            )}
          </div>
        </div>
      </section>

      {champs.length > 0 && rankings && (
        <section className="sec">
          <div className="wrap">
            <SectionHead eyebrow={`Official rankings · updated ${fmtDate(rankings.snapshot_date)}`} title="Champions" href="/rankings" cta="Full rankings" />
            <div className="champs">
              {rankings.divisions.filter((x) => !x.is_p4p && x.champion).map((x) => {
                const f = x.champion!.fighter_id ? champById.get(x.champion!.fighter_id) : null;
                const inner = (
                  <>
                    <Avatar f={{ name: x.champion!.name }} img={f ? imgs.get(f.id) : null} size={56} />
                    <div className="d">{x.label}</div>
                    <div className="n">{x.champion!.name}</div>
                    {f && <div className="faint mono label">{fmtRecord(f)}</div>}
                  </>
                );
                return f ? <Link key={x.key + x.is_womens} href={`/fighters/${fighterSlug(f)}`} className="champ-card">{inner}</Link> : <div key={x.key + x.is_womens} className="champ-card">{inner}</div>;
              })}
            </div>
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="sec">
          <div className="wrap">
            <SectionHead eyebrow="Results" title="Recent cards" href="/events" cta="Archive" />
            <div className="grid-3">{recent.map((e) => <EventCard key={e.id} e={e} main={mains.get(e.id)} imgs={imgs} />)}</div>
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
        "@context": "https://schema.org", "@type": "WebPage", "@id": `${SITE.url}/#home`, url: SITE.url, name: `${SITE.name} — UFC Cards, Fighters, Rankings & News`,
        description: SITE.description, isPartOf: { "@id": `${SITE.url}/#site` }, primaryImageOfPage: `${SITE.url}/opengraph-image`,
        ...(next ? { mainEntity: { "@type": "SportsEvent", name: next.name, startDate: next.event_date, url: `${SITE.url}/events/${eventSlug(next)}`, sport: "Mixed Martial Arts" } } : {}),
      }} />
      {articles.length > 0 && (
        <JsonLd data={{ "@context": "https://schema.org", "@type": "ItemList", name: "Latest UFC stories", itemListElement: articles.map((a, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE.url}/news/${a.slug}`, name: a.headline })) }} />
      )}
    </>
  );
}
