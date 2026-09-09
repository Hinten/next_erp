/**
 * Config assertion over `func.__endpoint`. `onSchedule` does not run the
 * handler at import time — it only records the declared options — so this is a
 * pure declaration test, not a live one. The behaviour lives in
 * `test/lib/nfe/handlers/apuracaoSimples.test.ts`.
 *
 * `FUNCTIONS_REGION` is normally inlined at build time by esbuild; stub it
 * before importing so `options.ts`'s `setGlobalOptions` does not throw.
 */
import { afterAll, describe, expect, it } from 'vitest';

const regiaoOriginal = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';

// Top-level, deliberately NOT in `beforeAll` — vitest's 10s hookTimeout flakes
// under `turbo run test` fan-out (same note as the mercado-livre suite).
const { apuracaoSimplesNacional } = await import('./apuracaoSimples');

afterAll(() => {
  if (regiaoOriginal === undefined) delete process.env.FUNCTIONS_REGION;
  else process.env.FUNCTIONS_REGION = regiaoOriginal;
});

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

describe('apuracaoSimplesNacional', () => {
  it('runs MONTHLY on the 2nd at 03:00 São Paulo — the period is load-bearing', () => {
    // ⚠️ Asserted on the parsed trigger fields, not `toContain` over the JSON:
    // every other schedule in this codebase already uses America/Sao_Paulo, so
    // a substring match would pass no matter what THIS function declares.
    //
    // The 2nd, not the 1st: the competência apurada is the previous month, and
    // running at the first instant of the new one races notes still being
    // authorised over the turn.
    const trigger = endpointOf(apuracaoSimplesNacional).scheduleTrigger as {
      schedule?: string;
      timeZone?: string;
    };
    expect(trigger.schedule).toBe('0 3 2 * *');
    expect(trigger.timeZone).toBe('America/Sao_Paulo');
  });

  it('is a scheduled trigger, not a task or a firestore one', () => {
    const endpoint = endpointOf(apuracaoSimplesNacional);
    expect(endpoint.scheduleTrigger).toBeDefined();
    expect(endpoint.taskQueueTrigger).toBeUndefined();
    expect(endpoint.eventTrigger).toBeUndefined();
  });
});
