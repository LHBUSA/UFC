#!/usr/bin/env node
/*
 * Compatibility shim for polish_world_class.mjs.
 *
 * The editorial script was written against an older Copilot CLI JSONL contract.
 * Current CLI prompt mode requires explicit non-interactive permissions and can
 * emit a plain silent final answer. This shim accepts the OLD arguments, invokes
 * the current real CLI in a locked-down empty working directory, then wraps the
 * final answer in the JSONL shape the existing parser already validates.
 *
 * Required env: REAL_COPILOT=/absolute/path/to/installed/copilot
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const real = process.env.REAL_COPILOT;
if (!real) {
  console.error('REAL_COPILOT is not set');
  process.exit(2);
}

function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const prompt = valueAfter('-p') || valueAfter('--prompt');
if (!prompt) {
  console.error('compat shim requires -p/--prompt');
  process.exit(2);
}

const childArgs = [
  '-p', prompt,
  '-s',
  '--yolo',
  '--no-ask-user',
  '--no-custom-instructions',
  '--no-remote',
  '--disable-builtin-mcps',
];

const child = spawnSync(real, childArgs, {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 180000,
  maxBuffer: 16 * 1024 * 1024,
  env: process.env,
});

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}
if (child.signal) {
  console.error(`real copilot terminated by ${child.signal}`);
  process.exit(1);
}
if (child.status !== 0) {
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.stdout) process.stderr.write(child.stdout);
  process.exit(child.status || 1);
}

const content = String(child.stdout || '').trim();
if (!content) {
  console.error('real copilot returned empty output');
  process.exit(1);
}

// Existing parser accepts assistant.message final_answer JSONL events.
process.stdout.write(`${JSON.stringify({
  type: 'assistant.message',
  data: {
    phase: 'final_answer',
    content,
    model: process.env.UFC_EDITORIAL_COPILOT_MODEL || 'auto',
  },
})}\n`);
