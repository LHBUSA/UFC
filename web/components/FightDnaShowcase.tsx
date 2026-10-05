import Link from "next/link";
import { FightDnaPortrait } from "@/components/FightDnaPortrait";
import { fmtMetric, fmtRecord as fmtDnaRecord, STANCE_LABEL, type MetricObject } from "@/lib/dna";
import { getFightDnaDemo, type FightDnaDemo } from "@/lib/fightDnaDemo";
import type { DemoCandidate, RoundPoint, StanceRow, Tile } from "@/lib/fightDnaDemoModel";
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

function signed(m: MetricObject): string {
  const v = m.value as number;
  const s = fmtMetric(m);
  return v > 0 ? `+${s}` : s;
}
const isRatioDelta = (t: Tile) => t.key.startsWith("pace_retention");
function tileValue(t: Tile): [string, string] {
  const v = t.metric.value as number;
  if (isRatioDelta(t)) { const p = Math.round((v - 1) * 100); return [`${p > 0 ? "+" : ""}${p}%`, ""]; }
  const s = t.signed ? signed(t.metric) : fmtMetric(t.metric);
  const unit = s.match(/(\/min|\/15)$/)?.[1] || "";
  return [unit ? s.slice(0, -unit.length) : s, unit];
}
function tileTone(t: Tile): string | undefined {
  /* Gold marks a gain in output; more strikes absorbed is never highlighted as good. */
  if ((!t.signed && !isRatioDelta(t)) || t.key.startsWith("defensive_drift")) return undefined;
  return (t.metric.value as number) > (isRatioDelta(t) ? 1 : 0) ? "up" : undefined;
}
function clock(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function asOf(d: string): string {
  const t = Date.parse(`${d}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : d;
}
const pct = (n: number) => `${Math.round(n * 100)}%`;
const lowSample = (c: string) => c === "low" || c === "insufficient";
const stanceName = (k: string) => STANCE_LABEL[k] || k;

function Tiles({ items }: { items: Tile[] }) {
  return <div className="fdna-tiles">{items.map((t) => { const [n, u] = tileValue(t); return <div className="fdna-tile" key={t.key}><b className={tileTone(t)}>{n}{u && <small>{u}</small>}</b><span>{t.label}</span></div>; })}</div>;
}

function Deltas({ items }: { items: Tile[] }) {
  return <ul className="fdna-deltas">{items.map((t) => { const [n, u] = tileValue(t); return <li key={t.key}><span>{t.label}</span><b className={tileTone(t)}>{n}{u && <small>{u}</small>}</b></li>; })}</ul>;
}

type Kind = "strike" | "grapple" | "round" | "finish";
function Icon({ kind }: { kind: Kind }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      {kind === "strike" && <><circle cx="12" cy="12" r="8" {...p} /><circle cx="12" cy="12" r="4" {...p} /><circle cx="12" cy="12" r=".9" fill="currentColor" /></>}
      {kind === "grapple" && <><path d="M7 15c-2-2-2-5 0-7s5-2 7 0" {...p} /><path d="M17 9c2 2 2 5 0 7s-5 2-7 0" {...p} /></>}
      {kind === "round" && <path d="M5 19v-7M10 19V7M15 19v-9M20 19V5" {...p} />}
      {kind === "finish" && <><circle cx="12" cy="12" r="8" {...p} /><path d="M12 4a8 8 0 0 1 8 8h-8z" fill="currentColor" opacity=".55" /></>}
    </svg>
  );
}

function Card({ kind, title, lede, href, children }: { kind: Kind; title: string; lede: string; href: string; children: React.ReactNode }) {
  return (
    <article className="fdna-card">
      <header><span className="ic"><Icon kind={kind} /></span><h3>{title}</h3></header>
      <p className="lede">{lede}</p>
      {children}
      <Link href={href} className="fv">Full view →</Link>
    </article>
  );
}

function RoundChart({ rounds }: { rounds: RoundPoint[] }) {
  const max = Math.max(...rounds.flatMap((r) => [r.landed, r.absorbed ?? 0]), 1);
  const W = 260, H = 118, top = 16, base = 96, gw = W / rounds.length, bw = Math.min(16, gw / 3.2);
  const y = (v: number) => base - (v / max) * (base - top);
  return (
    <figure className="fdna-roundchart">
      <div className="fdna-legend"><span><i className="gold" />Sig. landed / min</span><span><i className="grey" />Absorbed / min</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Significant strikes landed and absorbed per minute, by round">
        <line x1="0" x2={W} y1={base + .5} y2={base + .5} className="axis" />
        {rounds.map((r, i) => {
          const cx = gw * i + gw / 2;
          return (
            <g key={r.round} className={lowSample(r.confidence) ? "faded" : undefined}>
              <title>{`Round ${r.round}: ${r.landed.toFixed(2)} landed/min${r.absorbed != null ? `, ${r.absorbed.toFixed(2)} absorbed/min` : ""}${r.rounds != null ? ` · ${r.rounds} rounds observed` : ""} · ${r.confidence} confidence`}</title>
              <rect x={cx - bw - 1} y={y(r.landed)} width={bw} height={base - y(r.landed)} rx="3" className="bar-gold" />
              {r.absorbed != null && <rect x={cx + 1} y={y(r.absorbed)} width={bw} height={base - y(r.absorbed)} rx="3" className="bar-grey" />}
              <text x={cx - bw / 2 - 1} y={y(r.landed) - 4} textAnchor="middle" className="val">{r.landed.toFixed(1)}</text>
              <text x={cx} y={base + 12} textAnchor="middle" className="lab">R{r.round}</text>
              {r.rounds != null && <text x={cx} y={base + 21} textAnchor="middle" className="n">{r.rounds} rd{r.rounds === 1 ? "" : "s"}</text>}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

type Part = { key: string; label: string; value: number; cls: string };
function Donut({ parts, center }: { parts: Part[]; center: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  const R = 40, C = 2 * Math.PI * R, gap = shown.length > 1 ? 2 : 0;
  let off = 0;
  return (
    <svg className="fdna-donut" viewBox="0 0 104 104" role="img" aria-label={`Finish rate ${center}; ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`}>
      <circle cx="52" cy="52" r={R} className="track" />
      {total > 0 && shown.map((p) => {
        const len = (p.value / total) * C;
        const el = <circle key={p.key} cx="52" cy="52" r={R} className={p.cls} strokeDasharray={`${Math.max(len - gap, 0.5)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 52 52)"><title>{`${p.label}: ${p.value} win${p.value === 1 ? "" : "s"}`}</title></circle>;
        off += len;
        return el;
      })}
      <text x="52" y="54" textAnchor="middle" className="c1">{center}</text>
      <text x="52" y="66" textAnchor="middle" className="c2">FINISH RATE</text>
    </svg>
  );
}

function StanceRing({ row }: { row: StanceRow }) {
  const r = row.record, n = r.w + r.l + r.d, apps = r.appearances ?? n;
  const share = n > 0 ? r.w / n : 0;
  const R = 17, C = 2 * Math.PI * R, small = apps < 3;
  return (
    <div className={`fdna-ring${small ? " faded" : ""}`} title={`vs ${stanceName(row.stance)}: ${fmtDnaRecord(r)} across ${apps} archived appearance${apps === 1 ? "" : "s"}`}>
      <svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r={R} className="track" />{n > 0 && r.w > 0 && <circle cx="22" cy="22" r={R} className="arc" strokeDasharray={`${share * C} ${C}`} transform="rotate(-90 22 22)" />}<text x="22" y="25.5" textAnchor="middle">{pct(share)}</text></svg>
      <b>vs {stanceName(row.stance)}</b>
      <span>{r.w}-{r.l}{r.d ? `-${r.d}` : ""}{small ? " · small sample" : ""}</span>
    </div>
  );
}

function DemoCards({ demo, href }: { demo: FightDnaDemo; href: string }) {
  const v = demo.view;
  const tdMax = Math.max(...v.stanceTd.map((r) => r.tdLanded!.value as number), 0.01);
  const f = v.finish;
  const parts: Part[] = f ? ([
    { key: "ko", label: "KO/TKO", value: f.ko, cls: "seg-gold" },
    { key: "sub", label: "Submission", value: f.sub, cls: "seg-crimson" },
    { key: "dec", label: "Decision", value: f.decision, cls: "seg-grey" },
  ].filter((p) => p.value != null) as Part[]) : [];
  const finishes = f ? f.byRound.reduce((s, [, n]) => s + n, 0) : 0;
  const early = f ? f.byRound.filter(([r]) => Number(r) <= 3).reduce((s, [, n]) => s + n, 0) : 0;

  return (
    <div className="fdna-cards">
      <Card kind="strike" title="Striking DNA" lede="Output, accuracy, defense and where the significant strikes are aimed." href={href}>
        <Tiles items={v.striking} />
        {v.target.length > 0 && (
          <figure className="fdna-split">
            <figcaption>Significant strike targets</figcaption>
            <div className="bar" role="img" aria-label={v.target.map((t) => `${t.label} ${pct(t.value)}`).join(", ")}>{v.target.map((t, i) => <i key={t.key} className={`s${i}`} style={{ flexGrow: Math.max(t.value, 0.001) }} title={`${t.label}: ${pct(t.value)} of significant attempts`} />)}</div>
            <div className="keys">{v.target.map((t, i) => <span key={t.key}><i className={`s${i}`} />{t.label} <b>{pct(t.value)}</b></span>)}</div>
          </figure>
        )}
      </Card>

      <Card kind="grapple" title="Grappling DNA" lede="Takedown pressure, success rate, control and submission activity." href={href}>
        <Tiles items={v.grappling} />
        {v.stanceTd.length > 0 && (
          <figure className="fdna-cols">
            <figcaption>Takedowns landed / 15 min by opponent stance</figcaption>
            <div className="cols">
              {v.stanceTd.map((r) => {
                const val = r.tdLanded!.value as number;
                return (
                  <div key={r.stance} className={`col${lowSample(r.confidence) ? " faded" : ""}`} title={`vs ${stanceName(r.stance)}: ${val.toFixed(2)} takedowns landed per 15 min · ${r.statBouts} bout${r.statBouts === 1 ? "" : "s"} with stats · ${r.confidence} confidence`}>
                    <b>{val.toFixed(2)}</b>
                    <div className="track"><i style={{ height: `${Math.max((val / tdMax) * 100, 2)}%` }} /></div>
                    <span>{stanceName(r.stance)}</span>
                    <small>{r.statBouts} bout{r.statBouts === 1 ? "" : "s"}</small>
                  </div>
                );
              })}
            </div>
          </figure>
        )}
      </Card>

      <Card kind="round" title="Round DNA" lede="How output and damage taken change as the fight goes on." href={href}>
        <RoundChart rounds={v.rounds} />
        {v.roundDeltas.length > 0 && <Deltas items={v.roundDeltas} />}
        <p className="fdna-note">Rounds a fighter never reached are left out, never counted as zero. Faded bars rest on a small sample.</p>
      </Card>

      <Card kind="finish" title="Finish + stance DNA" lede="How the wins end, when finishes land, and results by opponent stance." href={href}>
        {f && (
          <>
            <div className="fdna-finish">
              <Donut parts={parts} center={pct(f.rate.value as number)} />
              <ul>{parts.map((p) => <li key={p.key}><i className={p.cls} />{p.label}<b>{p.value}</b><em>{pct(p.value / f.wins)}</em></li>)}</ul>
            </div>
            <ul className="fdna-deltas">
              {f.medianSeconds && <li><span>Median finish, elapsed</span><b>{fmtMetric(f.medianSeconds)}</b></li>}
              {finishes > 0 && <li><span>Finishes in R1–R3</span><b>{early} of {finishes}</b></li>}
            </ul>
          </>
        )}
        {v.stances.length > 0 && (
          <figure className="fdna-rings">
            <figcaption>Record by opponent stance</figcaption>
            <div className="rings">{v.stances.map((r) => <StanceRing key={r.stance} row={r} />)}</div>
          </figure>
        )}
      </Card>
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
              <span className="k">Featured Fight DNA</span>
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
.fdna-card{display:flex;flex-direction:column;gap:12px;min-width:0;padding:16px;border:1px solid var(--pbe-line);border-radius:14px;background:linear-gradient(180deg,rgba(255,245,220,.04),rgba(255,245,220,.012))}
.fdna-card header{display:flex;align-items:center;gap:10px}
.fdna-card .ic{flex:none;display:grid;place-items:center;width:30px;height:30px;border:1px solid rgba(212,175,55,.45);border-radius:8px;background:var(--pbe-gold-wash);color:var(--pbe-gold)}
.fdna-card h3{flex:1;min-width:0;color:var(--pbe-gold);font:800 12px/1.2 var(--pbe-font-data);letter-spacing:.11em;text-transform:uppercase}
.fdna-card .fv{margin-top:auto;align-self:flex-start;padding:8px 0 0;color:var(--pbe-gold);font:800 9.5px/1 var(--pbe-font-data);letter-spacing:.1em;text-transform:uppercase;text-decoration:none}
.fdna-card .fv:hover,.fdna-card .fv:focus-visible{color:var(--pbe-gold-bright);text-decoration:underline;text-underline-offset:3px}
.fdna-card .lede{color:var(--pbe-dim);font-size:13px;line-height:1.45}
.fdna-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
.fdna-tile{padding:10px;border:1px solid var(--pbe-line-faint);border-radius:9px;background:rgba(20,17,13,.45);min-width:0}
.fdna-tile b{display:block;color:var(--pbe-paper);font:800 19px/1 var(--pbe-font-data);white-space:nowrap}
.fdna-tile b small,.fdna-deltas b small{margin-left:2px;color:var(--pbe-faint);font-size:10px;font-weight:700}
.fdna-deltas{list-style:none;margin:0;padding:0;border-top:1px solid var(--pbe-line-faint)}
.fdna-deltas li{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:8px 0;border-bottom:1px solid var(--pbe-line-faint)}
.fdna-deltas span{color:var(--pbe-faint);font:700 9px/1.3 var(--pbe-font-data);letter-spacing:.07em;text-transform:uppercase}
.fdna-deltas b{flex:none;color:var(--pbe-paper);font:800 15px/1 var(--pbe-font-data);white-space:nowrap}
.fdna-deltas b.up{color:var(--pbe-gold-bright)}
.fdna-tile b.up{color:var(--pbe-gold-bright)}
.fdna-tile span{display:block;margin-top:6px;color:var(--pbe-faint);font:700 8.5px/1.3 var(--pbe-font-data);letter-spacing:.07em;text-transform:uppercase}
.fdna-card figure{margin:0}
.fdna-card figcaption{color:var(--pbe-paper-2);font:800 9px/1.3 var(--pbe-font-data);letter-spacing:.1em;text-transform:uppercase}
.fdna-split .bar{display:flex;gap:2px;height:12px;margin-top:9px;border-radius:4px;overflow:hidden}
.fdna-split .bar i{display:block;min-width:3px}
.fdna-split .s0{background:var(--pbe-gold)}.fdna-split .s1{background:rgba(212,175,55,.55)}.fdna-split .s2{background:rgba(212,175,55,.26)}
.fdna-split .keys{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px}
.fdna-split .keys span{display:inline-flex;align-items:center;gap:5px;color:var(--pbe-dim);font:700 10px/1 var(--pbe-font-data)}
.fdna-split .keys i{width:8px;height:8px;border-radius:2px}
.fdna-split .keys b{color:var(--pbe-paper)}
.fdna-cols .cols{display:flex;gap:10px;margin-top:10px;height:118px}
.fdna-cols .col{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
.fdna-cols .col b{color:var(--pbe-paper);font:800 11px/1 var(--pbe-font-data)}
.fdna-cols .track{flex:1;width:100%;max-width:44px;display:flex;align-items:flex-end;border-bottom:1px solid var(--pbe-line-strong)}
.fdna-cols .track i{display:block;width:100%;border-radius:4px 4px 0 0;background:linear-gradient(180deg,var(--pbe-gold-bright),rgba(212,175,55,.45))}
.fdna-cols .col span{color:var(--pbe-dim);font:700 9.5px/1 var(--pbe-font-data)}
.fdna-cols .col small{color:var(--pbe-faint);font:600 8.5px/1 var(--pbe-font-data)}
.fdna-cols .col.faded .track i{background:repeating-linear-gradient(135deg,rgba(212,175,55,.45) 0 3px,rgba(212,175,55,.15) 3px 6px)}
.fdna-legend{display:flex;flex-wrap:wrap;gap:4px 14px}
.fdna-legend span{display:inline-flex;align-items:center;gap:6px;color:var(--pbe-dim);font:700 9.5px/1 var(--pbe-font-data)}
.fdna-legend i{width:9px;height:9px;border-radius:2px}.fdna-legend i.gold{background:var(--pbe-gold)}.fdna-legend i.grey{background:#8f8778}
.fdna-roundchart svg{display:block;width:100%;height:auto;margin-top:6px;overflow:visible}
.fdna-roundchart .axis{stroke:var(--pbe-line-strong);stroke-width:1}
.fdna-roundchart .bar-gold{fill:var(--pbe-gold)}.fdna-roundchart .bar-grey{fill:#8f8778}
.fdna-roundchart .faded rect{opacity:.45}
.fdna-roundchart .val{fill:var(--pbe-paper);font:700 8.5px var(--pbe-font-data)}
.fdna-roundchart .lab{fill:var(--pbe-dim);font:700 8.5px var(--pbe-font-data)}
.fdna-roundchart .n{fill:var(--pbe-faint);font:600 7px var(--pbe-font-data)}
.fdna-note{color:var(--pbe-faint);font-size:11px;line-height:1.45}
.fdna-finish{display:grid;grid-template-columns:104px minmax(0,1fr);gap:14px;align-items:center}
.fdna-donut{width:104px;height:104px}
.fdna-donut circle{fill:none;stroke-width:11}
.fdna-donut .track{stroke:rgba(255,245,220,.07)}
.fdna-donut .seg-gold{stroke:var(--pbe-gold)}.fdna-donut .seg-crimson{stroke:var(--pbe-crimson)}.fdna-donut .seg-grey{stroke:#7e7a72}
.fdna-donut .c1{fill:var(--pbe-paper);font:800 19px var(--pbe-font-data)}
.fdna-donut .c2{fill:var(--pbe-faint);font:700 6.5px var(--pbe-font-data);letter-spacing:.1em}
.fdna-finish ul{list-style:none;margin:0;padding:0;display:grid;gap:7px;min-width:0}
.fdna-finish li{display:flex;align-items:center;gap:7px;color:var(--pbe-dim);font:700 11px/1 var(--pbe-font-data)}
.fdna-finish li i{flex:none;width:9px;height:9px;border-radius:50%}
.fdna-finish li i.seg-gold{background:var(--pbe-gold)}.fdna-finish li i.seg-crimson{background:var(--pbe-crimson)}.fdna-finish li i.seg-grey{background:#7e7a72}
.fdna-finish li b{margin-left:auto;color:var(--pbe-paper)}
.fdna-finish li em{width:34px;text-align:right;color:var(--pbe-faint);font-style:normal}
.fdna-rings .rings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:10px}
.fdna-ring{display:flex;flex-direction:column;align-items:center;gap:3px;text-align:center;min-width:0}
.fdna-ring svg{width:52px;height:52px}
.fdna-ring circle{fill:none;stroke-width:4}
.fdna-ring .track{stroke:rgba(255,245,220,.08)}.fdna-ring .arc{stroke:var(--pbe-gold);stroke-linecap:round}
.fdna-ring text{fill:var(--pbe-paper);font:800 9.5px var(--pbe-font-data)}
.fdna-ring b{color:var(--pbe-paper-2);font:700 10px/1.2 var(--pbe-font-data)}
.fdna-ring span{color:var(--pbe-faint);font:600 9.5px/1.2 var(--pbe-font-data)}
.fdna-ring.faded svg{opacity:.55}
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
@media(max-width:480px){.fdna{border-radius:16px}.fdna-photo{min-height:400px}.fdna-photo-copy{left:18px;right:18px;bottom:20px}.fdna-intro{padding:22px 18px}.fdna-intro h2{font-size:40px}.fdna-intro>p{font-size:14px}.fdna-cards{padding:12px}.fdna-pipe{grid-template-columns:1fr 1fr}.fdna-pipe li:after{display:none}.fdna-ctas .btn{flex:1 1 100%;justify-content:center;text-align:center}.fdna-finish{grid-template-columns:96px minmax(0,1fr)}.fdna-donut{width:96px;height:96px}}
`;
