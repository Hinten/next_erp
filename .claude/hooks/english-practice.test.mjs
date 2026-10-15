import { match, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'english-practice.mjs');

it('emits shared UserPromptSubmit context for Claude and Codex', () => {
  const output = JSON.parse(execFileSync(process.execPath, [HOOK], { encoding: 'utf8' }));
  strictEqual(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  match(output.hookSpecificOutput.additionalContext, /Always reply in English/);
  match(output.hookSpecificOutput.additionalContext, /pull request title\/description in English/);
});
