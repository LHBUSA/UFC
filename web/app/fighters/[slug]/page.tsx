import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFighterBySourceId, getFighterBouts } from "@/lib/db";
import { Empty, FighterPortrait, JsonLd, ProLock } from "@/components/ui";
import { fighterIdFromSlug, fighterSlug, eventSlug, matchupSlug } from "@/lib/slug";
import { age, fmtDate, fmtHeight, fmtRecord, fmtTime, METHOD_LABEL, stanceLabel, weightClassLabel } from "@/lib/format";
import { fighterImageCredit, fighterImageUrl, primaryFighterImage } from "@/lib/media";
import { SITE } from "@/lib/site";

export const revalidate = 300;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const id = fighterIdFromSlug((await params).slug);
  const f = id ? await getFighterBySourceId(id) : null;
  if (!f) return { title: "Fighter not found" };
  const image = fighterImageUrl(f, 1200);
  return {
    title: `${f.name}${f.nickname ? ` “${f.nickname}”` : ""} — Record, Stats & Next Fight`,
    description: `${f.name} UFC profile: ${fmtRecord(f)} record, ${fmtHeight(f.height_in)}, ${f.reach_in != null ? `${f.reach_in}" reach` : "reach unlisted"}, ${stanceLabel(f.stance)} stance, fight history and upcoming bout.`,
    alternates: { canonical: `/fighters/${fighterSlug(f)}` },
    openGraph: {
      type: "profile",
      title: f.name,
      description: `${fmtRecord(f)} · ${fmtHeight(f.height_in)} · ${stanceLabel(f.stance)}`,
      ...(image ? { images: [{ url: image, alt: f.name }] } : {}),
    },
    twitter: image ? { card: "summary_large_image", images: [image] } : undefined,
  };
}

export default async function FighterPage({ params }: { params: Promise<{ slug: string }> }) {
  const id = fighterIdFromSlug((await params).slug);
  const f = id ? await getFighterBySourceId(id) : null;
  if (!f) notFound();
  const bouts = await getFighterBouts(f.id);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = bouts.filter((b) => b.event?.event_date && b.event.event_date >= today && !b.result);
  const history = bouts.filter((b) => !upcoming.includes(b));
  const wins = history.filter((b) => b.result?.winner_id === f.id).length;
  const imageRef = primaryFighterImage(f);
  const imageCredit = fighterImageCredit(f);

  return (
    <div className="wrap" style={{ padding: "48px 24px" }}>
      <section className="fighter-profile-hero">
        <div className="fighter-profile-art">
          <FighterPortrait fighter={f} width={1100} priority />
        </div>
        <div className="fighter-profile-copy">
          <div className="eyebrow">Fighter dossier · {f.is_active === false ? "Inactive" : "Active"}</div>
          <h1>{f.name}</h1>
          {f.nickname && <div className="profile-nick">“{f.nickname}”</div>}
          <div className="profile-record">{fmtRecord(f)}</div>
          <div className="profile-sub">Professional record as listed by the source · {history.length ? `${wins}-${history.length - wins} across ${history.length} archived bouts` : "fight history backfill in progress"}</div>

          <div className="profile-kpis">
            <div className="profile-kpi"><b>{age(f.dob) ?? "—"}</b><span>Age</span></div>
            <div className="profile-kpi"><b>{fmtHeight(f.height_in)}</b><span>Height</span></div>
            <div className="profile-kpi"><b>{f.reach_in != null ? `${f.reach_in}"` : "—"}</b><span>Reach</span></div>
            <div className="profile-kpi"><b>{stanceLabel(f.stance)}</b><span>Stance</span></div>
          </div>

          <div className="profile-sub">
            {f.weight_lbs != null ? `${f.weight_lbs} lbs` : "Weight —"} · {[f.espn_athlete_id && "ESPN", f.ufcstats_id && "UFC Stats"].filter(Boolean).join(" + ") || "source pending"}
          </div>
          {imageRef && imageCredit && (
            <div className="profile-credit">
              Portrait: {imageCredit}{imageRef.source_url ? <> · <a href={imageRef.source_url} target="_blank" rel="noreferrer">source</a></> : null}
            </div>
          )}
        </div>
      </section>

      <section className="segment">
        <h3>Next fight</h3>
        {upcoming.length ? upcoming.map((b) => {
          const opp = b.fighter_a.id === f.id ? b.fighter_b : b.fighter_a;
          return (
            <div key={b.id} className="matchup visual">
              <div className="top"><span className="eyebrow">{weightClassLabel(b.weight_class, b.is_womens)}{b.is_title ? " · Title bout" : ""}</span><span className="tag">{fmtDate(b.event.event_date)}</span></div>
              <div className="matchup-visuals">
                <div className="matchup-fighter">
                  <FighterPortrait fighter={f} width={700} />
                  <div className="matchup-nameplate"><div className="name">{f.name}</div><div className="rec">{fmtRecord(f)}</div></div>
                </div>
                <Link href={`/fighters/${fighterSlug(opp)}`} className="matchup-fighter">
                  <FighterPortrait fighter={opp} width={700} />
                  <div className="matchup-nameplate"><div className="name">{opp.name}</div><div className="rec">{fmtRecord(opp)}</div></div>
                </Link>
              </div>
              <ProLock />
              <div className="matchup-link" style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
                <Link href={`/events/${eventSlug(b.event)}`} className="dim">{b.event.name}</Link>
                <Link href={`/fights/${matchupSlug(b.fighter_a, b.fighter_b, b.event)}`} style={{ color: "var(--pbe-gold)", fontWeight: 600 }}>Full matchup →</Link>
              </div>
            </div>
          );
        }) : <Empty title="No bout scheduled">When a bout is announced it appears here, and Pro members get the alert the moment it changes.</Empty>}
      </section>

      <section className="segment">
        <h3>Fight history</h3>
        {history.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Event</th><th>Opponent</th><th>Result</th><th>Method</th><th>Rd</th><th>Time</th></tr></thead>
              <tbody>
                {history.map((b) => {
                  const opp = b.fighter_a.id === f.id ? b.fighter_b : b.fighter_a;
                  const r = b.result;
                  const res = !r ? "—" : r.winner_id === f.id ? "W" : r.winner_id ? "L" : r.method === "DRAW" ? "D" : "NC";
                  return (
                    <tr key={b.id}>
                      <td>{fmtDate(b.event?.event_date, { month: "short", day: "numeric", year: "numeric" })}</td>
                      <td><Link href={`/events/${eventSlug(b.event)}`}>{b.event?.name}</Link></td>
                      <td><Link href={`/fighters/${fighterSlug(opp)}`}>{opp.name}</Link></td>
                      <td style={{ color: res === "W" ? "var(--pbe-pos)" : res === "L" ? "var(--pbe-crimson-bright)" : undefined, fontWeight: 700 }}>{res}</td>
                      <td>{r ? METHOD_LABEL[r.method] || r.method : "—"}{r?.finish_detail ? <span className="faint"> · {r.finish_detail}</span> : null}</td>
                      <td>{r?.round ?? "—"}</td>
                      <td>{r?.time_sec != null ? fmtTime(r.time_sec) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <Empty title="History backfilling">This fighter's bouts land here as the UFC Stats archive is loaded. Round-level striking and grappling stats follow.</Empty>}
      </section>

      <JsonLd data={{
        "@context": "https://schema.org", "@type": "Person", name: f.name, alternateName: f.nickname || undefined, url: `${SITE.url}/fighters/${fighterSlug(f)}`,
        image: fighterImageUrl(f, 1200) || undefined,
        birthDate: f.dob || undefined, height: f.height_in != null ? { "@type": "QuantitativeValue", value: f.height_in, unitCode: "INH" } : undefined,
        jobTitle: "Mixed martial artist", memberOf: { "@type": "SportsOrganization", name: "Ultimate Fighting Championship" },
      }} />
    </div>
  );
}
