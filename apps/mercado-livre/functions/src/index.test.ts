import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// #778: the reprocess sweep must bind the ML app credentials + a budget that
// fits its worst-case sequential ML-API-bound drain — exactly like every
// other function that resolves `loadMercadoLivreContext()`. Without them
// every doc it touches throws `MercadoLivreConfigError` (a plain `Error`),
// which the resilience pipeline treats as transient and parks after
// `MAX_TENTATIVAS` — silently destroying the failures-only store in ~2.5h
// (see the issue). `onSchedule` doesn't run the handler at import time — it
// only records the declared options onto `func.__endpoint` — so this is a
// pure config assertion, not a live Firestore/ML-API test (that behaviour is
// already covered by `lib/marketplace/notificacao.test.ts`'s
// `reprocessNotifications` suite).
//
// `FUNCTIONS_REGION` is normally inlined at build time (esbuild `define` in
// build.mjs); here we stub it before importing so `options.ts`'s
// `setGlobalOptions` doesn't throw. `vi.stubEnv` alone won't do — the module
// reads `process.env` at import time via top-level `const`, so the stub must
// land before the dynamic import (mirrors `mlTasks.test.ts`'s pattern).
process.env.FUNCTIONS_REGION = 'us-east5';

let indexModule: typeof import('./index');

beforeAll(async () => {
  indexModule = await import('./index');
});

afterEach(() => {
  // Nothing to reset — this suite only inspects static endpoint config.
});

describe('reprocessMercadoLivreNotifications (#778)', () => {
  it('binds both ML app secrets', () => {
    const endpoint = (
      indexModule.reprocessMercadoLivreNotifications as unknown as {
        __endpoint: { secretEnvironmentVariables?: Array<{ key: string }> };
      }
    ).__endpoint;
    const keys = (endpoint.secretEnvironmentVariables ?? []).map((s) => s.key);
    expect(keys).toContain('MERCADO_LIVRE_CLIENT_ID');
    expect(keys).toContain('MERCADO_LIVRE_CLIENT_SECRET');
  });

  it('sets timeoutSeconds to 540 (matches the other ML-API-bound sweeps)', () => {
    const endpoint = (
      indexModule.reprocessMercadoLivreNotifications as unknown as {
        __endpoint: { timeoutSeconds?: number };
      }
    ).__endpoint;
    expect(endpoint.timeoutSeconds).toBe(540);
  });
});
