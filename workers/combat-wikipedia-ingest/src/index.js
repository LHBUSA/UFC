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
const inIds = (ids) => `(${[...new Set(ids)].join(',')})`;
const compactName = (value) => normalizeName(value).replaceAll(' ', '');

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
  const headers = { apikey: key, Accept: 'application/json', 'content-type': 'application/json', ...extra };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return headers;
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 300)}`);
  }
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
  let total = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await sbRequest(env, `${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: 'POST',
      body: chunk,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    total += chunk.length;
  }
  return total;
}

async function sbInsert(env, table, rows, chunkSize = 100) {
  let total = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await sbRequest(env, table, { method: 'POST', body: chunk, prefer: 'return=minimal' });
    total += chunk.length;
  }
  return total;
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
    const query = new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await fetch(`${this.api}?${query}`, {
        headers: {
          'User-Agent': this.userAgent,
          'Api-User-Agent': this.userAgent,
          Accept: 'application/json',
        },
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
        if (body.error.code === 'maxlag' && attempt < 4) {
          await sleep(1000 * (2 ** attempt));
          continue;
        }
        throw new Error(`Wikimedia API ${body.error.code || 'error'}: ${body.error.info || 'unknown'}`);
      }
      return body;
    }
    throw new Error('Wikimedia API retries exhausted');
  }

  async exactPage(name) {
    const body = await this.get({ action: 'query', titles: name, redirects: '1', prop: 'info|pageprops', inprop: 'url' });
    const page = body.query?.pages?.[0];
    return !page || page.missing ? null : page;
  }

  async search(name) {
    const body = await this.get({ action: 'query', list: 'search', srsearch: `"${name}" mixed martial arts fighter`, srlimit: '5', srnamespace: '0' });
    return body.query?.search || [];
  }

  async parsePage(pageid) {
    const body = await this.get({ action: 'parse', pageid: String(pageid), prop: 'text|revid|displaytitle', disableeditsection: '1' });
    const page = body.parse || {};
    if (!page.text) throw new Error(`Wikipedia page ${pageid} returned no parsed HTML`);
    return page;
  }

  async resolveFighter(name) {
    const exact = await this.exactPage(name);
    const seen = new Set();
    const inspect = async (candidate) => {
      const pageid = Number(candidate?.pageid || 0);
      if (!pageid || seen.has(pageid)) return null;
      seen.add(pageid);
      const parsed = await this.parsePage(pageid);
      const record = parseMmaRecord(parsed.text);
      if (!record.rows.length) return null;
      const title = candidate.title || parsed.title || name;
      return { pageid, title, revid: parsed.revid, displaytitle: parsed.displaytitle, url: wikiUrl(title), record };
    };

    if (exact && exact.pageprops?.disambiguation === undefined) {
      const page = await inspect(exact);
      if (page) return page;
    }
    for (const candidate of await this.search(name)) {
      const page = await inspect(candidate);
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

function boutPairKey(eventId, fighterAId, fighterBId) {
  return `${eventId}|${[fighterAId, fighterBId].sort().join('|')}`;
}

async function sourceRow(env) {
  const rows = await sbAll(env, `combat_sources?select=id,source_key,access_mode,rights_state,enabled,redistribution_allowed&source_key=eq.${SOURCE_KEY}`);
  return rows[0] || null;
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
  const normIds = new Map();
  const compactIds = new Map();
  for (const f of fighters) {
    mapSet(normIds, normalizeName(f.display_name), f.id);
    mapSet(compactIds, compactName(f.display_name), f.id);
  }
  for (const alias of aliases) {
    if (alias.verification_state === 'rejected') continue;
    mapSet(normIds, alias.normalized, alias.combat_fighter_id);
    mapSet(compactIds, compactName(alias.normalized), alias.combat_fighter_id);
  }

  const wikiByTitle = new Map();
  const wikiByFighter = new Map();
  for (const identity of wikiIdentities) {
    if (identity.verification_state === 'rejected') continue;
    wikiByTitle.set(identity.external_id, identity);
    if (identity.verification_state === 'verified') wikiByFighter.set(identity.combat_fighter_id, identity);
  }
  const promotionBySlug = new Map(promotions.map((p) => [p.slug, p]));
  const eventByExternal = new Map(wikiEvents.filter((e) => e.external_event_id).map((e) => [e.external_event_id, e]));
  const boutByExternal = new Map();
  const boutByPair = new Map();
  for (const bout of wikiBouts) {
    if (bout.external_bout_id) boutByExternal.set(bout.external_bout_id, bout);
    boutByPair.set(boutPairKey(bout.event_id, bout.fighter_a_id, bout.fighter_b_id), bout);
  }
  const resultByBout = new Map(wikiResults.map((r) => [r.bout_id, r]));
  const careerByCombat = new Map(career.map((c) => [c.combat_fighter_id, c]));
  const reviewKeys = new Set(pendingReviews.map((r) => `${r.raw_external_id || ''}|${normalizeName(r.raw_name)}|${r.reason}`));
  return { fighters, fighterById, normIds, compactIds, wikiByTitle, wikiByFighter, promotionBySlug, eventByExternal,
    boutByExternal, boutByPair, resultByBout, careerByCombat, reviewKeys };
}

async function automaticTargets(env, state, limit) {
  const rankDateRows = await sbAll(env, 'ufc_rankings?select=snapshot_date&order=snapshot_date.desc&limit=1');
  const rankDate = rankDateRows[0]?.snapshot_date || null;
  const rankings = rankDate ? await sbAll(env, `ufc_rankings?select=fighter_id,rank&snapshot_date=eq.${rankDate}&fighter_id=not.is.null`) : [];
  const rankByUfc = new Map();
  for (const row of rankings) {
    const current = rankByUfc.get(row.fighter_id) || { ranked: false, champion: false };
    current.champion ||= Number(row.rank) === 0;
    current.ranked ||= Number(row.rank) > 0;
    rankByUfc.set(row.fighter_id, current);
  }

  const upcoming = await sbAll(env, `ufc_events?select=id,name,event_date&event_date=gte.${today()}&card_status=neq.complete&order=event_date.asc&limit=3`);
  const eventIndex = new Map(upcoming.map((event, index) => [event.id, index]));
  const booked = new Map();
  if (upcoming.length) {
    const bouts = await sbAll(env, `ufc_bouts?select=event_id,fighter_a_id,fighter_b_id,status&event_id=in.${inIds(upcoming.map((e) => e.id))}`);
    for (const bout of bouts) {
      if (bout.status === 'cancelled' || bout.status === 'replaced') continue;
      const index = eventIndex.get(bout.event_id);
      for (const fighterId of [bout.fighter_a_id, bout.fighter_b_id]) {
        if (!booked.has(fighterId) || index < booked.get(fighterId)) booked.set(fighterId, index);
      }
    }
  }

  const refreshDays = Math.max(1, Number(env.REFRESH_DAYS || 30));
  const refreshCutoff = Date.now() - refreshDays * 86400000;
  const scored = [];
  for (const fighter of state.fighters) {
    if (!fighter.ufc_fighter_id || fighter.identity_state === 'merged') continue;
    const wiki = state.wikiByFighter.get(fighter.id);
    if (wiki) {
      const fresh = wiki.last_observed_at && Date.parse(wiki.last_observed_at) > refreshCutoff;
      if (fighter.career_status !== 'active' || fresh || !wiki.last_observed_at) continue;
    }
    const ranking = rankByUfc.get(fighter.ufc_fighter_id) || {};
    const career = state.careerByCombat.get(fighter.id) || {};
    const nextCardIndex = booked.has(fighter.ufc_fighter_id) ? booked.get(fighter.ufc_fighter_id) : null;
    const priority = 1 + scoreTarget({
      ranked: ranking.ranked,
      champion: ranking.champion,
      nextCardIndex,
      active: fighter.career_status === 'active',
      externalAppearances: Number(career.external_appearances || 0),
    });
    scored.push({ fighter, priority });
  }
  scored.sort((a, b) => (b.priority - a.priority) || a.fighter.display_name.localeCompare(b.fighter.display_name));
  return { rankDate, upcoming, targets: scored.slice(0, limit).map((x) => x.fighter) };
}

function explicitTargets(state, ids, names) {
  const out = [];
  for (const id of ids) {
    const fighter = state.fighterById.get(id);
    if (!fighter?.ufc_fighter_id) throw new Error(`combat fighter ${id} is missing or not UFC-linked`);
    out.push(fighter);
  }
  for (const name of names) {
    const normalized = normalizeName(name);
    const matches = state.fighters.filter((f) => f.ufc_fighter_id && normalizeName(f.display_name) === normalized);
    if (matches.length !== 1) throw new Error(`${name} resolved to ${matches.length} UFC-linked combat fighters; use combat_fighter_id`);
    out.push(matches[0]);
  }
  return [...new Map(out.map((f) => [f.id, f])).values()];
}

async function canonicalUfc(env, target, state) {
  const rows = await sbAll(env,
    `combat_career_bouts?select=career_bout_key,fighter_a_id,fighter_b_id,winner_id,event_name,event_date,method,method_raw,round,time_sec,status&source_scope=eq.ufc&status=eq.complete&or=(fighter_a_id.eq.${target.id},fighter_b_id.eq.${target.id})`);
  return rows.map((row) => {
    const opponentId = row.fighter_a_id === target.id ? row.fighter_b_id : row.fighter_a_id;
    return { ...row, opponent_name: state.fighterById.get(opponentId)?.display_name || null };
  });
}

function reviewPush(batch, state, { externalId = null, name, candidateIds = [], reason, context }) {
  const key = `${externalId || ''}|${normalizeName(name)}|${reason}`;
  if (state.reviewKeys.has(key)) return;
  state.reviewKeys.add(key);
  batch.reviews.push({ source_id: batch.source.id, raw_external_id: externalId, raw_name: name,
    candidate_fighter_ids: candidateIds, reason, context });
}

function registerMainIdentity(batch, state, target, page, proof) {
  const existing = state.wikiByTitle.get(page.title);
  if (existing && existing.combat_fighter_id !== target.id) {
    reviewPush(batch, state, { externalId: page.title, name: target.display_name,
      candidateIds: [existing.combat_fighter_id, target.id], reason: 'wikipedia_identity_collision',
      context: { page: page.url, proof } });
    return false;
  }
  const identity = {
    combat_fighter_id: target.id,
    source_id: batch.source.id,
    external_id: page.title,
    external_url: page.url,
    display_name: target.display_name,
    dob: page.record.dob,
    verification_state: 'verified',
    confidence: 100,
    evidence: { method: 'canonical_completed_ufc_history_crosscheck', page_id: page.pageid, revision_id: page.revid, ...proof },
    last_observed_at: nowIso(),
  };
  batch.identities.push(identity);
  batch.aliases.push({
    combat_fighter_id: target.id,
    source_id: batch.source.id,
    alias: target.display_name,
    normalized: normalizeName(target.display_name),
    kind: 'name',
    verification_state: 'verified',
    evidence: { wikipedia_title: page.title, revision_id: page.revid },
  });
  state.wikiByTitle.set(page.title, identity);
  state.wikiByFighter.set(target.id, identity);
  mapSet(state.normIds, normalizeName(target.display_name), target.id);
  mapSet(state.compactIds, compactName(target.display_name), target.id);
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
    source_id: batch.source.id,
    ingest_key: `wikipedia:${page.pageid}:career`,
    packet_version: Number(page.revid || 1),
    packet_type: 'career',
    external_id: page.title,
    source_url: page.url,
    payload,
    payload_sha256: await sha256(JSON.stringify(payload)),
    validation_state: 'validated',
    validation_errors: [],
    fetched_at: nowIso(),
    updated_at: nowIso(),
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

  const candidates = new Set([
    ...(state.normIds.get(normalizeName(row.opponent)) || []),
    ...(state.compactIds.get(compactName(row.opponent)) || []),
  ]);
  if (candidates.size) {
    reviewPush(batch, state, { externalId: title, name: row.opponent, candidateIds: [...candidates],
      reason: 'wikipedia_opponent_matches_existing_identity_without_page_proof',
      context: { source_page: page.url, row_index: row.row_index } });
    return null;
  }

  const fighter = {
    id: crypto.randomUUID(),
    display_name: row.opponent,
    normalized_name: normalizeName(row.opponent),
    career_status: 'unknown',
    identity_state: 'source_native',
  };
  batch.fighters.push(fighter);
  batch.newFighterById.set(fighter.id, fighter);
  state.fighterById.set(fighter.id, fighter);
  mapSet(state.normIds, fighter.normalized_name, fighter.id);
  mapSet(state.compactIds, compactName(fighter.display_name), fighter.id);

  const identity = {
    combat_fighter_id: fighter.id,
    source_id: batch.source.id,
    external_id: title,
    external_url: wikiUrl(title),
    display_name: row.opponent,
    verification_state: 'verified',
    confidence: 100,
    evidence: { method: 'linked_opponent_on_verified_wikipedia_career_row', source_page_id: page.pageid,
      source_revision_id: page.revid, row_index: row.row_index },
    last_observed_at: nowIso(),
  };
  batch.identities.push(identity);
  batch.aliases.push({
    combat_fighter_id: fighter.id,
    source_id: batch.source.id,
    alias: row.opponent,
    normalized: fighter.normalized_name,
    kind: 'name',
    verification_state: 'verified',
    evidence: { wikipedia_title: title, source_page_id: page.pageid, source_revision_id: page.revid },
  });
  state.wikiByTitle.set(title, identity);
  return fighter;
}

function ensurePromotion(batch, state, row) {
  if (!RECOGNIZED_EXTERNAL_PROMOTIONS.has(row.promotion_slug)) return null;
  let promotion = state.promotionBySlug.get(row.promotion_slug);
  if (promotion) return promotion;
  promotion = {
    id: crypto.randomUUID(),
    slug: row.promotion_slug,
    name: row.promotion_name,
    source_id: batch.source.id,
    source_url: row.event_wiki_title ? wikiUrl(row.event_wiki_title) : null,
  };
  batch.promotions.push(promotion);
  state.promotionBySlug.set(promotion.slug, promotion);
  return promotion;
}

function resultConflictField(current, intended) {
  for (const key of ['outcome', 'winner_id', 'method', 'round', 'time_sec']) {
    if (current?.[key] != null && intended?.[key] != null && String(current[key]) !== String(intended[key])) return key;
  }
  return null;
}

function eventExternal(row) {
  if (row.event_wiki_title) return `wikipedia:event:${row.event_wiki_title}`;
  return `wikipedia:event:${row.promotion_slug}:${row.event_date}:${normalizeName(row.event).replaceAll(' ', '-')}`;
}

function boutExternal(eventKey, pageTitle, opponentTitle) {
  return `wikipedia:bout:${eventKey}|${[pageTitle, opponentTitle].sort().join('|')}`;
}

function addExternalRows(batch, state, target, page, item) {
  for (const row of page.record.rows) {
    if (row.promotion_slug === 'ufc') continue;
    if (!shouldPromoteCareerRow(row)) {
      if (!row.promotion_recognized) item.unknown_promotion += 1;
      else item.review_rows += 1;
      continue;
    }
    const opponent = ensureOpponent(batch, state, row, page);
    if (!opponent || opponent.id === target.id) {
      item.review_rows += 1;
      continue;
    }
    const promotion = ensurePromotion(batch, state, row);
    if (!promotion) {
      item.unknown_promotion += 1;
      continue;
    }

    const eventKey = eventExternal(row);
    let event = state.eventByExternal.get(eventKey);
    if (!event) {
      event = {
        id: crypto.randomUUID(),
        promotion_id: promotion.id,
        source_id: batch.source.id,
        external_event_id: eventKey,
        name: row.event,
        event_date: row.event_date,
        status: 'complete',
        source_url: row.event_wiki_title ? wikiUrl(row.event_wiki_title) : page.url,
        source_record: { wikipedia_event_title: row.event_wiki_title, career_page_id: page.pageid,
          career_revision_id: page.revid, location_raw: row.location },
      };
      batch.events.push(event);
      state.eventByExternal.set(eventKey, event);
    }

    const externalBoutKey = boutExternal(eventKey, page.title, row.opponent_wiki_title);
    const pairKey = boutPairKey(event.id, target.id, opponent.id);
    let bout = state.boutByExternal.get(externalBoutKey) || state.boutByPair.get(pairKey);
    if (!bout) {
      bout = {
        id: crypto.randomUUID(),
        event_id: event.id,
        source_id: batch.source.id,
        external_bout_id: externalBoutKey,
        fighter_a_id: target.id,
        fighter_b_id: opponent.id,
        competition_class: 'professional',
        is_title: false,
        status: 'complete',
        source_url: page.url,
        source_record: { career_page_id: page.pageid, career_revision_id: page.revid, row_index: row.row_index,
          record_text: row.record_text, wikipedia_event_title: row.event_wiki_title,
          wikipedia_opponent_title: row.opponent_wiki_title },
      };
      batch.bouts.push(bout);
      state.boutByExternal.set(externalBoutKey, bout);
      state.boutByPair.set(pairKey, bout);
    }

    const outcome = resultForCareerRow(row, target.id, opponent.id);
    const intended = {
      bout_id: bout.id,
      source_id: batch.source.id,
      ...outcome,
      method: row.method,
      method_raw: row.method_raw,
      round: row.round,
      time_sec: row.time_sec,
      source_url: page.url,
      source_record: { career_page_id: page.pageid, career_revision_id: page.revid, row_index: row.row_index },
    };
    const current = state.resultByBout.get(bout.id);
    const conflict = current ? resultConflictField(current, intended) : null;
    if (conflict) {
      reviewPush(batch, state, { externalId: externalBoutKey, name: `${target.display_name} vs ${opponent.display_name}`,
        candidateIds: [target.id, opponent.id], reason: 'wikipedia_bout_result_conflict',
        context: { field: conflict, current, intended, source_page: page.url } });
      item.review_rows += 1;
      continue;
    }
    state.resultByBout.set(bout.id, intended);
    batch.resultsByBout.set(bout.id, intended);
    item.accepted_external_rows += 1;
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
  return {
    new_fighters: batch.fighters.length,
    identities_upserted: batch.identities.length,
    aliases_upserted: batch.aliases.length,
    new_promotions: batch.promotions.length,
    new_events: batch.events.length,
    new_bouts: batch.bouts.length,
    results_upserted: batch.resultsByBout.size,
    packets_upserted: batch.packets.length,
    new_review_rows: batch.reviews.length,
  };
}

async function run(env, { explicitIds = [], explicitNames = [], limit = 5, write = false, mode = 'audit' } = {}) {
  const source = await sourceRow(env);
  if (!source || source.access_mode !== 'approved_ingest' || source.enabled !== true) {
    throw new Error('wikipedia_en is not enabled as approved_ingest');
  }
  const state = await loadState(env, source);
  let targets;
  let targetMeta = { rankDate: null, upcoming: [] };
  if (explicitIds.length || explicitNames.length) {
    targets = explicitTargets(state, explicitIds, explicitNames).slice(0, limit);
  } else {
    const selected = await automaticTargets(env, state, limit);
    targets = selected.targets;
    targetMeta = selected;
  }

  const wiki = new WikiClient(env);
  const report = {
    worker: WORKER,
    mode,
    write_requested: write,
    write_enabled: String(env.WRITE_ENABLED || 'false') === 'true',
    generated_at: nowIso(),
    targets: targets.length,
    rank_snapshot: targetMeta.rankDate,
    upcoming_events: targetMeta.upcoming.map((e) => ({ name: e.name, event_date: e.event_date })),
    wikipedia_requests: 0,
    fighters: [],
    totals: { resolved_pages: 0, verified_pages: 0, candidate_external_rows: 0, promotable_external_rows: 0,
      accepted_external_rows: 0, review_rows: 0, unknown_promotion: 0 },
    writes: null,
  };
  const batch = { source, fighters: [], newFighterById: new Map(), identities: [], aliases: [], promotions: [], events: [], bouts: [],
    resultsByBout: new Map(), packets: [], reviews: [] };
  const verified = [];

  for (const target of targets) {
    const item = { combat_fighter_id: target.id, name: target.display_name, status: 'pending', candidate_external_rows: 0,
      promotable_external_rows: 0, accepted_external_rows: 0, review_rows: 0, unknown_promotion: 0 };
    report.fighters.push(item);
    const page = await wiki.resolveFighter(target.display_name);
    if (!page) {
      item.status = 'no_mma_record_page';
      continue;
    }
    report.totals.resolved_pages += 1;
    const canonical = await canonicalUfc(env, target, state);
    const fighterNames = new Map(state.fighters.map((f) => [f.id, f.display_name]));
    const proof = verifyWikipediaCareer({ target, page, canonicalBouts: canonical, fighterNames });
    item.wikipedia_title = page.title;
    item.wikipedia_revision_id = page.revid;
    item.wikipedia_career_rows = page.record.rows.length;
    item.candidate_external_rows = page.record.rows.filter((r) => r.promotion_slug !== 'ufc').length;
    item.promotable_external_rows = page.record.rows.filter(shouldPromoteCareerRow).length;
    item.identity = proof;
    report.totals.candidate_external_rows += item.candidate_external_rows;
    report.totals.promotable_external_rows += item.promotable_external_rows;
    if (!proof.verified) {
      item.status = 'identity_review';
      continue;
    }
    item.status = 'verified';
    report.totals.verified_pages += 1;
    verified.push({ target, page, proof, item });
  }

  const mayWrite = write && report.write_enabled;
  if (mayWrite) {
    const accepted = [];
    for (const record of verified) {
      if (!registerMainIdentity(batch, state, record.target, record.page, record.proof)) {
        record.item.status = 'identity_collision';
        continue;
      }
      batch.packets.push(await packetFor(batch, record.target, record.page, record.proof));
      accepted.push(record);
    }
    for (const record of accepted) {
      addExternalRows(batch, state, record.target, record.page, record.item);
      report.totals.accepted_external_rows += record.item.accepted_external_rows;
      report.totals.review_rows += record.item.review_rows;
      report.totals.unknown_promotion += record.item.unknown_promotion;
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
  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: String(text).slice(0, 1900) }),
    });
  } catch {
    // Alerting never changes the data result.
  }
}

async function handleAdmin(req, env, pathname) {
  if (!isAdmin(req, env)) return new Response('Not found', { status: 404 });
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit') || env.MAX_FIGHTERS_PER_RUN || 5)));
  const explicitIds = url.searchParams.getAll('combat_fighter_id');
  const explicitNames = url.searchParams.getAll('fighter');
  if (pathname === '/admin/canary' && !explicitIds.length && !explicitNames.length) {
    explicitNames.push('Kayla Harrison', 'Patricio Pitbull', 'Salahdine Parnasse');
  }
  const write = pathname === '/admin/run' && url.searchParams.get('write') === '1';
  const report = await run(env, {
    explicitIds,
    explicitNames,
    limit,
    write,
    mode: pathname === '/admin/canary' ? 'canary' : 'manual',
  });
  return json(report);
}

async function health(env) {
  let source;
  try { source = await sourceRow(env); }
  catch (error) { source = { error: String(error?.message || error) }; }
  return json({
    worker: WORKER,
    ok: true,
    schedule_enabled: String(env.SCHEDULE_ENABLED || 'false') === 'true',
    write_enabled: String(env.WRITE_ENABLED || 'false') === 'true',
    max_fighters_per_run: Number(env.MAX_FIGHTERS_PER_RUN || 5),
    max_wikimedia_requests_per_run: Number(env.MAX_WIKIMEDIA_REQUESTS_PER_RUN || 40),
    source,
    policy: 'direct Wikimedia Action API; completed-UFC checksum; no name-only merges; no challenge bypass',
  });
}

async function scheduledRun(env) {
  if (String(env.SCHEDULE_ENABLED || 'false') !== 'true') return { skipped: true, reason: 'SCHEDULE_ENABLED=false' };
  const write = String(env.WRITE_ENABLED || 'false') === 'true';
  const limit = Math.max(1, Math.min(20, Number(env.MAX_FIGHTERS_PER_RUN || 5)));
  const report = await run(env, { limit, write, mode: 'scheduled' });
  const newBouts = report.writes?.new_bouts || 0;
  await discord(env, `${WORKER}: ${report.totals.verified_pages}/${report.targets} identities verified; ${newBouts} new external bouts; ${report.totals.review_rows} review rows; writes=${write}`);
  return report;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/health') return health(env);
      if (req.method === 'POST' && (url.pathname === '/admin/canary' || url.pathname === '/admin/run')) {
        return handleAdmin(req, env, url.pathname);
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      await discord(env, `${WORKER}: ${String(error?.stack || error?.message || error).slice(0, 1600)}`);
      return json({ error: String(error?.message || error), worker: WORKER }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scheduledRun(env).catch((error) => discord(env,
      `${WORKER} scheduled failure: ${String(error?.stack || error).slice(0, 1600)}`)));
  },
};

export { automaticTargets, run };
