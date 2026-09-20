// ufc-record-alerts: the scheduler around src/recordAlerts.js, and nothing else.
//   scheduled  every 5 minutes: one record-health check
//   GET /health  public: alert state as classes and counts. Never a pick, never an id.
import { runRecordAlerts, recordAlertStatus } from './recordAlerts.js';

const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') return json({ service: 'ufc-record-alerts', health_url: String(env.RECORD_HEALTH_URL || ''), record_alerts: await recordAlertStatus(env) });
    return json({ error: 'not_found' }, 404);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runRecordAlerts(env).catch((e) => console.log(`[record-alerts] failed: ${e?.message || e}`)));
  },
};
