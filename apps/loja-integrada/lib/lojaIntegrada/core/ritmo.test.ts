import { describe, expect, it } from 'vitest';

import {
  RITMO_ESCRITA_LI_MS,
  RITMO_LEITURA_LI_MS,
  ritmoDeEscritaLi,
  ritmoDeLeituraLi,
} from './ritmo';

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

describe('the writes pacer', () => {
  it('averages 2 000 ms per call — at most 30 a minute on the writes queue, its sweep included', () => {
    expect(RITMO_ESCRITA_LI_MS).toBe(2_000);
    expect(Math.floor(60_000 / RITMO_ESCRITA_LI_MS)).toBeLessThanOrEqual(30);
    // The reads queue and the writes queue each stay under a third of Loja
    // Integrada's 100 calls a minute per store.
    expect(Math.floor(60_000 / RITMO_ESCRITA_LI_MS) * 3).toBeLessThan(100);
  });

  it('binds the interval to the sleep it is given, and calls nothing by itself', async () => {
    const esperas: number[] = [];
    const ritmo = ritmoDeEscritaLi((ms) => {
      esperas.push(ms);
      return Promise.resolve();
    });
    expect(ritmo.intervaloMs).toBe(RITMO_ESCRITA_LI_MS);
    expect(esperas).toEqual([]);
    await ritmo.esperar(ritmo.intervaloMs);
    expect(esperas).toEqual([RITMO_ESCRITA_LI_MS]);
  });
});
