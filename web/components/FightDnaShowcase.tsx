import Link from "next/link";
import { Origin } from "@/components/dna";
import { getUfcAccess } from "@/lib/access";
import { getFighterDna, fmtMetric, fmtRecord as fmtDnaRecord, STANCE_LABEL, type DnaSnapshot, type MetricObject } from "@/lib/dna";
import { getFightersByIds, getImagesForFighters } from "@/lib/db";
import { fmtRecord as fmtFighterRecord } from "@/lib/format";
import { fighterIdFromSlug } from "@/lib/slug";

/* Homepage Fight DNA product module.
 *
 * This is intentionally a product preview, not another documentation block.
 * Verified Pro users see a real stored Fight DNA snapshot for the featured
 * fighter. Public users see the same product architecture without premium
 * values leaking. Every displayed number still comes from the stored DNA
 * snapshot; nothing is recomputed or inferred here. */

function idFromHref(href: string): string | null {
  const slug = href.split("/").filter(Boolean).pop()?.split("#")[0] || "";
  return fighterIdFromSlug(slug);
}

function hasMetric(m?: MetricObject | null): boolean {
  return Boolean(m && m.value != null);
}

function metric(m?: MetricObject | null): string {
  return hasMetric(m) ? fmtMetric(m) : "—";
}

function distribution(m?: MetricObject | null): Array<[string, number]> {
  if (!m) return [];
  const raw = (m as unknown as { value?: unknown }).value;
  const nested = raw && typeof raw === "object" ? raw as { buckets?: Record<string, number> } : null;
  const buckets = m.buckets || nested?.buckets || {};
  return Object.entries(buckets).filter(([, value]) => Number.isFinite(value) && value > 0).sort(([a], [b]) => Number(a) - Number(b));
}

function MetricCell({ label, value, locked = false }: { label: string; value: string; locked?: boolean }) {
  return (
    <div className={`fdna-metric${locked ? " locked" : ""}`}>
      <b>{locked ? "PRO" : value}</b>
      <span>{label}</span>
    </div>
  );
}

function FamilyCard({ title, eyebrow, children, locked = false }: { title: string; eyebrow: string; children: React.ReactNode; locked?: boolean }) {
  return (
    <article className={`fdna-family${locked ? " is-locked" : ""}`}>
      <div className="fdna-family-head"><span>{eyebrow}</span>{locked && <i>PRO</i>}</div>
      <h3>{title}</h3>
      {children}
    </article>
  );
}

export async function FightDnaShowcase({ exploreHref = "/fighters", exploreLabel = "Explore Fight DNA →" }: { exploreHref?: string; exploreLabel?: string }) {
  const fighterId = idFromHref(exploreHref);
  let fighter: Awaited<ReturnType<typeof getFightersByIds>>[number] | null = null;
  let image: string | null = null;
  let snapshot: DnaSnapshot | null = null;
  let pro = false;

  if (fighterId) {
    const [access, fighters, images] = await Promise.all([
      getUfcAccess(),
      getFightersByIds([fighterId]).catch(() => []),
      getImagesForFighters([fighterId]).catch(() => new Map()),
    ]);
    pro = Boolean(access.pro);
    fighter = fighters[0] || null;
    image = images.get(fighterId)?.card || null;
    if (pro) {
      const dna = await getFighterDna(fighterId).catch(() => null);
      if (dna?.status === "ok") snapshot = dna.data.snapshot;
    }
  }

  const m = snapshot?.metrics || {};
  const fp = snapshot?.finish_profile || {};
  const rounds = snapshot?.round_profile?.rounds || {};
  const roundKeys = ["1", "2", "3", "4", "5"].filter((key) => rounds[key]?.sig_att_per_min?.value != null);
  const roundMax = Math.max(...roundKeys.map((key) => Number(rounds[key]?.sig_att_per_min?.value || 0)), 0.01);
  const finishes = distribution(fp.finish_round_distribution);
  const finishTotal = finishes.reduce((sum, [, value]) => sum + value, 0);
  const stance = Object.entries(snapshot?.stance_splits || {})
    .filter(([key, split]) => /^[A-Z_]+$/.test(key) && Number(split.record?.appearances ?? split.appearances ?? 0) > 0)
    .sort(([, a], [, b]) => Number(b.record?.appearances ?? b.appearances ?? 0) - Number(a.record?.appearances ?? a.appearances ?? 0))[0] || null;

  const displayName = fighter?.name || "Featured fighter";
  const lastName = fighter?.name?.split(" ").slice(-1)[0] || "fighter";
  const fullProfileLabel = fighter ? `Open ${lastName}’s full Fight DNA →` : exploreLabel;
  const locked = !snapshot;

  return (
    <section className="fdna-showcase" aria-labelledby="fdna-title">
      <style>{`
        .fdna-showcase{position:relative;overflow:hidden;border:1px solid rgba(212,175,55,.36);border-radius:22px;background:radial-gradient(900px 420px at 0% 0%,rgba(212,175,55,.16),transparent 58%),radial-gradient(720px 420px at 100% 12%,rgba(97,72,255,.08),transparent 62%),linear-gradient(145deg,#15110d,#090807 72%);box-shadow:0 24px 70px rgba(0,0,0,.28)}
        .fdna-showcase:before{content:"";position:absolute;inset:0;background:url("/media/ufc-cage-bg-1600.webp") center 35%/cover;opacity:.07;pointer-events:none}
        .fdna-showcase>*{position:relative}.fdna-top{display:grid;grid-template-columns:minmax(250px,.78fr) minmax(0,1.45fr);min-height:410px}.fdna-fighter{position:relative;overflow:hidden;border-right:1px solid rgba(212,175,55,.2);background:linear-gradient(180deg,rgba(212,175,55,.045),rgba(0,0,0,.26));min-height:410px}.fdna-fighter:after{content:"";position:absolute;inset:36% 0 0;background:linear-gradient(180deg,transparent,rgba(5,5,4,.94) 72%)}
        .fdna-fighter img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 18%;filter:saturate(.85) contrast(1.05)}.fdna-fallback{position:absolute;inset:0;display:grid;place-items:center;color:rgba(212,175,55,.24);font:900 96px/1 var(--pbe-font-display);letter-spacing:-.08em;background:radial-gradient(circle at 50% 30%,rgba(212,175,55,.15),transparent 42%)}
        .fdna-fighter-copy{position:absolute;z-index:2;left:22px;right:22px;bottom:22px}.fdna-fighter-copy>span{display:block;color:var(--pbe-gold);font:800 9px/1 var(--pbe-font-data);letter-spacing:.16em;text-transform:uppercase}.fdna-fighter-copy h3{margin-top:7px;color:var(--pbe-paper);font:900 clamp(26px,3vw,38px)/.98 var(--pbe-font-display);letter-spacing:-.025em}.fdna-fighter-copy p{margin-top:8px;color:var(--pbe-dim);font:650 11px/1.4 var(--pbe-font-data);letter-spacing:.06em;text-transform:uppercase}.fdna-fighter-copy .fdna-live{display:inline-flex;margin-top:11px;padding:5px 8px;border:1px solid rgba(78,163,115,.36);border-radius:999px;background:rgba(78,163,115,.1);color:var(--pbe-pos);font:800 9px/1 var(--pbe-font-data);letter-spacing:.1em}
        .fdna-intro{padding:clamp(24px,3.2vw,38px)}.fdna-intro-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.fdna-intro .eyebrow{color:var(--pbe-gold)}.fdna-intro h2{margin-top:9px;max-width:13ch;color:var(--pbe-paper);font:900 clamp(34px,4.8vw,58px)/.95 var(--pbe-font-display);letter-spacing:-.035em}.fdna-intro h2 em{display:block;color:var(--pbe-gold);font-style:normal}.fdna-origin{flex:none}.fdna-intro>p{max-width:68ch;margin-top:15px;color:var(--pbe-paper-2);font-size:14.5px;line-height:1.65}.fdna-proof{display:flex;gap:7px;flex-wrap:wrap;margin-top:17px}.fdna-proof span{padding:6px 8px;border:1px solid var(--pbe-line);border-radius:999px;background:rgba(0,0,0,.25);color:var(--pbe-faint);font:800 9px/1 var(--pbe-font-data);letter-spacing:.09em;text-transform:uppercase}.fdna-proof span:first-child{border-color:rgba(212,175,55,.34);color:var(--pbe-gold)}
        .fdna-sample{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;margin-top:21px;border:1px solid var(--pbe-line);border-radius:10px;overflow:hidden;background:var(--pbe-line)}.fdna-sample div{padding:12px;background:rgba(7,7,6,.78)}.fdna-sample b{display:block;color:var(--pbe-paper);font:800 17px/1 var(--pbe-font-data)}.fdna-sample span{display:block;margin-top:5px;color:var(--pbe-faint);font:700 9px/1.2 var(--pbe-font-data);letter-spacing:.08em;text-transform:uppercase}
        .fdna-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:0 clamp(24px,3.2vw,38px) clamp(24px,3.2vw,38px)}.fdna-family{position:relative;min-height:190px;padding:16px;border:1px solid var(--pbe-line);border-radius:12px;background:linear-gradient(180deg,rgba(255,255,255,.022),rgba(0,0,0,.22));overflow:hidden}.fdna-family.is-locked:after{content:"";position:absolute;inset:0;background:linear-gradient(145deg,transparent 40%,rgba(0,0,0,.3));pointer-events:none}.fdna-family-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.fdna-family-head span{color:var(--pbe-gold);font:800 9px/1 var(--pbe-font-data);letter-spacing:.12em;text-transform:uppercase}.fdna-family-head i{padding:4px 6px;border:1px solid rgba(212,175,55,.42);border-radius:999px;color:var(--pbe-gold);font:800 8px/1 var(--pbe-font-data);font-style:normal;letter-spacing:.1em}.fdna-family h3{margin-top:8px;color:var(--pbe-paper);font:800 18px/1.05 var(--pbe-font-display)}.fdna-metrics{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:14px}.fdna-metric{padding:9px;border:1px solid var(--pbe-line-faint);border-radius:8px;background:rgba(0,0,0,.2)}.fdna-metric b{display:block;color:var(--pbe-paper);font:800 17px/1 var(--pbe-font-data)}.fdna-metric.locked b{color:var(--pbe-gold);font-size:10px;letter-spacing:.1em}.fdna-metric span{display:block;margin-top:5px;color:var(--pbe-faint);font:650 9px/1.2 var(--pbe-font-data);text-transform:uppercase;letter-spacing:.055em}
        .fdna-rounds{display:flex;align-items:flex-end;gap:7px;height:92px;margin-top:15px;padding-top:8px}.fdna-round{display:flex;flex:1;min-width:0;flex-direction:column;justify-content:flex-end;gap:5px;height:100%}.fdna-round i{display:block;min-height:8px;border-radius:4px 4px 1px 1px;background:linear-gradient(180deg,var(--pbe-gold),rgba(212,175,55,.28));box-shadow:0 0 14px rgba(212,175,55,.08)}.fdna-round b{color:var(--pbe-paper);font:750 10px/1 var(--pbe-font-data)}.fdna-round span{color:var(--pbe-faint);font:700 8px/1 var(--pbe-font-data);letter-spacing:.08em}.fdna-rounds.locked .fdna-round i{background:linear-gradient(180deg,rgba(212,175,55,.28),rgba(212,175,55,.04))}.fdna-rounds.locked .fdna-round b{color:var(--pbe-gold)}
        .fdna-finish{display:flex;align-items:flex-end;gap:7px;height:92px;margin-top:15px}.fdna-finish-col{display:flex;flex:1;min-width:0;height:100%;flex-direction:column;justify-content:flex-end;align-items:center;gap:5px}.fdna-finish-col i{width:100%;min-height:7px;border-radius:4px 4px 1px 1px;background:linear-gradient(180deg,#ffcf3b,rgba(212,175,55,.24))}.fdna-finish-col b{color:var(--pbe-paper);font:750 10px/1 var(--pbe-font-data)}.fdna-finish-col span{color:var(--pbe-faint);font:700 8px/1 var(--pbe-font-data);letter-spacing:.06em}.fdna-family-note{margin-top:13px;color:var(--pbe-faint);font-size:11px;line-height:1.45}.fdna-stance{margin-top:13px;padding:11px;border:1px solid var(--pbe-line-faint);border-radius:8px;background:rgba(0,0,0,.2)}.fdna-stance b{display:block;color:var(--pbe-paper);font:750 14px/1.1 var(--pbe-font-data)}.fdna-stance span{display:block;margin-top:5px;color:var(--pbe-faint);font-size:10px}
        .fdna-bottom{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px;padding:18px clamp(24px,3.2vw,38px);border-top:1px solid rgba(212,175,55,.2);background:rgba(0,0,0,.24)}.fdna-pipe{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.fdna-pipe span{display:inline-flex;align-items:center;gap:8px;color:var(--pbe-faint);font:800 9px/1 var(--pbe-font-data);letter-spacing:.08em;text-transform:uppercase}.fdna-pipe span:not(:last-child):after{content:"→";color:var(--pbe-gold)}.fdna-pipe b{color:var(--pbe-paper);font-weight:800}.fdna-bottom-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.fdna-disclaimer{grid-column:1/-1;color:var(--pbe-faint);font:500 10px/1.45 var(--pbe-font-data)}
        @media(max-width:1050px){.fdna-top{grid-template-columns:minmax(220px,.72fr) minmax(0,1.28fr)}.fdna-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
        @media(max-width:760px){.fdna-top{grid-template-columns:1fr}.fdna-fighter{min-height:330px;border-right:0;border-bottom:1px solid rgba(212,175,55,.2)}.fdna-intro-head{display:block}.fdna-origin{margin-top:12px}.fdna-sample{grid-template-columns:repeat(2,minmax(0,1fr))}.fdna-grid{grid-template-columns:1fr}.fdna-bottom{grid-template-columns:1fr}.fdna-bottom-actions{justify-content:flex-start}.fdna-family{min-height:0}}
        @media(max-width:480px){.fdna-intro,.fdna-grid,.fdna-bottom{padding-left:16px;padding-right:16px}.fdna-fighter-copy{left:16px;right:16px}.fdna-intro h2{font-size:36px}.fdna-sample{grid-template-columns:1fr 1fr}.fdna-bottom-actions .btn{width:100%;justify-content:center;text-align:center}}
      `}</style>

      <div className="fdna-top">
        <div className="fdna-fighter">
          <img src={image || "/media/fight-dna-featured-fighter.svg"} alt="" width={720} height={900} loading="lazy" decoding="async" />
          <div className="fdna-fighter-copy">
            <span>Featured Fight DNA</span>
            <h3>{displayName}</h3>
            <p>{fighter ? fmtFighterRecord(fighter) : "Normalized fight history"}</p>
            <span className="fdna-live">{snapshot ? `LIVE PROFILE · v${snapshot.definition_version}` : pro ? "PROFILE BUILDING" : "PRO INTELLIGENCE"}</span>
          </div>
        </div>

        <div className="fdna-intro">
          <div className="fdna-intro-head">
            <div>
              <div className="eyebrow">PropBetEdge Fight DNA · proprietary fighter intelligence</div>
              <h2 id="fdna-title">Every fighter leaves <em>a pattern.</em></h2>
            </div>
            <div className="fdna-origin"><Origin explain /></div>
          </div>
          <p>Fight DNA converts the historical fight record into versioned striking, grappling, stance, finish and round-level intelligence. Every derived metric keeps the sample, confidence, as-of date and provenance behind it.</p>
          <div className="fdna-proof"><span>PBE Derived</span><span>Source-backed</span><span>As-of safe</span><span>Versioned</span><span>No future-fight contamination</span></div>
          <div className="fdna-sample" aria-label="Fight DNA data coverage">
            <div><b>{snapshot ? snapshot.sample_completed_bouts : "—"}</b><span>Completed bouts</span></div>
            <div><b>{snapshot ? snapshot.sample_rounds : "—"}</b><span>Rounds with stats</span></div>
            <div><b>{snapshot ? `${Math.round(snapshot.sample_seconds / 60)}m` : "—"}</b><span>Observed time</span></div>
            <div><b>{snapshot ? snapshot.coverage_status : locked ? "PRO" : "—"}</b><span>{snapshot ? `As of ${snapshot.as_of_date}` : "Coverage + provenance"}</span></div>
          </div>
        </div>
      </div>

      <div className="fdna-grid">
        <FamilyCard title="Striking snapshot" eyebrow="Striking DNA" locked={locked}>
          <div className="fdna-metrics">
            <MetricCell label="Sig. landed / min" value={metric(m.sig_landed_per_min)} locked={locked} />
            <MetricCell label="Sig. accuracy" value={metric(m.sig_accuracy)} locked={locked} />
            <MetricCell label="Sig. defense" value={metric(m.sig_defense)} locked={locked} />
            <MetricCell label="Strike diff. / min" value={metric(m.sig_diff_per_min)} locked={locked} />
          </div>
        </FamilyCard>

        <FamilyCard title="Grappling pressure" eyebrow="Grappling DNA" locked={locked}>
          <div className="fdna-metrics">
            <MetricCell label="TD attempts / 15" value={metric(m.td_attempts_per_15)} locked={locked} />
            <MetricCell label="TD landed / 15" value={metric(m.td_landed_per_15)} locked={locked} />
            <MetricCell label="TD accuracy" value={metric(m.td_accuracy)} locked={locked} />
            <MetricCell label="Sub attempts / 15" value={metric(m.sub_attempts_per_15)} locked={locked} />
          </div>
        </FamilyCard>

        <FamilyCard title="Round progression" eyebrow="Round DNA" locked={locked}>
          <div className={`fdna-rounds${locked ? " locked" : ""}`} aria-label="Significant strike attempts per minute by round">
            {(snapshot && roundKeys.length ? roundKeys.slice(0, 5) : ["1", "2", "3"]).map((key, index) => {
              const value = snapshot ? Number(rounds[key]?.sig_att_per_min?.value || 0) : 0;
              const heights = [74, 62, 48];
              const height = snapshot ? Math.max(8, (value / roundMax) * 100) : heights[index] || 42;
              return <div className="fdna-round" key={key}><i style={{ height: `${height}%` }} /><b>{snapshot ? metric(rounds[key]?.sig_att_per_min) : "PRO"}</b><span>R{key}</span></div>;
            })}
          </div>
          <p className="fdna-family-note">Pace is reconstructed round by round from archived observations; missing rounds are never converted to zeroes.</p>
        </FamilyCard>

        <FamilyCard title="Finish + stance profile" eyebrow="Finish DNA" locked={locked}>
          {snapshot && finishes.length ? (
            <div className="fdna-finish" aria-label="Finish wins by round">
              {finishes.slice(0, 5).map(([round, count]) => <div className="fdna-finish-col" key={round}><i style={{ height: `${Math.max(8, (count / Math.max(finishTotal, 1)) * 100)}%` }} /><b>{count}</b><span>R{round}</span></div>)}
            </div>
          ) : (
            <div className="fdna-metrics">
              <MetricCell label="Finish rate" value={metric(fp.finish_rate)} locked={locked} />
              <MetricCell label="KO/TKO share" value={metric(fp.ko_finish_rate)} locked={locked} />
              <MetricCell label="Submission share" value={metric(fp.submission_finish_rate)} locked={locked} />
              <MetricCell label="Median finish" value={metric(fp.finish_time_median_sec)} locked={locked} />
            </div>
          )}
          <div className="fdna-stance">
            {snapshot && stance ? <><b>vs {STANCE_LABEL[stance[0]] || stance[0]}</b><span>{fmtDnaRecord(stance[1].record)} · {stance[1].record?.appearances ?? stance[1].appearances ?? 0} archived appearance{Number(stance[1].record?.appearances ?? stance[1].appearances ?? 0) === 1 ? "" : "s"}</span></> : <><b>{locked ? "STANCE DNA · PRO" : "Stance split pending"}</b><span>Historical performance grouped by opponent&apos;s listed stance.</span></>}
          </div>
        </FamilyCard>
      </div>

      <div className="fdna-bottom">
        <div className="fdna-pipe" aria-label="Fight DNA provenance pipeline"><span><b>Source record</b></span><span>Normalized</span><span><b>PBE derived</b></span><span>Provenance verified</span></div>
        <div className="fdna-bottom-actions">
          <Link href={snapshot ? exploreHref : "/pro"} className="btn gold">{snapshot ? fullProfileLabel : "Unlock Fight DNA →"}</Link>
          <Link href="/learn/fight-dna" className="btn">How Fight DNA is built →</Link>
        </div>
        <div className="fdna-disclaimer">Evidence with receipts, not certainty. Fight DNA describes patterns in the stored fight record; it is not an official UFC statistic and does not claim to know the next result.</div>
      </div>
    </section>
  );
}
