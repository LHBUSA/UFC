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

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'application/json' };

const log = (...a) => console.log(...a);

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
  if (!ODDS_KEY) {
    log('MARKET_DATA_NOT_CONFIGURED: ODDS_API_KEY is not set.');
    log('Nothing was fetched and nothing was written. No fallback prices exist by design.');
    process.exit(3);
  }
  if (!SUPA || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(2); }

  const run = { sport_key: SPORT, markets: MARKETS, source_events: 0, matched_bouts: 0, unmatched_events: 0, observations_written: 0, books_seen: 0 };
  let runId = null;
  if (!DRY) {
    const created = await rest('ufc_market_runs', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ sport_key: SPORT, markets: MARKETS }]) });
    runId = created?.[0]?.id ?? null;
  }

  try {
    /* One bulk call covers every listed event. The per-event endpoint would
     * cost a credit per fight and is prohibited for this market. */
    const url = `${API}/sports/${SPORT}/odds?apiKey=${encodeURIComponent(ODDS_KEY)}&regions=us&markets=${encodeURIComponent(MARKETS)}&oddsFormat=american`;
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const quota = {
      used: Number(res.headers.get('x-requests-used')) || null,
      remaining: Number(res.headers.get('x-requests-remaining')) || null,
      lastCost: Number(res.headers.get('x-requests-last')) || null,
    };
    if (!res.ok) throw new Error(`odds api ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const events = await res.json();
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

    run.matched_bouts = matched;
    run.books_seen = books.size;
    log(`matched bouts ${matched} · unmatched source events ${run.unmatched_events} · books ${books.size} · candidate observations ${rows.length}`);

    if (DRY) {
      log('dry run: nothing written');
      log(JSON.stringify({ sample: rows.slice(0, 3), unmatched: unmatched.slice(0, 3) }, null, 2));
    } else {
      /* ignore-duplicates is the idempotency: an unchanged price collides with
       * the unique constraint and is skipped, a changed one is inserted. */
      for (let i = 0; i < rows.length; i += 500) {
        await rest('ufc_market_observations', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify(rows.slice(i, i + 500)),
        });
      }
      run.observations_written = rows.length;
      if (unmatched.length) {
        await rest('ufc_market_unmatched', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(unmatched.map((u) => ({ ...u, last_seen_at: new Date().toISOString() }))),
        });
      }
      if (runId) {
        await rest(`ufc_market_runs?id=eq.${runId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            finished_at: new Date().toISOString(), status: 'success',
            ...run, quota_used: quota.used, quota_remaining: quota.remaining, last_cost: quota.lastCost,
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
