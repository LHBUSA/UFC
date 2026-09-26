/* Training & Corner — current-camp capture (migration 032).
 *
 * OWNER DECISION 2026-09-26: ESPN athlete `association` (id + name) is the UFC
 * current-camp signal. It is read from the athlete document this Worker already
 * fetches (Espn.athlete); there is no separate endpoint. `association.location`
 * is the fighter's national context, not the gym's, and is never read here.
 *
 * All history semantics live in SQL (public.ufc_training_record_association):
 *   first / confirmed (stamp only) / changed (+ AFFILIATION_CHANGED_OBSERVED) /
 *   absent (nothing written) / identity_mismatch (nothing written).
 * This module only extracts the field, calls that function, and counts. It
 * never throws into the ingest: a missed camp capture is a staleness, never a
 * reason to lose an ESPN pass.
 */
import { rpc } from './supabase.mjs';

export const CAMP_SWEEP = {
  max: 40,               // athlete documents per daily run, on top of those the pass already read
  recheckDays: 14,       // roster fighters
  bookedRecheckDays: 2,  // fighters on a card in the next bookedWindowDays
  bookedWindowDays: 21,
  rosterDays: 548,       // "a UFC bout in the last 18 months"
};

/** { id, name } from an ESPN athlete document, or null. Location is deliberately ignored. */
export function associationOf(doc) {
  const a = doc?.association;
  const id = a?.id != null ? String(a.id).trim() : '';
  const name = typeof a?.name === 'string' ? a.name.replace(/\s+/g, ' ').trim() : '';
  return id && name ? { id, name } : null;
}

export function newTrainingNotes() {
  return { first: 0, confirmed: 0, changed: 0, absent: 0, identity_mismatch: 0, errors: 0, changes: [], error_samples: [] };
}

/** Record one athlete read. `athlete` is the Espn.athlete() result (carries `association`). */
export async function captureAssociation(env, notes, fighter, athlete, capturedAt = new Date().toISOString()) {
  if (!notes || !fighter?.id || !fighter.espn_athlete_id || !athlete) return null;
  if (String(athlete.espn_athlete_id) !== String(fighter.espn_athlete_id)) { notes.identity_mismatch += 1; return null; }
  const assoc = athlete.association || null;
  try {
    const r = await rpc(env, 'ufc_training_record_association', {
      p_fighter_id: fighter.id,
      p_espn_athlete_id: String(fighter.espn_athlete_id),
      p_association_id: assoc?.id ?? null,
      p_association_name: assoc?.name ?? null,
      p_source_url: athlete.source_url,
      p_captured_at: capturedAt,
    });
    const action = String(r?.action || 'unknown');
    notes[action] = (notes[action] || 0) + 1;
    if (action === 'changed' && notes.changes.length < 25) {
      notes.changes.push({ fighter_id: fighter.id, name: fighter.name ?? null, to: assoc?.name ?? null, event_id: r.event_id ?? null });
    }
    return r;
  } catch (e) {
    notes.errors += 1;
    if (notes.error_samples.length < 5) notes.error_samples.push(String(e?.message || e).slice(0, 160));
    return null;
  }
}

/**
 * The active roster: a UFC-series bout in the last `rosterDays`, or a booked
 * UFC-series bout. Stale ufc_fighters.is_active is not consulted. Pure.
 * Returns Map fighter_id -> { booked_on: 'YYYY-MM-DD' | null, last_fought_on }.
 */
export function activeRoster({ bouts, events, resultsByBout, today, rosterDays = CAMP_SWEEP.rosterDays }) {
  const byId = new Map((events || []).map((e) => [e.id, e]));
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - rosterDays * 86400000).toISOString().slice(0, 10);
  const out = new Map();
  for (const b of bouts || []) {
    const ev = byId.get(b.event_id);
    if (!ev?.event_date) continue;
    if (ev.event_series && ev.event_series !== 'ufc') continue;
    if (['cancelled', 'replaced'].includes(b.status)) continue;
    const done = resultsByBout?.has?.(b.id);
    const booked = !done && ev.event_date >= today;
    const recent = done && ev.event_date >= cutoff && ev.event_date <= today;
    if (!booked && !recent) continue;
    for (const fid of [b.fighter_a_id, b.fighter_b_id]) {
      if (!fid) continue;
      const cur = out.get(fid) || { booked_on: null, last_fought_on: null };
      if (booked && (!cur.booked_on || ev.event_date < cur.booked_on)) cur.booked_on = ev.event_date;
      if (recent && (!cur.last_fought_on || ev.event_date > cur.last_fought_on)) cur.last_fought_on = ev.event_date;
      out.set(fid, cur);
    }
  }
  return out;
}

/**
 * Which roster fighters get an athlete read this run. Booked fighters first
 * (soonest card first), then never-observed, then stalest. A fighter whose
 * document was already read this run is skipped (its capture already ran).
 * `lastConfirmed`: Map fighter_id -> ISO of the latest ESPN observation stamp.
 */
export function planCampSweep({ roster, fighters, lastConfirmed, fetched, now = Date.now(), today, cfg = CAMP_SWEEP }) {
  const bookedHorizon = new Date(Date.parse(`${today}T00:00:00Z`) + cfg.bookedWindowDays * 86400000).toISOString().slice(0, 10);
  const due = [];
  for (const [fid, r] of roster) {
    const f = fighters.get(fid);
    if (!f?.espn_athlete_id || fetched?.has(fid)) continue;
    const soon = r.booked_on && r.booked_on <= bookedHorizon;
    const seen = lastConfirmed.get(fid);
    const ageDays = seen ? (now - Date.parse(seen)) / 86400000 : Infinity;
    if (ageDays < (soon ? cfg.bookedRecheckDays : cfg.recheckDays)) continue;
    due.push({ fid, soon: Boolean(soon), booked_on: r.booked_on || '9999-12-31', ageDays });
  }
  const stalest = (a, b) => (a.ageDays === b.ageDays ? 0 : a.ageDays > b.ageDays ? -1 : 1); // Infinity-safe
  due.sort((a, b) => (a.soon === b.soon ? 0 : a.soon ? -1 : 1) || a.booked_on.localeCompare(b.booked_on) || stalest(a, b));
  return { ids: due.slice(0, cfg.max).map((d) => d.fid), due: due.length };
}
