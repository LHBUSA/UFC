/* Candidate feeds, verification, and reconciliation of ufc_news_sources.
 *
 * WHY VERIFICATION HAPPENS FROM A WORKER
 *
 * scripts/news/seed_sources.mjs verifies from Node, on a laptop, and its own
 * header says Bloody Elbow "returns 403 to Node's fetch" - which is why that
 * source was dropped at seed time. Bloody Elbow is enabled in production today
 * and is one of the two feeds actually producing items. The difference is where
 * the request came from: publishers block datacentre and CLI user-agents at
 * different rates than they block Cloudflare's edge.
 *
 * So a feed's verdict from a laptop is not its verdict in production, and the
 * only verification that means anything is one performed by the thing that will
 * do the fetching. That is this module, running in the Worker.
 *
 * WHAT "PASSES" MEANS - and it is deliberately more than HTTP 200
 *
 *   1. reachable            2xx within the timeout
 *   2. parses               >= 3 items, so an HTML error page cannot pass
 *   3. has real links       every sampled item carries an absolute http(s) URL,
 *                           because an item with no link can never be fetched
 *                           for its body and is therefore useless to us
 *   4. has timestamps       a majority of items parse to a real date; without
 *                           one, freshness and the SLA clock are guesswork
 *   5. UFC focus            a majority of a sample survives the focus filter,
 *                           which is what keeps a boxing feed off the list
 *   6. stable identity      links are distinct; a feed whose items all share a
 *                           URL breaks fingerprinting
 *
 * A candidate failing any of these is reported with the reason and NOT enabled.
 * The standard does not move to make the count look better.
 */
import { parseFeed, parseDate } from '../../../scripts/news/lib.mjs';
import { classifyFocus } from './ufc_focus.mjs';

const USER_AGENT = 'Mozilla/5.0 (compatible; PropBetEdgeUFCBot/1.0; +https://ufc.propbetedge.ai)';
const PROBE_TIMEOUT_MS = 10000;

export const MIN_ITEMS = 3;
export const MIN_DATED_RATIO = 0.5;
export const MIN_UFC_RATIO = 0.4;

/* The five already in production, plus the candidates. Each entry may list
 * several URLs; the first that passes wins, because feeds move (MMA Fighting
 * and MMA Junkie have each moved once already). */
export const CANDIDATES = [
  /* incumbent */
  { name: 'MMA Fighting', urls: ['https://www.mmafighting.com/rss/index.xml', 'https://www.mmafighting.com/rss/current'], weight: 1 },
  { name: 'ESPN MMA', urls: ['https://www.espn.com/espn/rss/mma/news'], weight: 1 },
  { name: 'UFC.com News', urls: ['https://www.ufc.com/rss/news'], weight: 1.2 },
  { name: 'Bloody Elbow', urls: ['https://www.bloodyelbow.com/feed', 'https://bloodyelbow.com/feed/'], weight: 0.9 },

  /* candidates */
  { name: 'MMA Junkie', urls: ['https://mmajunkie.usatoday.com/feed', 'https://mmajunkie.usatoday.com/feed/', 'https://mmajunkie.usatoday.com/category/ufc/feed'], weight: 1 },
  { name: 'MMA Mania', urls: ['https://www.mmamania.com/rss/current', 'https://www.mmamania.com/rss/index.xml'], weight: 0.8 },
  { name: 'Sherdog', urls: ['https://www.sherdog.com/rss/news.xml', 'https://www.sherdog.com/rss/news'], weight: 0.9 },
  { name: 'Cageside Press', urls: ['https://cagesidepress.com/feed/'], weight: 0.7 },
  { name: 'The Mac Life', urls: ['https://themaclife.com/feed/'], weight: 0.6 },
  { name: 'MMA News', urls: ['https://www.mmanews.com/feed/'], weight: 0.7 },
  { name: 'BJPenn.com', urls: ['https://www.bjpenn.com/feed/'], weight: 0.6 },
  { name: 'Combat Press', urls: ['https://combatpress.com/feed/'], weight: 0.6 },
  { name: 'MMA Weekly', urls: ['https://www.mmaweekly.com/feed'], weight: 0.6 },
  { name: 'LowKick MMA', urls: ['https://www.lowkickmma.com/feed/'], weight: 0.5 },
  { name: 'MiddleEasy', urls: ['https://middleeasy.com/feed/'], weight: 0.5 },
];

/** Fetch and grade one URL. Never throws. */
export async function probeUrl(url, { now = Date.now() } = {}) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cf: { cacheTtl: 0 },
    });
  } catch (e) {
    return { url, ok: false, reason: e?.name === 'TimeoutError' ? `timeout after ${PROBE_TIMEOUT_MS}ms` : `fetch error: ${String(e?.message || e).slice(0, 140)}`, latency_ms: Date.now() - started };
  }
  const latency_ms = Date.now() - started;
  if (!res.ok) return { url, ok: false, reason: `http ${res.status}`, latency_ms, status: res.status };

  let items = [];
  try { items = parseFeed(await res.text()); }
  catch (e) { return { url, ok: false, reason: `parse error: ${String(e?.message || e).slice(0, 120)}`, latency_ms }; }

  if (items.length < MIN_ITEMS) {
    return { url, ok: false, reason: `only ${items.length} item(s) parsed, need ${MIN_ITEMS}`, latency_ms, items: items.length };
  }

  const sample = items.slice(0, 25);
  const linked = sample.filter((i) => /^https?:\/\//i.test(String(i.link || '')));
  const distinctLinks = new Set(linked.map((i) => i.link)).size;
  const dated = sample.map((i) => parseDate(i.published)).filter(Boolean);
  const focus = sample.map((i) => classifyFocus(i.title, i.summary));
  const ufc = focus.filter((f) => f.ok).length;
  const foreign = {};
  for (const f of focus) for (const p of f.foreign) foreign[p] = (foreign[p] || 0) + 1;

  const newestMs = dated.length ? Math.max(...dated.map((d) => d.getTime())) : null;
  const grade = {
    url, latency_ms, status: res.status,
    items: items.length,
    sampled: sample.length,
    with_absolute_link: linked.length,
    distinct_links: distinctLinks,
    with_date: dated.length,
    ufc_focused: ufc,
    ufc_ratio: Number((ufc / sample.length).toFixed(2)),
    foreign_promotions: foreign,
    newest_item_age_hours: newestMs === null ? null : Number(((now - newestMs) / 3600e3).toFixed(1)),
    has_etag: Boolean(res.headers.get('etag')),
    has_last_modified: Boolean(res.headers.get('last-modified')),
    conditional_support: Boolean(res.headers.get('etag') || res.headers.get('last-modified')),
  };

  const failures = [];
  if (linked.length !== sample.length) failures.push(`${sample.length - linked.length}/${sample.length} items have no absolute link`);
  if (distinctLinks !== linked.length) failures.push(`links are not distinct (${distinctLinks}/${linked.length})`);
  if (dated.length / sample.length < MIN_DATED_RATIO) failures.push(`only ${dated.length}/${sample.length} items carry a parseable date`);
  if (grade.ufc_ratio < MIN_UFC_RATIO) failures.push(`only ${Math.round(grade.ufc_ratio * 100)}% of sampled items are UFC-focused (need ${Math.round(MIN_UFC_RATIO * 100)}%)`);

  return { ...grade, ok: failures.length === 0, reason: failures.length ? failures.join('; ') : null, failures };
}

/** Probe every URL for one candidate; first pass wins. */
export async function probeCandidate(candidate, { now = Date.now() } = {}) {
  const attempts = [];
  for (const url of candidate.urls) {
    const r = await probeUrl(url, { now });
    attempts.push(r);
    if (r.ok) return { name: candidate.name, weight: candidate.weight, ok: true, chosen: r, attempts };
  }
  return { name: candidate.name, weight: candidate.weight, ok: false, chosen: null, attempts };
}

/**
 * Probe every candidate and, unless `dry`, reconcile ufc_news_sources.
 *
 * A source that passes is upserted enabled. A source already in the table that
 * now fails is DISABLED, never deleted: deleting it would orphan the
 * ufc_news_items rows that reference it, and the historical record of where a
 * story came from is worth more than a tidy table.
 */
export async function verifySources(env, sb, { now = Date.now(), dry = true, only = null } = {}) {
  const list = only ? CANDIDATES.filter((c) => c.name.toLowerCase() === String(only).toLowerCase()) : CANDIDATES;
  if (!list.length) return { status: 'no_candidate_matched', only };

  const graded = [];
  for (const c of list) graded.push(await probeCandidate(c, { now }));

  const existing = await sb.select('ufc_news_sources', 'select=id,kind,name,url,enabled,weight&kind=eq.rss');
  const byName = new Map(existing.map((s) => [s.name, s]));

  const plan = { enable: [], update_url: [], disable: [], unchanged: [], rejected: [] };
  for (const g of graded) {
    const current = byName.get(g.name);
    if (!g.ok) {
      plan.rejected.push({ name: g.name, attempts: g.attempts.map((a) => ({ url: a.url, reason: a.reason })) });
      if (current && current.enabled) plan.disable.push({ name: g.name, id: current.id, why: g.attempts[0]?.reason || 'verification failed' });
      continue;
    }
    if (!current) plan.enable.push({ name: g.name, url: g.chosen.url, weight: g.weight, grade: g.chosen });
    else if (current.url !== g.chosen.url) plan.update_url.push({ name: g.name, id: current.id, from: current.url, to: g.chosen.url, grade: g.chosen });
    else if (!current.enabled) plan.enable.push({ name: g.name, url: g.chosen.url, weight: g.weight, grade: g.chosen, reenable: true });
    else plan.unchanged.push({ name: g.name, url: current.url, grade: g.chosen });
  }

  if (dry) return { status: 'dry_run', probed: graded.length, plan, graded };

  const applied = { enabled: 0, url_updated: 0, disabled: 0 };
  for (const e of plan.enable) {
    const current = byName.get(e.name);
    if (current) { await sb.patch('ufc_news_sources', `id=eq.${current.id}`, { url: e.url, enabled: true, weight: e.weight }); }
    else { await sb.insert('ufc_news_sources', { kind: 'rss', name: e.name, url: e.url, weight: e.weight, enabled: true }); }
    applied.enabled += 1;
  }
  for (const u of plan.update_url) { await sb.patch('ufc_news_sources', `id=eq.${u.id}`, { url: u.to }); applied.url_updated += 1; }
  for (const d of plan.disable) { await sb.patch('ufc_news_sources', `id=eq.${d.id}`, { enabled: false }); applied.disabled += 1; }

  return { status: 'applied', probed: graded.length, applied, plan };
}
