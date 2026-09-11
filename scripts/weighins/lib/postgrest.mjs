/* Minimal PostgREST client for the Cloudflare Worker.
 *
 * Same interface as the Supabase class in scripts/news/lib.mjs (select with
 * Range paging, insert, patch) so the pass core runs unchanged under either
 * host. No node: imports — the Worker path must not depend on Node APIs.
 *
 * select() pages with Range headers: PostgREST caps a response at 1000 rows
 * and limit= cannot raise it (the trap that produced three wrong answers in
 * this codebase — see docs/ufc_autopilot_ownership.md).
 */
export class PostgrestClient {
  constructor({ url, key, fetchImpl = fetch }) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.key = key || '';
    this.fetch = fetchImpl;
    if (!this.url || !this.key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  async request(method, path, { body, prefer, range } = {}) {
    const headers = { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    if (range) headers.Range = range;
    const res = await this.fetch(`${this.url}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`PostgREST ${method} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  async select(table, query = 'select=*', pageSize = 1000) {
    const out = [];
    for (let from = 0; ; from += pageSize) {
      const rows = await this.request('GET', `${table}?${query}`, { range: `${from}-${from + pageSize - 1}` });
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }

  async insert(table, rows, { onConflict, ignoreDuplicates = false, returning = true } = {}) {
    const prefer = [returning ? 'return=representation' : 'return=minimal'];
    if (ignoreDuplicates) prefer.push('resolution=ignore-duplicates');
    const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    return this.request('POST', `${table}${q}`, { body: rows, prefer: prefer.join(',') });
  }

  async patch(table, filter, patch) {
    return this.request('PATCH', `${table}?${filter}`, { body: patch, prefer: 'return=representation' });
  }
}
