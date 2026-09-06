#!/usr/bin/env node
/* PropBetEdge UFC — world-class editorial desk pass.
 *
 * The deterministic writer remains the source of truth. This second pass may
 * improve headline/dek/structure/prose ONLY from the stored fact block + draft.
 * It fails closed if the model introduces a number/link that the source packet
 * did not contain, claims unavailable odds/model output, or produces thin copy.
 *
 * Usage:
 *   node scripts/news/polish_world_class.mjs [--limit 20] [--recent-hours 720] [--force] [--dry-run]
 */
import { Supabase, loadEnv, wordCount } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const LIMIT = Math.min(60, Math.max(1, Number(opt('--limit', '30')) || 30));
const HOURS = Math.min(24 * 60, Math.max(1, Number(opt('--recent-hours', '720')) || 720));
const FORCE = flag('--force');
const DRY = flag('--dry-run');
const MODEL = process.env.UFC_EDITORIAL_MODEL || 'claude-sonnet-5';
const VERSION = `${MODEL}/editorial-desk-v1`;

const SYSTEM = `You are the senior editor of PropBetEdge UFC, a premium bettor-facing combat-sports intelligence newsroom. You receive one complete SOURCE PACKET containing a deterministic draft and its machine-readable fact block. Your job is to turn it into publication-grade sports journalism without adding a single unsupported fact.

Editorial standard:
- Write like a top-tier sports/data magazine, not a database template. Open with the actual tension of the fight/result, not housekeeping.
- Translate evidence into fight meaning: range, pace, durability, finishing profile, control, recent form, stance/context and the specific market categories already supported by the packet.
- Put Bettor's Edge into the journalism: what the evidence changes, what it does NOT prove, the counter-case, and what new information would change the read.
- Use short, varied paragraphs. Avoid repeated boilerplate such as “the question this preview works through is simple,” “the tape's headline number,” “this is a profile update,” and generic “markets to reassess” filler.
- When data is missing, mention the limitation once in the most relevant section and keep moving. Do not build entire sections out of missing-data disclaimers.
- Never pad a thin source packet. A concise, sharp article beats invented depth.

Hard fact rules:
1. Use ONLY facts, names, dates, numbers, methods, records, locations, quotes, market categories and relationships contained in the SOURCE PACKET. No outside knowledge.
2. Never invent injuries, camp news, opponent-quality narratives, rankings, odds, prices, sportsbook availability, probabilities, model output, picks or predictions.
3. If odds_status/model_status is unavailable, say so only where useful; never imply a price or model edge exists.
4. Preserve the meaning of every record/sample/confidence caveat. Do not turn small samples into certainty.
5. Preserve every existing Markdown link somewhere in body_md. Do not create new URLs.
6. A headline must be evidence-led and truthful. Do not claim an “edge” unless the packet explicitly supports that wording.
7. Output valid JSON only, exactly: {"headline":"...","dek":"...","body_md":"..."}. No code fence or commentary.

Preferred article architecture when the source supports it:
Fight preview: Fight thesis → Matchup evidence → Recent form → Bettor's Edge → Market watch → Counter-case / what changes the read → Final read.
Results: What happened → What the fight changed → Data / round evidence → Bettor's post-mortem → What carries into the next market.
Card change: What changed → Why the matchup changed → Markets affected → What still needs confirmation.
External/source brief: lead with the attributed news, then explain only what PropBetEdge's own tables add.`;

function numTokens(text) {
  return new Set((String(text || '').match(/(?<![A-Za-z])[-+]?\d+(?:\.\d+)?%?(?![A-Za-z])/g) || []).map((v) => v.replace(/^\+/, '')));
}
function links(text) {
  return new Set((String(text || '').match(/\[[^\]]+\]\((https?:\/\/[^)]+|\/[^)]+)\)/g) || []));
}
function urls(text) {
  return new Set((String(text || '').match(/https?:\/\/[^\s)\]}>'"]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, '')));
}
function storyMinimum(article) {
  const cls = String(article.fact_block?.story_class || '');
  const short = Boolean(article.fact_block?.depth?.short);
  if (short) return Math.max(180, Math.floor(wordCount(article.body_md) * 0.8));
  if (article.story_type === 'results') return 800;
  if (article.story_type === 'fight_preview') {
    if (/main_event/.test(cls)) return 900;
    if (/main_card/.test(cls)) return 700;
    return 550;
  }
  if (article.story_type === 'card_change') return 450;
  if (article.story_type === 'external') return 180;
  return Math.max(250, Math.floor(wordCount(article.body_md) * 0.8));
}
function validate(source, out, article) {
  if (!out || typeof out !== 'object') return 'response is not an object';
  const headline = String(out.headline || '').trim();
  const dek = String(out.dek || '').trim();
  const body = String(out.body_md || '').trim();
  if (headline.length < 24 || headline.length > 150) return `headline length ${headline.length}`;
  if (dek.length < 35 || dek.length > 420) return `dek length ${dek.length}`;
  if (!body) return 'empty body';

  const allowedNumbers = numTokens(source);
  for (const n of numTokens(`${headline}\n${dek}\n${body}`)) {
    if (!allowedNumbers.has(n.replace(/^\+/, ''))) return `new number ${n}`;
  }

  const sourceUrls = urls(source);
  for (const u of urls(body)) if (!sourceUrls.has(u)) return `new URL ${u}`;
  const requiredLinks = links(article.body_md);
  const outputLinks = links(body);
  for (const l of requiredLinks) if (!outputLinks.has(l)) return `existing link removed: ${l.slice(0, 100)}`;

  const odds = article.fact_block?.bettor_angle?.odds_status || article.fact_block?.market_watch?.odds_status;
  const model = article.fact_block?.bettor_angle?.model_status || article.fact_block?.market_watch?.model_status;
  if (odds === 'unavailable' && /\b(?:-\d{3}|\+\d{3}|\$\d+(?:\.\d+)?)\b/.test(body)) return 'price-like claim while odds unavailable';
  if (model === 'unavailable' && /\b(?:our model (?:makes|prices|projects|gives)|model probability|fair price|model edge)\b/i.test(body)) return 'model claim while model unavailable';
  if (/\b(lock|guaranteed|sure thing|easy money)\b/i.test(body)) return 'prohibited certainty language';

  const words = wordCount(body);
  const minimum = storyMinimum(article);
  if (words < minimum) return `too short ${words} < ${minimum}`;
  if (words > 2100) return `too long ${words}`;
  const h2 = (body.match(/^##\s+/gm) || []).length;
  if ((article.story_type === 'fight_preview' || article.story_type === 'results') && h2 < 4) return `not enough editorial sections (${h2})`;

  const boiler = [
    'the question this preview works through is simple',
    "the tape's headline number",
    'this is a profile update, not a grade on the market',
  ];
  for (const phrase of boiler) if ((body.toLowerCase().split(phrase).length - 1) > 0) return `template phrase retained: ${phrase}`;
  return null;
}

async function polish(apiKey, article) {
  const sourcePacket = {
    article: { slug: article.slug, story_type: article.story_type, current_headline: article.headline, current_dek: article.dek, current_body_md: article.body_md },
    fact_block: article.fact_block,
    sources: article.sources,
  };
  const source = JSON.stringify(sourcePacket, null, 2);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 18000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      messages: [{ role: 'user', content: `SOURCE PACKET:\n${source}` }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(json).slice(0, 320)}`);
  if (json.stop_reason === 'refusal') throw new Error('anthropic refusal');
  if (json.stop_reason === 'max_tokens') throw new Error('anthropic output truncated');
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  let out;
  try { out = JSON.parse(text); } catch { throw new Error(`invalid JSON: ${text.slice(0, 180)}`); }
  const problem = validate(source, out, article);
  if (problem) throw new Error(`validation: ${problem}`);
  return { headline: out.headline.trim(), dek: out.dek.trim(), body_md: out.body_md.trim() };
}

async function main() {
  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY) {
    console.log('world-class desk: ANTHROPIC_API_KEY not configured; deterministic articles left unchanged');
    return;
  }
  const sb = new Supabase(env);
  const since = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();
  const rows = await sb.select('ufc_articles', `select=id,slug,headline,dek,body_md,story_type,status,fact_block,sources,model_version,updated_at&status=eq.published&updated_at=gte.${encodeURIComponent(since)}&order=updated_at.desc&limit=${LIMIT}`);
  let passed = 0, skipped = 0, rejected = 0;
  console.log(`world-class desk: candidates=${rows.length} limit=${LIMIT} hours=${HOURS} force=${FORCE} dry=${DRY}`);
  for (const article of rows) {
    if (!FORCE && String(article.model_version || '').includes('/editorial-desk-v1')) { skipped++; continue; }
    if (!article.fact_block || !article.body_md) { skipped++; continue; }
    try {
      const out = await polish(env.ANTHROPIC_API_KEY, article);
      console.log(`  PASS ${article.story_type.padEnd(13)} ${wordCount(article.body_md)}w -> ${wordCount(out.body_md)}w  ${article.slug}`);
      passed++;
      if (!DRY) await sb.patch('ufc_articles', `id=eq.${article.id}`, { ...out, model_version: VERSION, updated_at: new Date().toISOString() });
    } catch (error) {
      rejected++;
      console.log(`  HOLD ${article.slug}: ${String(error?.message || error).slice(0, 260)}`);
    }
  }
  console.log(`world-class desk: passed=${passed} skipped=${skipped} held=${rejected}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
