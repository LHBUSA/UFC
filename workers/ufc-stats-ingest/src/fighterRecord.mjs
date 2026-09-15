/* Fighter career record: parsing ESPN's record document and deciding whether a
 * stored ufc_fighters record may be replaced by it.
 *
 * Pure functions only (no fetch, no database) so the decision the Worker makes
 * and the decision the operator dry-run reports are the same code.
 *
 * Source of truth: ESPN's career record. Our own bout results are NEVER used to
 * increment a record locally; a result we hold is only (a) the trigger that says
 * a record is probably stale and (b) the allowance that says how far, and in
 * which direction, the source may legitimately have moved.
 *
 * ESPN shape (sports.core.api.espn.com .../athletes/{id}/records, verified live
 * 2026-09-14 for Jean Silva 5145766, Jose Miguel Delgado 5223435, Melvin
 * Guillard 2335800, Michel Pereira 4418962):
 *   items[] -> { name: "overall", type: "total", summary: "18-3-0",
 *                stats: [{ name: "wins", value: 18 }, { name: "losses", value: 3 },
 *                        { name: "draws", value: 0 }, { name: "noContests", value: 0 }, ...] }
 *   `summary` is W-L-D and OMITS no contests even when the fighter has them
 *   (Guillard: summary "32-24-2", stats.noContests 3). So the summary alone never
 *   proves NC = 0; the noContests stat does.
 */

export const RECORD_FIELDS = ['record_w', 'record_l', 'record_d', 'record_nc'];
const CATEGORY_FIELD = { W: 'record_w', L: 'record_l', D: 'record_d', NC: 'record_nc' };

const intOrNull = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * A record summary string -> { w, l, d, nc } or null.
 *
 *   "20-3-0"          -> nc null. W-L-D does not say anything about no contests
 *                        (ESPN's summary omits them), so NC is UNKNOWN, not 0.
 *   "20-3-0 (1 NC)"   -> nc 1   (UFC Stats / UFC.com style)
 *   "20-3-0, 1 NC"    -> nc 1
 *   "Record: 20-3-0 (2 NC)" -> nc 2 (label tolerated)
 * Anything else (two-part "20-3", four bare numbers, text) -> null: an ambiguous
 * format is not a record.
 */
export function parseRecordSummary(summary) {
  const s = String(summary ?? '').trim().replace(/^record:\s*/i, '');
  const m = /^(\d{1,3})\s*-\s*(\d{1,3})\s*-\s*(\d{1,3})(?:\s*(?:\(\s*(\d{1,3})\s*NC\s*\)|,\s*(\d{1,3})\s*NC))?$/i.exec(s);
  if (!m) return null;
  const nc = m[4] ?? m[5];
  return { w: Number(m[1]), l: Number(m[2]), d: Number(m[3]), nc: nc == null ? null : Number(nc) };
}

/** The overall record item from an ESPN records payload, or null. */
export function pickOverallRecord(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.find((x) => x?.name === 'overall') || items.find((x) => x?.type === 'total') || null;
}

/**
 * One ESPN record item -> { w, l, d, nc, nc_source, summary } or { error } .
 *
 * Named stats are preferred (typed, and the only place NC lives). The summary is
 * a cross-check: if both are present and disagree on W-L-D the item is not
 * understood and nothing may be written from it.
 *
 * nc_source:
 *   'stats'   noContests stat present -> authoritative, including 0.
 *   'summary' "(n NC)" in the summary.
 *   'absent'  neither -> nc null. The caller must leave a stored record_nc alone.
 */
export function parseEspnRecordItem(item) {
  if (!item || typeof item !== 'object') return { error: 'no overall record item' };
  const stats = new Map((Array.isArray(item.stats) ? item.stats : []).map((x) => [x?.name, x?.value]));
  const fromSummary = parseRecordSummary(item.summary ?? item.displayValue);
  const sw = intOrNull(stats.get('wins'));
  const sl = intOrNull(stats.get('losses'));
  const sd = intOrNull(stats.get('draws'));
  const snc = intOrNull(stats.get('noContests'));
  let w; let l; let d;
  if (sw != null && sl != null && sd != null) {
    [w, l, d] = [sw, sl, sd];
    if (fromSummary && (fromSummary.w !== w || fromSummary.l !== l || fromSummary.d !== d)) {
      return { error: `summary ${JSON.stringify(item.summary)} disagrees with stats ${w}-${l}-${d}` };
    }
  } else if (fromSummary) {
    ({ w, l, d } = fromSummary);
  } else {
    return { error: `unparseable record ${JSON.stringify(item.summary ?? null)}` };
  }
  let nc = null; let ncSource = 'absent';
  if (snc != null) { nc = snc; ncSource = 'stats'; } else if (fromSummary?.nc != null) { nc = fromSummary.nc; ncSource = 'summary'; }
  if (snc != null && fromSummary?.nc != null && fromSummary.nc !== snc) {
    return { error: `summary NC ${fromSummary.nc} disagrees with noContests ${snc}` };
  }
  return { w, l, d, nc, nc_source: ncSource, summary: item.summary ?? null };
}

/** A fighter's outcome in one stored result: 'W' | 'L' | 'D' | 'NC' | null (unknown). */
export function fighterOutcome(result, fighterId) {
  if (!result) return null;
  if (result.method === 'NC') return 'NC';
  if (result.method === 'DRAW') return 'D';
  if (result.winner_id) return result.winner_id === fighterId ? 'W' : 'L';
  return null;
}

export const fmtRecord = (r) => (r == null || r.w == null ? null : `${r.w}-${r.l}-${r.d}${r.nc == null ? '' : `-${r.nc}`}`);
export const storedRecord = (f) => ({ w: f?.record_w ?? null, l: f?.record_l ?? null, d: f?.record_d ?? null, nc: f?.record_nc ?? null });

/**
 * Should the stored record become the source record?
 *
 *   stored    ufc_fighters row (record_w/l/d/nc)
 *   source    parseEspnRecordItem() output (or null when the source could not be read)
 *   expected  our known final results for this fighter that the stored record may
 *             not include yet: [{ outcome: 'W'|'L'|'D'|'NC'|null, bout_id, event_date }]
 *   staleProof  true when at least one expected result post-dates the stored
 *             record (so an unchanged source means ESPN has not caught up yet)
 *
 * Actions (only 'update' writes):
 *   update          changes = only the record fields that differ
 *   unchanged       source equals stored and nothing says it should have moved
 *   pending_source  source equals stored although a known result post-dates it:
 *                   ESPN has not published the new record yet; retry later
 *   mismatch        the source moved in a way our results cannot explain
 *                   (a count decreased, more new fights than we know of, or a
 *                   different outcome than the one we recorded); nothing written
 *   source_unavailable  record missing / unparseable; nothing written
 */
export function decideRecordRefresh({ stored, source, expected = [], staleProof = false }) {
  const st = storedRecord(stored);
  if (!source || source.error) return { action: 'source_unavailable', changes: {}, reason: source?.error || 'no record in source' };
  const src = { w: source.w, l: source.l, d: source.d, nc: source.nc ?? null };

  /* Nothing stored yet: there is nothing to contradict; take the source. */
  if (st.w == null || st.l == null || st.d == null) {
    const changes = { record_w: src.w, record_l: src.l, record_d: src.d };
    if (src.nc != null) changes.record_nc = src.nc;
    return { action: 'update', changes, reason: 'no stored record', deltas: null };
  }

  const deltas = { W: src.w - st.w, L: src.l - st.l, D: src.d - st.d, NC: st.nc != null && src.nc != null ? src.nc - st.nc : 0 };
  const decreased = Object.entries(deltas).filter(([, v]) => v < 0).map(([k, v]) => `${k} ${v}`);
  if (decreased.length) {
    return { action: 'mismatch', changes: {}, deltas, reason: `source count decreased (${decreased.join(', ')}): stored ${fmtRecord(st)}, source ${fmtRecord(src)}` };
  }
  const moved = deltas.W + deltas.L + deltas.D + deltas.NC;
  /* Filling an unknown NC is not a change in the fight count. */
  const ncFill = st.nc == null && src.nc != null;

  if (moved === 0) {
    if (ncFill) return { action: 'update', changes: { record_nc: src.nc }, deltas, reason: 'record_nc was unknown; source provides it', still_pending: staleProof };
    return staleProof
      ? { action: 'pending_source', changes: {}, deltas, reason: `source still ${fmtRecord(src)} after ${expected.length} known result(s)` }
      : { action: 'unchanged', changes: {}, deltas, reason: 'source equals stored' };
  }

  /* The source moved. Every new fight must be one we know about, with the
   * outcome we recorded. Unknown outcomes (no winner recorded) may fill any
   * category but still count toward the total. */
  if (moved > expected.length) {
    return { action: 'mismatch', changes: {}, deltas, reason: `source added ${moved} fight(s) but we hold ${expected.length} known result(s): stored ${fmtRecord(st)}, source ${fmtRecord(src)}` };
  }
  const have = { W: 0, L: 0, D: 0, NC: 0, unknown: 0 };
  for (const e of expected) { if (e?.outcome && have[e.outcome] != null) have[e.outcome] += 1; else have.unknown += 1; }
  let wildcards = have.unknown;
  const unexplained = [];
  for (const k of ['W', 'L', 'D', 'NC']) {
    const over = deltas[k] - have[k];
    if (over > 0) {
      if (over <= wildcards) wildcards -= over; else unexplained.push(`+${deltas[k]} ${k} vs ${have[k]} known`);
    }
  }
  if (unexplained.length) {
    return { action: 'mismatch', changes: {}, deltas, reason: `source change not explained by our results (${unexplained.join('; ')}): stored ${fmtRecord(st)}, source ${fmtRecord(src)}` };
  }
  const changes = {};
  for (const [k, field] of Object.entries(CATEGORY_FIELD)) {
    const v = k === 'W' ? src.w : k === 'L' ? src.l : k === 'D' ? src.d : src.nc;
    if (v != null && v !== stored?.[field]) changes[field] = v;
  }
  return { action: 'update', changes, deltas, reason: `source moved ${fmtRecord(st)} -> ${fmtRecord(src)}` };
}

/**
 * Bounded, deduplicated refresh plan. Pure: callers pass what they already hold.
 *
 *   triggered   Map fighterId -> { bout_ids:Set } from results that landed THIS run
 *   window      [{ fighter_id, bout_id, event_date, outcome }] final results on cards
 *               in the reconcile window (daily lane only; [] on fight night)
 *   fighters    Map fighterId -> ufc_fighters row
 *   state       previous per-fighter outcomes { [fighterId]: { outcome, last_checked } }
 *   skip        Set of fighter ids already fetched from ESPN this run
 *   retryOnly   fight-night lane: window rows only re-check fighters whose last
 *               outcome was pending_source (rate-limited by pendingRetryMinutes);
 *               everything else in the window waits for the daily lane
 *
 * Priority when the cap binds: triggered this run, then pending_source retries,
 * then stale proof (a result dated after the stored row), then records not
 * checked within recheckDays, most recent fight first. Mismatches are re-read
 * last: they need a human, not more requests.
 */
export function planRecordRefresh({ triggered = new Map(), window = [], fighters, state = {}, skip = new Set(), now = Date.now(), max = 60, recheckDays = 7, pendingRetryMinutes = 0, retryOnly = false }) {
  const byFighter = new Map();
  const add = (fid) => { if (!byFighter.has(fid)) byFighter.set(fid, { fighter_id: fid, expected: [], triggered: false, last_fight_date: null }); return byFighter.get(fid); };
  for (const r of window) {
    const e = add(r.fighter_id);
    if (!e.expected.some((x) => x.bout_id === r.bout_id)) e.expected.push({ bout_id: r.bout_id, event_date: r.event_date, outcome: r.outcome });
    if (!e.last_fight_date || r.event_date > e.last_fight_date) e.last_fight_date = r.event_date;
  }
  for (const [fid, t] of triggered) {
    const e = add(fid);
    e.triggered = true;
    for (const x of t.results || []) {
      if (!e.expected.some((y) => y.bout_id === x.bout_id)) e.expected.push({ bout_id: x.bout_id, event_date: x.event_date, outcome: x.outcome });
      if (x.event_date && (!e.last_fight_date || x.event_date > e.last_fight_date)) e.last_fight_date = x.event_date;
    }
  }
  const skipped = { no_espn_id: 0, fetched_this_run: 0, recently_checked: 0, pending_retry_later: 0, left_for_daily: 0 };
  const plan = [];
  for (const e of byFighter.values()) {
    if (retryOnly && !e.triggered && state[e.fighter_id]?.outcome !== 'pending_source') { skipped.left_for_daily += 1; continue; }
    const f = fighters.get(e.fighter_id);
    if (!f?.espn_athlete_id) { skipped.no_espn_id += 1; continue; }
    if (skip.has(e.fighter_id)) { skipped.fetched_this_run += 1; continue; }
    const updatedMs = Date.parse(f.updated_at || '');
    /* A result on a card dated after the day the row was last written cannot be
     * in that record. Same-day writes are not proof either way (a card's UTC
     * date and its finish can straddle midnight), so they do not count. */
    const staleProof = e.triggered || e.expected.some((x) => x.event_date && (!Number.isFinite(updatedMs) || updatedMs < Date.parse(`${x.event_date}T00:00:00Z`)));
    const prev = state[e.fighter_id];
    const lastChecked = Date.parse(prev?.last_checked || '');
    if (!e.triggered && prev?.outcome === 'pending_source' && pendingRetryMinutes > 0 && Number.isFinite(lastChecked) && now - lastChecked < pendingRetryMinutes * 60000) {
      skipped.pending_retry_later += 1; continue;
    }
    if (!e.triggered && !staleProof && prev && ['unchanged', 'update'].includes(prev.outcome) && Number.isFinite(lastChecked) && now - lastChecked < recheckDays * 86400e3) {
      skipped.recently_checked += 1; continue;
    }
    const rank = e.triggered ? 0 : prev?.outcome === 'pending_source' ? 1 : prev?.outcome === 'mismatch' ? 4 : staleProof ? 2 : 3;
    plan.push({ ...e, fighter: f, stale_proof: staleProof, rank });
  }
  plan.sort((a, b) => a.rank - b.rank || String(b.last_fight_date || '').localeCompare(String(a.last_fight_date || '')) || String(a.fighter_id).localeCompare(String(b.fighter_id)));
  return { plan: plan.slice(0, max), capped: Math.max(0, plan.length - max), skipped };
}
