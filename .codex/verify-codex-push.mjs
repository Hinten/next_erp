#!/usr/bin/env node
// Codex-only PreToolUse/Bash hook for the one pre-authorized push command.
// The prefix rule deliberately names `origin`; this guard proves what that
// name resolves to and which branch HEAD names before the sandbox is crossed.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXPECTED_ORIGIN = 'https://github.com/Hinten/next_erp.git';
export const CANONICAL_PUSH = ['git', '-c', 'safe.directory=*', 'push', '-u', 'origin', 'HEAD'];

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
const COMMAND_SEPARATORS = new Set(['&&', '||', ';', '|', '\n', '(', ')']);
const SIMPLE_WRAPPERS = new Set(['&', 'command', 'nohup']);

function stripHeredocs(command) {
  const kept = [];
  let delimiter = null;
  for (const line of String(command).split(/\r?\n/)) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (match) delimiter = match[2];
  }
  return kept.join('\n');
}

function tokenize(command) {
  const tokens = [];
  let current = '';
  let quote = null;

  const pushCurrent = () => {
    if (!current) return;
    tokens.push(current);
    current = '';
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '\r') continue;
    if (character === '\n') {
      pushCurrent();
      tokens.push('\n');
      continue;
    }
    if (/\s/.test(character)) {
      pushCurrent();
      continue;
    }

    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      pushCurrent();
      tokens.push(pair);
      index++;
      continue;
    }
    if ([';', '|', '(', ')'].includes(character)) {
      pushCurrent();
      tokens.push(character);
      continue;
    }
    current += character;
  }

  pushCurrent();
  return tokens;
}

function splitCommands(command) {
  const commands = [];
  let current = [];
  for (const token of tokenize(stripHeredocs(command))) {
    if (COMMAND_SEPARATORS.has(token)) {
      if (current.length > 0) commands.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

function commandIndex(tokens) {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
  while (index < tokens.length && SIMPLE_WRAPPERS.has(tokens[index]?.toLowerCase())) {
    index++;
    while (tokens[index] === '--' || tokens[index] === '-p') index++;
  }
  return index;
}

function gitCommands(command) {
  const found = [];
  for (const tokens of splitCommands(command)) {
    const start = commandIndex(tokens);
    const executable = tokens[start]?.toLowerCase();
    if (!executable) continue;

    if (SHELLS.has(executable)) {
      const commandFlag = tokens.findIndex(
        (token, index) =>
          index > start && ['-c', '-lc', '-command', '/c'].includes(token.toLowerCase()),
      );
      if (commandFlag !== -1 && tokens[commandFlag + 1]) {
        found.push(...gitCommands(tokens.slice(commandFlag + 1).join(' ')));
      }
      continue;
    }

    if (executable === 'git') found.push(tokens.slice(start));
  }
  return found;
}

function startsWith(values, prefix) {
  return prefix.every((value, index) => values[index] === value);
}

export function verifyCodexPush(command, { originUrl, branch }) {
  for (const gitCommand of gitCommands(command)) {
    if (!startsWith(gitCommand, CANONICAL_PUSH)) continue;
    if (gitCommand.length !== CANONICAL_PUSH.length) {
      return 'The pre-authorized Codex push cannot contain additional flags or refspecs.';
    }
    if (originUrl !== EXPECTED_ORIGIN) {
      return `The origin remote must be exactly ${EXPECTED_ORIGIN}; refusing to publish to ${originUrl || 'an unresolved remote'}.`;
    }
    if (!branch) {
      return 'The pre-authorized Codex push requires an attached codex/* branch; HEAD is detached.';
    }
    if (!branch.startsWith('codex/')) {
      return `The pre-authorized Codex push requires a codex/* branch; refusing to publish ${branch}.`;
    }
  }
  return null;
}

function readGit(...args) {
  return execFileSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
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
    if (!gitCommands(command).some((tokens) => startsWith(tokens, CANONICAL_PUSH))) return;

    let originUrl = '';
    let branch = '';
    try {
      originUrl = readGit('remote', 'get-url', 'origin');
      branch = readGit('branch', '--show-current');
    } catch {
      deny(
        'Could not verify the Codex branch and origin remote; refusing the pre-authorized push.',
      );
      return;
    }

    const reason = verifyCodexPush(command, { originUrl, branch });
    if (reason) deny(reason);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runHook();
