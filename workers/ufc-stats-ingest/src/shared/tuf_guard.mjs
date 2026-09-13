/* The Ultimate Fighter in-house events are not UFC events.
 *
 * ESPN's MMA API lists some TUF house fights as events of their own — "The
 * Ultimate Fighter 26 Semifinal", "The Ultimate Fighter 29 Semifinal" — with
 * competitors, winners, methods and clocks, exactly like a card. They are
 * unsanctioned exhibitions filmed inside the show. Written into ufc_events and
 * ufc_bouts they would become professional results on fighters' records, which
 * is the one thing the TUF archive exists to prevent (web/lib/tuf.ts).
 *
 * Measured 2026-09-12: 13 such ESPN events (TUF 26, 29, 30, 31), none of them
 * in our tables. Nothing stopped them arriving; a backfill run with
 * ESPN_DATES=2021 would have loaded four.
 *
 * A finale is a real card and is never matched: "The Ultimate Fighter 28
 * Finale", "TUF Brazil Finale", and every finale held on a numbered event.
 *
 * Mirrored in shared/tuf_guard.py; scripts/sync_shared.py copies this file into
 * each Worker. Tests: shared/tests/test_tuf_guard.mjs.
 */

const TUF = /\b(the\s+)?ultimate\s+fighter\b|\btuf\b/i;
const IN_HOUSE = /\b(semi[\s-]?finals?|quarter[\s-]?finals?|elimination|entry\s+round|opening\s+round|round\s+of\s+(16|sixteen|32)|wild\s?card|episode\s*\d*|house\s+fights?)\b/i;
const FINALE = /\bfinale\b/i;

/**
 * Why an event must not be stored as a UFC event, or null when it may.
 * Only the event name is needed; the check is deliberately narrow so that it
 * cannot swallow a real card.
 */
export function tufInHouseEventReason(name) {
  const n = String(name || '');
  if (!TUF.test(n)) return null;
  if (FINALE.test(n)) return null;
  if (!IN_HOUSE.test(n)) return null;
  return `"${n}" is a TUF in-house stage, not a sanctioned UFC event; its bouts are exhibitions`;
}

export const isTufInHouseEvent = (name) => tufInHouseEventReason(name) !== null;
