import { deepStrictEqual, doesNotMatch, match } from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXPECTED_ORIGIN,
  describeRemote,
  repoIdentity,
  verifyCodexPush,
} from './verify-codex-push.mjs';

const PUSH = "git -c 'safe.directory=*' push -u origin HEAD";
const HOSTILE_ORIGIN = 'https://evil.example/x.git';

function verify(command = PUSH, originUrl = EXPECTED_ORIGIN, branch = 'codex/task') {
  return verifyCodexPush(command, { originUrl, branch });
}

describe('the pre-authorized Codex push', () => {
  it('allows the exact command on a codex/* branch and verified origin', () => {
    deepStrictEqual(verify(), null);
  });

  it('recognizes the exact command through the Windows shell wrapper', () => {
    deepStrictEqual(verify(`pwsh -Command "${PUSH}"`), null);
  });

  it('allows a trailing newline', () => {
    deepStrictEqual(verify(`${PUSH}\n`), null);
  });

  // Spellings a real shell turns into the canonical argv: they must be SEEN and
  // verified, never waved through with the checks skipped.
  for (const command of [
    'git -c safe.directory=\\* push -u origin HEAD',
    "git \\\n  -c 'safe.directory=*' push -u origin HEAD",
    'git -c "safe.directory=*" push -u origin HEAD',
  ]) {
    it(`verifies the origin for the equivalent spelling: ${JSON.stringify(command)}`, () => {
      deepStrictEqual(verify(command), null);
      match(verify(command, HOSTILE_ORIGIN), /origin remote must be/);
      match(verify(command, EXPECTED_ORIGIN, 'main'), /requires a codex\/\* branch/);
    });
  }

  for (const command of [
    `${PUSH} --force`,
    `${PUSH} other:codex/other`,
    'git -c safe.directory=\\* push -u origin HEAD --force',
    "git \\\n  -c 'safe.directory=*' push -u origin HEAD --force",
    `git status & ${PUSH} --force`,
    `git status & ${PUSH}`,
    `git commit -m "note << HEAD"\n${PUSH}`,
    `git status && ${PUSH}`,
    `${PUSH}; git status`,
    `pwsh -Command "git status; ${PUSH}"`,
    'git -c safe.directory=* push -u origin HEAD',
    'git -c safe.directory=$X push -u origin HEAD',
    "git -c 'safe.directory=*' push -u origin $(git branch --show-current)",
    "git -c 'safe.directory=*' $'push' -u origin HEAD",
    "git -c 'safe.directory=*' {push,} -u origin HEAD",
    `GIT_TRACE=1 ${PUSH}`,
    "git -c 'safe.Directory=*' push -u origin HEAD",
    "git -c 'safe.directory=*' push origin HEAD",
    "git -c 'safe.directory=*' push -u upstream HEAD",
    "git -c 'safe.directory=*' push -u origin codex/task",
  ]) {
    it(`denies the unprovable spelling: ${JSON.stringify(command)}`, () => {
      match(verify(command), /must be exactly/);
    });
  }

  it('rejects detached HEAD', () => {
    match(verify(PUSH, EXPECTED_ORIGIN, ''), /HEAD is detached/);
  });

  it('fails closed when git cannot be read', () => {
    match(verify(PUSH, null), /unreadable remote/);
    match(verify(PUSH, EXPECTED_ORIGIN, null), /Could not read the current branch/);
  });

  for (const branch of ['main', 'master', 'claude/task', 'feat/task']) {
    it(`rejects branch ${branch}`, () => {
      match(verify(PUSH, EXPECTED_ORIGIN, branch), /requires a codex\/\* branch/);
    });
  }
});

describe('the origin identity', () => {
  for (const originUrl of [
    EXPECTED_ORIGIN,
    'https://github.com/Hinten/next_erp',
    'https://github.com/Hinten/next_erp/',
    'https://GitHub.com/hinten/NEXT_ERP.git',
    'https://x-access-token:ghs_example@github.com/Hinten/next_erp.git',
    'git@github.com:Hinten/next_erp.git',
    'git@github.com:Hinten/next_erp',
    'ssh://git@github.com/Hinten/next_erp.git',
  ]) {
    it(`accepts ${originUrl}`, () => {
      deepStrictEqual(verify(PUSH, originUrl), null);
    });
  }

  // Near misses: each one differs from the accepted set in a single component.
  for (const originUrl of [
    'https://github.com/someone-else/next_erp.git',
    'https://github.com/Hinten/next_erp-fork.git',
    'https://github.com/Hinten/next_erp/extra.git',
    'https://gitlab.com/Hinten/next_erp.git',
    'https://github.com.evil.example/Hinten/next_erp.git',
    'http://github.com/Hinten/next_erp.git',
    'https://github.com/Hinten/next_erp.git?ref=x',
    'file:///github.com/Hinten/next_erp.git',
    '../next_erp',
    '',
  ]) {
    it(`rejects ${originUrl || '<empty>'}`, () => {
      match(verify(PUSH, originUrl), /origin remote must be the github\.com\/Hinten\/next_erp/);
    });
  }

  it('normalizes only userinfo, case and the .git suffix', () => {
    deepStrictEqual(
      repoIdentity('https://u:p@github.com/Hinten/next_erp.git'),
      'github.com/hinten/next_erp',
    );
    deepStrictEqual(
      repoIdentity('git@github.com:Hinten/next_erp.git'),
      'github.com/hinten/next_erp',
    );
    deepStrictEqual(
      repoIdentity('https://github.com/Hinten/next_erp.git.git'),
      'github.com/hinten/next_erp.git',
    );
    deepStrictEqual(repoIdentity('not a remote'), null);
  });
});

describe('the deny message', () => {
  for (const [originUrl, secret, shown] of [
    [
      'https://x-access-token:ghs_SECRET123@evil.example/x.git',
      /ghs_SECRET123|x-access-token/,
      'https://evil.example/x.git',
    ],
    ['https://ghp_SECRET123@evil.example/x.git', /ghp_SECRET123/, 'https://evil.example/x.git'],
    ['https://evil.example/x.git?token=SECRET123', /SECRET123/, 'https://evil.example/x.git'],
    ['deploy@evil.example:x.git', /deploy@/, 'evil.example:x.git'],
    ['ghp_SECRET123 not a url', /SECRET123/, 'an unrecognized remote'],
  ]) {
    it(`never echoes credentials from ${describeRemote(originUrl)}`, () => {
      const reason = verify(PUSH, originUrl);
      doesNotMatch(reason, secret);
      match(reason, new RegExp(shown.replace(/[.?*+^$()[\]{}|\\/]/g, '\\$&')));
    });
  }
});

describe('other push forms', () => {
  for (const command of [
    'git push origin HEAD',
    'git push -u origin codex/task',
    'git status',
    'git commit -m "push the fix"',
  ]) {
    it(`leaves ${command} to the normal approval policy, whatever the origin`, () => {
      deepStrictEqual(verify(command, HOSTILE_ORIGIN, 'main'), null);
    });
  }
});
