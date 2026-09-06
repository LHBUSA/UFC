#!/usr/bin/env node
/* PropBetEdge UFC — world-class editorial desk pass.
 *
 * The deterministic writer remains the source of truth. This second pass may
 * improve headline/dek/structure/prose ONLY from the stored fact block + draft.
 * It fails closed if the model introduces a number/link that the source packet
 * did not contain, claims unavailable odds/model output, or produces thin copy.
 *
 * Provider order:
 *   1. Anthropic when ANTHROPIC_API_KEY is configured.
 *   2. GitHub Copilot CLI using the short-lived Actions token.
 *
 * GitHub Models is intentionally not used: GitHub retired that inference
 * service on 2026-07-30. Copilot CLI is the supported Actions-native path.
 *
 * Usage:
 *   node scripts/news/polish_world_class.mjs [--limit 20] [--recent-hours 720] [--force] [--dry-run]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Supabase, loadEnv, wordCount } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const LIMIT = Math.min(60, Math.max(1, Number(opt('--limit', '30')) || 30));
const HOURS = Math.min(24 * 60, Math.max(1, Number(opt('--recent-hours', '720')) || 720));
const FORCE = flag('--force');
const DRY = flag('--dry-run');
const ANTHROPIC_MODEL = process.env.UFC_EDITORIAL_MODEL || 'claude-sonnet-5';
const COPILOT_MODEL = process.env.UFC_EDITORIAL_COPILOT_MODEL || 'auto';
const DESK_VERSION = 'editorial-desk-v2';

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
7. Output valid compact JSON only, exactly: {"headline":"...","dek":"...","body_md":"..."}. No code fence or commentary. JSON strings MUST escape line breaks as \\n; never put literal line breaks inside a quoted JSON string.`;

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

function sourcePacket(article) {
  const packet = {
    article: { slug: article.slug, story_type: article.story_type, current_headline: article.headline, current_dek: article.dek, current_body_md: article.body_md },
    fact_block: article.fact_block,
    sources: article.sources,
  };
  return { packet, source: JSON.stringify(packet, null, 2) };
}

function escapeRawControlsInsideJsonStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') { out += '\\r'; continue; }
    if (ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}

function parseModelJson(text) {
  const clean = String(text || '').trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(clean); } catch (strictError) {
    const repaired = escapeRawControlsInsideJsonStrings(clean);
    try { return JSON.parse(repaired); }
    catch (repairError) {
      throw new Error(`invalid JSON: ${clean.slice(0, 180)} (strict=${strictError.message}; repaired=${repairError.message})`);
    }
  }
}

function parseCopilotJsonl(stdout) {
  let finalMessage = null;
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'assistant.message') continue;
    if (typeof event?.data?.content !== 'string') continue;
    if (event.data.phase && event.data.phase !== 'final_answer') continue;
    finalMessage = { content: event.data.content, model: event.data.model || COPILOT_MODEL };
  }
  if (!finalMessage) throw new Error('copilot-cli JSONL contained no final assistant.message');
  return finalMessage;
}

function acceptanceInstructions(article) {
  const minimum = storyMinimum(article);
  const requiresSections = article.story_type === 'fight_preview' || article.story_type === 'results';
  return `OUTPUT ACCEPTANCE FOR THIS STORY:\n- body_md must be at least ${minimum} words and no more than 2100 words.\n${requiresSections ? '- body_md must contain at least 4 meaningful Markdown H2 sections.\n' : ''}- Meet the depth requirement by explaining only evidence already in the SOURCE PACKET; never pad with new facts or generic filler.\n- Preserve all existing Markdown links exactly.`;
}

async function polishAnthropic(apiKey, article, source) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 18000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      messages: [{ role: 'user', content: `${acceptanceInstructions(article)}\n\nSOURCE PACKET:\n${source}` }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${JSON.stringify(json).slice(0, 320)}`);
  if (json.stop_reason === 'refusal') throw new Error('anthropic refusal');
  if (json.stop_reason === 'max_tokens') throw new Error('anthropic output truncated');
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const out = parseModelJson(text);
  const problem = validate(source, out, article);
  if (problem) throw new Error(`validation: ${problem}`);
  return { headline: out.headline.trim(), dek: out.dek.trim(), body_md: out.body_md.trim(), provider: 'anthropic', model: ANTHROPIC_MODEL };
}

function polishCopilot(article, source) {
  const workdir = mkdtempSync(`${tmpdir()}/pbe-ufc-editorial-`);
  const prompt = `${SYSTEM}\n\n${acceptanceInstructions(article)}\n\nSOURCE PACKET:\n${source}`;
  let child;
  try {
    child = spawnSync('copilot', [
      '-p', prompt,
      '--model', COPILOT_MODEL,
      '--stream=off',
      '--output-format=json',
      '--no-color',
      '--no-ask-user',
      '--no-custom-instructions',
      '--no-remote',
    ], {
      cwd: workdir,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 12 * 1024 * 1024,
      env: {
        ...process.env,
        COPILOT_HOME: `${workdir}/copilot-home`,
        GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'false',
        GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: 'false',
        GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP: 'false',
      },
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }

  if (child.error) throw new Error(`copilot-cli: ${child.error.message}`);
  if (child.signal) throw new Error(`copilot-cli terminated by ${child.signal}`);
  if (child.status !== 0) {
    const detail = String(child.stderr || child.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(`copilot-cli exit ${child.status}: ${detail}`);
  }
  const envelope = parseCopilotJsonl(child.stdout);
  const out = parseModelJson(envelope.content);
  const problem = validate(source, out, article);
  if (problem) throw new Error(`validation: ${problem}`);
  return { headline: out.headline.trim(), dek: out.dek.trim(), body_md: out.body_md.trim(), provider: 'copilot-cli', model: envelope.model };
}

async function polish(env, article) {
  const { source } = sourcePacket(article);
  const copilotToken = env.COPILOT_GITHUB_TOKEN || env.GITHUB_TOKEN || '';
  const errors = [];

  if (env.ANTHROPIC_API_KEY) {
    try { return await polishAnthropic(env.ANTHROPIC_API_KEY, article, source); }
    catch (error) {
      errors.push(`anthropic: ${String(error?.message || error)}`);
      if (!copilotToken) throw error;
      console.log(`  FALLBACK ${article.slug}: Anthropic unavailable/held; trying Copilot CLI`);
    }
  }

  if (copilotToken) {
    try { return polishCopilot(article, source); }
    catch (error) { errors.push(`copilot-cli: ${String(error?.message || error)}`); }
  }

  if (!env.ANTHROPIC_API_KEY && !copilotToken) throw new Error('no editorial model provider configured');
  throw new Error(errors.join(' | ').slice(0, 900));
}

async function main() {
  const env = loadEnv();
  const copilotToken = env.COPILOT_GITHUB_TOKEN || env.GITHUB_TOKEN || '';
  if (!env.ANTHROPIC_API_KEY && !copilotToken) {
    throw new Error('world-class desk: neither ANTHROPIC_API_KEY nor Copilot token is configured');
  }
  const provider = env.ANTHROPIC_API_KEY
    ? `anthropic:${ANTHROPIC_MODEL}${copilotToken ? ' (+ copilot-cli fallback)' : ''}`
    : `copilot-cli:${COPILOT_MODEL}`;
  console.log(`world-class desk: provider=${provider}`);

  const sb = new Supabase(env);
  const since = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();
  const rows = await sb.select('ufc_articles', `select=id,slug,headline,dek,body_md,story_type,status,fact_block,sources,model_version,updated_at&status=eq.published&updated_at=gte.${encodeURIComponent(since)}&order=updated_at.desc&limit=${LIMIT}`);
  let passed = 0, skipped = 0, rejected = 0;
  console.log(`world-class desk: candidates=${rows.length} limit=${LIMIT} hours=${HOURS} force=${FORCE} dry=${DRY}`);
  for (const article of rows) {
    if (!FORCE && /\/editorial-desk-v(?:1|2)(?:$|\b)/.test(String(article.model_version || ''))) { skipped++; continue; }
    if (!article.fact_block || !article.body_md) { skipped++; continue; }
    try {
      const out = await polish(env, article);
      console.log(`  PASS ${article.story_type.padEnd(13)} ${wordCount(article.body_md)}w -> ${wordCount(out.body_md)}w  ${article.slug} via ${out.provider}:${out.model}`);
      passed++;
      if (!DRY) {
        await sb.patch('ufc_articles', `id=eq.${article.id}`, {
          headline: out.headline,
          dek: out.dek,
          body_md: out.body_md,
          model_version: `${out.provider}:${out.model}/${DESK_VERSION}`,
          updated_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      rejected++;
      console.log(`  HOLD ${article.slug}: ${String(error?.message || error).slice(0, 900)}`);
    }
  }
  console.log(`world-class desk: passed=${passed} skipped=${skipped} held=${rejected}`);
  if (rows.length > 0 && passed === 0 && skipped === 0 && rejected > 0) {
    throw new Error(`world-class desk: every candidate was held (${rejected}/${rows.length}); failing closed`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
