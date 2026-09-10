#!/usr/bin/env node
// PreToolUse hook: refuse to modify or delete `.old/`, the read-only local copy
// of the legacy Flutter app.
//
// Why: `.old/` is the parity reference for every port in this repo — the source
// the `*.ts` doc-comments cite by file:line. It is **gitignored**
// (`.gitignore:48`), so it exists only on disk: nothing restores it, no CI lane
// notices it is gone, and a port that cannot check parity silently degrades to
// guessing. It was lost once, on 2026-08-05.
//
// The likely cause is the reason this hook is not just another deny rule:
// `git clean -fdx` removes ignored files *by definition*, so it deletes `.old/`
// precisely BECAUSE the directory is gitignored — while looking like routine
// tree hygiene. `git clean` was absent from the deny list, and permission deny
// rules match a command PREFIX, so `cd packages && rm -rf ../.old` never
// matched `Bash(rm -rf *)` either. This hook splits compound commands and
// inspects each one, which closes both gaps.
//
// Reads is deliberately untouched: `grep -rn … .old`, `cat`, Read/Grep/Glob all
// stay allowed. Reading `.old/` is the entire point of keeping it.
//
// Reads the hook payload on stdin, prints a PreToolUse deny decision on stdout
// when it finds a write reaching `.old/`, and stays silent otherwise.

/** Tools whose payload names a file path directly. */
const PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Binaries that mutate or remove what they are pointed at. A command is only
 * refused when one of these is BOTH the binary AND a `.old` path appears in its
 * arguments — `grep -rn foo .old` names the directory too, and must still run.
 */
const DESTRUCTIVE_BINS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'mv',
  'cp',
  'dd',
  'truncate',
  'chmod',
  'chown',
  'tee',
  'sed', // `sed -i` edits in place
  'Remove-Item',
  'ri',
  'rd',
  'del',
  'erase',
  'Move-Item',
  'mi',
  'Copy-Item',
  'Set-Content',
  'sc',
  'Add-Content',
  'ac',
  'Clear-Content',
  'New-Item',
  'ni',
  'Out-File',
  'Rename-Item',
  'rni',
]);

/** `find … -delete` / `-exec rm` mutate without naming a destructive binary first. */
const FIND_MUTATORS = /(^|\s)-(delete|exec\b|execdir\b)/;

/**
 * Drop heredoc bodies — they are data, not commands. A commit message or PR
 * body that merely *mentions* deleting `.old` must not trip the check. Mirrors
 * `block-firebase-deploy.mjs`.
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

/** Tokenize one command, honouring quotes. */
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * True when a token refers to the `.old` directory.
 *
 * Matches it as a whole path segment so `.older/`, `foo.old` (a backup file)
 * and `--old-flag` are left alone. Backslashes are normalised first — the hook
 * runs on Windows, where `.claude\..\.old` is a real way to spell it.
 */
function touchesOld(token) {
  const p = String(token).replace(/\\/g, '/');
  return /(^|\/)\.old(\/|$)/.test(p);
}

/** Strip a leading `sudo`/`command`/`env`-style wrapper and env assignments. */
function realBin(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  while (tokens[i] === 'sudo' || tokens[i] === 'command' || tokens[i] === 'env') {
    i++;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  }
  return { bin: tokens[i], args: tokens.slice(i + 1) };
}

/**
 * Why this one command is refused, or `null` to let it through.
 *
 * `git clean` is judged on its FLAGS rather than its arguments: `-x`/`-X` are
 * what reach ignored files, and a bare `git clean -fdx` names no path at all
 * while still deleting `.old/`. That is the sweep this hook exists to stop, so
 * it is refused wherever it runs — a worktree has no `.old/` and loses nothing,
 * and the message names the two safe alternatives.
 */
function refuse(tokens) {
  const { bin, args } = realBin(tokens);
  if (!bin) return null;

  if (bin === 'git' && args[0] === 'clean') {
    // Only x/X reach ignored files; without one, `git clean` cannot touch
    // `.old/` at all. Matches short bundles (-fdx, -Xdf) and the long forms.
    const sweepsIgnored = args.slice(1).some((a) => /^-[a-zA-Z]*[xX]/.test(a));
    if (sweepsIgnored) {
      return (
        '`git clean -x`/`-X` deletes IGNORED files, which is exactly what `.old/` is ' +
        '(.gitignore:48) — the most likely way the legacy Flutter reference was lost on ' +
        '2026-08-05. Use `git clean -fd` (leaves ignored files alone), or scope it to a ' +
        'path that is not the repo root: `git clean -fdx packages/`.'
      );
    }
    return null;
  }

  if (bin === 'find' && args.some(touchesOld) && FIND_MUTATORS.test(args.join(' '))) {
    return '`find` with -delete/-exec inside `.old/` would mutate the legacy reference.';
  }

  if (DESTRUCTIVE_BINS.has(bin) && args.some(touchesOld)) {
    return `\`${bin}\` targeting \`.old/\` would modify or remove the legacy Flutter reference.`;
  }

  return null;
}

/**
 * Targets of shell redirections that are actually operators — `foo > .old/x`,
 * `>> .old/x`.
 *
 * Scans with quote state so a `>` *inside* quotes is data, not a redirect. That
 * distinction is load-bearing: without it, any command that merely quotes a
 * string containing `> .old/…` (a test fixture, a commit message, this hook's
 * own test payloads) is refused — and a protective hook that cries wolf gets
 * worked around, which is worse than not having it.
 */
function redirectTargets(command) {
  const targets = [];
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch !== '>') continue;
    let j = i + 1;
    while (command[j] === '>') j++;
    while (command[j] === ' ' || command[j] === '\t') j++;
    const m = /^("[^"]*"|'[^']*'|\S+)/.exec(command.slice(j));
    if (m) targets.push(m[1].replace(/['"]/g, ''));
  }
  return targets;
}

const WHY =
  ' `.old/` is the read-only parity reference for every port in this repo (the source ' +
  'the doc-comments cite by file:line) and it is gitignored, so nothing restores it and ' +
  'no CI lane notices it is gone. Reading it — Read, Grep, Glob, `grep -rn … .old` — is ' +
  'always allowed. If it genuinely needs to change, ask Lucas to do it.';

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason + WHY,
      },
    }),
  );
  process.exit(0);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // Unparseable payload: never block on our own bug.
  }

  const tool = payload?.tool_name ?? '';
  const input = payload?.tool_input ?? {};

  if (PATH_TOOLS.has(tool)) {
    const target = input.file_path ?? input.notebook_path ?? '';
    if (target && touchesOld(target)) {
      deny(`\`${tool}\` targets a file inside \`.old/\`.`);
    }
    process.exit(0);
  }

  const command = input.command ?? '';
  if (!command) process.exit(0);

  const script = stripHeredocs(command);

  if (redirectTargets(script).some(touchesOld)) {
    deny('Redirecting output into `.old/` would modify the legacy Flutter reference.');
  }

  for (const part of splitCommands(script)) {
    const reason = refuse(tokenize(part));
    if (reason) deny(reason);
  }
  process.exit(0);
});
