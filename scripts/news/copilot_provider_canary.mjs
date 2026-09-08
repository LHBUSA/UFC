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

  // GitHub's current Actions documentation recommends silent prompt mode with
  // --yolo. We keep the execution inside an empty temp directory, disable the
  // built-in MCP, custom instructions and remote control, and ask for no tools.
  // This removes JSONL/session-event parsing from the editorial dependency.
  const args = ['-p', prompt];
  if (supports('-s, --silent') || supports('--silent')) args.push('-s');
  if (supports('--yolo')) args.push('--yolo');
  if (supports('--no-ask-user')) args.push('--no-ask-user');
  if (supports('--no-custom-instructions')) args.push('--no-custom-instructions');
  if (supports('--no-remote')) args.push('--no-remote');
  if (supports('--disable-builtin-mcps')) args.push('--disable-builtin-mcps');

  console.log(JSON.stringify({
    help_contract: {
      silent: supports('-s, --silent') || supports('--silent'),
      yolo: supports('--yolo'),
      no_ask_user: supports('--no-ask-user'),
      no_custom_instructions: supports('--no-custom-instructions'),
      no_remote: supports('--no-remote'),
      disable_builtin_mcps: supports('--disable-builtin-mcps'),
    },
    invocation_flags: args.filter((x) => String(x).startsWith('-')),
  }, null, 2));

  const child = run(args, workdir);
  if (child.error) throw child.error;
  if (child.signal) throw new Error(`copilot terminated by ${child.signal}`);
  if (child.status !== 0) {
    const combined = `${child.stderr || ''}\n${child.stdout || ''}`.trim();
    console.error('COPILOT_FAILURE_TAIL');
    console.error(combined.split(/\r?\n/).slice(-24).join('\n').slice(-8000));
    throw new Error(`copilot exit ${child.status}`);
  }

  const obj = parseObject(child.stdout);
  if (!obj || obj.ok !== REQUIRED.ok || obj.provider !== REQUIRED.provider) {
    throw new Error(`unexpected structured response: ${String(child.stdout || '').slice(0, 1600)}`);
  }

  console.log(JSON.stringify({ acceptance: 'PASS', response: obj }, null, 2));
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
