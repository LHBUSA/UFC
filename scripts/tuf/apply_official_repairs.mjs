#!/usr/bin/env node
/**
 * Apply the official repairs ledger to the TUF season files.
 *
 *   node scripts/tuf/apply_official_repairs.mjs [--check]
 *
 * The season files were drafted from Wikipedia. Where an official UFC source
 * states a fact the draft got wrong or left out, the correction lives in
 * web/data/tuf/official_repairs.json with the page, its publish time and the
 * sentence that carries the fact. This script writes those corrections into
 * the season files and nothing else.
 *
 * It is idempotent and it is suspicious. A repair names the value it expects
 * to replace; if the file holds something else, that is a change nobody has
 * looked at, and the repair is refused rather than applied over it. A repair
 * already applied is recognised and left alone, so the importer can call this
 * after every draft without stacking duplicate sources.
 *
 * --check reports what would change and exits non-zero if the files are not
 * in the state the ledger describes. It writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'web', 'data', 'tuf');
export const LEDGER_FILE = path.join(DATA, 'official_repairs.json');

const same = (x, y) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

function findStage(season, weightClass, stage) {
  const div = (season.bracket || []).find((d) => d.weight_class === weightClass);
  return div?.stages.find((s) => s.stage === stage) || null;
}

function findBout(season, ref) {
  const st = findStage(season, ref.weight_class, ref.stage);
  if (!st) return { error: `no ${ref.weight_class}/${ref.stage} stage` };
  const hits = st.bouts.filter((b) => (b.a === ref.a && b.b === ref.b) || (b.a === ref.b && b.b === ref.a));
  if (hits.length !== 1) return { error: `${hits.length} bouts match ${ref.a} vs ${ref.b} in ${ref.weight_class}/${ref.stage}`, stage: st };
  return { bout: hits[0], stage: st };
}

function sourceEntry(repair, fields) {
  return {
    repair: repair.id,
    fields,
    ...repair.source,
    ...(repair.corroboration ? { corroboration: repair.corroboration.map((c) => c.url) } : {}),
  };
}

function addSource(target, entry) {
  target.sources = target.sources || [];
  if (!target.sources.some((s) => s.repair === entry.repair)) target.sources.push(entry);
}

function resolveConflicts(season, needles, repair) {
  const list = season._conflicts || [];
  const keep = [];
  const resolved = season._resolved_conflicts || [];
  let n = 0;
  for (const c of list) {
    if (needles.some((needle) => String(c.detail || '').includes(needle))) {
      resolved.push({ ...c, resolved_by: repair.id, resolved_with: repair.source.url, resolution: repair.why });
      n += 1;
    } else keep.push(c);
  }
  if (n) {
    season._conflicts = keep;
    season._resolved_conflicts = resolved;
  }
  return n;
}

/**
 * Apply every ledger repair for one season, in place. Returns a log and a
 * list of refusals; the caller decides whether a refusal is fatal.
 */
export function applyRepairsToSeason(season, inventoryRow, ledger) {
  const log = [];
  const refused = [];
  for (const r of ledger.repairs.filter((x) => x.season === season.slug)) {
    if (r.op === 'patch_bout') {
      const { bout, error } = findBout(season, r.bout);
      if (error) { refused.push(`${r.id}: ${error}`); continue; }
      const applied = Object.entries(r.set).every(([k, v]) => same(bout[k], v));
      if (applied) { addSource(bout, sourceEntry(r, Object.keys(r.set))); log.push(`${r.id}: already applied`); }
      else {
        const stale = Object.entries(r.expect || {}).filter(([k, v]) => !same(bout[k], v));
        if (stale.length) { refused.push(`${r.id}: expected ${stale.map(([k, v]) => `${k}=${JSON.stringify(v)} (found ${JSON.stringify(bout[k])})`).join(', ')}`); continue; }
        for (const [k, v] of Object.entries(r.set)) bout[k] = v;
        addSource(bout, sourceEntry(r, Object.keys(r.set)));
        log.push(`${r.id}: applied ${Object.keys(r.set).join(', ')}`);
      }
    } else if (r.op === 'add_bout') {
      const st = findStage(season, r.bout.weight_class, r.bout.stage);
      if (!st) { refused.push(`${r.id}: no ${r.bout.weight_class}/${r.bout.stage} stage`); continue; }
      const existing = st.bouts.find((b) => (b.a === r.value.a && b.b === r.value.b) || (b.a === r.value.b && b.b === r.value.a));
      if (existing) { addSource(existing, sourceEntry(r, Object.keys(r.value))); log.push(`${r.id}: already present`); }
      else {
        const bout = { ...r.value };
        addSource(bout, sourceEntry(r, Object.keys(r.value)));
        st.bouts.push(bout);
        log.push(`${r.id}: added`);
      }
    } else if (r.op === 'close_stages') {
      for (const ref of r.stages) {
        const st = findStage(season, ref.weight_class, ref.stage);
        if (!st) { refused.push(`${r.id}: no ${ref.weight_class}/${ref.stage} stage`); continue; }
        if (st.status === 'unverified' || st.note !== r.note) {
          delete st.status;
          st.note = r.note;
          addSource(st, sourceEntry(r, ['status', 'note']));
          log.push(`${r.id}: closed ${ref.stage}`);
        }
      }
      if (r.set_coverage && inventoryRow && inventoryRow.coverage !== r.set_coverage) {
        log.push(`${r.id}: coverage ${inventoryRow.coverage} -> ${r.set_coverage}`);
        inventoryRow.coverage = r.set_coverage;
      }
    } else {
      refused.push(`${r.id}: unknown op ${r.op}`);
      continue;
    }
    if (r.resolves_conflict) {
      const n = resolveConflicts(season, [].concat(r.resolves_conflict), r);
      if (n) log.push(`${r.id}: resolved ${n} conflict(s)`);
    }
    if (r.add_conflict) {
      season._conflicts = season._conflicts || [];
      if (!season._conflicts.some((c) => c.repair === r.id)) {
        season._conflicts.push({ ...r.add_conflict, repair: r.id });
        log.push(`${r.id}: recorded conflict`);
      }
    }
  }
  if (ledger.repairs.some((x) => x.season === season.slug)) {
    const prov = season._provenance || (season._provenance = {});
    prov.official_repairs = 'web/data/tuf/official_repairs.json';
    prov.precedence = ledger._policy.precedence;
  }
  return { log, refused };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  const check = process.argv.includes('--check');
  const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  const invFile = path.join(DATA, 'seasons.json');
  const inventory = JSON.parse(fs.readFileSync(invFile, 'utf8'));
  const slugs = [...new Set(ledger.repairs.map((r) => r.season))];
  let changedAny = false;
  let refusedAny = false;
  for (const slug of slugs) {
    const file = path.join(DATA, 'seasons', `${slug}.json`);
    const before = fs.readFileSync(file, 'utf8');
    const season = JSON.parse(before);
    const row = inventory.seasons.find((s) => s.slug === slug);
    const { log, refused } = applyRepairsToSeason(season, row, ledger);
    for (const l of log) console.log(`  ${l}`);
    for (const x of refused) { console.error(`  REFUSED ${x}`); refusedAny = true; }
    const after = JSON.stringify(season, null, 2) + '\n';
    if (after !== before) {
      changedAny = true;
      if (!check) fs.writeFileSync(file, after);
      console.log(`${slug}: ${check ? 'would change' : 'written'}`);
    }
  }
  const invAfter = JSON.stringify(inventory, null, 2) + '\n';
  if (invAfter !== fs.readFileSync(invFile, 'utf8')) {
    changedAny = true;
    if (!check) fs.writeFileSync(invFile, invAfter);
    console.log(`seasons.json: ${check ? 'would change' : 'written'}`);
  }
  if (refusedAny || (check && changedAny)) process.exitCode = 1;
}
