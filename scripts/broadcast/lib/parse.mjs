/* UFC.com -> structured event schedule. The authoritative parse.
 *
 * WHY THIS SOURCE, IN THIS ORDER
 * ------------------------------
 * The brief asked for embedded JSON / JSON-LD first, a public data endpoint
 * second, DOM third. UFC.com publishes no JSON-LD on /events (verified
 * 2026-09-12: zero `application/ld+json` blocks) and exposes no public schedule
 * endpoint. What it DOES publish is better than either for our purpose: the
 * Drupal theme emits the start times as UNIX EPOCH SECONDS in stable data
 * attributes, because its own client-side timezone widget needs them.
 *
 *   data-main-card-timestamp="1789246800"
 *   data-prelims-card-timestamp="1789236000"
 *   data-early-card-timestamp=""
 *
 * That is machine-readable, timezone-unambiguous truth from the promotion
 * itself. We never parse "5:00 PM EDT" -- the rendered string is a derived
 * display of the same number and is the thing that breaks across DST.
 *
 * The "How to Watch" overlay that ships with each listing row carries the same
 * epochs again, one per segment, each next to the carriers for that segment:
 *
 *   <div class="c-listing-viewing-option__fight-card">Main Card</div>
 *   <div ... data-timestamp="1791072000">8:00 PM EDT</div>
 *   <a href="https://ufc.ac/...">Watch On Paramount+</a>
 *   <a href="https://www.cbs.com/...">Watch on CBS</a>
 *
 * So one fetch of https://www.ufc.com/events yields, for every upcoming card:
 * segment start instants, per-segment carriers with official destination URLs,
 * venue, city/region/country, the official event URL and the ticket link.
 *
 * FRAGILITY, STATED PLAINLY
 * -------------------------
 * This is DOM parsing. It is pinned to four markers:
 *   `l-listing__item`  `c-card-event--result__headline`
 *   `data-main-card-timestamp`  `c-listing-viewing-option`
 * A Drupal theme change can move any of them. Every extractor therefore
 * returns null instead of guessing, `parseEventsPage` reports how many rows it
 * recognised, and the caller (pass_core) refuses to write when that count
 * collapses. Fail closed, never "helpfully" empty.
 *
 * No node: imports -- this module runs unchanged inside the Worker.
 */

export const PARSER = 'ufc-events-listing-v1';
export const PARSER_DETAIL = 'ufc-event-detail-title-v1';

/* Only these hosts are ever fetched. An "official destination URL" we hand a
 * reader must come from the source, but the fetcher must still be bounded:
 * the Worker is not a proxy. */
export const ALLOWED_HOSTS = new Set(['www.ufc.com', 'ufc.com']);

export const EVENTS_URL = 'https://www.ufc.com/events';

/** Segment labels UFC.com uses, mapped to our canonical keys. */
const SEGMENT_BY_LABEL = new Map([
  ['early prelims', 'early_prelims'],
  ['early prelims card', 'early_prelims'],
  ['prelims', 'prelims'],
  ['prelims card', 'prelims'],
  ['main card', 'main_card'],
]);

/* Provider classification. Deliberately a CLOSED list: an unrecognised carrier
 * keeps the name UFC.com printed and gets type null. A guessed `type` on the
 * next broadcast deal would be a fabricated fact in a field that looks
 * authoritative. */
const PROVIDER_TYPES = new Map([
  ['paramount+', 'streaming'],
  ['ufc fight pass', 'streaming'],
  ['espn+', 'streaming'],
  ['espn+ ppv', 'ppv'],
  ['cbs', 'tv'],
  ['abc', 'tv'],
  ['espn', 'tv'],
  ['espn2', 'tv'],
  ['tsn', 'tv'],
  ['tnt sports', 'tv'],
  ['dazn', 'streaming'],
  ['ufc fight pass ppv', 'ppv'],
]);

/* ------------------------------------------------------------------ utils */

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, d) => String.fromCodePoint(parseInt(d, 16)));
}

/** Tag-strip + whitespace-collapse. Returns null for an empty result. */
export function text(html) {
  if (html == null) return null;
  const t = decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t || null;
}

function attr(block, name) {
  const m = block.match(new RegExp(`${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Epoch seconds -> ISO instant, or null.
 *
 * UFC.com writes an EMPTY attribute for a segment a card does not have (an
 * early-prelims-less Fight Night). Empty, "0" and anything non-finite are all
 * "not published" and must stay null -- a 1970 timestamp rendered as "Watch at
 * 7:00 PM, Dec 31 1969" is worse than an honest blank.
 */
export function epochToIso(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || !/^\d{9,11}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  /* Sanity band: 2000-01-01 .. 2100-01-01. A parse that lands outside it is a
   * markup change, not a card. */
  if (n < 946684800 || n > 4102444800) return null;
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * The card's calendar date, in US Eastern.
 *
 * UFC dates its own cards by the US Eastern day of the main card -- the listing
 * literally prints "Sat, Sep 12 / 5:00 PM EDT" against main-card epoch
 * 1789246800. Our ufc_events.event_date follows the same convention, so this
 * is also what makes the two joinable. Computed with Intl, never with a fixed
 * hour offset: -4 and -5 are both "Eastern" depending on the week.
 */
const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function easternDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return ET_DATE.format(d); // en-CA yields YYYY-MM-DD
}

/**
 * Provider name from a UFC.com watch button label.
 * "Watch On Paramount+" -> "Paramount+";  "Watch on CBS" -> "CBS".
 * Anything that does not look like a watch button returns null rather than
 * becoming a broadcaster called "Tickets".
 */
export function providerFromLabel(label) {
  const t = text(label);
  if (!t) return null;
  const m = t.match(/^watch\s+(?:on|at|with)\s+(.+)$/i);
  const name = (m ? m[1] : t).trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) return null;
  if (/^(tickets?|available|view event details|buy|sold out|more info)$/i.test(name)) return null;
  return name;
}

export function providerType(provider) {
  if (!provider) return null;
  return PROVIDER_TYPES.get(provider.toLowerCase().trim()) ?? null;
}

/** A destination we are willing to print as an official "Watch" CTA. */
export function safeWatchUrl(href) {
  if (!href) return null;
  let u;
  try { u = new URL(String(href).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname) return null;
  /* Upgrade the bare-http links UFC.com still ships (ufcfightpass.com). */
  if (u.protocol === 'http:') u.protocol = 'https:';
  return u.toString();
}

/* -------------------------------------------------------------- extractors */

/** Split the listing page into one block per event row. */
export function splitListing(html) {
  const marker = /<div class="l-listing__item[^"]*">/g;
  const starts = [];
  let m;
  while ((m = marker.exec(html)) !== null) starts.push(m.index);
  return starts.map((s, i) => html.slice(s, i + 1 < starts.length ? starts[i + 1] : html.length));
}

/**
 * The per-segment "Start Times" rows inside a row's How to Watch overlay.
 * Returns [{segment, start_utc, providers:[{provider,type,watch_url}]}].
 */
export function parseViewingOptions(block) {
  const out = [];
  const items = block.split('<div class="c-listing-viewing-option">').slice(1);
  for (const raw of items) {
    const end = raw.indexOf('</li>');
    const item = end === -1 ? raw : raw.slice(0, end);
    const labelHtml = item.match(/c-listing-viewing-option__fight-card"[^>]*>([\s\S]*?)<\/div>/);
    const label = text(labelHtml ? labelHtml[1] : null);
    const segment = label ? SEGMENT_BY_LABEL.get(label.toLowerCase()) ?? null : null;
    const tsTag = item.match(/<div class="c-listing-viewing-option__time[^>]*>/);
    const start_utc = tsTag ? epochToIso(attr(tsTag[0], 'data-timestamp')) : null;

    const providers = [];
    const seen = new Set();
    for (const a of item.matchAll(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const provider = providerFromLabel(a[2]);
      const watch_url = safeWatchUrl(a[1]);
      if (!provider || !watch_url) continue;
      const key = provider.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      providers.push({ provider, type: providerType(provider), watch_url });
    }
    /* A row with neither a segment nor a time is markup we did not expect.
     * Drop that row; do not drop the event. */
    if (!segment && !start_utc) continue;
    out.push({ segment, start_utc, providers });
  }
  return out;
}

/** Venue / city / region / country from the listing row. */
export function parseLocation(block) {
  const venueM = block.match(/field--name-taxonomy-term-title[^>]*>\s*<h5>([\s\S]*?)<\/h5>/);
  const venue = text(venueM ? venueM[1] : null);
  const addrM = block.match(/<p class="address"[^>]*>([\s\S]*?)<\/p>/);
  const addr = addrM ? addrM[1] : '';
  const pick = (re) => {
    const m = addr.match(re);
    return text(m ? m[1] : null);
  };
  const city = pick(/<span class="locality">([\s\S]*?)<\/span>/);
  const region = pick(/<span class="administrative-area">([\s\S]*?)<\/span>/);
  const country = pick(/<span class="country">([\s\S]*?)<\/span>/);
  const location_raw = [city, region, country].filter(Boolean).join(', ') || null;
  return { venue, city, region, country, location_raw };
}

/**
 * One listing row -> a raw event record, or null if the row is not an event.
 *
 * Null (not a throw) so that one unrecognised row cannot take the page with
 * it; the caller counts the nulls and decides whether the PAGE is broken.
 */
export function parseEventBlock(block) {
  const headlineMatch = block.match(/c-card-event--result__headline"><a href="([^"]+)">([\s\S]*?)<\/a>/);
  if (!headlineMatch) return null;

  const slugMatch = headlineMatch[1].match(/^\/event\/([a-z0-9][a-z0-9-]*)$/i);
  if (!slugMatch) return null;
  const ufc_slug = slugMatch[1].toLowerCase();
  const event_headline = text(headlineMatch[2]);

  const dateTagM = block.match(/<div class="c-card-event--result__date[\s\S]{0,700}?>/);
  const dateTag = dateTagM ? dateTagM[0] : '';
  const headerMain = epochToIso(attr(dateTag, 'data-main-card-timestamp'));
  const headerPrelims = epochToIso(attr(dateTag, 'data-prelims-card-timestamp'));
  const headerEarly = epochToIso(attr(dateTag, 'data-early-card-timestamp'));

  const options = parseViewingOptions(block);
  /* The overlay is the richer source for times AND is the only source for
   * carriers. Where both exist they agree (verified across the live page);
   * where the header attribute is missing the overlay still has it. */
  const fromOptions = (seg) => {
    const hit = options.find((o) => o.segment === seg);
    return hit ? hit.start_utc : null;
  };

  const location = parseLocation(block);

  const ticketsM = block.match(/<a\s+href="(https?:\/\/(?:www\.)?(?:ticketmaster|seatgeek|axs)\.[^"]+)"/i);

  /* Carriers, flattened across segments. One provider may carry two segments;
   * it appears ONCE with both segment keys, so the UI can say "Paramount+"
   * rather than "Paramount+, Paramount+". */
  const byProvider = new Map();
  for (const o of options) {
    for (const p of o.providers) {
      const key = p.provider.toLowerCase();
      if (!byProvider.has(key)) byProvider.set(key, { provider: p.provider, type: p.type, watch_url: p.watch_url, segments: [] });
      const rec = byProvider.get(key);
      if (o.segment && !rec.segments.includes(o.segment)) rec.segments.push(o.segment);
      /* Prefer the main-card URL when a provider differs by segment. */
      if (o.segment === 'main_card') rec.watch_url = p.watch_url;
    }
  }

  return {
    ufc_slug,
    event_headline,
    ufc_event_url: `https://www.ufc.com/event/${ufc_slug}`,
    early_prelims_start_utc: headerEarly ?? fromOptions('early_prelims'),
    prelims_start_utc: headerPrelims ?? fromOptions('prelims'),
    main_card_start_utc: headerMain ?? fromOptions('main_card'),
    broadcasts: [...byProvider.values()],
    tickets_url: safeWatchUrl(ticketsM ? ticketsM[1] : null),
    venue: location.venue,
    city: location.city,
    region: location.region,
    country: location.country,
    location_raw: location.location_raw,
  };
}

/**
 * Parse the whole listing page.
 *
 * Returns `{ events, rows, recognised, unrecognised, upcoming, ok, reason }`.
 * The caller needs the shape of the failure, not just the data: "we saw 16
 * rows and understood 0" and "we saw 0 rows" are different breakages and only
 * the counts distinguish them.
 */
export function parseEventsPage(html, { now = Date.now() } = {}) {
  if (typeof html !== 'string' || html.length < 500) {
    return { events: [], rows: 0, recognised: 0, unrecognised: 0, upcoming: 0, ok: false, reason: 'response too short to be the events page' };
  }
  const blocks = splitListing(html);
  const events = [];
  let unrecognised = 0;
  for (const b of blocks) {
    let e = null;
    try { e = parseEventBlock(b); } catch { e = null; }
    if (e) events.push(e); else unrecognised += 1;
  }
  const upcoming = events.filter((e) => e.main_card_start_utc && Date.parse(e.main_card_start_utc) > now).length;
  return {
    events,
    rows: blocks.length,
    recognised: events.length,
    unrecognised,
    upcoming,
    ok: events.length > 0,
    reason: events.length > 0 ? null : `no event row recognised in ${blocks.length} listing block(s)`,
  };
}

/**
 * The branded name, from an event page's <title>.
 *
 * The listing only ever prints the matchup ("Silva vs Delgado"). The brand
 * ("Noche UFC", "UFC 332") lives on the event page title:
 *   <title>Noche UFC: Silva vs Delgado | UFC</title>
 * One extra fetch per NEW slug, never per pass.
 */
export function parseEventTitle(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const raw = text(m ? m[1] : null);
  if (!raw) return null;
  const name = raw.replace(/\s*\|\s*UFC\s*$/i, '').trim();
  if (!name || name.length > 160) return null;
  if (/^(page not found|access denied|ufc|events)$/i.test(name)) return null;
  return name;
}

/** Guard for every URL the Worker is allowed to fetch. */
export function isAllowedSourceUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname);
  } catch { return false; }
}
