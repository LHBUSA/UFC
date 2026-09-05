/* Supabase (PostgREST) access for ufc-stats-ingest.
 *
 * Same header contract as nfl-picks-engine-shared/supabase.mjs: sb_secret_*
 * keys go on `apikey` only; legacy eyJ service-role JWTs also get Bearer.
 * Never log a key, a row payload, or a URL containing credentials.
 */

function headersFor(env, extra = {}) {
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) throw new Error('supabase_key_missing');
  const h = { apikey: key, accept: 'application/json', ...extra };
  if (key.startsWith('eyJ')) h.authorization = `Bearer ${key}`;
  return h;
}

async function request(env, path, init = {}) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('supabase_url_missing');
  const table = String(path).split('?')[0];
  const method = init.method || 'GET';
  let res;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      res = await fetch(`${base}/rest/v1/${path}`, { ...init, headers: headersFor(env, init.headers || {}), cache: 'no-store' });
    } catch (e) {
      console.error(`[supabase] ${method} ${table} TRANSPORT_FAILED ${String(e?.message || e).slice(0, 120)}`);
      if (attempt === 3) throw new Error(`supabase_transport:${table}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 3) {
      console.error(`[supabase] ${method} ${table} -> HTTP ${res.status}, retry ${attempt + 1}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    break;
  }
  if (!res.ok) {
    let code = '';
    try { const d = await res.clone().json(); code = String(d?.code || d?.message || '').slice(0, 80); } catch (_) { /* */ }
    console.error(`[supabase] ${method} ${table} -> HTTP ${res.status}${code ? ` code=${code}` : ''}`);
    throw new Error(`supabase_${res.status}:${table}`);
  }
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

export function select(env, table, query = '') {
  return request(env, `${table}${query ? `?${query}` : ''}`, { method: 'GET' });
}

/* Paginated select for tables that can exceed PostgREST's 1000-row cap. */
export async function selectAll(env, table, query = '', page = 1000) {
  const out = [];
  for (let start = 0; ; start += page) {
    const rows = await request(env, `${table}${query ? `?${query}` : ''}`, {
      method: 'GET', headers: { 'range-unit': 'items', range: `${start}-${start + page - 1}` },
    }) || [];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

export function insert(env, table, rows, { returning = 'representation' } = {}) {
  return request(env, table, {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: `return=${returning}` },
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
}

/* Upsert on a named conflict target; chunks of 500. */
export async function upsert(env, table, rows, onConflict, { returning = 'minimal' } = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  let out = [];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const r = await request(env, `${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: `resolution=merge-duplicates,return=${returning}` },
      body: JSON.stringify(chunk),
    });
    if (Array.isArray(r)) out = out.concat(r);
  }
  return out;
}

export function patch(env, table, filter, values) {
  return request(env, `${table}?${filter}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify(values),
  });
}
