import {
  CONSENSUS_NOTE, FIRST_OBSERVED_NOTE, MARKET_STATE_COPY,
  describeAge, formatAmerican, movement,
  type BoutMarket, type MarketState, type SidePrices,
} from "@/lib/market";

/* A timestamp is only useful if the reader can tell what it is the time OF.
 * Two different facts get two different labels and are never merged:
 * "observed" is when this system last recorded a price, "book last moved" is
 * when the books themselves last repriced. A quiet market and a broken ingest
 * look identical if you only print one of them. */
const Stamp = ({ iso, label }: { iso: string | null; label: string }) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return (
    <time dateTime={iso} title={d.toUTCString().replace("GMT", "UTC")}>
      {label} {d.toUTCString().replace("GMT", "UTC")}
    </time>
  );
};

/* Market surfaces.
 *
 * Descriptive pricing only. Nothing here says edge, value, model, pick or win
 * probability, because the product has no prediction model and a market price
 * is not one. Movement is described as toward or away from a fighter and
 * never as sharp money, steam or public action: those are claims about who is
 * betting, and there is no source behind them.
 */

const Delta = ({ side, name }: { side: SidePrices | null; name: string }) => {
  const m = movement(side, "first");
  if (!m) return null;
  if (m.direction === "unchanged") return <span className="mk-move flat">Unchanged since first observed</span>;
  const toward = m.direction === "toward";
  return (
    <span className={`mk-move ${toward ? "toward" : "away"}`}>
      {toward ? "Moved toward" : "Moved away from"} {name} · {formatAmerican(m.from)} → {formatAmerican(m.to)}
    </span>
  );
};

/** Compact two-price line for a card or a bout row. */
export function MarketInline({
  market, state, nameA, nameB,
}: { market?: BoutMarket; state: MarketState; nameA: string; nameB: string }) {
  if (state !== "available" && state !== "partial") {
    /* A truthful sentence, never an empty container or a placeholder price. */
    return <div className="mk-inline mk-none">{MARKET_STATE_COPY[state].label}</div>;
  }
  return (
    <div className="mk-inline" aria-label="Current market">
      <span className="mk-side">
        <span className="mk-nm">{nameA}</span>
        <b>{formatAmerican(market?.a?.consensus)}</b>
      </span>
      <span className="mk-sep" aria-hidden="true" />
      <span className="mk-side">
        <span className="mk-nm">{nameB}</span>
        <b>{formatAmerican(market?.b?.consensus)}</b>
      </span>
      {state === "partial" ? <span className="mk-partial">One corner priced</span> : null}
      {market?.stale ? <span className="mk-stale-tag">Last observed {describeAge(market.ageMinutes)}</span> : null}
    </div>
  );
}

function Side({ side, name, label }: { side: SidePrices | null; name: string; label: string }) {
  if (!side) {
    return (
      <div className="mk-col">
        <div className="mk-col-h">{label}</div>
        <div className="mk-price">—</div>
        <p className="mk-none-sm">No book we read is pricing this corner.</p>
      </div>
    );
  }
  return (
    <div className="mk-col">
      <div className="mk-col-h">{label}</div>
      <div className="mk-price">{formatAmerican(side.consensus)}</div>
      <dl className="mk-rows">
        <div><dt>Best available</dt><dd>{formatAmerican(side.best)}</dd></div>
        <div><dt>Book range</dt><dd>{formatAmerican(side.worst)} to {formatAmerican(side.best)}</dd></div>
        <div><dt>Books</dt><dd>{side.bookCount}</dd></div>
        <div><dt>First observed</dt><dd>{formatAmerican(side.firstObserved?.price ?? null)}</dd></div>
      </dl>
      <Delta side={side} name={name} />
    </div>
  );
}

/** The full MARKET section for a fight page. */
export function MarketSection({
  market, state, nameA, nameB,
}: { market?: BoutMarket; state: MarketState; nameA: string; nameB: string }) {
  const copy = MARKET_STATE_COPY[state];

  if (state !== "available" && state !== "partial") {
    return (
      <section className="segment mk" id="market" aria-label="Market">
        <h3>Market</h3>
        <div className="card mk-empty">
          <div className="mk-state">{copy.label}</div>
          <p>{copy.body}</p>
        </div>
      </section>
    );
  }

  const books = new Map<string, { name: string | null; a?: number; b?: number }>();
  for (const x of market?.a?.books || []) books.set(x.key, { ...(books.get(x.key) || {}), name: x.name, a: x.price });
  for (const x of market?.b?.books || []) books.set(x.key, { ...(books.get(x.key) || {}), name: x.name, b: x.price });

  return (
    <section className="segment mk" id="market" aria-label="Market">
      <div className="mk-head">
        <div>
          <h3>Market</h3>
          <p className="mk-sub">What books are charging. Descriptive pricing, kept separate from Fight DNA and from round-level analysis.</p>
        </div>
        <div className="mk-stamp">
          <span className={`mk-chip${market?.stale ? " stale" : ""}`}>
            {market?.stale ? "Market not current" : copy.label}
          </span>
          <Stamp iso={market?.lastUpdated ?? null} label="Observed" />
          <Stamp iso={market?.sourceLastUpdate ?? null} label="Book last moved" />
        </div>
      </div>

      <div className="card mk-card">
        {market?.stale && (
          /* The prices below are real and were really observed; what is no
           * longer true is that they are current. Say exactly that, rather
           * than hiding a fact we hold or presenting it as live. */
          <p className="mk-stale-note">
            These prices were last observed {describeAge(market.ageMinutes)} and have not been rechecked since.
            They are the last prices this system recorded, not the current market. Books may have moved.
          </p>
        )}
        <div className="mk-cols">
          <Side side={market?.a ?? null} name={nameA} label={nameA} />
          <Side side={market?.b ?? null} name={nameB} label={nameB} />
        </div>

        {books.size > 0 && (
          <div className="mk-books">
            <div className="eyebrow">Books · {books.size}</div>
            <div className="mk-book-grid">
              {[...books.entries()].map(([key, v]) => (
                <div className="mk-book" key={key}>
                  <span className="mk-book-n">{v.name || key}</span>
                  <span className="mk-book-p">{formatAmerican(v.a ?? null)}</span>
                  <span className="mk-book-p">{formatAmerican(v.b ?? null)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mk-notes">
          <p>{CONSENSUS_NOTE}</p>
          <p>{FIRST_OBSERVED_NOTE}</p>
          <p>Market pricing is an independent layer. PropBetEdge does not publish a model probability, an edge or a recommended bet, and nothing on this page should be read as one.</p>
        </div>
      </div>
    </section>
  );
}
