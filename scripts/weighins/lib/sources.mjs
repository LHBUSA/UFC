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
    /* Discovered, never constructed: the UFC.com News "Official Weigh-In
     * Results" article the newsroom captured for this card (discover.mjs).
     * ufc_events has no ufc_slug; the old template built ".../event/" for
     * every card and fetched the wrong page. */
    url: (event, discovered) => (discovered?.official || []).map((o) => o.url),
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
    /* Not fetched at all: the stored source_body of weigh-in stories the
     * newsroom already captured (discover.mjs). */
    url: () => null,
    parse: parseWireItem,
    cadenceMinutes: 3,
    notes: 'Reads ufc_news_items already ingested by the newsroom. Fastest to appear, most likely to need a correction.',
  },
];

/* ------------------------------------------------------------------ parsers */

/* A weight as publishers write it: "155", "155.5", "155 lbs", "155.5 lb". */
const WEIGHT_RE = /(\d{2,3}(?:\.\d)?)\s*(?:lbs?|pounds)?/i;

/* A figure outside this band is an age, a record or a year, not a UFC scale
 * reading (strawweight 115 ... heavyweight 265 plus an honest miss). Same band
 * as the database's weighin_weight_is_plausible check. */
export const PLAUSIBLE_LBS = { min: 100, max: 300 };
const plausible = (w) => Number.isFinite(w) && w >= PLAUSIBLE_LBS.min && w <= PLAUSIBLE_LBS.max;

/** HTML to text lines, for the official page. Block tags become line breaks. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/* "Catchweight (130-lbs) Bout:" / "130-pound catchweight". The only way a
 * catchweight limit enters the pipeline is a source writing the figure. */
const CATCH_LABEL_RE = /catchweight\s*\((\d{2,3}(?:\.\d)?)\s*-?\s*(?:lbs?|pounds?)\)/i;
const CATCH_PROSE_RE = /(\d{2,3}(?:\.\d)?)[\s-]*(?:pound|lb)s?\s+catchweight/i;

/** Sentences that state a catchweight figure, for attaching a sourced limit. */
export function catchweightStatements(text) {
  const out = [];
  for (const sentence of String(text || '').split(/(?<=[.!?])\s+|\n/)) {
    const m = sentence.match(CATCH_LABEL_RE) || sentence.match(CATCH_PROSE_RE);
    if (m && plausible(Number(m[1]))) out.push({ limit: Number(m[1]), sentence: normalize(sentence) });
  }
  return out;
}

/**
 * "Jane Doe (155.5) vs. John Roe (156)" and the table forms UFC.com uses.
 *
 * Returns `{ name, weight }` pairs and nothing else — no verdict, because
 * whether a weight made the limit depends on a contract this parser cannot
 * see.
 */
export function parseUfcOfficial(text) {
  const out = [];
  let src = String(text || '');
  /* The official article body sits between "… Official Weigh-In Results:"
   * and the tag list; the navigation and "Up Next" rails around it name other
   * cards. Restrict to the block when it can be found. */
  const start = src.search(/weigh[\s-]?in results:\s*(\n|$)/i);
  if (start >= 0) {
    const rest = src.slice(start);
    const stop = rest.search(/\n(tags|don'?t miss|up next)\b/i);
    src = stop > 0 ? rest.slice(0, stop) : rest;
  }

  for (const line of src.split(/\r?\n/)) {
    const label = line.match(CATCH_LABEL_RE);
    /* Form 1: "Name (155.5) vs. Name (156)", possibly after "Lightweight Bout:" */
    for (const m of line.matchAll(/([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,3})\s*\((\d{2,3}(?:\.\d)?)\)/g)) {
      const w = Number(m[2]);
      if (!plausible(w)) continue;
      out.push({ name: m[1].trim(), weight: w, raw: line.trim(), limit: label ? Number(label[1]) : null });
    }
    /* Form 2: a results list, one fighter per line: "Jane Doe: 155.5 lbs" */
    const m2 = line.match(/^\s*([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,3})\s*[:\-–]\s*(\d{2,3}(?:\.\d)?)\s*(?:lbs?|pounds)?\s*$/);
    if (m2 && plausible(Number(m2[2]))) out.push({ name: m2[1].trim(), weight: Number(m2[2]), raw: line.trim(), limit: null });
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
    if (!plausible(Number(m[2]))) continue;
    out.push({ name: m[1].trim(), weight: Number(m[2]), raw: m[0], reportedMiss: missed });
  }

  /* The results list publishers reprint: "Jean Silva (145) vs. Jose Miguel
   * Delgado (145.5)". Only the PAIR form counts — a lone "(29)" beside a name
   * is an age as often as a weight — and each figure must be a plausible
   * scale reading. A per-fighter miss is never inferred from a headline that
   * mentions a miss elsewhere, so reportedMiss is false for list rows. */
  const NAME = "([A-Z][\\w'’.-]+(?:\\s+[A-Z][\\w'’.-]+){0,3})";
  const PAIR = new RegExp(`${NAME}\\s*\\((\\d{2,3}(?:\\.\\d)?)\\)\\s*vs\\.?\\s*${NAME}\\s*\\((\\d{2,3}(?:\\.\\d)?)\\)`, 'g');
  for (const m of src.matchAll(PAIR)) {
    const a = Number(m[2]);
    const b = Number(m[4]);
    if (plausible(a)) out.push({ name: m[1].trim(), weight: a, raw: m[0], reportedMiss: false });
    if (plausible(b)) out.push({ name: m[3].trim(), weight: b, raw: m[0], reportedMiss: false });
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
const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
const core = (n) => normalize(n).split(' ').filter((t) => t && !SUFFIX.has(t));

export function matchFighter(name, fighters) {
  const whole = matchCore(core(name), fighters);
  if (whole) return whole;
  /* A results list reprinted as one run of text glues the heading onto the
   * first name: "Main Card Jean Silva (145)". Trailing windows of the capture
   * are tried, EXACT names only — never the looser rules below. */
  const parts = core(name);
  for (let k = parts.length - 1; k >= 2; k -= 1) {
    const tail = parts.slice(parts.length - k).join(' ');
    const exact = fighters.filter((f) => core(f.name).join(' ') === tail);
    if (exact.length === 1) return { fighter: exact[0], how: 'exact name (trailing window)' };
  }
  return null;
}

function matchCore(parts, fighters) {
  const n = parts.join(' ');
  if (!n) return null;
  const exact = fighters.filter((f) => core(f.name).join(' ') === n);
  if (exact.length === 1) return { fighter: exact[0], how: 'exact name' };
  if (exact.length > 1) return null;

  /* Same first and last name, middle names differing: "Jose Delgado" and
   * "Jose Miguel Delgado". Unique on the card or nothing. */
  if (parts.length >= 2) {
    const fl = fighters.filter((f) => { const c = core(f.name); return c.length >= 2 && c[0] === parts[0] && c[c.length - 1] === parts[parts.length - 1]; });
    if (fl.length === 1) return { fighter: fl[0], how: 'first and last name on this card' };
  }

  /* Three characters, not four. The news linker uses four because it matches
   * against three thousand fighters; here the pool is the twenty-odd people
   * booked on this card, so Lee, Doe and Cruz are safe — and the uniqueness
   * check below is what actually prevents a wrong attachment.
   *
   * A different FIRST name blocks the surname rule: "Ryan Garcia" (a boxer
   * weighing in the same morning) must not become "Rafa Garcia" because Garcia
   * is unique on the UFC card. A bare surname, or a first name that is a
   * prefix of the other ("Tom"/"Tommy"), may still resolve. */
  const surname = parts[parts.length - 1];
  if (surname && surname.length >= 3) {
    const bySurname = fighters.filter((f) => core(f.name).pop() === surname);
    if (bySurname.length === 1) {
      const theirs = core(bySurname[0].name);
      const compatible = parts.length === 1 || theirs.length === 1
        || theirs[0] === parts[0]
        || (Math.min(theirs[0].length, parts[0].length) >= 3 && (theirs[0].startsWith(parts[0]) || parts[0].startsWith(theirs[0])));
      if (compatible) return { fighter: bySurname[0], how: 'unique surname on this card' };
    }
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
export async function parseWeighInSources({ event, bouts = [], fighters = [], now = Date.now(), fetchImpl = null, discovered = null } = {}) {
  const readings = [];
  let fetched = 0;
  let failed = 0;
  const trail = [];

  if (!fetchImpl && !discovered) {
    return {
      readings, sources_fetched: 0, sources_failed: 0, trail,
      note: 'no fetcher supplied; no source was contacted. Adapters are configured but this build does not reach out to publishers.',
    };
  }

  const boutOf = (fighterId) => bouts.find((b) => b.fighter_a_id === fighterId || b.fighter_b_id === fighterId) || null;
  /* A page that names fewer than this many booked fighters is not this card's
   * results page, whatever its title says. */
  const minMatches = Math.min(4, Math.max(1, Math.floor(fighters.length / 4)));

  const take = (rows, src, adapter) => {
    let matched = 0;
    const out = [];
    for (const p of rows) {
      const hit = matchFighter(p.name, fighters);
      if (!hit) continue;
      matched += 1;
      const bout = boutOf(hit.fighter.id);
      out.push({
        fighter_id: hit.fighter.id,
        fighter_name: hit.fighter.name,
        bout_id: bout?.id ?? null,
        official_weight_lbs: p.weight ?? null,
        reported_miss: Boolean(p.reportedMiss),
        sourced_limit_lbs: p.limit ?? null,
        catchweight_lbs: p.limit != null && (bout?.weight_class === 'CATCHWEIGHT' || /catchweight/i.test(p.raw || '')) ? p.limit : null,
        attempt_number: 1,
        source_url: src.url,
        source_name: src.name,
        source_kind: adapter.kind,
        source_published_at: src.published_at ?? null,
        weighed_at: null,
        raw_text: p.raw ?? null,
        adapter: adapter.id,
        matched: hit.how,
        news_item_id: src.news_item_id ?? null,
      });
    }
    return { matched, out };
  };

  for (const adapter of SOURCE_ADAPTERS) {
    if (adapter.kind === 'official') {
      for (const url of adapter.url(event, discovered) || []) {
        const src = (discovered?.official || []).find((o) => o.url === url) || { url, name: adapter.name };
        if (!fetchImpl) { trail.push({ adapter: adapter.id, url, status: 'skipped', why: 'no fetcher' }); continue; }
        let body;
        try {
          const res = await fetchImpl(url);
          if (!res || !res.ok) throw new Error(`http ${res?.status}`);
          body = await res.text();
          fetched += 1;
        } catch (e) {
          failed += 1;
          trail.push({ adapter: adapter.id, url, status: 'failed', why: String(e?.message || e).slice(0, 120) });
          continue;
        }
        const rows = adapter.parse(htmlToText(body));
        const { matched, out } = take(Array.isArray(rows) ? rows : [], src, adapter);
        if (matched < minMatches) { trail.push({ adapter: adapter.id, url, status: 'rejected', why: `names only ${matched} booked fighter(s); not this card's results` }); continue; }
        trail.push({ adapter: adapter.id, url, status: 'ok', parsed: rows.length, matched });
        readings.push(...out);
      }
    } else if (adapter.kind === 'news') {
      for (const src of discovered?.wire || []) {
        const parsed = adapter.parse(src.text);
        const rows = Array.isArray(parsed) ? parsed : [];
        /* A catchweight figure stated in prose applies to a bout only when the
         * SAME sentence names both of its fighters ("…between Tim Elliott and
         * Edgar Chairez … changed to a 130-pound catchweight bout"). */
        const statements = catchweightStatements(src.text);
        if (statements.length) {
          const byId = new Map(fighters.map((f) => [f.id, f]));
          const sur = (id) => core(byId.get(id)?.name || '').pop();
          for (const r of rows) {
            const hit = matchFighter(r.name, fighters);
            const bout = hit && boutOf(hit.fighter.id);
            if (!bout) continue;
            const [a, b] = [sur(bout.fighter_a_id), sur(bout.fighter_b_id)];
            const st = a && b && statements.find((x) => ` ${x.sentence} `.includes(` ${a} `) && ` ${x.sentence} `.includes(` ${b} `));
            if (st) r.limit = st.limit;
          }
        }
        const { matched, out } = take(rows, src, adapter);
        if (!matched) { trail.push({ adapter: adapter.id, url: src.url, status: 'no-readings', parsed: rows.length }); continue; }
        trail.push({ adapter: adapter.id, url: src.url, status: 'ok', parsed: rows.length, matched });
        readings.push(...out);
      }
    }
    /* commission: no verified jurisdiction URL is on file for any card yet;
     * it stays configured and inert rather than guessing a PDF location. */
  }

  return { readings, sources_fetched: fetched, sources_failed: failed, trail };
}
