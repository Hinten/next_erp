import { describe, expect, it } from 'vitest';

import {
  FUSO_FISCAL,
  competenciaAnterior,
  competenciaDe,
  formatCompetencia,
  inicioDaCompetencia,
  janelaDaCompetencia,
  janelaRbt12,
  parseCompetencia,
  proximaCompetencia,
} from './competencia';

const iso = (ms: number) => new Date(ms).toISOString();

describe('parse/format', () => {
  it('round-trips', () => {
    expect(parseCompetencia('2026-09')).toEqual({ ano: 2026, mes: 9 });
    expect(formatCompetencia(2026, 9)).toBe('2026-09');
  });

  it.each([['2026-13'], ['2026-00'], ['2026-9'], ['26-09'], [''], ['setembro']])(
    'rejects %s',
    (s) => expect(parseCompetencia(s)).toBeNull(),
  );
});

describe('arithmetic across the year boundary', () => {
  it('december rolls forward into january', () => {
    expect(proximaCompetencia('2026-12')).toBe('2027-01');
  });

  it('january rolls back into december', () => {
    expect(competenciaAnterior('2026-01')).toBe('2025-12');
  });

  it('twelve back is the same month one year earlier', () => {
    expect(competenciaAnterior('2026-09', 12)).toBe('2025-09');
  });

  it('n = 0 is identity', () => {
    expect(competenciaAnterior('2026-09', 0)).toBe('2026-09');
  });
});

// ── The timezone boundary ─────────────────────────────────────────────────
//
// This is the whole reason the module exists. São Paulo is UTC−3, so a fiscal
// month starts at 03:00 UTC — NOT at 00:00 UTC.
describe('inicioDaCompetencia — the fiscal month starts in São Paulo', () => {
  it('2026-09 starts at 03:00 UTC, not midnight UTC', () => {
    expect(iso(inicioDaCompetencia('2026-09')!)).toBe('2026-09-01T03:00:00.000Z');
  });

  it('a note at 23:30 on the last day of the month is still THAT month', () => {
    // 2026-02-28 23:30 São Paulo == 2026-03-01 02:30 UTC. A UTC cut would file
    // it under March; the fiscal cut keeps it in February.
    const emissao = Date.parse('2026-03-01T02:30:00.000Z');
    expect(competenciaDe(emissao)).toBe('2026-02');
    expect(emissao).toBeLessThan(inicioDaCompetencia('2026-03')!);
  });

  it('half an hour later it IS the next month', () => {
    const emissao = Date.parse('2026-03-01T03:30:00.000Z');
    expect(competenciaDe(emissao)).toBe('2026-03');
    expect(emissao).toBeGreaterThanOrEqual(inicioDaCompetencia('2026-03')!);
  });

  it('the boundary itself belongs to the NEW month (half-open)', () => {
    const inicio = inicioDaCompetencia('2026-03')!;
    expect(competenciaDe(inicio)).toBe('2026-03');
    expect(competenciaDe(inicio - 1)).toBe('2026-02');
  });

  it('handles a pre-2019 date, when Brazil still had DST', () => {
    // January 2018 was inside horário de verão (UTC−2), so this must NOT be
    // 03:00 UTC — assuming a fixed −3 would be wrong by an hour on the legacy
    // corpus, which does contain notes from then.
    const jan2018 = inicioDaCompetencia('2018-01')!;
    expect(iso(jan2018)).toBe('2018-01-01T02:00:00.000Z');
  });

  it('and a post-2019 date, when it was abolished', () => {
    expect(iso(inicioDaCompetencia('2020-01')!)).toBe('2020-01-01T03:00:00.000Z');
  });

  it('UTC as the zone gives midnight — proving the zone is honoured, not ignored', () => {
    expect(iso(inicioDaCompetencia('2026-09', 'UTC')!)).toBe('2026-09-01T00:00:00.000Z');
  });
});

// ── The RBT12 window ──────────────────────────────────────────────────────
describe('janelaRbt12 — the twelve months BEFORE, current month excluded', () => {
  it('for 2026-09 the window is 2025-09 .. 2026-09 (exclusive)', () => {
    const j = janelaRbt12('2026-09')!;
    expect(j.primeira).toBe('2025-09');
    expect(iso(j.inicioMs)).toBe('2025-09-01T03:00:00.000Z');
    expect(iso(j.fimMs)).toBe('2026-09-01T03:00:00.000Z');
  });

  it('EXCLUDES the apuração month itself', () => {
    // Including it would inflate RBT12 and can push the faixa up — LC 123
    // art. 18 §1º says "os doze meses ANTERIORES".
    const j = janelaRbt12('2026-09')!;
    const primeiroDeSetembro = inicioDaCompetencia('2026-09')!;
    expect(j.fimMs).toBe(primeiroDeSetembro);
    expect(primeiroDeSetembro).not.toBeLessThan(j.fimMs);
  });

  it('spans exactly twelve competências', () => {
    const j = janelaRbt12('2026-01')!;
    expect(j.primeira).toBe('2025-01');
    expect(iso(j.fimMs)).toBe('2026-01-01T03:00:00.000Z');
  });
});

describe('janelaDaCompetencia', () => {
  it('covers exactly the month, half-open', () => {
    const j = janelaDaCompetencia('2026-12')!;
    expect(iso(j.inicioMs)).toBe('2026-12-01T03:00:00.000Z');
    expect(iso(j.fimMs)).toBe('2027-01-01T03:00:00.000Z');
  });
});

describe('FUSO_FISCAL', () => {
  it('is São Paulo — the zone the apuração is defined in', () => {
    expect(FUSO_FISCAL).toBe('America/Sao_Paulo');
  });
});
