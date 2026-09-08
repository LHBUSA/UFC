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
 *   2. GitHub Copilot CLI using the short-lived Actions token — CLI only.
 *
 * WORKER-CALLABLE. The ufc-newsroom Worker imports this module and calls main()
 * with its own bindings, which imposes three rules that the rest of the file
 * now keeps. Nothing runs on import: this file used to call main() at module
 * scope with no CLI guard, so importing it would have started an editorial
 * pass and patched published articles. Nothing is decided at import: the
 * limits, the window and the models were module-scope constants read from
 * process.argv and process.env, which in a long-lived isolate is once, ever.
 * And node:child_process is imported lazily inside the Copilot provider rather
 * than at the top of the file, so a runtime with no subprocesses can bundle
 * and load this module: the Copilot path simply reports itself unavailable.
 *
 * Each provider gets one bounded corrective rewrite when the deterministic
 * fact/depth validator rejects its first draft. The correction includes only
 * the rejection reason and the same locked source packet; validation is never
 * weakened and the second failure is held.
 *
 * GitHub Models is intentionally not used: GitHub retired that inference
 * service on 2026-07-30. Copilot CLI is the supported Actions-native path.
 *
 * Usage:
 *   node scripts/news/polish_world_class.mjs [--limit 20] [--recent-hours 720] [--force] [--dry-run]
 */
import { Supabase, loadEnv, wordCount } from './lib.mjs';
import { callMessages, DEFAULT_MODEL } from './anthropic.mjs';

const DESK_VERSION = 'editorial-desk-v3';
const DEFAULT_COPILOT_MODEL = 'auto';

export function parseCliOptions(argv = []) {
  const flag = (name) => argv.includes(name);
  const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  return {
    limit: Number(opt('--limit', '30')) || 30,
    recentHours: Number(opt('--recent-hours', '720')) || 720,
    force: flag('--force'),
    dry: flag('--dry-run'),
  };
}

/**
 * Normalise caller options.
 *
 * `env` is threaded in because the model ids used to be read from
 * process.env at import time; a Worker has no process.env worth reading and an
 * isolate would freeze whatever it found on the first load either way.
 */
export function resolveOptions(options = {}, env = {}) {
  return {
    limit: Math.min(60, Math.max(1, Number(options.limit) || 30)),
    recentHours: Math.min(24 * 60, Math.max(1, Number(options.recentHours) || 720)),
    force: Boolean(options.force),
    dry: Boolean(options.dry),
    now: options.now ?? Date.now(),
    anthropicModel: options.anthropicModel || env.UFC_EDITORIAL_MODEL || DEFAULT_MODEL,
    copilotModel: options.copilotModel || env.UFC_EDITORIAL_COPILOT_MODEL || DEFAULT_COPILOT_MODEL,
    /* The Copilot fallback needs a subprocess. Off by default so a host that
     * cannot spawn one never tries; the CLI turns it on. */
    allowCopilot: Boolean(options.allowCopilot),
  };
}

const SYSTEM = `You are the senior editor of PropBetEdge UFC, a premium bettor-facing combat-sports intelligence newsroom. You receive one complete SOURCE PACKET containing a deterministic draft and its machine-readable fact block. Your job is to turn it into publication-grade sports journalism without adding a single unsupported fact.

Editorial standard:
- Write like a top-tier sports/data magazine, not a database template. Open with the actual tension of the fight/result, not housekeeping.
- Translate evidence into fight meaning: range, pace, durability, finishing profile, control, recent form, stance/context and the specific market categories already supported by the packet.
- Put Bettor's Edge into the journalism: what the evidence changes, what it does NOT prove, the counter-case, and what new information would change the read.
- Use short, varied paragraphs. Avoid repeated boilerplate such as “the question this preview works through is simple,” “the tape's headline number,” “this is a profile update,” and generic “markets to reassess” filler.
- When data is missing, mention the limitation once in the most relevant section and keep moving. Do not build entire sections out of missing-data disclaimers.
- Never pad a thin source packet. A concise, sharp article beats invented depth.

Search/editorial discoverability standard:
- Write for humans first, but make the story easy for search engines and answer engines to understand.
- Put the central fighter names, matchup/event and actual story type into the headline/dek when the SOURCE PACKET supports them.
- Establish the core entities and why the story matters in the opening 120 words; do not bury the subject behind a generic lead.
- Use descriptive H2s that say what the section is about. Prefer entity/evidence-led headings over vague labels such as “The big question” or “What it means.”
- Preserve useful internal Markdown links naturally. Never create a new URL or manufacture an entity relationship.
- Do not keyword-stuff, repeat fighter names unnaturally, write for a crawler, or make clickbait claims.

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

function parseCopilotJsonl(stdout, fallbackModel) {
  let finalMessage = null;
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'assistant.message') continue;
    if (typeof event?.data?.content !== 'string') continue;
    if (event.data.phase && event.data.phase !== 'final_answer') continue;
    finalMessage = { content: event.data.content, model: event.data.model || fallbackModel };
  }
  if (!finalMessage) throw new Error('copilot-cli JSONL contained no final assistant.message');
  return finalMessage;
}

function acceptanceInstructions(article) {
  const minimum = storyMinimum(article);
  const requiresSections = article.story_type === 'fight_preview' || article.story_type === 'results';
  return `OUTPUT ACCEPTANCE FOR THIS STORY:\n- body_md must be at least ${minimum} words and no more than 2100 words.\n${requiresSections ? '- body_md must contain at least 4 meaningful Markdown H2 sections.\n' : ''}- Meet the depth requirement by explaining only evidence already in the SOURCE PACKET; never pad with new facts or generic filler.\n- Preserve all existing Markdown links exactly.\n- Use descriptive, search-legible headings and a direct entity-led opening without keyword stuffing.`;
}

function correctionInstructions(problem) {
  return `CORRECTIVE REWRITE REQUIRED:\nThe previous draft was rejected by the deterministic publication gate for exactly this reason: ${problem}.\nRewrite the entire JSON response from the SAME SOURCE PACKET. Fix that failure without adding any fact, number, URL, relationship, odds, prediction or outside knowledge. The publication gate will run again unchanged.`;
}

function parseAndValidate(text, source, article) {
  const out = parseModelJson(text);
  const problem = validate(source, out, article);
  return { out, problem };
}

async function polishAnthropic(apiKey, article, source, opts) {
  let correction = '';
  let lastProblem = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    /* The transport is shared with the article writer (./anthropic.mjs); the
     * prompt, the gate and the single corrective retry stay here, because a
     * copy edit that must preserve every number is not the same editorial job
     * as this desk's restructuring pass. */
    const { text } = await callMessages(apiKey, {
      model: opts.anthropicModel,
      maxTokens: 18000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      prompt: `${acceptanceInstructions(article)}${correction ? `\n\n${correction}` : ''}\n\nSOURCE PACKET:\n${source}`,
    });
    try {
      const { out, problem } = parseAndValidate(text, source, article);
      if (!problem) return { headline: out.headline.trim(), dek: out.dek.trim(), body_md: out.body_md.trim(), provider: 'anthropic', model: opts.anthropicModel, attempts: attempt };
      lastProblem = problem;
    } catch (error) {
      lastProblem = `invalid output serialization: ${String(error?.message || error).slice(0, 260)}`;
    }
    if (attempt === 1) {
      console.log(`  RETRY ${article.slug}: Anthropic held — ${lastProblem}`);
      correction = correctionInstructions(lastProblem);
    }
  }
  throw new Error(`validation after corrective retry: ${lastProblem}`);
}

async function runCopilot(prompt, opts) {
  /* Imported here, not at the top of the file. A Worker has no subprocesses;
   * a static import of node:child_process would make this module unloadable
   * there and take the Anthropic desk down with a fallback nobody can use. */
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const workdir = mkdtempSync(`${tmpdir()}/pbe-ufc-editorial-`);
  let child;
  try {
    child = spawnSync('copilot', [
      '-p', prompt,
      '--model', opts.copilotModel,
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
  return parseCopilotJsonl(child.stdout, opts.copilotModel);
}

async function polishCopilot(article, source, opts) {
  let correction = '';
  let lastProblem = '';
  let lastModel = opts.copilotModel;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = `${SYSTEM}\n\n${acceptanceInstructions(article)}${correction ? `\n\n${correction}` : ''}\n\nSOURCE PACKET:\n${source}`;
    const envelope = await runCopilot(prompt, opts);
    lastModel = envelope.model;
    try {
      const { out, problem } = parseAndValidate(envelope.content, source, article);
      if (!problem) return { headline: out.headline.trim(), dek: out.dek.trim(), body_md: out.body_md.trim(), provider: 'copilot-cli', model: envelope.model, attempts: attempt };
      lastProblem = problem;
    } catch (error) {
      lastProblem = `invalid output serialization: ${String(error?.message || error).slice(0, 260)}`;
    }
    if (attempt === 1) {
      console.log(`  RETRY ${article.slug}: Copilot held — ${lastProblem}`);
      correction = correctionInstructions(lastProblem);
    }
  }
  throw new Error(`validation after corrective retry via ${lastModel}: ${lastProblem}`);
}

/** Which providers this host can actually use, given its bindings. */
export function providersFor(env = {}, opts = { allowCopilot: false }) {
  return {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    /* A token is not enough: the Copilot path spawns a process, so a host that
     * cannot spawn one does not have this provider however many tokens it
     * holds. The Worker never sets allowCopilot. */
    copilot: Boolean(opts.allowCopilot && (env.COPILOT_GITHUB_TOKEN || env.GITHUB_TOKEN)),
  };
}

async function polish(env, article, opts) {
  const { source } = sourcePacket(article);
  const have = providersFor(env, opts);
  const errors = [];

  if (have.anthropic) {
    try { return await polishAnthropic(env.ANTHROPIC_API_KEY, article, source, opts); }
    catch (error) {
      errors.push(`anthropic: ${String(error?.message || error)}`);
      if (!have.copilot) throw error;
      console.log(`  FALLBACK ${article.slug}: Anthropic unavailable/held; trying Copilot CLI`);
    }
  }

  if (have.copilot) {
    try { return await polishCopilot(article, source, opts); }
    catch (error) { errors.push(`copilot-cli: ${String(error?.message || error)}`); }
  }

  if (!have.anthropic && !have.copilot) throw new Error('no editorial model provider configured');
  throw new Error(errors.join(' | ').slice(0, 900));
}

export async function main(injectedEnv, options = {}) {
  const env = injectedEnv || loadEnv();
  const opts = resolveOptions(options, env);
  const have = providersFor(env, opts);

  /* No provider is not a crash and not a silent success. The desk is the
   * polish layer; publication does not pass through it, so a host with no
   * model reports that it did nothing and returns. The CLI adapter below
   * turns this into a non-zero exit, which is what the workflow relied on. */
  if (!have.anthropic && !have.copilot) {
    console.log('world-class desk: no editorial model provider configured; nothing polished');
    return { status: 'no_provider', candidates: 0, passed: 0, skipped: 0, held: 0, provider: null };
  }

  const provider = have.anthropic
    ? `anthropic:${opts.anthropicModel}${have.copilot ? ' (+ copilot-cli fallback)' : ''}`
    : `copilot-cli:${opts.copilotModel}`;
  console.log(`world-class desk: provider=${provider}`);

  const sb = new Supabase(env);
  const since = new Date(opts.now - opts.recentHours * 3600 * 1000).toISOString();
  const rows = await sb.select('ufc_articles', `select=id,slug,headline,dek,body_md,story_type,status,fact_block,sources,model_version,updated_at&status=eq.published&updated_at=gte.${encodeURIComponent(since)}&order=updated_at.desc&limit=${opts.limit}`);
  let passed = 0, skipped = 0, rejected = 0;
  console.log(`world-class desk: candidates=${rows.length} limit=${opts.limit} hours=${opts.recentHours} force=${opts.force} dry=${opts.dry}`);
  for (const article of rows) {
    if (!opts.force && /\/editorial-desk-v\d+(?:$|\b)/.test(String(article.model_version || ''))) { skipped++; continue; }
    if (!article.fact_block || !article.body_md) { skipped++; continue; }
    try {
      const out = await polish(env, article, opts);
      console.log(`  PASS ${article.story_type.padEnd(13)} ${wordCount(article.body_md)}w -> ${wordCount(out.body_md)}w  ${article.slug} via ${out.provider}:${out.model} attempts=${out.attempts || 1}`);
      passed++;
      if (!opts.dry) {
        await sb.patch('ufc_articles', `id=eq.${article.id}`, {
          headline: out.headline,
          dek: out.dek,
          body_md: out.body_md,
          model_version: `${out.provider}:${out.model}/${DESK_VERSION}`,
          updated_at: new Date(opts.now).toISOString(),
        });
      }
    } catch (error) {
      /* A held article keeps the version already published. The desk may only
       * improve an article; it may never remove or downgrade one. */
      rejected++;
      console.log(`  HOLD ${article.slug}: ${String(error?.message || error).slice(0, 900)}`);
    }
  }
  console.log(`world-class desk: passed=${passed} skipped=${skipped} held=${rejected}`);
  const result = { status: 'ran', candidates: rows.length, passed, skipped, held: rejected, provider, dry: opts.dry };
  if (rows.length > 0 && passed === 0 && skipped === 0 && rejected > 0) {
    /* Fail closed: every candidate held means the gate is rejecting everything
     * the model produces, which is a desk fault worth surfacing, not a quiet
     * no-op. Published articles are untouched either way. */
    const e = new Error(`world-class desk: every candidate was held (${rejected}/${rows.length}); failing closed`);
    e.deskResult = result;
    throw e;
  }
  return result;
}

/* CLI only. Importing this module must never start an editorial pass. */
const isCli = typeof process !== 'undefined' && process.argv?.[1]?.endsWith('polish_world_class.mjs');
if (isCli) {
  main(undefined, { ...parseCliOptions(process.argv.slice(2)), allowCopilot: true })
    .then((r) => { if (r && r.status === 'no_provider') { console.error('world-class desk: neither ANTHROPIC_API_KEY nor Copilot token is configured'); process.exit(1); } })
    .catch((error) => { console.error(error); process.exit(1); });
}
