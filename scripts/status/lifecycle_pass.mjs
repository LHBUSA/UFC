#!/usr/bin/env node
/* Apply the status lifecycle: expire what its card outlived, resolve what a
 * source ended.
 *
 *   node scripts/status/lifecycle_pass.mjs [--write] [--today 2026-09-08]
 *
 * DEFAULT IS DRY RUN, like the collector. The decisions live in
 * lib/lifecycle.mjs and are pure; this file is only the part that reads rows
 * and writes state transitions, so every rule is testable without a database
 * and without the migration having been applied.
 *
 * Nothing here deletes. Expiry and resolution are state changes on rows that
 * stay where they are, so a fighter's history keeps the event, its source and
 * the card it was about — a page can still show that they withdrew from UFC
 * 319 in March; it just stops saying they are out today.
 *
 * NO MEDICAL INFERENCE. Read lib/lifecycle.mjs for what that rules out: an
 * injury with no card attached never expires by time here, at any age.
 */
import { Supabase, loadEnv } from '../news/lib.mjs';
import { planLifecycle } from './lib/lifecycle.mjs';

export function parseCliOptions(argv = []) {
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return { write: argv.includes('--write'), today: opt('--today', null) };
}

export function resolveOptions(options = {}) {
  const now = options.now ?? Date.now();
  return {
    write: Boolean(options.write),
    /* A date, not an instant: an event on the 14th is current all of the 14th
     * in UTC rather than until some local midnight nobody agreed on. */
    today: options.today || new Date(now).toISOString().slice(0, 10),
    now,
  };
}

export async function runLifecycle(injectedEnv, options = {}) {
  const opts = resolveOptions(options);
  const env = injectedEnv || loadEnv();
  const sb = new Supabase(env);

  /* Everything still open, plus the resolvers that might close them. A
   * resolver can be older than the pass window and still be the thing that
   * ended a status, so both are read by state rather than by recency. */
  const rows = await sb.select('ufc_fighter_status_events',
    'select=id,fighter_id,status_type,state,event_id,bout_id,source_kind,effective_at,source_published_at,detected_at'
    + '&or=(state.eq.active,status_type.in.(cleared,return))'
    + '&order=detected_at.desc&limit=2000');

  const eventIds = [...new Set(rows.map((r) => r.event_id).filter(Boolean))];
  const events = eventIds.length
    ? await sb.select('ufc_events', `select=id,event_date&id=in.(${eventIds.join(',')})`)
    : [];
  const eventDateById = new Map(events.map((e) => [e.id, e.event_date]));

  const plan = planLifecycle({ rows, eventDateById, today: opts.today });

  console.log(`[lifecycle] ${rows.length} row(s) considered as of ${opts.today}`);
  console.log(`[lifecycle] resolve=${plan.resolve.length} expire=${plan.expire.length} ambiguous=${plan.ambiguous.length}${opts.write ? '' : '  (dry run)'}`);
  for (const r of plan.resolve) console.log(`  resolve ${r.id}  <- ${r.resolved_by_event_id}  ${r.reason}`);
  for (const e of plan.expire) console.log(`  expire  ${e.id}  ${e.reason}`);
  for (const a of plan.ambiguous) console.log(`  LEFT ALONE ${a.id ?? a.fighter_id}  ${a.reason}`);

  if (!opts.write) return { ...plan, applied: 0, wrote: false, today: opts.today };

  const stamp = new Date(opts.now).toISOString();
  let applied = 0;
  /* One PATCH per row. There are single-digit numbers of these per pass and a
   * failed transition must not take the others with it. */
  for (const r of plan.resolve) {
    await sb.patch('ufc_fighter_status_events', `id=eq.${r.id}`,
      { state: 'resolved', resolved_by_event_id: r.resolved_by_event_id, updated_at: stamp });
    applied += 1;
  }
  for (const e of plan.expire) {
    await sb.patch('ufc_fighter_status_events', `id=eq.${e.id}`, { state: 'expired', updated_at: stamp });
    applied += 1;
  }
  console.log(`[lifecycle] applied ${applied} transition(s); 0 rows deleted`);
  return { ...plan, applied, wrote: true, today: opts.today };
}

/* CLI only. Importing this module must never transition anything. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('lifecycle_pass.mjs');
if (isCli) runLifecycle(undefined, parseCliOptions(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
