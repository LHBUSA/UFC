#!/usr/bin/env node
/* The live weigh-in pass. Fetch, parse, store, mirror. No model, no articles.
 *
 *   node scripts/weighins/weighin_pass.mjs [--write] [--event <id>] [--force]
 *
 * DEFAULT IS DRY RUN, and the migration is unapplied, so the write path is
 * unreachable in every environment today.
 *
 * WHAT IT MUST NEVER DO
 *
 * Call Anthropic. Generate an article. Trigger a Fight DNA or model build.
 * A scale reading is a number with a source; turning each one into prose would
 * cost money per fighter per correction and produce copy nobody asked for. The
 * deterministic sentence — "Fighter X — 158.5 lb — MISSED by 2.5 lb" — is
 * built from stored fields in weights.mjs and is reproducible six months later.
 * Editorial publication stays on its own cadence and its own entry point.
 *
 * weighin_pass.test.mjs walks this module's transitive import graph and fails
 * if write_articles, polish_world_class, any Anthropic transport or the DNA
 * builder ever appears in it.
 *
 * ITS OWN SINGLE-FLIGHT IDENTITY
 *
 * LOCK_ID below is deliberately not the newsroom's. The newsroom's Durable
 * Object serialises its invocations, and a four-minute editorial sweep holding
 * that lock would make every weigh-in pass inside it stand down — during the
 * exact ninety minutes the feature exists for. A live desk cannot queue behind
 * a batch writer.
 */
import { Supabase, loadEnv, sha256 } from '../news/lib.mjs';
import { resolveLimit, evaluateWeight, fingerprintOf, projectCurrent } from './lib/weights.mjs';
import { planWindow, CADENCE } from './lib/window.mjs';
import { parseWeighInSources, SOURCE_ADAPTERS } from './lib/sources.mjs';

/** Not 'newsroom'. See the header. */
export const LOCK_ID = 'weigh-ins';
export const WORKER = 'ufc-weigh-ins';

export function parseCliOptions(argv = []) {
  const flag = (n) => argv.includes(n);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return { write: flag('--write'), force: flag('--force'), eventId: opt('--event', null), verbose: flag('--verbose') };
}

export function resolveOptions(options = {}) {
  return {
    write: Boolean(options.write),
    /* Ignore the cadence gate. For an operator running it by hand, never for a
     * scheduled caller — the gate is what makes the idle case cheap. */
    force: Boolean(options.force),
    eventId: options.eventId || null,
    now: options.now ?? Date.now(),
    /* Injected so tests drive the parser without network, and so a host can
     * supply its own fetch. */
    fetchImpl: options.fetchImpl || null,
  };
}

/**
 * One pass.
 *
 * Order matters: the window decision comes FIRST and before any source fetch,
 * because the whole point of the idle mode is not paying for the expensive
 * part. One indexed query for the next event, then a decision, then possibly
 * nothing at all.
 */
export async function runWeighInPass(injectedEnv, options = {}) {
  const opts = resolveOptions(options);
  const env = injectedEnv || loadEnv();
  const sb = new Supabase(env);
  const started = Date.now();

  const event = opts.eventId
    ? (await sb.select('ufc_events', `select=id,name,event_date&id=eq.${opts.eventId}&limit=1`))[0] || null
    : (await sb.select('ufc_events', `select=id,name,event_date&event_date=gte.${new Date(opts.now - 36 * 3600e3).toISOString().slice(0, 10)}&order=event_date.asc&limit=1`))[0] || null;

  const lastRun = opts.force ? null
    : (await sb.select('ufc_ingest_runs', `select=started_at&worker=eq.${WORKER}&order=started_at.desc&limit=1`).catch(() => []))[0]?.started_at || null;

  const plan = planWindow({ nextEvent: event, now: opts.now, lastRunAt: lastRun });

  if (plan.skip && !opts.force) {
    console.log(`[weigh-ins] no-op (${plan.mode}): ${plan.reason}`);
    return { status: 'skipped', plan, fetched: 0, readings: [], counters: zero(), duration_ms: Date.now() - started };
  }
  if (plan.mode === 'idle' && !opts.force) {
    console.log(`[weigh-ins] idle: ${plan.reason} — no source fetched`);
    return { status: 'idle', plan, fetched: 0, readings: [], counters: zero(), duration_ms: Date.now() - started };
  }

  /* Only now does anything cost money or bandwidth. */
  const bouts = await sb.select('ufc_bouts',
    `select=id,event_id,fighter_a_id,fighter_b_id,weight_class,weight_class_raw,is_womens,is_title,card_position,bout_order,status&event_id=eq.${event.id}`);
  const fighterIds = [...new Set(bouts.flatMap((b) => [b.fighter_a_id, b.fighter_b_id]))];
  const fighters = fighterIds.length
    ? await sb.select('ufc_fighters', `select=id,name&id=in.(${fighterIds.join(',')})`)
    : [];

  const parsed = await parseWeighInSources({
    event, bouts, fighters, now: opts.now, fetchImpl: opts.fetchImpl,
  });

  const readings = [];
  const counters = zero();
  counters.sources_fetched = parsed.sources_fetched;
  counters.sources_failed = parsed.sources_failed;

  for (const r of parsed.readings) {
    const bout = bouts.find((b) => b.id === r.bout_id) || null;
    const limit = resolveLimit({
      weightClass: bout?.weight_class,
      isTitle: typeof bout?.is_title === 'boolean' ? bout.is_title : undefined,
      sourcedLimitLbs: r.sourced_limit_lbs ?? null,
    });
    const verdict = evaluateWeight({
      officialWeightLbs: r.official_weight_lbs,
      applicableLimitLbs: limit.applicable_limit_lbs,
      reportedMiss: Boolean(r.reported_miss),
    });

    /* The schema forbids result='missed' with no weight, so an unmeasured miss
     * is stored as a miss ONLY when the source also gave a number. Otherwise
     * it is carried as a status event alone — the availability fact survives,
     * the invented measurement never exists. */
    const measured = r.official_weight_lbs != null;
    const result = verdict.result === 'missed_unmeasured' ? 'pending'
      : verdict.result === 'unjudged' ? (measured ? 'made' : 'pending')
      : verdict.result;

    const row = {
      event_id: event.id,
      bout_id: r.bout_id ?? null,
      fighter_id: r.fighter_id,
      contracted_limit_lbs: limit.contracted_limit_lbs,
      allowance_lbs: limit.allowance_lbs,
      limit_basis: limit.limit_basis,
      official_weight_lbs: measured ? r.official_weight_lbs : null,
      attempt_number: r.attempt_number ?? 1,
      result: r.result_override || result,
      over_by_lbs: verdict.over_by_lbs,
      catchweight_lbs: r.catchweight_lbs ?? null,
      weighed_at: r.weighed_at ?? null,
      source_url: r.source_url,
      source_name: r.source_name,
      source_kind: r.source_kind,
      source_published_at: r.source_published_at ?? null,
      detected_at: new Date(opts.now).toISOString(),
      first_seen_at: new Date(opts.now).toISOString(),
      last_seen_at: new Date(opts.now).toISOString(),
      raw_text: r.raw_text ?? null,
      provenance: {
        adapter: r.adapter,
        matched: r.matched ?? null,
        limit_reason: limit.reason,
        verdict: verdict.result,
        unmeasured_miss: verdict.result === 'missed_unmeasured',
        bout_resolved: Boolean(bout),
      },
      /* Carried for the status mirror; not a column. */
      _fighter_name: r.fighter_name,
      _unmeasured_miss: verdict.result === 'missed_unmeasured',
    };
    row.fingerprint = fingerprintOf(row, sha256);
    readings.push(row);
  }

  counters.readings = readings.length;
  counters.made = readings.filter((r) => r.result === 'made').length;
  counters.missed = readings.filter((r) => r.result === 'missed').length;
  counters.pending = readings.filter((r) => r.result === 'pending').length;
  counters.limit_unsupported = readings.filter((r) => r.limit_basis === 'unsupported').length;

  if (!opts.write) {
    console.log(`[weigh-ins] dry run (${plan.mode}): ${counters.readings} reading(s) from ${counters.sources_fetched} source(s) for ${event.name}`);
    return { status: 'dry_run', plan, event, readings, counters, duration_ms: Date.now() - started };
  }

  const write = await storeReadings(sb, readings, { now: opts.now });
  Object.assign(counters, write.counters);
  console.log(`[weigh-ins] ${plan.mode}: offered=${counters.offered} inserted=${counters.inserted} duplicate_noop=${counters.duplicate_noop} corrections=${counters.corrections} status_events=${counters.status_events}`);
  return { status: 'ok', plan, event, readings, counters, duration_ms: Date.now() - started };
}

const zero = () => ({
  sources_fetched: 0, sources_failed: 0, readings: 0, made: 0, missed: 0, pending: 0,
  limit_unsupported: 0, offered: 0, inserted: 0, duplicate_noop: 0, corrections: 0, status_events: 0,
});

/**
 * Store readings, count what actually landed, and mirror misses into status.
 *
 * Counters measure the DATABASE, not intent: under
 * `resolution=ignore-duplicates` a repeat succeeds and inserts nothing, so
 * `return=representation` is what distinguishes a new reading from the same
 * one seen again. A live pass re-reads the same page every three minutes; if a
 * no-op counted as a write, the number an operator checks would say the desk
 * is working while the table sat still.
 */
export async function storeReadings(sb, readings, { now = Date.now() } = {}) {
  const counters = { offered: readings.length, inserted: 0, duplicate_noop: 0, corrections: 0, status_events: 0, rejected: 0 };
  if (!readings.length) return { counters, inserted: [] };

  /* What we already hold for these fighters at this event, so a changed weight
   * becomes a correction chain rather than a silent second row. */
  const eventId = readings[0].event_id;
  const existing = await sb.select('ufc_weigh_in_results',
    `select=id,fighter_id,attempt_number,official_weight_lbs,result,source_kind,source_published_at,detected_at,fingerprint,superseded_at&event_id=eq.${eventId}&superseded_at=is.null`).catch(() => []);
  const currentByFighter = new Map(projectCurrent(existing.map((e) => ({ ...e, event_id: eventId }))).map((e) => [e.fighter_id, e]));
  const knownFingerprints = new Set(existing.map((e) => e.fingerprint));

  const fresh = [];
  const supersedes = [];
  for (const r of readings) {
    if (knownFingerprints.has(r.fingerprint)) { counters.duplicate_noop += 1; continue; }
    const prior = currentByFighter.get(r.fighter_id);
    /* A different reading for a fighter we already have is a correction, not a
     * replacement: the earlier number was on the page and somebody read it. */
    if (prior && prior.attempt_number === r.attempt_number && prior.official_weight_lbs !== r.official_weight_lbs) {
      r.supersedes_id = prior.id;
      r.correction_reason = `superseded by ${r.source_kind} reading at ${new Date(now).toISOString()}`;
      supersedes.push(prior.id);
      counters.corrections += 1;
    }
    fresh.push(r);
  }

  const columns = (r) => {
    const out = { ...r };
    delete out._fighter_name; delete out._unmeasured_miss;
    return out;
  };

  if (fresh.length) {
    try {
      const back = await sb.insert('ufc_weigh_in_results', fresh.map(columns),
        { onConflict: 'fingerprint', ignoreDuplicates: true, returning: true });
      counters.inserted = Array.isArray(back) ? back.length : 0;
      counters.duplicate_noop += fresh.length - counters.inserted;
      /* Mark what each correction replaced, after the replacement exists. */
      for (const id of supersedes) {
        await sb.patch('ufc_weigh_in_results', `id=eq.${id}`, { superseded_at: new Date(now).toISOString() });
      }
      counters.status_events = await mirrorMisses(sb, Array.isArray(back) ? back : [], readings, { now });
    } catch (e) {
      counters.rejected = fresh.length;
      console.error(`[weigh-ins] insert failed: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  return { counters };
}

/**
 * Mirror a miss into ufc_fighter_status_events, exactly once.
 *
 * The weigh-in row is the canonical record of the WEIGHT; the status event is
 * the record of the AVAILABILITY consequence, which is what the fighter page
 * and /injuries read. Both need to exist and neither is a copy of the other.
 *
 * Exactly once is enforced by the database: weigh_in_result_id carries a
 * partial unique index, so a replaying pass that somehow reached here twice
 * would collide rather than mint a second claim about a named athlete.
 *
 * NO MEDICAL INFERENCE. A missed cut is not an illness, an injury or a
 * diagnosis, and nothing here writes a clinical field. injury_type, body_part
 * and clinical_quote are absent from the row entirely.
 */
export async function mirrorMisses(sb, insertedRows, readings, { now = Date.now() } = {}) {
  const byFingerprint = new Map(readings.map((r) => [r.fingerprint, r]));
  const events = [];

  for (const row of insertedRows) {
    const source = byFingerprint.get(row.fingerprint);
    const isMiss = row.result === 'missed' || source?._unmeasured_miss;
    if (!isMiss) continue;
    events.push({
      fighter_id: row.fighter_id,
      status_type: 'weight_miss',
      state: 'active',
      event_id: row.event_id,
      bout_id: row.bout_id,
      /* Deterministic, from stored fields. Never composed by a model. */
      status_detail: row.over_by_lbs != null
        ? `Missed weight by ${row.over_by_lbs} lb (${row.official_weight_lbs} lb against ${Number(row.contracted_limit_lbs) + Number(row.allowance_lbs || 0)} lb)`
        : row.official_weight_lbs != null
          ? `Weighed ${row.official_weight_lbs} lb; contracted limit not published`
          : 'Reported to have missed weight; no figure published',
      source_url: row.source_url,
      source_name: row.source_name,
      source_kind: row.source_kind,
      source_published_at: row.source_published_at,
      detected_at: new Date(now).toISOString(),
      effective_at: row.weighed_at,
      confidence: row.source_kind === 'official' ? 0.95 : row.source_kind === 'commission' ? 0.92 : 0.8,
      weigh_in_result_id: row.id,
      provenance: {
        origin: 'weigh_in_pass',
        weigh_in_result_id: row.id,
        limit_basis: row.limit_basis,
        over_by_lbs: row.over_by_lbs,
      },
      fingerprint: sha256(['weigh-in-miss', row.fighter_id, row.event_id, row.id].join('|')),
    });
  }

  if (!events.length) return 0;
  const back = await sb.insert('ufc_fighter_status_events', events,
    { onConflict: 'fingerprint', ignoreDuplicates: true, returning: true });
  return Array.isArray(back) ? back.length : 0;
}

export { SOURCE_ADAPTERS, CADENCE };

/* CLI only. Importing this module must never fetch, write, or mirror. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('weighin_pass.mjs');
if (isCli) runWeighInPass(undefined, parseCliOptions(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
