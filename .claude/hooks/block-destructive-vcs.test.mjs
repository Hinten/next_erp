import { execFileSync } from 'node:child_process';
import { deepStrictEqual, match, ok } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./block-destructive-vcs.mjs', import.meta.url));

function run(command) {
  const output = execFileSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  }).trim();
  return output ? JSON.parse(output).hookSpecificOutput.permissionDecisionReason : null;
}

describe('force-push and main mutation', () => {
  for (const command of [
    'git push --force origin HEAD',
    'git push origin HEAD --force',
    'git push origin claude/task --force-with-lease',
    'git push --force-with-lease=abc origin HEAD',
    'git push -uf origin HEAD',
    'git -C packages push origin HEAD -f',
    'sudo git push origin HEAD --force',
  ]) {
    it(`blocks ${command}`, () => match(run(command), /Force-pushing/));
  }

  for (const command of [
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin feature:refs/heads/main',
  ]) {
    it(`blocks ${command}`, () => match(run(command), /Direct pushes/));
  }
});

describe('other destructive operations', () => {
  const cases = [
    ['git rebase origin/main', /Rebasing/],
    ['git reset HEAD --hard', /reset --hard/],
    ['git branch -D claude/old', /Force-deleting/],
    ['git branch --delete --force claude/old', /Force-deleting/],
    ['git branch --force claude/task HEAD~1', /Force-moving/],
    ['git branch -d main', /Deleting `main`/],
    ['git checkout main', /Switching.*`main`/],
    ['git switch main', /Switching.*`main`/],
    ['gh pr merge 1580', /must not merge/],
    ['gh --repo Hinten/next_erp pr merge 1580', /must not merge/],
    ['pnpm test && git push origin HEAD --force', /Force-pushing/],
    ['bash -lc "git push origin HEAD --force"', /Force-pushing/],
    ['cmd.exe /d /s /c git rebase origin/main', /Rebasing/],
    ['& git.exe reset --hard HEAD', /reset --hard/],
    ['gh.exe pr merge 1580', /must not merge/],
  ];

  for (const [command, expected] of cases) {
    it(`blocks ${command}`, () => match(run(command), expected));
  }
});

describe('safe and prose-only commands', () => {
  for (const command of [
    'git push origin HEAD',
    'git branch -d claude/merged',
    'git checkout -b claude/task main',
    'git switch -c claude/task main',
    'gh pr view 1580',
    'git commit -m "never git push --force"',
    'echo "gh pr merge is forbidden"',
    "gh pr comment 1580 --body 'do not git reset --hard'",
  ]) {
    it(`allows ${command}`, () => deepStrictEqual(run(command), null));
  }

  it('ignores destructive examples inside a heredoc body', () => {
    deepStrictEqual(run("git commit -F- <<'EOF'\nNever run git push --force.\nEOF"), null);
  });

  it('emits a real PreToolUse denial', () => {
    ok(run('git push origin HEAD --force'));
  });
});
