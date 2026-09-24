/* Fight-week card watch and the card-contradiction guard.
 *
 * INCIDENT 2026-09-24 (UFC Vegas 121). ESPN dropped Mickey Gall vs Sedriques
 * Dumas (competition 401923433) during the afternoon. Our last read of that
 * card was the 06:00Z daily pass, and the fast lane only re-reads a card on
 * fight night, so the newest observation still listed the bout. The effective
 * card (ufc_bouts_effective, web applyCardTruth) applied the rule correctly to
 * stale evidence: Gall vs Dumas stayed active on the event page, Fight Week and
 * the simulator for hours after two newsroom items reported the replacement.
 *
 * Two parts, both pure here (no I/O, no clock):
 *
 *   cardWatchDue / cardWatchDates
 *     Every 30 minutes, re-read every UFC card dated inside the next 7 days
 *     through the ordinary ESPN pass. Same identity rules, same append-only
 *     observation; the newest complete observation still decides.
 *
 *   cardContradictions
 *     Structured relationships only, no text matching: a newsroom item with
 *     story_kind replacement or withdrawal and a linked fighter id (entity
 *     confidence >= 0.7) that belongs to an ACTIVE upcoming effective bout.
 *       stale_card            the card has not been observed since the report and
 *                             the reconciliation window has passed: our ingest is
 *                             behind the news. Alerted.
 *       awaiting_observation  reported, not yet re-read, still inside the window.
 *       reported_unconfirmed  the card WAS re-read after the report and still lists
 *                             the bout. Correct by contract: a report is not a
 *                             removal. Reported for review, not alerted.
 *     Nothing here removes a bout. Removal happens only through a card
 *     observation or a canonical status, exactly as before. */

export const CARD_WATCH = {
  aheadDays: 7,
  everyMinutes: 30,
  offsetMinute: 5,
  reconcileMinutes: 90,
  newsLookbackDays: 7,
  minEntityConfidence: 0.7,
  kinds: ['replacement', 'withdrawal'],
};

export function cardWatchDue(nowMs) {
  return new Date(nowMs).getUTCMinutes() % CARD_WATCH.everyMinutes === CARD_WATCH.offsetMinute;
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
/** One ESPN date range covering today .. today + aheadDays (UTC). */
export function cardWatchDates(nowMs) {
  return [`${ymd(nowMs)}-${ymd(nowMs + CARD_WATCH.aheadDays * 86400e3)}`];
}

const t = (s) => { const n = s ? Date.parse(s) : NaN; return Number.isFinite(n) ? n : null; };

/**
 * @param {object} a
 * @param {number} a.now
 * @param {object[]} a.items   ufc_news_items rows (id, title, story_kind, fighter_ids, primary_fighter_id, secondary_fighter_ids, entity_confidence, detected_at)
 * @param {object[]} a.bouts   ACTIVE effective bouts on upcoming cards (id, event_id, fighter_a_id, fighter_b_id)
 * @param {Record<string, {name?: string, event_date?: string}>} [a.events]
 * @param {Record<string, string>} [a.lastObserved]  event_id -> newest observation observed_at
 * @param {Record<string, string>} [a.fighterNames]
 */
export function cardContradictions({ now, items, bouts, events = {}, lastObserved = {}, fighterNames = {} }) {
  const windowMs = CARD_WATCH.reconcileMinutes * 60000;
  const since = now - CARD_WATCH.newsLookbackDays * 86400e3;
  const byBout = new Map();
  for (const it of items) {
    if (!CARD_WATCH.kinds.includes(it.story_kind)) continue;
    if (!(Number(it.entity_confidence) >= CARD_WATCH.minEntityConfidence)) continue;
    const at = t(it.detected_at);
    if (at === null || at < since || at > now) continue;
    const fighters = new Set([it.primary_fighter_id, ...(it.secondary_fighter_ids || []), ...(it.fighter_ids || [])].filter(Boolean));
    for (const b of bouts) {
      const hit = [b.fighter_a_id, b.fighter_b_id].filter((f) => f && fighters.has(f));
      if (!hit.length) continue;
      if (!byBout.has(b.id)) byBout.set(b.id, { bout: b, reports: [] });
      byBout.get(b.id).reports.push({ item: it, at, fighters: hit });
    }
  }
  const out = [];
  /* Duplicate reports collapse to one entry per bout. The staleness clock starts at the OLDEST report the card has not
   * been re-read since (a newer duplicate must not reset it); a card re-read after the NEWEST report is reconciled. */
  for (const { bout, reports } of byBout.values()) {
    reports.sort((x, y) => x.at - y.at);
    const observed = t(lastObserved[bout.event_id]);
    const unreconciled = reports.filter((r) => observed === null || r.at > observed);
    const pick = unreconciled[0] || reports[reports.length - 1];
    const state = !unreconciled.length ? 'reported_unconfirmed' : now - pick.at >= windowMs ? 'stale_card' : 'awaiting_observation';
    const { item, fighters } = pick;
    out.push({
      state, bout_id: bout.id, event_id: bout.event_id, event_name: events[bout.event_id]?.name ?? null,
      matchup: [bout.fighter_a_id, bout.fighter_b_id].map((f) => fighterNames[f] || f).join(' vs '),
      named_fighters: fighters, news_item_id: item.id, story_kind: item.story_kind, headline: item.title ?? null,
      reported_at: item.detected_at, last_observed_at: lastObserved[bout.event_id] ?? null, reports: reports.length,
    });
  }
  const rank = { stale_card: 0, awaiting_observation: 1, reported_unconfirmed: 2 };
  return out.sort((x, y) => rank[x.state] - rank[y.state] || String(x.bout_id).localeCompare(String(y.bout_id)));
}

/** Alert on a NEW stale bout, and once more when all stale bouts clear. Dedupe state rides in R2 like the archive alert. */
export function contradictionAlertDecision({ found, previous, now }) {
  const prev = previous || { stale_bout_ids: [] };
  const stale = found.filter((c) => c.state === 'stale_card');
  const ids = stale.map((c) => c.bout_id).sort();
  const isNew = ids.some((id) => !(prev.stale_bout_ids || []).includes(id));
  const cleared = !ids.length && (prev.stale_bout_ids || []).length > 0;
  const at = new Date(now).toISOString();
  const next = { status: ids.length ? 'degraded' : 'ok', stale_bout_ids: ids, checked_at: at, last_alert_at: isNew || cleared ? at : prev.last_alert_at ?? null, found };
  if (isNew) {
    const lines = stale.map((c) => `- ${c.event_name || c.event_id}: ${c.matchup} still ACTIVE; ${c.story_kind} reported ${c.reported_at}, card last observed ${c.last_observed_at || 'never'} (news ${c.news_item_id})`);
    return { send: true, loud: true, message: `CARD CONTRADICTION - newsroom reports a change the canonical card has not re-read\n${lines.join('\n')}`, next };
  }
  if (cleared) return { send: true, loud: false, message: 'CARD CONTRADICTION CLEARED - every reported change has been re-read against the official card', next };
  return { send: false, next };
}
