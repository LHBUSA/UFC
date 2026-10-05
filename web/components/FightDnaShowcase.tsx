import Link from "next/link";
import { FightDnaPortrait } from "@/components/FightDnaPortrait";
import { DnaCard, DnaDeltas, DnaTiles, FinishDonut, RoundPaceChart, SplitBar, StanceColumns, StanceRings, finishParts } from "@/components/dnaViz";
import { fmtMetric } from "@/lib/dna";
import { getFightDnaDemo, type FightDnaDemo } from "@/lib/fightDnaDemo";
import type { DemoCandidate } from "@/lib/fightDnaDemoModel";
import { fmtRecord as fmtFighterRecord } from "@/lib/format";
import { fighterSlug } from "@/lib/slug";

/* Homepage Fight DNA — a PUBLIC DEMO of the product (owner decision 2026-10-05).
 *
 * One real stored snapshot, chosen deterministically by lib/fightDnaDemo.ts,
 * shown identically to every visitor. There is no access decision here on
 * purpose: entitlement must not change this module. Full fighter and fight
 * DNA stay UFC Pro on their own pages.
 *
 * Every number is a stored snapshot field. Missing fields are omitted, never
 * drawn as zero, "—" or "PRO". If no candidate qualifies the module keeps the
 * product story (headline, proof, pipeline, CTAs) and drops the data cards. */

const PIPELINE: Array<[string, string]> = [
  ["Source record", "Official results + fight stats"],
  ["Normalized history", "Standardized, de-duplicated"],
  ["Fight DNA system", "Versioned PBE metric build"],
  ["Confidence + provenance", "Sample, as-of date, sources"],
  ["Matchup intelligence", "Two profiles, one fight"],
];
const PROOF = ["PBE Derived", "Source-backed", "Versioned", "As-of safe", "Provenance verified"];

function clock(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function asOf(d: string): string {
  const t = Date.parse(`${d}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : d;
}
const shortDate = (d: string) => asOf(d).replace(/, \d{4}$/, "");

function DemoCards({ demo, href }: { demo: FightDnaDemo; href: string }) {
  const v = demo.view;
  const f = v.finish;
  const finishes = f ? f.byRound.reduce((s, [, n]) => s + n, 0) : 0;
  const early = f ? f.byRound.filter(([r]) => Number(r) <= 3).reduce((s, [, n]) => s + n, 0) : 0;
  return (
    <div className="fdna-cards">
      <DnaCard kind="strike" title="Striking DNA" lede="Output, accuracy, defense and where the significant strikes are aimed." href={href}>
        <DnaTiles items={v.striking} />
        <SplitBar caption="Significant strike targets" items={v.target} />
      </DnaCard>
      <DnaCard kind="grapple" title="Grappling DNA" lede="Takedown pressure, success rate, control and submission activity." href={href}>
        <DnaTiles items={v.grappling} />
        <StanceColumns caption="Takedowns landed / 15 min by opponent stance" rows={v.stanceTd} />
      </DnaCard>
      <DnaCard kind="round" title="Round DNA" lede="How output and damage taken change as the fight goes on." href={href}>
        <RoundPaceChart rounds={v.rounds} />
        <DnaDeltas items={v.roundDeltas} />
        <p className="dv-note">Rounds a fighter never reached are left out, never counted as zero. Faded bars rest on a small sample.</p>
      </DnaCard>
      <DnaCard kind="finish" title="Finish + stance DNA" lede="How the wins end, when finishes land, and results by opponent stance." href={href}>
        {f && <FinishDonut parts={finishParts(f)} rate={f.rate.value as number} wins={f.wins} />}
        {f && <DnaDeltas items={[
          ...(f.medianSeconds ? [{ key: "median", label: "Median finish, elapsed", text: fmtMetric(f.medianSeconds) }] : []),
          ...(finishes > 0 ? [{ key: "early", label: "Finishes in R1–R3", text: `${early} of ${finishes}` }] : []),
        ]} />}
        <StanceRings caption="Record by opponent stance" rows={v.stances} />
      </DnaCard>
    </div>
  );
}

export async function FightDnaShowcase({ candidates }: { candidates: DemoCandidate[] }) {
  const demo = await getFightDnaDemo(candidates).catch(() => null);
  const href = demo ? `/fighters/${fighterSlug(demo.fighter)}#fight-dna` : "/fighters";
  const words = demo ? demo.fighter.name.trim().split(/\s+/) : [];
  const last = words.length > 1 ? words[words.length - 1] : "";
  const first = words.length > 1 ? words.slice(0, -1).join(" ") : words.join(" ");
  const v = demo?.view;

  return (
    <section className={`fdna${demo ? "" : " fdna--story"}`} aria-labelledby="fdna-title">
      <style>{CSS}</style>
      <div className="fdna-hero">
        {demo && (
          <div className="fdna-photo">
            <FightDnaPortrait src={demo.image.src} alt={demo.fighter.name} />
            <div className="fdna-photo-copy">
              <span className="k">Featured Fight DNA · through {shortDate(demo.window.end)}</span>
              <h3>{first} {last && <em>{last}</em>}</h3>
              <p>{demo.context} · {fmtFighterRecord(demo.fighter)}</p>
              {demo.fighter.nickname && <p className="nick">“{demo.fighter.nickname}”</p>}
            </div>
          </div>
        )}
        <div className="fdna-intro">
          <div className="fdna-topline">
            <div className="eyebrow">PropBetEdge Fight DNA · Proprietary fighter intelligence</div>
            {demo && <span className="fdna-demo-pill" title="This one profile is open to everyone as a sample of Fight DNA.">Public demo</span>}
          </div>
          <h2 id="fdna-title">Every fighter leaves <em>a pattern.</em></h2>
          <p>Fight DNA turns the complete fight record into proprietary striking, grappling, round-by-round, finish and stance intelligence. Every metric carries its sample, confidence, definition version and as-of date.</p>
          <div className="fdna-proof">{PROOF.map((x) => <span key={x}>{x}</span>)}</div>
          {v && (
            <dl className="fdna-coverage" aria-label="Snapshot coverage">
              <div><dt>Completed bouts</dt><dd>{v.completedBouts}</dd></div>
              <div><dt>Rounds with stats</dt><dd>{v.statRounds}</dd></div>
              <div><dt>Observed time</dt><dd>{clock(v.observedSeconds)}</dd></div>
              <div><dt>As of · v{v.version}</dt><dd>{asOf(v.asOf)}</dd></div>
            </dl>
          )}
        </div>
      </div>

      {demo && <DemoCards demo={demo} href={href} />}

      <div className="fdna-foot">
        <ol className="fdna-pipe" aria-label="Fight DNA pipeline">{PIPELINE.map(([t, d], i) => <li key={t} title={d}><small>0{i + 1}</small><b>{t}</b></li>)}</ol>
        <div className="fdna-ctas">
          <Link href={href} className="btn gold">{demo ? `Explore ${last || demo.fighter.name}’s Fight DNA →` : "Explore Fight DNA →"}</Link>
          <Link href="/learn/fight-dna" className="btn">See how it works →</Link>
        </div>
      </div>
      <p className="fdna-fine">Evidence with receipts, not certainty. Fight DNA describes patterns in the stored fight record; it is not an official UFC statistic and does not predict the next result.{demo?.image.credit ? ` Photo: ${demo.image.credit}.` : ""}</p>
    </section>
  );
}

const CSS = `
.fdna{position:relative;overflow:hidden;border:1px solid rgba(212,175,55,.34);border-radius:22px;background:radial-gradient(900px 460px at 0% 0%,rgba(212,175,55,.13),transparent 60%),linear-gradient(150deg,var(--pbe-ink-2),var(--pbe-ink) 55%,var(--pbe-ink-4));box-shadow:0 28px 80px rgba(0,0,0,.32)}
.fdna:before{content:"";position:absolute;inset:0;background:url("/media/ufc-cage-bg-1600.webp") center 30%/cover;opacity:.09;pointer-events:none}
.fdna>*{position:relative}
.fdna-hero{display:grid;grid-template-columns:minmax(300px,38%) minmax(0,1fr);border-bottom:1px solid rgba(212,175,55,.16)}
.fdna--story .fdna-hero{grid-template-columns:1fr}
.fdna-photo{position:relative;min-height:470px;overflow:hidden;border-right:1px solid rgba(212,175,55,.18);background:var(--pbe-ink-4)}
.fdna-photo img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 16%;filter:saturate(.78) contrast(1.08) sepia(.12)}
.fdna-photo:before{content:"";position:absolute;inset:0;z-index:1;background:radial-gradient(120% 70% at 70% 8%,rgba(233,199,90,.22),transparent 55%),linear-gradient(90deg,transparent 70%,rgba(20,17,13,.55));mix-blend-mode:soft-light;pointer-events:none}
.fdna-photo:after{content:"";position:absolute;inset:38% 0 0;z-index:1;background:linear-gradient(180deg,transparent,rgba(13,11,8,.72) 45%,rgba(13,11,8,.97));pointer-events:none}
.fdna-portrait-fallback{position:absolute;inset:0;display:grid;place-items:center;background:radial-gradient(360px 260px at 50% 30%,rgba(212,175,55,.16),transparent 70%),linear-gradient(180deg,var(--pbe-ink-2),var(--pbe-ink-4))}
.fdna-portrait-fallback .cage{position:absolute;inset:-10% auto auto -20%;width:140%;opacity:.1}
.fdna-photo-copy{position:absolute;z-index:2;left:28px;right:24px;bottom:26px}
.fdna-photo-copy .k{display:block;color:var(--pbe-gold);font:800 10px/1 var(--pbe-font-data);letter-spacing:.18em;text-transform:uppercase}
.fdna-photo-copy h3{margin-top:9px;color:var(--pbe-paper);font:900 clamp(32px,3.4vw,46px)/.96 var(--pbe-font-display);letter-spacing:-.025em;text-wrap:balance}
.fdna-photo-copy h3 em{color:var(--pbe-gold-bright);font-style:normal}
.fdna-photo-copy p{margin-top:9px;color:var(--pbe-paper-2);font:700 11px/1.4 var(--pbe-font-data);letter-spacing:.1em;text-transform:uppercase}
.fdna-photo-copy p.nick{margin-top:4px;color:var(--pbe-dim);letter-spacing:.08em}
.fdna-intro{padding:clamp(26px,3.2vw,44px);display:flex;flex-direction:column;justify-content:center;min-width:0}
.fdna-topline{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.fdna-topline .eyebrow{color:var(--pbe-gold)}
.fdna-demo-pill{flex:none;display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border:1px solid rgba(78,163,115,.42);border-radius:999px;background:rgba(78,163,115,.09);color:var(--pbe-paper-2);font:800 9.5px/1 var(--pbe-font-data);letter-spacing:.13em;text-transform:uppercase}
.fdna-demo-pill:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--pbe-pos);box-shadow:0 0 10px rgba(78,163,115,.7)}
.fdna-intro h2{margin-top:12px;color:var(--pbe-paper);font:900 clamp(38px,5vw,68px)/.94 var(--pbe-font-display);letter-spacing:-.035em}
.fdna-intro h2 em{display:block;color:var(--pbe-gold);font-style:normal}
.fdna-intro>p{max-width:64ch;margin-top:16px;color:var(--pbe-paper-2);font-size:15px;line-height:1.62}
.fdna-proof{display:flex;flex-wrap:wrap;gap:7px;margin-top:18px}
.fdna-proof span{padding:7px 10px;border:1px solid var(--pbe-line-strong);border-radius:999px;background:rgba(255,245,220,.03);color:var(--pbe-dim);font:800 9.5px/1 var(--pbe-font-data);letter-spacing:.1em;text-transform:uppercase}
.fdna-proof span:first-child{border-color:rgba(212,175,55,.55);color:var(--pbe-gold);background:var(--pbe-gold-wash)}
.fdna-coverage{display:grid;grid-template-columns:.8fr .9fr 1.1fr 1.25fr;margin:22px 0 0;border:1px solid var(--pbe-line);border-radius:12px;background:rgba(255,245,220,.025);overflow:hidden}
.fdna-coverage div{padding:14px 16px;display:flex;flex-direction:column-reverse;justify-content:flex-end;gap:6px;min-width:0}
.fdna-coverage div+div{border-left:1px solid var(--pbe-line)}
.fdna-coverage dd{margin:0;color:var(--pbe-paper);font:800 clamp(17px,1.55vw,22px)/1 var(--pbe-font-data);white-space:nowrap}
.fdna-coverage dt{color:var(--pbe-faint);font:700 9px/1.25 var(--pbe-font-data);letter-spacing:.1em;text-transform:uppercase}
.fdna-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:clamp(16px,2vw,24px)}
.fdna-foot{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px 24px;align-items:center;padding:16px clamp(16px,2vw,24px);border-top:1px solid rgba(212,175,55,.18);background:rgba(20,17,13,.5)}
.fdna-pipe{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px}
.fdna-pipe li{position:relative;display:flex;align-items:baseline;gap:7px;padding-right:16px;min-width:0}
.fdna-pipe li:not(:last-child):after{content:"→";position:absolute;right:0;top:0;color:var(--pbe-gold);font:700 12px/1 var(--pbe-font-data)}
.fdna-pipe small{flex:none;color:var(--pbe-faint);font:700 9px/1.3 var(--pbe-font-data)}
.fdna-pipe b{color:var(--pbe-paper);font:800 9.5px/1.3 var(--pbe-font-data);letter-spacing:.08em;text-transform:uppercase}
.fdna-pipe li:nth-child(3) b{color:var(--pbe-gold)}
.fdna-ctas{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.fdna-fine{margin:0;padding:0 clamp(16px,2vw,24px) 16px;color:var(--pbe-faint);font:500 10px/1.5 var(--pbe-font-data);background:rgba(20,17,13,.5)}
@media(max-width:1180px){.fdna-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.fdna-foot{grid-template-columns:1fr}.fdna-ctas{justify-content:flex-start}}
@media(max-width:900px){.fdna-hero{grid-template-columns:minmax(260px,40%) minmax(0,1fr)}.fdna-coverage{grid-template-columns:repeat(2,minmax(0,1fr))}.fdna-coverage div:nth-child(3){border-left:0}.fdna-coverage div:nth-child(n+3){border-top:1px solid var(--pbe-line)}.fdna-pipe{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:12px}.fdna-pipe li:nth-child(3):after{display:none}}
@media(max-width:760px){.fdna-hero{grid-template-columns:1fr}.fdna-photo{min-height:440px;border-right:0;border-bottom:1px solid rgba(212,175,55,.18)}.fdna-cards{grid-template-columns:1fr}.fdna-topline{flex-direction:column-reverse;gap:12px}}
@media(max-width:480px){.fdna{border-radius:16px}.fdna-photo{min-height:400px}.fdna-photo-copy{left:18px;right:18px;bottom:20px}.fdna-intro{padding:22px 18px}.fdna-intro h2{font-size:40px}.fdna-intro>p{font-size:14px}.fdna-cards{padding:12px}.fdna-pipe{grid-template-columns:1fr 1fr}.fdna-pipe li:after{display:none}.fdna-ctas .btn{flex:1 1 100%;justify-content:center;text-align:center}}
`;
