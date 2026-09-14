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
const COMMAND_SEPARATORS = new Set(['&&', '||', ';', '|', '\n', '(', ')']);
const SIMPLE_WRAPPERS = new Set(['&', 'command', 'nohup']);
const PROTECTED_BRANCHES = new Set(['main', 'master']);
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
  for (const token of tokenize(command)) {
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

function skipAssignments(tokens, index) {
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
  return index;
}

function commandIndex(tokens) {
  let index = skipAssignments(tokens, 0);
  while (index < tokens.length) {
    const wrapper = tokens[index]?.toLowerCase();
    if (SIMPLE_WRAPPERS.has(wrapper)) {
      index++;
      while (tokens[index] === '--' || tokens[index] === '-p') index++;
      continue;
    }
    if (wrapper === 'env') {
      index++;
      while (tokens[index]?.startsWith('-')) {
        const option = tokens[index++];
        if (['-C', '--chdir', '-S', '--split-string', '-u', '--unset'].includes(option)) index++;
      }
      index = skipAssignments(tokens, index);
      continue;
    }
    if (wrapper === 'sudo') {
      index++;
      while (tokens[index]?.startsWith('-')) {
        const option = tokens[index++];
        if (['-C', '-g', '-h', '-p', '-R', '-T', '-u'].includes(option)) index++;
      }
      continue;
    }
    break;
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
      (arg.startsWith('+') && arg.length > 1) ||
      arg === '-f' ||
      /^-[^-]*f/.test(arg) ||
      /^--force(?:$|=|-with-lease(?:$|=)|-if-includes(?:$|=))/.test(arg),
  );
}

function targetsProtectedBranch(args) {
  return args.some(
    (arg) => {
      const destination = arg.split(':').at(-1)?.replace(/^\+/, '');
      return (
        PROTECTED_BRANCHES.has(destination) ||
        [...PROTECTED_BRANCHES].some((branch) => destination === `refs/heads/${branch}`)
      );
    },
  );
}

function isHelp(args) {
  return args.includes('--help') || args.includes('-h');
}

function isDryRun(args) {
  return args.includes('--dry-run') || args.some((arg) => /^-[^-]*n/.test(arg));
}

function dangerousGit(tokens, start) {
  let index = skipOptions(tokens, start + 1, GIT_GLOBAL_VALUE_FLAGS);
  const subcommand = tokens[index++];
  const args = tokens.slice(index);

  if (isHelp(args)) return null;

  if (subcommand === 'push') {
    if (isDryRun(args)) return null;
    if (hasForcePush(args))
      return 'Force-pushing is forbidden; push an ordinary follow-up commit instead.';
    if (targetsProtectedBranch(args))
      return 'Direct pushes to `main` or `master` are forbidden; push the task branch instead.';
  }
  if (subcommand === 'rebase') {
    if (args.some((arg) => ['--abort', '--continue', '--quit', '--skip'].includes(arg))) return null;
    return 'Rebasing is forbidden on shared task branches; merge the base branch or ask the repository owner.';
  }
  if (
    subcommand === 'pull' &&
    args.some((arg) => arg === '-r' || /^--rebase(?:$|=)/.test(arg))
  ) {
    return '`git pull --rebase` is forbidden on shared task branches; pull without rebasing.';
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
    if (deletesBranch && targetsProtectedBranch(args)) {
      return 'Deleting `main` or `master` is forbidden.';
    }
  }
  if (subcommand === 'checkout' || subcommand === 'switch') {
    const createsBranch = args.some((arg) =>
      ['-b', '-B', '-c', '-C', '--create', '--force-create'].includes(arg),
    );
    if (!createsBranch && targetsProtectedBranch(args))
      return 'Switching this task checkout to `main` or `master` is forbidden.';
  }
  return null;
}

function dangerousGh(tokens, start) {
  let index = skipOptions(tokens, start + 1, GH_GLOBAL_VALUE_FLAGS);
  const args = tokens.slice(index);
  if (args.includes('--help') || args.includes('-h')) return null;
  if (args[0] === 'pr' && args[1] === 'merge') {
    return 'Agents must not merge pull requests; leave the final merge to the repository owner.';
  }
  return null;
}

function dangerousCommand(command) {
  for (const part of splitCommands(stripHeredocs(command))) {
    const tokens = part;
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
