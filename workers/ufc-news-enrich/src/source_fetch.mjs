/* Fetch the source page and pull out the article body.
 *
 * Ported from propbet-news-enrich, where this exact extractor has been reading
 * ESPN, CBS, PFT and a dozen others in production since May. The order matters:
 * <article>, then <main>, then the longest run of <p> tags. Sites that wrap
 * their body in neither are the reason the third branch exists.
 *
 * WHY THE BODY IS WORTH FETCHING AT ALL. The whole external path was dead
 * because the packet was built from an RSS headline, and no gate will let a
 * model write 500 words from twelve. This is the stage that makes the existing
 * gate passable without weakening it: real reported detail enters as class-B
 * evidence, usable with attribution, and everything else in the article still
 * comes from our own tables.
 */
const TIMEOUT_MS = 9000;
const MAX_CHARS = 6000;
const UA = 'Mozilla/5.0 (compatible; PropBetEdgeUFCBot/1.0; +https://ufc.propbetedge.ai)';

const strip = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<figure[\s\S]*?<\/figure>/gi, ' ')
  .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;/g, "'")
  .replace(/&[a-z]+;/gi, ' ')
  .replace(/\s+/g, ' ').trim();

const meta = (html, prop) => {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*property=["']${prop}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'),
  ];
  for (const p of patterns) { const m = html.match(p); if (m) return m[1]; }
  return null;
};

export function extract(html) {
  const out = { title: meta(html, 'og:title'), image: meta(html, 'og:image'),
    description: meta(html, 'og:description'), published: meta(html, 'article:published_time'), text: '' };

  let body = html.match(/<article[^>]*>([\s\S]{200,60000}?)<\/article>/i);
  if (!body) body = html.match(/<main[^>]*>([\s\S]{200,60000}?)<\/main>/i);
  if (body) {
    out.text = strip(body[1]).slice(0, MAX_CHARS);
  } else {
    const paras = [];
    for (const m of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      const t = strip(m[1]);
      /* 60 chars filters nav links, captions and cookie notices without
       * filtering short but real opening sentences. */
      if (t.length > 60) paras.push(t);
      if (paras.length >= 25) break;
    }
    out.text = paras.join('\n\n').slice(0, MAX_CHARS);
  }
  return out;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Normalised for hashing, so trivial markup churn is not a new story. */
const normalise = (t) => String(t || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);

/**
 * Never throws. A source we cannot read is a fact about that source, and the
 * caller decides whether the remaining evidence still supports an article.
 */
export async function fetchSource(url, { fetchImpl = fetch } = {}) {
  if (!url) return { ok: false, status: null, status_class: 'not_attempted', error: 'no url', text: '', hash: null };
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, status_class: res.status === 403 || res.status === 401 ? 'blocked' : 'failed',
        error: `http ${res.status}`, text: '', hash: null };
    }
    const html = await res.text();
    const data = extract(html);
    if (!data.text || data.text.length < 200) {
      /* A 200 with no extractable body is a paywall, a consent wall or a
       * client-rendered page. Calling it a success would put an empty excerpt
       * into the packet and let the gate believe evidence exists. */
      return { ok: false, status: res.status, status_class: 'thin', error: `extracted ${data.text.length} chars`,
        text: '', hash: null, title: data.title, image: data.image };
    }
    return { ok: true, status: res.status, status_class: 'ok', text: data.text,
      hash: await sha256Hex(normalise(data.text)),
      title: data.title, image: data.image, description: data.description, published: data.published };
  } catch (e) {
    const timeout = e?.name === 'TimeoutError';
    return { ok: false, status: null, status_class: timeout ? 'failed' : 'failed',
      error: timeout ? `timeout after ${TIMEOUT_MS}ms` : String(e?.message || e).slice(0, 200), text: '', hash: null };
  }
}
