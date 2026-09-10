import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePacket } from './validate_packet.mjs';

function good() {
  return {
    schema_version: 1,
    source_key: 'licensed_provider_x',
    packet_type: 'career',
    source_url: 'https://provider.example/fighters/a',
    fetched_at: '2026-09-10T22:00:00Z',
    fighters: [
      { external_id: 'a', name: 'Alpha Fighter', dob: '1995-01-02' },
      { external_id: 'b', name: 'Beta Fighter' },
    ],
    events: [{ external_id: 'e1', name: 'Promotion 10', date: '2025-01-01', promotion: { name: 'Promotion' } }],
    bouts: [{
      external_id: 'b1', event_external_id: 'e1', fighter_a_external_id: 'a', fighter_b_external_id: 'b',
      competition_class: 'professional', scheduled_rounds: 3,
      result: { outcome: 'win', winner_external_id: 'a', round: 2, time_sec: 123 },
    }],
  };
}

test('accepts a source-native career packet with stable ids', () => {
  assert.deepEqual(validatePacket(good()), []);
});

test('rejects a winner who is not one of the two source-native fighter ids', () => {
  const p = good(); p.bouts[0].result.winner_external_id = 'someone-else';
  assert.ok(validatePacket(p).some((e) => e.path.endsWith('winner_external_id')));
});

test('rejects a bout whose two corners resolve to the same source identity', () => {
  const p = good(); p.bouts[0].fighter_b_external_id = 'a';
  assert.ok(validatePacket(p).some((e) => e.path === 'bouts[0]'));
});

test('rejects incomplete career packets before staging', () => {
  const p = good(); delete p.bouts[0].external_id; delete p.source_url;
  const errors = validatePacket(p);
  assert.ok(errors.some((e) => e.path === 'source_url'));
  assert.ok(errors.some((e) => e.path === 'bouts[0].external_id'));
});
