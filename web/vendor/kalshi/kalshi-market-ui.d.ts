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
  market?: { venue?: string; lifecycle?: string; market_url?: string; proposition?: string; close?: { lifecycle?: string; shape?: string; outcomes?: Record<string, unknown>[] } | null; [k: string]: unknown } | null;
  market_history?: { lifecycle?: string; status_label?: string; shape?: string; market_url?: string; outcomes?: Record<string, unknown>[]; [k: string]: unknown } | null;
  [k: string]: unknown;
}
export function ageLabel(sec: number | null | undefined): string;
export function sparkline(points: unknown[], opts?: { width?: number; height?: number }): string;
export function kalshiCard(entry: KalshiEntry | null | undefined, opts?: { placement?: string; colors?: Record<string, string>; compact?: boolean }): string;
export function kalshiStrip(entry: KalshiEntry | null | undefined, opts?: { placement?: string; colors?: Record<string, string> }): string;
export function kalshiLine(entry: KalshiEntry | null | undefined): string;
export function historyChart(h: Record<string, unknown>, opts?: { width?: number; height?: number }): string;
export function marketHistoryCard(entry: KalshiEntry | null | undefined, opts?: { placement?: string }): string;
export function marketCloseLine(entry: KalshiEntry | null | undefined): string;
export function marketModule(entry: KalshiEntry | null | undefined, opts?: { placement?: string; colors?: Record<string, string>; compact?: boolean }): string;
export function wireKalshi(root?: ParentNode | null): void;
/* VENUES (canonical 4303a38, venue-neutral): one desk event from /v1/market-desk; '' when no second venue qualifies. */
export interface DeskEvent { canonical_event_id: string; contracts: Record<string, unknown>[]; [k: string]: unknown }
export function venueLines(deskEvent: DeskEvent | null | undefined, opts?: { placement?: string; standalone?: boolean }): string;
/** Venues other than Kalshi with a current priced market on this event. */
export function deskVenues(deskEvent: DeskEvent | null | undefined): string[];
/** Compact venue cue for list / card surfaces; '' when none. */
export function venueChip(deskEvent: DeskEvent | null | undefined): string;
/** Re-render "Updated Xs ago" on venue cards in place. */
export function tickVenueAges(root?: ParentNode | null): void;
export function __resetKalshiFlashes(): void;
/* ALGO vs MARKET (canonical ad6187a): /v1/algo-vs-market/:sport and /v1/algo-vs-market/event/:sport/:id. */
export interface AvmComparison {
  algo_id: string;
  algo_label?: string | null;
  canonical_event_id: string;
  event_label?: string | null;
  status: string;
  algo_lock_at?: string | null;
  algo_selection?: string | null;
  algo_selection_label?: string | null;
  algo_probability?: number | null;
  market?: { selection?: string | null; selection_label?: string | null; selection_price_bp?: number | null; snapshot_age_s?: number | null; prices?: Record<string, { label?: string | null; [k: string]: unknown }> | null; [k: string]: unknown } | null;
  result?: { h2h_outcome: string; [k: string]: unknown } | null;
  [k: string]: unknown;
}
export interface AvmAlgo {
  algo_id: string;
  algo_label?: string | null;
  scoreboard: { algo_wins: number; market_wins: number; neither: number; void: number; agreements: number; disagreements: number; pending: number; decided?: number; algo_win_rate?: number | null; [k: string]: unknown };
  excluded?: Record<string, number> | null;
  ledger: AvmComparison[];
  [k: string]: unknown;
}
export type AvmNameOf = (row: AvmComparison, role: string) => string | null | undefined;
export function algoVsMarketCard(algo: AvmAlgo | null | undefined, opts?: { nameOf?: AvmNameOf | null; recent?: number; ledgerHref?: string | null }): string;
export function algoVsMarketEvent(payload: { comparisons?: AvmComparison[] } | null | undefined, opts?: { nameOf?: AvmNameOf | null }): string;
