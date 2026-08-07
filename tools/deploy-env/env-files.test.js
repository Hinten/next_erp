import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyEnvFile, copyDeployEnv } from './env-files.mjs';

/**
 * The table IS the contract. Every name the old denylist would have shipped to the
 * cloud is represented here, so a regression shows up as a changed verdict rather
 * than as a file quietly appearing in a deploy artifact.
 */
describe('classifyEnvFile', () => {
  const cases = [
    // The two allowlisted source names, and the rename that makes them legible to
    // firebase-tools (which reads `.env` / `.env.<project-id>`, nothing else).
    { name: '.env.deploy', action: 'copy', dest: '.env' },
    { name: '.env.deploy.demo-erp', action: 'copy', dest: '.env.demo-erp' },
    { name: '.env.deploy.my-project-prod', action: 'copy', dest: '.env.my-project-prod' },

    // Pre-existing meanings, unchanged.
    { name: '.env.local', action: 'ignore' },
    { name: '.env.example', action: 'ignore' },

    // Not dotenv files. `.envrc` matters: it starts with the six characters the
    // old denylist matched on, so it used to be copied into the artifact.
    { name: '.envrc', action: 'ignore' },
    { name: 'package.json', action: 'ignore' },
    { name: 'index.js', action: 'ignore' },

    // The whole point of the module.
    { name: '.env.secrets', action: 'reject' },
    { name: '.env.secrets.example', action: 'reject' },
    { name: '.env.secrets.bak', action: 'reject' },

    // Legacy + junk names: rejected loudly rather than silently dropped, because
    // `.env` was the documented nfe source filename and still exists on operator disks.
    { name: '.env', action: 'reject' },
    { name: '.env.staging', action: 'reject' },
    { name: '.env.production', action: 'reject' },
    { name: '.env.bak', action: 'reject' },
    { name: '.env.demo-erp', action: 'reject' },

    // Legal project-id characters, reserved artifact meanings.
    { name: '.env.deploy.example', action: 'reject' },
    { name: '.env.deploy.local', action: 'reject' },
  ];

  for (const { name, action, dest } of cases) {
    it(`${name} → ${action}${dest ? ` (${dest})` : ''}`, () => {
      const verdict = classifyEnvFile(name);
      expect(verdict.action).toBe(action);
      if (dest) expect(verdict.dest).toBe(dest);
      if (action === 'reject') expect(verdict.reason).toContain(name);
    });
  }

  it('never returns a copy verdict whose dest is the source name', () => {
    // The rename is the mechanism, not a detail: a `.env.deploy` left un-renamed
    // in the artifact is uploaded and then ignored by firebase-tools.
    for (const { name } of cases) {
      const verdict = classifyEnvFile(name);
      if (verdict.action === 'copy') expect(verdict.dest).not.toBe(name);
    }
  });

  it('rejects the secrets template by prefix, not by exact name', () => {
    // A prefix check is correct HERE (and only here): every `.env.secrets*` variant
    // an operator invents — .bak, .old, .1 — is credential material.
    expect(classifyEnvFile('.env.secrets.whatever-comes-next').action).toBe('reject');
  });
});

describe('copyDeployEnv', () => {
  let pkgDir;
  let deployDir;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-env-'));
    pkgDir = join(root, 'functions');
    deployDir = join(root, 'artifact');
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(deployDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(join(pkgDir, '..'), { recursive: true, force: true });
  });

  const write = (name, body) => writeFileSync(join(pkgDir, name), body);

  it('copies both allowlisted names under their artifact names', () => {
    write('.env.deploy', 'NFE_CERT_ENV_FALLBACK=1\n');
    write('.env.deploy.demo-erp', 'NFE_AMBIENTE=homologacao\n');

    const copied = copyDeployEnv(pkgDir, deployDir);

    expect(readdirSync(deployDir).sort()).toEqual(['.env', '.env.demo-erp']);
    expect(readFileSync(join(deployDir, '.env'), 'utf8')).toBe('NFE_CERT_ENV_FALLBACK=1\n');
    expect(readFileSync(join(deployDir, '.env.demo-erp'), 'utf8')).toBe(
      'NFE_AMBIENTE=homologacao\n',
    );
    expect(copied).toEqual(['.env.deploy → .env', '.env.deploy.demo-erp → .env.demo-erp']);
  });

  it('leaves the artifact empty when there is nothing to copy', () => {
    write('.env.local', 'SEED=1\n');
    write('.env.example', '# template\n');
    write('index.js', 'export default 1;\n');

    expect(copyDeployEnv(pkgDir, deployDir)).toEqual([]);
    expect(readdirSync(deployDir)).toEqual([]);
  });

  it('throws on a secrets file and copies NOTHING', () => {
    write('.env.deploy', 'A=1\n');
    write('.env.secrets', 'MERCADO_LIVRE_CLIENT_SECRET=hunter2\n');

    // `.env.deploy` sorts before `.env.secrets`, so this also pins that the throw
    // aborts the whole artifact rather than leaving a half-populated one behind.
    expect(() => copyDeployEnv(pkgDir, deployDir)).toThrow(/\.env\.secrets/);
  });

  it('throws on a secrets DIRECTORY, not just a file', () => {
    mkdirSync(join(pkgDir, '.env.secrets.d'));
    expect(() => copyDeployEnv(pkgDir, deployDir)).toThrow(/never reach a deploy artifact/);
  });

  it('throws on the legacy bare .env with a rename instruction', () => {
    write('.env', 'NFE_CERT_ENV_FALLBACK=1\n');
    expect(() => copyDeployEnv(pkgDir, deployDir)).toThrow(/Rename it to "\.env\.deploy"/);
  });

  it('throws rather than EISDIR when an allowlisted name is a directory', () => {
    mkdirSync(join(pkgDir, '.env.deploy'));
    expect(() => copyDeployEnv(pkgDir, deployDir)).toThrow(/not a regular file/);
  });
});
