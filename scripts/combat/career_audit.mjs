#!/usr/bin/env node
// Read-only audit of the combat career overlay once the migration is applied.
// Shows bridge completeness, source policy, and how much non-UFC history has
// actually been added without hiding the UFC/full-career distinction.
//
//   node scripts/combat/career_audit.mjs --json logs/combat-career-audit.json
import { all, arg, pct, writeJson } from './common.mjs';

const main = async () => {
  const [coverageRows, sources, careers, promotions, events, bouts, reviews] = await Promise.all([
    all('combat_ufc_bridge_coverage?select=*'),
    all('combat_sources?select=source_key,source_name,source_kind,access_mode,rights_state,redistribution_allowed,enabled,reviewed_at&order=source_key.asc'),
    all('combat_fighter_career_summary?select=combat_fighter_id,ufc_fighter_id,display_name,career_appearances,ufc_appearances,external_appearances,wins,losses,draws,no_contests,promotions_seen,first_bout_date,last_bout_date'),
    all('combat_promotions?select=id,slug,name'),
    all('combat_events?select=id,promotion_id,event_date,status'),
    all('combat_bouts?select=id,event_id,status,competition_class'),
    all('combat_identity_review_queue?select=id,status,reason,created_at'),
  ]);

  const c = coverageRows[0] || {};
  const externalized = careers.filter((r) => Number(r.external_appearances || 0) > 0);
  const promotionById = new Map(promotions.map((p) => [p.id, p]));
  const eventById = new Map(events.map((e) => [e.id, e]));
  const promotionBoutCounts = new Map();
  for (const b of bouts) {
    const e = eventById.get(b.event_id);
    const p = e ? promotionById.get(e.promotion_id) : null;
    const key = p?.slug || 'unknown';
    promotionBoutCounts.set(key, (promotionBoutCounts.get(key) || 0) + 1);
  }

  const top = [...externalized]
    .sort((a, b) => Number(b.external_appearances || 0) - Number(a.external_appearances || 0))
    .slice(0, 25);

  const report = {
    generated_at: new Date().toISOString(),
    bridge: c,
    career: {
      fighters: careers.length,
      fighters_with_external_history: externalized.length,
      fighters_with_external_history_pct: careers.length ? Number(((externalized.length / careers.length) * 100).toFixed(2)) : 0,
      external_bouts: bouts.length,
      external_events: events.length,
      promotion_bout_counts: Object.fromEntries([...promotionBoutCounts.entries()].sort((a, b) => b[1] - a[1])),
      top_externalized_fighters: top,
    },
    source_policy: sources,
    pending_identity_reviews: reviews.filter((r) => r.status === 'pending').length,
  };

  console.log('\n=== COMBAT CAREER GRAPH AUDIT ===');
  console.log(`UFC identity bridge  ${c.linked_combat_fighters || 0}/${c.total_ufc_fighters || 0} (${pct(c.linked_combat_fighters || 0, c.total_ufc_fighters || 0)})`);
  console.log(`External MMA bouts   ${bouts.length}`);
  console.log(`External MMA events  ${events.length}`);
  console.log(`Fighters enriched    ${externalized.length}/${careers.length} (${pct(externalized.length, careers.length)})`);
  console.log(`Identity reviews     ${report.pending_identity_reviews}`);
  console.log('\nSource gates:');
  for (const s of sources) {
    console.log(`  ${s.source_key.padEnd(22)} ${String(s.access_mode).padEnd(16)} enabled=${String(s.enabled).padEnd(5)} redistribute=${s.redistribution_allowed}`);
  }
  if (top.length) {
    console.log('\nMost externally enriched fighters:');
    for (const r of top) console.log(`  ${String(r.external_appearances).padStart(3)} external / ${String(r.ufc_appearances).padStart(3)} UFC  ${r.display_name}`);
  }

  writeJson(arg('--json'), report);
};

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
