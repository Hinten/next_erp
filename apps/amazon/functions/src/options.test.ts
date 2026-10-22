import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `options.ts` has no exports — it is imported for its SIDE EFFECT, and the side
 * effect is what these tests drive. Nothing else covers the blank-guard on
 * `AMAZON_TASKS_REGION`, which is the line standing between a blank env value
 * and the queue path `locations//functions/…` that drops every task while the
 * enqueue reports success (#887, #1108), nor the refusal of a bundle built
 * without a region.
 */

vi.mock('firebase-functions/v2', () => ({ setGlobalOptions: vi.fn() }));

const REGIAO_ORIGINAL = process.env.FUNCTIONS_REGION;
const TASKS_ORIGINAL = process.env.AMAZON_TASKS_REGION;

beforeEach(() => {
  vi.resetModules();
  // The mocked module survives `resetModules`, so its call log accumulates over
  // the file: clear it, or the last test counts the earlier tests' imports.
  vi.clearAllMocks();
});

afterEach(() => {
  // ⚠️ `options.ts` WRITES process env, and vitest shares the process across the
  // files of a project — restore both.
  if (REGIAO_ORIGINAL === undefined) delete process.env.FUNCTIONS_REGION;
  else process.env.FUNCTIONS_REGION = REGIAO_ORIGINAL;
  if (TASKS_ORIGINAL === undefined) delete process.env.AMAZON_TASKS_REGION;
  else process.env.AMAZON_TASKS_REGION = TASKS_ORIGINAL;
});

describe('options.ts — the inline guard', () => {
  it('refuses a bundle without an inlined FUNCTIONS_REGION — no default', async () => {
    delete process.env.FUNCTIONS_REGION;

    await expect(import('./options')).rejects.toThrow(/FUNCTIONS_REGION was not inlined/);
  });

  it('a BLANK FUNCTIONS_REGION is refused the same way', async () => {
    process.env.FUNCTIONS_REGION = '';

    await expect(import('./options')).rejects.toThrow(/FUNCTIONS_REGION/);
  });

  it('registers the global options with the inlined region and the instance cap', async () => {
    process.env.FUNCTIONS_REGION = 'xx-regiao1';
    const { setGlobalOptions } = await import('firebase-functions/v2');

    await import('./options');

    expect(setGlobalOptions).toHaveBeenCalledExactlyOnceWith({
      region: 'xx-regiao1',
      maxInstances: 10,
    });
  });
});

describe('options.ts — the blank-region default of AMAZON_TASKS_REGION', () => {
  it('defaults an unset AMAZON_TASKS_REGION to the inlined region', async () => {
    process.env.FUNCTIONS_REGION = 'xx-regiao1';
    delete process.env.AMAZON_TASKS_REGION;

    await import('./options');

    expect(process.env.AMAZON_TASKS_REGION).toBe('xx-regiao1');
  });

  it.each([[''], ['   '], ['\t']])(
    'treats AMAZON_TASKS_REGION=%j as NOT set (the trim)',
    async (valor) => {
      process.env.FUNCTIONS_REGION = 'xx-regiao1';
      process.env.AMAZON_TASKS_REGION = valor;

      await import('./options');

      expect(process.env.AMAZON_TASKS_REGION).toBe('xx-regiao1');
    },
  );

  // NEAR-MISS: the guard exists for the BLANK, and it does not second-guess a
  // real value — `options.ts` keeps it and `??` alone already would. This pins
  // only that mechanics. It does NOT make a cross-region value correct: the one
  // queue is created with its function, in `FUNCTIONS_REGION`, so a different
  // value names a queue that does not exist (#1108). DEPLOY.md says to leave the
  // variable unset or equal to `FUNCTIONS_REGION`; the distinct value below only
  // makes "kept" observable apart from "overwritten".
  it('KEEPS a real value, without overwriting it with the inlined region', async () => {
    process.env.FUNCTIONS_REGION = 'xx-regiao1';
    process.env.AMAZON_TASKS_REGION = 'xx-regiao2';

    await import('./options');

    expect(process.env.AMAZON_TASKS_REGION).toBe('xx-regiao2');
  });
});
