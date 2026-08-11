import { afterAll, describe, expect, it } from 'vitest';

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
// `reprocessNotifications` suite). We assert over `JSON.stringify(__endpoint)`
// rather than its internal shape (mirrors `apps/whatsapp/functions/src/sendOutbound.test.ts`)
// since `secretEnvironmentVariables`/`{ key }` is firebase-functions-internal
// and may change shape across versions.
//
// `FUNCTIONS_REGION` is normally inlined at build time (esbuild `define` in
// build.mjs); here we stub it before importing so `options.ts`'s
// `setGlobalOptions` doesn't throw — restored afterwards so it doesn't leak
// into other test files sharing this vitest project. The module reads
// `process.env` at import time via a top-level `const`, so the stub must land
// before the dynamic import (mirrors `mlTasks.test.ts`'s pattern).
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-east5';

// ⚠️ Keep this import at the TOP LEVEL — do NOT move it into a `beforeAll`.
// `./index` is the heaviest module in this codebase (firebase-functions v2 plus
// every handler + queue module it registers), and Vitest's `hookTimeout`
// defaults to 10 s: inside a hook it flakes under `turbo run test` fan-out,
// while a top-level `await import` is module evaluation and carries no such
// budget. This mirrors `apps/whatsapp/functions/src/sendOutbound.test.ts` and
// the sibling `on*Changed` tests here, which all import at the top level.
const { reprocessMercadoLivreNotifications } = await import('./index');

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
});

describe('reprocessMercadoLivreNotifications (#778)', () => {
  it('binds both ML app secrets and sets timeoutSeconds to 540 (matches the other ML-API-bound sweeps)', () => {
    const endpoint = (
      reprocessMercadoLivreNotifications as unknown as {
        __endpoint: Record<string, unknown>;
      }
    ).__endpoint;
    const serialized = JSON.stringify(endpoint);
    expect(serialized).toContain('MERCADO_LIVRE_CLIENT_ID');
    expect(serialized).toContain('MERCADO_LIVRE_CLIENT_SECRET');
    expect(endpoint.timeoutSeconds).toBe(540);
  });
});
