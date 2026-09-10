#!/usr/bin/env node
// Pure validator for source-native combat packets. No network and no writes.
// Adapters must pass through this contract before a packet may be staged.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const TYPES = new Set(['fighter','event','bout','career','ranking','weigh_in','scorecard','status','award','mixed']);
const CLASSES = new Set(['professional','amateur','exhibition','unknown']);
const OUTCOMES = new Set(['win','draw','no_contest','unknown']);

const text = (v) => typeof v === 'string' && v.trim().length > 0;
const dateish = (v) => v == null || (text(v) && !Number.isNaN(Date.parse(v)));
const urlish = (v) => text(v) && /^https?:\/\//i.test(v);

export function validatePacket(packet) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return [{ path: '$', message: 'packet must be an object' }];

  if (packet.schema_version !== 1) err('schema_version', 'must equal 1');
  if (!text(packet.source_key)) err('source_key', 'stable source_key required');
  if (!TYPES.has(packet.packet_type)) err('packet_type', 'unsupported packet_type');
  if (!urlish(packet.source_url)) err('source_url', 'absolute http(s) source URL required');
  if (!dateish(packet.fetched_at) || packet.fetched_at == null) err('fetched_at', 'valid source fetch timestamp required');

  const fighters = Array.isArray(packet.fighters) ? packet.fighters : [];
  const events = Array.isArray(packet.events) ? packet.events : [];
  const bouts = Array.isArray(packet.bouts) ? packet.bouts : [];
  const fighterIds = new Set();
  const eventIds = new Set();

  fighters.forEach((f, i) => {
    const p = `fighters[${i}]`;
    if (!f || typeof f !== 'object') { err(p, 'fighter must be an object'); return; }
    if (!text(f.external_id)) err(`${p}.external_id`, 'source-native fighter id required');
    else if (fighterIds.has(f.external_id)) err(`${p}.external_id`, 'duplicate fighter external_id in packet');
    else fighterIds.add(f.external_id);
    if (!text(f.name)) err(`${p}.name`, 'fighter name required');
    if (!dateish(f.dob)) err(`${p}.dob`, 'dob must be YYYY-MM-DD/date-like when present');
    if (f.source_url != null && !urlish(f.source_url)) err(`${p}.source_url`, 'must be absolute http(s) URL');
  });

  events.forEach((e, i) => {
    const p = `events[${i}]`;
    if (!e || typeof e !== 'object') { err(p, 'event must be an object'); return; }
    if (!text(e.external_id)) err(`${p}.external_id`, 'source-native event id required');
    else if (eventIds.has(e.external_id)) err(`${p}.external_id`, 'duplicate event external_id in packet');
    else eventIds.add(e.external_id);
    if (!text(e.name)) err(`${p}.name`, 'event name required');
    if (!dateish(e.date) || e.date == null) err(`${p}.date`, 'event date required');
    if (!e.promotion || !text(e.promotion.name)) err(`${p}.promotion.name`, 'promotion name required');
    if (e.source_url != null && !urlish(e.source_url)) err(`${p}.source_url`, 'must be absolute http(s) URL');
  });

  const boutIds = new Set();
  bouts.forEach((b, i) => {
    const p = `bouts[${i}]`;
    if (!b || typeof b !== 'object') { err(p, 'bout must be an object'); return; }
    if (!text(b.external_id)) err(`${p}.external_id`, 'source-native bout id required');
    else if (boutIds.has(b.external_id)) err(`${p}.external_id`, 'duplicate bout external_id in packet');
    else boutIds.add(b.external_id);
    if (!text(b.event_external_id)) err(`${p}.event_external_id`, 'event external id required');
    if (!text(b.fighter_a_external_id)) err(`${p}.fighter_a_external_id`, 'fighter A external id required');
    if (!text(b.fighter_b_external_id)) err(`${p}.fighter_b_external_id`, 'fighter B external id required');
    if (text(b.fighter_a_external_id) && b.fighter_a_external_id === b.fighter_b_external_id) err(p, 'fighter A and fighter B cannot be the same identity');
    if (b.competition_class != null && !CLASSES.has(b.competition_class)) err(`${p}.competition_class`, 'unsupported competition class');
    if (b.scheduled_rounds != null && (!Number.isInteger(b.scheduled_rounds) || b.scheduled_rounds < 1 || b.scheduled_rounds > 10)) err(`${p}.scheduled_rounds`, 'must be integer 1..10');
    if (b.source_url != null && !urlish(b.source_url)) err(`${p}.source_url`, 'must be absolute http(s) URL');

    if (b.result != null) {
      const r = b.result;
      if (!OUTCOMES.has(r.outcome)) err(`${p}.result.outcome`, 'unsupported outcome');
      if (r.outcome === 'win' && !text(r.winner_external_id)) err(`${p}.result.winner_external_id`, 'winner id required for a win');
      if (r.outcome !== 'win' && r.winner_external_id != null) err(`${p}.result.winner_external_id`, 'winner must be null unless outcome=win');
      if (text(r.winner_external_id) && ![b.fighter_a_external_id, b.fighter_b_external_id].includes(r.winner_external_id)) err(`${p}.result.winner_external_id`, 'winner must be one of the bout identities');
      if (r.round != null && (!Number.isInteger(r.round) || r.round < 1 || r.round > 10)) err(`${p}.result.round`, 'must be integer 1..10');
      if (r.time_sec != null && (!Number.isInteger(r.time_sec) || r.time_sec < 0)) err(`${p}.result.time_sec`, 'must be a non-negative integer');
    }
  });

  if (packet.packet_type === 'career' && fighters.length === 0) err('fighters', 'career packet requires at least one fighter');
  if (['event','bout','career','mixed'].includes(packet.packet_type) && events.length === 0) err('events', `${packet.packet_type} packet requires at least one event`);
  if (['bout','career'].includes(packet.packet_type) && bouts.length === 0) err('bouts', `${packet.packet_type} packet requires at least one bout`);
  return errors;
}

export function assertPacket(packet) {
  const errors = validatePacket(packet);
  if (errors.length) {
    const e = new Error(`combat packet rejected (${errors.length} validation error${errors.length === 1 ? '' : 's'})`);
    e.errors = errors;
    throw e;
  }
  return packet;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/combat/validate_packet.mjs <packet.json>'); process.exit(2); }
  try {
    const packet = JSON.parse(fs.readFileSync(file, 'utf8'));
    const errors = validatePacket(packet);
    if (errors.length) {
      console.error(JSON.stringify({ ok: false, errors }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, source_key: packet.source_key, packet_type: packet.packet_type }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e?.message || e), errors: e?.errors || [] }, null, 2));
    process.exit(1);
  }
}
