import { deepStrictEqual, match } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'enforce-claude-branch-prefix.mjs');

function run(command) {
  const output = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  return output.trim() ? JSON.parse(output).hookSpecificOutput : null;
}

const creations = [
  (name) => 'git checkout -b ' + name,
  (name) => 'git checkout -B ' + name,
  (name) => 'git switch -c ' + name,
  (name) => 'git switch --create ' + name,
  (name) => 'git switch -C ' + name,
  (name) => 'git branch ' + name,
  (name) => 'git branch -m old-name ' + name,
  (name) => 'git branch -c old-name ' + name,
  (name) => 'git worktree add -b ' + name + ' ../new-worktree',
];

describe('allowed agent branch prefixes', () => {
  for (const prefix of ['claude/', 'codex/']) {
    for (const create of creations) {
      const command = create(prefix + 'issue-534-chat-empty-filter');
      it('allows ' + command, () => deepStrictEqual(run(command), null));
    }
  }

  it('allows quoted Codex names after global options and an environment assignment', () => {
    deepStrictEqual(
      run('MSYS_NO_PATHCONV=1 git -C ../repo -c core.quotePath=false switch -c "codex/chat"'),
      null,
    );
  });
});

describe('rejected prefixes', () => {
  for (const name of ['feat/chat', 'fix/chat', 'main', 'codex-chat', 'codex', 'claude-chat']) {
    for (const create of creations) {
      const command = create(name);
      it('rejects ' + command, () => {
        const decision = run(command);
        deepStrictEqual(decision?.permissionDecision, 'deny');
        match(decision.permissionDecisionReason, /claude\/.*codex\//);
      });
    }
  }

  it('still rejects an unsupported creation after an allowed Codex creation', () => {
    deepStrictEqual(
      run('git switch -c codex/chat && git branch feat/other')?.permissionDecision,
      'deny',
    );
  });
});

describe('commands that create no branch', () => {
  for (const command of ['git branch', 'git branch --list', 'git branch -d feat/old', 'git switch feat/existing']) {
    it('leaves ' + command + ' unchanged', () => deepStrictEqual(run(command), null));
  }
});
