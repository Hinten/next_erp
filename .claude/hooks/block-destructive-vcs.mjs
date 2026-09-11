#!/usr/bin/env node
// PreToolUse/Bash+PowerShell hook: refuse destructive Git/GitHub operations
// regardless of where their flags appear.
//
// Native Codex rules remain useful for approval UX, but they match command
// prefixes. This hook is the order-independent backstop for force-pushes,
// history rewriting, destructive branch operations, direct main mutation,
// and PR merges.

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
const WRAPPERS = new Set(['&', 'command', 'sudo']);
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--super-prefix',
  '--work-tree',
]);
const GH_GLOBAL_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);

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

function splitCommands(command) {
  return command.split(/\|\||&&|[;\n|]/g);
}

function tokenize(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function commandIndex(tokens) {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
  while (WRAPPERS.has(tokens[index])) {
    const wrapper = tokens[index++];
    if (wrapper !== 'sudo') continue;
    while (tokens[index]?.startsWith('-')) {
      if (['-C', '-g', '-h', '-p', '-R', '-T', '-u'].includes(tokens[index])) index++;
      index++;
    }
  }
  return index;
}

function skipOptions(tokens, index, valueFlags) {
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    index++;
    if (valueFlags.has(option)) index++;
  }
  return index;
}

function hasForcePush(args) {
  return args.some(
    (arg) =>
      arg === '-f' ||
      /^-[^-]*f/.test(arg) ||
      /^--force(?:$|=|-with-lease(?:$|=)|-if-includes(?:$|=))/.test(arg),
  );
}

function targetsMain(args) {
  return args.some(
    (arg) =>
      arg === 'main' ||
      arg === 'refs/heads/main' ||
      arg.endsWith(':main') ||
      arg.endsWith(':refs/heads/main'),
  );
}

function dangerousGit(tokens, start) {
  let index = skipOptions(tokens, start + 1, GIT_GLOBAL_VALUE_FLAGS);
  const subcommand = tokens[index++];
  const args = tokens.slice(index);

  if (subcommand === 'push') {
    if (hasForcePush(args))
      return 'Force-pushing is forbidden; push an ordinary follow-up commit instead.';
    if (targetsMain(args))
      return 'Direct pushes to `main` are forbidden; push the task branch instead.';
  }
  if (subcommand === 'rebase') {
    return 'Rebasing is forbidden on shared task branches; merge the base branch or ask the repository owner.';
  }
  if (subcommand === 'reset' && args.includes('--hard')) {
    return '`git reset --hard` is forbidden because it can discard workspace changes.';
  }
  if (subcommand === 'branch') {
    const deletesBranch = args.some((arg) => ['-d', '-D', '--delete'].includes(arg));
    const forcesBranch = args.some(
      (arg) => arg === '--force' || arg === '-f' || /^-[^-]*[Df]/.test(arg),
    );
    if (deletesBranch && forcesBranch) {
      return 'Force-deleting branches is forbidden.';
    }
    if (forcesBranch) {
      return 'Force-moving or replacing branches is forbidden.';
    }
    if (deletesBranch && targetsMain(args)) {
      return 'Deleting `main` is forbidden.';
    }
  }
  if (subcommand === 'checkout' || subcommand === 'switch') {
    const createsBranch = args.some((arg) =>
      ['-b', '-B', '-c', '-C', '--create', '--force-create'].includes(arg),
    );
    if (!createsBranch && targetsMain(args))
      return 'Switching this task checkout to `main` is forbidden.';
  }
  return null;
}

function dangerousGh(tokens, start) {
  let index = skipOptions(tokens, start + 1, GH_GLOBAL_VALUE_FLAGS);
  if (tokens[index] === 'pr' && tokens[index + 1] === 'merge') {
    return 'Agents must not merge pull requests; leave the final merge to the repository owner.';
  }
  return null;
}

function dangerousCommand(command) {
  for (const part of splitCommands(stripHeredocs(command))) {
    const tokens = tokenize(part);
    const start = commandIndex(tokens);
    const executable = tokens[start]?.toLowerCase();
    if (!executable) continue;

    if (SHELLS.has(executable)) {
      const commandFlag = tokens.findIndex(
        (token, index) =>
          index > start && ['-c', '-lc', '-command', '/c'].includes(token.toLowerCase()),
      );
      if (commandFlag !== -1 && tokens[commandFlag + 1]) {
        const nested = dangerousCommand(tokens.slice(commandFlag + 1).join(' '));
        if (nested) return nested;
      }
      continue;
    }

    if (executable === 'git' || executable === 'git.exe') {
      const reason = dangerousGit(tokens, start);
      if (reason) return reason;
    } else if (executable === 'gh' || executable === 'gh.exe') {
      const reason = dangerousGh(tokens, start);
      if (reason) return reason;
    }
  }
  return null;
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
  process.exit(0);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let command = '';
  try {
    command = JSON.parse(raw)?.tool_input?.command ?? '';
  } catch (err) {
    if (err instanceof SyntaxError) process.exit(0);
    throw err;
  }
  if (!command) process.exit(0);

  const reason = dangerousCommand(command);
  if (reason) deny(reason);
});
