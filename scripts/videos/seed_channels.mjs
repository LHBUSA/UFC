#!/usr/bin/env node
/* Seed ufc_video_channels from scripts/videos/channels.json. Idempotent: upserts
 * on (provider, channel_id).
 *
 * Every channel is re-verified live before it is written, and only a channel
 * that passes every check its entry expects is stored verified=true. The checks:
 *
 *   feed_title               the public Atom feed's <title> equals channels.json feed_title
 *   verified_badge           the channel page carries YouTube's BADGE_STYLE_TYPE_VERIFIED
 *   featured_on_ufc_channel  the channel id sits in the featured-channels grid
 *                            (gridChannelRenderer) of the verified UFC channel page
 *
 * A channel that fails is still upserted, but as verified=false, enabled=false
 * with the failure recorded in `verification`, so the ingest never reads it.
 * `enabled` in channels.json is honoured only for channels that verify.
 *
 *   node scripts/videos/seed_channels.mjs [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supabase, fetchText, feedUrl, parseYoutubeFeed, sleep } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UFC_OFFICIAL_ID = 'UCvgfXK4nTYKudb0rFR6noLA';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchPage(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: ctl.signal });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } finally { clearTimeout(t); }
}

/* Channel ids listed in the featured grid of the official UFC channel page. */
async function loadFeaturedOnUfc() {
  const page = await fetchPage(`https://www.youtube.com/channel/${UFC_OFFICIAL_ID}`);
  if (!page.ok) return { ok: false, status: page.status, ids: new Set(), verified_badge: false };
  const ids = new Set();
  for (const m of page.body.matchAll(/"gridChannelRenderer":\{"channelId":"(UC[A-Za-z0-9_-]{22})"/g)) ids.add(m[1]);
  return { ok: true, status: page.status, ids, verified_badge: /BADGE_STYLE_TYPE_VERIFIED/.test(page.body) };
}

async function verifyChannel(c, featured) {
  const checks = {};
  const checkedAt = new Date().toISOString();
  let feedTitle = null; let feedEntries = null; let feedStatus = null;
  try {
    const r = await fetchText(feedUrl(c.channel_id));
    feedStatus = r.status;
    if (r.ok) {
      const parsed = parseYoutubeFeed(r.body);
      feedTitle = parsed.channel.title;
      feedEntries = parsed.entries.length;
    }
  } catch (e) { feedStatus = `error: ${e.message}`; }
  if (c.verification.expect.includes('feed_title')) checks.feed_title = feedTitle != null && feedTitle === c.feed_title;

  let canonical = null; let badge = null; let pageStatus = null;
  if (c.verification.expect.includes('verified_badge')) {
    try {
      const page = await fetchPage(`https://www.youtube.com/channel/${c.channel_id}`);
      pageStatus = page.status;
      const m = page.body.match(/<link rel="canonical" href="([^"]+)"/);
      canonical = m ? m[1] : null;
      badge = /BADGE_STYLE_TYPE_VERIFIED/.test(page.body);
    } catch (e) { pageStatus = `error: ${e.message}`; badge = false; }
    checks.verified_badge = Boolean(badge) && canonical === `https://www.youtube.com/channel/${c.channel_id}`;
  }
  if (c.verification.expect.includes('featured_on_ufc_channel')) {
    checks.featured_on_ufc_channel = featured.ok && featured.verified_badge && featured.ids.has(c.channel_id);
  }
  const passed = Object.values(checks).every(Boolean);
  return {
    passed,
    verification: {
      method: c.verification.expect,
      checks,
      feed_title: feedTitle,
      expected_feed_title: c.feed_title,
      feed_entries: feedEntries,
      feed_status: feedStatus,
      channel_canonical: canonical,
      page_status: pageStatus,
      featured_on: checks.featured_on_ufc_channel ? UFC_OFFICIAL_ID : null,
      handle: c.handle,
      evidence_note: c.verification[Object.keys(c.verification).find((k) => k.startsWith('evidence_'))] || null,
      checked_at: checkedAt,
    },
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = JSON.parse(readFileSync(resolve(HERE, 'channels.json'), 'utf8'));
  const sb = new Supabase();

  const featured = await loadFeaturedOnUfc();
  console.log(`UFC official page: http ${featured.status}, verified badge ${featured.verified_badge ? 'present' : 'ABSENT'}, ${featured.ids.size} featured channels`);

  const rows = [];
  for (const c of cfg.channels) {
    const v = await verifyChannel(c, featured);
    const enabled = v.passed && Boolean(c.enabled);
    const checkStr = Object.entries(v.verification.checks).map(([k, ok]) => `${k}=${ok ? 'ok' : 'FAIL'}`).join(' ');
    console.log(`${v.passed ? 'ok  ' : 'fail'} ${c.channel_id} ${c.name.padEnd(16)} ${c.channel_class.padEnd(17)} feed="${v.verification.feed_title}" ${checkStr} -> verified=${v.passed} enabled=${enabled}`);
    rows.push({
      provider: c.provider || 'youtube',
      channel_id: c.channel_id,
      name: c.name,
      handle: c.handle || null,
      channel_class: c.channel_class,
      verified: v.passed,
      verification: v.verification,
      enabled,
    });
    await sleep(400);
  }

  console.log(`\n${dryRun ? 'would seed' : 'seeding'} ${rows.length} channels (${rows.filter((r) => r.enabled).length} enabled, ${rows.filter((r) => r.verified).length} verified)`);
  if (dryRun) { console.log(JSON.stringify(rows.map(({ verification, ...r }) => ({ ...r, checks: verification.checks })), null, 2)); return; }

  const written = await sb.upsert('ufc_video_channels', rows, 'provider,channel_id');
  for (const r of written) console.log(`  ${r.channel_id} ${r.name.padEnd(16)} ${r.channel_class.padEnd(17)} verified=${r.verified} enabled=${r.enabled}`);

  /* A channel that was seeded earlier but is no longer in channels.json is switched off, not deleted. */
  const listed = new Set(rows.map((r) => r.channel_id));
  const all = await sb.select('ufc_video_channels', 'select=provider,channel_id,name,enabled,verified');
  for (const r of all) {
    if (listed.has(r.channel_id) || !r.enabled) continue;
    await sb.patch('ufc_video_channels', `provider=eq.${r.provider}&channel_id=eq.${encodeURIComponent(r.channel_id)}`, { enabled: false });
    console.log(`  disabled ${r.channel_id} ${r.name} (no longer in channels.json)`);
  }
  console.log(`\nufc_video_channels: ${all.length} rows, ${all.filter((s) => s.enabled).length} enabled`);
}

main().catch((e) => { console.error(e); process.exit(1); });
