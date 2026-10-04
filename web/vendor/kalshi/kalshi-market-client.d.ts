/* Type declarations for the vendored, unchanged kalshi-market-client.js. */
import type { KalshiEntry, DeskEvent } from "./kalshi-market-ui.js";
export const POLL_MS: { live: number; pregame: number; idle: number };
export interface KalshiClient {
  sport: string;
  loadBoard(opts?: { force?: boolean }): Promise<Map<string, KalshiEntry>>;
  forEvent(eventId: string): KalshiEntry | null;
  loadEvent(eventId: string, opts?: { force?: boolean }): Promise<KalshiEntry | null>;
  /** Multi-venue desk event for one canonical bout (GET /v1/market-desk?sport=&event=); null when none. */
  loadDesk(eventId: string, opts?: { force?: boolean }): Promise<DeskEvent | null>;
  pollMsFor(state: string): number;
}
export function createKalshiClient(opts: { base?: string; sport: string; fetchImpl?: typeof fetch }): KalshiClient;
