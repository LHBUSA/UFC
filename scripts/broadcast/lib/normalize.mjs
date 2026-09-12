/* The normalized broadcast record, its fingerprint, and the diff.
 *
 * THE CONTRACT
 * ------------
 *   verified_at      moves on every SUCCESSFUL authoritative verification,
 *                    whether or not anything changed. It answers "how stale is
 *                    this?".
 *   last_changed_at  moves ONLY when the card's comparable content actually
 *                    moves. It answers "did the card change?".
 *
 * Those two must never collapse into one field. A UI that says "updated 4
 * minutes ago" every time a cron ran is lying about the card; a UI that says
 * "updated 6 days ago" because nothing changed is lying about the check.
 *
 * The fingerprint is taken over COMPARABLE fields only -- the facts about the
 * card. Timestamps, run ids, parser version and the source URL are deliberately
 * excluded: bumping the parser version must not read as "the main card moved".
 */

import { easternDate } from './parse.mjs';
import { sha256 } from '../../weighins/lib/sha256.mjs';

/* Fields that define "the card as UFC.com states it". Order is fixed: the hash
 * is computed from a canonical JSON of exactly these keys, so it is stable
 * across runs, hosts and property insertion order. */
export const COMPARABLE = [
  'event_name',
  'event_headline',
  'event_date',
  'venue',
  'city',
  'region',
  'country',
  'early_prelims_start_utc',
  'prelims_start_utc',
  'main_card_start_utc',
  'broadcasts',
  'ufc_event_url',
];

/* Which kind of change a field represents, for the change ledger. */
const CHANGE_KIND = {
  early_prelims_start_utc: 'time',
  prelims_start_utc: 'time',
  main_card_start_utc: 'time',
  event_date: 'time',
  broadcasts: 'broadcast',
  venue: 'venue',
  city: 'venue',
  region: 'venue',
  country: 'venue',
  event_name: 'identity',
  event_headline: 'identity',
  ufc_event_url: 'identity',
};

const SEGMENT_ORDER = { early_prelims: 0, prelims: 1, main_card: 2 };

/** Stable ordering + shape for one carrier. */
function normalizeBroadcast(b) {
  const provider = typeof b?.provider === 'string' ? b.provider.trim() : null;
  if (!provider) return null;
  const segments = Array.isArray(b.segments)
    ? [...new Set(b.segments.filter((s) => s in SEGMENT_ORDER))].sort((x, y) => SEGMENT_ORDER[x] - SEGMENT_ORDER[y])
    : [];
  return {
    provider,
    /* The US edition of ufc.com/events is the page we pin to: its times are
     * printed in ET and its carriers are the US carriers. `region` records
     * WHICH EDITION stated this, which is a property of the source we actually
     * observed -- not a claim about rights in any other territory. */
    region: 'US',
    type: typeof b.type === 'string' && b.type ? b.type : null,
    watch_url: typeof b.watch_url === 'string' && b.watch_url ? b.watch_url : null,
    segments,
  };
}

/**
 * A parsed listing row -> the record we store and serve.
 *
 * `event_name` falls back to the headline when no branded title has been
 * fetched yet. That is a real UFC.com string either way; it is never
 * synthesised from the slug.
 */
export function normalizeEvent(raw, { brandedName = null, sourceUrl, parser, sourceEdition = 'www.ufc.com (en-US)' } = {}) {
  if (!raw || typeof raw.ufc_slug !== 'string' || !raw.ufc_slug) return null;

  const broadcasts = (Array.isArray(raw.broadcasts) ? raw.broadcasts : [])
    .map(normalizeBroadcast)
    .filter(Boolean)
    .sort((a, b) => {
      /* Earliest segment first, then alphabetical. Deterministic ordering is
       * what keeps the hash from flapping when UFC.com reorders buttons. */
      const sa = a.segments.length ? SEGMENT_ORDER[a.segments[0]] : 99;
      const sb = b.segments.length ? SEGMENT_ORDER[b.segments[0]] : 99;
      return sa - sb || a.provider.localeCompare(b.provider);
    });

  const event_name = brandedName || raw.event_headline || null;
  if (!event_name) return null; // an event with no name from the source is not an event

  return {
    ufc_slug: raw.ufc_slug,
    event_name,
    event_headline: raw.event_headline ?? null,
    event_date: easternDate(raw.main_card_start_utc) ?? easternDate(raw.prelims_start_utc) ?? null,
    venue: raw.venue ?? null,
    city: raw.city ?? null,
    region: raw.region ?? null,
    country: raw.country ?? null,
    location_raw: raw.location_raw ?? null,
    early_prelims_start_utc: raw.early_prelims_start_utc ?? null,
    prelims_start_utc: raw.prelims_start_utc ?? null,
    main_card_start_utc: raw.main_card_start_utc ?? null,
    broadcasts,
    ufc_event_url: raw.ufc_event_url ?? null,
    tickets_url: raw.tickets_url ?? null,
    source: 'UFC.com',
    source_url: sourceUrl ?? null,
    source_edition: sourceEdition,
    parser: parser ?? null,
  };
}

/** Canonical JSON over COMPARABLE, used for both the hash and the diff. */
export function comparableOf(rec) {
  const out = {};
  for (const k of COMPARABLE) out[k] = rec ? rec[k] ?? null : null;
  return out;
}

/**
 * Content fingerprint.
 *
 * Reuses the weigh-in desk's pure-JS SHA-256 rather than node:crypto or
 * WebCrypto, for the same reason that module exists: a digest computed inside
 * the Worker and one computed by `node --test` must be byte-identical, and it
 * must stay synchronous so it can be called inside a loop.
 */
export function fingerprint(rec) {
  return sha256(JSON.stringify(comparableOf(rec)));
}

function asComparableString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/**
 * Field-level diff between the stored row and the freshly normalized record.
 *
 * Returns [{field, kind, before, after}]. Empty means "verified, unchanged" --
 * which is the overwhelmingly common case and the one that must cost a single
 * verified_at write and nothing else.
 */
export function diffEvent(previous, next) {
  const changes = [];
  if (!previous) return changes;
  const a = comparableOf(previous);
  const b = comparableOf(next);
  for (const field of COMPARABLE) {
    const before = asComparableString(a[field]);
    const after = asComparableString(b[field]);
    if (before === after) continue;
    changes.push({ field, kind: CHANGE_KIND[field] ?? 'other', before, after });
  }
  return changes;
}

/**
 * Match a UFC.com row to one of our ufc_events rows.
 *
 * Conservative on purpose. A broadcast row attached to the WRONG event puts
 * the wrong start time on a card page, which is worse than no start time at
 * all -- so anything short of a confident match returns 'unmatched' (or
 * 'ambiguous') and leaves event_id null. The reader then falls back to
 * matching on date, which is visible and correctable, rather than inheriting a
 * bad link that looks authoritative.
 *
 * `candidates` are our events on (or adjacent to) the same date.
 */
export function matchLocalEvent(rec, candidates) {
  if (!rec || !rec.event_date || !Array.isArray(candidates) || candidates.length === 0) {
    return { event_id: null, match_status: 'unmatched', reason: 'no candidate on that date' };
  }
  const sameDate = candidates.filter((c) => c.event_date === rec.event_date);
  if (sameDate.length === 1) {
    return { event_id: sameDate[0].id, match_status: 'matched', reason: 'single event on that date' };
  }
  if (sameDate.length === 0) {
    return { event_id: null, match_status: 'unmatched', reason: 'no candidate on that date' };
  }
  /* Two cards on one date (it happens: a Fight Night and a Contender Series).
   * Break the tie on the matchup names the headline carries, never on
   * position. */
  const tokens = nameTokens(rec.event_headline || rec.event_name);
  const scored = sameDate
    .map((c) => ({ c, score: overlap(tokens, nameTokens(c.name)) }))
    .sort((x, y) => y.score - x.score);
  if (scored[0].score >= 1 && scored[0].score > (scored[1]?.score ?? 0)) {
    return { event_id: scored[0].c.id, match_status: 'matched', reason: `name overlap ${scored[0].score}` };
  }
  return { event_id: null, match_status: 'ambiguous', reason: `${sameDate.length} events on ${rec.event_date}, no decisive name overlap` };
}

const STOP = new Set(['ufc', 'fight', 'night', 'vs', 'vs.', 'the', 'noche', 'on', 'road', 'to', 'series', 'contender', 'dana', 'whites', 'white']);
function nameTokens(name) {
  if (!name) return new Set();
  return new Set(
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}
function overlap(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}
