#!/usr/bin/env node
// PreToolUse/Bash+PowerShell hook: refuse to run the firebase CLI's `deploy`
// subcommand.
//
// Why: CLAUDE.md critical rule #2 — the Firestore rulesets are GENERATED and
// deployment is a manual, coordinated human step; several firebase.*.json
// configs exist specifically so a stray `firebase deploy` can't push the
// wrong rules or functions. This hook is the technical backstop for that
// rule, covering direct invocations and the common npx/pnpm/yarn/bun runner
// wrappers.
//
// Reads the hook payload on stdin, prints a PreToolUse deny decision on
// stdout when it finds a `firebase deploy` invocation, and stays silent
// otherwise.

const FIREBASE_BIN = /^firebase(-tools)?(@.*)?$/;
const RUNNER_PREFIXES = new Set(['npx', 'pnpm', 'yarn', 'bunx', 'bun']);
const EXEC_SUBCOMMANDS = new Set(['exec', 'dlx']);
/** Flags that consume the following token, so it is not the `deploy` subcommand. */
const VALUE_FLAGS = new Set(['--project', '-P', '--config', '--token']);

/**
 * Drop heredoc bodies. They are data, not commands — a commit message or PR
 * body that merely *mentions* `firebase deploy` must not trip the check. The
 * introducing line is kept (it holds the real command); the body and its
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

/** Tokenize one command, honouring quotes. */
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** True if this command's tokens invoke `firebase … deploy …`, optionally through one runner wrapper. */
function invokesFirebaseDeploy(tokens) {
  // Skip leading environment assignments (FOO=bar firebase deploy).
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;

  let bin = tokens[i];
  if (bin === undefined) return false;

  // Unwrap one layer of runner: `npx firebase deploy`, `pnpm exec firebase-tools deploy`,
  // `pnpm dlx firebase-tools deploy`, `bunx firebase deploy`.
  if (RUNNER_PREFIXES.has(bin)) {
    i++;
    if ((bin === 'pnpm' || bin === 'yarn' || bin === 'bun') && EXEC_SUBCOMMANDS.has(tokens[i])) i++;
    while (tokens[i]?.startsWith('-')) i++; // e.g. npx -y, npx --yes
    bin = tokens[i];
    i++;
  } else {
    i++;
  }

  if (!bin || !FIREBASE_BIN.test(bin)) return false;

  // `deploy` is a positional subcommand anywhere after the binary (flags such
  // as --project can precede it), never a flag value.
  const rest = tokens.slice(i);
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    if (t === 'deploy') return true;
    if (VALUE_FLAGS.has(t)) j++;
  }
  return false;
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

  const hit = splitCommands(stripHeredocs(command)).some((part) => invokesFirebaseDeploy(tokenize(part)));
  if (!hit) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'CLAUDE.md critical rule #2: deploying Firestore rules/functions/hosting is a ' +
          'manual, coordinated human step — agents never run `firebase deploy`. Ask Lucas to ' +
          'run it himself.',
      },
    }),
  );
  process.exit(0);
});
