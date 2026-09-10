/* ufc-media — portraits, images, hero assets, credits.
 *
 * PROBE BUILD. Only /health and /admin/probe-resize exist yet: the portrait
 * pipeline's one Worker-incompatible step is image derivation, and whether
 * Cloudflare image transformations are available on this account decides how
 * that step is written. Guessing and finding out at the end would mean building
 * the whole lane on an assumption.
 */
import { derive, imageSize } from './derive.mjs';

const WORKER = 'ufc-media';
const VERSION = 'v0.0.1-probe';
const json = (b, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function authorized(req, env) {
  const expected = String(env.ADMIN_TRIGGER_TOKEN || '');
  if (!expected) return false;
  const presented = String(req.headers.get('x-pbe-admin-token') || '');
  if (presented.length !== expected.length) return false;
  let d = 0;
  for (let i = 0; i < expected.length; i += 1) d |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return json({ service: WORKER, version: VERSION, stage: 'probe', lanes: ['portraits (pending)'],
        requirements: { SUPABASE_URL: Boolean(env.SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY: Boolean(env.SUPABASE_SERVICE_ROLE_KEY), ADMIN_TRIGGER_TOKEN: Boolean(env.ADMIN_TRIGGER_TOKEN) } });
    }
    if (req.method !== 'POST' || !authorized(req, env)) return json({ error: 'not_found' }, 404);

    if (url.pathname === '/admin/probe-resize') {
      const target = url.searchParams.get('url')
        || 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/Islam_Makhachev_2019.jpg/1200px-Islam_Makhachev_2019.jpg';
      const original = await fetch(target, { headers: { 'User-Agent': 'PropBetEdgeUFC/1.1 (https://ufc.propbetedge.ai)' } });
      const origBytes = original.ok ? new Uint8Array(await original.arrayBuffer()) : null;
      const card = await derive(target, { width: 800, height: 1000 });
      const thumb = await derive(target, { width: 320, height: 400 });
      return json({
        service: WORKER,
        target,
        original: { http: original.status, size: origBytes ? imageSize(origBytes) : null, bytes: origBytes?.length ?? null },
        card: { ok: card.ok, width: card.width, height: card.height, bytes: card.bytes?.length ?? null, reason: card.reason ?? null },
        thumb: { ok: thumb.ok, width: thumb.width, height: thumb.height, bytes: thumb.bytes?.length ?? null, reason: thumb.reason ?? null },
        verdict: card.ok && thumb.ok
          ? 'image transformations ARE available; derivatives can be produced in-Worker'
          : 'image transformations are NOT available from this Worker; derivatives need another engine',
      });
    }
    return json({ error: 'not_found' }, 404);
  },
};
