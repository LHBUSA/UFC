/* Fight DNA visual layer — small, honest charts shared by the homepage public
 * demo and the full fighter profile. Every mark is a stored snapshot value fed
 * through lib/fightDnaDemoModel.ts (buildDemoView); nothing here computes a
 * metric. Missing rounds are absent, not zero; small samples are faded and say
 * so; every chart has a text equivalent (labels, legend, title tooltips). CSS
 * lives in app/fightdna.css under the dv- prefix. */
import Link from "next/link";
import type { MetricObject, RecordObj } from "@/lib/dna";
import { fmtMetric, STANCE_LABEL } from "@/lib/dna";
import type { RoundPoint, ShareBar, StanceRow, Tile } from "@/lib/fightDnaDemoModel";

const pct = (n: number) => `${Math.round(n * 100)}%`;
export const lowSample = (c: string) => c === "low" || c === "insufficient";
const stanceName = (k: string) => STANCE_LABEL[k] || k;

function signed(m: MetricObject): string {
  const v = m.value as number;
  const s = fmtMetric(m);
  return v > 0 ? `+${s}` : s;
}
const isRatioDelta = (t: Tile) => t.key.startsWith("pace_retention");
/* [number, unit] so the unit can sit small beside the figure and never truncate it. */
export function tileValue(t: Tile): [string, string] {
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

export function DnaTiles({ items }: { items: Tile[] }) {
  if (!items.length) return null;
  return <div className="dv-tiles">{items.map((t) => { const [n, u] = tileValue(t); return <div className="dv-tile" key={t.key}><b className={tileTone(t)}>{n}{u && <small>{u}</small>}</b><span>{t.label}</span></div>; })}</div>;
}

export function DnaDeltas({ items }: { items: Array<Tile | { key: string; label: string; text: string }> }) {
  if (!items.length) return null;
  return <ul className="dv-deltas">{items.map((t) => { if ("text" in t) return <li key={t.key}><span>{t.label}</span><b>{t.text}</b></li>; const [n, u] = tileValue(t); return <li key={t.key}><span>{t.label}</span><b className={tileTone(t)}>{n}{u && <small>{u}</small>}</b></li>; })}</ul>;
}

export type DnaKind = "strike" | "grapple" | "round" | "finish" | "stance" | "context";
function Icon({ kind }: { kind: DnaKind }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      {kind === "strike" && <><circle cx="12" cy="12" r="8" {...p} /><circle cx="12" cy="12" r="4" {...p} /><circle cx="12" cy="12" r=".9" fill="currentColor" /></>}
      {kind === "grapple" && <><path d="M7 15c-2-2-2-5 0-7s5-2 7 0" {...p} /><path d="M17 9c2 2 2 5 0 7s-5 2-7 0" {...p} /></>}
      {kind === "round" && <path d="M5 19v-7M10 19V7M15 19v-9M20 19V5" {...p} />}
      {kind === "finish" && <><circle cx="12" cy="12" r="8" {...p} /><path d="M12 4a8 8 0 0 1 8 8h-8z" fill="currentColor" opacity=".55" /></>}
      {kind === "stance" && <path d="M8 20l2-7-3-3 2-5M16 20l-2-7 3-3-2-5" {...p} />}
      {kind === "context" && <><rect x="4" y="5" width="16" height="14" rx="2" {...p} /><path d="M4 10h16M9 5v14" {...p} /></>}
    </svg>
  );
}

/* One DNA family card: icon, family name, a one-line lede, the content, an optional link. */
export function DnaCard({ kind, title, lede, href, linkLabel = "Full view →", wide = false, children }: { kind: DnaKind; title: string; lede: string; href?: string; linkLabel?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <article className={`dv-card${wide ? " wide" : ""}`}>
      <header><span className="ic"><Icon kind={kind} /></span><h4>{title}</h4></header>
      <p className="lede">{lede}</p>
      {children}
      {href && <Link href={href} className="fv">{linkLabel}</Link>}
    </article>
  );
}

/* Finish parts from the view, in fixed order, dropping any the snapshot does not carry. */
export function finishParts(f: { ko: number | null; sub: number | null; decision: number | null }): FinishPart[] {
  const all: Array<{ key: string; label: string; value: number | null; cls: FinishPart["cls"] }> = [
    { key: "ko", label: "KO/TKO", value: f.ko, cls: "seg-gold" },
    { key: "sub", label: "Submission", value: f.sub, cls: "seg-crimson" },
    { key: "dec", label: "Decision", value: f.decision, cls: "seg-grey" },
  ];
  return all.filter((p) => p.value != null).map((p) => ({ ...p, value: p.value as number }));
}

/* Landed vs absorbed significant strikes per minute, by round. */
export function RoundPaceChart({ rounds, compact = false }: { rounds: RoundPoint[]; compact?: boolean }) {
  if (!rounds.length) return null;
  const max = Math.max(...rounds.flatMap((r) => [r.landed, r.absorbed ?? 0]), 1);
  const W = 260, top = 16, base = compact ? 86 : 96, H = base + 22, gw = W / rounds.length, bw = Math.min(16, gw / 3.2);
  const y = (v: number) => base - (v / max) * (base - top);
  return (
    <figure className="dv-round">
      <div className="dv-legend"><span><i className="gold" />Sig. landed / min</span><span><i className="grey" />Absorbed / min</span></div>
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

/* A share split (targets or positions) as one segmented bar with a labelled key. */
export function SplitBar({ caption, items }: { caption: string; items: ShareBar[] }) {
  if (!items.length) return null;
  return (
    <figure className="dv-split">
      <figcaption>{caption}</figcaption>
      <div className="bar" role="img" aria-label={`${caption}: ${items.map((t) => `${t.label} ${pct(t.value)}`).join(", ")}`}>{items.map((t, i) => <i key={t.key} className={`s${i}`} style={{ flexGrow: Math.max(t.value, 0.001) }} title={`${t.label}: ${pct(t.value)}`} />)}</div>
      <div className="keys">{items.map((t, i) => <span key={t.key}><i className={`s${i}`} />{t.label} <b>{pct(t.value)}</b></span>)}</div>
    </figure>
  );
}

/* One stored per-15 rate per opponent stance, as columns. */
export function StanceColumns({ caption, rows }: { caption: string; rows: StanceRow[] }) {
  const shown = rows.filter((r) => r.tdLanded && r.statBouts > 0);
  if (!shown.length) return null;
  const max = Math.max(...shown.map((r) => r.tdLanded!.value as number), 0.01);
  return (
    <figure className="dv-cols">
      <figcaption>{caption}</figcaption>
      <div className="cols">
        {shown.map((r) => {
          const val = r.tdLanded!.value as number;
          return (
            <div key={r.stance} className={`col${lowSample(r.confidence) ? " faded" : ""}`} title={`vs ${stanceName(r.stance)}: ${val.toFixed(2)} per 15 min · ${r.statBouts} bout${r.statBouts === 1 ? "" : "s"} with stats · ${r.confidence} confidence`}>
              <b>{val.toFixed(2)}</b>
              <div className="track"><i style={{ height: `${Math.max((val / max) * 100, 2)}%` }} /></div>
              <span>{stanceName(r.stance)}</span>
              <small>{r.statBouts} bout{r.statBouts === 1 ? "" : "s"}</small>
            </div>
          );
        })}
      </div>
    </figure>
  );
}

export type FinishPart = { key: string; label: string; value: number; cls: "seg-gold" | "seg-crimson" | "seg-grey" };

/* How the wins ended: finish rate in the middle, the split around it, a legend with counts. */
export function FinishDonut({ parts, rate, wins }: { parts: FinishPart[]; rate: number; wins: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  const R = 40, C = 2 * Math.PI * R, gap = shown.length > 1 ? 2 : 0;
  let off = 0;
  return (
    <div className="dv-finish">
      <svg className="dv-donut" viewBox="0 0 104 104" role="img" aria-label={`Finish rate ${pct(rate)}; ${parts.map((p) => `${p.label} ${p.value}`).join(", ")} of ${wins} wins`}>
        <circle cx="52" cy="52" r={R} className="track" />
        {total > 0 && shown.map((p) => {
          const len = (p.value / total) * C;
          const el = <circle key={p.key} cx="52" cy="52" r={R} className={p.cls} strokeDasharray={`${Math.max(len - gap, 0.5)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 52 52)"><title>{`${p.label}: ${p.value} win${p.value === 1 ? "" : "s"}`}</title></circle>;
          off += len;
          return el;
        })}
        <text x="52" y="54" textAnchor="middle" className="c1">{pct(rate)}</text>
        <text x="52" y="66" textAnchor="middle" className="c2">FINISH RATE</text>
      </svg>
      <ul>{parts.map((p) => <li key={p.key}><i className={p.cls} />{p.label}<b>{p.value}</b><em>{pct(wins ? p.value / wins : 0)}</em></li>)}</ul>
    </div>
  );
}

/* Counts per round (finish wins, or losses by stoppage), stored buckets only. */
export function RoundCounts({ caption, buckets, tone = "gold" }: { caption: string; buckets: Array<[string, number]>; tone?: "gold" | "crimson" }) {
  const total = buckets.reduce((s, [, n]) => s + n, 0);
  if (!buckets.length || !total) return null;
  const max = Math.max(...buckets.map(([, n]) => n), 1);
  return (
    <figure className={`dv-counts ${tone}`}>
      <figcaption>{caption} <small>{total} total</small></figcaption>
      <div className="cols">{buckets.map(([r, n]) => <div key={r} className="col" title={`Round ${r}: ${n}`}><b>{n}</b><div className="track"><i style={{ height: `${n ? Math.max((n / max) * 100, 6) : 0}%` }} /></div><span>R{r}</span></div>)}</div>
    </figure>
  );
}

/* Win share by opponent stance as rings; fewer than three appearances is faded and labelled. */
export function StanceRings({ caption, rows }: { caption: string; rows: StanceRow[] }) {
  if (!rows.length) return null;
  return (
    <figure className="dv-rings">
      <figcaption>{caption}</figcaption>
      <div className="rings">{rows.map((row) => <Ring key={row.stance} stance={row.stance} r={row.record} />)}</div>
    </figure>
  );
}

function Ring({ stance, r }: { stance: string; r: RecordObj }) {
  const n = r.w + r.l + r.d, apps = r.appearances ?? n;
  const share = n > 0 ? r.w / n : 0;
  const R = 17, C = 2 * Math.PI * R, small = apps < 3;
  return (
    <div className={`ring${small ? " faded" : ""}`} title={`vs ${stanceName(stance)}: ${r.w}-${r.l}-${r.d} across ${apps} archived appearance${apps === 1 ? "" : "s"}`}>
      <svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r={R} className="track" />{n > 0 && r.w > 0 && <circle cx="22" cy="22" r={R} className="arc" strokeDasharray={`${share * C} ${C}`} transform="rotate(-90 22 22)" />}<text x="22" y="25.5" textAnchor="middle">{pct(share)}</text></svg>
      <b>vs {stanceName(stance)}</b>
      <span>{r.w}-{r.l}{r.d ? `-${r.d}` : ""}{small ? " · small sample" : ""}</span>
    </div>
  );
}

/* Two fighters' significant strikes landed per minute, round by round. Only rounds
 * at least one of them reached are drawn; a fighter with no stored value for a round
 * has no bar there (not a zero). */
export function PairedRoundChart({ a, b }: { a: { name: string; rounds: RoundPoint[] }; b: { name: string; rounds: RoundPoint[] } }) {
  const keys = ["1", "2", "3", "4", "5"].filter((k) => a.rounds.some((r) => r.round === k) || b.rounds.some((r) => r.round === k));
  if (!keys.length || !a.rounds.length || !b.rounds.length) return null;
  const get = (rs: RoundPoint[], k: string) => rs.find((r) => r.round === k) || null;
  const max = Math.max(...[...a.rounds, ...b.rounds].map((r) => r.landed), 1);
  const W = 300, top = 16, base = 96, H = base + 14, gw = W / keys.length, bw = Math.min(18, gw / 3.2);
  const y = (val: number) => base - (val / max) * (base - top);
  const last = (n: string) => n.split(" ").slice(-1)[0];
  return (
    <figure className="dv-round dv-paired">
      <div className="dv-legend"><span><i className="gold" />{a.name}</span><span><i className="red" />{b.name}</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Significant strikes landed per minute by round: ${a.name} and ${b.name}`}>
        <line x1="0" x2={W} y1={base + .5} y2={base + .5} className="axis" />
        {keys.map((k, i) => {
          const cx = gw * i + gw / 2, ra = get(a.rounds, k), rb = get(b.rounds, k);
          return (
            <g key={k}>
              <title>{`Round ${k}: ${ra ? `${last(a.name)} ${ra.landed.toFixed(2)}/min (${ra.rounds ?? "?"} rds, ${ra.confidence})` : `${last(a.name)} no rounds`} · ${rb ? `${last(b.name)} ${rb.landed.toFixed(2)}/min (${rb.rounds ?? "?"} rds, ${rb.confidence})` : `${last(b.name)} no rounds`}`}</title>
              {ra && <g className={lowSample(ra.confidence) ? "faded" : undefined}><rect x={cx - bw - 1} y={y(ra.landed)} width={bw} height={base - y(ra.landed)} rx="3" className="bar-gold" /><text x={cx - bw / 2 - 1} y={y(ra.landed) - 4} textAnchor="middle" className="val">{ra.landed.toFixed(1)}</text></g>}
              {rb && <g className={lowSample(rb.confidence) ? "faded" : undefined}><rect x={cx + 1} y={y(rb.landed)} width={bw} height={base - y(rb.landed)} rx="3" className="bar-red" /><text x={cx + bw / 2 + 1} y={y(rb.landed) - 4} textAnchor="middle" className="val">{rb.landed.toFixed(1)}</text></g>}
              <text x={cx} y={base + 12} textAnchor="middle" className="lab">R{k}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
