import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import {
  FASE_RECONCILE_ESTOQUE_LI,
  FASE_RECONCILE_PRECO_LI,
  ID_RECONCILE_ESTOQUE_LI,
  ID_SLOT_PRECO_RECONCILE_LI,
  ORDEM_FASES_RECONCILE_LI,
  faseDoRunReconcileLi,
  faseReconcileEstoqueLiSchema,
  faseReconcilePrecoLiSchema,
  precoSolicitadoReconcileLiSchema,
  reconcileEstoqueLojaIntegradaBaseSchema,
  reconcileEstoqueLojaIntegradaSchema,
} from './reconcileEstoqueLojaIntegrada';
import {
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  tarefaReconcileEstoqueLiSchema,
} from './tarefaEstoqueLojaIntegrada';

/**
 * The step-13 amendment of the daily reconcile's run document and of its reads-queue slice: the
 * price arm's phases, the "Atualizar preços" request and the price slot. ADDITIVE ONLY — the
 * shipped stock suites (`reconcileEstoqueLojaIntegrada.test.ts`, `tarefaEstoqueLojaIntegrada.test.ts`)
 * run unedited beside this file, and the documents and tasks an older build wrote parse exactly as
 * they did.
 */

const AGORA_MS = 1_800_000_000_000;
const RUN = 'estoque-reconcile-20271115';

/** A run document as the stock build writes it today, mid-way through its queue phase. */
const RUN_DO_ESTOQUE = {
  execucaoId: RUN,
  iniciadoEmMs: AGORA_MS,
  emExecucaoAteMs: AGORA_MS + 100_000,
  seq: 9,
  fase: FASE_RECONCILE_ESTOQUE_LI.fila,
  contas: ['conta-a', 'conta-b'],
  idxConta: 0,
  walk: { ultimoDocPath: 'produtos/p9/produtolojaintegrada/123456789', concluida: true },
  candidatos: [{ c: 0, i: '123456789', p: 'p1', d: 3 }],
  proximoSlotMs: AGORA_MS + 17_000,
  contadores: { linhasLi: 650 },
};

const TAREFA = { tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI, execucaoId: RUN, seq: 0 } as const;

describe('the run document, step 13 (additive)', () => {
  it('a stock document parses EXACTLY as before: no price field is defaulted into it', () => {
    const lido = reconcileEstoqueLojaIntegradaSchema.parse(RUN_DO_ESTOQUE) as Record<
      string,
      unknown
    >;
    expect(lido).toEqual(RUN_DO_ESTOQUE);
    expect(Object.hasOwn(lido, 'fasePreco')).toBe(false);
    expect(Object.hasOwn(lido, 'precoSolicitado')).toBe(false);
    const vazio = reconcileEstoqueLojaIntegradaSchema.parse({}) as Record<string, unknown>;
    expect(Object.keys(vazio).sort()).toEqual(
      [
        'candidatos',
        'contadores',
        'contas',
        'emExecucaoAteMs',
        'execucaoId',
        'fase',
        'idxConta',
        'iniciadoEmMs',
        'proximoSlotMs',
        'seq',
        'walk',
      ].sort(),
    );
  });

  it('the stock phases stay exactly four; the price phases are their own three', () => {
    expect(faseReconcileEstoqueLiSchema.options).toEqual(['erp', 'li', 'fila', 'fim']);
    expect(faseReconcilePrecoLiSchema.options).toEqual(['pais-preco', 'li-preco', 'fila-preco']);
    expect(Object.values(FASE_RECONCILE_PRECO_LI)).toEqual(faseReconcilePrecoLiSchema.options);
    // NEAR-MISS: a price phase is never a member of `fase`, nor a stock phase of `fasePreco`.
    for (const fase of faseReconcilePrecoLiSchema.options) {
      expect(reconcileEstoqueLojaIntegradaSchema.safeParse({ fase }).success, fase).toBe(false);
    }
    for (const fasePreco of ['fila', 'fim', 'preco', 'li_preco']) {
      expect(
        reconcileEstoqueLojaIntegradaSchema.safeParse({ fase: 'fila', fasePreco }).success,
        fasePreco,
      ).toBe(false);
    }
  });

  it('the order: erp → li → fila → pais-preco → li-preco → fila-preco → fim', () => {
    expect(ORDEM_FASES_RECONCILE_LI).toEqual([
      'erp',
      'li',
      'fila',
      'pais-preco',
      'li-preco',
      'fila-preco',
      'fim',
    ]);
  });

  it('a price phase round-trips while `fase` is `fila`, and the run reads as that phase', () => {
    for (const fasePreco of faseReconcilePrecoLiSchema.options) {
      const doc = { ...RUN_DO_ESTOQUE, candidatos: [], fasePreco };
      expect(reconcileEstoqueLojaIntegradaSchema.parse(doc)).toEqual(doc);
      expect(faseDoRunReconcileLi(doc)).toBe(fasePreco);
    }
    expect(faseDoRunReconcileLi(RUN_DO_ESTOQUE)).toBe('fila');
    expect(faseDoRunReconcileLi({ ...RUN_DO_ESTOQUE, fasePreco: null })).toBe('fila');
    expect(faseDoRunReconcileLi({ fase: null })).toBeNull();
  });

  it('⚠️ NEAR-MISS: a price phase beside any other stock phase is refused by the invariants', () => {
    for (const fase of ['erp', 'li', 'fim'] as const) {
      const doc = { ...RUN_DO_ESTOQUE, fase, fasePreco: FASE_RECONCILE_PRECO_LI.liPreco };
      expect(reconcileEstoqueLojaIntegradaSchema.safeParse(doc).success, fase).toBe(false);
      // The handle's SHAPE accepts it (a patch is checked field by field); the full read refuses.
      expect(reconcileEstoqueLojaIntegradaBaseSchema.safeParse(doc).success, fase).toBe(true);
      // And the stored `fase` wins for anyone reading the two as one.
      expect(faseDoRunReconcileLi(doc), fase).toBe(fase);
    }
    expect(
      reconcileEstoqueLojaIntegradaSchema.safeParse({
        ...RUN_DO_ESTOQUE,
        fase: 'fim',
        fasePreco: null,
      }).success,
    ).toBe(true);
  });

  it('the "Atualizar preços" request rides the run: a conta and a flag, never a price', () => {
    const precoSolicitado = { contaId: 'conta-b', permitirBaixar: true };
    const doc = { ...RUN_DO_ESTOQUE, precoSolicitado };
    expect(reconcileEstoqueLojaIntegradaSchema.parse(doc)).toEqual(doc);
    expect(reconcileEstoqueLojaIntegradaSchema.parse({ ...doc, precoSolicitado: null })).toEqual({
      ...doc,
      precoSolicitado: null,
    });
    // Unknown keys are STRIPPED on the document (its read never fails over a newer field).
    expect(precoSolicitadoReconcileLiSchema.parse({ ...precoSolicitado, cheio: 50 })).toEqual(
      precoSolicitado,
    );
    for (const ruim of [
      { contaId: 'conta-b' },
      { permitirBaixar: true },
      { contaId: 'a/b', permitirBaixar: true },
      { contaId: 'conta-b', permitirBaixar: 'true' },
    ]) {
      expect(
        reconcileEstoqueLojaIntegradaSchema.safeParse({ ...RUN_DO_ESTOQUE, precoSolicitado: ruim })
          .success,
        JSON.stringify(ruim),
      ).toBe(false);
    }
  });
});

describe('the price slot document', () => {
  it('sits beside the run document and holds only its slot: every other field reads "no run"', () => {
    expect(ID_SLOT_PRECO_RECONCILE_LI).toBe('slot-preco');
    expect(ID_SLOT_PRECO_RECONCILE_LI).not.toBe(ID_RECONCILE_ESTOQUE_LI);
    const lido = reconcileEstoqueLojaIntegradaSchema.parse({ proximoSlotMs: AGORA_MS + 8_000 });
    expect(lido).toMatchObject({
      proximoSlotMs: AGORA_MS + 8_000,
      execucaoId: null,
      emExecucaoAteMs: 0,
      fase: null,
      contas: [],
      candidatos: [],
    });
    expect(faseDoRunReconcileLi(lido)).toBeNull();
  });
});

describe('the reconcile slice task, step 13 (additive)', () => {
  it('every task enqueued before it still parses, unchanged', () => {
    expect(tarefaReconcileEstoqueLiSchema.parse(TAREFA)).toEqual(TAREFA);
    expect(tarefaReconcileEstoqueLiSchema.parse({ ...TAREFA, seq: 7 })).toEqual({
      ...TAREFA,
      seq: 7,
    });
  });

  it('carries "Atualizar preços": a conta and a flag, absent or null on every other task', () => {
    const comPedido = { ...TAREFA, precoSolicitado: { contaId: 'conta-b', permitirBaixar: false } };
    expect(tarefaReconcileEstoqueLiSchema.parse(comPedido)).toEqual(comPedido);
    expect(tarefaReconcileEstoqueLiSchema.parse({ ...TAREFA, precoSolicitado: null })).toEqual({
      ...TAREFA,
      precoSolicitado: null,
    });
  });

  it('⚠️ STRICT inside too: a price, a custo or any extra key in the request is REFUSED, never stripped', () => {
    for (const precoSolicitado of [
      { contaId: 'conta-b', permitirBaixar: true, cheio: 50 },
      { contaId: 'conta-b', permitirBaixar: true, custo: 12.5 },
      { contaId: 'conta-b', permitirBaixar: true, promocional: 39.99 },
      { contaId: 'conta-b', permitirBaixar: true, tabelaNormalId: 't1' },
      { contaId: 'conta-b' },
      { permitirBaixar: true },
      { contaId: 'conta-b', permitirBaixar: 1 },
      'conta-b',
    ]) {
      expect(
        tarefaReconcileEstoqueLiSchema.safeParse({ ...TAREFA, precoSolicitado }).success,
        JSON.stringify(precoSolicitado),
      ).toBe(false);
    }
    // NEAR-MISS: the request beside the slice, flattened, is an extra key of the slice.
    expect(
      tarefaReconcileEstoqueLiSchema.safeParse({
        ...TAREFA,
        contaId: 'conta-b',
        permitirBaixar: true,
      }).success,
    ).toBe(false);
  });

  it('the barrel re-exports the amendment', () => {
    expect(barrel.faseReconcilePrecoLiSchema).toBe(faseReconcilePrecoLiSchema);
    expect(barrel.faseDoRunReconcileLi).toBe(faseDoRunReconcileLi);
    expect(barrel.ID_SLOT_PRECO_RECONCILE_LI).toBe(ID_SLOT_PRECO_RECONCILE_LI);
    expect(barrel.precoSolicitadoReconcileLiSchema).toBe(precoSolicitadoReconcileLiSchema);
  });
});
