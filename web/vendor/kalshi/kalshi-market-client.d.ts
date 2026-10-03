/* Type declarations for the vendored, unchanged kalshi-market-client.js. */
import type { KalshiEntry } from "./kalshi-market-ui.js";
export const POLL_MS: { live: number; pregame: number; idle: number };
export interface KalshiClient {
  sport: string;
  loadBoard(opts?: { force?: boolean }): Promise<Map<string, KalshiEntry>>;
  forEvent(eventId: string): KalshiEntry | null;
  loadEvent(eventId: string, opts?: { force?: boolean }): Promise<KalshiEntry | null>;
  pollMsFor(state: string): number;
}
export function createKalshiClient(opts: { base?: string; sport: string; fetchImpl?: typeof fetch }): KalshiClient;
