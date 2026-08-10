import { describe, expect, it } from 'vitest';
import { auditarReservaNegativa, type HistoricoResumo } from './predicate';

const PATH = 'produtos/P1/estoques/est-P1-dep1';

function estoque(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parentId: 'P1',
    depositoOuterRef: 'documents/depositos/dep1',
    quantidade: 8,
    quantidadeReservada: -2,
    ultimaModificacao: 1_700_000_000_000,
    ...over,
  };
}

/** A v2 row: the `movimentoReservada` key is PRESENT. */
function v2(
  movimentoReservada: number | null,
  over: Partial<HistoricoResumo> = {},
): HistoricoResumo {
  return {
    movimentoReservada,
    saldoReservada: null,
    timestamp: 1_700_000_000_000,
    tipo: 'saida',
    motivo: null,
    ...over,
  };
}

/** A v1 (Flutter) row: the key is ABSENT, which is how "unknown" is encoded. */
function v1(over: Partial<HistoricoResumo> = {}): HistoricoResumo {
  return {
    movimentoReservada: undefined,
    saldoReservada: undefined,
    timestamp: 1_699_000_000_000,
    tipo: null,
    motivo: 'ajuste',
    ...over,
  };
}

describe('auditarReservaNegativa — what is NOT a hit', () => {
  it('ignores a non-negative reservation', () => {
    expect(auditarReservaNegativa(PATH, estoque({ quantidadeReservada: 0 }), [])).toBeNull();
    expect(auditarReservaNegativa(PATH, estoque({ quantidadeReservada: 3 }), [])).toBeNull();
  });

  it('ignores a missing or non-numeric counter', () => {
    // ⚠️ Deliberate: it reads as 0 everywhere, so it cannot invent stock. The
    // kit-sold stamp (ADR 0014 §2) writes no counters at all, so flagging this
    // would bury every real hit.
    expect(
      auditarReservaNegativa(PATH, estoque({ quantidadeReservada: undefined }), []),
    ).toBeNull();
    expect(auditarReservaNegativa(PATH, estoque({ quantidadeReservada: null }), [])).toBeNull();
    expect(auditarReservaNegativa(PATH, estoque({ quantidadeReservada: 'x' }), [])).toBeNull();
    expect(
      auditarReservaNegativa(PATH, estoque({ quantidadeReservada: Number.NaN }), []),
    ).toBeNull();
  });
});

describe('auditarReservaNegativa — the four kinds', () => {
  it('sem-historico: the counter moved and nothing was appended', () => {
    const row = auditarReservaNegativa(PATH, estoque(), []);
    expect(row?.kind).toBe('sem-historico');
    expect(row?.somaMovimentoReservada).toBeNull();
    expect(row?.nLinhas).toBe(0);
  });

  it('historico-v1: an ABSENT movimentoReservada key makes the ledger unsummable', () => {
    const row = auditarReservaNegativa(PATH, estoque(), [v2(-1), v1()]);
    expect(row?.kind).toBe('historico-v1');
    expect(row?.nSemMovimentoReservada).toBe(1);
    // No honest total exists, so none is reported — a partial sum would read as
    // a reconciliation and mislabel the row.
    expect(row?.somaMovimentoReservada).toBeNull();
  });

  it('historico-v2: every row is v2 and the sum reconciles with the counter', () => {
    const row = auditarReservaNegativa(PATH, estoque({ quantidadeReservada: -2 }), [v2(3), v2(-5)]);
    expect(row?.kind).toBe('historico-v2');
    expect(row?.somaMovimentoReservada).toBe(-2);
  });

  it('desvio-ledger: v2 rows whose sum disagrees with the stored counter', () => {
    // Σ = -1 but the doc holds -2: a writer moved the counter without appending.
    const row = auditarReservaNegativa(PATH, estoque({ quantidadeReservada: -2 }), [v2(-1)]);
    expect(row?.kind).toBe('desvio-ledger');
    expect(row?.somaMovimentoReservada).toBe(-1);
  });

  it('an explicit null movimentoReservada counts as 0, not as unknown', () => {
    // `null` is a v2 writer with nothing to record; only an ABSENT key is the v1
    // "unknown" the ledger design encodes (ADR 0014 §4).
    const row = auditarReservaNegativa(PATH, estoque({ quantidadeReservada: -2 }), [
      v2(-2),
      v2(null),
    ]);
    expect(row?.kind).toBe('historico-v2');
    expect(row?.nSemMovimentoReservada).toBe(0);
    expect(row?.somaMovimentoReservada).toBe(-2);
  });

  it('tolerates float drift when reconciling a summed ledger', () => {
    const row = auditarReservaNegativa(PATH, estoque({ quantidadeReservada: -0.3 }), [
      v2(-0.1),
      v2(-0.2),
    ]);
    expect(row?.kind).toBe('historico-v2');
  });
});

describe('auditarReservaNegativa — the blast-radius numbers', () => {
  it('reports how many units the row would invent without the floor', () => {
    const row = auditarReservaNegativa(
      PATH,
      estoque({ quantidade: 8, quantidadeReservada: -2 }),
      [],
    );
    // Unfloored: 8 − (−2) = 10. Floored: 8 − max(0, −2) = 8. Two invented units.
    expect(row?.disponivelIngenuo).toBe(10);
    expect(row?.disponivelFloored).toBe(8);
    expect(row?.unidadesInventadas).toBe(2);
  });

  it('carries the join keys so a hit can be traced back to produto + depósito', () => {
    const row = auditarReservaNegativa(PATH, estoque(), []);
    expect(row?.parentId).toBe('P1');
    expect(row?.depositoOuterRef).toBe('documents/depositos/dep1');
    expect(row?.estoquePath).toBe(PATH);
  });

  it('coalesces a missing quantidade to 0 rather than dropping the hit', () => {
    // ADR 0014 §2 writes exactly this shape (stamp only, no counters), so a
    // negative reservation can genuinely appear on a doc with no `quantidade`.
    const row = auditarReservaNegativa(
      PATH,
      { quantidadeReservada: -2, depositoOuterRef: 'documents/depositos/dep1' },
      [],
    );
    expect(row?.quantidade).toBe(0);
    expect(row?.unidadesInventadas).toBe(2);
  });
});

describe('auditarReservaNegativa — the forensic payload', () => {
  it('returns the newest rows first', () => {
    const row = auditarReservaNegativa(PATH, estoque(), [
      v2(-1, { timestamp: 100, motivo: 'antiga' }),
      v2(-1, { timestamp: 300, motivo: 'nova' }),
      v2(0, { timestamp: 200, motivo: 'meio' }),
    ]);
    expect(row?.ultimasLinhas.map((h) => h.motivo)).toEqual(['nova', 'meio', 'antiga']);
  });

  it('sorts a row with no timestamp LAST instead of dropping it', () => {
    // A v1 row is exactly the kind most likely to lack one, and it is still
    // evidence.
    const row = auditarReservaNegativa(PATH, estoque(), [
      v1({ timestamp: undefined, motivo: 'sem-data' }),
      v2(-2, { timestamp: 100, motivo: 'com-data' }),
    ]);
    expect(row?.ultimasLinhas.map((h) => h.motivo)).toEqual(['com-data', 'sem-data']);
  });

  it('caps the payload at 10 rows but still counts them all', () => {
    const muitas = Array.from({ length: 25 }, (_, i) => v2(-1, { timestamp: i }));
    const row = auditarReservaNegativa(PATH, estoque(), muitas);
    expect(row?.nLinhas).toBe(25);
    expect(row?.ultimasLinhas).toHaveLength(10);
    expect(row?.ultimasLinhas[0]?.timestamp).toBe(24);
  });
});
