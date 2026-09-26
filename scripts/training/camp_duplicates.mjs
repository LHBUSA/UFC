#!/usr/bin/env node
// Duplicate-candidate report for training camps (read-only). Nothing is merged here:
// merges are reviewed and done with `enrich.mjs merge-camp` (migration 033).
//
//   node scripts/training/camp_duplicates.mjs            # markdown to stdout
//
// Tier 1: same normalized name, different ESPN ids. Tier 2: same name after dropping
// generic words (MMA, Team, Academy, Gym, FC, ...). Already-merged camps are excluded.
import { getAll } from './lib.mjs';

const camps = (await getAll('ufc_training_camps', 'id,canonical_name,slug,name_norm,espn_association_id,merged_into')).filter((c) => !c.merged_into);
const cur = await getAll('ufc_fighter_training_current', 'fighter_id,current_camp', 'fighter_id');
const cnt = new Map();
for (const r of cur) if (r.current_camp) cnt.set(r.current_camp.camp_id, (cnt.get(r.current_camp.camp_id) || 0) + 1);
const GENERIC = new Set(['mma', 'team', 'academy', 'gym', 'fc', 'fight', 'fighting', 'club', 'the', 'de', 'martial', 'arts', 'training', 'center', 'centre', 'bjj', 'jiu', 'jitsu', 'jiujitsu', 'muay', 'thai', 'and', 'x']);
const loose = (n) => n.replace(/&/g, ' and ').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !GENERIC.has(t)).join(' ');
const group = (keyf) => {
  const m = new Map();
  for (const c of camps) { const k = keyf(c); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(c); }
  return [...m.entries()].filter(([, v]) => v.length > 1);
};
const exact = group((c) => c.name_norm);
const exactIds = new Set(exact.flatMap(([, v]) => v.map((c) => c.id)));
const looseG = group((c) => loose(c.canonical_name)).filter(([, v]) => !v.every((c) => exactIds.has(c.id)));
const fmt = (v) => v.map((c) => `\`${c.canonical_name}\` (espn ${c.espn_association_id}, ${cnt.get(c.id) || 0} fighters, slug:${c.slug})`).join(' / ');
let md = `# Camp duplicate candidates (generated ${new Date().toISOString().slice(0, 10)})\n\n${camps.length} canonical camps. Nothing is merged by name automatically.\n\n`;
md += `## Tier 1: same normalized name, different ESPN ids (${exact.length})\n\n${exact.map(([, v]) => `- ${fmt(v)}`).join('\n') || '- none'}\n\n`;
md += `## Tier 2: same name after dropping generic words (${looseG.length})\n\n${looseG.map(([k, v]) => `- **${k}**: ${fmt(v)}`).join('\n') || '- none'}\n`;
console.log(md);
