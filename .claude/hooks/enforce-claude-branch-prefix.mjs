#!/usr/bin/env node
// PreToolUse/Bash hook: refuse to create a git branch whose name does not start
// with `claude/`.
//
// Why: every workflow's `pull_request` trigger filters on the PR's BASE branch
// (`.github/workflows/ci.yml`). A PR stacked onto a branch outside that list
// reports *zero* checks — silently, as "no checks reported" rather than a
// failure — so it can be merged untested. Keeping every branch under `claude/`
// keeps stacked PRs inside the filter.
//
// Reads the hook payload on stdin, prints a PreToolUse deny decision on stdout
// when it finds a violation, and stays silent otherwise.

const PREFIX = 'claude/';

/** Flags that consume the following token, so it is not a branch name. */
const VALUE_FLAGS = new Set(['-t', '--track', '--set-upstream-to', '-u', '--orphan']);

/**
 * Drop heredoc bodies. They are data, not commands — a commit message or PR
 * body that merely *mentions* `git checkout -b feat/x` must not trip the check.
 * The introducing line is kept (it holds the real command); the body and its
 * terminator are dropped.
 */
function stripHeredocs(command) {
  const kept = [];
  let delim = null;
  for (const line of command.split('\n')) {
    if (delim !== null) {
      if (line.trim() === delim) delim = null;
      continue;
    }
    kept.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m) delim = m[2];
  }
  return kept.join('\n');
}

/** Split a shell command line into separate commands on && || ; | and newlines. */
function splitCommands(line) {
  return line.split(/\|\||&&|[;\n|]/g);
}

/** Tokenize one command, honouring quotes well enough for branch names. */
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Given the tokens of a single command, return every branch name it would
 * create (or rename/copy an existing branch to). Empty when it creates none.
 */
function branchNamesCreated(tokens) {
  // `git` must be the command word, not merely present — otherwise
  // `echo git checkout -b x` or a grep pattern would trip the check. Leading
  // environment assignments (`MSYS_NO_PATHCONV=1 git …`) are skipped.
  let g = 0;
  while (g < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[g])) g++;
  if (tokens[g] !== 'git') return [];
  // Skip `git` and any global options (-C <dir>, -c k=v, --no-pager, …).
  let i = g + 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '-C' || tokens[i] === '-c') i++;
    i++;
  }
  const sub = tokens[i];
  const rest = tokens.slice(i + 1);
  const positionals = [];
  const flags = [];
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    if (t === '--') break;
    if (t.startsWith('-')) {
      flags.push(t);
      if (VALUE_FLAGS.has(t)) j++;
    } else {
      positionals.push(t);
    }
  }
  const has = (...names) => names.some((n) => flags.includes(n));

  if (sub === 'checkout' || sub === 'switch') {
    // -b/-c create; -B/-C force-create. Without them nothing is created.
    if (!has('-b', '-B', '-c', '-C', '--create', '--force-create')) return [];
    return positionals.slice(0, 1);
  }

  if (sub === 'branch') {
    if (has('-d', '-D', '--delete', '--list', '-l', '--show-current', '--contains', '--merged', '--no-merged'))
      return [];
    // Rename/copy: the NEW name is the last positional.
    if (has('-m', '-M', '--move', '-c', '-C', '--copy')) return positionals.slice(-1);
    // `git branch` with no positional just lists.
    return positionals.slice(0, 1);
  }

  if (sub === 'worktree' && positionals[0] === 'add') {
    if (!has('-b', '-B')) return [];
    // `git worktree add -b <branch> <path>` — the flag value is the branch.
    const at = rest.findIndex((t) => t === '-b' || t === '-B');
    return at !== -1 && rest[at + 1] ? [rest[at + 1]] : [];
  }

  return [];
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let command = '';
  try {
    command = JSON.parse(raw)?.tool_input?.command ?? '';
  } catch {
    process.exit(0); // Unparseable payload: never block on our own bug.
  }
  if (!command) process.exit(0);

  const offenders = [];
  for (const part of splitCommands(stripHeredocs(command))) {
    for (const name of branchNamesCreated(tokenize(part))) {
      if (!name.startsWith(PREFIX)) offenders.push(name);
    }
  }
  if (offenders.length === 0) process.exit(0);

  const list = offenders.map((n) => `\`${n}\``).join(', ');
  const suggestion = `claude/${offenders[0].replace(/^[^/]+\//, '')}`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Branch name ${list} does not start with \`${PREFIX}\`. Every workflow's ` +
          "`pull_request` trigger filters on the PR's BASE branch, so a PR stacked onto a " +
          'branch outside that list reports zero checks and can be merged untested. ' +
          `Re-run with \`${suggestion}\` instead.`,
      },
    }),
  );
  process.exit(0);
});
