/**
 * The Vitest env pin (`apps/nfe/vitest.config.ts`) — every test run of this app is
 * homologação by construction.
 *
 * `vitest.config.ts` hoists the repo-root `.env` / `.env.local` and the shell env
 * into the test env, so before the pin a developer's `.env.local` carrying
 * `NFE_AMBIENTE=producao` + `NFE_ALLOW_PRODUCAO=true` would have pointed the live
 * orchestrator suites at SEFAZ produção. The pin writes both keys AFTER those
 * spreads; this file proves it with NO stubbing — the ambient env it reads is the
 * one every other test in this app gets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetNFeRuntimeForTests, getNFeRuntime } from '@/lib/nfe/runtime';

describe('vitest env pin — homologação only', () => {
  beforeEach(() => {
    __resetNFeRuntimeForTests();
  });
  afterEach(() => {
    __resetNFeRuntimeForTests();
  });

  it('pins NFE_AMBIENTE to homologação over any .env.local / shell value', () => {
    expect(process.env.NFE_AMBIENTE).toBe('homologacao');
  });

  it('pins NFE_ALLOW_PRODUCAO off, so the transport guards cannot be opted out of', () => {
    expect(process.env.NFE_ALLOW_PRODUCAO).not.toBe('true');
  });

  it('boots the runtime from the ambient env as tpAmb 2 / homologação', () => {
    // No explicit env: this is the call the live orchestrator suite makes.
    const rt = getNFeRuntime();
    expect(rt.ambiente).toBe('homologacao');
    expect(rt.tpAmb).toBe('2');
  });
});
