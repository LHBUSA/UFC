/* PostgREST access for the newsroom worker.
 *
 * One rule is worth more than the rest of this file: an upsert MUST name its
 * conflict target. PostgREST infers ON CONFLICT from the PRIMARY KEY unless
 * `?on_conflict=` says otherwise, and every table here has a surrogate uuid
 * primary key that can never collide. So `resolution=ignore-duplicates` alone
 * compiles to ON CONFLICT (id) DO NOTHING and deduplicates nothing at all -
 * the insert simply raises 23505 against the real unique index the moment a
 * duplicate arrives. This exact bug cost a full ingest on the odds side: it is
 * invisible on an empty table and fatal on every run after the first.
 *
 * The constraints that actually make the newsroom idempotent already exist in
 * migration 20260906000001:
 *
 *   ufc_news_items.url          unique
 *   ufc_news_items.fingerprint  unique
 *   ufc_articles.slug           unique
 *
 * Duplicate suppression is therefore the database's job, not a lock's. The
 * advisory lock in runlog.mjs stops wasted work; these constraints are what
 * make a duplicate publication impossible.
 */

export const CONFLICT_TARGETS = {
  ufc_news_items: 'fingerprint',
  ufc_articles: 'slug',
};

export class Supabase {
  constructor(env) {
    this.url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
    this.key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
    /* Fail closed and say which half is missing: a newsroom that silently
     * writes nothing looks exactly like a newsroom with no news. */
    if (!this.url) throw new Error('SUPABASE_URL is not configured');
    if (!this.key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }

  headers(extra = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async request(method, path, { body, prefer, range } = {}) {
    const headers = this.headers();
    if (prefer) headers.Prefer = prefer;
    if (range) headers.Range = range;
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`PostgREST ${method} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  select(table, query = 'select=*') { return this.request('GET', `${table}?${query}`); }

  async count(table, filter = '') {
    const res = await fetch(`${this.url}/rest/v1/${table}?select=id${filter ? `&${filter}` : ''}`, {
      headers: this.headers({ Prefer: 'count=exact', Range: '0-0' }),
    });
    if (!res.ok) return null;
    const n = Number((res.headers.get('content-range') || '/0').split('/')[1]);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Insert rows, ignoring ones that already exist.
   *
   * `table` must appear in CONFLICT_TARGETS: an upsert with no named target is
   * refused rather than silently degraded, because the degraded form looks
   * identical until it fails in production.
   */
  async insertIgnoringDuplicates(table, rows) {
    if (!rows?.length) return 0;
    const target = CONFLICT_TARGETS[table];
    if (!target) throw new Error(`refusing to upsert ${table} without a declared conflict target`);
    const before = await this.count(table);
    await this.request('POST', `${table}?on_conflict=${target}`, {
      body: rows,
      prefer: 'resolution=ignore-duplicates,return=minimal',
    });
    const after = await this.count(table);
    /* What landed, not what was offered. On a repeat ingest this is zero, and
     * reporting the offered count instead would make a no-op look like news. */
    return before === null || after === null ? 0 : Math.max(0, after - before);
  }

  insert(table, row) {
    return this.request('POST', table, { body: Array.isArray(row) ? row : [row], prefer: 'return=representation' });
  }

  patch(table, filter, body) {
    return this.request('PATCH', `${table}?${filter}`, { body, prefer: 'return=minimal' });
  }
}
