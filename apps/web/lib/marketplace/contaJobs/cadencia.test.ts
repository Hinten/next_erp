import { describe, expect, it } from 'vitest';

import {
  INTERVALO_JOB_MS,
  SEM_PROGRESSO_MS,
  formatarInstanteJob,
  silencioExcedido,
  ultimoSinalDeVida,
} from './cadencia';

/**
 * The channel-neutral clock of a conta job card, moved out of Shopee's
 * `cadenciaJobsShopee.ts` (whose tests still pin how Shopee's statuses use it).
 * The `formatarInstanteJob` cases moved here verbatim.
 */

const AGORA = Date.UTC(2026, 9, 14, 15, 0);

describe('the two values', () => {
  it('polls every 3 s and flags after 45 minutes', () => {
    expect(INTERVALO_JOB_MS).toBe(3_000);
    expect(SEM_PROGRESSO_MS).toBe(45 * 60_000);
  });
});

describe('silencioExcedido', () => {
  it('is true one millisecond past 45 min of silence', () => {
    expect(silencioExcedido(AGORA - SEM_PROGRESSO_MS - 1, AGORA)).toBe(true);
  });

  it('NEAR MISS — exactly at the bound and just inside it stay quiet', () => {
    expect(silencioExcedido(AGORA - SEM_PROGRESSO_MS, AGORA)).toBe(false);
    expect(silencioExcedido(AGORA - SEM_PROGRESSO_MS + 1, AGORA)).toBe(false);
  });

  it('a sign of life in the future (clock skew) is never silence', () => {
    expect(silencioExcedido(AGORA + 60_000, AGORA)).toBe(false);
  });
});

describe('ultimoSinalDeVida', () => {
  it('is the checkpoint when nothing is scheduled', () => {
    expect(ultimoSinalDeVida({ updatedAt: AGORA })).toBe(AGORA);
    expect(ultimoSinalDeVida({ updatedAt: AGORA, retomarEm: null })).toBe(AGORA);
  });

  it('is the later of the checkpoint and a scheduled resume', () => {
    expect(ultimoSinalDeVida({ updatedAt: AGORA, retomarEm: AGORA + 1 })).toBe(AGORA + 1);
    // NEAR MISS — a resume already behind the checkpoint does not pull it back.
    expect(ultimoSinalDeVida({ updatedAt: AGORA, retomarEm: AGORA - 1 })).toBe(AGORA);
  });
});

describe('formatarInstanteJob', () => {
  it('prints São Paulo wall time, whatever the machine zone', () => {
    // 03:05Z is 00:05 in São Paulo — and midnight prints as 00, never 24.
    expect(formatarInstanteJob(Date.UTC(2026, 9, 1, 3, 5))).toBe('01/10 00:05');
    expect(formatarInstanteJob(Date.UTC(2026, 9, 1, 3, 5), { comAno: true })).toBe(
      '01/10/2026 00:05',
    );
  });

  it('prints a dash for a value that is not an instant', () => {
    expect(formatarInstanteJob(Number.NaN)).toBe('—');
  });
});
