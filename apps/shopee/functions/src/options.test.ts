import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `options.ts` has no exports — it is imported for its SIDE EFFECT, and the side
 * effect is what these tests drive. `index.test.ts` covers the trigger options;
 * nothing covered the blank-guard on `SHOPEE_TASKS_REGION`, which is the line
 * standing between a blank env value and the queue path `locations//functions/…`
 * that drops every task while the enqueue reports success (#887, #1108).
 */

vi.mock('firebase-functions/v2', () => ({ setGlobalOptions: vi.fn() }));

const REGIAO_ORIGINAL = process.env.FUNCTIONS_REGION;
const TASKS_ORIGINAL = process.env.SHOPEE_TASKS_REGION;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  // ⚠️ `options.ts` WRITES process env, and vitest shares the process across the
  // files of a project — restore both, exactly as index.test.ts does.
  if (REGIAO_ORIGINAL === undefined) delete process.env.FUNCTIONS_REGION;
  else process.env.FUNCTIONS_REGION = REGIAO_ORIGINAL;
  if (TASKS_ORIGINAL === undefined) delete process.env.SHOPEE_TASKS_REGION;
  else process.env.SHOPEE_TASKS_REGION = TASKS_ORIGINAL;
});

describe('options.ts — o guarda de região em branco', () => {
  it('trata SHOPEE_TASKS_REGION só com espaços como NÃO definida', async () => {
    process.env.FUNCTIONS_REGION = 'us-central1';
    process.env.SHOPEE_TASKS_REGION = '   ';

    await import('./options');

    expect(process.env.SHOPEE_TASKS_REGION).toBe('us-central1');
  });

  it('trata a string vazia da mesma forma', async () => {
    process.env.FUNCTIONS_REGION = 'us-central1';
    process.env.SHOPEE_TASKS_REGION = '';

    await import('./options');

    expect(process.env.SHOPEE_TASKS_REGION).toBe('us-central1');
  });

  // NEAR-MISS: o guarda existe para o BRANCO, não para sobrescrever uma escolha
  // do operador. Um valor real tem de sobreviver — uma fila numa região
  // diferente da função é uma decisão legítima (e o `??` sozinho já a respeita).
  it('PRESERVA um valor real, sem sobrescrever com a região embutida', async () => {
    process.env.FUNCTIONS_REGION = 'us-central1';
    process.env.SHOPEE_TASKS_REGION = 'us-east4';

    await import('./options');

    expect(process.env.SHOPEE_TASKS_REGION).toBe('us-east4');
  });

  it('recusa a build sem FUNCTIONS_REGION embutida — sem default', async () => {
    delete process.env.FUNCTIONS_REGION;

    await expect(import('./options')).rejects.toThrow(/FUNCTIONS_REGION/);
  });
});
