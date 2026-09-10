/* The UFC intelligence packet.
 *
 * A source story is the EVENT TRIGGER. This is the INTELLIGENCE LAYER. The
 * difference between PropBetEdge and an MMA news site is entirely here: anyone
 * can report that Fighter B replaced Fighter C, and only we can say what that
 * does to the tape, the finishing profile, the grappling exchange and the
 * markets that were priced on the old matchup.
 *
 * EVERY FACT CARRIES ITS PROVENANCE, because the editorial gate downstream is
 * built on that and not on trust:
 *
 *   class A   our own tables. May be asserted flatly.
 *   class B   the fetched source article. Usable only with attribution.
 *   class C   anything else. Rejected.
 *
 * So a number is not a number here, it is {value, class, source}. The gate then
 * becomes a lookup rather than a judgement, which is what makes "no invented
 * numbers" enforceable instead of aspirational.
 *
 * ABSENCE IS A FACT TOO. A section with no data does not get a paragraph saying
 * there is no data - it gets no section. Writing about the absence of evidence
 * is the other way to pad, and `odds_status: 'unavailable'` exists precisely so
 * the model is forbidden from implying a price it was never given.
 */

const ROUND_STATS_LIMIT = 400;

/* ------------------------------------------------------------ helpers */

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const recordOf = (f) => (f?.record_w == null ? null
  : `${f.record_w}-${f.record_l ?? 0}-${f.record_d ?? 0}${f.record_nc ? ` (${f.record_nc} NC)` : ''}`);

function ageOn(dob, onDate) {
  if (!dob || !onDate) return null;
  const d = new Date(dob), on = new Date(onDate);
  if (Number.isNaN(d.getTime()) || Number.isNaN(on.getTime())) return null;
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  const m = on.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

const heightStr = (inches) => (inches == null ? null
  : `${Math.floor(Number(inches) / 12)}'${Math.round(Number(inches) % 12)}"`);

/**
 * Number tokens, defined ONCE so the packet and the validator cannot disagree.
 *
 * They did disagree, and it held a finished article. A UFC record is written
 * "23-4" and a naive [-+]?\d+ reads the hyphen as a minus sign, producing a
 * token "-4" that appears nowhere in the packet - so the gate rejected an
 * article for inventing a number the model had not invented. Any tokenizer
 * used on one side of a whitelist has to be the same function used on the
 * other, or the whitelist is comparing two different alphabets.
 *
 * Hyphen-joined digit runs are therefore split, not signed: 23-4-0 is three
 * values, and 5'11" is five and eleven. A genuine negative still parses,
 * because a rank change of -4 is preceded by a space rather than a digit.
 */
export function numberTokens(text) {
  const normalised = String(text || '')
    .replace(/(\d)\s*[-‐-―]\s*(?=\d)/g, '$1 ')   /* 23-4-0, 6-4 */
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1');                /* 1,234 */
  return [...normalised.matchAll(/(?<![\w.])[-+]?\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

/** Every number the packet contains, with the class that governs its use. */
/* Keys whose digits are addressing, not facts. A UUID, a URL slug or an image
 * hash contains long digit runs that mean nothing; admitting them as class A
 * would let the model quote "469714" from a source URL and call it a statistic.
 * These are matched by KEY, and by shape below, because both leak. */
const OPAQUE_KEY = /(^|_)(id|ids|url|href|slug|hash|key|token|image|thumbnail|video_id|channel_id|fingerprint|signature)$/i;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_LIKE = /^(https?:)?\/\//i;

export function factNumbers(packet) {
  const out = new Map();
  const walk = (node, key = '') => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach((v) => walk(v, key)); return; }
    if (typeof node === 'object') { for (const [k, v] of Object.entries(node)) walk(v, k); return; }

    const n = Number(node);
    if (Number.isFinite(n) && String(node).trim() !== '') { out.set(String(n), 'A'); return; }

    /* THE STRING CASE, WHICH USED TO BE DROPPED ENTIRELY.
     *
     * The packet stores plenty of facts as formatted strings because that is
     * what the renderer consumes: a record is "28-5-0", a height is 5'11", an
     * event is "UFC 324", a date is "2026-01-24". Number() returns NaN for all
     * of them, so every digit inside was invisible here -- while the prose side
     * tokenises with numberTokens(), which DOES look inside strings.
     *
     * The two sides therefore disagreed, and the gate blamed the model for it:
     * a fighter's own win count came back as "class C number 28 is in no part
     * of the packet" while 28 sat in the packet. Measured on 48 hours of live
     * traffic that was the single largest cause of held articles after the
     * credential outage.
     *
     * Both sides now tokenise the same way. This makes the gate more accurate,
     * not more permissive: a number the model actually invents still appears in
     * no field and is still class C. */
    if (typeof node === 'string' && !OPAQUE_KEY.test(key) && !UUID_LIKE.test(node.trim()) && !URL_LIKE.test(node.trim())) {
      for (const t of numberTokens(node)) {
        const k = String(Number(t));
        if (k !== 'NaN' && !out.has(k)) out.set(k, 'A');
      }
    }
  };
  walk({ ...packet, source_excerpt: undefined, source: undefined });
  /* Class B: numbers that exist only in the fetched source article. They are
   * permitted in the body, but only in a sentence that attributes them. */
  for (const t of numberTokens(packet.source?.excerpt || '')) {
    const k = String(Number(t));
    if (!out.has(k)) out.set(k, 'B');
  }
  return out;
}

/* ------------------------------------------------------------ loaders */

async function fighterCore(sb, id) {
  const rows = await sb.select('ufc_fighters',
    `select=id,name,nickname,dob,stance,height_in,reach_in,weight_lbs,record_w,record_l,record_d,record_nc,`
    + `career_slpm,career_str_acc,career_sapm,career_str_def,career_td_avg,career_td_acc,career_td_def,career_sub_avg,is_active`
    + `&id=eq.${id}&limit=1`);
  return rows[0] || null;
}

/** Last five completed bouts, with method, round and the opponent's name. */
async function recentForm(sb, fighterId, today) {
  const bouts = await sb.select('ufc_bouts',
    `select=id,event_id,fighter_a_id,fighter_b_id,weight_class,is_title,scheduled_rounds,`
    + `event:ufc_events(name,event_date),result:ufc_bout_results(winner_id,method,round,time_sec,method_raw)`
    + `&or=(fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId})&limit=60`);
  const done = bouts
    .filter((b) => b.result && b.event?.event_date && b.event.event_date <= today)
    .sort((a, b) => b.event.event_date.localeCompare(a.event.event_date));

  const oppIds = [...new Set(done.slice(0, 5).map((b) => (b.fighter_a_id === fighterId ? b.fighter_b_id : b.fighter_a_id)))].filter(Boolean);
  const opps = oppIds.length
    ? await sb.select('ufc_fighters', `select=id,name&id=in.(${oppIds.join(',')})`)
    : [];
  const nameById = new Map(opps.map((o) => [o.id, o.name]));

  const last5 = done.slice(0, 5).map((b) => {
    const r = b.result;
    const oppId = b.fighter_a_id === fighterId ? b.fighter_b_id : b.fighter_a_id;
    return {
      date: b.event.event_date,
      event: b.event.name,
      opponent: nameById.get(oppId) || null,
      result: r.winner_id === fighterId ? 'W' : (r.winner_id ? 'L' : 'D/NC'),
      method: r.method || r.method_raw || null,
      round: r.round ?? null,
      is_title: Boolean(b.is_title),
    };
  });

  /* Career shape across everything we hold, not just the last five: a finish
   * rate on three bouts is noise and the sample size has to travel with it. */
  let w = 0, l = 0, ko = 0, sub = 0, dec = 0, finishedAgainst = 0;
  for (const b of done) {
    const r = b.result;
    const won = r.winner_id === fighterId;
    const m = String(r.method || '').toLowerCase();
    if (won) {
      w += 1;
      if (/ko|tko/.test(m)) ko += 1;
      else if (/sub/.test(m)) sub += 1;
      else dec += 1;
    } else if (r.winner_id) {
      l += 1;
      if (/ko|tko|sub/.test(m)) finishedAgainst += 1;
    }
  }
  return {
    archive_bouts: done.length,
    wins: w, losses: l,
    wins_by_ko_tko: ko, wins_by_submission: sub, wins_by_decision: dec,
    finish_rate_on_wins_pct: w ? Math.round(((ko + sub) / w) * 100) : null,
    times_finished: finishedAgainst,
    last_five: last5,
    days_since_last_bout: last5[0] ? Math.round((Date.parse(today) - Date.parse(last5[0].date)) / 86400e3) : null,
  };
}

/** Round-level totals: the grappling and volume signal UFC Stats averages hide. */
async function roundStats(sb, fighterId) {
  const rows = await sb.select('ufc_bout_round_stats',
    `select=bout_id,round,sig_str_landed,sig_str_att,td_landed,td_att,ctrl_sec,kd,sub_att,head_landed,body_landed,leg_landed`
    + `&fighter_id=eq.${fighterId}&limit=${ROUND_STATS_LIMIT}`);
  if (!rows.length) return null;
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const bouts = new Set(rows.map((r) => r.bout_id)).size;
  const sigAtt = sum('sig_str_att'), tdAtt = sum('td_att'), ctrl = sum('ctrl_sec');
  return {
    bouts_with_round_data: bouts,
    rounds: rows.length,
    sig_strikes_landed: sum('sig_str_landed'),
    sig_strike_accuracy_pct: sigAtt ? Math.round((sum('sig_str_landed') / sigAtt) * 100) : null,
    takedowns_landed: sum('td_landed'),
    takedown_accuracy_pct: tdAtt ? Math.round((sum('td_landed') / tdAtt) * 100) : null,
    control_minutes: Math.round(ctrl / 60),
    knockdowns: sum('kd'),
    submission_attempts: sum('sub_att'),
    target_split: { head: sum('head_landed'), body: sum('body_landed'), leg: sum('leg_landed') },
  };
}

async function ranking(sb, fighterId) {
  const rows = await sb.select('ufc_rankings',
    `select=division,rank,rank_change,is_p4p,is_new,snapshot_date&fighter_id=eq.${fighterId}`
    + `&order=snapshot_date.desc&limit=6`);
  if (!rows.length) return null;
  const latest = rows[0].snapshot_date;
  return rows.filter((r) => r.snapshot_date === latest)
    .map((r) => ({
      division: r.division,
      /* Rank 0 is the champion in this table; there is no is_champion column
       * and inventing one is how a contender becomes a titleholder in print. */
      rank: r.rank === 0 ? 'champion' : r.rank,
      change: r.rank_change,
      newly_ranked: r.is_new,
      p4p: r.is_p4p,
      as_of: r.snapshot_date,
    }));
}

async function nextBout(sb, fighterId, today) {
  const bouts = await sb.select('ufc_bouts',
    `select=id,event_id,fighter_a_id,fighter_b_id,weight_class,is_title,is_womens,scheduled_rounds,card_position,status,`
    + `event:ufc_events(id,name,event_date,venue,city,country)`
    + `&or=(fighter_a_id.eq.${fighterId},fighter_b_id.eq.${fighterId})&status=neq.cancelled&limit=40`);
  const upcoming = bouts
    .filter((b) => b.event?.event_date && b.event.event_date >= today)
    .sort((a, b) => a.event.event_date.localeCompare(b.event.event_date));
  if (!upcoming.length) return null;
  const b = upcoming[0];
  const oppId = b.fighter_a_id === fighterId ? b.fighter_b_id : b.fighter_a_id;
  const opp = oppId ? (await sb.select('ufc_fighters', `select=id,name&id=eq.${oppId}&limit=1`))[0] : null;
  return {
    bout_id: b.id,
    opponent_id: opp?.id || null,
    opponent: opp?.name || null,
    weight_class: b.weight_class,
    is_title: Boolean(b.is_title),
    scheduled_rounds: b.scheduled_rounds,
    card_position: b.card_position,
    status: b.status,
    event: b.event ? {
      id: b.event.id, name: b.event.name, date: b.event.event_date,
      venue: b.event.venue, city: b.event.city, country: b.event.country,
    } : null,
  };
}

/**
 * Verified market prices for one bout, or an explicit unavailable.
 *
 * Coverage is thin and uneven, so the gate is per-BOUT, never per-table. A
 * non-empty ufc_market_observations does not mean this fight is priced, and
 * treating it that way is how a fabricated line reaches a reader.
 */
async function market(sb, boutId) {
  if (!boutId) return { odds_status: 'unavailable', reason: 'no bout linked to this story' };
  const rows = await sb.select('ufc_market_observations',
    `select=bookmaker_name,market_key,outcome_name,price,point,observed_at&bout_id=eq.${boutId}`
    + `&order=observed_at.desc&limit=40`);
  if (!rows.length) return { odds_status: 'unavailable', reason: 'no price observed for this bout' };
  const newest = rows[0].observed_at;
  return {
    odds_status: 'available',
    observed_at: newest,
    books: [...new Set(rows.map((r) => r.bookmaker_name))],
    prices: rows.filter((r) => r.observed_at === newest)
      .map((r) => ({ book: r.bookmaker_name, market: r.market_key, outcome: r.outcome_name, price: r.price, point: r.point })),
  };
}

/* ------------------------------------------------------------ builder */

/**
 * Assemble everything we hold about the subject of one wire item.
 *
 * `item` must already carry a resolved primary_fighter_id; this function does
 * not guess identity, because guessing identity is how a comparison fighter
 * becomes the hero image.
 */
/* Bump when anything about how a packet is BUILT changes. A cached packet from
 * an older builder must never be reused, and a version in the key is the only
 * invalidation that cannot be forgotten. */
export const PACKET_BUILDER_VERSION = 'v2';

/* Twenty minutes. Long enough to collapse a burst of reports about one
 * development, which is the actual pattern; short enough that a bout being
 * rebooked, a rankings update or a fresh price is never more than twenty
 * minutes from reaching an article. A packet is the factual basis of a
 * published piece, so the cache is a cost optimisation that must never become
 * a staleness source. */
const PACKET_TTL_MS = 20 * 60 * 1000;

async function fingerprint(parts) {
  const data = new TextEncoder().encode(parts.join('|'));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The packet, cached on the entities it is a function of.
 *
 * WHAT THE KEY CONTAINS, AND WHY
 *
 * A packet is derived entirely from the primary fighter, the opponent, the
 * bout and the event -- so those, plus the builder version, are the key. The
 * SOURCE is deliberately NOT in the key and not in the cached value: the source
 * excerpt differs per report and is merged in after the cache, so two outlets
 * covering one development share the expensive first-party half while each
 * keeps its own attribution and its own class-B numbers.
 *
 * WHAT IT WILL NOT DO
 *
 * It will not serve anything older than PACKET_TTL_MS, it will not survive a
 * builder change, and any failure -- KV unavailable, malformed JSON, a miss --
 * falls straight through to building the packet properly. A cache that can
 * fail closed into "no article" would be a worse trade than the cost it saves.
 */
export async function buildCachedPacket(sb, env, item, opts = {}) {
  const { sourceExcerpt = null, sourceMeta = null, now = Date.now() } = opts;
  const kv = env?.PACKET_CACHE;
  if (!kv || !item.primary_fighter_id) {
    return { packet: await buildPacket(sb, item, opts), cached: false };
  }
  const key = `packet:${PACKET_BUILDER_VERSION}:${await fingerprint([
    item.primary_fighter_id, item.bout_id || '-', item.event_id || '-', item.story_kind || '-',
  ])}`;
  try {
    const hit = await kv.get(key, 'json');
    if (hit && Number.isFinite(hit.built_at) && now - hit.built_at < PACKET_TTL_MS && hit.packet?.primary) {
      /* The first-party half is reused; this report's own source is layered on
       * top, so attribution and class-B provenance are never shared between
       * two different outlets' stories. */
      const packet = { ...hit.packet };
      packet.source = sourceMeta ? { ...sourceMeta, excerpt: sourceExcerpt } : null;
      packet.built_at = new Date(now).toISOString();
      return { packet, cached: true, age_ms: now - hit.built_at };
    }
  } catch { /* a cache read must never be the reason an article fails */ }

  const packet = await buildPacket(sb, item, opts);
  try {
    const storable = { ...packet, source: null };
    await kv.put(key, JSON.stringify({ built_at: now, packet: storable }), {
      expirationTtl: Math.ceil(PACKET_TTL_MS / 1000) * 2,
    });
  } catch { /* likewise a cache write */ }
  return { packet, cached: false };
}

export async function buildPacket(sb, item, { now = Date.now(), sourceExcerpt = null, sourceMeta = null } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const primaryId = item.primary_fighter_id;
  if (!primaryId) throw new Error('packet requires a resolved primary_fighter_id');

  const primary = await fighterCore(sb, primaryId);
  if (!primary) throw new Error(`primary fighter ${primaryId} not found`);

  const [form, rounds, ranks, next] = await Promise.all([
    recentForm(sb, primaryId, today),
    roundStats(sb, primaryId),
    ranking(sb, primaryId),
    nextBout(sb, primaryId, today),
  ]);

  const boutId = item.bout_id || next?.bout_id || null;
  const [mkt, opponent] = await Promise.all([
    market(sb, boutId),
    next?.opponent_id ? fighterCore(sb, next.opponent_id) : Promise.resolve(null),
  ]);
  const [oppForm, oppRounds, oppRanks] = opponent
    ? await Promise.all([recentForm(sb, opponent.id, today), roundStats(sb, opponent.id), ranking(sb, opponent.id)])
    : [null, null, null];

  const profile = (f, fm, rs, rk) => (!f ? null : {
    fighter_id: f.id,
    name: f.name,
    nickname: f.nickname,
    record: recordOf(f),
    age: ageOn(f.dob, today),
    stance: f.stance,
    height: heightStr(f.height_in),
    height_in: num(f.height_in),
    reach_in: num(f.reach_in),
    weight_lbs: num(f.weight_lbs),
    is_active: f.is_active,
    career: {
      sig_strikes_landed_per_min: num(f.career_slpm),
      sig_strike_accuracy_pct: num(f.career_str_acc),
      sig_strikes_absorbed_per_min: num(f.career_sapm),
      striking_defence_pct: num(f.career_str_def),
      takedowns_per_15min: num(f.career_td_avg),
      takedown_accuracy_pct: num(f.career_td_acc),
      takedown_defence_pct: num(f.career_td_def),
      submission_attempts_per_15min: num(f.career_sub_avg),
    },
    form: fm,
    round_data: rs,
    rankings: rk,
  });

  /* Material differences only. A one-inch reach edge is not an edge, and
   * listing it as one trains the reader to ignore the ones that are. */
  const edges = [];
  if (opponent) {
    const a = primary, b = opponent;
    const reach = num(a.reach_in) - num(b.reach_in);
    if (Number.isFinite(reach) && Math.abs(reach) >= 2) {
      edges.push({ metric: 'reach', favours: reach > 0 ? a.name : b.name, gap_inches: Math.abs(reach) });
    }
    const slpm = num(a.career_slpm) - num(b.career_slpm);
    if (Number.isFinite(slpm) && Math.abs(slpm) >= 1.0) {
      edges.push({ metric: 'striking_volume', favours: slpm > 0 ? a.name : b.name, gap_per_min: Math.abs(Math.round(slpm * 100) / 100) });
    }
    const tdd = num(a.career_td_def) - num(b.career_td_def);
    if (Number.isFinite(tdd) && Math.abs(tdd) >= 10) {
      edges.push({ metric: 'takedown_defence', favours: tdd > 0 ? a.name : b.name, gap_points: Math.abs(Math.round(tdd)) });
    }
    const ageGap = (ageOn(a.dob, today) ?? 0) - (ageOn(b.dob, today) ?? 0);
    if (Math.abs(ageGap) >= 5) {
      edges.push({ metric: 'age', favours: ageGap < 0 ? a.name : b.name, gap_years: Math.abs(ageGap) });
    }
  }

  return {
    version: 1,
    generated_at: new Date(now).toISOString(),
    story: {
      news_item_id: item.id,
      headline_seen: item.title,
      story_kind: item.story_kind || (item.taxonomy?.labels || [])[0] || 'news',
      relevance_score: item.relevance_score ?? null,
    },
    /* Class B evidence. Quoted once, attributed, never asserted as ours. */
    source: sourceMeta ? {
      publisher: sourceMeta.publisher,
      url: sourceMeta.url,
      published_at: sourceMeta.published_at,
      title: sourceMeta.title,
      excerpt: sourceExcerpt,
    } : null,
    primary: profile(primary, form, rounds, ranks),
    opponent: profile(opponent, oppForm, oppRounds, oppRanks),
    bout: next,
    edges,
    market: mkt,
    /* No model output exists for UFC yet. Stated, so the gate can forbid any
     * sentence implying one does. */
    model: { model_status: 'unavailable', reason: 'no graded UFC model output exists yet' },
  };
}
