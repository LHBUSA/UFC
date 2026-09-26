#!/usr/bin/env node
// Manual, cited Training & Corner facts (migration 032). No hand-written SQL: every write goes
// through public.ufc_training_add_manual, which is append-only and emits the change events.
//
//   node scripts/training/enrich.mjs <command> --fighter <ref> --source <url> [options] [--dry]
//
// <ref> is a fighter uuid, ESPN athlete id, UFC Stats id or profile slug (e.g. alex-pereira-4705658).
//
// Commands
//   show               --fighter                          current facts, camp history, change events
//   fighting-out-of    --city --region --country          where the fighter officially represents
//   training-location  --city --region --country [--camp] physical training base
//   coach              --coach <name|id:|slug:> --role <ROLE> [--since YYYY-MM-DD] [--camp]
//   coach-end          --coach --role [--until YYYY-MM-DD]
//   camp               --camp --type <PRIMARY_CAMP|TEMPORARY_CAMP|CROSS_TRAINING|FIGHT_CAMP> [--since]
//   camp-end           --camp --type [--until]
//   switch             --to <camp> [--from <camp>] [--effective YYYY-MM-DD]   CONFIRMED camp switch
//   find-camp <text>   /  find-coach <text>                candidate discovery (no writes)
//
// Common: --source <url> (required for writes) --published YYYY-MM-DD --note "short factual locator"
//         --create (allow creating a camp/coach that has no exact match) --dry (print the payload only)
//
// ROLE: HEAD STRIKING BOXING MUAY_THAI KICKBOXING WRESTLING GRAPPLING BJJ STRENGTH_CONDITIONING OTHER
//
// Camp / coach refs: id:<uuid>, slug:<slug>, espn:<association id> (camps), or a name. A name must
// match exactly one camp/coach by normalized name or alias; otherwise the candidates are printed and
// nothing is written (add --create to make a new one). Dates are only ever the ones the source states.
import { get, post, rpc, norm, slugify, resolveFighter } from './lib.mjs';

const ROLES = ['HEAD', 'STRIKING', 'BOXING', 'MUAY_THAI', 'KICKBOXING', 'WRESTLING', 'GRAPPLING', 'BJJ', 'STRENGTH_CONDITIONING', 'OTHER'];
const TYPES = ['PRIMARY_CAMP', 'TEMPORARY_CAMP', 'CROSS_TRAINING', 'FIGHT_CAMP'];

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (['dry', 'create'].includes(k)) out[k] = true;
    else { out[k] = argv[i + 1]; i += 1; }
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function date(v, name) {
  if (v == null) return null;
  if (!DATE_RE.test(v)) throw new Error(`--${name} must be YYYY-MM-DD (only a date the source states)`);
  return v;
}

function tokens(s) { return new Set(String(norm(s) || '').split(' ').filter((t) => t.length > 2)); }
function near(list, text) {
  const q = tokens(text);
  return list.map((r) => ({ r, score: [...tokens(r.canonical_name)].filter((t) => q.has(t)).length }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map((x) => x.r);
}

async function findCamps(text) {
  const n = norm(text);
  const [byName, byAlias] = await Promise.all([
    get(`ufc_training_camps?select=id,canonical_name,slug,espn_association_id&name_norm=eq.${encodeURIComponent(n)}`),
    get(`ufc_training_camp_aliases?select=camp:ufc_training_camps(id,canonical_name,slug,espn_association_id)&alias_norm=eq.${encodeURIComponent(n)}`),
  ]);
  const exact = new Map([...byName, ...byAlias.map((a) => a.camp)].map((c) => [c.id, c]));
  return [...exact.values()];
}

async function resolveCamp(ref, { create = false, dry = false } = {}) {
  if (!ref) return null;
  const r = String(ref);
  const sel = 'select=id,canonical_name,slug,espn_association_id';
  let rows;
  if (r.startsWith('id:')) rows = await get(`ufc_training_camps?${sel}&id=eq.${r.slice(3)}`);
  else if (r.startsWith('slug:')) rows = await get(`ufc_training_camps?${sel}&slug=eq.${encodeURIComponent(r.slice(5))}`);
  else if (r.startsWith('espn:')) rows = await get(`ufc_training_camps?${sel}&espn_association_id=eq.${encodeURIComponent(r.slice(5))}`);
  else rows = await findCamps(r);
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) throw new Error(`camp "${r}" is ambiguous:\n${rows.map((c) => `  slug:${c.slug}  ${c.canonical_name}${c.espn_association_id ? `  espn:${c.espn_association_id}` : ''}`).join('\n')}`);
  if (/^(id|slug|espn):/.test(r)) throw new Error(`camp "${r}" not found`);
  const cands = near(await get(`ufc_training_camps?${sel}&limit=2000`), r);
  if (!create) throw new Error(`no camp named "${r}". Candidates:\n${cands.map((c) => `  slug:${c.slug}  ${c.canonical_name}`).join('\n') || '  (none)'}\nUse a candidate, or add --create to make "${r}" a new camp.`);
  if (dry) return { id: '(would create)', canonical_name: r.trim(), slug: await freeSlug('ufc_training_camps', r) };
  const [row] = await post('ufc_training_camps', [{ canonical_name: r.trim(), slug: await freeSlug('ufc_training_camps', r) }]);
  const src = (await get('combat_sources?select=id&source_key=eq.ufc_training_manual'))[0]?.id;
  await post('ufc_training_camp_aliases', [{ camp_id: row.id, alias: r.trim(), source_id: src }], 'return=minimal');
  console.error(`created camp slug:${row.slug} (${row.canonical_name})`);
  return row;
}

async function resolveCoach(ref, { create = false, dry = false } = {}) {
  const r = String(ref || '');
  if (!r) throw new Error('--coach is required');
  const sel = 'select=id,canonical_name,slug';
  let rows;
  if (r.startsWith('id:')) rows = await get(`ufc_coaches?${sel}&id=eq.${r.slice(3)}`);
  else if (r.startsWith('slug:')) rows = await get(`ufc_coaches?${sel}&slug=eq.${encodeURIComponent(r.slice(5))}`);
  else rows = await get(`ufc_coaches?${sel}&name_norm=eq.${encodeURIComponent(norm(r))}`);
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) throw new Error(`coach "${r}" is ambiguous:\n${rows.map((c) => `  slug:${c.slug}  ${c.canonical_name}`).join('\n')}`);
  if (/^(id|slug):/.test(r)) throw new Error(`coach "${r}" not found`);
  const cands = near(await get(`ufc_coaches?${sel}&limit=2000`), r);
  if (!create) throw new Error(`no coach named "${r}". Candidates:\n${cands.map((c) => `  slug:${c.slug}  ${c.canonical_name}`).join('\n') || '  (none)'}\nUse a candidate, or add --create to make "${r}" a new coach.`);
  if (dry) return { id: '(would create)', canonical_name: r.trim(), slug: await freeSlug('ufc_coaches', r) };
  const [row] = await post('ufc_coaches', [{ canonical_name: r.trim(), slug: await freeSlug('ufc_coaches', r) }]);
  console.error(`created coach slug:${row.slug} (${row.canonical_name})`);
  return row;
}

async function freeSlug(table, name) {
  const base = slugify(name) || 'x';
  for (let i = 1; ; i += 1) {
    const s = i === 1 ? base : `${base}-${i}`;
    if (!(await get(`${table}?select=id&slug=eq.${s}`)).length) return s;
  }
}

async function show(f) {
  const [cur, stints, events] = await Promise.all([
    get(`ufc_fighter_training_current?fighter_id=eq.${f.id}`),
    get(`ufc_fighter_camp_stints?select=stint_no,camp_name,certainty,first_observed_at,last_confirmed_at,joined_on,is_current&fighter_id=eq.${f.id}&order=stint_no.asc`),
    get(`ufc_training_change_events?select=kind,previous_value,new_value,effective_on,observed_at,source_url,supersedes_event_id&fighter_id=eq.${f.id}&order=observed_at.asc`),
  ]);
  console.log(JSON.stringify({ fighter: f, current: cur[0] || null, camp_history: stints, changes: events }, null, 2));
}

async function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  if (!cmd || cmd === 'help') { console.log((await import('node:fs')).readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); return; }
  if (cmd === 'find-camp') {
    const q = o._.slice(1).join(' ');
    const exact = await findCamps(q);
    const cands = near(await get('ufc_training_camps?select=id,canonical_name,slug,espn_association_id&limit=2000'), q);
    console.log(JSON.stringify({ exact, candidates: cands }, null, 2));
    return;
  }
  if (cmd === 'find-coach') {
    const q = o._.slice(1).join(' ');
    console.log(JSON.stringify(near(await get('ufc_coaches?select=id,canonical_name,slug&limit=2000'), q), null, 2));
    return;
  }
  const f = await resolveFighter(o.fighter);
  if (cmd === 'show') return show(f);

  if (!/^https?:\/\//.test(o.source || '')) throw new Error('--source <url> is required: every fact cites the page it was read from');
  const p = {
    kind: null, fighter_id: f.id, source_url: o.source,
    source_published_at: date(o.published, 'published'),
    evidence_note: o.note ? String(o.note).slice(0, 500) : undefined,
  };
  const opts = { create: Boolean(o.create), dry: Boolean(o.dry) };  // --dry never creates a camp or coach
  switch (cmd) {
    case 'fighting-out-of':
    case 'training-location': {
      if (!o.city && !o.region && !o.country) throw new Error('give at least one of --city --region --country');
      Object.assign(p, { kind: cmd.replace(/-/g, '_'), city: o.city, region: o.region, country: o.country });
      if (cmd === 'training-location' && o.camp) p.camp_id = (await resolveCamp(o.camp, opts)).id;
      if (cmd === 'fighting-out-of' && o.camp) throw new Error('fighting out of is a place, not a camp');
      break;
    }
    case 'coach':
    case 'coach-end': {
      const role = String(o.role || '').toUpperCase();
      if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(' ')} (only the role the source states)`);
      const coach = await resolveCoach(o.coach, cmd === 'coach' ? opts : { dry: opts.dry });
      Object.assign(p, { kind: cmd.replace('-', '_'), coach_id: coach.id, coach_role: role,
        effective_from: date(o.since, 'since'), effective_to: date(o.until, 'until') });
      if (o.camp) p.camp_id = (await resolveCamp(o.camp)).id;
      break;
    }
    case 'camp':
    case 'camp-end': {
      const type = String(o.type || '').toUpperCase();
      if (!TYPES.includes(type)) throw new Error(`--type must be one of ${TYPES.join(' ')}`);
      const camp = await resolveCamp(o.camp, cmd === 'camp' ? opts : {});
      Object.assign(p, { kind: cmd.replace('-', '_'), camp_id: camp.id, relationship_type: type,
        effective_from: date(o.since, 'since'), effective_to: date(o.until, 'until') });
      break;
    }
    case 'switch': {
      const to = await resolveCamp(o.to, opts);
      const from = o.from ? await resolveCamp(o.from) : null;
      Object.assign(p, { kind: 'switch', camp_id: to.id, from_camp_id: from?.id, effective_from: date(o.effective, 'effective') });
      break;
    }
    default:
      throw new Error(`unknown command "${cmd}" (run with help)`);
  }
  for (const k of Object.keys(p)) if (p[k] == null) delete p[k];
  if (o.dry) { console.log(JSON.stringify({ dry: true, payload: p }, null, 2)); return; }
  const r = await rpc('ufc_training_add_manual', { p });  // PostgREST binds the body's keys to argument names: the one argument is p
  console.log(JSON.stringify({ fighter: f.name, ...r }, null, 2));
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
