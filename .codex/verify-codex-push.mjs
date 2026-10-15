#!/usr/bin/env node
// Codex-only PreToolUse/Bash hook for the one pre-authorized push command.
// The prefix rule deliberately names `origin`; this guard proves what that
// name resolves to and which branch HEAD names before the sandbox is crossed.
//
// The gate is inverted on purpose. Codex's prefix_rule matches a PREFIX, so any
// shell spelling that reaches `git -c safe.directory=* push -u origin HEAD` is
// auto-allowed. Recognising those spellings one by one is a race against the
// shell grammar (escapes, line continuations, `&`, quoting a heredoc marker),
// so instead any command that even mentions `safe.directory` together with
// `push` is denied unless it is PROVABLY the canonical command and nothing else.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXPECTED_ORIGIN = 'https://github.com/Hinten/next_erp.git';
export const CANONICAL_PUSH = ['git', '-c', 'safe.directory=*', 'push', '-u', 'origin', 'HEAD'];

const EXPECTED_REPO_IDENTITY = 'github.com/hinten/next_erp';
const SHELLS = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'powershell.exe',
]);
const SHELL_COMMAND_FLAGS = new Set(['-c', '-lc', '-command', '/c']);
// Outside quotes, any of these makes the argv depend on the shell rather than
// on the text: control operators, redirections, expansion and globbing.
const UNPROVABLE_UNQUOTED = new Set([
  ';',
  '&',
  '|',
  '(',
  ')',
  '<',
  '>',
  '\n',
  '$',
  '`',
  '*',
  '?',
  '[',
  ']',
  '{',
  '}',
  '~',
  '#',
]);

const NON_CANONICAL_REASON =
  "A push that names safe.directory must be exactly `git -c 'safe.directory=*' push -u origin HEAD`, on its own: no extra flags or refspecs, no chained commands, escapes or shell expansion. Use a plain `git push` for anything else.";

/**
 * True when the command could be a spelling of the pre-authorized push. Quotes,
 * backslashes, `$` and backticks are folded away first, so `safe.dir''ectory`,
 * `safe.directory=\*` and `$'push'` are all still seen. Over-matching is safe:
 * a candidate that is not provably canonical is denied with a message naming
 * the exact form, and a plain `git push` never matches.
 */
export function mentionsPreauthorizedPush(command) {
  const folded = String(command)
    .replace(/\\\r?\n/g, '')
    .replace(/[\\'"`$]/g, '');
  return /safe\.directory/i.test(folded) && /push/i.test(folded);
}

/**
 * Splits a POSIX-shell word list, honouring single quotes, double quotes,
 * backslash escapes and backslash-newline continuations. Returns null when the
 * argv cannot be derived from the text alone (see UNPROVABLE_UNQUOTED, `$` or a
 * backtick inside double quotes, or an unterminated quote).
 */
function parseWords(command) {
  const words = [];
  let current = '';
  let inWord = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index];

    if (character === "'") {
      const end = command.indexOf("'", index + 1);
      if (end === -1) return null;
      current += command.slice(index + 1, end);
      inWord = true;
      index = end;
      continue;
    }

    if (character === '"') {
      let closed = false;
      for (index++; index < command.length; index++) {
        const inner = command[index];
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === '$' || inner === '`') return null;
        if (inner === '\\') {
          const next = command[index + 1];
          if (next === '\n') {
            index++;
            continue;
          }
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            current += next;
            index++;
            continue;
          }
        }
        current += inner;
      }
      if (!closed) return null;
      inWord = true;
      continue;
    }

    if (character === '\\') {
      const next = command[index + 1];
      if (next === undefined) return null;
      index++;
      if (next === '\n') continue;
      if (next === '\r' && command[index + 1] === '\n') {
        index++;
        continue;
      }
      current += next;
      inWord = true;
      continue;
    }

    if (character === ' ' || character === '\t' || character === '\r') {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
      continue;
    }

    if (UNPROVABLE_UNQUOTED.has(character)) return null;
    current += character;
    inWord = true;
  }

  if (inWord) words.push(current);
  return words;
}

function sameWords(words, expected) {
  return words.length === expected.length && expected.every((word, i) => words[i] === word);
}

/**
 * True only when the whole command is the canonical push, either bare or as the
 * sole script of a shell wrapper (`pwsh -Command "<push>"`, `bash -lc '<push>'`).
 */
function provesCanonical(command, nested = false) {
  const words = parseWords(command.trim());
  if (words === null) return false;
  if (sameWords(words, CANONICAL_PUSH)) return true;
  if (nested || words.length < 3 || !SHELLS.has(words[0].toLowerCase())) return false;

  const flag = words.at(-2).toLowerCase();
  const options = words.slice(1, -2);
  if (!SHELL_COMMAND_FLAGS.has(flag)) return false;
  if (!options.every((option) => /^[-/][A-Za-z]+$/.test(option))) return false;
  return provesCanonical(words.at(-1), true);
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

// `user@host:owner/repo`; the lookahead keeps `https://…` out of it.
const SCP_REMOTE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/;

/**
 * `host/owner/repo`, lower-cased, without userinfo or a `.git` suffix, for the
 * https, ssh:// and scp-style spellings of a remote; null for anything else.
 * GitHub resolves owner and repository names case-insensitively.
 */
export function repoIdentity(remote) {
  const value = String(remote ?? '').trim();
  let host;
  let path;

  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? parseUrl(value) : null;
  if (url) {
    if (!['https:', 'ssh:', 'git+ssh:'].includes(url.protocol)) return null;
    if (url.search || url.hash) return null;
    host = url.hostname;
    path = url.pathname;
  } else {
    const scp = value.match(SCP_REMOTE);
    if (!scp) return null;
    [, host, path] = scp;
  }

  const repo = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
  return `${host.toLowerCase()}/${repo}`;
}

/**
 * A remote spelled for a deny message. Never echoes the raw value: an https
 * remote routinely embeds a credential (`https://x-access-token:ghs_…@github.com`
 * in an Actions checkout), and the reason lands in transcripts and hook logs.
 */
export function describeRemote(remote) {
  if (remote === null || remote === undefined) return 'an unreadable remote';
  const value = String(remote).trim();
  if (!value) return 'an unset remote';

  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? parseUrl(value) : null;
  if (url) return `${url.protocol}//${url.host}${url.pathname}`;

  const scp = value.match(SCP_REMOTE);
  if (scp) return `${scp[1]}:${scp[2]}`;
  return 'an unrecognized remote';
}

/**
 * Null when the command is not the pre-authorized push (normal approval policy
 * applies) or when it is and every check passes; otherwise the deny reason.
 * `originUrl` or `branch` being null means git could not be read.
 */
export function verifyCodexPush(command, { originUrl, branch }) {
  if (!mentionsPreauthorizedPush(command)) return null;
  if (!provesCanonical(String(command))) return NON_CANONICAL_REASON;

  if (repoIdentity(originUrl) !== EXPECTED_REPO_IDENTITY) {
    return `The origin remote must be the github.com/Hinten/next_erp repository; refusing to publish to ${describeRemote(originUrl)}.`;
  }
  if (branch === null || branch === undefined) {
    return 'Could not read the current branch; refusing the pre-authorized push.';
  }
  if (!branch) {
    return 'The pre-authorized Codex push requires an attached codex/* branch; HEAD is detached.';
  }
  if (!branch.startsWith('codex/')) {
    return `The pre-authorized Codex push requires a codex/* branch; refusing to publish ${branch}.`;
  }
  return null;
}

// Returns null when git cannot run or exits non-zero, so the caller fails
// closed without a catch.
function readGit(...args) {
  const result = spawnSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

function runHook() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', () => {
    let command = '';
    try {
      command = JSON.parse(raw)?.tool_input?.command ?? '';
    } catch (err) {
      if (err instanceof SyntaxError) {
        deny('Could not parse the Codex push approval payload.');
        return;
      }
      throw err;
    }
    if (!mentionsPreauthorizedPush(command)) return;

    const reason = verifyCodexPush(command, {
      originUrl: readGit('remote', 'get-url', 'origin'),
      branch: readGit('branch', '--show-current'),
    });
    if (reason) deny(reason);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runHook();
