import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFighterBouts, getImagesForFighters, getArticlesForFighter, getFighterRoundStats, getRankings } from "@/lib/db";
import { storyMedia } from "@/lib/faces";
import { resolveFighter } from "@/lib/resolve";
import { Empty, JsonLd, ProLock, Breadcrumbs, Portrait, Credit, Avatar, StoryCard, TaleOfTheTape } from "@/components/ui";
import { fighterSlug, eventSlug, matchupSlug } from "@/lib/slug";
import { age, fmtDate, fmtHeight, fmtReach, fmtRecord, fmtTime, METHOD_LABEL, stanceLabel, weightClassLabel, archiveSummary, totals, pct, plural, daysUntil } from "@/lib/format";
import { SITE } from "@/lib/site";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const f = await resolveFighter((await params).slug);
  if (!f) return { title: "Fighter not found", robots: { index: false } };
  const title = `${f.name}${f.nickname ? ` “${f.nickname}”` : ""} — UFC Record, Stats & Next Fight`;
  return {
    title,
    description: `${f.name} UFC profile: ${fmtRecord(f)} record, ${fmtHeight(f.height_in)}, ${f.reach_in != null ? `${f.reach_in}" reach` : "reach unlisted"}, ${stanceLabel(f.stance)} stance. Full fight history, round-by-round striking and grappling stats, and next scheduled bout.`,
    alternates: { canonical: `/fighters/${fighterSlug(f)}` },
    openGraph: { type: "profile", title: f.name, description: `${fmtRecord(f)} · ${fmtHeight(f.height_in)} · ${stanceLabel(f.stance)}`, url: `${SITE.url}/fighters/${fighterSlug(f)}` },
    twitter: { card: "summary_large_image", title: f.name },
  };
}

export default async function FighterPage({ params }: { params: Promise<{ slug: string }> }) {
  const f = await resolveFighter((await params).slug);
  if (!f) notFound();
  const [bouts, articles, rounds, rankings] = await Promise.all([getFighterBouts(f.id), getArticlesForFighter(f.id), getFighterRoundStats(f.id), getRankings()]);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = bouts.filter((b) => b.event?.event_date && b.event.event_date >= today && !b.result && b.status !== "cancelled").sort((a, b) => a.event.event_date!.localeCompare(b.event.event_date!));
  const history = bouts.filter((b) => !upcoming.includes(b) && b.event?.event_date && b.event.event_date < today);
  const opponents = bouts.map((b) => (b.fighter_a.id === f.id ? b.fighter_b : b.fighter_a));
  const imgs = await getImagesForFighters([f.id, ...opponents.map((o) => o.id)]);
  const img = imgs.get(f.id) || null;
  const media = await storyMedia(articles);
  const sum = archiveSummary(f.id, history);
  const t = totals(rounds);
  const statsFights = new Set(rounds.map((r) => r.bout_id)).size;
  const ranked = (rankings?.divisions || []).flatMap((dv) => [
    ...(dv.champion?.fighter_id === f.id ? [{ label: dv.label, rank: 0 }] : []),
    ...dv.entries.filter((en) => en.fighter_id === f.id).map((en) => ({ label: dv.label, rank: en.rank })),
  ]);
  const primaryRank = ranked.find((r) => !/pound/i.test(r.label)) || ranked[0];
  const lastWc = bouts.find((b) => b.weight_class)?.weight_class || null;
  const lastWomens = bouts.find((b) => b.weight_class)?.is_womens || false;
  const a = age(f.dob);

  return (
    <div className="wrap page">
      <Breadcrumbs items={[{ name: "Fighters", href: "/fighters" }, { name: f.name }]} />
      <div className="fighter-head">
        <div>
          <Portrait f={f} img={img} priority sizes="(max-width: 1000px) 90vw, 340px" />
          <div className="mt-2"><Credit img={img} /></div>
        </div>
        <div>
          <div className="eyebrow">{primaryRank ? (primaryRank.rank === 0 ? `${primaryRank.label} champion` : `#${primaryRank.rank} ${primaryRank.label}`) : lastWc ? weightClassLabel(lastWc, lastWomens) : "Fighter"}{f.is_active === false ? " · Inactive" : ""}</div>
          <h1 className="serif" style={{ fontSize: "var(--fs-display)", lineHeight: 1, letterSpacing: "-.025em", margin: "8px 0 4px" }}>{f.name}</h1>
          {f.nickname && <div className="serif" style={{ color: "var(--pbe-gold)", fontStyle: "italic", fontSize: 22 }}>“{f.nickname}”</div>}
          <div className="tiles mt-5">
            <div className="tile gold"><b>{fmtRecord(f)}</b><span>Pro record</span></div>
            <div className="tile"><b>{sum.fights ? `${sum.w}-${sum.l}${sum.d ? `-${sum.d}` : ""}` : "—"}</b><span>In archive</span></div>
            <div className="tile"><b>{sum.finishRate != null ? <>{sum.finishRate}<small>%</small></> : "—"}</b><span>Finish rate</span></div>
            <div className="tile"><b>{a ?? "—"}</b><span>Age</span></div>
          </div>
          <dl className="kv mt-5" style={{ gridTemplateColumns: "auto 1fr auto 1fr" }}>
            <dt>Height</dt><dd>{fmtHeight(f.height_in)}</dd>
            <dt>Reach</dt><dd>{fmtReach(f.reach_in)}</dd>
            <dt>Stance</dt><dd>{stanceLabel(f.stance)}</dd>
            <dt>Weight</dt><dd>{f.weight_lbs != null ? `${f.weight_lbs} lb` : "—"}</dd>
            <dt>Born</dt><dd>{f.dob ? fmtDate(f.dob, { month: "short", day: "numeric", year: "numeric" }) : "—"}</dd>
            <dt>KO / Sub / Dec</dt><dd>{sum.fights ? `${sum.ko} / ${sum.sub} / ${sum.dec}` : "—"}</dd>
          </dl>
          {ranked.length > 1 && <div className="tags mt-4">{ranked.map((r) => <span key={r.label} className="tag gold">{r.rank === 0 ? "C" : `#${r.rank}`} {r.label}</span>)}</div>}
        </div>
      </div>

      <section className="segment">
        <h3>Next fight</h3>
        {upcoming.length ? upcoming.map((b) => {
          const opp = b.fighter_a.id === f.id ? b.fighter_b : b.fighter_a;
          const dd = daysUntil(b.event.event_date);
          return (
            <div key={b.id} className="matchup">
              <div className="top">
                <span className="eyebrow">{weightClassLabel(b.weight_class, b.is_womens)}{b.is_title ? " · Title bout" : ""}{b.scheduled_rounds ? ` · ${b.scheduled_rounds} rounds` : ""}</span>
                <span className={`tag${dd != null && dd <= 6 ? " gold" : ""}`}>{fmtDate(b.event.event_date)}{dd != null && dd >= 0 ? ` · ${dd === 0 ? "tonight" : `${dd}d`}` : ""}</span>
              </div>
              <div className="tape">
                <div className="side"><Avatar f={f} img={img} size={84} /><div className="name">{f.name}</div><div className="rec">{fmtRecord(f)}</div></div>
                <div className="vs">vs</div>
                <Link href={`/fighters/${fighterSlug(opp)}`} className="side"><Avatar f={opp} img={imgs.get(opp.id)} size={84} /><div className="name">{opp.name}</div>{opp.nickname && <div className="nick">“{opp.nickname}”</div>}<div className="rec">{fmtRecord(opp)}</div></Link>
              </div>
              <TaleOfTheTape a={f} b={opp} at={b.event.event_date} />
              <ProLock />
              <div className="between mt-3 sm">
                <Link href={`/events/${eventSlug(b.event)}`} className="dim">{b.event.name}</Link>
                <Link href={`/fights/${matchupSlug(b.fighter_a, b.fighter_b, b.event)}`} style={{ color: "var(--pbe-gold)", fontWeight: 600 }}>Full matchup →</Link>
              </div>
            </div>
          );
        }) : <Empty title="No bout scheduled">When a bout is announced it appears here with the tale of the tape, and Pro members get the alert the moment it changes.</Empty>}
      </section>

      {rounds.length > 0 && (
        <section className="segment">
          <h3>Striking & grappling <small>{plural(statsFights, "fight")} · {plural(t.rounds, "round")} of UFC Stats data</small></h3>
          <div className="tiles">
            <div className="tile"><b>{t.rounds ? (t.sig_l / (t.rounds * 5)).toFixed(2) : "—"}</b><span>Sig. strikes / min</span></div>
            <div className="tile"><b>{pct(t.sig_l, t.sig_a)}</b><span>Striking accuracy</span></div>
            <div className="tile"><b>{t.sig_l.toLocaleString()}<small>/ {t.sig_a.toLocaleString()}</small></b><span>Sig. strikes landed</span></div>
            <div className="tile"><b>{t.kd}</b><span>Knockdowns</span></div>
            <div className="tile"><b>{t.td_l}<small>/ {t.td_a}</small></b><span>Takedowns</span></div>
            <div className="tile"><b>{pct(t.td_l, t.td_a)}</b><span>Takedown accuracy</span></div>
            <div className="tile"><b>{t.sub}</b><span>Sub attempts</span></div>
            <div className="tile"><b>{fmtTime(t.ctrl)}</b><span>Control time</span></div>
          </div>
          {t.sig_l > 0 && (
            <div className="grid-2 mt-4">
              <div className="well">
                <div className="eyebrow dim mb-3">Target</div>
                <Bars rows={[["Head", t.head], ["Body", t.body], ["Leg", t.leg]]} total={t.sig_l} />
              </div>
              <div className="well">
                <div className="eyebrow dim mb-3">Position</div>
                <Bars rows={[["Distance", t.dist], ["Clinch", t.clinch], ["Ground", t.ground]]} total={t.sig_l} />
              </div>
            </div>
          )}
          {(f.career_slpm != null || f.career_td_avg != null) && (
            <p className="faint label mt-3">UFC Stats career snapshot at capture: {f.career_slpm != null ? `${f.career_slpm} SLpM` : ""}{f.career_str_acc != null ? ` · ${pctOf(f.career_str_acc)} accuracy` : ""}{f.career_sapm != null ? ` · ${f.career_sapm} SApM` : ""}{f.career_str_def != null ? ` · ${pctOf(f.career_str_def)} defence` : ""}{f.career_td_avg != null ? ` · ${f.career_td_avg} TD/15` : ""}{f.career_td_acc != null ? ` · ${pctOf(f.career_td_acc)} TD acc` : ""}{f.career_sub_avg != null ? ` · ${f.career_sub_avg} sub/15` : ""}.</p>
          )}
        </section>
      )}

      <section className="segment">
        <h3>Fight history <small>{history.length ? plural(history.length, "bout") : "backfilling"}</small></h3>
        {history.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Event</th><th>Opponent</th><th className="c">Res</th><th>Method</th><th className="c">Rd</th><th className="c">Time</th></tr></thead>
              <tbody>
                {history.map((b) => {
                  const opp = b.fighter_a.id === f.id ? b.fighter_b : b.fighter_a;
                  const r = b.result;
                  const res = b.status === "cancelled" ? "—" : !r ? "—" : r.winner_id === f.id ? "W" : r.winner_id ? "L" : r.method === "DRAW" ? "D" : "NC";
                  return (
                    <tr key={b.id}>
                      <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDate(b.event?.event_date, { month: "short", day: "numeric", year: "numeric" })}</td>
                      <td><Link href={`/events/${eventSlug(b.event)}`}>{b.event?.name}</Link></td>
                      <td><Link href={`/fights/${matchupSlug(b.fighter_a, b.fighter_b, b.event)}`} className="row" style={{ gap: 8 }}><Avatar f={opp} img={imgs.get(opp.id)} size={26} />{opp.name}</Link></td>
                      <td className={`c ${res}`}>{res}</td>
                      <td>{b.status === "cancelled" ? <span className="faint">Cancelled</span> : r ? METHOD_LABEL[r.method] || r.method : <span className="faint">Result pending</span>}{r?.finish_detail ? <span className="faint"> · {r.finish_detail}</span> : null}</td>
                      <td className="c">{r?.round ?? "—"}</td>
                      <td className="c">{r?.time_sec != null ? fmtTime(r.time_sec) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <Empty title="History backfilling">This fighter's bouts land here as the archive loads. Round-level striking and grappling stats follow.</Empty>}
      </section>

      {articles.length > 0 && (
        <section className="segment">
          <h3>Stories <small>{plural(articles.length, "story", "stories")}</small></h3>
          <div className="news">{articles.map((a) => <StoryCard key={a.id} a={a} hero={a.hero_image_ref ? media.heroes.get(a.hero_image_ref) : null} faces={media.faces.get(a.id)} />)}</div>
        </section>
      )}

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "Person", "@id": `${SITE.url}/fighters/${fighterSlug(f)}#person`, name: f.name, alternateName: f.nickname || undefined, url: `${SITE.url}/fighters/${fighterSlug(f)}`,
        image: img ? img.portrait : `${SITE.url}/fighters/${fighterSlug(f)}/opengraph-image`, birthDate: f.dob || undefined,
        height: f.height_in != null ? { "@type": "QuantitativeValue", value: f.height_in, unitCode: "INH" } : undefined,
        weight: f.weight_lbs != null ? { "@type": "QuantitativeValue", value: f.weight_lbs, unitCode: "LBR" } : undefined,
        jobTitle: "Mixed martial artist", memberOf: { "@type": "SportsOrganization", name: "Ultimate Fighting Championship" },
        description: `${f.name}, ${fmtRecord(f)} professional record${lastWc ? `, ${weightClassLabel(lastWc, lastWomens)}` : ""}.`,
        mainEntityOfPage: `${SITE.url}/fighters/${fighterSlug(f)}`,
      }} />
    </div>
  );
}

/* UFC Stats percentages are stored as printed (42 = 42%); older rows may hold a ratio. */
function pctOf(v: number): string {
  return `${Math.round(v <= 1 ? v * 100 : v)}%`;
}

function Bars({ rows, total }: { rows: Array<[string, number]>; total: number }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map(([k, v]) => (
        <div key={k} className="compare"><div className="cr" style={{ gridTemplateColumns: "72px 1fr 56px" }}>
          <span className="k" style={{ textAlign: "left" }}>{k}</span>
          <span className="bar b"><i style={{ width: `${total ? (v / total) * 100 : 0}%` }} /></span>
          <span className="v b">{pct(v, total)}</span>
        </div></div>
      ))}
    </div>
  );
}
