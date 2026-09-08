/**
 * Referee archive metrics, computed from every loaded assignment.
 *
 * Extracted from enrich.mjs, where the query carried `limit=500`. That is not
 * a page size — it was the whole request, so any referee past 500 assignments
 * silently described a truncated sample. Herb Dean's packet claimed 203 bouts
 * against a live 1,351 and John McCarthy's claimed 9 against 669, and nothing
 * anywhere said the number was a fragment. A distribution over an unstated
 * subset is worse than no distribution, because it reads as the record.
 *
 * Two changes make that unrepresentable rather than merely fixed:
 *
 *   Pages are fetched until the source is exhausted, in a deterministic order,
 *   so a page size is only ever a page size.
 *
 *   The row count is asserted against ufc_referee_directory.bouts before any
 *   packet is written. If they disagree the refresh FAILS CLOSED for that
 *   referee and writes nothing — a stale packet that is honestly old beats a
 *   fresh one that is quietly short.
 */

const SELECT = [
  'bout_id', 'method', 'round', 'time_sec', 'is_title', 'card_position',
  'scheduled_rounds', 'event_date', 'event_name',
  'fighter_a_name', 'fighter_b_name', 'winner_name', 'weight_class', 'is_womens',
].join(',');

/** Deterministic order: newest first, with the bout id breaking ties so paging
 *  can never repeat or skip a row when two bouts share a date. */
const ORDER = 'event_date.desc.nullslast,bout_id.asc';

export const DEFAULT_PAGE_SIZE = 500;

/**
 * Every loaded assignment for one referee.
 *
 * `fetchPage(pathAndQuery)` is injected so this can be driven by a fixture in
 * a test. It should behave like the project's `rest()`: take a PostgREST path
 * and resolve to an array of rows.
 */
export async function fetchRefereeBouts(slug, fetchPage, { pageSize = DEFAULT_PAGE_SIZE, maxPages = 200 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;
    const rows = await fetchPage(
      `ufc_referee_bouts?select=${SELECT}&referee_slug=eq.${encodeURIComponent(slug)}` +
      `&order=${ORDER}&limit=${pageSize}&offset=${offset}`,
    );
    if (!Array.isArray(rows)) throw new Error(`${slug}: page ${page} did not return rows`);
    out.push(...rows);
    /* A short page means the end. A full page means there may be more, so ask
     * again rather than assume. */
    if (rows.length < pageSize) return out;
  }
  throw new Error(`${slug}: still returning full pages after ${maxPages} pages — refusing to loop`);
}

/** The distributions, computed over whatever rows it is given. */
export function computeArchiveMetrics(bouts) {
  if (!bouts.length) return null;

  const rounds = {};
  const byMethod = {};
  let mainEvents = 0;
  let positioned = 0;
  let timed = 0;
  let totalTime = 0;

  for (const b of bouts) {
    const m = String(b.method || 'UNKNOWN');
    byMethod[m] = (byMethod[m] || 0) + 1;
    if (b.round) rounds[b.round] = (rounds[b.round] || 0) + 1;
    if (b.card_position != null) positioned += 1;
    if (b.card_position === 'main') mainEvents += 1;
    if (b.round && b.time_sec != null) { timed += 1; totalTime += (b.round - 1) * 300 + b.time_sec; }
  }

  const stoppageTimes = bouts
    .filter((b) => /KO_TKO|SUB/.test(b.method || '') && b.round && b.time_sec != null)
    .map((b) => (b.round - 1) * 300 + b.time_sec)
    .sort((a, b) => a - b);
  const pctile = (p) => (stoppageTimes.length ? stoppageTimes[Math.min(stoppageTimes.length - 1, Math.floor(stoppageTimes.length * p))] : null);

  return {
    sample_bouts: bouts.length,
    main_event_assignments: mainEvents,
    /* card_position is only recorded for recent events — 202 of Herb Dean's
     * 1,351 assignments carry one, none before 2017. The main-event count is
     * therefore a count over a subset, and now that the sample is complete the
     * two numbers sit side by side and the reader would take one as a share of
     * the other. Carry the size of the subset so whoever displays the count can
     * say what it is a count of. */
    card_position_sample: positioned,
    method_distribution: byMethod,
    round_distribution: rounds,
    avg_fight_seconds: timed ? Math.round(totalTime / timed) : null,
    timed_sample: timed,
    stoppage_time_seconds: stoppageTimes.length
      ? { p25: pctile(0.25), median: pctile(0.5), p75: pctile(0.75), sample: stoppageTimes.length }
      : null,
    notable: bouts.filter((b) => b.is_title).slice(0, 8).map((b) => ({
      fight: `${b.fighter_a_name} vs ${b.fighter_b_name}`,
      event: b.event_name,
      date: b.event_date,
      method: b.method,
      round: b.round,
    })),
  };
}

/**
 * Metrics for one referee, or a thrown error.
 *
 * `expectedBouts` is ufc_referee_directory.bouts — the same number the page
 * headline shows. Refusing to return anything when the fetched count differs
 * is the whole point: it is what stops a truncated or half-loaded read from
 * being written into a packet and then read as the record.
 */
export async function archiveMetricsFor(slug, expectedBouts, fetchPage, opts = {}) {
  const bouts = await fetchRefereeBouts(slug, fetchPage, opts);

  if (typeof expectedBouts !== 'number') {
    throw new Error(`${slug}: no directory bout count to check ${bouts.length} fetched rows against`);
  }
  if (bouts.length !== expectedBouts) {
    throw new Error(
      `${slug}: fetched ${bouts.length} bout rows but the directory says ${expectedBouts}. ` +
      'Refusing to write a packet from a sample that is not the record.',
    );
  }

  const metrics = computeArchiveMetrics(bouts);
  if (metrics && metrics.sample_bouts !== expectedBouts) {
    throw new Error(`${slug}: computed sample ${metrics.sample_bouts} does not match ${expectedBouts}`);
  }
  return metrics;
}
