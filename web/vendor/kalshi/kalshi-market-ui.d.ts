/* Type declarations for the vendored, unchanged kalshi-market-ui.js (contract market-intel/1).
 * This file is ours; the .js / .css / README beside it are byte-identical copies of
 * propbetedge-workers/workers/propsports-markets/client/ (enforced by lib/kalshi.test.ts). */
export interface KalshiOutcome {
  role: string;
  abbr?: string | null;
  kalshi_name?: string | null;
  contract?: string | null;
  market_ticker: string;
  mid_bp?: number | null;
  best_yes_bid_bp?: number | null;
  best_yes_ask_bp?: number | null;
  last_price_bp?: number | null;
  displayable?: boolean;
  [k: string]: unknown;
}
export interface KalshiBlock {
  market_url: string;
  event_ticker: string;
  state: string;
  freshness?: string;
  age_seconds?: number | null;
  outcomes: KalshiOutcome[];
  [k: string]: unknown;
}
export interface KalshiEntry {
  event: { sport: string; canonical_event_id: string; state?: string | null; start_at?: string | null; [k: string]: unknown };
  kalshi: KalshiBlock | null;
  movement?: { kalshi?: Record<string, unknown> | null } | null;
  [k: string]: unknown;
}
export function ageLabel(sec: number | null | undefined): string;
export function sparkline(points: unknown[], opts?: { width?: number; height?: number }): string;
export function kalshiCard(entry: KalshiEntry | null | undefined, opts?: { placement?: string; colors?: Record<string, string>; compact?: boolean }): string;
export function kalshiStrip(entry: KalshiEntry | null | undefined, opts?: { placement?: string; colors?: Record<string, string> }): string;
export function kalshiLine(entry: KalshiEntry | null | undefined): string;
export function wireKalshi(root?: ParentNode | null): void;
export function __resetKalshiFlashes(): void;
