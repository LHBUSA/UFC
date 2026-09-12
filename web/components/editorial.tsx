/* Bettor-facing editorial modules rendered from ufc_articles.fact_block v2
 * (docs/editorial_contract.md). Everything here is derived from verified
 * structured data; the Bettor's Edge block is labelled as analysis and the
 * market box never shows a price that does not exist in our tables. */
import Link from "next/link";
import type { PortraitSet } from "@/lib/db";
import { Avatar } from "./ui";
import { Mark } from "./Brand";
import { fmtDate, fmtHeight, fmtReach, METHOD_SHORT, stanceLabel } from "@/lib/format";

export type FighterFacts = {
  fighter_id: string; name: string; nickname?: string | null; slug?: string | null;
  record?: { w: number; l: number; d: number; nc?: number } | null; age?: number | null; height_in?: number | null; reach_in?: number | null; stance?: string | null; weight_lbs?: number | null;
  career?: { slpm?: number | null; str_acc?: number | null; sapm?: number | null; str_def?: number | null; td_avg?: number | null; td_acc?: number | null; td_def?: number | null; sub_avg?: number | null } | null;
  archive?: { fights?: number; w?: number; l?: number; d?: number; nc?: number; ko?: number; sub?: number; dec?: number; finish_rate?: number | null; rounds_with_stats?: number; days_since_last?: number | null;
    last?: Array<{ date: string; opponent: string; opponent_slug?: string | null; result: string; method: string; round?: number | null; event?: string }> } | null;
};
import type { EditorialMarket } from "@/lib/editorialMarket";
import { formatAmerican, describeAge } from "@/lib/market";
import { fmtDateTime } from "@/lib/format";

export type BettorAngle = { impact_score?: number; markets?: string[]; summary?: string; supporting_facts?: string[]; risks?: string[]; watch_items?: string[]; odds_status?: string; model_status?: string };
export type FactBlock = {
  version?: number; story_class?: string; generated_at?: string; sources?: { families?: string[]; news_item_ids?: string[] };
  matchup?: { a: FighterFacts; b: FighterFacts; edges?: Array<{ key: string; favors: "a" | "b" | null; delta?: number | null; unit?: string; note?: string }> };
  bettor_angle?: BettorAngle; market_watch?: { status?: string; markets?: string[]; note?: string };
};

export const MARKET_LABEL: Record<string, string> = {
  moneyline: "Moneyline", fight_goes_distance: "Fight goes distance", total_rounds: "Total rounds", method_of_victory: "Method of victory", round_betting: "Round betting",
  significant_strikes: "Significant strikes", takedowns: "Takedowns", control_time: "Control time", knockdowns: "Knockdowns", inside_distance: "Inside the distance",
};
const marketLabel = (m: string) => MARKET_LABEL[m] || m.replace(/_/g, " ");
const rec = (f: FighterFacts) => (f.record ? `${f.record.w}-${f.record.l}-${f.record.d}${f.record.nc ? ` (${f.record.nc} NC)` : ""}` : "—");
const num = (v: number | null | undefined, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v <= 1 ? v * 100 : v)}%`);

export function BettorsEdge({ angle, em }: { angle: BettorAngle; em?: EditorialMarket | null }) {

  /* Live market state wins over the stored flag; the stored flag only ever
     described the moment the article was generated. */
  const oddsLive = em ? em.hasPrices : false;
  const oddsLabel = em
    ? (em.hasPrices ? (em.moneyline?.stale ? "verified snapshot" : "verified market") : "no verified snapshot")
    : (angle.odds_status === "live" ? "live" : angle.odds_status === "snapshot" ? "snapshot" : "no verified snapshot");
  /* An impact meter reading 0/5 is a claim: it tells the reader the desk judged
   * this story unimportant. Articles from ufc-news-enrich do not produce an
   * impact score at all, and rendering their absence as a zero would be the
   * renderer inventing an editorial judgement. No score, no meter. */
  const hasScore = Number.isFinite(Number(angle.impact_score)) && Number(angle.impact_score) > 0;
  const score = Math.max(0, Math.min(5, Math.round(angle.impact_score || 0)));
  return (
    <aside className="bedge" aria-label="Bettor's Edge analysis">
      <div className="bedge-head">
        <div className="bedge-label"><Mark size={22} /><span>Bettor's Edge</span><small>Analysis · from the verified fact block</small></div>
        {hasScore && <div className="bedge-impact" title="Editorial impact score, 1–5. Analysis, not a price.">
          <span className="k">Impact</span>
          <span className="pips" aria-label={`Impact ${score} of 5`}>{[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= score ? "on" : ""} />)}</span>
          <b>{score}/5</b>
        </div>}
      </div>
      {angle.summary && <p className="bedge-summary">{angle.summary}</p>}
      {angle.markets && angle.markets.length > 0 && (
        <div className="bedge-row"><span className="k">Markets affected</span><div className="chips">{angle.markets.map((m) => <span key={m} className="tag gold">{marketLabel(m)}</span>)}</div></div>
      )}
      <div className="bedge-cols">
        {angle.supporting_facts && angle.supporting_facts.length > 0 && (
          <div><div className="k">Why</div><ul>{angle.supporting_facts.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
        )}
        {angle.risks && angle.risks.length > 0 && (
          <div><div className="k risk">Risk / counter-case</div><ul>{angle.risks.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
        )}
        {angle.watch_items && angle.watch_items.length > 0 && (
          <div><div className="k">Watch before betting</div><ul>{angle.watch_items.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
        )}
      </div>
      <div className="bedge-foot">
        {/* Was "Odds · not connected", read off a generation-time flag. That
            claimed the market SYSTEM was missing when in fact we held verified
            prices for the bout. It now reflects the live read when one is
            passed, and otherwise states an absence of data rather than an
            absence of infrastructure. */}
        <span className={`tag${oddsLive ? " pos" : ""}`}>Odds · {oddsLabel}</span>
        <span className={`tag${angle.model_status === "priced" ? " model" : ""}`}>Model · {angle.model_status === "priced" ? "priced" : "not yet produced"}</span>
        <span className="faint label">No pick, price or probability is shown unless it exists in verified data.</span>
      </div>
    </aside>
  );
}

export function MatchupModule({ a, b, imgs, edges, href }: { a: FighterFacts; b: FighterFacts; imgs: Map<string, PortraitSet>; edges?: FactBlock["matchup"] extends infer M ? (M extends { edges?: infer E } ? E : never) : never; href?: string | null }) {
  const rows: Array<[string, string, string, "a" | "b" | null]> = [
    ["Record", rec(a), rec(b), null],
    ["Age", a.age?.toString() || "—", b.age?.toString() || "—", null],
    ["Height", fmtHeight(a.height_in ?? null), fmtHeight(b.height_in ?? null), null],
    ["Reach", fmtReach(a.reach_in ?? null), fmtReach(b.reach_in ?? null), null],
    ["Stance", stanceLabel(a.stance ?? null), stanceLabel(b.stance ?? null), null],
    ["SLpM", num(a.career?.slpm), num(b.career?.slpm), null],
    ["SApM", num(a.career?.sapm), num(b.career?.sapm), null],
    ["Str. def.", pct(a.career?.str_def), pct(b.career?.str_def), null],
    ["TD avg / 15", num(a.career?.td_avg), num(b.career?.td_avg), null],
    ["TD def.", pct(a.career?.td_def), pct(b.career?.td_def), null],
    ["Finish rate", a.archive?.finish_rate != null ? `${a.archive.finish_rate}% (${a.archive.w ?? 0} W)` : "—", b.archive?.finish_rate != null ? `${b.archive.finish_rate}% (${b.archive.w ?? 0} W)` : "—", null],
  ];
  const fav = new Map((edges || []).map((e) => [e.key, e.favors] as const));
  const keyOf: Record<string, string> = { Reach: "reach", Height: "height", Age: "age", SLpM: "slpm", SApM: "sapm", "Str. def.": "str_def", "TD avg / 15": "td_avg", "TD def.": "td_def", "Finish rate": "finish_rate" };
  return (
    <div className="mm">
      <div className="mm-head">
        <Side f={a} img={imgs.get(a.fighter_id)} side="a" />
        <div className="mm-vs">vs</div>
        <Side f={b} img={imgs.get(b.fighter_id)} side="b" />
      </div>
      <div className="tape-rows">
        {rows.map(([k, l, r]) => {
          const f = fav.get(keyOf[k] || "");
          return <div className="tr" key={k}><span className={`l${f === "a" ? " edge" : ""}`}>{l}</span><span className="k">{k}</span><span className={`r${f === "b" ? " edge" : ""}`}>{r}</span></div>;
        })}
      </div>
      <div className="mm-form">
        <RecentForm f={a} />
        <RecentForm f={b} />
      </div>
      <div className="between mt-3">
        <span className="faint label">Career figures are UFC Stats snapshots at capture; archive figures come from bouts in the PropBetEdge database{(a.archive?.rounds_with_stats || b.archive?.rounds_with_stats) ? ", round stats where present" : ""}.</span>
        {href && <Link href={href} className="btn sm">Full matchup →</Link>}
      </div>
    </div>
  );
}

function Side({ f, img, side }: { f: FighterFacts; img?: PortraitSet | null; side: "a" | "b" }) {
  const inner = (
    <>
      <Avatar f={{ name: f.name }} img={img} size={64} />
      <div>
        <div className="n">{f.name}</div>
        {f.nickname && <div className="nick">“{f.nickname}”</div>}
        <div className="r">{rec(f)}{f.archive?.days_since_last != null ? ` · ${f.archive.days_since_last}d since last fight` : ""}</div>
      </div>
    </>
  );
  return f.slug ? <Link href={`/fighters/${f.slug}`} className={`mm-side ${side}`}>{inner}</Link> : <div className={`mm-side ${side}`}>{inner}</div>;
}

export function RecentForm({ f }: { f: FighterFacts }) {
  const last = f.archive?.last || [];
  return (
    <div className="form">
      <div className="eyebrow dim">{f.name.split(" ").slice(-1)[0]} · last {last.length || 0}{f.archive?.fights ? ` of ${f.archive.fights} archived` : ""}</div>
      {last.length ? (
        <ul>
          {last.map((x, i) => (
            <li key={i}>
              <b className={`res ${x.result}`}>{x.result}</b>
              <span className="opp">{x.opponent_slug ? <Link href={`/fighters/${x.opponent_slug}`}>{x.opponent}</Link> : x.opponent}</span>
              <span className="mono faint label">{METHOD_SHORT[x.method] || x.method}{x.round ? ` R${x.round}` : ""} · {fmtDate(x.date, { month: "short", year: "2-digit" })}</span>
            </li>
          ))}
        </ul>
      ) : <div className="faint sm">No archived UFC bouts yet.</div>}
    </div>
  );
}

/* Market Watch, resolved at render time.
 *
 * `mw` is the article's stored fact block and contributes ONE thing: which
 * markets the desk flagged as worth watching. Its legacy `status` is
 * deliberately ignored — it was written at generation time and said
 * "unavailable" forever, even while the fight page showed real prices for the
 * same bout from the same table.
 *
 * `em` is the live read. Availability is per market, because we ingest
 * moneyline and nothing else: saying "not connected" because a method-of-
 * victory price is missing would be false about the moneyline we do hold.
 */
export function MarketWatch({
  mw, em,
}: {
  mw: NonNullable<FactBlock["market_watch"]>;
  em?: EditorialMarket | null;
}) {
  /* No live read available (older render path): fall back to the chips and an
   * honest sentence. Never the old "not connected" claim. */
  if (!em) {
    return (
      <div className="mkt">
        <div className="eyebrow">Market watch</div>
        <div className="mkt-body">
          <span className="dim sm">No verified market snapshot is currently available.</span>
          {mw.markets && mw.markets.length > 0 && (
            <div className="chips"><span className="faint label" style={{ alignSelf: "center" }}>Watch:</span>{mw.markets.map((m) => <span key={m} className="tag">{marketLabel(m)}</span>)}</div>
          )}
        </div>
      </div>
    );
  }

  const ml = em.moneyline;
  const showPrices = em.hasPrices && ml && em.fighterA && em.fighterB;
  const stale = Boolean(ml?.stale);

  return (
    <div className={`mkt${showPrices ? " live" : ""}`}>
      <div className="eyebrow">Market watch</div>
      <div className="mkt-body">
        {showPrices ? (
          <>
            <div className="mkt-line">
              <span className="k">Moneyline</span>
              {/* Stale prices are still shown - they were genuinely observed -
                  but they are never presented as the current market. */}
              <span className={`tag${stale ? "" : " pos"}`}>{stale ? "Not current" : "Current"}</span>
            </div>
            <table className="mkt-prices">
              <tbody>
                <tr>
                  <th scope="row">{em.fighterA!.name}</th>
                  <td className="mono">{formatAmerican(ml!.a?.consensus)}</td>
                </tr>
                <tr>
                  <th scope="row">{em.fighterB!.name}</th>
                  <td className="mono">{formatAmerican(ml!.b?.consensus)}</td>
                </tr>
              </tbody>
            </table>
            {/* A price with no provenance is not evidence. */}
            <span className="faint sm mkt-prov">
              Consensus across {ml!.bookCount} book{ml!.bookCount === 1 ? "" : "s"}
              {ml!.lastUpdated ? <> · observed <time dateTime={ml!.lastUpdated}>{fmtDateTime(ml!.lastUpdated)}</time></> : null}
              {ml!.ageMinutes != null ? ` · ${describeAge(ml!.ageMinutes)}` : ""}
            </span>
          </>
        ) : (
          <span className="dim sm">No verified market snapshot is currently available.</span>
        )}

        {/* Per-market availability. This is the granularity the single frozen
            flag could never express. */}
        {em.markets.length > 0 && (
          <ul className="mkt-avail">
            {em.markets.map((m) => (
              <li key={m.key} data-ok={m.available ? "true" : undefined}>
                <span>{m.label}</span>
                <em>{m.available ? "Verified market available" : m.note}</em>
              </li>
            ))}
          </ul>
        )}

        {mw.markets && mw.markets.length > 0 && (
          <div className="chips"><span className="faint label" style={{ alignSelf: "center" }}>Watch:</span>{mw.markets.map((m) => <span key={m} className="tag">{marketLabel(m)}</span>)}</div>
        )}
      </div>
    </div>
  );
}

export function Methodology({ fb, updated }: { fb: FactBlock; updated: string }) {
  const fam = (fb.sources?.families || []).map((f) => ({ espn: "ESPN schedule/results", ufcstats: "UFC Stats round data", newsroom: "attributed newsroom sources", rankings: "UFC.com rankings snapshot" }[f] || f));
  return (
    <div className="method">
      <div className="eyebrow dim">Source &amp; methodology</div>
      {/* Same reader-first standard as the content-plan articles. "Fact block"
        * is our word for the verified data set behind a story, and it meant
        * nothing to a reader; the UTC generation timestamp was build detail. The
        * substance -- what the analysis is built on, and that every number is
        * checked -- is unchanged and now legible. */}
      <p>
        PropBetEdge analysis built on its own UFC records{fam.length ? ` (${fam.join(", ")})` : ""}. Every number traces
        either to that data or to an attributed source report. Bettor&rsquo;s Edge is analysis and is labelled as such;
        odds and model figures stay blank until verified data exists.
        {" "}Last updated {new Date(updated).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.{" "}
        <Link href="/methodology">Editorial &amp; Data Methodology</Link>.
      </p>
    </div>
  );
}
