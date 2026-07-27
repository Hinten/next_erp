import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// requireSuAuthEnv() reads E2E_SU_EMAIL/E2E_SU_PASSWORD through the
// module-level consts exported by ./auth, which are captured ONCE at import
// time — so each test resets the module registry after mutating process.env
// and re-imports fresh, rather than relying on a single static import.
describe('requireSuAuthEnv — #31 mandatory SU auth for configuracoes.spec.ts', () => {
  let savedEmail: string | undefined;
  let savedPassword: string | undefined;

  beforeEach(() => {
    savedEmail = process.env.E2E_SU_EMAIL;
    savedPassword = process.env.E2E_SU_PASSWORD;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedEmail === undefined) delete process.env.E2E_SU_EMAIL;
    else process.env.E2E_SU_EMAIL = savedEmail;
    if (savedPassword === undefined) delete process.env.E2E_SU_PASSWORD;
    else process.env.E2E_SU_PASSWORD = savedPassword;
  });

  it('throws when both E2E_SU_EMAIL and E2E_SU_PASSWORD are missing', async () => {
    delete process.env.E2E_SU_EMAIL;
    delete process.env.E2E_SU_PASSWORD;
    const { requireSuAuthEnv } = await import('./auth');
    expect(requireSuAuthEnv).toThrow(/E2E_SU_EMAIL\/E2E_SU_PASSWORD/);
  });

  it('throws when only E2E_SU_PASSWORD is missing', async () => {
    process.env.E2E_SU_EMAIL = 'su@example.com';
    delete process.env.E2E_SU_PASSWORD;
    const { requireSuAuthEnv } = await import('./auth');
    expect(requireSuAuthEnv).toThrow(/E2E_SU_EMAIL\/E2E_SU_PASSWORD/);
  });

  it('does not throw when both are configured', async () => {
    process.env.E2E_SU_EMAIL = 'su@example.com';
    process.env.E2E_SU_PASSWORD = 'super-secret';
    const { requireSuAuthEnv } = await import('./auth');
    expect(requireSuAuthEnv).not.toThrow();
  });
});
