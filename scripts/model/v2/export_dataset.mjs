#!/usr/bin/env node
// Export the exact training dataset the frozen V2 candidate was fitted on, and
// refuse unless it re-hashes to the artifact's dataset_sha256.
//
//   PBE_MODEL_CACHE=<clean extract> node scripts/model/v2/export_dataset.mjs <out.jsonl>
//
// One line per bout, JSON [bout_id, event_date, label, x], in training order:
// byte-for-byte the lines freeze_candidate.mjs hashed. Read-only.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { cacheDir } from '../common.mjs';
import { trainingOrder } from '../walkforward_core.mjs';
import { loadV2 } from './dataset_v2.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: export_dataset.mjs <out.jsonl>');
const artifact = JSON.parse(fs.readFileSync(new URL('./artifacts/pbe-fight-model-v2-candidate-elo.json', import.meta.url), 'utf8'));
const { dataset, withX } = await loadV2(cacheDir());
const cutoff = artifact.training.cutoff_exclusive;
const rows = dataset.filter((r) => r.graded && r.event_date < cutoff).sort(trainingOrder).map((r) => withX(r, 'c2elo'));
const text = rows.map((r) => JSON.stringify([r.bout_id, r.event_date, r.label, r.x])).join('\n');
const sha = createHash('sha256').update(text).digest('hex');
if (sha !== artifact.training.dataset_sha256) throw new Error(`dataset does not re-hash: ${sha} != ${artifact.training.dataset_sha256}`);
fs.writeFileSync(out, text);
console.log(JSON.stringify({ out, rows: rows.length, sha256: sha }));
