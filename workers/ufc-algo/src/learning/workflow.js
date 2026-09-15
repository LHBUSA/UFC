// LearnDaily: the Cloudflare Workflow that runs one daily learning attempt.
//
//   gate -> (NO_NEW_TRAINING_DATA | WAITING_FOR_DATA | FAILED: store_nodata)
//        -> dataset -> [Sunday: rebuild_plan -> rebuild_shard_* -> rebuild_compare]
//        -> train_validate -> store
//
// It can create at most one CHALLENGER training run. It cannot create or change
// a ufc_model_versions row and cannot touch a prediction; promotion is the
// owner-token /admin/promote route only.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { db } from '../supabase.js';
import { datasetStep, gateStep, rebuildCompare, rebuildPlan, rebuildShard, storeNoData, storeTrained, trainStep } from './daily.js';

const RETRY = { retries: { limit: 3, delay: '2 minutes', backoff: 'exponential' }, timeout: '20 minutes' };

export class LearnDaily extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const params = event.payload || {};
    const trigger = params.trigger === 'admin' ? 'admin' : 'cron';
    const now = params.now ? Date.parse(params.now) : Date.parse(event.timestamp);
    const q = db(env);
    const bucket = env.ARTIFACTS;

    const gate = await step.do('gate', RETRY, () => gateStep({ q, env, bucket, now }));
    const weekly = params.rebuild === true || (params.rebuild !== false && new Date(now).getUTCDay() === 0);

    let dataset = null;
    if (gate.decision.status === 'LEARN') dataset = await step.do('dataset', RETRY, () => datasetStep({ q, bucket, gate }));

    let drift = null;
    /* The weekly rebuild runs only on settled data: never while the gate is waiting for ingestion or has failed. */
    if (weekly && gate.champion && ['LEARN', 'NO_NEW_TRAINING_DATA'].includes(gate.decision.status)) {
      const shards = await step.do('rebuild_plan', RETRY, () => rebuildPlan({ q, runDate: gate.run_date }));
      const done = [];
      for (let i = 0; i < shards.length; i++) {
        done.push(await step.do(`rebuild_shard_${i}`, RETRY, () => rebuildShard({ q, bucket, runDate: gate.run_date, index: i, events: shards[i] })));
      }
      const incremental = dataset ? { sha: dataset.dataset_sha256, uri: dataset.dataset_uri } : { sha: gate.parent.sha, uri: gate.parent.uri };
      drift = await step.do('rebuild_compare', RETRY, async () => ({
        ...(await rebuildCompare({ bucket, shardKeys: done.map((d) => d.key), incremental })),
        shards: done.length, integrity_violation_count: done.reduce((a, d) => a + d.integrity_violation_count, 0), skipped: done.reduce((a, d) => a + d.skipped, 0),
      }));
      await step.do('rebuild_report', RETRY, async () => { await bucket.put(`learning/rebuilds/${gate.run_date}/report.json`, JSON.stringify({ gate: gate.decision, drift })); return true; });
      if (drift.drift) {
        /* The database was repaired since the incremental lineage: train on the full rebuild and flag it. */
        dataset = { dataset_sha256: drift.rebuilt_sha256, dataset_uri: drift.rebuilt_uri, training_bouts: drift.rebuilt_rows, added: drift.added, not_assembled: [], skipped: [], integrity: [] };
        if (gate.decision.status !== 'LEARN') gate.decision = { status: 'LEARN', newly_graded: 0, reason: 'weekly rebuild differs from the incremental dataset', bout_ids: [] };
      }
    }

    if (!dataset) {
      return step.do('store_nodata', RETRY, () => storeNoData({ q, env, gate, trigger }));
    }
    const trained = await step.do('train_validate', RETRY, () => trainStep({ q, env, bucket, gate, dataset, drift, now }));
    return step.do('store', RETRY, () => storeTrained({ q, env, gate, dataset, trained, drift, trigger }));
  }
}
