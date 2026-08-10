import { describe, expect, it } from 'vitest';
import { chavesDoPath, planHistoricoV2 } from './transform';

const PATH = 'produtos/PROD-1/estoques/est-PROD-1-DEP-1/historicoEstoque/row-1';

describe('chavesDoPath', () => {
  it('recovers produto + depósito from the document path', () => {
    expect(chavesDoPath(PATH)).toEqual({ parentId: 'PROD-1', depositoId: 'DEP-1' });
  });

  it('keeps hyphens inside BOTH ids (a positional split would truncate them)', () => {
    // `est-<produtoId>-<depositoId>` with hyphens on both sides is the case a
    // naive `split('-')` gets wrong, and both ids may legally contain them.
    expect(chavesDoPath('produtos/a-b-c/estoques/est-a-b-c-d-e/historicoEstoque/x')).toEqual({
      parentId: 'a-b-c',
      depositoId: 'd-e',
    });
  });

  it('tolerates a leading segment before `produtos`', () => {
    expect(chavesDoPath('/produtos/P/estoques/est-P-D/historicoEstoque/x')).toEqual({
      parentId: 'P',
      depositoId: 'D',
    });
  });

  it('returns null when the estoque id does not carry the expected prefix', () => {
    // A hand-made or legacy estoque id — never guess a depósito out of it.
    expect(chavesDoPath('produtos/P/estoques/algum-outro-id/historicoEstoque/x')).toBeNull();
  });

  it('returns null on a truncated path or an empty depósito', () => {
    expect(chavesDoPath('produtos/P/estoques')).toBeNull();
    expect(chavesDoPath('produtos/P/estoques/est-P-/historicoEstoque/x')).toBeNull();
    expect(chavesDoPath('outra/coisa')).toBeNull();
  });
});

describe('planHistoricoV2 — movements', () => {
  it('renames a plain movement delta and derives the join keys', () => {
    const v = planHistoricoV2(
      {
        quantidade: -5,
        quantidadeReservada: -5,
        quantidadeDepois: 12,
        quantidadeReservadaDepois: 0,
        tipo: 'saida',
      },
      PATH,
    );
    expect(v).toEqual({
      kind: 'migrado',
      patch: {
        movimento: -5,
        movimentoReservada: -5,
        saldo: 12,
        saldoReservada: 0,
        parentId: 'PROD-1',
        depositoOuterRef: 'documents/depositos/DEP-1',
      },
    });
  });

  it('a legacy Flutter row (no audit block) still converts — the delta was always a delta', () => {
    const v = planHistoricoV2({ quantidade: 3, quantidadeReservada: 0, tipo: null }, PATH);
    expect(v).toMatchObject({
      kind: 'migrado',
      patch: { movimento: 3, movimentoReservada: 0, saldo: null, saldoReservada: null },
    });
  });

  it('a movimentação with NO readable quantidade is unknown, not a confident 0', () => {
    // Writing `movimento: 0` here would assert "this row moved nothing" about a
    // row that records nothing at all — a claim the sweep would then trust.
    const v = planHistoricoV2({ quantidade: 'x' }, PATH);
    expect(v.kind).toBe('movimento-desconhecido');
    if (v.kind !== 'movimento-desconhecido') throw new Error('unreachable');
    expect(v.patch).not.toHaveProperty('movimento');
    expect(v.motivo).toContain('sem quantidade');
  });

  it('a missing quantidadeReservada DOES mean 0 — the reservation did not move', () => {
    const v = planHistoricoV2({ quantidade: 4 }, PATH);
    expect(v).toMatchObject({ kind: 'migrado', patch: { movimento: 4, movimentoReservada: 0 } });
  });
});

describe('planHistoricoV2 — balanço (the case that cannot be assumed)', () => {
  it('derives the signed delta when the row recorded quantidadeAntes', () => {
    const v = planHistoricoV2(
      {
        ehBalanco: true,
        quantidade: 42, // the COUNTED value in v1, not a delta
        quantidadeAntes: 50,
        quantidadeReservada: 2,
        quantidadeReservadaAntes: 3,
      },
      PATH,
    );
    expect(v).toMatchObject({
      kind: 'migrado',
      patch: { movimento: -8, movimentoReservada: -1, saldo: 42, saldoReservada: 2 },
    });
  });

  it('recognizes a balanço by `tipo` as well as by `ehBalanco`', () => {
    const v = planHistoricoV2({ tipo: 'balanco', quantidade: 10, quantidadeAntes: 4 }, PATH);
    expect(v).toMatchObject({ kind: 'migrado', patch: { movimento: 6 } });
  });

  it('⚠️ NEVER invents a delta when quantidadeAntes is absent', () => {
    // The read-free manual path wrote balanços without before/after, so this is
    // the COMMON case. Writing `quantidade` into `movimento` would silently
    // corrupt every sum; an unknown fails OPEN instead.
    const v = planHistoricoV2({ ehBalanco: true, quantidade: 42, quantidadeReservada: 2 }, PATH);
    expect(v.kind).toBe('movimento-desconhecido');
    if (v.kind !== 'movimento-desconhecido') throw new Error('unreachable');
    expect(v.patch).toMatchObject({
      // The counted value IS the resulting saldo even without `quantidadeDepois`.
      saldo: 42,
      saldoReservada: 2,
    });
    // ⚠️ ABSENT, never `movimento: null` — the ML sweep detects an unreadable
    // row with `countIf(not(exists('movimento')))`, so an explicit null would
    // read as present and put the pair back in the silent-skip hole.
    expect(v.patch).not.toHaveProperty('movimento');
    expect(v.patch).not.toHaveProperty('movimentoReservada');
    expect(v.motivo).toContain('quantidadeAntes');
  });

  it('reports a balanço with no counted value at all', () => {
    const v = planHistoricoV2({ ehBalanco: true }, PATH);
    expect(v.kind).toBe('movimento-desconhecido');
    if (v.kind !== 'movimento-desconhecido') throw new Error('unreachable');
    expect(v.motivo).toContain('sem quantidade');
  });

  it('prefers a recorded quantidadeDepois over the counted value for saldo', () => {
    const v = planHistoricoV2(
      { ehBalanco: true, quantidade: 42, quantidadeAntes: 40, quantidadeDepois: 41 },
      PATH,
    );
    expect(v).toMatchObject({ kind: 'migrado', patch: { saldo: 41, movimento: 2 } });
  });
});

describe('planHistoricoV2 — idempotence and junk', () => {
  it('a row already carrying a numeric movimento is left alone', () => {
    expect(planHistoricoV2({ movimento: -5, saldo: 3 }, PATH)).toEqual({ kind: 'ja-migrado' });
    expect(planHistoricoV2({ movimento: 0 }, PATH)).toEqual({ kind: 'ja-migrado' });
  });

  it('a NULL movimento is not treated as converted (an unrecoverable balanço re-reports)', () => {
    // Otherwise a second pass would silently hide how many rows never got a
    // delta — the number the operator most needs after the run.
    expect(planHistoricoV2({ movimento: null, ehBalanco: true, quantidade: 5 }, PATH).kind).toBe(
      'movimento-desconhecido',
    );
  });

  it('reports a non-object row instead of throwing', () => {
    for (const junk of [null, undefined, 42, 'x', []]) {
      expect(planHistoricoV2(junk, PATH)).toEqual({ kind: 'sem-dados' });
    }
  });

  it('reports a row whose path yields no keys', () => {
    expect(planHistoricoV2({ quantidade: 1 }, 'produtos/P/estoques/xx/historicoEstoque/y')).toEqual(
      { kind: 'sem-dados' },
    );
  });
});
