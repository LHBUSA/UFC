/* Discord webhook. Never throws: alerting must not be able to kill a run. */
export async function discord(env, content, { loud = false } = {}) {
  const url = String(env.DISCORD_WEBHOOK_URL || '').trim();
  if (!url) return false;
  const body = { content: `${loud ? '@here ' : ''}${content}`.slice(0, 1900) };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) console.error(`[discord] HTTP ${r.status}`);
    return r.ok;
  } catch (e) {
    console.error(`[discord] failed ${String(e?.message || e).slice(0, 120)}`);
    return false;
  }
}
