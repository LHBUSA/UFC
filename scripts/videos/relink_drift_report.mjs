#!/usr/bin/env node
/* Relink drift receipt. READ-ONLY: it reads an --explain file and SELECTs names; it never writes.
 *
 *   node scripts/videos/ingest_youtube.mjs --relink --dry-run --explain --explain-out drift.json
 *   node scripts/videos/relink_drift_report.mjs drift.json [out.json]
 *
 * Answers, with counts rather than guesses, WHY a full relink would rewrite the rows it would:
 * each lost or changed event link is tested against the resolver's own window (events within
 * +-WINDOW_DAYS of the run date), because a relink scores every stored video against the cards
 * around TODAY, not around the day the video was published.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Supabase, loadEnv, WINDOW_DAYS } from './lib.mjs';
import { ageBand, tally, BUCKETS } from './relink_diff.mjs';

const [inFile, outFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!inFile) { console.error('usage: relink_drift_report.mjs <explain.json> [out.json]'); process.exit(2); }
const explain = JSON.parse(readFileSync(inFile, 'utf8'));
const now = explain.generated_at;
const rows = explain.rows;
const sb = new Supabase(loadEnv());

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
async function byIds(table, select, ids) {
  const out = new Map();
  for (const part of chunk([...new Set(ids.filter(Boolean))], 60)) {
    for (const r of await sb.select(table, `select=${select}&id=in.(${part.map((x) => `"${x}"`).join(',')})`)) out.set(r.id, r);
  }
  return out;
}
const events = await byIds('ufc_events', 'id,name,event_date', rows.flatMap((r) => [r.stored.event_id, r.proposed.event_id]));
const fighters = await byIds('ufc_fighters', 'id,name', rows.flatMap((r) => [...r.removed_fighters, ...r.added_fighters]));
const bouts = await byIds('ufc_bouts', 'id,event_id,fighter_a_id,fighter_b_id', rows.flatMap((r) => [r.stored.bout_id, r.proposed.bout_id]));

/* A stored event is 'in the window' relative to the VIDEO's publish date, which is what a relink now resolves against
 * (pass --run-date-window to reproduce the pre-fix audit, which measured against the run date's window). */
const RUN_DATE_WINDOW = process.argv.includes('--run-date-window');
const inWindow = (d, publishedAt) => {
  if (!d) return false;
  if (RUN_DATE_WINDOW) return d >= explain.window.lo && d <= explain.window.hi;
  const t = Date.parse(publishedAt || ''); if (!Number.isFinite(t)) return false;
  return Math.abs(Date.parse(`${d}T00:00:00Z`) - t) / 86400e3 <= WINDOW_DAYS;
};
const evName = (id) => (id ? `${events.get(id)?.name || id} (${events.get(id)?.event_date || '?'})` : null);
const daysFromEvent = (r, id) => { const e = events.get(id); return e && r.published_at ? Math.round((Date.parse(r.published_at) - Date.parse(`${e.event_date}T00:00:00Z`)) / 86400e3) : null; };

/* ---- root cause, measured per row ------------------------------------- */
function causeOf(r) {
  const causes = [];
  const se = events.get(r.stored.event_id), pe = events.get(r.proposed.event_id);
  if (r.buckets.includes(BUCKETS.B)) causes.push(se && !inWindow(se.event_date, r.published_at) ? 'stored_event_outside_todays_window' : 'event_lost_inside_window');
  if (r.buckets.includes(BUCKETS.C)) causes.push(se && !inWindow(se.event_date, r.published_at) ? 'stored_event_outside_todays_window_then_rematched' : 'event_rematched_inside_window');
  if (r.buckets.includes(BUCKETS.E) || r.buckets.includes(BUCKETS.F)) causes.push(se && !inWindow(se.event_date, r.published_at) ? 'bout_followed_event_out_of_window' : 'bout_changed_inside_window');
  if (r.buckets.includes(BUCKETS.A)) causes.push('new_event_match');
  if (r.buckets.includes(BUCKETS.G) || r.buckets.includes(BUCKETS.H) || r.buckets.includes(BUCKETS.I)) causes.push('fighter_scope_recomputed');
  if (r.buckets.includes(BUCKETS.J)) causes.push('article_link_recomputed');
  if (r.fields.includes('language')) causes.push(`language_restated:${r.stored.language}->${r.proposed.language}`);
  if (r.fields.includes('tuf')) causes.push('tuf_tag_recomputed');
  if (r.fields.length === 1 && r.fields[0] === 'linking') causes.push('linking_evidence_shape_only');
  if (!pe && !se && !causes.length) causes.push('other');
  return causes;
}

const enriched = rows.map((r) => ({
  id: r.id, channel: r.channel, title: r.title, published_at: r.published_at, age: ageBand(r.published_at, now), risk: r.risk, buckets: r.buckets, fields: r.fields, causes: causeOf(r),
  stored_event: evName(r.stored.event_id), proposed_event: evName(r.proposed.event_id),
  stored_event_in_window: r.stored.event_id ? inWindow(events.get(r.stored.event_id)?.event_date, r.published_at) : null,
  published_days_from_stored_event: daysFromEvent(r, r.stored.event_id), published_days_from_proposed_event: daysFromEvent(r, r.proposed.event_id),
  bout: r.stored.bout_id === r.proposed.bout_id ? undefined : { stored: r.stored.bout_id, proposed: r.proposed.bout_id, stored_bout_event: evName(bouts.get(r.stored.bout_id)?.event_id) },
  fighters_removed: r.removed_fighters.map((id) => fighters.get(id)?.name || id), fighters_added: r.added_fighters.map((id) => fighters.get(id)?.name || id),
  confidence: r.stored.resolver_confidence === r.proposed.resolver_confidence ? undefined : `${r.stored.resolver_confidence}->${r.proposed.resolver_confidence}`,
  link_status: r.stored.link_status === r.proposed.link_status ? undefined : `${r.stored.link_status}->${r.proposed.link_status}`,
  review_reason: r.stored.review_reason === r.proposed.review_reason ? undefined : `${r.stored.review_reason}->${r.proposed.review_reason}`,
  language: r.stored.language === r.proposed.language ? undefined : `${r.stored.language}->${r.proposed.language}`,
  destructive: r.destructive || [], stored_linking: r.stored.linking, proposed_linking: r.proposed.linking,
}));

const pub = enriched.map((r) => r.published_at).filter(Boolean).sort();
const summary = {
  generated_at: now, resolver_window: { ...explain.window, days: WINDOW_DAYS, events: explain.events_in_window.length },
  total_changed: enriched.length,
  risk: tally(enriched, (r) => r.risk), buckets: tally(enriched, (r) => r.buckets), fields: tally(enriched, (r) => r.fields),
  causes: tally(enriched, (r) => r.causes.map((c) => c.replace(/:.*/, ''))), language_moves: tally(enriched, (r) => r.language || []),
  age: tally(enriched, (r) => r.age), channel: tally(enriched, (r) => r.channel), risk_by_age: tally(enriched, (r) => `${r.age} ${r.risk}`), risk_by_channel: tally(enriched, (r) => `${r.channel} ${r.risk}`),
  oldest_published: pub[0], newest_published: pub[pub.length - 1],
  stored_event_top: tally(enriched.filter((r) => r.fields.includes('event_id')), (r) => r.stored_event || '(none)'),
  proposed_event_top: tally(enriched.filter((r) => r.fields.includes('event_id')), (r) => r.proposed_event || '(none)'),
  event_lost: { total: enriched.filter((r) => r.buckets.includes(BUCKETS.B)).length, stored_event_outside_window: enriched.filter((r) => r.buckets.includes(BUCKETS.B) && r.stored_event_in_window === false).length },
  event_changed: { total: enriched.filter((r) => r.buckets.includes(BUCKETS.C)).length, stored_event_outside_window: enriched.filter((r) => r.buckets.includes(BUCKETS.C) && r.stored_event_in_window === false).length },
  destructive: tally(enriched, (r) => r.destructive), blocked_by_write_guard: enriched.filter((r) => r.destructive.length).length, held: { article_links: (explain.held || []).filter((h) => h.article_id).length, status_flips: (explain.held || []).filter((h) => h.link_status).length, publish_date_unavailable: (explain.held || []).filter((h) => h.publish_date_unavailable).length },
  confidence_moves: tally(enriched, (r) => r.confidence || []), status_moves: tally(enriched, (r) => r.link_status || []),
};
console.log(JSON.stringify(summary, null, 1));
if (outFile) { writeFileSync(outFile, `${JSON.stringify({ summary, rows: enriched }, null, 1)}\n`); console.error(`wrote ${outFile}`); }
