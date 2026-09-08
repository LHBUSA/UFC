/* Where an official weight can actually come from, in priority order.
 *
 * SOURCE POLICY
 *
 *   1. official     the promotion's own weigh-in results page (ufc.com).
 *                   This is the promotion publishing its own scale readings.
 *   2. commission   the athletic commission running the event. Authoritative
 *                   for the jurisdiction and frequently the only place a
 *                   catchweight's contracted figure is written down.
 *   3. news         an established verified reporting source already seeded in
 *                   ufc_news_sources. Fast, usually right, occasionally a
 *                   transcription error — which is why corrections exist.
 *
 * NEVER FROM COMMENTARY, AND NEVER FROM A PICTURE OF A SCALE. A number read
 * off a broadcast still frame or inferred from "he looked drained" is not an
 * official weight, and there is no adapter here that could produce one. Every
 * adapter below extracts a figure that its source published as text, and
 * carries the exact substring it came from in raw_text.
 *
 * WHAT IS AND IS NOT IMPLEMENTED HERE
 *
 * The parsers are real and tested. The FETCHERS are deliberately behind an
 * injected `fetchImpl`, and the default in this branch fetches nothing: the
 * migration is unapplied, this is a read-only build, and pointing a live
 * scraper at a publisher from a dry run would be the one part of this feature
 * that touches the outside world. `parseWeighInSources` therefore returns no
 * readings unless a caller supplies a fetcher, and says so.
 */

import { normalize } from '../../../shared/alias_resolver.mjs';

/**
 * The adapters, in the order the collector should trust them.
 *
 * `kind` maps to ufc_weigh_in_results.source_kind. `cadence` is the shortest
 * interval that is polite for that publisher during a live window.
 */
export const SOURCE_ADAPTERS = [
  {
    id: 'ufc-official-weigh-ins',
    kind: 'official',
    name: 'UFC.com',
    /* The promotion posts official weigh-in results as an article on the event
     * page the morning of the scale. It is the fastest authoritative surface
     * and the only one that reliably states a catchweight's agreed figure. */
    url: (event) => `https://www.ufc.com/event/${event.ufc_slug || ''}`,
    parse: parseUfcOfficial,
    cadenceMinutes: 3,
    notes: 'Event page weigh-in results block. Authoritative; publishes ~09:00 local, typically 10-25 min after the scale.',
  },
  {
    id: 'commission-results',
    kind: 'commission',
    name: 'Athletic commission',
    /* Nevada, California and Florida publish official weights as PDFs or HTML
     * tables. Slowest to appear and the most authoritative when it does; it is
     * also where a contracted catchweight limit is written down. */
    url: () => null,
    parse: parseCommissionTable,
    cadenceMinutes: 15,
    notes: 'Jurisdiction-specific. Slow (often post-event) but decisive for contracted limits and corrections.',
  },
  {
    id: 'wire-weigh-in-report',
    kind: 'news',
    name: 'Verified wire',
    /* The existing ufc_news_items pipeline already fetches and dedupes these
     * five publishers every pass. Reusing it means no new fetcher, no new
     * politeness budget, and the same linking policy the newsroom uses. */
    url: () => null,
    parse: parseWireItem,
    cadenceMinutes: 3,
    notes: 'Reads ufc_news_items already ingested by the newsroom. Fastest to appear, most likely to need a correction.',
  },
];

/* ------------------------------------------------------------------ parsers */

/* A weight as publishers write it: "155", "155.5", "155 lbs", "155.5 lb". */
const WEIGHT_RE = /(\d{2,3}(?:\.\d)?)\s*(?:lbs?|pounds)?/i;

/**
 * "Jane Doe (155.5) vs. John Roe (156)" and the table forms UFC.com uses.
 *
 * Returns `{ name, weight }` pairs and nothing else — no verdict, because
 * whether a weight made the limit depends on a contract this parser cannot
 * see.
 */
export function parseUfcOfficial(text) {
  const out = [];
  const src = String(text || '');

  /* Form 1: "Name (155.5) vs. Name (156)" */
  for (const m of src.matchAll(/([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,3})\s*\((\d{2,3}(?:\.\d)?)\)/g)) {
    out.push({ name: m[1].trim(), weight: Number(m[2]), raw: m[0] });
  }

  /* Form 2: a results list, one fighter per line: "Jane Doe: 155.5 lbs" */
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,3})\s*[:\-–]\s*(\d{2,3}(?:\.\d)?)\s*(?:lbs?|pounds)?\s*$/);
    if (m) out.push({ name: m[1].trim(), weight: Number(m[2]), raw: line.trim() });
  }

  return dedupeByName(out);
}

/** Commission tables: "DOE, JANE  155.5". Surname-first, fixed columns. */
export function parseCommissionTable(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Za-z'’.-]+),\s*([A-Z][A-Za-z'’.-]+)\s+(\d{2,3}(?:\.\d)?)\s*$/);
    if (m) out.push({ name: `${m[2]} ${m[1]}`, weight: Number(m[3]), raw: line.trim() });
  }
  return dedupeByName(out);
}

/**
 * A wire item that reports a weigh-in.
 *
 * This is the one that must be most careful. A headline saying a fighter
 * "missed weight" without a figure is a real, storable fact — and a headline
 * that merely mentions a number near a name is not. So a weight is only taken
 * when it sits adjacent to the fighter's name, and a miss with no adjacent
 * number is returned with `weight: null` and `reportedMiss: true`.
 */
export function parseWireItem(text) {
  const src = String(text || '');
  const out = [];
  const missed = /\b(?:miss(?:es|ed)\s+weight|weight\s+miss|fail(?:s|ed)\s+to\s+make\s+weight|came\s+in\s+(?:heavy|over))\b/i.test(src);

  /* At least TWO capitalised words. One is not a fighter name: "The 155 lb
   * division is stacked" parsed as a fighter called "The" weighing 155, and
   * although matchFighter would have rejected it, a parser that emits garbage
   * is one card-roster coincidence away from attaching it to somebody. */
  for (const m of src.matchAll(/([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){1,3})\s*(?:\(|\s)(\d{2,3}(?:\.\d)?)\s*(?:lbs?|pounds)\b/g)) {
    out.push({ name: m[1].trim(), weight: Number(m[2]), raw: m[0], reportedMiss: missed });
  }

  if (!out.length && missed) {
    /* A miss with no number. Worth storing as an availability fact; the
     * measurement stays null rather than being invented. */
    return { unmeasuredMiss: true, raw: src.slice(0, 300) };
  }
  return dedupeByName(out);
}

function dedupeByName(rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = normalize(r.name);
    /* A later mention of the same fighter with a different number is a
     * publisher correcting itself mid-article; take the last. */
    seen.set(k, r);
  }
  return [...seen.values()];
}

/**
 * Match a parsed name to a fighter on this card.
 *
 * Only fighters BOOKED ON THIS EVENT are candidates. That is the whole
 * safeguard: a weigh-in page names twenty-odd people, and matching against the
 * full 3,000-fighter table would eventually attach a weight to a namesake who
 * is not on the card.
 */
export function matchFighter(name, fighters) {
  const n = normalize(name);
  if (!n) return null;
  const exact = fighters.find((f) => normalize(f.name) === n);
  if (exact) return { fighter: exact, how: 'exact name' };

  /* Three characters, not four. The news linker uses four because it matches
   * against three thousand fighters; here the pool is the twenty-odd people
   * booked on this card, so Lee, Doe and Cruz are safe — and the uniqueness
   * check below is what actually prevents a wrong attachment. */
  const surname = n.split(' ').pop();
  if (surname && surname.length >= 3) {
    const bySurname = fighters.filter((f) => normalize(f.name).split(' ').pop() === surname);
    /* One surname on the card is unambiguous; two is not, and a weight
     * attached to the wrong athlete is worse than a missing row. */
    if (bySurname.length === 1) return { fighter: bySurname[0], how: 'unique surname on this card' };
  }
  return null;
}

/**
 * Fetch and parse every configured adapter for one event.
 *
 * `fetchImpl` is required for anything to be fetched at all. Without it this
 * returns zero readings and says so: this branch is read-only and a dry run
 * must not reach out to a publisher.
 */
export async function parseWeighInSources({ event, bouts = [], fighters = [], now = Date.now(), fetchImpl = null } = {}) {
  const readings = [];
  let fetched = 0;
  let failed = 0;

  if (!fetchImpl) {
    return {
      readings, sources_fetched: 0, sources_failed: 0,
      note: 'no fetcher supplied; no source was contacted. Adapters are configured but this build does not reach out to publishers.',
    };
  }

  const boutOf = (fighterId) => bouts.find((b) => b.fighter_a_id === fighterId || b.fighter_b_id === fighterId) || null;

  for (const adapter of SOURCE_ADAPTERS) {
    const url = adapter.url(event);
    if (!url) continue;
    let body;
    try {
      const res = await fetchImpl(url);
      if (!res || !res.ok) throw new Error(`http ${res?.status}`);
      body = await res.text();
      fetched += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[weigh-ins] ${adapter.id} unavailable: ${String(e?.message || e).slice(0, 120)}`);
      continue;
    }

    const parsed = adapter.parse(body);
    const rows = Array.isArray(parsed) ? parsed : [];
    for (const p of rows) {
      const hit = matchFighter(p.name, fighters);
      if (!hit) continue;
      const bout = boutOf(hit.fighter.id);
      readings.push({
        fighter_id: hit.fighter.id,
        fighter_name: hit.fighter.name,
        bout_id: bout?.id ?? null,
        official_weight_lbs: p.weight ?? null,
        reported_miss: Boolean(p.reportedMiss),
        attempt_number: 1,
        source_url: url,
        source_name: adapter.name,
        source_kind: adapter.kind,
        source_published_at: null,
        weighed_at: null,
        raw_text: p.raw ?? null,
        adapter: adapter.id,
        matched: hit.how,
      });
    }
  }

  return { readings, sources_fetched: fetched, sources_failed: failed };
}
