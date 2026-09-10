import { normalizeName, parseMmaRecord } from './parser.js';
import { RECOGNIZED_EXTERNAL_PROMOTIONS, resultForCareerRow, scoreTarget, shouldPromoteCareerRow, verifyWikipediaCareer } from './logic.js';

const WORKER = 'combat-wikipedia-ingest';
const SOURCE_KEY = 'wikipedia_en';
const WIKI_BASE = 'https://en.wikipedia.org/wiki/';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);
const qv = (v) => encodeURIComponent(String(v));
const inIds = (ids) => `(${[...new Set(ids)].join(',')})`;

function wikiUrl(title) {
  return WIKI_BASE + encodeURIComponent(String(title).replaceAll(' ', '_')).replaceAll('%2F', '/');
}

async function sha256(value) {
  const data = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sbHeaders(env, extra = {}) {
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  const h = { apikey: key, Accept: 'application/json', 'content-type': 'application/json', ...extra };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}

async function sbRequest(env, path, { method = 'GET', body = null, prefer = null, range = null } = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('SUPABASE_URL is not configured');
  const headers = sbHeaders(env, {
    ...(prefer ? { Prefer: prefer } : {}),
    ...(range ? { 'Range-Unit': 'items', Range: range } : {}),
  });
  const res = await fetch(`${base}/rest/v1/${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  if (res.status === 204) return [];
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function sbAll(env, path, pageSize = 1000) {
  const out = [];
  for (let start = 0; ; start += pageSize) {
    const rows = await sbRequest(env, path, { range: `${start}-${start + pageSize - 1}` });
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

async function sbUpsert(env, table, rows, onConflict, chunkSize = 100) {
  if (!rows.length) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await sbRequest(env, `${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: 'POST', body: chunk, prefer: 'resolution=merge-duplicates,return=minimal',
    });
    n += chunk.length;
  }
  return n;
}

async function sbInsert(env, table, rows, chunkSize = 100) {
  if (!rows.length) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await sbRequest(env, table, { method: 'POST', body: chunk, prefer: 'return=minimal' });
    n += chunk.length;
  }
  return n;
}

class WikiClient {
  constructor(env) {
    this.api = String(env.WIKIMEDIA_API || 'https://en.wikipedia.org/w/api.php');
    this.userAgent = String(env.WIKIMEDIA_USER_AGENT || 'PropBetEdge-MMA-Ingest/1.0 (+https://ufc.propbetedge.ai/)');
    this.maxRequests = Math.max(1, Number(env.MAX_WIKIMEDIA_REQUESTS_PER_RUN || 40));
    this.interval = Math.max(0, Number(env.WIKIMEDIA_MIN_INTERVAL_MS || 500));
    this.requests = 0;
    this.lastAt = 0;
  }

  async get(params) {
    this.requests += 1;
    if (this.requests > this.maxRequests) throw new Error(`Wikimedia request cap exceeded (${this.maxRequests})`);
    const wait = this.interval - (Date.now() - this.lastAt);
    if (wait > 0) await sleep(wait);
    this.lastAt = Date.now();
    const qs = new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await fetch(`${this.api}?${qs}`, {
        headers: { 'User-Agent': this.userAgent, 'Api-User-Agent': this.userAgent, Accept: 'application/json' },
      });
      if ([429, 500, 502, 503, 504].includes(res.status)) {
        if (attempt === 4) throw new Error(`Wikimedia API HTTP ${res.status}`);
        const retry = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 1000 * (2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`Wikimedia API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      if (body.error) {
        if (body.error.code === 'maxlag' && attempt < 4) { await sleep(1000 * (2 ** attempt)); continue; }
        throw new Error(`Wikimedia API ${body.error.code || 'error'}: ${body.error.info || 'unknown'}`);
      }
      return body;
    }
    throw new Error('Wikimedia API retries exhausted');
  }

  async exactPage(name) {
    const body = await this.get({ action: 'query', titles: name, redirects: '1', prop: 'info|pageprops', inprop: 'url' });
    const p = body.query?.pages?.[0];
    if (!p || p.missing) return null;
    return p;
  }

  async search(name) {
    const body = await this.get({ action: 'query', list: 'search', srsearch: `"${name}" mixed martial arts fighter`, srlimit: '5', srnamespace: '0' });
    return body.query?.search || [];
  }

  async parsePage(pageid) {
    const body = await this.get({ action: 'parse', pageid: String(pageid), prop: 'text|revid|displaytitle', disableeditsection: '1' });
    const p = body.parse || {};
    if (!p.text) throw new Error(`Wikipedia page ${pageid} returned no parsed HTML`);
    return p;
  }

  async resolveFighter(name) {
    const exact = await this.exactPage(name);
    const candidates = [];
    if (exact && exact.pageprops?.disambiguation === undefined) candidates.push(exact);
    const tried = new Set();
    const inspect = async (c) => {
      const pageid = Number(c?.pageid || 0);
      if (!pageid || tried.has(pageid)) return null;
      tried.add(pageid);
      const parsed = await this.parsePage(pageid);
      const record = parseMmaRecord(parsed.text);
      if (!record.rows.length) return null;
      const title = c.title || parsed.title || name;
      return { pageid, title, revid: parsed.revid, displaytitle: parsed.displaytitle, url: wikiUrl(title), record };
    };
    for (const c of candidates) {
      const page = await inspect(c);
      if (page) return page;
    }
    for (const c of await this.search(name)) {
      const page = await inspect(c);
      if (page) return page;
    }
    return null;
  }
}

function mapSet(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

async function loadState(env, source) {
  const [fighters, aliases, wikiIdentities, promotions, wikiEvents, wikiBouts, wikiResults, career, pendingReviews] = await Promise.all([
    sbAll(env, 'combat_fighters?select=id,ufc_fighter_id,display_name,dob,career_status,identity_state'),
    sbAll(env, 'combat_fighter_aliases?select=combat_fighter_id,normalized,verification_state'),
    sbAll(env, `combat_fighter_identities?select=id,combat_fighter_id,external_id,verification_state,confidence,last_observed_at&source_id=eq.${source.id}`),
    sbAll(env, 'combat_promotions?select=id,slug,name,source_id'),
    sbAll(env, `combat_events?select=id,external_event_id,promotion_id&source_id=eq.${source.id}`),
    sbAll(env, `combat_bouts?select=id,external_bout_id,event_id,fighter_a_id,fighter_b_id&source_id=eq.${source.id}`),
    sbAll(env, `combat_bout_results?select=bout_id,outcome,winner_id,method,round,time_sec&source_id=eq.${source.id}`),
    sbAll(env, 'combat_fighter_career_summary?select=combat_fighter_id,ufc_fighter_id,ufc_appearances,external_appearances,promotions_seen'),
    sbAll(env, `combat_identity_review_queue?select=raw_external_id,raw_name,reason,status&source_id=eq.${source.id}&status=eq.pending`),
  ]);
  const fighterById = new Map(fighters.map((f) => [f.id, f]));
  const fighterByUfcId = new Map(fighters.filter((f) => f.ufc_fighter_id).map((f) => [f.ufc_fighter_id, f]));
  const normIds = new Map();
  for (const f of fighters) mapSet(normIds, normalizeName(f.display_name), f.id);
  for (const a of aliases) if (a.verification_state !== 'rejected') mapSet(normIds, a.normalized, a.combat_fighter_id);
  const wikiByTitle = new Map(wikiIdentities.filter((x) => x.verification_state !== 'rejected').map((x) => [x.external_id, x]));
  const promotionBySlug = new Map(promotions.map((p) => [p.slug, p]));
  const eventByExternal = new Map(wikiEvents.filter((e) => e.external_event_id).map((e) => [e.external_event_id, e]));
  const boutByExternal = new Map(wikiBouts.filter((b) => b.external_bout_id).map((b) => [b.external_bout_id, b]));
  const resultByBout = new Map(wikiResults.map((r) => [r.bout_id, r]));
  const careerByCombat = new Map(career.map((c) => [c.combat_fighter_id, c]));
  const reviewKeys = new Set(pendingReviews.map((r) => `${r.raw_external_id || ''}|${normalizeName(r.raw_name)}|${r.reason}`));
  return { fighters, fighterById, fighterByUfcId, normIds, wikiByTitle, promotionBySlug, eventByExternal, boutByExternal, resultByBout, careerByCombat, reviewKeys };
}

async function automaticTargets(env, state, limit) {
  const rankDateRows = await sbAll(env, 'ufc_rankings?select=snapshot_date&order=snapshot_date.desc&limit=1');
  const rankDate = rankDateRows[0]?.snapshot_date || null;
  const rankings = rankDate ? await sbAll(env, `ufc_rankings?select=fighter_id,rank&snapshot_date=eq.${rankDate}&fighter_id=not.is.null`) : [];
  const rank = new Map();
  for (const r of rankings) {
    const cur = rank.get(r.fighter_id) || { ranked: false, champion: false };
    cur.champion ||= Number(r.rank) === 0;
    cur.ranked ||= Number(r.rank) > 0;
    rank.set(r.fighter_id, cur);
  }
  const upcoming = await sbAll(env, `ufc_events?select=id,name,event_date&event_date=gte.${today()}&card_status=neq.complete&order=event_date.asc&limit=3`);
  const eventIndex = new Map(upcoming.map((e, i) => [e.id, i]));
  const booked = new Map();
  if (upcoming.length) {
    const bouts = await sbAll(env, `ufc_bouts?select=event_id,fighter_a_id,fighter_b_id,status&event_id=in.${inIds(upcoming.map((e) => e.id))}`);
    for (const b of bouts) {
      if (b.status === 'cancelled' || b.status === 'replaced') continue;
      const i = eventIndex.get(b.event_id);
      for (const fid of [b.fighter_a_id, b.fighter_b_id]) {
        const old = booked.get(fid);
        if (old == null || i < old) booked.set(fid, i);
      }
    }
  }
  const refreshDays = Math.max(1, Number(env.REFRESH_DAYS || 30));
  const refreshCutoff = Date.now() - refreshDays * 86400000;
  const scored = [];
  for (const f of state.fighters) {
    if (!f.ufc_fighter_id || f.identity_state === 'merged') continue;
    const existingWiki = [...state.wikiByTitle.values()].find((x) => x.combat_fighter_id === f.id && x.verification_state === 'verified');
    if (existingWiki && (!existingWiki.last_observed_at || Date.parse(existingWiki.last_observed_at) > refreshCutoff || f.career_status !== 'active')) continue;
    const r = rank.get(f.ufc_fighter_id) || {};
    const c = state.careerByCombat.get(f.id) || {};
    const nextCardIndex = booked.has(f.ufc_fighter_id) ? booked.get(f.ufc_fighter_id) : null;
    let priority = scoreTarget({ ranked: r.ranked, champion: r.champion, nextCardIndex, active: f.career_status === 'active', externalAppearances: Number(c.external_appearances || 0) });
    priority += 1; // after visible priorities, eventually walk the full UFC-linked graph
    scored.push({ fighter: f, priority, rank: r, nextCardIndex, externalAppearances: Number(c.external_appearances || 0) });
  }
  scored.sort((a, b) => (b.priority - a.priority) || a.fighter.display_name.localeCompare(b.fighter.display_name));
  return { rankDate, upcoming, targets: scored.slice(0, limit).map((x) => x.fighter) };
}

async function explicitTargets(env, state, url) {
  const ids = url.searchParams.getAll('combat_fighter_id');
  const names = url.searchParams.getAll('fighter');
  const out = [];
  for (const id of ids) {
    const f = state.fighterById.get(id);
    if (!f?.ufc_fighter_id) throw new Error(`combat fighter ${id} is missing or not UFC-linked`);
    out.push(f);
  }
  for (const name of names) {
    const matches = state.fighters.filter((f) => f.ufc_fighter_id && normalizeName(f.display_name) === normalizeName(name));
    if (matches.length !== 1) throw new Error(`${name} resolved to ${matches.length} UFC-linked combat fighters; use combat_fighter_id`);
    out.push(matches[0]);
  }
  return [...new Map(out.map((f) => [f.id, f])).values()];
}

async function canonicalUfc(env, target, state) {
  const rows = await sbAll(env,
    `combat_career_bouts?select=career_bout_key,fighter_a_id,fighter_b_id,winner_id,event_name,event_date,method,method_raw,round,time_sec&source_scope=eq.ufc&or=(fighter_a_id.eq.${target.id},fighter_b_id.eq.${target.id})`);
  return rows.map((r) => {
    const other = r.fighter_a_id === target.id ? r.fighter_b_id : r.fighter_a_id;
    return { ...r, opponent_name: state.fighterById.get(other)?.display_name || null };
  });
}

function reviewPush(batch, state, { externalId = null, name, candidateIds = [], reason, context }) {
  const key = `${externalId || ''}|${normalizeName(name)}|${reason}`;
  if (state.reviewKeys.has(key)) return;
  state.reviewKeys.add(key);
  batch.reviews.push({ source_id: batch.source.id, raw_external_id: externalId, raw_name: name, candidate_fighter_ids: candidateIds, reason, context });
}

function registerMainIdentity(batch, state, target, page, proof) {
  const existing = state.wikiByTitle.get(page.title);
  if (existing && existing.combat_fighter_id !== target.id) {
    reviewPush(batch, state, { externalId: page.title, name: target.display_name, candidateIds: [existing.combat_fighter_id, target.id],
      reason: 'wikipedia_identity_collision', context: { page: page.url, proof } });
    return false;
  }
  const identity = {
    combat_fighter_id: target.id, source_id: batch.source.id, external_id: page.title, external_url: page.url,
    display_name: target.display_name, dob: page.record.dob, verification_state: 'verified', confidence: 100,
    evidence: { method: 'canonical_ufc_history_crosscheck', page_id: page.pageid, revision_id: page.revid, ...proof },
    last_observed_at: nowIso(),
  };
  batch.identities.push(identity);
  batch.aliases.push({ combat_fighter_id: target.id, source_id: batch.source.id, alias: target.display_name,
    normalized: normalizeName(target.display_name), kind: 'name', verification_state: 'verified',
    evidence: { wikipedia_title: page.title, revision_id: page.revid } });
  state.wikiByTitle.set(page.title, { ...identity });
  mapSet(state.normIds, normalizeName(target.display_name), target.id);
  return true;
}

async function packetFor(batch, target, page, proof) {
  const payload = {
    schema: 'combat.wikipedia-career/v1',
    fighter: { combat_fighter_id: target.id, display_name: target.display_name },
    source: { page_id: page.pageid, revision_id: page.revid, page_title: page.title, url: page.url },
    identity_proof: proof,
    career_rows: page.record.rows,
  };
  return {
    source_id: batch.source.id, ingest_key: `wikipedia:${page.pageid}:career`, packet_version: Number(page.revid || 1),
    packet_type: 'career', external_id: page.title, source_url: page.url, payload,
    payload_sha256: await sha256(JSON.stringify(payload)), validation_state: 'validated', validation_errors: [],
    fetched_at: nowIso(), updated_at: nowIso(),
  };
}

function ensureOpponent(batch, state, row, page) {
  const title = row.opponent_wiki_title;
  if (!title) {
    reviewPush(batch, state, { name: row.opponent, reason: 'wikipedia_opponent_has_no_stable_page_link',
      context: { source_page: page.url, row_index: row.row_index } });
    return null;
  }
  const known = state.wikiByTitle.get(title);
  if (known) return state.fighterById.get(known.combat_fighter_id) || batch.newFighterById.get(known.combat_fighter_id) || null;

  const collisions = [...(state.normIds.get(normalizeName(row.opponent)) || [])];
  if (collisions.length) {
    reviewPush(batch, state, { externalId: title, name: row.opponent, candidateIds: collisions,
      reason: 'wikipedia_opponent_matches_existing_name_without_identity_proof', context: { source_page: page.url, row_index: row.row_index } });
    return null;
  }

  const fighter = { id: crypto.randomUUID(), display_name: row.opponent, normalized_name: normalizeName(row.opponent),
    career_status: 'unknown', identity_state: 'source_native' };
  batch.fighters.push(fighter);
  batch.newFighterById.set(fighter.id, fighter);
  state.fighterById.set(fighter.id, fighter);
  mapSet(state.normIds, fighter.normalized_name, fighter.id);
  const identity = {
    combat_fighter_id: fighter.id, source_id: batch.source.id, external_id: title, external_url: wikiUrl(title),
    display_name: row.opponent, verification_state: 'verified', confidence: 100,
    evidence: { method: 'linked_opponent_on_verified_wikipedia_career_row', source_page_id: page.pageid,
      source_revision_id: page.revid, row_index: row.row_index }, last_observed_at: nowIso(),
  };
  batch.identities.push(identity);
  batch.aliases.push({ combat_fighter_id: fighter.id, source_id: batch.source.id, alias: row.opponent,
    normalized: fighter.normalized_name, kind: 'name', verification_state: 'verified',
    evidence: { wikipedia_title: title, source_page_id: page.pageid, source_revision_id: page.revid } });
  state.wikiByTitle.set(title, identity);
  return fighter;
}

function ensurePromotion(batch, state, row) {
  if (!RECOGNIZED_EXTERNAL_PROMOTIONS.has(row.promotion_slug)) return null;
  let p = state.promotionBySlug.get(row.promotion_slug);
  if (p) return p;
  p = { id: crypto.randomUUID(), slug: row.promotion_slug, name: row.promotion_name, source_id: batch.source.id,
    source_url: row.event_wiki_title ? wikiUrl(row.event_wiki_title) : null };
  batch.promotions.push(p);
  state.promotionBySlug.set(p.slug, p);
  return p;
}

function resultConflicts(a, b) {
  for (const key of ['outcome', 'winner_id', 'method', 'round', 'time_sec']) {
    if (a?.[key] != null && b?.[key] != null && String(a[key]) !== String(b[key])) return key;
  }
  return null;
}

function eventExternal(row) {
  return row.event_wiki_title ? `wikipedia:event:${row.event_wiki_title}`
    : `wikipedia:event:${row.promotion_slug}:${row.event_date}:${normalizeName(row.event).replaceAll(' ', '-')}`;
}

function boutExternal(eventKey, pageTitle, opponentTitle) {
  return `wikipedia:bout:${eventKey}|${[pageTitle, opponentTitle].sort().join('|')}`;
}

function addExternalRows(batch, state, target, page, reportItem) {
  for (const row of page.record.rows) {
    if (row.promotion_slug === 'ufc') continue;
    reportItem.candidate_external_rows += 1;
    if (!shouldPromoteCareerRow(row)) {
      if (!row.promotion_recognized) reportItem.unknown_promotion += 1;
      else reportItem.review_rows += 1;
      continue;
    }
    const opponent = ensureOpponent(batch, state, row, page);
    if (!opponent) { reportItem.review_rows += 1; continue; }
    if (opponent.id === target.id) { reportItem.review_rows += 1; continue; }
    const promotion = ensurePromotion(batch, state, row);
    if (!promotion) { reportItem.unknown_promotion += 1; continue; }

    const evKey = eventExternal(row);
    let event = state.eventByExternal.get(evKey);
    if (!event) {
      event = { id: crypto.randomUUID(), promotion_id: promotion.id, source_id: batch.source.id, external_event_id: evKey,
        name: row.event, event_date: row.event_date, status: 'complete',
        source_url: row.event_wiki_title ? wikiUrl(row.event_wiki_title) : page.url,
        source_record: { wikipedia_event_title: row.event_wiki_title, career_page_id: page.pageid,
          career_revision_id: page.revid, location_raw: row.location } };
      batch.events.push(event);
      state.eventByExternal.set(evKey, event);
    }

    const bKey = boutExternal(evKey, page.title, row.opponent_wiki_title);
    let bout = state.boutByExternal.get(bKey);
    if (!bout) {
      bout = { id: crypto.randomUUID(), event_id: event.id, source_id: batch.source.id, external_bout_id: bKey,
        fighter_a_id: target.id, fighter_b_id: opponent.id, competition_class: 'professional', is_title: false,
        status: 'complete', source_url: page.url,
        source_record: { career_page_id: page.pageid, career_revision_id: page.revid, row_index: row.row_index,
          record_text: row.record_text, wikipedia_event_title: row.event_wiki_title,
          wikipedia_opponent_title: row.opponent_wiki_title } };
      batch.bouts.push(bout);
      state.boutByExternal.set(bKey, bout);
    }

    const outcome = resultForCareerRow(row, target.id, opponent.id);
    const intended = { bout_id: bout.id, source_id: batch.source.id, ...outcome, method: row.method, method_raw: row.method_raw,
      round: row.round, time_sec: row.time_sec, source_url: page.url,
      source_record: { career_page_id: page.pageid, career_revision_id: page.revid, row_index: row.row_index } };
    const current = state.resultByBout.get(bout.id);
    const conflict = current ? resultConflicts(current, intended) : null;
    if (conflict) {
      reviewPush(batch, state, { externalId: bKey, name: `${target.display_name} vs ${opponent.display_name}`,
        candidateIds: [target.id, opponent.id], reason: 'wikipedia_bout_result_conflict',
        context: { field: conflict, current, intended, source_page: page.url } });
      reportItem.review_rows += 1;
      continue;
    }
    state.resultByBout.set(bout.id, intended);
    batch.resultsByBout.set(bout.id, intended);
    reportItem.written_bouts += 1;
  }
}

async function writeBatch(env, batch) {
  await sbUpsert(env, 'combat_fighters', batch.fighters, 'id');
  await sbUpsert(env, 'combat_fighter_identities', batch.identities, 'source_id,external_id');
  await sbUpsert(env, 'combat_fighter_aliases', batch.aliases, 'combat_fighter_id,source_id,normalized');
  await sbUpsert(env, 'combat_promotions', batch.promotions, 'slug');
  await sbUpsert(env, 'combat_events', batch.events, 'source_id,external_event_id');
  await sbUpsert(env, 'combat_bouts', batch.bouts, 'source_id,external_bout_id');
  await sbUpsert(env, 'combat_bout_results', [...batch.resultsByBout.values()], 'bout_id');
  await sbUpsert(env, 'combat_ingest_packets', batch.packets, 'source_id,ingest_key,packet_version');
  await sbInsert(env, 'combat_identity_review_queue', batch.reviews);
  return { new_fighters: batch.fighters.length, identities: batch.identities.length, aliases: batch.aliases.length,
    promotions: batch.promotions.length, events: batch.events.length, bouts: batch.bouts.length,
    results: batch.resultsByBout.size, packets: batch.packets.length, reviews: batch.reviews.length };
}

async function sourceRow(env) {
  const rows = await sbAll(env, `combat_sources?select=id,source_key,access_mode,rights_state,enabled,redistribution_allowed&source_key=eq.${SOURCE_KEY}`);
  return rows[0] || null;
}

async function run(env, { requestedTargets = [], limit = 5, write = false, mode = 'audit' } = {}) {
  const source = await sourceRow(env);
  if (!source || source.access_mode !== 'approved_ingest' || source.enabled !== true) {
    throw new Error('wikipedia_en is not enabled as approved_ingest');
  }
  const state = await loadState(env, source);
  let targets = requestedTargets;
  let targetMeta = { rankDate: null, upcoming: [] };
  if (!targets.length) {
    const selected = await automaticTargets(env, state, limit);
    targets = selected.targets;
    targetMeta = selected;
  }
  targets = targets.slice(0, limit);
  const wiki = new WikiClient(env);
  const report = {
    worker: WORKER, mode, write_requested: write, write_enabled: String(env.WRITE_ENABLED || 'false') === 'true',
    generated_at: nowIso(), targets: targets.length, rank_snapshot: targetMeta.rankDate,
    upcoming_events: targetMeta.upcoming?.map((e) => ({ name: e.name, event_date: e.event_date })) || [],
    wikipedia_requests: 0, fighters: [], totals: { resolved_pages: 0, verified_pages: 0, candidate_external_rows: 0,
      written_bouts: 0, review_rows: 0, unknown_promotion: 0 }, writes: null,
  };
  const batch = { source, fighters: [], newFighterById: new Map(), identities: [], aliases: [], promotions: [], events: [], bouts: [],
    resultsByBout: new Map(), packets: [], reviews: [] };
  const verified = [];

  for (const target of targets) {
    const item = { combat_fighter_id: target.id, name: target.display_name, status: 'pending', candidate_external_rows: 0,
      written_bouts: 0, review_rows: 0, unknown_promotion: 0 };
    report.fighters.push(item);
    const page = await wiki.resolveFighter(target.display_name);
    if (!page) { item.status = 'no_mma_record_page'; continue; }
    report.totals.resolved_pages += 1;
    const canonical = await canonicalUfc(env, target, state);
    const fighterNames = new Map(state.fighters.map((f) => [f.id, f.display_name]));
    const proof = verifyWikipediaCareer({ target, page, canonicalBouts: canonical, fighterNames });
    item.wikipedia_title = page.title;
    item.wikipedia_revision_id = page.revid;
    item.wikipedia_career_rows = page.record.rows.length;
    item.identity = proof;
    item.candidate_external_rows = page.record.rows.filter((r) => r.promotion_slug !== 'ufc').length;
    report.totals.candidate_external_rows += item.candidate_external_rows;
    if (!proof.verified) { item.status = 'identity_review'; continue; }
    item.status = 'verified';
    report.totals.verified_pages += 1;
    verified.push({ target, page, proof, item });
  }

  const mayWrite = write && String(env.WRITE_ENABLED || 'false') === 'true';
  if (mayWrite) {
    const accepted = [];
    for (const rec of verified) {
      if (!registerMainIdentity(batch, state, rec.target, rec.page, rec.proof)) {
        rec.item.status = 'identity_collision';
        continue;
      }
      batch.packets.push(await packetFor(batch, rec.target, rec.page, rec.proof));
      accepted.push(rec);
    }
    for (const rec of accepted) {
      addExternalRows(batch, state, rec.target, rec.page, rec.item);
      report.totals.written_bouts += rec.item.written_bouts;
      report.totals.review_rows += rec.item.review_rows;
      report.totals.unknown_promotion += rec.item.unknown_promotion;
    }
    report.writes = await writeBatch(env, batch);
  }

  report.wikipedia_requests = wiki.requests;
  return report;
}

function isAdmin(req, env) {
  const secret = String(env.ADMIN_TRIGGER_TOKEN || '');
  if (!secret) return false;
  const bearer = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const header = String(req.headers.get('x-admin-token') || '');
  return bearer === secret || header === secret;
}

async function discord(env, text) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  try { await fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) }); }
  catch { /* alerting never changes the data result */ }
}

async function handleAdmin(req, env, pathname) {
  if (!isAdmin(req, env)) return new Response('Not found', { status: 404 });
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit') || env.MAX_FIGHTERS_PER_RUN || 5)));
  const source = await sourceRow(env);
  if (!source) return json({ error: 'wikipedia_en source not configured' }, 503);
  const state = await loadState(env, source);
  let requested = await explicitTargets(env, state, url);
  if (pathname === '/admin/canary' && !requested.length) {
    for (const name of ['Kayla Harrison', 'Patricio Pitbull', 'Salahdine Parnasse']) {
      const matches = state.fighters.filter((f) => f.ufc_fighter_id && normalizeName(f.display_name) === normalizeName(name));
      if (matches.length === 1) requested.push(matches[0]);
    }
  }
  const write = pathname === '/admin/run' && url.searchParams.get('write') === '1';
  const report = await run(env, { requestedTargets: requested, limit, write, mode: pathname === '/admin/canary' ? 'canary' : 'manual' });
  return json(report);
}

async function health(env) {
  let source = null;
  try { source = await sourceRow(env); } catch (e) { source = { error: String(e.message || e) }; }
  return json({
    worker: WORKER,
    ok: true,
    schedule_enabled: String(env.SCHEDULE_ENABLED || 'false') === 'true',
    write_enabled: String(env.WRITE_ENABLED || 'false') === 'true',
    max_fighters_per_run: Number(env.MAX_FIGHTERS_PER_RUN || 5),
    max_wikimedia_requests_per_run: Number(env.MAX_WIKIMEDIA_REQUESTS_PER_RUN || 40),
    source,
    policy: 'direct Wikimedia Action API; canonical UFC checksum; no name-only merges; no challenge bypass',
  });
}

async function scheduledRun(env) {
  if (String(env.SCHEDULE_ENABLED || 'false') !== 'true') return { skipped: true, reason: 'SCHEDULE_ENABLED=false' };
  const write = String(env.WRITE_ENABLED || 'false') === 'true';
  const limit = Math.max(1, Math.min(20, Number(env.MAX_FIGHTERS_PER_RUN || 5)));
  const report = await run(env, { limit, write, mode: 'scheduled' });
  await discord(env, `🥊 ${WORKER}: ${report.totals.verified_pages}/${report.targets} identities verified · ${report.totals.written_bouts} external bouts · ${report.totals.review_rows} review rows · writes=${write}`);
  return report;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/health') return health(env);
      if (req.method === 'POST' && (url.pathname === '/admin/canary' || url.pathname === '/admin/run')) return handleAdmin(req, env, url.pathname);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      await discord(env, `🚨 ${WORKER}: ${String(e?.stack || e?.message || e).slice(0, 1600)}`);
      return json({ error: String(e?.message || e), worker: WORKER }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scheduledRun(env).catch((e) => discord(env, `🚨 ${WORKER} scheduled failure: ${String(e?.stack || e).slice(0, 1600)}`)));
  },
};

export { automaticTargets, run };
