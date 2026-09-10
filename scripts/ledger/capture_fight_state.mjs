/* PBE Fight State Ledger — append-only fight-week snapshots per bout.
 *
 * PRODUCTION OWNER IS THE CLOUDFLARE WORKER workers/ufc-fight-state.
 * This module holds the logic; the Worker holds the schedule. The CLI entry at
 * the foot of the file is for local inspection and bounded replay only.
 *
 *   node scripts/ledger/capture_fight_state.mjs --auto
 *   node scripts/ledger/capture_fight_state.mjs --checkpoint ad_hoc [--event <substring>] [--dry-run] [--json]
 *
 * WHY THIS IS ONE MODULE AND NOT TWO
 *
 * The obvious way to move a scheduled script onto Workers is to write a Worker
 * that does the same thing. Then there are two implementations of "what is the
 * state of this fight", they drift, and the ledger -- whose entire value is that
 * it records state that cannot be recreated later -- ends up holding rows built
 * by two different definitions. So the logic is exported once and injected with
 * its dependencies. Nothing here reads the filesystem, argv or process at module
 * scope, because in workerd those are absent, frozen or meaningless.
 *
 * Checkpoints (relative to the ESPN scheduled start of the event; when the
 * start is unknown the event date at 22:00 UTC is assumed and recorded in
 * provenance.checkpoint_basis):
 *   t_minus_7d (start-168h)  t_minus_72h (start-72h)  t_minus_24h (start-24h)
 *   post_weigh_in (start-26h until weigh-in ingestion exists; basis recorded)
 *   t_minus_3h (start-3h)    close (start-1h)   post_result (once a result row exists)
 * A checkpoint is captured once per bout, only inside its window
 * [checkpoint_time, checkpoint_time + LATE_HOURS]. Missed windows are never
 * back-filled: the point of the ledger is state that cannot be recreated.
 * Rows are inserted, never updated (the table trigger enforces it). */

export const LEDGER_VERSION = 1;
export const BUILDER = 'ufc-fight-state@1';
export const LATE_HOURS = 12;
const ASSUMED_START_UTC = 'T22:00:00Z';
const CHECKPOINTS = [
  ['t_minus_7d', 168], ['t_minus_72h', 72], ['post_weigh_in', 26], ['t_minus_24h', 24], ['t_minus_3h', 3], ['close', 1],
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const hours = (a, b) => (new Date(a).getTime() - new Date(b).getTime()) / 3600e3;
const compactFighter = (f, rank) => ({ id: f.id, name: f.name, nickname: f.nickname, stance: f.stance, slug_id: f.espn_athlete_id || f.ufcstats_id || null, record: { w: f.record_w, l: f.record_l, d: f.record_d, nc: f.record_nc }, dob: f.dob, height_in: f.height_in, reach_in: f.reach_in, weight_lbs: f.weight_lbs, is_active: f.is_active, updated_at: f.updated_at, rankings: rank });
const pick = (m, keys) => Object.fromEntries(keys.filter((k) => m && m[k]).map((k) => [k, m[k]]));

/**
 * Capture every fight-state checkpoint that is due.
 *
 * @param {object}   cfg
 * @param {string}   cfg.supabaseUrl
 * @param {string}   cfg.serviceKey
 * @param {Date}     [cfg.now]          evaluated per run, never at import
 * @param {boolean}  [cfg.auto]         capture whatever is due now
 * @param {string}   [cfg.checkpoint]   capture one named checkpoint instead
 * @param {boolean}  [cfg.dry]          build rows, write nothing
 * @param {string}   [cfg.eventFilter]  substring match on event name
 * @param {Function} [cfg.fetchImpl]
 */
/* ------------------------------------------------ append-only corrections
 *
 * THE PROBLEM A CORRECTION SOLVES
 *
 * This ledger is append-only at the database level: a trigger rejects UPDATE
 * and DELETE, and that is correct. Its value is that it records state which
 * cannot be recreated later, and a table you can quietly edit records nothing.
 *
 * But "cannot be edited" is not the same as "cannot be wrong". A row can be
 * written that should never have existed -- a checkpoint captured outside its
 * window, say -- and with the once-per-(bout, checkpoint) rule, that bad row
 * then SUPPRESSES the genuine capture forever. The archive would hold a
 * confident wrong answer and no way to reach the right one.
 *
 * So a correction is another row, not an edit. It names the row it invalidates,
 * says why, and carries its own version. Reading logic then distinguishes the
 * RAW ledger (everything ever written, for audit) from the EFFECTIVE ledger
 * (what is authoritative now). Nothing is destroyed and nothing is hidden; the
 * mistake stays visible beside the record that supersedes it.
 */
export const CORRECTION_VERSION = 1;

/** A correction is a metadata record, not a state snapshot. */
const CORRECTION_MARK = { status: 'correction_record' };

export function buildCorrectionRow(bad, { reason, now = new Date(), correctionVersion = CORRECTION_VERSION } = {}) {
  const at = new Date(now).toISOString();
  return {
    bout_id: bad.bout_id,
    event_id: bad.event_id,
    /* ad_hoc, because this row makes no claim about a moment in fight week.
     * It is exempt from the once-only rule, so a correction can never itself
     * suppress a genuine capture. */
    checkpoint: 'ad_hoc',
    ledger_version: LEDGER_VERSION,
    captured_at: at,
    scheduled_start: bad.scheduled_start ?? null,
    event_date: bad.event_date ?? null,
    hours_to_start: null,
    bout_state: CORRECTION_MARK,
    fighters: CORRECTION_MARK,
    rankings: CORRECTION_MARK,
    dna: CORRECTION_MARK,
    weigh_in: CORRECTION_MARK,
    wire: CORRECTION_MARK,
    odds: CORRECTION_MARK,
    market: CORRECTION_MARK,
    model: CORRECTION_MARK,
    result: CORRECTION_MARK,
    provenance: {
      builder: BUILDER,
      record_kind: 'correction',
      correction: {
        invalidates_ledger_id: bad.id,
        invalidates_checkpoint: bad.checkpoint,
        invalidates_captured_at: bad.captured_at ?? null,
        reason,
        corrected_at: at,
        correction_version: correctionVersion,
      },
    },
  };
}

/**
 * Split a raw ledger read into what is authoritative and what is not.
 *
 * `effective` is what any product, API or idempotence check should use.
 * `invalidated` and `corrections` exist so an audit read can show the original
 * beside the record that superseded it -- which is the entire point of
 * correcting by appending rather than by editing.
 */
export function partitionLedger(rows = []) {
  const corrections = [];
  const invalidatedIds = new Set();
  for (const r of rows) {
    const c = r?.provenance?.correction;
    if (c?.invalidates_ledger_id) {
      corrections.push(r);
      invalidatedIds.add(String(c.invalidates_ledger_id));
    }
  }
  const effective = [];
  const invalidated = [];
  for (const r of rows) {
    if (r?.provenance?.record_kind === 'correction') continue;   /* not a capture */
    if (invalidatedIds.has(String(r.id))) invalidated.push(r);
    else effective.push(r);
  }
  return { effective, invalidated, corrections, invalidatedIds };
}

export async function captureFightState(cfg) {
  const URL_ = String(cfg.supabaseUrl || '').replace(/\/$/, '');
  const KEY = String(cfg.serviceKey || '');
  if (!URL_ || !KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  const f = cfg.fetchImpl || fetch;
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
  const NOW = cfg.now ? new Date(cfg.now) : new Date();
  const AUTO = Boolean(cfg.auto);
  const CHECKPOINT = cfg.checkpoint || (AUTO ? null : 'ad_hoc');
  const DRY = Boolean(cfg.dry);
  const EVENT_FILTER = String(cfg.eventFilter || '').toLowerCase();

  async function rest(path) {
    const out = []; let off = 0;
    for (;;) {
      const res = await f(`${URL_}/rest/v1/${path}${path.includes('?') ? '&' : '?'}offset=${off}&limit=1000`, { headers: H });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${path.split('?')[0]} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const rows = await res.json(); out.push(...rows);
      if (rows.length < 1000) return out; off += 1000;
    }
  }
  async function insert(rows) {
    if (DRY || !rows.length) return rows.length;
    const res = await f(`${URL_}/rest/v1/ufc_fight_state_ledger`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
    if (!res.ok) throw new Error(`ledger insert -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return rows.length;
  }
  async function espnStart(espnEventId) {
    if (!espnEventId) return null;
    try {
      const res = await f(`https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/${espnEventId}?lang=en&region=us`, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (!res.ok) return null;
      const j = await res.json();
      return j?.date ? new Date(j.date).toISOString() : null;
    } catch { return null; }
  }

  const today = NOW.toISOString().slice(0, 10);
  const from = new Date(NOW.getTime() - 3 * 86400e3).toISOString().slice(0, 10);
  const to = new Date(NOW.getTime() + 9 * 86400e3).toISOString().slice(0, 10);
  const events = (await rest(`ufc_events?select=id,name,event_date,espn_event_id,ufcstats_id,venue,city,region,country,card_status,updated_at&event_date=gte.${from}&event_date=lte.${to}&order=event_date.asc`)) || [];
  const evs = events.filter((e) => !EVENT_FILTER || e.name.toLowerCase().includes(EVENT_FILTER));
  const empty = { events: evs.length, bouts: 0, inserted: 0, skipped_existing: 0, missed_windows: 0, checkpoints: {}, skipped: [], missed: [] };
  if (!evs.length) return { ...empty, events: 0 };
  const evIds = evs.map((e) => e.id);
  const bouts = (await rest(`ufc_bouts?select=*,fighter_a:ufc_fighters!ufc_bouts_fighter_a_id_fkey(*),fighter_b:ufc_fighters!ufc_bouts_fighter_b_id_fkey(*)&event_id=in.(${evIds.join(',')})&order=bout_order.desc`)) || [];
  if (!bouts.length) return empty;
  const results = new Map(((await rest(`ufc_bout_results?select=*&bout_id=in.(${bouts.map((b) => b.id).join(',')})`)) || []).map((r) => [r.bout_id, r]));
  /* Read id and provenance too: without them a correction cannot be matched to
   * the row it invalidates, and `have` would keep suppressing a checkpoint that
   * has been formally withdrawn. */
  const existingRaw = (await rest(`ufc_fight_state_ledger?select=id,bout_id,checkpoint,captured_at,provenance&event_id=in.(${evIds.join(',')})`)) || [];
  const ledger = partitionLedger(existingRaw);
  /* THE EFFECTIVE LEDGER, not the raw one. A row that a later correction
   * invalidates is not an authoritative capture, so it must not count as
   * "already captured" -- otherwise correcting a mistake would be impossible by
   * construction and the bad row would win forever. */
  const have = new Set(ledger.effective.map((r) => `${r.bout_id}:${r.checkpoint}`));
  const fighterIds = [...new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))];

  /* rankings: latest snapshot in the table, else unavailable */
  const rankRows = await rest(`ufc_rankings?select=snapshot_date,division,is_womens,is_p4p,rank,fighter_id,name_raw,captured_at&fighter_id=in.(${fighterIds.join(',')})&order=snapshot_date.desc`);
  const latestSnap = rankRows?.length ? rankRows[0].snapshot_date : null;
  const rankBy = new Map();
  for (const r of rankRows || []) if (r.snapshot_date === latestSnap) { if (!rankBy.has(r.fighter_id)) rankBy.set(r.fighter_id, []); rankBy.get(r.fighter_id).push({ division: r.division, is_womens: r.is_womens, is_p4p: r.is_p4p, rank: r.rank }); }

  /* Fight DNA: latest snapshot at or before today per fighter */
  const dnaRows = await rest(`ufc_fighter_dna_snapshots?select=fighter_id,as_of_date,definition_version,sample_bouts,sample_completed_bouts,sample_stat_bouts,sample_rounds,sample_seconds,coverage_status,metrics,stance_splits,round_profile,finish_profile,generated_at&fighter_id=in.(${fighterIds.join(',')})&as_of_date=lte.${today}&order=as_of_date.desc,definition_version.desc`);
  const dnaBy = new Map();
  for (const r of dnaRows || []) if (!dnaBy.has(r.fighter_id)) dnaBy.set(r.fighter_id, r);

  /* wire: attributed items linked to the event, bout or either fighter, last 14 days */
  const since = new Date(NOW.getTime() - 14 * 86400e3).toISOString();
  const wireRows = (await rest(`ufc_news_items?select=id,title,url,published_at,captured_at,taxonomy,fighter_ids,event_id,bout_id,source:ufc_news_sources(name)&published_at=gte.${since}&order=published_at.desc`)) || [];
  const artRows = (await rest(`ufc_articles?select=id,slug,headline,story_type,status,updated_at,bout_id,event_id,fighter_ids,fact_block->>version&status=eq.published&event_id=in.(${evIds.join(',')})`)) || [];

  const rows = []; const skipped = []; const missed = [];
  for (const e of evs) {
    const start = await espnStart(e.espn_event_id);
    const startIso = start || `${e.event_date}${ASSUMED_START_UTC}`;
    const basis = start ? 'espn_event_start' : 'event_date_22z_assumed';
    for (const b of bouts.filter((x) => x.event_id === e.id)) {
      /* FAIL CLOSED ON UNCERTAIN IDENTITY. A ledger row is a permanent claim
       * about who was booked, and it can never be corrected by a later run.
       * Without both fighters resolved it would record a fight we cannot name,
       * which is worse than recording nothing at all. */
      if (!b.fighter_a || !b.fighter_b) { skipped.push({ bout: b.id, reason: 'unresolved_fighter_identity' }); continue; }
      const res = results.get(b.id) || null;
      const due = [];
      if (AUTO) {
        for (const [cp, hBefore] of CHECKPOINTS) {
          const at = new Date(new Date(startIso).getTime() - hBefore * 3600e3);
          const age = hours(NOW, at);
          if (age < 0) continue;                                   // not yet
          if (have.has(`${b.id}:${cp}`)) continue;                 // captured once
          if (age > LATE_HOURS) { missed.push({ bout: b.id, checkpoint: cp, hours_late: Math.round(age) }); continue; }
          due.push(cp);
        }
        if (res && !have.has(`${b.id}:post_result`)) due.push('post_result');
      } else if (CHECKPOINT) {
        /* A NAMED CHECKPOINT MUST STILL BE INSIDE ITS WINDOW.
         *
         * Replay used to bypass the window entirely, which sounds like a
         * convenience and is a way to permanently corrupt an append-only
         * ledger. Capturing 't_minus_24h' 52 hours before the fight writes a
         * row labelled with a moment that has not happened, and -- because a
         * captured (bout, checkpoint) pair is never captured twice -- it also
         * suppresses the real one when the window finally opens. The ledger
         * then holds a confident, permanent, wrong answer. I did exactly this
         * to one event before adding this guard.
         *
         * ad_hoc is exempt because it claims nothing about timing: it means
         * "state as at captured_at", and hours_to_start is recorded alongside.
         */
        const spec = CHECKPOINTS.find(([name]) => name === CHECKPOINT);
        if (spec) {
          const at = new Date(new Date(startIso).getTime() - spec[1] * 3600e3);
          const age = hours(NOW, at);
          if (age < 0) { skipped.push({ bout: b.id, checkpoint: CHECKPOINT, reason: `window opens in ${Math.abs(Math.round(age))}h` }); continue; }
          if (age > LATE_HOURS) { skipped.push({ bout: b.id, checkpoint: CHECKPOINT, reason: `window closed ${Math.round(age)}h ago; never back-filled` }); continue; }
        }
        if (CHECKPOINT !== 'ad_hoc' && have.has(`${b.id}:${CHECKPOINT}`)) { skipped.push({ bout: b.id, checkpoint: CHECKPOINT, reason: 'already captured' }); } else due.push(CHECKPOINT);
      }
      for (const cp of due) {
        const fa = b.fighter_a, fb = b.fighter_b;
        const dna = (fx, opp) => {
          const s = dnaBy.get(fx.id);
          if (!s) return { status: 'unavailable', reason: 'no_snapshot' };
          const oppStance = opp.stance || 'UNKNOWN';
          return {
            status: 'ok', as_of_date: s.as_of_date, definition_version: s.definition_version, coverage_status: s.coverage_status,
            sample: { bouts: s.sample_bouts, completed_bouts: s.sample_completed_bouts, stat_bouts: s.sample_stat_bouts, rounds: s.sample_rounds, seconds: s.sample_seconds },
            metrics: pick(s.metrics, ['sig_landed_per_min', 'sig_absorbed_per_min', 'sig_accuracy', 'sig_defense', 'head_attack_share', 'body_attack_share', 'leg_attack_share', 'distance_attack_share', 'clinch_attack_share', 'ground_attack_share', 'knockdowns_per_15', 'td_attempts_per_15', 'td_accuracy', 'control_seconds_per_td', 'sub_attempts_per_15']),
            pace: pick(s.round_profile, ['pace_retention_r2_vs_r1', 'pace_retention_r3_vs_r1', 'championship_round_delta']),
            finish: pick(s.finish_profile, ['finish_rate', 'ko_finish_rate', 'submission_finish_rate', 'finish_round_distribution']),
            vs_opponent_stance: { opponent_stance: oppStance, split: s.stance_splits?.[oppStance] || null },
            generated_at: s.generated_at,
          };
        };
        const wire = wireRows.filter((n) => n.bout_id === b.id || n.event_id === e.id || (n.fighter_ids || []).some((id) => id === fa.id || id === fb.id));
        const arts = artRows.filter((a) => a.bout_id === b.id || (a.event_id === e.id && (a.fighter_ids || []).some((id) => id === fa.id || id === fb.id)));
        const scheduledStart = new Date(startIso);
        rows.push({
          bout_id: b.id, event_id: e.id, checkpoint: cp, ledger_version: LEDGER_VERSION, captured_at: NOW.toISOString(),
          scheduled_start: startIso, event_date: e.event_date, hours_to_start: Number(hours(scheduledStart, NOW).toFixed(2)),
          bout_state: { status: b.status, card_position: b.card_position, bout_order: b.bout_order, is_main_event: b.bout_order === Math.max(...bouts.filter((x) => x.event_id === e.id).map((x) => x.bout_order)), scheduled_rounds: b.scheduled_rounds, is_title: b.is_title, weight_class: b.weight_class, weight_class_raw: b.weight_class_raw, is_womens: b.is_womens, short_notice_days: b.short_notice_days, replaced_bout_id: b.replaced_bout_id, espn_competition_id: b.espn_competition_id, ufcstats_id: b.ufcstats_id, bout_updated_at: b.updated_at, event: { name: e.name, card_status: e.card_status, venue: e.venue, city: e.city, region: e.region, country: e.country, event_updated_at: e.updated_at } },
          fighters: { a: compactFighter(fa, rankBy.get(fa.id) || null), b: compactFighter(fb, rankBy.get(fb.id) || null), stance_context: !fa.stance || !fb.stance ? 'unknown' : (fa.stance === 'SWITCH' || fb.stance === 'SWITCH') ? 'switch_involved' : fa.stance === fb.stance ? 'same' : 'open' },
          rankings: rankRows === null ? { status: 'unavailable', reason: 'table_missing' } : latestSnap ? { status: 'ok', snapshot_date: latestSnap, a: rankBy.get(fa.id) || [], b: rankBy.get(fb.id) || [] } : { status: 'unavailable', reason: 'no_snapshot' },
          dna: dnaRows === null ? { status: 'unavailable', reason: 'table_missing' } : { a: dna(fa, fb), b: dna(fb, fa) },
          weigh_in: { status: 'unavailable', reason: 'weigh_in_ingestion_not_built' },
          wire: { status: 'ok', count: wire.length, items: wire.slice(0, 40).map((n) => ({ id: n.id, title: n.title, url: n.url, source: n.source?.name || null, published_at: n.published_at, labels: n.taxonomy?.labels || [], links: { bout: n.bout_id === b.id, event: n.event_id === e.id, fighters: (n.fighter_ids || []).filter((id) => id === fa.id || id === fb.id) } })), articles: arts.map((a) => ({ id: a.id, slug: a.slug, headline: a.headline, story_type: a.story_type, fact_block_version: a.version ?? a['fact_block'] ?? null, updated_at: a.updated_at })) },
          odds: { status: 'unavailable', reason: 'no_odds_provider_connected' },
          market: { status: 'unavailable', reason: 'no_odds_provider_connected' },
          model: { status: 'unavailable', reason: 'no_model_output_exists' },
          result: res ? { status: 'final', winner_id: res.winner_id, method: res.method, method_raw: res.method_raw, round: res.round, time_sec: res.time_sec, time_format: res.time_format, referee: res.referee, finish_detail: res.finish_detail, result_source: res.result_source, has_stats: res.has_stats, captured_at: res.captured_at } : { status: 'pending' },
          provenance: {
            builder: BUILDER, checkpoint_basis: basis, scheduled_start_source: start ? 'espn_core_api' : 'assumed', captured_at: NOW.toISOString(),
            sources: { bout: { table: 'ufc_bouts', updated_at: b.updated_at }, event: { table: 'ufc_events', updated_at: e.updated_at }, fighters: { table: 'ufc_fighters', updated_at: [fa.updated_at, fb.updated_at] }, result: res ? { table: 'ufc_bout_results', captured_at: res.captured_at } : null, rankings: latestSnap ? { table: 'ufc_rankings', snapshot_date: latestSnap } : null, dna: { table: 'ufc_fighter_dna_snapshots', a_generated_at: dnaBy.get(fa.id)?.generated_at || null, b_generated_at: dnaBy.get(fb.id)?.generated_at || null }, wire: { table: 'ufc_news_items', window_days: 14, newest_published_at: wire[0]?.published_at || null } },
          },
        });
      }
    }
  }
  const n = await insert(rows);
  return {
    events: evs.length, bouts: bouts.length,
    inserted: DRY ? 0 : n, would_insert: DRY ? n : undefined,
    skipped_existing: skipped.length, missed_windows: missed.length,
    checkpoints: rows.reduce((m, r) => ({ ...m, [r.checkpoint]: (m[r.checkpoint] || 0) + 1 }), {}),
    skipped, missed,
  };
}

/**
 * Append corrections for ledger rows that should never have been written.
 *
 * Selection is explicit -- ids, or a (checkpoint, builder, captured-at window)
 * triple -- because "correct everything that looks wrong" is not a thing a
 * ledger tool should be able to do. Already-corrected rows are skipped, so
 * running this twice appends nothing the second time.
 */
export async function correctLedgerRows(cfg) {
  const URL_ = String(cfg.supabaseUrl || '').replace(/\/$/, '');
  const KEY = String(cfg.serviceKey || '');
  if (!URL_ || !KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  const f = cfg.fetchImpl || fetch;
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
  const reason = String(cfg.reason || '').trim();
  if (!reason) throw new Error('a correction must state its reason');

  const filters = [];
  if (Array.isArray(cfg.ids) && cfg.ids.length) filters.push(`id=in.(${cfg.ids.join(',')})`);
  if (cfg.checkpoint) filters.push(`checkpoint=eq.${encodeURIComponent(cfg.checkpoint)}`);
  if (cfg.builder) filters.push(`provenance->>builder=eq.${encodeURIComponent(cfg.builder)}`);
  if (cfg.capturedFrom) filters.push(`captured_at=gte.${encodeURIComponent(cfg.capturedFrom)}`);
  if (cfg.capturedTo) filters.push(`captured_at=lte.${encodeURIComponent(cfg.capturedTo)}`);
  if (!filters.length) throw new Error('a correction must name the rows it invalidates');

  const q = `ufc_fight_state_ledger?select=id,bout_id,event_id,checkpoint,captured_at,scheduled_start,event_date,provenance&${filters.join('&')}`;
  const res = await f(`${URL_}/rest/v1/${q}`, { headers: H });
  if (!res.ok) throw new Error(`select -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const targets = (await res.json()).filter((r) => r?.provenance?.record_kind !== 'correction');
  if (!targets.length) return { matched: 0, corrected: 0, already: 0, rows: [] };

  /* Which of these are already corrected? Ask the ledger rather than assume. */
  const evIds = [...new Set(targets.map((r) => r.event_id))];
  const allRes = await f(`${URL_}/rest/v1/ufc_fight_state_ledger?select=id,bout_id,checkpoint,provenance&event_id=in.(${evIds.join(',')})`, { headers: H });
  const already = allRes.ok ? partitionLedger(await allRes.json()).invalidatedIds : new Set();

  const todo = targets.filter((r) => !already.has(String(r.id)));
  if (!todo.length) return { matched: targets.length, corrected: 0, already: targets.length, rows: [] };

  const rows = todo.map((bad) => buildCorrectionRow(bad, { reason, now: cfg.now || new Date() }));
  if (cfg.dry) return { matched: targets.length, corrected: 0, would_correct: rows.length, already: targets.length - todo.length, rows: todo.map((r) => r.id) };

  const ins = await f(`${URL_}/rest/v1/ufc_fight_state_ledger`, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(rows),
  });
  if (!ins.ok) throw new Error(`correction insert -> HTTP ${ins.status} ${(await ins.text()).slice(0, 200)}`);
  return { matched: targets.length, corrected: rows.length, already: targets.length - todo.length, rows: todo.map((r) => r.id) };
}

/* CLI ONLY. Importing this module must never read a file or write a row. */
const isCli = typeof process !== 'undefined'
  && process.argv?.[1]?.replace(/\\/g, '/').endsWith('scripts/ledger/capture_fight_state.mjs');
if (isCli) {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const fileEnv = {};
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) fileEnv[m[1]] = m[2].trim();
    }
  } catch { /* the environment may supply these instead of a file */ }
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  try {
    const summary = await captureFightState({
      supabaseUrl: process.env.SUPABASE_URL || fileEnv.SUPABASE_URL,
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || fileEnv.SUPABASE_SERVICE_ROLE_KEY,
      auto: args.includes('--auto'),
      checkpoint: opt('--checkpoint', null),
      dry: args.includes('--dry-run'),
      eventFilter: opt('--event', ''),
    });
    if (args.includes('--json')) console.log(JSON.stringify(summary, null, 2));
    else console.log(`[ledger] ${JSON.stringify({ ...summary, missed: undefined, skipped: undefined })}${summary.missed?.length ? ` missed=${summary.missed.length} (windows older than ${LATE_HOURS}h are never back-filled)` : ''}`);
  } catch (e) {
    console.error('[ledger] FAILED', e.message);
    process.exit(1);
  }
}
