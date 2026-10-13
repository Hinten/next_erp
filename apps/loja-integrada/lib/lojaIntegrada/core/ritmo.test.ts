import { describe, expect, it } from 'vitest';

import { RITMO_LEITURA_LI_MS, ritmoDeLeituraLi } from './ritmo';

describe('the reads pacer', () => {
  it('spaces calls by 2 000 ms — at most 30 a minute on the reads queue', () => {
    expect(RITMO_LEITURA_LI_MS).toBe(2_000);
    expect(Math.floor(60_000 / RITMO_LEITURA_LI_MS)).toBeLessThanOrEqual(30);
  });

  it('binds the interval to the sleep it is given, and calls nothing by itself', async () => {
    const esperas: number[] = [];
    const ritmo = ritmoDeLeituraLi((ms) => {
      esperas.push(ms);
      return Promise.resolve();
    });
    expect(ritmo.intervaloMs).toBe(RITMO_LEITURA_LI_MS);
    expect(esperas).toEqual([]);
    await ritmo.esperar(ritmo.intervaloMs);
    expect(esperas).toEqual([RITMO_LEITURA_LI_MS]);
  });
});
