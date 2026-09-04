import { describe, expect, it } from 'vitest';
import type { ImpostoProduto } from '@delfrance/schemas';
import { emptyImposto, montarLinhasImposto, operacoesAtivas } from './impostoRows';

/**
 * These rows are built from TWO call sites — the Impostos tab's seeding effect
 * and the Modificações tab's revert staging — and the second only exists
 * because the first does not run until the operator opens that tab. A shape
 * mismatch between them is silent: `ImpostoManager` skips its own seed once the
 * value is non-null, so a row the revert forgot would render blank and be
 * written back empty on save.
 */

function operacaoDoc(
  id: string,
  over: Partial<{ nome: string; ativo: boolean; padrao: boolean }> = {},
) {
  return { id, data: { nome: id.toUpperCase(), ...over } };
}

function impostoDoc(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    data: {
      impostoOpercaoOuterRef: `operacao/${id}`,
      origem: '0',
      ...over,
    } as unknown as ImpostoProduto,
  };
}

describe('operacoesAtivas', () => {
  it('keeps the query order and drops only the explicitly inactive', () => {
    expect(
      operacoesAtivas([
        operacaoDoc('a'),
        operacaoDoc('b', { ativo: false }),
        operacaoDoc('c', { ativo: true, padrao: true }),
      ]),
    ).toEqual([
      { id: 'a', nome: 'A', padrao: false },
      { id: 'c', nome: 'C', padrao: true },
    ]);
  });
});

describe('montarLinhasImposto', () => {
  const operacoes = operacoesAtivas([operacaoDoc('op1'), operacaoDoc('op2')]);

  it('emits one row per active operação, in operação order', () => {
    const rows = montarLinhasImposto(operacoes, []);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.impostoOpercaoOuterRef)).toEqual(['operacao/op1', 'operacao/op2']);
  });

  it('merges a saved doc over the blank entry and stamps its id', () => {
    const rows = montarLinhasImposto(operacoes, [impostoDoc('op2', { origem: '3' })]);
    expect(rows[1]).toMatchObject({
      id: 'op2',
      origem: '3',
      impostoOpercaoOuterRef: 'operacao/op2',
    });
    // The operação with no saved doc still gets a row — the tab renders it.
    expect(rows[0]).toEqual(emptyImposto('op1'));
  });

  it('skips a null-scoped imposto so the save leaves that doc untouched', () => {
    // A default-fallback imposto is not a per-operação entry; pulling it into
    // the form would rewrite its scope to a fake `operacao/<docId>` on save.
    const rows = montarLinhasImposto(operacoes, [
      { id: 'fallback', data: { impostoOpercaoOuterRef: null, origem: '9' } as ImpostoProduto },
    ]);
    expect(rows).toEqual([emptyImposto('op1'), emptyImposto('op2')]);
  });

  it('ignores a saved doc whose operação is no longer active', () => {
    const rows = montarLinhasImposto(operacoes, [impostoDoc('op-removida', { origem: '5' })]);
    expect(rows.map((r) => r.impostoOpercaoOuterRef)).toEqual(['operacao/op1', 'operacao/op2']);
  });
});
