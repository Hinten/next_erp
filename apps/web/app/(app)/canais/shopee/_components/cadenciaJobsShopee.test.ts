import { describe, expect, it } from 'vitest';
import {
  ENVIO_PRECO_SHOPEE_STATUS,
  IMPORTACAO_SHOPEE_STATUS,
  type EnvioPrecoShopeeStatus,
  type ImportacaoShopeeStatus,
} from '@delfrance/schemas';

import {
  INTERVALO_JOB_ESTACIONADO_MS,
  INTERVALO_JOB_MS,
  SEM_PROGRESSO_MS,
  formatarInstanteJob,
  intervaloEnvioPreco,
  intervaloImportacao,
  janelaUpdateTimeEmSegundos,
  semProgresso,
  ultimoSinalDeVida,
} from './cadenciaJobsShopee';

const AGORA = Date.UTC(2026, 9, 14, 15, 0);

function importacao(status: ImportacaoShopeeStatus) {
  return { status, updatedAt: AGORA };
}

function envioPreco(
  over: { status?: EnvioPrecoShopeeStatus; updatedAt?: number; retomarEm?: number | null } = {},
) {
  return {
    status: over.status ?? ENVIO_PRECO_SHOPEE_STATUS.running,
    updatedAt: over.updatedAt ?? AGORA,
    retomarEm: over.retomarEm ?? null,
  };
}

describe('intervaloImportacao', () => {
  it('polls every 3 s while running and stops on every terminal status', () => {
    expect(INTERVALO_JOB_MS).toBe(3_000);
    expect(intervaloImportacao(importacao(IMPORTACAO_SHOPEE_STATUS.running))).toBe(3_000);
    for (const status of [
      IMPORTACAO_SHOPEE_STATUS.completed,
      IMPORTACAO_SHOPEE_STATUS.failed,
      IMPORTACAO_SHOPEE_STATUS.cancelled,
    ]) {
      expect(intervaloImportacao(importacao(status))).toBe(false);
    }
  });

  it('does not poll before a status was read', () => {
    expect(intervaloImportacao(undefined)).toBe(false);
  });
});

describe('intervaloEnvioPreco', () => {
  it('polls every 3 s while running and not parked', () => {
    expect(intervaloEnvioPreco(envioPreco(), AGORA)).toBe(INTERVALO_JOB_MS);
  });

  it('backs off to 60 s while parked with the resume still AHEAD', () => {
    expect(INTERVALO_JOB_ESTACIONADO_MS).toBe(60_000);
    expect(intervaloEnvioPreco(envioPreco({ retomarEm: AGORA + 1 }), AGORA)).toBe(60_000);
  });

  it('polls fast again once the resume is due — an overdue park is not a park', () => {
    // The near miss of the case above: one millisecond on the other side.
    expect(intervaloEnvioPreco(envioPreco({ retomarEm: AGORA - 1 }), AGORA)).toBe(3_000);
    expect(intervaloEnvioPreco(envioPreco({ retomarEm: AGORA }), AGORA)).toBe(3_000);
  });

  it('stops once the run stopped, even with a stale resume stamp', () => {
    expect(
      intervaloEnvioPreco(
        envioPreco({ status: ENVIO_PRECO_SHOPEE_STATUS.completed, retomarEm: AGORA + 60_000 }),
        AGORA,
      ),
    ).toBe(false);
    expect(intervaloEnvioPreco(undefined, AGORA)).toBe(false);
  });
});

describe('semProgresso', () => {
  it('is 45 minutes', () => {
    expect(SEM_PROGRESSO_MS).toBe(45 * 60_000);
  });

  it('flags a running job one millisecond past 45 min of silence, and not one before', () => {
    const d = envioPreco({ updatedAt: AGORA - SEM_PROGRESSO_MS - 1 });
    expect(semProgresso(d, AGORA)).toBe(true);
    // NEAR MISS — exactly at the bound and just inside it stay quiet.
    expect(semProgresso(envioPreco({ updatedAt: AGORA - SEM_PROGRESSO_MS }), AGORA)).toBe(false);
    expect(semProgresso(envioPreco({ updatedAt: AGORA - SEM_PROGRESSO_MS + 1 }), AGORA)).toBe(
      false,
    );
  });

  it('never flags a parked run whose resume is still ahead, however old its checkpoint', () => {
    // A park PROMISES activity at `retomarEm`; a day-long park is not a wedge.
    const d = envioPreco({ updatedAt: AGORA - 24 * 3_600_000, retomarEm: AGORA + 60_000 });
    expect(semProgresso(d, AGORA)).toBe(false);
  });

  it('counts the silence from an overdue resume, not from the old checkpoint', () => {
    const retomarEm = AGORA - SEM_PROGRESSO_MS - 1;
    const d = envioPreco({ updatedAt: AGORA - 24 * 3_600_000, retomarEm });
    expect(ultimoSinalDeVida(d)).toBe(retomarEm);
    expect(semProgresso(d, AGORA)).toBe(true);
  });

  it('serves the import card too, and never flags a stopped job', () => {
    expect(
      semProgresso(
        { status: IMPORTACAO_SHOPEE_STATUS.running, updatedAt: 0 },
        SEM_PROGRESSO_MS + 1,
      ),
    ).toBe(true);
    expect(semProgresso({ status: IMPORTACAO_SHOPEE_STATUS.completed, updatedAt: 0 }, AGORA)).toBe(
      false,
    );
    expect(semProgresso(undefined, AGORA)).toBe(false);
  });
});

describe('janelaUpdateTimeEmSegundos', () => {
  it('⭐ D16 — two civil days in São Paulo, whole and inclusive, in SECONDS', () => {
    // 2026-10-01 00:00:00 in São Paulo is 03:00Z; 2026-10-02 23:59:59 is
    // 2026-10-03T02:59:59Z.
    expect(janelaUpdateTimeEmSegundos(['2026-10-01', '2026-10-02'])).toEqual([
      1790823600, 1790996399,
    ]);
  });

  it('NEAR MISS — is never UTC midnight, which `new Date("YYYY-MM-DD")` would give', () => {
    const janela = janelaUpdateTimeEmSegundos(['2026-10-01', '2026-10-02']);
    expect(janela?.[0]).not.toBe(Date.UTC(2026, 9, 1) / 1_000); // 1790812800
    // Seconds, not milliseconds — the wire's unit.
    expect(janela?.[0]).toBeLessThan(1e10);
    expect(janela?.[1]).toBe((janela?.[0] ?? 0) + 2 * 86_400 - 1);
  });

  it('a single-day window is that whole day', () => {
    const janela = janelaUpdateTimeEmSegundos(['2026-10-01', '2026-10-01']);
    expect(janela).toEqual([1790823600, 1790823600 + 86_399]);
  });

  it('needs both ends, each a real civil date', () => {
    expect(janelaUpdateTimeEmSegundos([null, null])).toBeNull();
    expect(janelaUpdateTimeEmSegundos(['2026-10-01', null])).toBeNull();
    expect(janelaUpdateTimeEmSegundos([null, '2026-10-02'])).toBeNull();
    expect(janelaUpdateTimeEmSegundos(['2026-02-30', '2026-10-02'])).toBeNull();
    expect(janelaUpdateTimeEmSegundos(['2026-10-01', '2026-10-02T10:00:00'])).toBeNull();
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
