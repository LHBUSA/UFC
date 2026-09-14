// Minimal PostgREST client for the PBE Algo scheduler. Service role, server
// only. Every multi-row read is keyset- or id-bounded; nothing relies on an
// offset page that could time out or silently truncate.

export function db(env) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !key) throw new Error('supabase_not_configured');
  const headers = (extra = {}) => ({ apikey: key, authorization: `Bearer ${key}`, accept: 'application/json', ...extra });

  async function req(method, path, { body, prefer } = {}) {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method,
      headers: headers({ ...(body ? { 'content-type': 'application/json' } : {}), ...(prefer ? { prefer } : {}) }),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  return {
    get: (path) => req('GET', path),
    post: (path, body, prefer = 'return=representation') => req('POST', path, { body, prefer }),
    patch: (path, body, prefer = 'return=representation') => req('PATCH', path, { body, prefer }),
    del: (path) => req('DELETE', path, { prefer: 'return=representation' }),
    rpc: (fn, args) => req('POST', `rpc/${fn}`, { body: args }),
    /** GET rows where `column` is in `ids`, chunked so the URL stays short. */
    async inChunks(table, column, ids, select, extra = '', size = 40) {
      const out = [];
      const list = [...new Set(ids.filter(Boolean))];
      for (let i = 0; i < list.length; i += size) {
        const chunk = list.slice(i, i + size).map((x) => `"${x}"`).join(',');
        out.push(...(await req('GET', `${table}?select=${select}&${column}=in.(${chunk})${extra}`)));
      }
      return out;
    },
  };
}
