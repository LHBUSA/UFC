/* Renders the deterministic content plan that ufc-news-enrich stores on every
 * article as fact_block.content_plan.
 *
 * THE DIVISION OF LABOUR
 *
 * Sol writes the prose and decides nothing else. The enrich Worker decides which
 * modules an article has earned, reading its own first-party tables, and records
 * every module it left out together with the reason. This file draws what the
 * plan contains and NEVER supplies a fallback: if the plan omitted the market
 * module because no bout was linked, the article has no market module, and the
 * omission is shown to the reader rather than papered over. An empty section
 * headed "Fight DNA" is worse than no section, because it teaches the reader
 * that our headings mean nothing.
 *
 * WHY MODULES ARE LOOKED UP BY ID RATHER THAN MAPPED IN ORDER
 *
 * The plan's own order is a build order, not a reading order. A reader wants the
 * booking before the styles and the market after the analysis; the builder emits
 * whatever it could prove, in the order it proved it. So the page asks for the
 * modules it wants where it wants them, and a module the plan did not produce
 * simply returns null.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Chart, ChartSet, type ChartSpec } from "@/components/charts";
import { fmtDate } from "@/lib/format";
import { readableFamilies, familiesSentence } from "@/lib/provenance";
import { renderMarkdownBlocks } from "@/lib/markdown";
import { OfficialVideo } from "@/components/OfficialVideo";
import { renderablePlanVideos, type PlanVideo, type RenderablePlanVideo } from "@/lib/videoPolicy";

export type PlanModule = { id: string; title?: string; note?: string; data: unknown };
export type ContentPlan = {
  version?: string;
  modules?: PlanModule[];
  module_ids?: string[];
  omitted?: { id: string; reason: string }[];
  chart_count?: number;
  video_tier?: number | null;
  generated_at?: string;
};

/** Typed accessor. A module that is absent is absent — there is no default. */
export function moduleOf<T = any>(plan: ContentPlan | null | undefined, id: string): { title?: string; note?: string; data: T } | null {
  const m = (plan?.modules || []).find((x) => x.id === id);
  return m ? { title: m.title, note: m.note, data: m.data as T } : null;
}

export function chartsOf(plan: ContentPlan | null | undefined): ChartSpec[] {
  const m = moduleOf<ChartSpec[]>(plan, "charts");
  return Array.isArray(m?.data) ? m!.data : [];
}
export const chartById = (charts: ChartSpec[], id: string) => charts.find((c) => c.id === id) || null;

/* ---------------------------------------------------------------- shell */

function Module({ eyebrow, title, note, children, className = "" }: { eyebrow: string; title?: string; note?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`module ${className}`.trim()}>
      <div className="module-head">
        <div className="eyebrow">{eyebrow}</div>
        {title ? <h2 className="module-title">{title}</h2> : null}
      </div>
      {note ? <p className="module-note">{note}</p> : null}
      {children}
    </section>
  );
}

const pctOf = (v: unknown) => (v === null || v === undefined ? "—" : `${Math.round(Number(v) * 100)}%`);
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/* ------------------------------------------------------------- modules */

type BoutContext = {
  event?: { id?: string; name?: string; date?: string; venue?: string; city?: string; country?: string };
  status?: string; is_title?: boolean; opponent?: string;
  weight_class?: string; card_position?: string; scheduled_rounds?: number;
};

export function BoutContextModule({ plan, eventHref }: { plan: ContentPlan | null; eventHref?: string | null }) {
  const m = moduleOf<BoutContext>(plan, "bout_context");
  if (!m?.data?.event) return null;
  const d = m.data;
  const place = [d.event?.venue, [d.event?.city, d.event?.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  const facts: [string, ReactNode][] = [
    ["Event", eventHref ? <Link href={eventHref}>{d.event?.name}</Link> : d.event?.name],
    ["Date", d.event?.date ? fmtDate(d.event.date) : null],
    ["Where", place || null],
    ["Weight class", d.weight_class ? titleCase(d.weight_class.toLowerCase()) : null],
    ["Position", d.card_position ? `${titleCase(d.card_position)}${d.scheduled_rounds ? ` · ${d.scheduled_rounds} rounds` : ""}` : null],
    ["Status", d.status ? titleCase(d.status) : null],
  ];
  return (
    <Module eyebrow="The booking" title={m.title === "The booking" ? undefined : m.title} className="booking">
      <dl className="facts">
        {facts.filter(([, v]) => v).map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
        {d.is_title ? <div><dt>Title</dt><dd className="gold">Championship bout</dd></div> : null}
      </dl>
    </Module>
  );
}

type Side = {
  name: string; age?: number | null; record?: string; stance?: string; reach_in?: number | null;
  career?: Record<string, number | null>;
};
const CAREER_ROWS: [string, string, string][] = [
  ["sig_strikes_landed_per_min", "Strikes landed", "per min"],
  ["sig_strikes_absorbed_per_min", "Strikes absorbed", "per min"],
  ["sig_strike_accuracy_pct", "Striking accuracy", "%"],
  ["striking_defence_pct", "Striking defence", "%"],
  ["takedowns_per_15min", "Takedowns", "per 15 min"],
  ["takedown_accuracy_pct", "Takedown accuracy", "%"],
  ["takedown_defence_pct", "Takedown defence", "%"],
  ["submission_attempts_per_15min", "Submission attempts", "per 15 min"],
];

/**
 * Side by side, with the better number in each row marked.
 *
 * "Better" is not a judgement the renderer makes up: for absorbed strikes lower
 * wins and for everything else higher wins, which is a property of the metric
 * and is declared right here rather than inferred.
 */
export function ComparisonModule({ plan, charts }: { plan: ContentPlan | null; charts: ChartSpec[] }) {
  const m = moduleOf<{ a: Side; b: Side; edges?: Record<string, unknown>[] }>(plan, "fighter_comparison");
  if (!m?.data?.a || !m?.data?.b) return null;
  const { a, b, edges } = m.data;
  const LOWER_WINS = new Set(["sig_strikes_absorbed_per_min"]);
  /* These three charts plot the same career columns the table above lists, so
   * they sit with it. A chart parked in a generic gallery at the foot of the
   * page makes the reader carry the table in their head to interpret it. */
  const own = ["striking_exchange", "grappling_volume", "grappling_rates"]
    .map((id) => chartById(charts, id))
    .filter((c): c is ChartSpec => Boolean(c));
  return (
    <Module eyebrow="Head to head" title={m.title} className="cmp">
      <table className="cmp-table">
        <caption className="sr-only">{a.name} compared with {b.name}, career averages</caption>
        <thead>
          <tr><th scope="col" className="cmp-a">{a.name}</th><th scope="col" className="cmp-mid"> </th><th scope="col" className="cmp-b">{b.name}</th></tr>
        </thead>
        <tbody>
          <tr className="cmp-meta">
            <td>{a.record}</td><th scope="row">Record</th><td>{b.record}</td>
          </tr>
          {(a.age || b.age) ? <tr className="cmp-meta"><td>{a.age ?? "—"}</td><th scope="row">Age</th><td>{b.age ?? "—"}</td></tr> : null}
          {(a.reach_in || b.reach_in) ? <tr className="cmp-meta"><td>{a.reach_in ? `${a.reach_in}"` : "—"}</td><th scope="row">Reach</th><td>{b.reach_in ? `${b.reach_in}"` : "—"}</td></tr> : null}
          {(a.stance || b.stance) ? <tr className="cmp-meta"><td>{a.stance ? titleCase(a.stance.toLowerCase()) : "—"}</td><th scope="row">Stance</th><td>{b.stance ? titleCase(b.stance.toLowerCase()) : "—"}</td></tr> : null}
          {CAREER_ROWS.map(([key, label, unit]) => {
            const va = a.career?.[key], vb = b.career?.[key];
            if (va === undefined && vb === undefined) return null;
            const na = va === null || va === undefined ? null : Number(va);
            const nb = vb === null || vb === undefined ? null : Number(vb);
            let aWins = false, bWins = false;
            if (na !== null && nb !== null && na !== nb) {
              const aBetter = LOWER_WINS.has(key) ? na < nb : na > nb;
              aWins = aBetter; bWins = !aBetter;
            }
            return (
              <tr key={key}>
                <td className={aWins ? "win" : ""}>{na ?? "—"}</td>
                <th scope="row">{label}<em>{unit}</em></th>
                <td className={bWins ? "win" : ""}>{nb ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {edges && edges.length > 0 && (
        <ul className="edges">
          {edges.map((e, i) => {
            const gap = e.gap_inches ?? e.gap_per_min ?? e.gap_points ?? e.gap;
            const unit = e.gap_inches !== undefined ? '"' : e.gap_per_min !== undefined ? " / min" : e.gap_points !== undefined ? " pts" : "";
            return (
              <li key={i}>
                <span className="k">{titleCase(String(e.metric))}</span>
                <b>{String(e.favours)}</b>
                {gap !== undefined && gap !== null ? <em>by {String(gap)}{unit}</em> : null}
              </li>
            );
          })}
        </ul>
      )}
      {own.length > 0 && <div className="chart-grid mt-5">{own.map((c) => <Chart key={c.id} spec={c} />)}</div>}
      <p className="module-src">Career averages from PropBetEdge fighter profiles. The marked side leads that row; for strikes absorbed the lower number leads.</p>
    </Module>
  );
}

type FighterCard = {
  name: string; nickname?: string | null; age?: number | null; height?: string | null;
  reach_in?: number | null; weight_lbs?: number | null; stance?: string | null;
  record?: string | null; rankings?: { division?: string; rank?: number | string }[] | null;
};

/** The subject, stated once. Carries a story that has no second fighter. */
export function FighterCardModule({ plan, href, portrait }: { plan: ContentPlan | null; href?: string | null; portrait?: string | null }) {
  const m = moduleOf<FighterCard>(plan, "fighter_card");
  if (!m?.data?.name) return null;
  const d = m.data;
  const facts: [string, string][] = ([
    ["Record", d.record || ""],
    ["Age", d.age ? String(d.age) : ""],
    ["Height", d.height || ""],
    ["Reach", d.reach_in ? `${d.reach_in}"` : ""],
    ["Weight", d.weight_lbs ? `${d.weight_lbs} lb` : ""],
    ["Stance", d.stance ? titleCase(d.stance.toLowerCase()) : ""],
  ] as [string, string][]).filter(([, v]) => v);
  return (
    <Module eyebrow="The subject" className="fcard">
      <div className="fcard-body">
        {portrait ? <img className="fcard-img" src={portrait} alt="" aria-hidden="true" width={112} height={140} loading="lazy" decoding="async" /> : null}
        <div className="fcard-main">
          <div className="fcard-name">
            {href ? <Link href={href}>{d.name}</Link> : d.name}
            {d.nickname ? <em>&ldquo;{d.nickname}&rdquo;</em> : null}
          </div>
          {d.rankings && d.rankings.length > 0 ? (
            <div className="chips mb-2">
              {d.rankings.map((r, i) => (
                <span key={i} className="tag gold">
                  {String(r.rank) === "champion" ? "Champion" : `#${r.rank}`}
                  {r.division ? ` ${titleCase(String(r.division).toLowerCase())}` : ""}
                </span>
              ))}
            </div>
          ) : null}
          <dl className="facts inline">
            {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        </div>
      </div>
    </Module>
  );
}

/**
 * The plan's bettor_angle uses supporting/against/unknown; the site's existing
 * Bettor's Edge component predates it and speaks supporting_facts/risks/
 * watch_items. Translating here rather than renaming either side keeps one
 * visual treatment across old and new articles, which matters more than
 * matching field names nobody sees.
 */
export function planAngle(plan: ContentPlan | null) {
  const m = moduleOf<any>(plan, "bettors_edge");
  if (!m?.data) return null;
  const d = m.data;
  return {
    summary: d.summary,
    markets: d.markets,
    supporting_facts: d.supporting,
    risks: d.against,
    watch_items: d.unknown,
    odds_status: d.odds_status,
    model_status: d.model_status,
    impact_score: d.impact_score,
    durable: d.durable,
  };
}

type Trait = { key: string; unit?: string; value: number; confidence?: string; sample_bouts?: number; sample_rounds?: number };
type Dna = { as_of?: string; traits?: Record<string, Trait>; coverage?: string; archetype?: string | null; sample_bouts?: number; sample_rounds?: number; definition_version?: number | string };

const DNA_ORDER: [string, string][] = [
  ["sig_accuracy", "Striking accuracy"],
  ["sig_defense", "Striking defence"],
  ["knockdowns_per_15", "Knockdowns / 15 min"],
  ["td_landed_per_15", "Takedowns / 15 min"],
  ["td_accuracy", "Takedown accuracy"],
  ["control_share", "Control share"],
  ["finish_rate", "Finish rate"],
  ["ko_finish_rate", "KO / TKO finish rate"],
  ["submission_finish_rate", "Submission finish rate"],
];

export function DnaModule({ plan, charts }: { plan: ContentPlan | null; charts: ChartSpec[] }) {
  const m = moduleOf<Dna>(plan, "fight_dna");
  if (!m?.data?.traits) return null;
  const d = m.data;
  const rows = DNA_ORDER.map(([k, label]) => [label, d.traits?.[k]] as const).filter(([, t]) => t && Number.isFinite(Number(t.value)));
  if (!rows.length) return null;
  const traitChart = chartById(charts, "dna_traits");
  const paceChart = chartById(charts, "round_pace");
  return (
    <Module eyebrow="Fight DNA" title={m.title === "Fight DNA" ? undefined : m.title} className="dna">
      <div className="dna-meta">
        {d.archetype ? <span className="tag gold">{titleCase(d.archetype)}</span> : null}
        <span className="tag">{d.sample_bouts ?? "?"} bouts · {d.sample_rounds ?? "?"} rounds</span>
        <span className={`tag${d.coverage === "low" ? " warn" : ""}`}>Coverage · {d.coverage || "unknown"}</span>
        {d.as_of ? <span className="faint label">as of {fmtDate(d.as_of)} · definition v{d.definition_version}</span> : null}
      </div>
      <ul className="dna-grid">
        {rows.map(([label, t]) => (
          <li key={t!.key}>
            <span className="k">{label}</span>
            <b>{t!.unit === "ratio" ? pctOf(t!.value) : Number(t!.value).toFixed(2)}</b>
            <em title={`${t!.confidence} confidence from ${t!.sample_bouts} bouts`}>{t!.confidence}</em>
          </li>
        ))}
      </ul>
      {(traitChart || paceChart) && (
        <div className="chart-grid mt-5">
          {traitChart ? <Chart spec={traitChart} /> : null}
          {paceChart ? <Chart spec={paceChart} /> : null}
        </div>
      )}
      <p className="module-src">
        Each metric is measured from PropBetEdge's own round-by-round archive and carries its own confidence and sample size.
        Low coverage means the archive holds fewer bouts than the metric wants — it is published with that caveat rather than withheld or inflated.
      </p>
    </Module>
  );
}

type FormBout = { date?: string; event?: string; round?: number; method?: string; result?: string; is_title?: boolean; opponent?: string };
type Form = { last_five?: FormBout[]; opponent_last_five?: FormBout[]; sample_note?: string; archive_bouts?: number; days_since_last_bout?: number; finish_rate_on_wins_pct?: number };

const METHOD_LABEL: Record<string, string> = { KO_TKO: "KO/TKO", SUB: "Submission", DEC_U: "Decision (U)", DEC_S: "Decision (S)", DEC_M: "Decision (M)", DQ: "DQ", NC: "No contest", DRAW: "Draw" };

function FormList({ bouts, name }: { bouts: FormBout[]; name?: string }) {
  return (
    <div className="form-col">
      {name ? <div className="k">{name}</div> : null}
      <ol className="form-list">
        {bouts.map((b, i) => (
          <li key={i} className={b.result === "W" ? "w" : b.result === "L" ? "l" : ""}>
            <span className="res" aria-label={b.result === "W" ? "Win" : b.result === "L" ? "Loss" : "Result"}>{b.result}</span>
            <span className="who">{b.opponent}{b.is_title ? <em className="gold"> title</em> : null}</span>
            <span className="how">{METHOD_LABEL[String(b.method)] || b.method}{b.round ? ` · R${b.round}` : ""}</span>
            <span className="when">{b.date ? fmtDate(b.date) : ""}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function RecentFormModule({ plan, charts, names }: { plan: ContentPlan | null; charts: ChartSpec[]; names?: { a?: string; b?: string } }) {
  const m = moduleOf<Form>(plan, "recent_form");
  const bouts = m?.data?.last_five || [];
  if (!bouts.length) return null;
  const d = m!.data;
  const finishChart = chartById(charts, "finish_history");
  const opp = d.opponent_last_five || [];
  return (
    <Module eyebrow="Recent form" title={m!.title === "Recent form" ? undefined : m!.title} className="form">
      <div className="form-cols">
        <FormList bouts={bouts} name={opp.length ? names?.a : undefined} />
        {opp.length ? <FormList bouts={opp} name={names?.b} /> : null}
      </div>
      <div className="form-meta">
        {typeof d.days_since_last_bout === "number" ? <span className="tag">{d.days_since_last_bout} days since last bout</span> : null}
        {typeof d.finish_rate_on_wins_pct === "number" ? <span className="tag">{d.finish_rate_on_wins_pct}% of wins by finish</span> : null}
        {d.archive_bouts ? <span className="faint label">{d.archive_bouts} bouts in our archive{d.sample_note ? ` · ${d.sample_note}` : ""}</span> : null}
      </div>
      {finishChart ? <div className="chart-grid mt-5"><Chart spec={finishChart} /></div> : null}
    </Module>
  );
}

type RoundStats = {
  rounds?: number; knockdowns?: number; control_minutes?: number; takedowns_landed?: number;
  sig_strikes_landed?: number; submission_attempts?: number; bouts_with_round_data?: number;
  takedown_accuracy_pct?: number; sig_strike_accuracy_pct?: number;
  target_split?: { head?: number; body?: number; leg?: number };
  opponent?: RoundStats;
};

const STAT_ROWS: [keyof RoundStats, string][] = [
  ["sig_strikes_landed", "Significant strikes landed"],
  ["sig_strike_accuracy_pct", "Striking accuracy %"],
  ["knockdowns", "Knockdowns"],
  ["takedowns_landed", "Takedowns landed"],
  ["takedown_accuracy_pct", "Takedown accuracy %"],
  ["control_minutes", "Control minutes"],
  ["submission_attempts", "Submission attempts"],
];

/** Where the strikes actually land. A composition, so it is a share bar. */
function TargetSplit({ split, name }: { split: { head?: number; body?: number; leg?: number }; name: string }) {
  const parts: [string, number][] = [["head", split.head || 0], ["body", split.body || 0], ["leg", split.leg || 0]];
  const total = parts.reduce((t, [, v]) => t + v, 0);
  if (total <= 0) return null;
  const HUES = ["#c98500", "#3987e5", "#199e70"];
  return (
    <div className="split">
      <div className="k">{name} · target distribution<em>{total} strikes</em></div>
      <div className="split-bar">
        {parts.map(([k, v], i) => v > 0 ? (
          <div key={k} style={{ width: `${(v / total) * 100}%`, background: HUES[i] }} title={`${k}: ${v} of ${total}`}>
            {v / total >= 0.1 ? <span>{Math.round((v / total) * 100)}%</span> : null}
          </div>
        ) : null)}
      </div>
      <ul className="split-key">
        {parts.map(([k, v], i) => (
          <li key={k}><i style={{ background: HUES[i] }} aria-hidden="true" />{k} <b>{v}</b></li>
        ))}
      </ul>
    </div>
  );
}

export function RoundStyleModule({ plan, names }: { plan: ContentPlan | null; names?: { a?: string; b?: string } }) {
  const m = moduleOf<RoundStats>(plan, "round_style_stats");
  if (!m?.data) return null;
  const d = m.data;
  const o = d.opponent;
  /* The distinction between archive totals and career averages is only worth
   * drawing when the reader has just seen the averages. On a story with no
   * booked opponent there is no comparison table, and pointing at one that is
   * not on the page is the kind of small false statement that costs more trust
   * than the sentence was ever going to earn. */
  const hasComparison = Boolean(moduleOf(plan, "fighter_comparison"));
  return (
    <Module eyebrow="Round and style data" title={m.title === "Round and style data" ? undefined : m.title} className="rounds">
      <p className="module-note">
        Totals from PropBetEdge's round-by-round archive — {d.bouts_with_round_data ?? "?"} bouts, {d.rounds ?? "?"} rounds
        {o ? ` for ${names?.a || "the subject"}, and ${o.bouts_with_round_data ?? "?"} bouts, ${o.rounds ?? "?"} rounds for ${names?.b || "the opponent"}` : ""}.
        {hasComparison
          ? " These are archive totals, not career averages, so they answer a different question from the comparison table above."
          : " These are totals from the bouts we hold complete round data for, not career averages."}
      </p>
      <table className="cmp-table tight">
        <thead>
          <tr><th scope="col" className="cmp-a">{names?.a || "Subject"}</th><th scope="col" className="cmp-mid"> </th>{o ? <th scope="col" className="cmp-b">{names?.b || "Opponent"}</th> : null}</tr>
        </thead>
        <tbody>
          {STAT_ROWS.map(([key, label]) => {
            const va = d[key] as number | undefined;
            const vb = o?.[key] as number | undefined;
            if (va === undefined && vb === undefined) return null;
            return (
              <tr key={String(key)}>
                <td>{va ?? "—"}</td>
                <th scope="row">{label}</th>
                {o ? <td>{vb ?? "—"}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="splits">
        {d.target_split ? <TargetSplit split={d.target_split} name={names?.a || "Subject"} /> : null}
        {o?.target_split ? <TargetSplit split={o.target_split} name={names?.b || "Opponent"} /> : null}
      </div>
    </Module>
  );
}

type Price = { book: string; price: number; market: string; outcome: string; point?: number | null };
type Market = { books?: string[]; prices?: Price[]; observed_at?: string };

export function MarketModule({ plan, charts }: { plan: ContentPlan | null; charts: ChartSpec[] }) {
  const m = moduleOf<Market>(plan, "market_snapshot");
  const prices = (m?.data?.prices || []).filter((p) => p.market === "h2h");
  if (!prices.length) return null;
  const outcomes = [...new Set(prices.map((p) => p.outcome))];
  const books = [...new Set(prices.map((p) => p.book))];
  const chart = chartById(charts, "market_implied");
  /* Best price per outcome: highest number for a plus price, closest to zero for
   * a minus price — which is the same comparison, since American odds are
   * already ordered that way on the number line. */
  const best = new Map(outcomes.map((o) => [o, Math.max(...prices.filter((p) => p.outcome === o).map((p) => p.price))]));
  return (
    <Module eyebrow="Market" title={m!.title === "Market" ? undefined : m!.title} className="mkt">
      {chart ? <div className="chart-grid"><Chart spec={chart} /></div> : null}
      <div className="tbl-wrap">
        <table className="tbl odds">
          <caption className="sr-only">Moneyline prices by sportsbook</caption>
          <thead>
            <tr><th scope="col">Book</th>{outcomes.map((o) => <th key={o} scope="col">{o}</th>)}</tr>
          </thead>
          <tbody>
            {books.map((b) => (
              <tr key={b}>
                <th scope="row">{b}</th>
                {outcomes.map((o) => {
                  const p = prices.find((x) => x.book === b && x.outcome === o);
                  const isBest = p && best.get(o) === p.price;
                  return <td key={o} className={`mono${isBest ? " best" : ""}`}>{p ? signed(p.price) : "—"}{isBest ? <em title="Best available price">best</em> : null}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="module-src">
        {prices.length} moneyline prices across {books.length} books{m!.data.observed_at ? `, observed ${fmtDate(m!.data.observed_at)}` : ""}.
        Prices move; this is the snapshot the analysis above was written against, not a live feed.
      </p>
    </Module>
  );
}

const TIER_WHY: Record<number, string> = {
  1: "matched to this exact story",
  2: "matched to this exact bout and this fighter",
  3: "matched to this event and this fighter",
  4: "an official video featuring this fighter",
};

/* The plan's clips play through the same hardened player as every rail
 * (components/OfficialVideo): poster first, and a removed, private,
 * embed-refused or region-blocked video falls back to its poster with a
 * Watch-on-YouTube link instead of a dead YouTube box. Videos the policy
 * already knows cannot play here are never handed to the player at all
 * (lib/videoPolicy renderablePlanVideos). `videos` is that filtered list,
 * computed once by StoryView so the JSON-LD describes the same set. */
export function OfficialVideoModule({ plan, videos }: { plan: ContentPlan | null; videos?: RenderablePlanVideo[] }) {
  const m = moduleOf<{ tier?: number; videos?: PlanVideo[] }>(plan, "official_video");
  if (!m) return null;
  const list = videos ?? renderablePlanVideos(m.data?.videos || []);
  if (!list.length) return null;
  const tier = m.data.tier;
  return (
    <Module eyebrow="Official video" title={m.title === "Official video" ? undefined : m.title} className="vid">
      <p className="module-note">
        {tier && TIER_WHY[tier] ? `Every clip here is ${TIER_WHY[tier]}. ` : ""}
        Published by the UFC's own channels and played from them — we do not host, re-upload or re-encode it.
      </p>
      <div className="vid-grid">
        {list.map((v) => (
          <div key={v.id} className="vid-item" data-video-id={v.video_id} data-playability={v.playability} data-matched-tier={v.matched_tier ?? undefined} data-matched-on={v.matched_on || undefined}>
            <OfficialVideo
              lang={v.lang}
              video={{
                provider_video_id: v.video_id, title: v.title, channel_name: v.publisher || "UFC", url: v.url,
                thumbnail_url: v.thumbnail_url || null, published_at: v.published_at || null,
                video_type: v.video_type || null, duration_sec: v.duration_sec ?? null,
              }}
            />
          </div>
        ))}
      </div>
    </Module>
  );
}

type Methodology = {
  gate?: { ok?: boolean; gate?: string; blockers?: string[]; failures?: string[]; green_path?: boolean; corrective_retry?: boolean };
  model?: string; trigger?: { url?: string; publisher?: string; published_at?: string };
  odds_status?: string; model_status?: string; first_party_tables?: string[];
};

/**
 * Sources and method, written for a reader.
 *
 * WHAT THIS BLOCK IS FOR
 *
 * A reader arriving from search has one question: can I trust this? The answer
 * is genuinely strong -- the story is attributed to whoever broke it, the
 * analysis is built on our own fight data, and every number in the prose was
 * checked against that data before it published. This block says exactly that,
 * in language that means something to someone who does not work here.
 *
 * WHAT IT IS NOT
 *
 * It used to print the model name, the gate identifier, validator status chips,
 * the raw table names and the list of modules the plan omitted. All of that is
 * true and none of it is for readers: it made a finished article look like a
 * build log, and it published implementation detail that no reader benefits
 * from. It still exists, in the stored plan, in telemetry and in /desk/preview,
 * which is where an engineer looks.
 *
 * THE CLAIM WE ARE CAREFUL NOT TO MAKE
 *
 * The previous wording said PropBetEdge "verified the development". We did not.
 * We fetched and read the original report, and we analysed the data around it
 * using our own records -- which is a real and defensible thing, and a
 * different thing from independently confirming that the event occurred. The
 * copy now says what actually happened.
 */
export function MethodologyModule({ plan, updated, corroborating }: { plan: ContentPlan | null; updated?: string; corroborating?: { publisher: string; url: string }[] }) {
  const m = moduleOf<Methodology>(plan, "source_methodology");
  if (!m?.data) return null;
  const d = m.data;
  const families = readableFamilies(d.first_party_tables);
  const familySentence = familiesSentence(d.first_party_tables);
  const corroboration = (corroborating || []).filter((c) => c?.url && c?.publisher).slice(0, 6);
  const oddsConnected = d.odds_status === "available";
  return (
    <Module eyebrow="Sources and method" className="method">
      <p className="method-lede">
        {d.trigger?.url ? (
          <>
            First reported by{" "}
            <a href={d.trigger.url} rel="noopener nofollow" target="_blank"><b>{d.trigger.publisher || "the original outlet"}</b></a>
            {d.trigger.published_at ? <> on {fmtDate(d.trigger.published_at)}</> : null}.{" "}
          </>
        ) : null}
        PropBetEdge read that report and analysed the development against its own UFC records
        {familySentence ? <> — {familySentence}</> : null}.
      </p>

      {corroboration.length > 0 && (
        <p className="method-lede">
          {/* Independent reports of the same development are the strongest
            * signal a story is solid, so they are shown rather than counted. */}
          Also reported by{" "}
          {corroboration.map((c, i) => (
            <span key={c.url}>
              {i > 0 ? (i === corroboration.length - 1 ? " and " : ", ") : ""}
              <a href={c.url} rel="noopener nofollow" target="_blank">{c.publisher}</a>
            </span>
          ))}.
        </p>
      )}

      {families.length > 0 && (
        <div className="method-row">
          <span className="k">Data used</span>
          <div className="chips">{families.map((f) => <span key={f} className="tag">{f}</span>)}</div>
        </div>
      )}

      <div className="method-row">
        <span className="k">Editorial method</span>
        <p>
          PropBetEdge uses AI-assisted editorial analysis grounded in a verified fact set. Every numerical claim in this
          article is checked automatically before publication: it must either appear in our own first-party data, or be
          attributed in the same sentence to the reporting it came from. Charts are drawn directly from those verified
          figures rather than written by the model.
          {oddsConnected ? " Odds shown are a snapshot taken when this analysis was written, not a live feed; prices move." : ""}
        </p>
      </div>

      <p className="module-src">
        <Link href="/methodology">Read our Editorial &amp; Data Methodology →</Link>
        {updated ? <> · Last updated {fmtDate(updated)}</> : null}
      </p>
    </Module>
  );
}

/**
 * Prose with intelligence modules set between its paragraphs.
 *
 * WHY MODULES ARE INTERLEAVED RATHER THAN STACKED UNDERNEATH
 *
 * A thousand words followed by a wall of eight modules is two documents on one
 * page, and readers finish the first and leave. Set between paragraphs, each
 * module lands while the sentence that motivates it is still on screen, and the
 * article reads as one thing: analysis, evidence, analysis.
 *
 * THE PLACEMENT RULES
 *
 * Spread the modules evenly across the prose, then correct for two things a
 * naive spread gets wrong. Never insert directly after a heading, which would
 * orphan it from the section it introduces. Never insert before the second
 * paragraph, so the piece establishes what it is about before it is interrupted.
 * If there is not enough prose to hold them all, the surplus falls through to
 * the end rather than being dropped or crowded in.
 */
export function ArticleBody({ md, modules }: { md: string; modules: ReactNode[] }) {
  const blocks = renderMarkdownBlocks(md);
  const mods = modules.filter(Boolean);
  const n = blocks.length;
  const isHeading = (b: string) => /^<h[23]/.test(b);

  const at = new Map<number, ReactNode[]>();
  const overflow: ReactNode[] = [];
  const used = new Set<number>();
  mods.forEach((node, i) => {
    let want = Math.round(((i + 1) * n) / (mods.length + 1));
    want = Math.max(2, want);
    while (want < n && isHeading(blocks[want - 1])) want += 1;
    while (used.has(want) && want < n) want += 1;
    if (want >= n) { overflow.push(node); return; }
    used.add(want);
    at.set(want, [...(at.get(want) || []), node]);
  });

  return (
    <>
      {blocks.map((html, i) => (
        <div key={i}>
          {(at.get(i) || []).map((node, j) => <div key={j}>{node}</div>)}
          <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      ))}
      {overflow.map((node, j) => <div key={`o${j}`}>{node}</div>)}
    </>
  );
}

export { ChartSet };

/** Charts a module renders itself, so the page can catch anything unclaimed. */
export const CLAIMED_CHARTS = new Set([
  "striking_exchange", "grappling_volume", "grappling_rates",
  "dna_traits", "round_pace", "finish_history", "market_implied",
]);
