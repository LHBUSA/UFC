// Parity harness ONLY. Not deployed, no routes, no bindings, no secrets.
//
// `wrangler dev` runs this in workerd so the runtime parity gate can compare
// the artifact hash produced by the engine under workerd with the hash
// produced under Node for the same fixture. The production Worker (Phase 4)
// is a separate design: storage, locks, entitlement and admin routes are not
// here on purpose.

import { simulate } from './engine/simulate.mjs';
import { SIMULATOR_VERSION } from './engine/params.mjs';
import fx1 from '../fixtures/ufc333_volkanovski_evloev.json';
import fx2 from '../fixtures/ufc331_steveson_sharaf.json';
import fx3 from '../fixtures/ufc331_aswell_yoo.json';
import fx4 from '../fixtures/ufc331_pitbull_choi.json';

const FIXTURES = { ufc333_volkanovski_evloev: fx1, ufc331_steveson_sharaf: fx2, ufc331_aswell_yoo: fx3, ufc331_pitbull_choi: fx4 };

function request(fx, nSims) {
  return { fighter_a: fx.fighter_a, fighter_b: fx.fighter_b, anchor: fx.anchor, settings: { scheduled_rounds: fx.bout.scheduled_rounds, weight_class: fx.bout.weight_class, is_title: fx.bout.is_title, is_womens: fx.bout.is_womens }, n_sims: nSims };
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true, simulator_version: SIMULATOR_VERSION, runtime: 'workerd', harness: 'parity-only' });
    if (url.pathname === '/parity') {
      const nSims = Number(url.searchParams.get('n') || 10000);
      const only = url.searchParams.get('fixture');
      const out = {};
      for (const [name, fx] of Object.entries(FIXTURES)) {
        if (only && only !== name) continue;
        const t = Date.now();
        const { artifact } = simulate(request(fx, nSims), { runtime: 'workerd' });
        out[name] = { simulation_id: artifact.simulation_id, artifact_sha256: artifact.artifact_sha256, status: artifact.status, ms: Date.now() - t, tilt: artifact.anchor?.tilt_applied ?? null };
      }
      return Response.json({ runtime: 'workerd', n_sims: nSims, results: out });
    }
    return new Response('parity harness: /health, /parity?n=10000[&fixture=name]', { status: 404 });
  },
};
