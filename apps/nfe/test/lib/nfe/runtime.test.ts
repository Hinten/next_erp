/**
 * `getNFeRuntime` is the cert-OPTIONAL base runtime: the process must boot with
 * NO env cert (per-filial signing). These tests pass an explicit `env` so they
 * never touch the real `NFE_CERT_*`. The offline CI runner has no vendored TLS
 * chain (it's fetched only in the live lane), so `NFE_CA_DIR` points at a
 * throwaway dir with a dummy chain — the cert-free boot guard just needs a file
 * to read; the base runtime never builds an mTLS agent from it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { __resetNFeRuntimeForTests, getNFeRuntime } from '@/lib/nfe/runtime';

let caDir: string;
let prevCaDir: string | undefined;

beforeAll(() => {
  caDir = mkdtempSync(join(tmpdir(), 'nfe-ca-'));
  writeFileSync(
    join(caDir, 'sefaz-sp-homologacao.pem'),
    '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
  );
  prevCaDir = process.env.NFE_CA_DIR;
  process.env.NFE_CA_DIR = caDir;
});

afterAll(() => {
  if (prevCaDir === undefined) delete process.env.NFE_CA_DIR;
  else process.env.NFE_CA_DIR = prevCaDir;
  rmSync(caDir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetNFeRuntimeForTests();
});

afterEach(() => {
  __resetNFeRuntimeForTests();
});

// A clean env with NO `NFE_CERT_*` so the lazy env runtime resolves to null.
const env = (extra: Record<string, string>): NodeJS.ProcessEnv =>
  extra as unknown as NodeJS.ProcessEnv;

describe('getNFeRuntime — cert-optional boot', () => {
  it('boots with no env cert; envRuntime() resolves to null', () => {
    const base = getNFeRuntime(env({ NFE_AMBIENTE: 'homologacao', NFE_UF: 'SP' }));
    expect(base.ambiente).toBe('homologacao');
    expect(base.uf).toBe('SP');
    expect(base.tpAmb).toBe('2');
    // No NFE_CERT_* in the passed env → the lazy env runtime is null, not a throw.
    expect(base.envRuntime()).toBeNull();
  });

  it('throws on an invalid NFE_AMBIENTE', () => {
    expect(() => getNFeRuntime(env({ NFE_AMBIENTE: 'banana' }))).toThrow(/NFE_AMBIENTE/);
  });

  it('caches the base singleton across calls', () => {
    const a = getNFeRuntime(env({ NFE_AMBIENTE: 'homologacao', NFE_UF: 'SP' }));
    const b = getNFeRuntime();
    expect(b).toBe(a);
  });
});
