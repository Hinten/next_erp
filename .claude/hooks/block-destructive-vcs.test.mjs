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
    'git push origin +HEAD:refs/heads/codex/task',
    'git push origin +codex/task',
    'env GIT_TERMINAL_PROMPT=0 git push origin HEAD --force',
    'nohup git push origin HEAD --force',
    '( git push origin HEAD --force )',
  ]) {
    it(`blocks ${command}`, () => match(run(command), /Force-pushing/));
  }

  for (const command of [
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin feature:refs/heads/main',
    'git push origin master',
    'git push origin HEAD:refs/heads/master',
  ]) {
    it(`blocks ${command}`, () => match(run(command), /Direct pushes/));
  }
});

describe('other destructive operations', () => {
  const cases = [
    ['git rebase origin/main', /Rebasing/],
    ['git pull --rebase origin main', /pull --rebase/],
    ['git pull --rebase=merges', /pull --rebase/],
    ['git pull -r origin main', /pull --rebase/],
    ['git reset HEAD --hard', /reset --hard/],
    ['git branch -D claude/old', /Force-deleting/],
    ['git branch --delete --force claude/old', /Force-deleting/],
    ['git branch --force claude/task HEAD~1', /Force-moving/],
    ['git branch -d main', /Deleting `main`/],
    ['git checkout main', /Switching.*`main`/],
    ['git switch main', /Switching.*`main`/],
    ['git checkout master', /Switching.*`main` or `master`/],
    ['gh pr merge 1580', /must not merge/],
    ['gh --repo Hinten/next_erp pr merge 1580', /must not merge/],
    ['pnpm test && git push origin HEAD --force', /Force-pushing/],
    ['bash -lc "git push origin HEAD --force"', /Force-pushing/],
    ['bash -lc "git push origin HEAD --force; true"', /Force-pushing/],
    ['bash -lc "git push origin HEAD --force && true"', /Force-pushing/],
    ["sh -c 'git push origin HEAD --force; true'", /Force-pushing/],
    ['pwsh -Command "git push origin HEAD --force; exit 0"', /Force-pushing/],
    ['bash -lc "git reset --hard origin/main; true"', /reset --hard/],
    ['bash -lc "gh pr merge 1583 --squash; true"', /must not merge/],
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
    'git rebase --abort',
    'git rebase --continue',
    'git rebase --quit',
    'git rebase --skip',
    'git rebase --help',
    'gh pr merge --help',
    'git push --dry-run --force origin HEAD',
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
