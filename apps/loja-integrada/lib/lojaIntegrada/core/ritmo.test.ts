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
  });

  it('the honest per-store worst case is 120 a minute — above Loja Integrada’s 100, which every flow tolerates', () => {
    // Four consumers can hit one store in the same minute: the reads queue, the
    // poller and the inline reads sweep (each at the reads pacer) plus the writes
    // queue. 120 > 100: reaching it needs a read backlog AND a write backlog on
    // one store at once, and a 429 loses nothing anywhere (the write never
    // landed and its task retries; a read-back or the history read is contained).
    // `ritmo.ts` states this number; this pins it to the two intervals.
    const porMinuto = (ms: number) => Math.floor(60_000 / ms);
    expect(3 * porMinuto(RITMO_LEITURA_LI_MS) + porMinuto(RITMO_ESCRITA_LI_MS)).toBe(120);
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
