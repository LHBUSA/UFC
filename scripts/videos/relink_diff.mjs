/* Field-level diff for a relink plan. Pure: no I/O, no clock, no writes.
 *
 * `ingest_youtube.mjs --relink --dry-run` says HOW MANY stored rows a relink
 * would rewrite. It does not say what would change, and "216 updates" can be
 * 216 improvements, 216 lost event links, or both. This module turns one
 * (stored row, proposed row) pair into named buckets and a risk level, so a
 * relink can be read before it is run.
 *
 * A bucket describes a change to what a consumer sees (which card a video sits
 * on, whose profile it appears on, whether it is published). Timestamps the
 * ingest stamps on every pass (linked_at, updated_at, captured_at) are never
 * drift and are ignored everywhere.
 */

export const BUCKETS = Object.freeze({
  A: 'event_gained', B: 'event_lost', C: 'event_changed',
  D: 'bout_gained', E: 'bout_lost', F: 'bout_changed',
  G: 'fighters_gained', H: 'fighters_lost', I: 'fighters_changed',
  J: 'article_changed', K: 'confidence_changed', L: 'link_status_changed',
  M: 'review_reason_changed', N: 'classification_only', O: 'tuf_metadata_only', P: 'harmless_normalization',
});

const IGNORED_LINKING_KEYS = new Set(['linked_at', 'updated_at', 'captured_at', 'checked_at']);

/** Canonical JSON with volatile timestamps removed: jsonb reorders keys, and linked_at moves every pass. */
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => !IGNORED_LINKING_KEYS.has(k)).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const nn = (v) => v ?? null;
const idSet = (v) => [...new Set(Array.isArray(v) ? v : [])].sort();

/** The comparable projection of a ufc_videos row. Stored and proposed rows go through the same function. */
export function project(row) {
  const sm = row?.source_metadata || {};
  return {
    event_id: nn(row?.event_id), bout_id: nn(row?.bout_id), article_id: nn(row?.article_id),
    fighter_ids: idSet(row?.fighter_ids),
    resolver_confidence: nn(row?.resolver_confidence), link_status: nn(row?.link_status), video_type: nn(row?.video_type),
    linking: sm.linking ?? null, review_reason: nn(sm.review_reason), review: sm.review ?? null, tuf: sm.tuf ?? null,
    language: nn(sm.language), classification_evidence: sm.classification?.evidence ?? null,
  };
}

/**
 * One row's diff. `fields` lists every projected field that differs (after
 * timestamp removal); `buckets` names what that means; `risk` is the worst of them.
 */
export function diffRow(stored, proposed) {
  const a = project(stored), b = project(proposed);
  const fields = Object.keys(a).filter((k) => stable(a[k]) !== stable(b[k]));
  const buckets = [];

  if (a.event_id !== b.event_id) buckets.push(!a.event_id ? BUCKETS.A : !b.event_id ? BUCKETS.B : BUCKETS.C);
  if (a.bout_id !== b.bout_id) buckets.push(!a.bout_id ? BUCKETS.D : !b.bout_id ? BUCKETS.E : BUCKETS.F);

  const removed = a.fighter_ids.filter((id) => !b.fighter_ids.includes(id));
  const added = b.fighter_ids.filter((id) => !a.fighter_ids.includes(id));
  if (added.length && removed.length) buckets.push(BUCKETS.I);
  else if (removed.length) buckets.push(BUCKETS.H);
  else if (added.length) buckets.push(BUCKETS.G);

  if (a.article_id !== b.article_id) buckets.push(BUCKETS.J);
  if (a.resolver_confidence !== b.resolver_confidence) buckets.push(BUCKETS.K);
  if (a.link_status !== b.link_status) buckets.push(BUCKETS.L);
  if (a.review_reason !== b.review_reason || stable(a.review) !== stable(b.review)) buckets.push(BUCKETS.M);

  /* The "only" buckets mean exactly that: nothing a consumer keys on moved. */
  const identity = ['event_id', 'bout_id', 'article_id', 'fighter_ids', 'resolver_confidence', 'link_status', 'review_reason', 'review'];
  const identityMoved = fields.some((f) => identity.includes(f));
  if (!identityMoved) {
    if (fields.includes('video_type') || fields.includes('classification_evidence')) buckets.push(BUCKETS.N);
    if (fields.includes('tuf')) buckets.push(BUCKETS.O);
    /* linking evidence or language re-stated while every link, status and type is identical. */
    if (fields.length && fields.every((f) => f === 'linking' || f === 'language')) buckets.push(BUCKETS.P);
  }

  return { fields, buckets, risk: riskOf(a, b, buckets, fields), removed_fighters: removed, added_fighters: added };
}

const HIGH = new Set([BUCKETS.B, BUCKETS.C, BUCKETS.E, BUCKETS.F, BUCKETS.H, BUCKETS.I]);
const MEDIUM = new Set([BUCKETS.A, BUCKETS.D, BUCKETS.G, BUCKETS.J, BUCKETS.K, BUCKETS.M]);

export function riskOf(a, b, buckets, fields = []) {
  if (!buckets.length && !fields.length) return 'none';
  if (buckets.some((x) => HIGH.has(x))) return 'high';
  if (buckets.includes(BUCKETS.L)) {
    /* published -> review hides a video; review -> published publishes one the resolver once doubted. Both high.
     * Anything touching `rejected` is a human decision moving, also high. */
    return 'high';
  }
  if (buckets.some((x) => MEDIUM.has(x))) return 'medium';
  /* A video_type change moves the card between fight-week stages: visible, not identity. */
  if (fields.includes('video_type')) return 'medium';
  return 'low';
}

/** Age bands used by the drift receipt, from the video's own publish date. */
export function ageBand(publishedAt, now) {
  const t = Date.parse(publishedAt || '');
  if (!Number.isFinite(t)) return 'unknown';
  const days = (new Date(now).getTime() - t) / 86400e3;
  return days <= 7 ? '0-7d' : days <= 30 ? '8-30d' : days <= 90 ? '31-90d' : '>90d';
}

export function tally(items, keyOf) {
  const out = {};
  for (const it of items) for (const k of [].concat(keyOf(it))) out[k] = (out[k] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0]))));
}
