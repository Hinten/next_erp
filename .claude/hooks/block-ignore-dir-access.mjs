#!/usr/bin/env node
// PreToolUse hook: refuse any tool call that touches the `.ignore/` directory.
//
// Why: `.ignore/` is the repo's local-only, gitignored store for material that
// agents must never access. `permissions.deny` already carried
// `Read(./.ignore/**)`, but that covers exactly one tool — a Write, an Edit, a
// Glob, or a shell command reading the same path all went through. This hook
// closes the gap for every tool at once, including the two shells, where a
// permission rule would have to enumerate command shapes.
//
// Matching is by PATH SEGMENT: `.ignore` must be preceded by a separator (or
// start of string) and followed by one (or end). That blocks `.ignore/x`,
// `./.ignore`, and `C:/repo/.ignore/key.json` while leaving `.gitignore`,
// `.prettierignore` and `--ignore-unknown` alone — none of which contain a dot
// immediately before `ignore`.
//
// Reads the hook payload on stdin, prints a PreToolUse deny decision on stdout
// when it finds a hit, and stays silent otherwise.

import { applyPatchPaths, shellApplyPatchPaths } from './apply-patch-paths.mjs';

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
 * Values of message-carrying flags are PROSE, not paths — `gh pr create --title
 * "block access to the .ignore/ directory"` must not trip the check. Same
 * rationale as stripHeredocs below; this covers the inline form.
 *
 * The `(?:=|\s)` lookahead is load-bearing: it keeps `--body` from swallowing
 * `--body-file`, whose value IS a path and must stay scannable.
 */
const MESSAGE_FLAG_VALUE =
  /(^|\s)(-m|--message|--title|--body|--description|--notes|--reason|--subject)(?:=|\s+)("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g;

function stripMessageFlagValues(command) {
  return command.replace(MESSAGE_FLAG_VALUE, '$1$2 <prose>');
}

/**
 * Drop heredoc bodies before scanning a shell command — they are data, not
 * commands. A commit message or PR body that merely *mentions* `.ignore/` must
 * not trip the check. Mirrors block-firebase-deploy.mjs.
 */
function stripHeredocs(command) {
  const kept = [];
  let delim = null;
  for (const line of command.split(/\r?\n/)) {
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

function isPathField(key) {
  const normalized = key.toLowerCase();
  return (
    normalized === 'path' ||
    normalized === 'paths' ||
    normalized === 'file' ||
    normalized === 'files' ||
    normalized === 'glob' ||
    normalized === 'cwd' ||
    normalized === 'workdir' ||
    normalized === 'directory' ||
    normalized === 'directories' ||
    normalized === 'folder' ||
    normalized === 'folders' ||
    normalized === 'root' ||
    normalized.endsWith('_path') ||
    normalized.endsWith('_paths')
  );
}

/** Path values from Codex/MCP tools that do not have a Claude-specific map. */
function genericPathCandidates(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(genericPathCandidates);

  return Object.entries(value).flatMap(([key, field]) =>
    isPathField(key) ? strings(field) : genericPathCandidates(field),
  );
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

const IGNORE_REASON =
  'Blocked: `.ignore/` holds local-only files that agents must not access. This hook ' +
  'was added deliberately. Do not read, write, list or reference that directory, and ' +
  'do not look for another route to its contents — ask the repo owner to run anything ' +
  'that needs them.';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) process.exit(0); // Unparseable payload: never block on our own bug.
    throw err;
  }

  const tool = payload?.tool_name ?? '';
  const input = payload?.tool_input ?? {};
  let candidates = [];

  if (tool === 'apply_patch') {
    if (typeof input.command !== 'string') {
      deny(
        'Blocked: Codex sent `apply_patch` without its documented `tool_input.command`; ' +
          'the hook cannot prove that the patch avoids `.ignore/`.',
      );
    } else {
      candidates = applyPatchPaths(input.command);
    }
  } else if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(input.command ?? '');
    candidates = [
      stripMessageFlagValues(stripHeredocs(command)),
      ...shellApplyPatchPaths(command),
    ];
  } else if (PATH_FIELDS[tool]) {
    candidates = PATH_FIELDS[tool].flatMap((field) => strings(input[field]));
  } else {
    candidates = genericPathCandidates(input);
  }

  if (!candidates.some((c) => IGNORE_SEGMENT.test(c))) process.exit(0);
  deny(IGNORE_REASON);
});
