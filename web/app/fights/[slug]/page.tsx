import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getImagesForFighters, getRoundStats, getArticlesForBout, getFighterBouts } from "@/lib/db";
import { storyMedia } from "@/lib/faces";
import { getFighterDna, getMatchupDna } from "@/lib/dna";
import { RoundAnalysis } from "@/components/RoundAnalysis";
import { analysisState, buildRounds, compareToDna, roundEdges, roundOverRound } from "@/lib/roundAnalysis";
import { DnaMatchup } from "@/components/dna";
import { resolveFight } from "@/lib/resolve";
import { JsonLd, ProLock, TaleOfTheTape, Breadcrumbs, Portrait, Credit, BoutRow } from "@/components/ui";
import { NewsStoryCard } from "@/components/NewsStoryCard";
import { getMarketsFor, marketProviderLive, marketStateFor, unresolvedBouts } from "@/lib/market";
import { MarketSection } from "@/components/Market";
import { OfficialScorecards } from "@/components/Scorecard";
import { buildBoutScorecard } from "@/lib/judgeScoring";
import { eventSlug, fighterSlug, matchupSlug } from "@/lib/slug";
import { cardPositionLabel, fmtDate, fmtRecord, fmtTime, METHOD_LABEL, weightClassLabel, totals, pct, archiveSummary, winnerOf, loserOf, daysUntil, locationLine, plural, METHOD_SHORT, eventBrand } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const hit = await resolveFight((await params).slug);
  if (!hit) return { title: "Matchup not found", robots: { index: false } };
  const { e, b } = hit;
  const done = Boolean(b.result);
  const title = `${b.fighter_a.name} vs ${b.fighter_b.name} — ${e.name}`;
  return {
    title: done ? `${title} Result, Stats & Scorecards` : `${title} Tale of the Tape, Records & Matchup`,
    description: `${b.fighter_a.name} (${fmtRecord(b.fighter_a)}) vs ${b.fighter_b.name} (${fmtRecord(b.fighter_b)}) at ${e.name} on ${fmtDate(e.event_date)}: ${weightClassLabel(b.weight_class, b.is_womens)}${b.is_title ? " title fight" : ""}, ${cardPositionLabel(b.card_position).toLowerCase()}. ${done ? "Result, method, round-by-round stats." : "Tale of the tape, height, reach, age, records and recent form."}`,
    alternates: { canonical: `/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}` },
    openGraph: { title, description: `${fmtDate(e.event_date)} · ${weightClassLabel(b.weight_class, b.is_womens)}`, url: `${SITE.url}/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}` },
    twitter: { card: "summary_large_image", title },
  };
}

export default async function FightPage({ params }: { params: Promise<{ slug: string }> }) {
  const hit = await resolveFight((await params).slug);
  if (!hit) notFound();
  const { e, b, bouts } = hit;
  const [imgs, rounds, articles, histA, histB] = await Promise.all([
    getImagesForFighters([b.fighter_a.id, b.fighter_b.id, ...bouts.flatMap((x) => [x.fighter_a.id, x.fighter_b.id])]), getRoundStats(b.id), getArticlesForBout(b.id), getFighterBouts(b.fighter_a.id), getFighterBouts(b.fighter_b.id),
  ]);
  const [media, dna, dnaFighterA, dnaFighterB] = await Promise.all([
    storyMedia(articles),
    getMatchupDna(b.fighter_a.id, b.fighter_b.id, b.result ? e.event_date : null),
    /* Baselines are read as of the event date so the comparison is against the
     * fighter as they were BEFORE this fight, never a snapshot that already
     * contains it. Comparing a performance to itself would flatter every
     * number toward zero deviation. */
    getFighterDna(b.fighter_a.id, e.event_date),
    getFighterDna(b.fighter_b.id, e.event_date),
  ]);
  const r = b.result;
  const w = winnerOf(b), l = loserOf(b);
  const d = daysUntil(e.event_date);
  const ra = rounds.filter((x) => x.fighter_id === b.fighter_a.id), rb = rounds.filter((x) => x.fighter_id === b.fighter_b.id);
  const ta = totals(ra), tb = totals(rb);
  const roundsN = Math.max(...rounds.map((x) => x.round), 0);

  /* Round-by-Round Analysis. Everything is derived server-side and passed to
   * the client component, which only owns which round is selected. */
  /* Market is an independent layer: fetched separately, rendered in its own
   * section, and never mixed into Fight DNA or the round analysis. */
  const [markets, providerLive, unresolved] = await Promise.all([
    getMarketsFor([b.id], new Map([[b.id, { a: b.fighter_a.id, b: b.fighter_b.id }]])),
    marketProviderLive(),
    unresolvedBouts([{ id: b.id, a: b.fighter_a.name, b: b.fighter_b.name }], e.event_date),
  ]);
  const market = markets.get(b.id);
  const marketState = marketStateFor(market, {
    eventDate: e.event_date, hasResult: Boolean(r), providerLive,
    unresolved: unresolved.has(b.id),
  });

  const rbaRounds = buildRounds(rounds, b.fighter_a.id, b.fighter_b.id, r?.round ?? null, r?.time_sec ?? null);
  const rbaState = analysisState({
    hasResult: Boolean(r), hasRounds: rbaRounds.length > 0,
    eventDate: e.event_date, cancelled: b.status === "cancelled",
  });
  const rbaSignals: Record<number, ReturnType<typeof roundOverRound>> = {};
  const rbaEdges: Record<number, ReturnType<typeof roundEdges>> = {};
  for (let i = 0; i < rbaRounds.length; i += 1) {
    const cur = rbaRounds[i];
    rbaEdges[cur.round] = roundEdges(cur, b.fighter_a.name, b.fighter_b.name);
    if (i > 0) {
      rbaSignals[cur.round] = [
        ...roundOverRound(cur, rbaRounds[i - 1], "a", b.fighter_a.name),
        ...roundOverRound(cur, rbaRounds[i - 1], "b", b.fighter_b.name),
      ];
    }
  }
  const snapA = dnaFighterA.status === "ok" ? dnaFighterA.data.snapshot : null;
  const snapB = dnaFighterB.status === "ok" ? dnaFighterB.data.snapshot : null;
  const rbaFinalLine = r
    ? `${METHOD_LABEL[r.method] || r.method}${r.round ? ` · R${r.round}` : ""}${r.time_sec != null ? ` · ${fmtTime(r.time_sec)}` : ""}`
    : null;
  const before = (h: Awaited<ReturnType<typeof getFighterBouts>>) => h.filter((x) => x.id !== b.id && x.result && x.event?.event_date && x.event.event_date < (e.event_date || "9999")).slice(0, 5);
  const formA = before(histA), formB = before(histB);
  const sumA = archiveSummary(b.fighter_a.id, histA.filter((x) => x.id !== b.id)), sumB = archiveSummary(b.fighter_b.id, histB.filter((x) => x.id !== b.id));
  const idx = bouts.findIndex((x) => x.id === b.id);
  const neighbours = [bouts[idx - 1], bouts[idx + 1]].filter(Boolean);
  /* Judge cards, attributed to a fighter using the bout's own result. Built
   * here so the result strip can link each judge and show the score the right
   * way round, rather than repeating the source's bare pair. */
  const panel = r
    ? buildBoutScorecard({ method: r.method, scorecards: r.scorecards, winnerId: r.winner_id, fighterAId: b.fighter_a.id, fighterBId: b.fighter_b.id }).cards
    : [];
  const resultSourceUrl = r?.source_url || null;

  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Events", href: "/events" }, { name: e.name, href: `/events/${eventSlug(e)}` }, { name: `${b.fighter_a.name} vs ${b.fighter_b.name}` }]} />
      <div className="between mb-4">
        <div className="eyebrow">{weightClassLabel(b.weight_class, b.is_womens)}{b.is_title ? " · Title bout" : ""}{b.scheduled_rounds ? ` · ${b.scheduled_rounds} rounds` : ""} · {cardPositionLabel(b.card_position)}</div>
        {b.status === "cancelled" ? <span className="tag live">Cancelled</span> : r ? <span className="tag pos">Final</span> : <span className={`tag${d != null && d <= 6 && d >= 0 ? " gold" : ""}`}>{d === 0 ? "Tonight" : d != null && d > 0 ? `In ${d} day${d === 1 ? "" : "s"}` : "Scheduled"}</span>}
      </div>

      <div className="faceoff">
        <Link href={`/fighters/${fighterSlug(b.fighter_a)}`} className="side a">
          <Portrait f={b.fighter_a} img={imgs.get(b.fighter_a.id)} priority />
          <div>
            <div className="name">{b.fighter_a.name}{w?.id === b.fighter_a.id && <span className="tag fill" style={{ marginLeft: 10, verticalAlign: "middle" }}>Winner</span>}</div>
            {b.fighter_a.nickname && <div className="nick">“{b.fighter_a.nickname}”</div>}
            <div className="rec">{fmtRecord(b.fighter_a)}</div>
          </div>
        </Link>
        <div className="vs">vs</div>
        <Link href={`/fighters/${fighterSlug(b.fighter_b)}`} className="side b">
          <Portrait f={b.fighter_b} img={imgs.get(b.fighter_b.id)} priority />
          <div>
            <div className="name">{w?.id === b.fighter_b.id && <span className="tag fill" style={{ marginRight: 10, verticalAlign: "middle" }}>Winner</span>}{b.fighter_b.name}</div>
            {b.fighter_b.nickname && <div className="nick">“{b.fighter_b.nickname}”</div>}
            <div className="rec">{fmtRecord(b.fighter_b)}</div>
          </div>
        </Link>
      </div>
      <div className="between mt-2">
        <Credit img={imgs.get(b.fighter_a.id)} />
        <Credit img={imgs.get(b.fighter_b.id)} />
      </div>

      <div className="card mt-5">
        <div className="between">
          <div><div className="eyebrow">{e.name}</div><div className="mono dim sm mt-2">{fmtDate(e.event_date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} · {locationLine(e) || "Venue TBA"}</div></div>
          <Link href={`/events/${eventSlug(e)}`} className="btn">Full card →</Link>
        </div>
      </div>

      {r && (
        <section className="segment">
          <h3>Result</h3>
          <div className="card hi">
            <div className="serif" style={{ fontSize: "clamp(22px, 2.6vw, 32px)", fontWeight: 800, color: "var(--pbe-paper)" }}>
              {w && l ? <>{w.name} <span className="gold">def.</span> {l.name}</> : METHOD_LABEL[r.method] || r.method}
            </div>
            <div className="mono dim mt-2">
              {METHOD_LABEL[r.method] || r.method}{r.finish_detail ? ` (${r.finish_detail})` : ""}{r.round ? ` · Round ${r.round}` : ""}{r.time_sec != null ? ` · ${fmtTime(r.time_sec)}` : ""}{r.time_format ? ` · ${r.time_format}` : ""}
            </div>
            <div className="tags mt-3">
              {r.referee && <span className="tag">Referee · {r.referee}</span>}
              <span className="tag dim">Source · {r.result_source === "espn" ? "ESPN" : "UFC Stats"}{r.has_stats ? " · round stats archived" : ""}</span>
            </div>
            {/* The judges leave the flat tag strip and become links into the
                judge archive. The scores themselves belong to the Official
                Scorecards section below, where they can be attributed to a
                fighter instead of floating as a bare pair. */}
            {panel.length > 0 && (
              <div className="jd-panel mt-3">
                {panel.map((c) => (
                  <Link href={`/judges/${c.judgeSlug}`} key={`${c.cardIndex}-${c.judge}`}>
                    {c.judge} <b>{c.fighterAScore != null ? `${c.fighterAScore}–${c.fighterBScore}` : c.rawScore}</b>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Official scorecards. Rendered for every completed bout, because the
          absence of a card on a finish is itself the answer and has to be
          stated rather than left as a missing section. */}
      {r && <OfficialScorecards result={r} a={b.fighter_a} b={b.fighter_b} sourceUrl={resultSourceUrl} />}

      <MarketSection market={market} state={marketState} nameA={b.fighter_a.name} nameB={b.fighter_b.name} />

      <RoundAnalysis
        state={rbaState}
        rounds={rbaRounds}
        nameA={b.fighter_a.name}
        nameB={b.fighter_b.name}
        dnaA={compareToDna(rbaRounds, "a", snapA)}
        dnaB={compareToDna(rbaRounds, "b", snapB)}
        signals={rbaSignals}
        edges={rbaEdges}
        finalLine={rbaFinalLine}
        updatedAt={null}
      />

      {rounds.length > 0 && (
        <section className="segment">
          <h3>Fight stats <small>{plural(roundsN, "round")} · UFC Stats</small></h3>
          <div className="card">
            <div className="compare">
              {([
                ["Sig. strikes", ta.sig_l, tb.sig_l, `${ta.sig_l} / ${ta.sig_a}`, `${tb.sig_l} / ${tb.sig_a}`],
                ["Accuracy", ta.sig_a ? ta.sig_l / ta.sig_a : 0, tb.sig_a ? tb.sig_l / tb.sig_a : 0, pct(ta.sig_l, ta.sig_a), pct(tb.sig_l, tb.sig_a)],
                ["Total strikes", ta.tot_l, tb.tot_l, `${ta.tot_l} / ${ta.tot_a}`, `${tb.tot_l} / ${tb.tot_a}`],
                ["Knockdowns", ta.kd, tb.kd, String(ta.kd), String(tb.kd)],
                ["Takedowns", ta.td_l, tb.td_l, `${ta.td_l} / ${ta.td_a}`, `${tb.td_l} / ${tb.td_a}`],
                ["Sub attempts", ta.sub, tb.sub, String(ta.sub), String(tb.sub)],
                ["Control", ta.ctrl, tb.ctrl, fmtTime(ta.ctrl), fmtTime(tb.ctrl)],
                ["Head", ta.head, tb.head, String(ta.head), String(tb.head)],
                ["Body", ta.body, tb.body, String(ta.body), String(tb.body)],
                ["Leg", ta.leg, tb.leg, String(ta.leg), String(tb.leg)],
              ] as Array<[string, number, number, string, string]>).map(([k, va, vb, la, lb]) => {
                const max = Math.max(va, vb) || 1;
                return (
                  <div className="cr" key={k}>
                    <span className="v">{la}</span>
                    <span className={`bar a${va < vb ? " lose" : ""}`}><i style={{ width: `${(va / max) * 100}%` }} /></span>
                    <span className="k">{k}</span>
                    <span className={`bar b${vb < va ? " lose" : ""}`}><i style={{ width: `${(vb / max) * 100}%` }} /></span>
                    <span className="v b">{lb}</span>
                  </div>
                );
              })}
            </div>
            <div className="between mt-4 mono label faint"><span>{b.fighter_a.name}</span><span>{b.fighter_b.name}</span></div>
          </div>
          <div className="tbl-wrap mt-4">
            <table className="tbl">
              <thead><tr><th>Round</th><th>Fighter</th><th className="c">KD</th><th className="c">Sig. str.</th><th className="c">Total</th><th className="c">TD</th><th className="c">Sub</th><th className="c">Ctrl</th><th className="c">Head</th><th className="c">Body</th><th className="c">Leg</th></tr></thead>
              <tbody>
                {Array.from({ length: roundsN }, (_, i) => i + 1).flatMap((rn) => [b.fighter_a, b.fighter_b].map((f) => {
                  const x = rounds.find((s) => s.round === rn && s.fighter_id === f.id);
                  return (
                    <tr key={`${rn}-${f.id}`}>
                      <td className="gold">{f.id === b.fighter_a.id ? `R${rn}` : ""}</td>
                      <td>{f.name}</td>
                      <td className="c">{x?.kd ?? "—"}</td>
                      <td className="c">{x ? `${x.sig_str_landed ?? 0}/${x.sig_str_att ?? 0}` : "—"}</td>
                      <td className="c">{x ? `${x.total_str_landed ?? 0}/${x.total_str_att ?? 0}` : "—"}</td>
                      <td className="c">{x ? `${x.td_landed ?? 0}/${x.td_att ?? 0}` : "—"}</td>
                      <td className="c">{x?.sub_att ?? "—"}</td>
                      <td className="c">{x ? fmtTime(x.ctrl_sec || 0) : "—"}</td>
                      <td className="c">{x?.head_landed ?? "—"}</td>
                      <td className="c">{x?.body_landed ?? "—"}</td>
                      <td className="c">{x?.leg_landed ?? "—"}</td>
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="segment">
        <h3>Tale of the tape</h3>
        <div className="matchup">
          <TaleOfTheTape a={b.fighter_a} b={b.fighter_b} at={e.event_date} />
          <div className="grid-2 mt-4">
            {[[b.fighter_a, sumA, formA], [b.fighter_b, sumB, formB]].map(([f, s, form]) => {
              const ff = f as typeof b.fighter_a; const ss = s as typeof sumA; const fm = form as typeof formA;
              return (
                <div className="well" key={ff.id}>
                  <div className="between"><b style={{ color: "var(--pbe-paper)" }}>{ff.name}</b><span className="mono faint label">{ss.fights ? `${ss.w}-${ss.l}${ss.d ? `-${ss.d}` : ""} in archive` : "archive pending"}</span></div>
                  <div className="tiles mt-3" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
                    <div className="tile"><b>{ss.ko}</b><span>KO/TKO wins</span></div>
                    <div className="tile"><b>{ss.sub}</b><span>Sub wins</span></div>
                    <div className="tile"><b>{ss.finishRate != null ? `${ss.finishRate}%` : "—"}</b><span>Finish rate</span></div>
                  </div>
                  {fm.length > 0 && (
                    <div className="mt-3">
                      <div className="eyebrow dim mb-2">Last {fm.length}</div>
                      <div className="stack" style={{ gap: 4 }}>
                        {fm.map((x) => {
                          const opp = x.fighter_a.id === ff.id ? x.fighter_b : x.fighter_a;
                          const res = x.result!.winner_id === ff.id ? "W" : x.result!.winner_id ? "L" : x.result!.method === "DRAW" ? "D" : "NC";
                          return (
                            <Link key={x.id} href={`/fights/${matchupSlug(x.fighter_a, x.fighter_b, x.event)}`} className="between sm" style={{ padding: "4px 0", borderBottom: "1px solid var(--pbe-line-faint)" }}>
                              <span><b className={`mono ${res === "W" ? "" : ""}`} style={{ color: res === "W" ? "var(--pbe-pos)" : res === "L" ? "var(--pbe-crimson-bright)" : "var(--pbe-dim)", marginRight: 8 }}>{res}</b>{opp.name}</span>
                              <span className="mono faint label">{METHOD_SHORT[x.result!.method]}{x.result!.round ? ` R${x.result!.round}` : ""} · {fmtDate(x.event.event_date, { month: "short", year: "2-digit" })}</span>
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!r && <ProLock />}
        </div>
      </section>

      {dna.status === "ok" && <DnaMatchup dna={dna.data} />}

      {articles.length > 0 && (
        <section className="segment">
          <h3>Coverage</h3>
          <div className="news">{articles.map((a) => <NewsStoryCard key={a.id} a={a} hero={a.hero_image_ref ? media.heroes.get(a.hero_image_ref) : null} faces={media.faces.get(a.id)} kicker={eventBrand(e.name)} />)}</div>
        </section>
      )}

      {neighbours.length > 0 && (
        <section className="segment">
          <h3>Also on this card</h3>
          <div className="bouts">{neighbours.map((x) => <BoutRow key={x.id} b={x} e={e} imgs={imgs} />)}</div>
        </section>
      )}

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "SportsEvent", "@id": `${SITE.url}/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}#bout`, name: `${b.fighter_a.name} vs ${b.fighter_b.name}`, startDate: e.event_date, sport: "Mixed Martial Arts",
        description: `${weightClassLabel(b.weight_class, b.is_womens)}${b.is_title ? " title" : ""} bout at ${e.name}${r && w ? `: ${w.name} won by ${METHOD_LABEL[r.method]}${r.round ? ` in round ${r.round}` : ""}` : ""}.`,
        eventStatus: b.status === "cancelled" ? "https://schema.org/EventCancelled" : "https://schema.org/EventScheduled",
        superEvent: { "@type": "SportsEvent", name: e.name, url: `${SITE.url}/events/${eventSlug(e)}`, startDate: e.event_date },
        location: e.venue || e.city ? { "@type": "Place", name: e.venue || e.city, address: { "@type": "PostalAddress", addressLocality: e.city, addressRegion: e.region, addressCountry: e.country } } : undefined,
        competitor: [{ "@type": "Person", name: b.fighter_a.name, url: `${SITE.url}/fighters/${fighterSlug(b.fighter_a)}` }, { "@type": "Person", name: b.fighter_b.name, url: `${SITE.url}/fighters/${fighterSlug(b.fighter_b)}` }],
        image: `${SITE.url}/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}/opengraph-image`,
        url: `${SITE.url}/fights/${matchupSlug(b.fighter_a, b.fighter_b, e)}`,
      }} />
    </div>
  );
}
