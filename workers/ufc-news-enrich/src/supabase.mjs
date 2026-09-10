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
 * Duplicate ROWS are therefore the database's job, and it does that job
 * unconditionally. Duplicate WORK is a different question with a different
 * answer: a constraint rejects the second INSERT, which is long after the
 * second writer has built its drafts and paid for any model rewrite. Only the
 * Durable Object in lock.mjs stops that, and only where it is bound. Neither
 * mechanism substitutes for the other.
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


  /**
   * SELECT that returns every row, not the first thousand.
   *
   * PostgREST caps an unbounded select at max-rows, which is 1000 on this
   * project, and `&limit=5000` does NOT raise it - the cap wins. So every
   * caller that asked for a whole table has silently been reading a third of
   * it.
   *
   * That is not hypothetical. loadFighterIndex() selects all of ufc_fighters
   * and all of ufc_fighter_aliases to build the alias resolver. With 3,184
   * fighters it was resolving against 1,000, alphabetically truncated, so
   * Islam Makhachev - the pound-for-pound number one - was simply not in the
   * index. Entity linking in the wire, the UFC-focus filter's "names no known
   * fighter" rule and primary-subject resolution were all running on a
   * fraction of the roster and failing quietly, which is the worst way to
   * fail: every count looked plausible.
   *
   * Range pagination is the documented way past the cap. Pages until a short
   * page arrives, so it costs one extra round trip and never a wrong answer.
   */
  async selectAll(table, query = 'select=*', { pageSize = 1000, maxPages = 50 } = {}) {
    const out = [];
    for (let page = 0; page < maxPages; page += 1) {
      const from = page * pageSize;
      const rows = await this.request('GET', `${table}?${query}`, { range: `${from}-${from + pageSize - 1}` });
      if (!rows?.length) break;
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }

  /**
   * The ordinary select, with one safety net.
   *
   * A query that names its own limit is left alone - the caller said what it
   * wanted. A query with NO limit that comes back exactly at the cap is almost
   * certainly truncated, so it is transparently re-fetched with pagination.
   * Callers do not have to remember the cap exists, which is the only way a
   * rule like this survives contact with a codebase.
   */
  async select(table, query = 'select=*') {
    const rows = await this.request('GET', `${table}?${query}`);
    if (!/[?&]limit=/.test(`?${query}`) && Array.isArray(rows) && rows.length === 1000) {
      return this.selectAll(table, query);
    }
    return rows;
  }

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

  /**
   * PATCH that returns the rows it changed.
   *
   * This is what makes the candidate state machine a lock. A conditional update
   *
   *   ...?id=eq.X&state=in.(new,scored)  ->  {state:'enriching', lease_token}
   *
   * is atomic in Postgres, so of two consumers racing the same item exactly one
   * gets a row back and the other gets an empty array and stops. `return=minimal`
   * throws that answer away, which is why the ordinary patch() above cannot be
   * used for a claim.
   */
  patchReturning(table, filter, body) {
    return this.request('PATCH', `${table}?${filter}`, { body, prefer: 'return=representation' });
  }
}
