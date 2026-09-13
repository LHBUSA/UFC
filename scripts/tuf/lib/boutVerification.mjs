/**
 * Result verification for one TUF bout. Pure: no network, no file system.
 * Used by scripts/tuf/completeness_matrix.mjs.
 *
 * Two questions that must never share one answer:
 *   dbPairMatches        every professional ufc_bouts row between these two
 *                        fighter ids, whenever it happened. Reported, never
 *                        evidence for a TUF result by itself.
 *   actualFinaleDbBout   the ONE ufc_bouts row that is this tournament final
 *                        on its finale card, or null.
 * Only the actual finale row can verify a result (dbFinaleVerified) or repair a
 * final's classification. A later — or earlier — professional fight between the
 * same two people verifies nothing about a TUF bout.
 *
 * HOUSE BOUTS are verified only by evidence tied to that house bout: an explicit
 * athletic commission record (hasCommissionResult), an official source repair
 * that covers the winner, or an official recap result for the same pairing with
 * the same winner and no contradiction.
 *
 * PROFESSIONAL FINALS (stage final AND on_finale_card) link to the database exactly:
 *   1. an explicit recorded link — ufc_bout_id, scheduled.ufc_bout_id, or a
 *      verified_against of the exact form "ufc_bouts:<uuid>": the row with that
 *      id, and only if it is between the bout's two fighter ids. Explicit links
 *      that disagree fail closed; an explicit link is never overridden by the
 *      fallback;
 *   2. otherwise the season's recorded finale for that bout: the single row
 *      between the two ids whose event name equals the recorded event name
 *      exactly and whose event date equals the recorded date (final_bouts[] for
 *      the weight class, else the season finale_event / finale_date), and whose
 *      date equals the bout's own fight_date when it has one. Both a recorded
 *      event and a recorded date are required.
 *   Anything else — nothing recorded, several candidates, a mismatch — is null.
 */
import { hasCommissionResult } from '../../../web/lib/tufBoutState.ts';

export const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
export const pairKey = (a, b) => [norm(a), norm(b)].sort().join('|');
const one = (v) => (Array.isArray(v) ? v[0] : v);
const samePair = (row, a, b) => [row.fighter_a_id, row.fighter_b_id].sort().join('|') === [a, b].sort().join('|');

/** The winner's canonical id: the corner whose printed name matches, else the
 * season's linked winner for this weight class when that id is one of the corners
 * of a final. A winner printed as neither corner resolves to nothing. */
export function winnerIdOf(bout, seasonRow) {
  if (!bout.winner) return null;
  if (norm(bout.winner) === norm(bout.a)) return bout.a_fighter_id ?? null;
  if (norm(bout.winner) === norm(bout.b)) return bout.b_fighter_id ?? null;
  const winners = seasonRow?.winners || [];
  const seasonWinnerId = winners.find((w) => norm(w.weight_class) === norm(bout.weight_class) || winners.length === 1)?.fighter_id;
  return bout.stage === 'final' && seasonWinnerId && [bout.a_fighter_id, bout.b_fighter_id].includes(seasonWinnerId) ? seasonWinnerId : null;
}

/** The recorded finale for a final: date and event name, from the season inventory row. */
export function recordedFinale(bout, seasonRow) {
  const finals = (seasonRow?.final_bouts || []).filter((f) => norm(f.weight_class) === norm(bout.weight_class));
  const named = finals.filter((f) => pairKey(f.a, f.b) === pairKey(bout.a, bout.b));
  const f = named.length === 1 ? named[0] : finals.length === 1 ? finals[0] : null;
  return { date: f?.date ?? seasonRow?.finale_date ?? null, event: f?.event ?? seasonRow?.finale_event ?? null };
}

/** Every explicit bout-id link recorded on a final, deduplicated. */
export function explicitFinaleBoutIds(bout) {
  const va = /^ufc_bouts:([0-9a-f-]{36})$/i.exec(String(bout.verified_against ?? '').trim());
  return [...new Set([bout.ufc_bout_id, bout.scheduled?.ufc_bout_id, va?.[1]].filter(Boolean).map((x) => String(x).toLowerCase()))];
}

/** The one database row that is this final on its finale card, or null with the reason. */
export function actualFinaleDbBout(bout, seasonRow, pairRows) {
  if (!(bout.stage === 'final' && bout.on_finale_card)) return { row: null, linked_by: null, reason: 'not a finale-card final' };
  if (!bout.a_fighter_id || !bout.b_fighter_id) return { row: null, linked_by: null, reason: 'finalist identity unresolved' };
  const rows = (pairRows || []).filter((r) => samePair(r, bout.a_fighter_id, bout.b_fighter_id));
  const ids = explicitFinaleBoutIds(bout);
  if (ids.length > 1) return { row: null, linked_by: null, reason: `conflicting explicit bout links ${ids.join(', ')}` };
  if (ids.length === 1) {
    const hit = rows.filter((r) => String(r.id).toLowerCase() === ids[0]);
    return hit.length === 1 ? { row: hit[0], linked_by: 'explicit_bout_id', reason: null } : { row: null, linked_by: null, reason: `explicit bout link ${ids[0]} is not a bout between these fighter ids` };
  }
  const rec = recordedFinale(bout, seasonRow);
  if (!rec.date || !rec.event) return { row: null, linked_by: null, reason: `no explicit bout link and no recorded finale ${!rec.date && !rec.event ? 'date or event' : !rec.date ? 'date' : 'event'}` };
  if (bout.fight_date && bout.fight_date !== rec.date) return { row: null, linked_by: null, reason: `fight_date ${bout.fight_date} differs from the recorded finale date ${rec.date}` };
  const hits = rows.filter((r) => one(r.event)?.event_date === rec.date && String(one(r.event)?.name ?? '').trim() === String(rec.event).trim());
  if (hits.length !== 1) return { row: null, linked_by: null, reason: `${hits.length} bouts between these ids on ${rec.date} at "${rec.event}"` };
  return { row: hits[0], linked_by: 'recorded_finale_event_date_pair', reason: null };
}

/**
 * Verify one bout.
 * @param bout       season bracket bout with weight_class and stage attached
 * @param seasonRow  web/data/tuf/seasons.json row
 * @param episodes   web/data/tuf/episodes/<slug>.json or null
 * @param pairRows   ufc_bouts rows (with event and result) between the bout's two ids
 * @param today      ISO date for scheduled finals
 */
export function verifyBout({ bout, seasonRow, episodes, pairRows, today }) {
  const winnerId = winnerIdOf(bout, seasonRow);
  /* An applied official repair: it names its repair and covers the winner field. */
  const officialWinner = (bout.sources || []).some((s) => Boolean(s.repair) && s.family !== 'wikipedia' && (s.fields || []).includes('winner'));
  const recapResult = (episodes?.episodes || []).flatMap((e) => e.bouts || [])
    .find((eb) => pairKey(eb.bracket?.a || eb.a, eb.bracket?.b || eb.b) === pairKey(bout.a, bout.b) && eb.result?.winner);
  const recapAgrees = Boolean(recapResult) && !recapResult.result.contradiction && norm(recapResult.result.winner) === norm(bout.winner);
  const commission = hasCommissionResult(bout);

  const finale = actualFinaleDbBout(bout, seasonRow, pairRows);
  const finaleRow = finale.row;
  const finaleResult = finaleRow ? one(finaleRow.result) : null;
  const dbPairMatches = bout.a_fighter_id && bout.b_fighter_id
    ? (pairRows || []).filter((r) => samePair(r, bout.a_fighter_id, bout.b_fighter_id)).map((r) => ({
      id: r.id, status: r.status, event: one(r.event)?.name ?? null, date: one(r.event)?.event_date ?? null, has_result: Boolean(one(r.result)),
      winner_matches_archive: Boolean(one(r.result)?.winner_id) && one(r.result).winner_id === winnerId,
      is_linked_finale: Boolean(finaleRow) && r.id === finaleRow.id,
    }))
    : null;
  /* This exact tournament final's result row names the archive winner. */
  const dbFinaleVerified = Boolean(finaleResult?.winner_id) && Boolean(winnerId) && finaleResult.winner_id === winnerId;
  /* The final is on its finale card and verified there, while the archive still says 'unverified'. */
  const classificationRepairable = bout.classification === 'unverified' && bout.stage === 'final' && dbFinaleVerified;
  const scheduled = bout.stage === 'final' && !bout.winner && Boolean(finaleRow) && !finaleResult && finaleRow.status !== 'cancelled' && String(one(finaleRow.event)?.event_date) >= today;

  const evidence = [
    ...(dbFinaleVerified ? ['finale_result_row'] : []), ...(officialWinner ? ['official_repair'] : []),
    ...(recapAgrees ? ['official_recap'] : []), ...(commission ? ['commission_record'] : []),
  ];
  const result = bout.winner ? (evidence.length ? 'verified' : 'partial') : scheduled ? 'scheduled' : 'unknown';
  return {
    result, evidence, winnerId, dbPairMatches, dbFinaleVerified, classificationRepairable, scheduled,
    actualFinaleDbBout: finaleRow ? { id: finaleRow.id, event: one(finaleRow.event)?.name ?? null, date: one(finaleRow.event)?.event_date ?? null, linked_by: finale.linked_by, winner_matches_archive: dbFinaleVerified } : null,
    finaleLinkReason: finale.reason,
  };
}
