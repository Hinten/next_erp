#!/usr/bin/env node
// PreToolUse hook: refuse any tool call that touches the `.ignore/` directory.
//
// Why: `.ignore/` holds the Firebase service-account key and the A1 NF-e
// certificates (.pfx). `permissions.deny` already carried `Read(./.ignore/**)`,
// but that covers exactly one tool — a Write, an Edit, a Glob, or a shell
// command reading the same path all went through. This hook closes the gap for
// every tool at once, including the two shells, where a permission rule would
// have to enumerate command shapes.
//
// Matching is by PATH SEGMENT: `.ignore` must be preceded by a separator (or
// start of string) and followed by one (or end). That blocks `.ignore/x`,
// `./.ignore`, and `C:/repo/.ignore/key.json` while leaving `.gitignore`,
// `.prettierignore` and `--ignore-unknown` alone — none of which contain a dot
// immediately before `ignore`.
//
// Reads the hook payload on stdin, prints a PreToolUse deny decision on stdout
// when it finds a hit, and stays silent otherwise.

/** `.ignore` as a whole path segment, in a path or inside a shell command. */
const IGNORE_SEGMENT = /(^|[/\\'"`\s=:(])\.ignore($|[/\\'"`\s),;])/i;

/**
 * Path-bearing fields per tool. Deliberately NOT Grep's `pattern` — that is a
 * content regex, so searching the repo for the text ".ignore" is legitimate and
 * reads nothing out of the directory. Glob's `pattern` IS a path and is checked.
 */
const PATH_FIELDS = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['pattern', 'path'],
  Grep: ['path', 'glob'],
  Artifact: ['file_path'],
  SendUserFile: ['files'],
};

/**
 * Drop heredoc bodies before scanning a shell command — they are data, not
 * commands. A commit message or PR body that merely *mentions* `.ignore/` must
 * not trip the check. Mirrors block-firebase-deploy.mjs.
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

/** Every string reachable from a value (handles the array-valued fields). */
function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return [];
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
  let candidates = [];

  if (tool === 'Bash' || tool === 'PowerShell') {
    candidates = [stripHeredocs(String(input.command ?? ''))];
  } else if (PATH_FIELDS[tool]) {
    candidates = PATH_FIELDS[tool].flatMap((field) => strings(input[field]));
  }

  if (!candidates.some((c) => IGNORE_SEGMENT.test(c))) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Blocked: `.ignore/` holds the Firebase service-account key and the A1 NF-e ' +
          'certificates. Lucas added this hook deliberately to keep agents out of it. Do not ' +
          'read, write, list or reference that directory, and do not look for another route ' +
          'to its contents — ask Lucas to run anything that needs those credentials.',
      },
    }),
  );
  process.exit(0);
});
