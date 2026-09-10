#!/usr/bin/env node
// Fighter portrait candidate queue generator.
//
// For every in-scope fighter (ranked, next 3 cards, homepage featured, active
// roster; rules in web/lib/fighterMediaPolicy.ts) that has no portrait cleared
// for high-visibility surfaces, gather candidate images into
// ufc_fighter_media_candidates, ordered by priority_score. It NEVER approves:
// approval is a named reviewer's decision in /admin/media.
//
// Sources
//   ufc_images            stored first-party Commons/PD portraits (the photos
//                         public pages showed before this pipeline). Identity
//                         evidence is carried over as recorded at ingest; 368
//                         rows have none and are flagged for the reviewer.
//   ufc_image_candidates  the older Commons discovery ledger (needs_review).
//                         Non-photo formats are auto-rejected.
//   ESPN athlete API      one headshot per athlete id, with the API's name and
//                         DOB checked against ours as identity evidence. ESPN
//                         grants us no license: display_only, never commercial,
//                         proposed for standard surfaces only.
//
// Idempotent: inserts use on_conflict=(fighter_id,image_key) ignore-duplicates,
// so a re-run never resets a reviewed candidate. Quarantined images re-enter as
// quarantined (database trigger).
//
// Usage
//   node scripts/media/fighter_portrait_queue.mjs                 # dry run, writes JSON
//   node scripts/media/fighter_portrait_queue.mjs --apply         # insert candidates
//     [--no-espn] [--limit N] [--out path.json] [--espn-concurrency 6]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyLicense, identityConfidence, suitability, candidatePriority, ESPN_RIGHTS, portraitDecision,
} from '../../web/lib/fighterMediaPolicy.ts';
import { ROOT, client, gatherScope, loadEnv, normalizedName, pool } from './lib/portraitData.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APPLY = flag('--apply');
const WITH_ESPN = !flag('--no-espn');
const LIMIT = Number(opt('--limit', 'Infinity'));
const ESPN_CONCURRENCY = Number(opt('--espn-concurrency', '6'));
const OUT = opt('--out', path.join(os.tmpdir(), 'fighter_portrait_queue.dryrun.json'));
const RUN = `fighter_portrait_queue@${new Date().toISOString()}`;
const ESPN_ATHLETE = 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/athletes';

/* Human decisions that used to live in code, carried into the queue so a
 * re-run cannot resurrect them as pending. */
const KNOWN_REJECTIONS = new Map([
  ['73077eea-6c1e-4f3b-88e4-c23a412c11d8', 'Petr Yan: Kremlin award ceremony handshake, not a portrait (was NOT_PRIMARY_PORTRAIT in web/lib/db.ts)'],
]);

const env = loadEnv();
const db = client(env);

function legacyImageCandidate(img, fighter, scopeEntry) {
  const rights = classifyLicense(img.license);
  const commercial = rights.commercial_use_allowed && img.commercial_use_allowed === true;
  const recorded = img.identity_evidence && Object.keys(img.identity_evidence).length > 0;
  const evidence = recorded
    ? { ...img.identity_evidence, provenance: { ufc_images_id: img.id, captured_at: img.captured_at } }
    : { recorded_evidence: false, provenance: { ufc_images_id: img.id, captured_at: img.captured_at, note: 'ufc_images row carries no identity evidence; the reviewer is the identity check' } };
  const dir = img.r2_key.replace(/\/[^/]+$/, '');
  const suit = suitability({ image_url: img.r2_key, width: img.width, height: img.height, framing_status: img.framing_status, source_type: 'wikimedia_commons' });
  const identity = identityConfidence(evidence, 'wikimedia_commons');
  const flags = [...suit.flags];
  if (!recorded) flags.push('no_identity_evidence');
  if (img.identity_evidence?.dob_match === false) flags.push('dob_mismatch');
  if (img.identity_evidence?.context_match === false) flags.push('no_mma_context');
  const attribution = img.attribution_text || [img.author, img.license].filter(Boolean).join(', ') + ', via Wikimedia Commons';
  const rejected = KNOWN_REJECTIONS.get(img.id);
  return {
    fighter_id: fighter.id,
    image_url: db.mediaUrl(img.r2_key),
    thumbnail_url: /\/portrait\.jpg$/.test(img.r2_key) ? db.mediaUrl(`${dir}/card.jpg`) : null,
    storage_key: img.r2_key,
    legacy_image_id: img.id,
    source_url: img.source_url || db.mediaUrl(img.r2_key),
    source_name: 'Wikimedia Commons',
    source_type: img.kind === 'public_domain' ? 'public_domain' : 'wikimedia_commons',
    license_type: rights.license_type,
    license_label: img.license,
    author: img.author,
    commercial_use_allowed: commercial,
    derivative_use_allowed: rights.derivative_use_allowed && img.derivatives_allowed !== false,
    attribution_required: rights.attribution_required || img.attribution_required === true,
    attribution_text: attribution,
    identity_evidence: evidence,
    identity_confidence: identity,
    suitability_score: suit.score,
    priority_score: candidatePriority(scopeEntry.priority, identity, suit.score, commercial),
    fighter_priority: scopeEntry.priority,
    queue_reasons: scopeEntry.reasons,
    width: img.width || null,
    height: img.height || null,
    focal_x: img.focal_x ?? null,
    focal_y: img.focal_y ?? null,
    proposed_surface_policy: 'all_surfaces',
    flags,
    status: rejected ? 'rejected' : 'pending',
    review_reason: rejected || null,
    reviewed_by: rejected ? 'migration:NOT_PRIMARY_PORTRAIT' : null,
    discovered_by: `ufc_images:${RUN}`,
  };
}

function ledgerCandidate(c, fighter, scopeEntry) {
  const rights = classifyLicense(c.license);
  const url = c.thumbnail_url || c.image_url;
  const evidence = { ...c.identity_evidence, ledger_identity_confidence: c.identity_confidence, discovery_method: c.discovery_method, provenance: { ufc_image_candidates_id: c.id } };
  const suit = suitability({ image_url: c.image_url || '', width: c.metadata?.width, height: c.metadata?.height, source_type: 'wikimedia_commons' });
  const identity = identityConfidence(evidence, 'wikimedia_commons');
  const flags = [...suit.flags, 'hotlinked_not_stored'];
  const notPhoto = suit.flags.includes('not_a_photo_format');
  return {
    fighter_id: fighter.id,
    image_url: url,
    thumbnail_url: c.thumbnail_url || null,
    storage_key: null,
    legacy_candidate_id: c.id,
    source_url: c.source_url,
    source_name: 'Wikimedia Commons',
    source_type: 'wikimedia_commons',
    license_type: rights.license_type,
    license_label: c.license,
    author: c.author,
    commercial_use_allowed: rights.commercial_use_allowed,
    derivative_use_allowed: rights.derivative_use_allowed,
    attribution_required: rights.attribution_required,
    attribution_text: c.attribution_text || [c.author, c.license].filter(Boolean).join(', ') + ', via Wikimedia Commons',
    identity_evidence: evidence,
    identity_confidence: identity,
    suitability_score: suit.score,
    priority_score: candidatePriority(scopeEntry.priority, identity, suit.score, rights.commercial_use_allowed),
    fighter_priority: scopeEntry.priority,
    queue_reasons: scopeEntry.reasons,
    width: c.metadata?.width || null,
    height: c.metadata?.height || null,
    proposed_surface_policy: 'all_surfaces',
    flags,
    status: notPhoto ? 'rejected' : 'pending',
    review_reason: notPhoto ? 'not a photograph (file format); auto-rejected by the queue generator' : null,
    reviewed_by: notPhoto ? 'system:fighter_portrait_queue' : null,
    discovered_by: `ufc_image_candidates:${RUN}`,
  };
}

async function espnCandidate(fighter, scopeEntry) {
  const id = String(fighter.espn_athlete_id || '').trim();
  if (!/^\d+$/.test(id)) return { skip: 'no_espn_id' };
  let athlete;
  try {
    const res = await fetch(`${ESPN_ATHLETE}/${id}?lang=en&region=us`, { headers: { Accept: 'application/json', 'User-Agent': 'PropBetEdgeUFC/1.1 (portrait review queue)' }, signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return { skip: 'espn_athlete_404' };
    if (!res.ok) return { skip: `espn_http_${res.status}` };
    athlete = await res.json();
  } catch (e) {
    return { skip: 'espn_fetch_failed' };
  }
  const href = String(athlete?.headshot?.href || '').replace(/^http:/, 'https:');
  if (!href) return { skip: 'espn_no_headshot' };
  const apiName = athlete.fullName || athlete.displayName || '';
  const apiDob = athlete.dateOfBirth ? String(athlete.dateOfBirth).slice(0, 10) : null;
  const evidence = {
    method: 'espn_athlete_api',
    espn_athlete_id: id,
    athlete_api_url: `${ESPN_ATHLETE}/${id}`,
    athlete_id_match: String(athlete.id || '') === id,
    api_full_name: apiName,
    name_exact: normalizedName(apiName) === normalizedName(fighter.name) && Boolean(normalizedName(apiName)),
    dob_api: apiDob,
    dob_db: fighter.dob || null,
    dob_match: apiDob && fighter.dob ? apiDob === fighter.dob : null,
    headshot_alt: athlete.headshot?.alt || null,
    headshot_alt_match: athlete.headshot?.alt ? normalizedName(athlete.headshot.alt) === normalizedName(fighter.name) : null,
    checked_at: new Date().toISOString(),
    caveat: 'A matching athlete record proves the ESPN slot belongs to this athlete id, not that the pictured face is the fighter. Check the face.',
  };
  const identity = identityConfidence(evidence, 'espn');
  const suit = suitability({ image_url: href, source_type: 'espn' });
  const flags = ['no_commercial_grant', 'hotlinked_not_stored'];
  if (!evidence.name_exact) flags.push('name_mismatch');
  if (evidence.dob_match === false) flags.push('dob_mismatch');
  if (evidence.headshot_alt_match === false) flags.push('headshot_alt_mismatch');
  return {
    row: {
      fighter_id: fighter.id,
      image_url: href,
      thumbnail_url: null,
      storage_key: null,
      source_url: `https://www.espn.com/mma/fighter/_/id/${id}`,
      source_name: 'ESPN',
      source_type: 'espn',
      ...ESPN_RIGHTS,
      license_label: null,
      author: 'ESPN',
      attribution_text: 'Photo: ESPN',
      identity_evidence: evidence,
      identity_confidence: identity,
      suitability_score: suit.score,
      priority_score: candidatePriority(scopeEntry.priority, identity, suit.score, false),
      fighter_priority: scopeEntry.priority,
      queue_reasons: scopeEntry.reasons,
      proposed_surface_policy: 'standard_surfaces',
      flags,
      status: 'pending',
      discovered_by: `espn_athlete_api:${RUN}`,
    },
  };
}

async function main() {
  const t0 = Date.now();
  const tablesReady = await db.exists('ufc_fighter_media_candidates');
  if (APPLY && !tablesReady) throw new Error('ufc_fighter_media_candidates does not exist: apply supabase/migrations/20260910210000_ufc_fighter_media_pipeline.sql first');

  const { scope, nextEvents } = await gatherScope(db);
  const eligible = tablesReady && (await db.exists('ufc_fighter_portrait_eligible'))
    ? await db.all('ufc_fighter_portrait_eligible?select=*&order=fighter_id') : [];
  const covered = new Set(eligible.filter((r) => portraitDecision(r, 'high_visibility').ok).map((r) => r.fighter_id));

  const targets = [...scope.entries()].filter(([id]) => !covered.has(id))
    .sort((a, b) => b[1].priority - a[1].priority || a[0].localeCompare(b[0]))
    .slice(0, LIMIT);
  const targetIds = targets.map(([id]) => id);
  const scopeById = new Map(targets);

  const fighters = [];
  for (let i = 0; i < targetIds.length; i += 150) {
    fighters.push(...await db.all(`ufc_fighters?select=id,name,dob,espn_athlete_id&id=in.(${targetIds.slice(i, i + 150).join(',')})&order=id`));
  }
  const fighterById = new Map(fighters.map((f) => [f.id, f]));

  const IMG = 'id,kind,r2_key,license,author,source_url,fighter_id,source_family,attribution_text,identity_evidence,width,height,captured_at,focal_x,focal_y,framing_status,commercial_use_allowed,derivatives_allowed,attribution_required';
  const images = [];
  const ledger = [];
  for (let i = 0; i < targetIds.length; i += 150) {
    const chunk = targetIds.slice(i, i + 150).join(',');
    images.push(...await db.all(`ufc_images?select=${IMG}&fighter_id=in.(${chunk})&order=id`));
    ledger.push(...await db.all(`ufc_image_candidates?select=*&fighter_id=in.(${chunk})&status=in.(needs_review,auto_approved)&order=id`));
  }

  const rows = [];
  for (const img of images) {
    const f = fighterById.get(img.fighter_id);
    if (!f || !img.r2_key || img.identity_evidence?.former_fighter_id) continue;
    rows.push(legacyImageCandidate(img, f, scopeById.get(f.id)));
  }
  for (const c of ledger) {
    const f = fighterById.get(c.fighter_id);
    if (!f || !(c.thumbnail_url || c.image_url)?.startsWith('https://')) continue;
    rows.push(ledgerCandidate(c, f, scopeById.get(f.id)));
  }
  const espnSkips = {};
  if (WITH_ESPN) {
    const results = await pool(fighters, ESPN_CONCURRENCY, (f) => espnCandidate(f, scopeById.get(f.id)));
    for (const r of results) { if (r.row) rows.push(r.row); else espnSkips[r.skip] = (espnSkips[r.skip] || 0) + 1; }
  }

  /* Mirror the quarantine trigger so the dry run shows what --apply will store.
   * Before the migration exists, the one carried-over entry is known statically. */
  const imageKey = (u) => String(u || '').trim().replace(/[?#].*$/, '').toLowerCase();
  const quarantine = tablesReady
    ? await db.all('ufc_media_quarantine?select=image_key,source_url&lifted_at=is.null&order=id')
    : [{ image_key: 'https://a.espncdn.com/i/headshots/mma/players/full/5307124.png', source_url: 'https://www.espn.com/mma/fighter/_/id/5307124' }];
  const qKeys = new Set(quarantine.map((q) => q.image_key));
  const qSources = new Set(quarantine.map((q) => q.source_url).filter(Boolean));
  for (const r of rows) {
    if ((r.status === 'pending') && (qKeys.has(imageKey(r.image_url)) || qSources.has(r.source_url))) {
      r.status = 'quarantined';
      r.review_reason = 'blocked: matches an active ufc_media_quarantine entry';
      r.reviewed_by = 'system:quarantine';
    }
  }

  /* One candidate per (fighter, image key), like the unique constraint. */
  const keyOf = (r) => `${r.fighter_id}|${imageKey(r.image_url)}`;
  const dedup = [...new Map(rows.map((r) => [keyOf(r), r])).values()].sort((a, b) => b.priority_score - a.priority_score);

  const tally = (f) => dedup.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const fightersWithCandidate = new Set(dedup.filter((r) => r.status === 'pending').map((r) => r.fighter_id));
  const summary = {
    run: RUN,
    mode: APPLY ? 'apply' : 'dry-run',
    tables_ready: tablesReady,
    cards_in_scope: nextEvents.map((e) => `${e.name} (${e.event_date})`),
    scope_fighters: scope.size,
    already_covered_high_visibility: covered.size,
    target_fighters: targets.length,
    candidates: dedup.length,
    by_source: tally((r) => r.source_type),
    by_status: tally((r) => r.status),
    identity_band: tally((r) => (r.identity_confidence >= 0.85 ? 'strong >=0.85' : r.identity_confidence >= 0.6 ? 'medium 0.6-0.85' : 'weak <0.6')),
    commercial: tally((r) => (r.commercial_use_allowed ? 'commercial' : 'no_commercial_grant')),
    target_fighters_with_pending_candidate: fightersWithCandidate.size,
    target_fighters_with_commercial_pending_candidate: new Set(dedup.filter((r) => r.status === 'pending' && r.commercial_use_allowed).map((r) => r.fighter_id)).size,
    espn_skips: espnSkips,
    seconds: Math.round((Date.now() - t0) / 1000),
  };

  if (APPLY) {
    let sent = 0;
    for (let i = 0; i < dedup.length; i += 200) {
      const batch = dedup.slice(i, i + 200).map((r) => ({ ...r, reviewed_at: r.reviewed_by ? new Date().toISOString() : null }));
      await db.req('ufc_fighter_media_candidates?on_conflict=fighter_id,image_key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(normalizeBatch(batch)),
      });
      sent += batch.length;
    }
    summary.sent = sent;
    summary.pending_in_table = await db.count('ufc_fighter_media_candidates?select=id&status=eq.pending');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ summary, candidates: dedup }, null, 2) + '\n');
    summary.wrote = OUT;
  }
  console.log(JSON.stringify(summary, null, 2));
}

/* PostgREST bulk insert needs every object to carry the same keys. */
function normalizeBatch(batch) {
  const keys = [...new Set(batch.flatMap((r) => Object.keys(r)))];
  return batch.map((r) => Object.fromEntries(keys.map((k) => [k, r[k] === undefined ? null : r[k]])));
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
