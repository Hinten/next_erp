// Tests for the `.ignore/` access hook, including Codex's apply_patch payload.
import { deepStrictEqual, ok } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'block-ignore-dir-access.mjs');

function run(payload) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  if (out.trim() === '') return null;
  return JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
}

describe('Codex apply_patch', () => {
  const dir = ['.', 'ignore'].join('');

  for (const [label, patch] of [
    ['Add File', `*** Begin Patch\n*** Add File: ${dir}/secret.txt\n+x\n*** End Patch`],
    ['Update File', `*** Begin Patch\n*** Update File: ${dir}/secret.txt\n@@\n-a\n+b\n*** End Patch`],
    ['Delete File', `*** Begin Patch\n*** Delete File: ${dir}/secret.txt\n*** End Patch`],
    [
      'Move to',
      `*** Begin Patch\n*** Update File: src/a.txt\n*** Move to: ${dir}/a.txt\n@@\n-a\n+b\n*** End Patch`,
    ],
  ]) {
    it(`blocks ${label} inside the directory`, () => {
      ok(run({ tool_name: 'apply_patch', tool_input: { command: patch } }));
    });
  }

  it('allows a patch whose content merely names the directory', () => {
    const patch =
      `*** Begin Patch\n*** Update File: docs/policy.md\n@@\n` +
      `+Agents cannot access ${dir}/.\n*** End Patch`;
    deepStrictEqual(run({ tool_name: 'apply_patch', tool_input: { command: patch } }), null);
  });

  it('blocks CRLF patch headers', () => {
    const patch = `*** Begin Patch\r\n*** Add File: ${dir}/secret.txt\r\n+x\r\n*** End Patch`;
    ok(run({ tool_name: 'apply_patch', tool_input: { command: patch } }));
  });

  it('fails closed when apply_patch has no documented command field', () => {
    ok(run({ tool_name: 'apply_patch', tool_input: { patch: 'uninspectable' } }));
  });
});

describe('existing Claude tool payloads', () => {
  const dir = ['.', 'ignore'].join('');

  it('blocks a direct Read path', () => {
    ok(run({ tool_name: 'Read', tool_input: { file_path: `${dir}/secret.txt` } }));
  });

  it('blocks a shell path', () => {
    ok(run({ tool_name: 'Bash', tool_input: { command: `Get-Content ${dir}/secret.txt` } }));
  });

  it('allows path lookalikes and prose flags', () => {
    deepStrictEqual(
      run({ tool_name: 'Bash', tool_input: { command: 'rg token .gitignore' } }),
      null,
    );
    deepStrictEqual(
      run({
        tool_name: 'Bash',
        tool_input: { command: `gh pr create --title "block access to ${dir}/"` },
      }),
      null,
    );
  });

  it('blocks apply_patch delivered through a shell heredoc', () => {
    const patch = `*** Begin Patch\n*** Add File: ${dir}/secret.txt\n+x\n*** End Patch`;
    ok(run({ tool_name: 'Bash', tool_input: { command: `apply_patch <<'PATCH'\n${patch}\nPATCH` } }));
  });

  it('blocks apply_patch delivered through a PowerShell here-string', () => {
    const patch = `*** Begin Patch\n*** Add File: ${dir}/secret.txt\n+x\n*** End Patch`;
    ok(run({ tool_name: 'Bash', tool_input: { command: `@'\n${patch}\n'@ | apply_patch` } }));
  });

  it('allows a prose-only heredoc that merely names the directory', () => {
    deepStrictEqual(
      run({
        tool_name: 'Bash',
        tool_input: { command: `git commit -F- <<'EOF'\nNever read ${dir}/secret.txt\nEOF` },
      }),
      null,
    );
  });
});

describe('other Codex and MCP tools', () => {
  const dir = ['.', 'ignore'].join('');

  it('blocks an unknown tool with a nested path field', () => {
    ok(
      run({
        tool_name: 'mcp__filesystem__read_file',
        tool_input: { target: { path: `${dir}/secret.txt` } },
      }),
    );
  });

  it('does not treat prompt text as a path', () => {
    deepStrictEqual(
      run({
        tool_name: 'some_tool',
        tool_input: { prompt: `Explain why ${dir}/ is protected.` },
      }),
      null,
    );
  });
});
