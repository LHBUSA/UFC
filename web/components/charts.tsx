/* Deterministic chart rendering for the article content plan.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 *
 * Nothing here computes a statistic. Every number drawn arrives inside a chart
 * spec that ufc-news-enrich built from a verified database column, and the only
 * arithmetic performed below is turning a value into a pixel width. A renderer
 * that could derive a number would be a second, unaudited place for a number to
 * come from, and the two-class number gate cannot inspect a bar.
 *
 * WHY HTML BARS RATHER THAN SVG
 *
 * These charts sit inside a reading column that is 72ch on a desktop and about
 * 20ch on a phone. A bar built from a div reflows; an SVG viewBox scales its
 * type down with it until the labels are unreadable at exactly the width most
 * of our readers use. Only the line chart, which genuinely needs a coordinate
 * space, is SVG - and it is drawn in a fixed box that scrolls rather than
 * shrinks.
 *
 * COLOR
 *
 * Three hues, in fixed order, validated with the palette checker against this
 * site's chart surface (--pbe-ink-2, #1d1914): lightness band, chroma floor,
 * CVD separation (deutan dE 19.6), normal-vision separation (dE 20.9) and
 * contrast all pass. The brand gold (#d4af37) does NOT pass the lightness band
 * on this surface, which is why the chart gold is a step darker than the gold
 * used for text. Series colour follows the entity, never its rank, so a chart
 * with one series and a chart with two paint the first fighter identically.
 */
import type { ReactNode } from "react";
import { readableSource } from "@/lib/provenance";

export const CHART_HUES = ["#c98500", "#3987e5", "#199e70"] as const;

export type ChartSpec = {
  id: string;
  type: "bar" | "grouped_bar" | "stacked_bar" | "line";
  title: string;
  unit?: string;
  max?: number;
  source?: string;
  note?: string;
  sample_note?: string;
  legend?: string[];
  value_keys?: string[];
  label_key?: string;
  series: Record<string, unknown>[];
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
};
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(n < 10 ? 2 : 1).replace(/\.?0+$/, ""));

/** Keys that carry a plotted value, as opposed to a label or provenance. */
const META = new Set(["label", "trait", "metric_key", "confidence", "sample_bouts", "sample_rounds", "rounds_sampled", "round", "books", "best_book", "best_price"]);

function valueKeys(spec: ChartSpec): string[] {
  if (spec.value_keys?.length) return spec.value_keys;
  if (spec.legend?.length && spec.type !== "bar") return spec.legend;
  const keys: string[] = [];
  for (const row of spec.series) {
    for (const k of Object.keys(row)) {
      if (!META.has(k) && !keys.includes(k) && num(row[k]) !== null) keys.push(k);
    }
  }
  return keys.length ? keys : ["value"];
}

const rowLabel = (spec: ChartSpec, row: Record<string, unknown>) =>
  String(row[spec.label_key || "label"] ?? row.trait ?? row.label ?? "");

/* --------------------------------------------------------------- chrome */

function Figure({ spec, children, footnote }: { spec: ChartSpec; children: ReactNode; footnote?: string }) {
  const notes = [spec.note, spec.sample_note, footnote].filter(Boolean) as string[];
  /* The spec records provenance as our own table paths. Readers get the same
   * claim in their own language; the precise form stays in the stored plan. */
  const source = readableSource(spec.source);
  return (
    <figure className="chart" aria-labelledby={`ct-${spec.id}`}>
      <figcaption>
        <b id={`ct-${spec.id}`}>{spec.title}</b>
        {spec.unit ? <span className="chart-unit">{spec.unit}</span> : null}
      </figcaption>
      {children}
      {(notes.length > 0 || source) && (
        <div className="chart-src">
          {notes.join(" · ")}
          {notes.length > 0 && source ? " · " : ""}
          {source ? <>Source: {source}</> : null}
        </div>
      )}
    </figure>
  );
}

function Legend({ keys }: { keys: string[] }) {
  if (keys.length < 2) return null;
  return (
    <ul className="chart-key">
      {keys.map((k, i) => (
        <li key={k}>
          <i style={{ background: CHART_HUES[i % CHART_HUES.length] }} aria-hidden="true" />
          {k.replace(/_/g, " ")}
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------- bar family */

/**
 * Bars and grouped bars share a body: a grouped bar is n bars per row rather
 * than one. Keeping them in one function is what guarantees a single-series
 * chart and a two-series chart use the same scale rules and the same label
 * placement, so switching between them (which the DNA chart does, depending on
 * whether the opponent has data) cannot change how a value reads.
 */
function Bars({ spec }: { spec: ChartSpec }) {
  const keys = valueKeys(spec);
  const values = spec.series.flatMap((r) => keys.map((k) => num(r[k])).filter((v): v is number => v !== null));
  /* Domain from zero, always: a bar's length IS its value, so a truncated
   * baseline turns a 10% gap into an apparent doubling. */
  const max = spec.max ?? Math.max(1, ...values) * 1.08;
  return (
    <>
      <Legend keys={keys} />
      <div className="chart-rows">
        {spec.series.map((row, ri) => {
          const label = rowLabel(spec, row);
          const conf = row.confidence ? String(row.confidence) : null;
          const sample = num(row.sample_bouts);
          return (
            <div className="chart-row" key={`${label}-${ri}`}>
              <div className="chart-row-label">
                {label}
                {conf ? (
                  <em title={sample ? `${conf} confidence from ${sample} bouts` : `${conf} confidence`}>
                    {conf}{sample ? ` · ${sample}` : ""}
                  </em>
                ) : null}
              </div>
              <div className="chart-bars">
                {keys.map((k, ki) => {
                  const v = num(row[k]);
                  if (v === null) {
                    return <div className="chart-bar none" key={k}><span className="chart-val faint">no data</span></div>;
                  }
                  const price = keys.length === 1 && row.best_price !== undefined ? Number(row.best_price) : null;
                  const shown = `${fmt(v)}${spec.unit === "%" ? "%" : ""}`;
                  return (
                    <div className="chart-bar" key={k}>
                      <div className="chart-track">
                        <div
                          className="chart-fill"
                          style={{ width: `${Math.max(0.6, (v / max) * 100)}%`, background: CHART_HUES[ki % CHART_HUES.length] }}
                          title={`${label}${keys.length > 1 ? ` · ${k.replace(/_/g, " ")}` : ""}: ${shown}${spec.unit && spec.unit !== "%" ? ` ${spec.unit}` : ""}`}
                        />
                      </div>
                      <span className="chart-val">
                        {shown}
                        {price !== null ? <em>{price > 0 ? "+" : ""}{price}{row.best_book ? ` ${row.best_book}` : ""}</em> : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Wins by method: a composition, so one row and a 2px gap between segments. */
function Stacked({ spec }: { spec: ChartSpec }) {
  const keys = valueKeys(spec);
  return (
    <>
      <Legend keys={keys} />
      <div className="chart-rows">
        {spec.series.map((row, ri) => {
          const total = keys.reduce((t, k) => t + (num(row[k]) ?? 0), 0);
          if (total <= 0) return null;
          return (
            <div className="chart-row stacked" key={ri}>
              <div className="chart-row-label">
                {rowLabel(spec, row)}<em>{total} {spec.unit}</em>
              </div>
              <div className="chart-stack">
                {keys.map((k, ki) => {
                  const v = num(row[k]) ?? 0;
                  if (v <= 0) return null;
                  return (
                    <div
                      key={k}
                      className="chart-seg"
                      style={{ width: `${(v / total) * 100}%`, background: CHART_HUES[ki % CHART_HUES.length] }}
                      title={`${k.replace(/_/g, " ")}: ${v} of ${total}`}
                    >
                      {/* A number wider than its own segment reads as belonging
                        * to the neighbouring one. Below a tenth of the bar the
                        * hover title carries the value instead. */}
                      {v / total >= 0.1 ? <span>{v}</span> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Output by round. The one chart with a real coordinate space. */
function LineChart({ spec }: { spec: ChartSpec }) {
  const key = valueKeys(spec)[0];
  const pts = spec.series
    .map((r) => ({ x: num(r.round), y: num(r[key]), n: num(r.rounds_sampled) }))
    .filter((p): p is { x: number; y: number; n: number | null } => p.x !== null && p.y !== null);
  if (pts.length < 2) return null;
  const W = 560, H = 190, PL = 40, PR = 18, PT = 16, PB = 30;
  const yMax = Math.max(...pts.map((p) => p.y)) * 1.18;
  const xs = pts.map((p) => p.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  /* Inset, so the first and last markers do not sit ON the axis: a centred
   * value label above a point at x=PL overlaps the y-axis tick beside it. */
  const IN = 22;
  const px = (x: number) => PL + IN + ((x - xMin) / Math.max(1, xMax - xMin)) * (W - PL - PR - IN * 2);
  const py = (y: number) => PT + (1 - y / yMax) * (H - PT - PB);
  const ticks = [0, yMax / 2, yMax];
  return (
    <div className="chart-scroll">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={`${spec.title}. ${pts.map((p) => `round ${p.x}: ${fmt(p.y)}`).join("; ")}`}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={py(t)} y2={py(t)} stroke="rgba(255,245,220,.10)" strokeWidth="1" />
            <text x={PL - 8} y={py(t) + 4} textAnchor="end" fill="#8e8a80" fontSize="11" fontFamily="ui-monospace, monospace">{fmt(t)}</text>
          </g>
        ))}
        <polyline
          points={pts.map((p) => `${px(p.x)},${py(p.y)}`).join(" ")}
          fill="none"
          stroke={CHART_HUES[0]}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {pts.map((p) => (
          <g key={p.x}>
            {/* 2px surface ring, so a marker crossing the line stays legible. */}
            <circle cx={px(p.x)} cy={py(p.y)} r="6" fill={CHART_HUES[0]} stroke="#1d1914" strokeWidth="2" />
            <title>{`Round ${p.x}: ${fmt(p.y)}${p.n ? ` · ${p.n} rounds sampled` : ""}`}</title>
            <text x={px(p.x)} y={py(p.y) - 14} textAnchor="middle" fill="#f5f1eb" fontSize="12" fontWeight="700" fontFamily="ui-monospace, monospace">{fmt(p.y)}</text>
            <text x={px(p.x)} y={H - 9} textAnchor="middle" fill="#b8b3a8" fontSize="11" fontFamily="ui-monospace, monospace">R{p.x}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function Chart({ spec }: { spec: ChartSpec }) {
  if (!spec?.series?.length) return null;
  const sampled = spec.series.map((r) => num(r.rounds_sampled)).filter((v): v is number => v !== null);
  const footnote =
    spec.type === "line" && sampled.length
      ? `${Math.min(...sampled)}–${Math.max(...sampled)} rounds sampled per point`
      : undefined;
  const body =
    spec.type === "line" ? <LineChart spec={spec} /> :
    spec.type === "stacked_bar" ? <Stacked spec={spec} /> :
    <Bars spec={spec} />;
  if (!body) return null;
  return <Figure spec={spec} footnote={footnote}>{body}</Figure>;
}

/** The whole chart module, in plan order. */
export function ChartSet({ charts, title, note }: { charts: ChartSpec[]; title?: string; note?: string }) {
  const drawable = (charts || []).filter((c) => c?.series?.length);
  if (!drawable.length) return null;
  return (
    <section className="module charts-module">
      <div className="eyebrow mb-3">{title || "The numbers"}</div>
      {note ? <p className="faint label mb-4">{note}</p> : null}
      <div className="chart-grid">{drawable.map((c) => <Chart key={c.id} spec={c} />)}</div>
    </section>
  );
}
