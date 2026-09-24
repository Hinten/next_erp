/**
 * The Vitest env pin (`apps/nfe/vitest.config.ts`) — every test run of this app is
 * homologação by construction.
 *
 * `vitest.config.ts` hoists the repo-root `.env` / `.env.local` and the shell env
 * into the test env, so before the pin a developer's `.env.local` carrying
 * `NFE_AMBIENTE=producao` + `NFE_ALLOW_PRODUCAO=true` would have pointed the live
 * orchestrator suites at SEFAZ produção. The pin writes both keys AFTER those
 * spreads; this file proves it without stubbing either NF-e key — the ambient env
 * it reads is the one every other test in this app gets.
 *
 * The one stub is `NFE_CA_DIR`: the offline CI runner has no vendored TLS chain
 * (it is fetched only in the live lane), and the cert-free boot guard just needs
 * a file to read (same workaround as `runtime.test.ts`).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetNFeRuntimeForTests, getNFeRuntime } from '@/lib/nfe/runtime';

let caDir: string;

beforeAll(() => {
  caDir = mkdtempSync(join(tmpdir(), 'nfe-ca-pin-'));
  const uf = (process.env.NFE_UF ?? 'SP').toLowerCase();
  writeFileSync(
    join(caDir, `sefaz-${uf}-homologacao.pem`),
    '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
  );
});

afterAll(() => {
  rmSync(caDir, { recursive: true, force: true });
});

describe('vitest env pin — homologação only', () => {
  beforeEach(() => {
    vi.stubEnv('NFE_CA_DIR', caDir);
    __resetNFeRuntimeForTests();
  });
  afterEach(() => {
    __resetNFeRuntimeForTests();
    vi.unstubAllEnvs();
  });

  it('pins NFE_AMBIENTE to homologação over any .env.local / shell value', () => {
    expect(process.env.NFE_AMBIENTE).toBe('homologacao');
  });

  it('pins NFE_ALLOW_PRODUCAO to the empty string, so the transport guards cannot be opted out of', () => {
    // `''`, not merely "not 'true'": CI never sets the key, so an absent pin
    // (undefined) must fail here too.
    expect(process.env.NFE_ALLOW_PRODUCAO).toBe('');
  });

  it('boots the runtime from the ambient env as tpAmb 2 / homologação', () => {
    // No explicit env: this is the call the live orchestrator suite makes.
    const rt = getNFeRuntime();
    expect(rt.ambiente).toBe('homologacao');
    expect(rt.tpAmb).toBe('2');
  });
});
