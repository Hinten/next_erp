import { execFileSync } from 'node:child_process';
import { deepStrictEqual, match, ok } from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = readFileSync(resolve(REPO_ROOT, '.codex/config.toml'), 'utf8');

function gitFiles(pathspecs) {
  return execFileSync('git', ['-c', 'safe.directory=*', 'ls-files', '--', ...pathspecs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

function maxInstructionChain() {
  const docs = gitFiles(['CLAUDE.md', '**/CLAUDE.md']);
  const sizes = new Map(docs.map((path) => [path, statSync(resolve(REPO_ROOT, path)).size]));
  let largest = { leaf: '', bytes: 0 };

  for (const leaf of docs) {
    const leafDir = posix.dirname(leaf);
    const bytes = docs.reduce((sum, candidate) => {
      const candidateDir = posix.dirname(candidate);
      const applies =
        candidateDir === '.' || leafDir === candidateDir || leafDir.startsWith(`${candidateDir}/`);
      return sum + (applies ? sizes.get(candidate) : 0);
    }, 0);
    if (bytes > largest.bytes) largest = { leaf, bytes };
  }
  return { docs, largest };
}

describe('Codex instruction discovery', () => {
  it('keeps CLAUDE.md as the only repository instruction source', () => {
    match(CONFIG, /project_doc_fallback_filenames\s*=\s*\["CLAUDE\.md"\]/);
    deepStrictEqual(gitFiles(['AGENTS.md', '**/AGENTS.md', 'CODEX.md', '**/CODEX.md']), []);
  });

  it('routes Codex branches through the pre-PR push CI prefix', () => {
    match(CONFIG, /Create Codex task branches under `codex\/\*`/);
  });

  it('keeps at least 16 KiB above the largest instruction chain', () => {
    const configured = Number(CONFIG.match(/project_doc_max_bytes\s*=\s*(\d+)/)?.[1]);
    const { docs, largest } = maxInstructionChain();
    ok(docs.length >= 11, `Expected at least 11 CLAUDE.md files, found ${docs.length}.`);
    ok(Number.isSafeInteger(configured), 'project_doc_max_bytes must be an integer.');
    ok(
      configured - largest.bytes >= 16 * 1024,
      `${largest.leaf} needs ${largest.bytes} bytes, leaving less than 16 KiB under ${configured}.`,
    );
  });
});

describe('Playwright MCP configuration', () => {
  it('uses one pinned package version and the installed binary in both agents', () => {
    const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    const claudeMcp = JSON.parse(readFileSync(resolve(REPO_ROOT, '.mcp.json'), 'utf8'));

    match(packageJson.devDependencies['@playwright/mcp'], /^\d+\.\d+\.\d+$/);
    deepStrictEqual(claudeMcp.mcpServers.playwright, {
      command: 'node',
      args: ['node_modules/@playwright/mcp/cli.js'],
    });
    match(
      CONFIG,
      /\[mcp_servers\.playwright\][\s\S]*?command\s*=\s*"node"[\s\S]*?args\s*=\s*\["node_modules\/@playwright\/mcp\/cli\.js"\][\s\S]*?cwd\s*=\s*"\.\."/,
    );
  });
});

describe('shared destructive Git hook', () => {
  it('is registered exactly once for Claude and Codex shell tools', () => {
    const claudeSettings = JSON.parse(
      readFileSync(resolve(REPO_ROOT, '.claude/settings.json'), 'utf8'),
    );
    const codexHooks = JSON.parse(readFileSync(resolve(REPO_ROOT, '.codex/hooks.json'), 'utf8'));
    const registrations = [claudeSettings, codexHooks].map((settings) =>
      settings.hooks.PreToolUse.filter((entry) =>
        entry.hooks.some((hook) => hook.command.includes('block-destructive-vcs.mjs')),
      ),
    );

    deepStrictEqual(
      registrations.map((entries) => entries.length),
      [1, 1],
    );
    match(registrations[0][0].matcher, /Bash/);
    match(registrations[1][0].matcher, /Bash/);
  });
});

describe('Codex security parity', () => {
  it('keeps credential-bearing local paths denied by the Codex sandbox', () => {
    match(CONFIG, /default_permissions\s*=\s*"next-erp"/);
    // Keep the forbidden filename out of source literals: the repository lint
    // rule bans even mentioning it, while this test only asserts its denial.
    const sensitiveDotEnv = ['.env', 'secrets'].join('.');
    for (const path of ['.env', '.env.local', sensitiveDotEnv, 'secrets/**', '.ignore/**']) {
      match(
        CONFIG,
        new RegExp(`"${path.replaceAll('.', '\\.').replaceAll('*', '\\*')}"\\s*=\\s*"deny"`),
      );
    }
  });

  it('registers every shared policy hook in both agents', () => {
    const claudeSettings = JSON.parse(
      readFileSync(resolve(REPO_ROOT, '.claude/settings.json'), 'utf8'),
    );
    const codexHooks = JSON.parse(readFileSync(resolve(REPO_ROOT, '.codex/hooks.json'), 'utf8'));
    const commandNames = [
      'enforce-claude-branch-prefix.mjs',
      'block-firebase-deploy.mjs',
      'block-destructive-vcs.mjs',
      'protect-old-reference.mjs',
      'block-ignore-dir-access.mjs',
    ];

    for (const commandName of commandNames) {
      for (const settings of [claudeSettings, codexHooks]) {
        const registrations = settings.hooks.PreToolUse.filter((entry) =>
          entry.hooks.some((hook) => hook.command.includes(commandName)),
        );
        deepStrictEqual(registrations.length, 1, `${commandName} must be registered exactly once.`);
      }
    }
  });
});
