// Fixture loader shared by tests, bench and the parity harness (Node only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

export const PAIR_FIXTURES = ['ufc333_volkanovski_evloev', 'ufc331_steveson_sharaf', 'ufc331_aswell_yoo', 'ufc331_pitbull_choi'];

export function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
}

export function requestFromFixture(fx, overrides = {}) {
  return {
    fighter_a: fx.fighter_a,
    fighter_b: fx.fighter_b,
    anchor: fx.anchor,
    settings: { scheduled_rounds: fx.bout.scheduled_rounds, weight_class: fx.bout.weight_class, is_title: fx.bout.is_title, is_womens: fx.bout.is_womens },
    n_sims: 10000,
    ...overrides,
  };
}
