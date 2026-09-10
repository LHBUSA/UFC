#!/usr/bin/env node
// Build the first Career DNA enrichment queue from our own UFC graph only.
// No outside source is contacted. Ranked + near-term booked fighters rise to
// the top so the first non-UFC career work improves visible product surfaces.
//
//   node scripts/combat/build_pilot_queue.mjs --limit 100 --json logs/combat-pilot.json
import { all, arg, writeJson } from './common.mjs';

const LIMIT = Math.max(1, Number(arg('--limit', '100')) || 100);

async function optional(resource) {
  try { return await all(resource); }
  catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

const main = async () => {
  const [fighters, events, bouts, rankDates, career] = await Promise.all([
    all('ufc_fighters?select=id,name,nickname,dob,is_active,ufcstats_id,espn_athlete_id'),
    all('ufc_events?select=id,name,event_date,card_status&order=event_date.asc'),
    all('ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,status'),
    optional('ufc_rankings?select=snapshot_date&order=snapshot_date.desc&limit=1'),
    optional('combat_fighter_career_summary?select=combat_fighter_id,ufc_fighter_id,career_appearances,ufc_appearances,external_appearances,promotions_seen'),
  ]);

  const latestRankDate = rankDates[0]?.snapshot_date || null;
  const rankings = latestRankDate
    ? await all(`ufc_rankings?select=fighter_id,division,is_womens,is_p4p,rank&snapshot_date=eq.${latestRankDate}&fighter_id=not.is.null`)
    : [];

  const today = new Date().toISOString().slice(0, 10);
  const future = events.filter((e) => e.event_date && e.event_date >= today && e.card_status !== 'complete').slice(0, 3);
  const eventPriority = new Map(future.map((e, i) => [e.id, 100 - (i * 20)]));
  const booked = new Map();
  for (const b of bouts) {
    const p = eventPriority.get(b.event_id);
    if (!p || b.status === 'cancelled' || b.status === 'replaced') continue;
    for (const fid of [b.fighter_a_id, b.fighter_b_id]) {
      const cur = booked.get(fid) || { score: 0, event_ids: [] };
      cur.score = Math.max(cur.score, p);
      if (!cur.event_ids.includes(b.event_id)) cur.event_ids.push(b.event_id);
      booked.set(fid, cur);
    }
  }

  const rankByFighter = new Map();
  for (const r of rankings) {
    const cur = rankByFighter.get(r.fighter_id) || [];
    cur.push(r);
    rankByFighter.set(r.fighter_id, cur);
  }
  const careerByUfc = new Map(career.map((r) => [r.ufc_fighter_id, r]));
  const eventById = new Map(future.map((e) => [e.id, e]));

  const queue = fighters.map((f) => {
    const rs = rankByFighter.get(f.id) || [];
    const book = booked.get(f.id);
    const c = careerByUfc.get(f.id) || null;
    const champion = rs.some((r) => Number(r.rank) === 0);
    let priority = 0;
    const reasons = [];
    if (champion) { priority += 130; reasons.push('champion'); }
    else if (rs.length) { priority += 100; reasons.push('ranked'); }
    if (book) { priority += book.score; reasons.push('next_3_cards'); }
    if (f.is_active === true) { priority += 20; reasons.push('active'); }
    if (!c || Number(c.external_appearances || 0) === 0) { priority += 25; reasons.push('no_external_career_rows'); }
    if (f.ufcstats_id && f.espn_athlete_id) { priority += 10; reasons.push('two_verified_ufc_namespaces'); }
    return {
      priority,
      reasons,
      ufc_fighter_id: f.id,
      combat_fighter_id: c?.combat_fighter_id || null,
      name: f.name,
      nickname: f.nickname,
      dob: f.dob,
      is_active: f.is_active,
      ufcstats_id: f.ufcstats_id,
      espn_athlete_id: f.espn_athlete_id,
      rankings: rs,
      upcoming_events: (book?.event_ids || []).map((id) => eventById.get(id)).filter(Boolean),
      ufc_appearances: c?.ufc_appearances ?? null,
      external_appearances: c?.external_appearances ?? null,
      promotions_seen: c?.promotions_seen ?? null,
    };
  }).filter((q) => q.priority > 0)
    .sort((a, b) => (b.priority - a.priority) || a.name.localeCompare(b.name))
    .slice(0, LIMIT);

  console.log('\n=== COMBAT CAREER PILOT QUEUE ===');
  console.log(`latest rankings: ${latestRankDate || 'unavailable'} · next cards: ${future.length} · selected: ${queue.length}`);
  for (const q of queue.slice(0, 30)) {
    const ext = q.external_appearances == null ? '?' : q.external_appearances;
    console.log(`${String(q.priority).padStart(3)}  ${q.name.padEnd(28).slice(0, 28)}  UFC=${String(q.ufc_appearances ?? '?').padStart(3)}  external=${String(ext).padStart(3)}  ${q.reasons.join(',')}`);
  }
  if (queue.length > 30) console.log(`... ${queue.length - 30} more; use --json for the full queue`);

  writeJson(arg('--json'), {
    generated_at: new Date().toISOString(),
    latest_rankings_snapshot: latestRankDate,
    upcoming_events: future,
    count: queue.length,
    queue,
  });
};

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
