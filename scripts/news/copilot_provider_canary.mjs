#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REQUIRED = { ok: true, provider: 'copilot' };
const prompt = 'Return exactly this JSON object and nothing else: {"ok":true,"provider":"copilot"}';

function run(args, cwd) {
  return spawnSync('copilot', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      COPILOT_HOME: `${cwd}/copilot-home`,
      GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'false',
      GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS: 'false',
      GITHUB_COPILOT_PROMPT_MODE_WORKSPACE_MCP: 'false',
    },
  });
}

function contentFromJson(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value?.content === 'string') return value.content;
  if (typeof value?.message === 'string') return value.message;
  if (typeof value?.data?.content === 'string') return value.data.content;
  if (typeof value?.result === 'string') return value.result;
  return null;
}

function extract(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return contentFromJson(parsed) || text;
  } catch {}
  let last = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      const content = contentFromJson(event);
      if (content) last = content;
    } catch {}
  }
  return last || text;
}

function parseObject(text) {
  const clean = String(text || '').trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(clean); } catch {}
  const m = clean.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

const workdir = mkdtempSync(`${tmpdir()}/pbe-ufc-copilot-canary-`);
try {
  const helpRun = run(['--help'], workdir);
  const help = `${helpRun.stdout || ''}\n${helpRun.stderr || ''}`;
  if (helpRun.status !== 0) throw new Error(`copilot --help exit ${helpRun.status}: ${help.trim().slice(0, 800)}`);

  const supports = (flag) => help.includes(flag);
  const args = ['-p', prompt];
  if (supports('--model')) args.push('--model', process.env.UFC_EDITORIAL_COPILOT_MODEL || 'auto');
  if (supports('--output-format')) args.push('--output-format=json');
  if (supports('--stream')) args.push('--stream=off');
  if (supports('--no-color')) args.push('--no-color');
  if (supports('--no-ask-user')) args.push('--no-ask-user');
  if (supports('--no-custom-instructions')) args.push('--no-custom-instructions');
  if (supports('--no-remote')) args.push('--no-remote');
  if (supports('--disable-builtin-mcps')) args.push('--disable-builtin-mcps');
  // Copilot CLI 1.0.83 explicitly requires this in prompt/non-interactive mode.
  // The canary runs in an empty temp directory with built-in MCPs disabled, so
  // permission is granted without exposing the repository or external tools.
  if (supports('--allow-all-tools')) args.push('--allow-all-tools');

  console.log(JSON.stringify({
    help_contract: {
      output_format: supports('--output-format'),
      stream: supports('--stream'),
      no_color: supports('--no-color'),
      no_ask_user: supports('--no-ask-user'),
      no_custom_instructions: supports('--no-custom-instructions'),
      no_remote: supports('--no-remote'),
      disable_builtin_mcps: supports('--disable-builtin-mcps'),
      allow_all_tools: supports('--allow-all-tools'),
      model: supports('--model'),
    },
    invocation_flags: args.filter((x) => String(x).startsWith('-')),
  }, null, 2));

  const child = run(args, workdir);
  if (child.error) throw child.error;
  if (child.signal) throw new Error(`copilot terminated by ${child.signal}`);
  if (child.status !== 0) {
    throw new Error(`copilot exit ${child.status}: ${String(child.stderr || child.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 1600)}`);
  }

  const content = extract(child.stdout);
  const obj = parseObject(content);
  if (!obj || obj.ok !== REQUIRED.ok || obj.provider !== REQUIRED.provider) {
    throw new Error(`unexpected structured response: ${String(content || child.stdout).slice(0, 1600)}`);
  }

  console.log(JSON.stringify({ acceptance: 'PASS', response: obj }, null, 2));
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
