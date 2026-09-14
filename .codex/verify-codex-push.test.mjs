import { deepStrictEqual, match } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXPECTED_ORIGIN, verifyCodexPush } from './verify-codex-push.mjs';

const PUSH = "git -c 'safe.directory=*' push -u origin HEAD";

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

  for (const command of [`${PUSH} --force`, `${PUSH} other:codex/other`]) {
    it(`rejects additional arguments in: ${command}`, () => {
      match(verify(command), /additional flags or refspecs/);
    });
  }

  for (const originUrl of [
    'git@github.com:Hinten/next_erp.git',
    'https://github.com/someone-else/next_erp.git',
    '',
  ]) {
    it(`rejects unverified origin ${originUrl || '<empty>'}`, () => {
      match(verify(PUSH, originUrl), /origin remote must be exactly/);
    });
  }

  it('rejects detached HEAD', () => {
    match(verify(PUSH, EXPECTED_ORIGIN, ''), /HEAD is detached/);
  });

  for (const branch of ['main', 'master', 'claude/task', 'feat/task']) {
    it(`rejects branch ${branch}`, () => {
      match(verify(PUSH, EXPECTED_ORIGIN, branch), /requires a codex\/\* branch/);
    });
  }
});

describe('other push forms', () => {
  for (const command of [
    'git push origin HEAD',
    "git -c 'safe.directory=*' push origin HEAD",
    "git -c 'safe.directory=*' push -u upstream HEAD",
    "git -c 'safe.directory=*' push -u origin codex/task",
  ]) {
    it(`leaves ${command} to the normal approval policy`, () => {
      deepStrictEqual(verify(command), null);
    });
  }
});
