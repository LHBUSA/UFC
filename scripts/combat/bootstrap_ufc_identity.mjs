#!/usr/bin/env node
// Bootstrap / refresh the UFC -> combat identity bridge.
//
// Default is read-only. --apply calls the migration-owned idempotent RPC;
// it never fetches an outside publisher and never writes any ufc_* table.
//
//   node scripts/combat/bootstrap_ufc_identity.mjs
//   node scripts/combat/bootstrap_ufc_identity.mjs --apply --json logs/combat-bridge.json
import { all, arg, has, pct, rpc, writeJson } from './common.mjs';

async function maybeCombatRows() {
  try {
    return await all('combat_fighters?select=id,ufc_fighter_id&ufc_fighter_id=not.is.null');
  } catch (e) {
    if (e.status === 404 || String(e.message).includes('combat_fighters')) return null;
    throw e;
  }
}

async function coverage() {
  try {
    const rows = await all('combat_ufc_bridge_coverage?select=*');
    return rows[0] || null;
  } catch (e) {
    if (e.status === 404 || String(e.message).includes('combat_ufc_bridge_coverage')) return null;
    throw e;
  }
}

const main = async () => {
  const apply = has('--apply');
  const ufc = await all('ufc_fighters?select=id,ufcstats_id,espn_athlete_id,name,dob,is_active');
  const linkedBefore = await maybeCombatRows();
  const before = {
    total_ufc_fighters: ufc.length,
    ufcstats_ids: ufc.filter((f) => f.ufcstats_id).length,
    espn_ids: ufc.filter((f) => f.espn_athlete_id).length,
    linked_combat_fighters: linkedBefore?.length ?? null,
  };

  console.log('\n=== UFC -> COMBAT IDENTITY BRIDGE ===');
  console.log(`UFC fighters       ${before.total_ufc_fighters}`);
  console.log(`UFC Stats ids      ${before.ufcstats_ids} (${pct(before.ufcstats_ids, before.total_ufc_fighters)})`);
  console.log(`ESPN ids           ${before.espn_ids} (${pct(before.espn_ids, before.total_ufc_fighters)})`);
  console.log(`Combat-linked      ${before.linked_combat_fighters == null ? 'migration not applied' : `${before.linked_combat_fighters} (${pct(before.linked_combat_fighters, before.total_ufc_fighters)})`}`);

  let sync = null;
  if (apply) {
    console.log('\nApplying idempotent combat_sync_ufc_identity() ...');
    sync = await rpc('combat_sync_ufc_identity');
    console.log(JSON.stringify(sync, null, 2));
  } else {
    console.log('\nREAD ONLY. Pass --apply only after the combat career migration is applied.');
  }

  const after = await coverage();
  if (after) {
    console.log('\nBridge coverage after run:');
    console.log(`linked ${after.linked_combat_fighters}/${after.total_ufc_fighters} (${pct(after.linked_combat_fighters, after.total_ufc_fighters)})`);
    console.log(`UFC Stats identities ${after.bridged_ufcstats_ids}/${after.ufcstats_ids}`);
    console.log(`ESPN identities      ${after.bridged_espn_ids}/${after.espn_ids}`);
    console.log(`pending reviews      ${after.pending_identity_reviews}`);
    console.log(`external bouts       ${after.external_bouts}`);
  }

  const report = { generated_at: new Date().toISOString(), mode: apply ? 'apply' : 'audit', before, sync, after };
  writeJson(arg('--json'), report);
};

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
