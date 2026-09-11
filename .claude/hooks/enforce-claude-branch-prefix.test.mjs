import { execFileSync } from 'node:child_process';
import { deepStrictEqual, match } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./enforce-claude-branch-prefix.mjs', import.meta.url));

function run(command) {
  const output = execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  }).trim();
  return output ? JSON.parse(output).hookSpecificOutput.permissionDecisionReason : null;
}

describe('agent branch prefixes', () => {
  for (const command of [
    'git checkout -b codex/task main',
    'git switch -c codex/task main',
    'git branch codex/task main',
    'git worktree add -b codex/task ../task main',
    'git checkout -b claude/task main',
  ]) {
    it(`allows ${command}`, () => deepStrictEqual(run(command), null));
  }

  for (const command of [
    'git checkout -b chore/task main',
    'git switch -c feature/task main',
    'git branch task main',
    'git worktree add -b fix/task ../task main',
  ]) {
    it(`blocks ${command}`, () => {
      match(run(command), /does not start with `claude\/` or `codex\/`/);
    });
  }
});
