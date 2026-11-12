import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import * as modulo from './reconcileEstoqueLojaIntegrada';
import {
  COLECAO_RECONCILE_ESTOQUE_LI,
  FASE_RECONCILE_ESTOQUE_LI,
  ID_RECONCILE_ESTOQUE_LI,
  faseReconcileEstoqueLiSchema,
  reconcileEstoqueLojaIntegradaSchema,
} from './reconcileEstoqueLojaIntegrada';
import { ALL_DOMAINS } from './registry';

const AGORA_MS = 1_800_000_000_000;
const RUN = 'estoque-reconcile-20271115';

describe('reconcileEstoqueLojaIntegradaSchema (the daily run’s lease and chain)', () => {
  it('an empty document parses to the defaults: no run, a free lease', () => {
    expect(reconcileEstoqueLojaIntegradaSchema.parse({})).toEqual({
      execucaoId: null,
      iniciadoEmMs: null,
      emExecucaoAteMs: 0,
      seq: 0,
      fase: null,
      contas: [],
      idxConta: 0,
      walk: null,
      candidatos: [],
      proximoSlotMs: null,
      contadores: {},
    });
  });

  it('a run mid-way through the second conta round-trips', () => {
    const doc = {
      execucaoId: RUN,
      iniciadoEmMs: AGORA_MS,
      emExecucaoAteMs: AGORA_MS + 100_000,
      seq: 7,
      fase: FASE_RECONCILE_ESTOQUE_LI.li,
      contas: ['conta-a', 'conta-b'],
      idxConta: 1,
      walk: { ultimoDocPath: 'produtos/p9/produtolojaintegrada/123456789' },
      candidatos: [
        { c: 0, i: '123456789', p: 'p1', d: 3 },
        { c: 1, i: '7654321', p: 'p2', d: -2 },
      ],
      proximoSlotMs: AGORA_MS + 6_000,
      contadores: { linhasLi: 650 },
    };
    expect(reconcileEstoqueLojaIntegradaSchema.parse(doc)).toEqual(doc);
  });

  it('the phases are exactly erp → li → fila → fim: there is NO light mode', () => {
    expect(faseReconcileEstoqueLiSchema.options).toEqual(['erp', 'li', 'fila', 'fim']);
    const lido = reconcileEstoqueLojaIntegradaSchema.parse({
      modoPorConta: { 'conta-a': 'leve' },
      movidos: ['p1'],
      kitsPendentes: { blank: 1 },
    }) as Record<string, unknown>;
    expect(Object.hasOwn(lido, 'modoPorConta')).toBe(false);
    expect(Object.hasOwn(lido, 'movidos')).toBe(false);
    expect(Object.hasOwn(lido, 'kitsPendentes')).toBe(false);
  });

  it('⚠️ NEAR-MISS: a candidate of a conta outside the list, or a conta index past it, is refused', () => {
    const base = { execucaoId: RUN, contas: ['conta-a'] };
    expect(
      reconcileEstoqueLojaIntegradaSchema.safeParse({
        ...base,
        candidatos: [{ c: 0, i: '1', p: 'p1', d: 0 }],
      }).success,
    ).toBe(true);
    expect(
      reconcileEstoqueLojaIntegradaSchema.safeParse({
        ...base,
        candidatos: [{ c: 1, i: '1', p: 'p1', d: 0 }],
      }).success,
    ).toBe(false);
    // `idxConta` may sit ONE past the end: the li phase is done with every conta.
    expect(reconcileEstoqueLojaIntegradaSchema.safeParse({ ...base, idxConta: 1 }).success).toBe(
      true,
    );
    expect(reconcileEstoqueLojaIntegradaSchema.safeParse({ ...base, idxConta: 2 }).success).toBe(
      false,
    );
  });

  it('the walk cursor is a link document path — any depth, never a bare id or another collection', () => {
    const ok = (ultimoDocPath: string) =>
      reconcileEstoqueLojaIntegradaSchema.safeParse({ walk: { ultimoDocPath } }).success;
    expect(ok('produtos/p1/produtolojaintegrada/l1')).toBe(true);
    expect(ok('a/b/produtos/p1/produtolojaintegrada/l1')).toBe(true);
    expect(ok('l1')).toBe(false);
    expect(ok('produtos/p1/produtoshopee/l1')).toBe(false);
    expect(ok('produtos/p1/produtolojaintegrada/')).toBe(false);
    expect(ok('produtos//produtolojaintegrada/l1')).toBe(false);
  });

  it('a candidate is short: conta index, store id, produto, delta — the delta may be negative, never fractional', () => {
    const ok = (candidato: unknown) =>
      reconcileEstoqueLojaIntegradaSchema.safeParse({ contas: ['a'], candidatos: [candidato] })
        .success;
    expect(ok({ c: 0, i: '1', p: 'p1', d: -5 })).toBe(true);
    expect(ok({ c: 0, i: '01', p: 'p1', d: 0 })).toBe(false);
    expect(ok({ c: 0, i: '1', p: 'a/b', d: 0 })).toBe(false);
    expect(ok({ c: 0, i: '1', p: 'p1', d: 0.5 })).toBe(false);
    expect(ok({ c: 0, i: '1', p: 'p1' })).toBe(false);
  });

  it('is NOT registered in ALL_DOMAINS, and the module exports nothing combined { schema, meta }', () => {
    expect(ID_RECONCILE_ESTOQUE_LI).toBe('atual');
    expect(ALL_DOMAINS.map((d) => d.schema)).not.toContain(reconcileEstoqueLojaIntegradaSchema);
    expect(ALL_DOMAINS.map((d) => d.meta.collectionPath)).not.toContain(
      COLECAO_RECONCILE_ESTOQUE_LI,
    );
    for (const [nome, valor] of Object.entries(modulo)) {
      const temSchemaEMeta =
        typeof valor === 'object' && valor !== null && 'schema' in valor && 'meta' in valor;
      expect(temSchemaEMeta, nome).toBe(false);
      expect(Reflect.get(barrel, nome), nome).toBe(valor);
    }
  });
});
