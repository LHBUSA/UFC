#!/usr/bin/env node
/**
 * UFC market ingest — The Odds API, sport key mma_mixed_martial_arts.
 *
 * Market data only. No model output, no edge, no implied value. The product
 * has no prediction model, so a price here is a description of what books are
 * offering and nothing more.
 *
 * Two rules shape the whole file.
 *
 * A price is never attached on a guess. The Odds API gives fighter names, not
 * ids, and attaching Volkanovski's price to the wrong Volkov is a worse
 * outcome than showing no market at all. Resolution is deterministic and
 * ambiguity fails closed into ufc_market_unmatched for a human to read.
 *
 * History is the product. The unique constraint means re-ingesting an
 * unchanged price is a database no-op while a changed price becomes a new
 * observation, so idempotency needs no read-then-write and nothing is ever
 * overwritten.
 *
 *   node scripts/odds/ingest_market.mjs [--dry-run] [--markets h2h] [--json out]
 *                                        [--save-source f] [--source f]
 *
 * One paid call, replayed as often as needed. --save-source writes the raw
 * provider payload beside the run; --source re-processes that payload instead
 * of calling the provider. Matching and resolution are pure functions of the
 * payload, so every rerun during debugging costs nothing and the archived
 * response is also the audit trail for what the provider actually said.
 *
 * Requires ODDS_API_KEY, matching the convention already used by the network's
 * odds worker. Without it the script exits MARKET_DATA_NOT_CONFIGURED and
 * writes nothing; it never invents a fallback price.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = { ...process.env };
for (const f of [path.join(ROOT, '.env'), path.join(ROOT, 'web', '.env.local')]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#')) {
      const k = line.slice(0, i).trim();
      if (!env[k]) env[k] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
  }
}

const SUPA = (env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY || '';
const ODDS_KEY = env.ODDS_API_KEY || '';
const SPORT = 'mma_mixed_martial_arts';
const API = 'https://api.the-odds-api.com/v4';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry-run');
const MARKETS = opt('--markets', 'h2h');
const SAVE_SOURCE = opt('--save-source');
const SOURCE = opt('--source');

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'application/json' };

/**
 * The ON CONFLICT target, which must equal ufc_market_obs_unique exactly.
 *
 * Exported so a test can assert the two never drift apart. If a column is
 * added to the constraint and not to this list, PostgREST silently stops
 * deduplicating on it; if one is named here that the constraint lacks, every
 * insert errors. Neither failure is visible until the second ingest.
 *
 * observed_at is deliberately ABSENT: it records when we looked, so including
 * it would make every run's rows unique and defeat the whole mechanism.
 */
export const OBS_CONFLICT_COLUMNS = [
  'bout_id', 'bookmaker_key', 'market_key', 'outcome_name', 'source_last_update', 'price',
];
export const OBS_CONFLICT = OBS_CONFLICT_COLUMNS.join(',');

/** The identity a row collides on. Two rows with the same key are one fact. */
export const observationKey = (r) => OBS_CONFLICT_COLUMNS.map((c) => String(r[c] ?? '')).join('|');

const log = (...a) => console.log(...a);

/**
 * The observed_at that a replay must reuse.
 *
 * A saved payload is ONE provider fetch. If a replay stamps newly resolvable
 * rows with now(), that single fetch ends up split across two timestamps, the
 * read layer buckets those as two runs, and the difference between them
 * becomes reported line movement - a second market reading that never
 * happened, invented by re-processing the first one.
 *
 * So the timestamp is read back from the rows the original ingest already
 * wrote for these very source events, not taken from the clock and not from
 * the payload's own fetched_at, which differs from the insert time by however
 * long the matching took. Exactly one distinct value is required: zero means
 * nothing from this snapshot has ever landed, and more than one means the
 * chronology is already ambiguous and this script must not guess which
 * reading the new rows belong to.
 */
async function snapshotObservedAt(sourceEventIds) {
  const seen = new Set();
  const ids = [...new Set(sourceEventIds)];
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50).map((x) => `"${x}"`).join(',');
    const rows = await all(`ufc_market_observations?select=observed_at&source_event_id=in.(${slice})`);
    for (const r of rows) seen.add(r.observed_at);
  }
  return [...seen];
}

/** Exact row count, so a run reports what landed rather than what was sent. */
async function countObservations() {
  const r = await fetch(`${SUPA}/rest/v1/ufc_market_observations?select=id`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
  });
  if (!r.ok) return 0;
  const n = Number((r.headers.get('content-range') || '/0').split('/')[1]);
  return Number.isFinite(n) ? n : 0;
}

async function rest(pathq, init = {}) {
  const r = await fetch(`${SUPA}/rest/v1/${pathq}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${pathq.split('?')[0]} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
async function all(q, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${SUPA}/rest/v1/${q}`, { headers: { ...H, Range: `${from}-${from + pageSize - 1}` } });
    if (!r.ok) throw new Error(`${q.split('?')[0]} -> ${r.status}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

/* ---- identity ------------------------------------------------------------
 * Normalisation strips the things that differ between sources without ever
 * changing who a name refers to: case, accents, punctuation, extra spacing.
 * It deliberately does NOT drop or reorder name parts, because that is where
 * two different fighters start colliding. */
export function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* Nicknames arrive quoted inside a name often enough to be worth removing. */
const stripNickname = (s) => String(s || '').replace(/["“”].*?["“”]/g, ' ').replace(/\s+/g, ' ').trim();

function buildIndex(fighters, aliases) {
  const byNorm = new Map();
  const add = (key, id) => {
    if (!key) return;
    let set = byNorm.get(key);
    if (!set) { set = new Set(); byNorm.set(key, set); }
    set.add(id);
  };
  for (const f of fighters) {
    add(normName(f.name), f.id);
    add(normName(stripNickname(f.name)), f.id);
  }
  for (const a of aliases || []) {
    if (a.normalized && a.fighter_id) add(String(a.normalized), a.fighter_id);
    if (a.alias && a.fighter_id) add(normName(a.alias), a.fighter_id);
  }
  return byNorm;
}

/**
 * Resolve one outcome name to a canonical fighter, restricted to the two
 * fighters actually in the bout.
 *
 * Scoping to the bout is what makes this safe: "Silva" is hopeless across the
 * whole roster and unambiguous when only two people can be meant. Anything
 * that still matches both corners, or neither, is a failure rather than a
 * coin flip.
 */
export function resolveOutcome(outcomeName, boutFighters, byNorm) {
  const want = normName(stripNickname(outcomeName));
  if (!want) return { status: 'unresolved', reason: 'empty_outcome_name' };

  const exact = boutFighters.filter((f) => normName(f.name) === want || normName(stripNickname(f.name)) === want);
  if (exact.length === 1) return { status: 'ok', fighterId: exact[0].id, method: 'exact' };
  if (exact.length > 1) return { status: 'ambiguous', reason: 'both_corners_match_exactly' };

  /* Alias table, still scoped to this bout. */
  const ids = byNorm.get(want);
  if (ids) {
    const inBout = boutFighters.filter((f) => ids.has(f.id));
    if (inBout.length === 1) return { status: 'ok', fighterId: inBout[0].id, method: 'alias' };
    if (inBout.length > 1) return { status: 'ambiguous', reason: 'alias_matches_both_corners' };
  }

  /* Surname within the bout. Safe only because the candidate set is two. */
  const surname = want.split(' ').pop();
  const bySurname = boutFighters.filter((f) => normName(f.name).split(' ').pop() === surname);
  if (bySurname.length === 1) return { status: 'ok', fighterId: bySurname[0].id, method: 'surname_in_bout' };
  if (bySurname.length > 1) return { status: 'ambiguous', reason: 'shared_surname_in_bout' };

  return { status: 'unresolved', reason: 'no_match_in_bout' };
}

/**
 * Match a source event to a canonical bout.
 *
 * Both fighters must resolve, and they must be the two corners of the same
 * bout. Date is a filter, never the match: two cards can share a date and a
 * date-only match would attach a price to the wrong fight.
 */
function matchBout(srcEvent, bouts, byNorm) {
  const a = normName(stripNickname(srcEvent.home_team));
  const b = normName(stripNickname(srcEvent.away_team));
  if (!a || !b) return { status: 'unresolved', reason: 'missing_team_names' };

  const commence = srcEvent.commence_time ? new Date(srcEvent.commence_time) : null;
  const near = commence
    ? bouts.filter((x) => {
        if (!x.eventDate) return false;
        const d = Math.abs(new Date(`${x.eventDate}T00:00:00Z`) - commence) / 86400000;
        return d <= 2;                       // a card can start late UTC
      })
    : bouts;

  const hits = near.filter((x) => {
    const names = [normName(x.a.name), normName(x.b.name), normName(stripNickname(x.a.name)), normName(stripNickname(x.b.name))];
    const aHit = names.includes(a) || (byNorm.get(a) && (byNorm.get(a).has(x.a.id) || byNorm.get(a).has(x.b.id)));
    const bHit = names.includes(b) || (byNorm.get(b) && (byNorm.get(b).has(x.a.id) || byNorm.get(b).has(x.b.id)));
    return aHit && bHit;
  });

  if (hits.length === 1) return { status: 'ok', bout: hits[0] };
  if (hits.length > 1) return { status: 'ambiguous', reason: 'multiple_bouts_match_both_fighters' };
  return { status: 'unresolved', reason: 'no_bout_with_both_fighters' };
}

const main = async () => {
  if (!ODDS_KEY && !SOURCE) {
    log('MARKET_DATA_NOT_CONFIGURED: ODDS_API_KEY is not set.');
    log('Nothing was fetched and nothing was written. No fallback prices exist by design.');
    process.exit(3);
  }
  if (!SUPA || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }

  const run = { sport_key: SPORT, markets: MARKETS, source_events: 0, matched_bouts: 0, unmatched_events: 0, observations_written: 0, books_seen: 0 };
  /* Offered is not a column and this task adds no DDL, so it rides in the
   * existing notes jsonb. Offered minus written is the idempotency working. */
  let offered = 0;
  let runId = null;
  /* A replay re-processes a fetch that already has a ledger entry. Opening a
   * second successful run for it would double-count the snapshot in the audit
   * trail and make one provider call look like two. The original entry, and
   * any failure against it, stay exactly as they are. */
  if (!DRY && !SOURCE) {
    const created = await rest('ufc_market_runs', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ sport_key: SPORT, markets: MARKETS }]) });
    runId = created?.[0]?.id ?? null;
  }

  try {
    /* One bulk call covers every listed event. The per-event endpoint would
     * cost a credit per fight and is prohibited for this market. */
    let events;
    let quota;
    let savedFetchedAt = null;
    if (SOURCE) {
      /* Replay. The payload is the whole input to matching, so a rerun is a
       * faithful repeat of the paid call and is billed nothing. */
      const saved = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
      events = Array.isArray(saved) ? saved : saved.events;
      savedFetchedAt = Array.isArray(saved) ? null : saved.fetched_at || null;
      quota = (Array.isArray(saved) ? null : saved.quota) || { used: null, remaining: null, lastCost: 0 };
      log(`replaying ${SOURCE}: ${events.length} source events, no provider call, no quota spent`);
    } else {
      const url = `${API}/sports/${SPORT}/odds?apiKey=${encodeURIComponent(ODDS_KEY)}&regions=us&markets=${encodeURIComponent(MARKETS)}&oddsFormat=american`;
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      quota = {
        used: Number(res.headers.get('x-requests-used')) || null,
        remaining: Number(res.headers.get('x-requests-remaining')) || null,
        /* Measured, never predicted: a bulk call bills regions x markets. */
        lastCost: Number(res.headers.get('x-requests-last')) || null,
      };
      /* The provider echoes the key in some error bodies. Status only. */
      if (!res.ok) throw new Error(`odds api ${res.status}`);
      events = await res.json();
      if (SAVE_SOURCE) {
        fs.writeFileSync(SAVE_SOURCE, JSON.stringify({ fetched_at: new Date().toISOString(), sport_key: SPORT, markets: MARKETS, regions: 'us', quota, events }, null, 2) + '\n');
        log(`source payload -> ${SAVE_SOURCE} (replay with --source, costs nothing)`);
      }
    }
    run.source_events = events.length;
    log(`source events ${events.length} · quota used ${quota.used} remaining ${quota.remaining} cost ${quota.lastCost}`);

    const [fighters, aliases, boutRows, eventRows] = await Promise.all([
      all('ufc_fighters?select=id,name'),
      all('ufc_fighter_aliases?select=fighter_id,alias,normalized').catch(() => []),
      all('ufc_bouts?select=id,event_id,fighter_a_id,fighter_b_id,status'),
      all('ufc_events?select=id,name,event_date'),
    ]);
    const fById = new Map(fighters.map((f) => [f.id, f]));
    const eById = new Map(eventRows.map((e) => [e.id, e]));
    const byNorm = buildIndex(fighters, aliases);

    /* Only bouts that could still be priced. A finished fight has no market. */
    const today = new Date().toISOString().slice(0, 10);
    const candidates = boutRows
      .map((b) => ({ ...b, eventDate: eById.get(b.event_id)?.event_date || null, a: fById.get(b.fighter_a_id), b2: fById.get(b.fighter_b_id) }))
      .filter((b) => b.a && b.b2 && b.eventDate && b.eventDate >= today && b.status !== 'cancelled')
      .map((b) => ({ id: b.id, eventId: b.event_id, eventDate: b.eventDate, a: b.a, b: b.b2 }));

    log(`upcoming canonical bouts available for matching: ${candidates.length}`);

    const rows = [];
    const unmatched = [];
    const matchedSourceIds = [];
    const books = new Set();
    let matched = 0;

    for (const se of events) {
      const m = matchBout(se, candidates, byNorm);
      if (m.status !== 'ok') {
        run.unmatched_events += 1;
        unmatched.push({
          source_event_id: se.id, sport_key: SPORT, commence_time: se.commence_time || null,
          home_team: se.home_team || null, away_team: se.away_team || null,
          reason: m.reason, detail: { status: m.status },
        });
        continue;
      }
      matched += 1;
      matchedSourceIds.push(se.id);
      const bout = m.bout;
      const boutFighters = [bout.a, bout.b];

      for (const bk of se.bookmakers || []) {
        books.add(bk.key);
        for (const mk of bk.markets || []) {
          for (const oc of mk.outcomes || []) {
            const r = resolveOutcome(oc.name, boutFighters, byNorm);
            if (r.status !== 'ok') {
              /* A price we cannot attribute is dropped, loudly. It is never
               * guessed onto a corner. */
              unmatched.push({
                source_event_id: se.id, sport_key: SPORT, commence_time: se.commence_time || null,
                home_team: se.home_team || null, away_team: se.away_team || null,
                reason: `outcome_${r.reason}`,
                detail: { outcome: oc.name, bookmaker: bk.key, bout_id: bout.id, status: r.status },
              });
              continue;
            }
            rows.push({
              event_id: bout.eventId,
              bout_id: bout.id,
              fighter_a_id: bout.a.id,
              fighter_b_id: bout.b.id,
              bookmaker_key: bk.key,
              bookmaker_name: bk.title || null,
              market_key: mk.key,
              outcome_name: oc.name,
              outcome_fighter_id: r.fighterId,
              price: Math.round(Number(oc.price)),
              point: oc.point ?? null,
              source_event_id: se.id,
              commence_time: se.commence_time || null,
              source_last_update: mk.last_update || bk.last_update || null,
            });
          }
        }
      }
    }

    /* Replays inherit the original snapshot's timestamp, or stop. */
    if (SOURCE && rows.length) {
      const stamps = await snapshotObservedAt(events.map((e) => e.id));
      if (stamps.length > 1) {
        throw new Error(
          `refusing to replay: this snapshot already has ${stamps.length} distinct observed_at values ` +
          `(${stamps.sort().join(', ')}). The chronology is ambiguous and guessing which reading these ` +
          `rows belong to would manufacture movement. Resolve by hand.`,
        );
      }
      const observedAt = stamps[0] || new Date(savedFetchedAt || Date.now()).toISOString();
      if (!stamps.length) {
        log(`no prior rows for this snapshot; stamping with the payload's own fetch time ${observedAt}`);
      } else {
        log(`replay inherits the original snapshot timestamp ${observedAt}`);
      }
      for (const r of rows) r.observed_at = observedAt;
    }

    run.matched_bouts = matched;
    run.books_seen = books.size;
    log(`matched bouts ${matched} · unmatched source events ${run.unmatched_events} · books ${books.size} · candidate observations ${rows.length}`);

    if (DRY) {
      log('dry run: nothing written');
      log(JSON.stringify({ sample: rows.slice(0, 3), unmatched: unmatched.slice(0, 3) }, null, 2));
    } else {
      /* Idempotency, and the conflict target is not optional.
       *
       * PostgREST infers ON CONFLICT from the PRIMARY KEY unless a target is
       * named. The primary key here is a bigserial that can never collide, so
       * `resolution=ignore-duplicates` alone compiles to ON CONFLICT (id) DO
       * NOTHING, which does not cover ufc_market_obs_unique at all: the second
       * ingest raises 23505 and the whole batch is lost. That is invisible on
       * an empty table and fatal on every run after the first, so the target
       * is spelled out here and must match the constraint exactly.
       *
       * Caveat worth knowing: source_last_update is nullable and Postgres
       * treats NULLs as distinct, so a book that reports no last_update would
       * re-insert every run rather than dedupe. The provider has always sent
       * one, and a null is left to become visible history rather than being
       * silently coalesced into a false match. */
      let written = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500);
        const before = await countObservations();
        await rest(`ufc_market_observations?on_conflict=${OBS_CONFLICT}`, {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify(slice),
        });
        const after = await countObservations();
        written += Math.max(0, after - before);
      }
      /* What actually landed, not what was offered. On a repeat ingest at
       * unchanged prices this is legitimately zero, and recording the row
       * count instead would make a no-op look like a full write. */
      run.observations_written = written;
      offered = rows.length;
      if (unmatched.length) {
        await rest('ufc_market_unmatched?on_conflict=source_event_id,reason', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(unmatched.map((u) => ({ ...u, last_seen_at: new Date().toISOString() }))),
        });
      }
      /* An event that matched this time is no longer unmatched. Without this
       * the fail-closed landing zone keeps asserting a failure that has since
       * been fixed - by an alias, a corrected name, or a bout appearing - and
       * a stale complaint there is worse than none, because it is read as
       * current. */
      const matchedIds = [...new Set(matchedSourceIds)];
      for (let i = 0; i < matchedIds.length; i += 100) {
        const slice = matchedIds.slice(i, i + 100).map((x) => `"${x}"`).join(',');
        await rest(`ufc_market_unmatched?source_event_id=in.(${slice})&resolved=is.false`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ resolved: true }),
        }).catch(() => {});
      }
      if (runId) {
        await rest(`ufc_market_runs?id=eq.${runId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            finished_at: new Date().toISOString(), status: 'success',
            ...run, quota_used: quota.used, quota_remaining: quota.remaining, last_cost: quota.lastCost,
            notes: { observations_offered: offered, observations_skipped_as_duplicate: Math.max(0, offered - run.observations_written), replayed_from_source: Boolean(SOURCE) },
          }),
        });
      }
    }

    if (opt('--json')) {
      fs.writeFileSync(opt('--json'), JSON.stringify({ generated_at: new Date().toISOString(), quota, run, unmatched }, null, 2) + '\n');
      log(`json -> ${opt('--json')}`);
    }
    log(`\nquota: ${quota.used} used, ${quota.remaining} remaining, this call cost ${quota.lastCost}`);
  } catch (e) {
    if (runId) {
      await rest(`ufc_market_runs?id=eq.${runId}`, {
        method: 'PATCH',
        body: JSON.stringify({ finished_at: new Date().toISOString(), status: 'failed', error: String(e?.message || e).slice(0, 500), ...run }),
      }).catch(() => {});
    }
    console.error('FATAL', e);
    process.exit(1);
  }
};

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ingest_market.mjs')) main();
