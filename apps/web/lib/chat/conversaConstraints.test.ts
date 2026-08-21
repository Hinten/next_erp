import { describe, expect, it } from 'vitest';
import {
  CONVERSA_PAGE_SIZE,
  DEFAULT_ORDEM,
  conversaConstraintSpecs,
  type ConversaOrdem,
} from './conversaConstraints';

describe('conversaConstraintSpecs — tab base filters', () => {
  it('Atendimento: array-contains(usuarios, uid) + estadoConversa == 1, default ultima_modificacao desc', () => {
    expect(
      conversaConstraintSpecs({ tab: 'atendimento', ordem: DEFAULT_ORDEM.atendimento, uid: 'op1' }),
    ).toEqual([
      { kind: 'where', op: 'array-contains', field: 'usuarios', value: 'op1' },
      { kind: 'where', op: '==', field: 'estadoConversa', value: 1 },
      { kind: 'orderBy', field: 'ultima_modificacao', direction: 'desc' },
      { kind: 'limit', value: CONVERSA_PAGE_SIZE },
    ]);
  });

  it('Pendentes: estadoConversa == 0, default prazo_resposta asc', () => {
    expect(conversaConstraintSpecs({ tab: 'pendentes', ordem: DEFAULT_ORDEM.pendentes })).toEqual([
      { kind: 'where', op: '==', field: 'estadoConversa', value: 0 },
      { kind: 'orderBy', field: 'prazo_resposta', direction: 'asc' },
      { kind: 'limit', value: CONVERSA_PAGE_SIZE },
    ]);
  });

  it('Todas: no estado filter, default ultima_modificacao desc', () => {
    expect(conversaConstraintSpecs({ tab: 'todas', ordem: DEFAULT_ORDEM.todas })).toEqual([
      { kind: 'orderBy', field: 'ultima_modificacao', direction: 'desc' },
      { kind: 'limit', value: CONVERSA_PAGE_SIZE },
    ]);
  });

  it('falls back to "" for the Atendimento membership when uid is absent', () => {
    const specs = conversaConstraintSpecs({ tab: 'atendimento', ordem: 'ultima' });
    expect(specs[0]).toEqual({ kind: 'where', op: 'array-contains', field: 'usuarios', value: '' });
  });
});

describe('conversaConstraintSpecs — orderings', () => {
  const cases: Array<[ConversaOrdem, string, 'asc' | 'desc']> = [
    ['ultima', 'ultima_modificacao', 'desc'],
    ['prazo_asc', 'prazo_resposta', 'asc'],
    ['prazo_desc', 'prazo_resposta', 'desc'],
    ['cadastro_asc', 'data_cadastro', 'asc'],
    ['cadastro_desc', 'data_cadastro', 'desc'],
  ];
  it.each(cases)('ordem %s → orderBy %s %s', (ordem, field, direction) => {
    const specs = conversaConstraintSpecs({ tab: 'todas', ordem });
    expect(specs).toContainEqual({ kind: 'orderBy', field, direction });
  });
});

describe('conversaConstraintSpecs — composable filters', () => {
  it('maps integracaoId to the documents/integracao/<id> outer ref', () => {
    const specs = conversaConstraintSpecs({ tab: 'todas', ordem: 'ultima', integracaoId: 'int7' });
    expect(specs).toContainEqual({
      kind: 'where',
      op: '==',
      field: 'integracaoOuterRef',
      value: 'documents/integracao/int7',
    });
  });

  it('adds cor_etiqueta and clienteOuterRef filters, and honours a custom limit', () => {
    const specs = conversaConstraintSpecs({
      tab: 'todas',
      ordem: 'ultima',
      etiqueta: 0xfff44336,
      clienteOuterRef: 'documents/clientes/c1',
      limit: 50,
    });
    expect(specs).toContainEqual({
      kind: 'where',
      op: '==',
      field: 'cor_etiqueta',
      value: 0xfff44336,
    });
    expect(specs).toContainEqual({
      kind: 'where',
      op: '==',
      field: 'clienteOuterRef',
      value: 'documents/clientes/c1',
    });
    expect(specs.at(-1)).toEqual({ kind: 'limit', value: 50 });
  });

  it('omits filters that are null/absent', () => {
    const specs = conversaConstraintSpecs({
      tab: 'todas',
      ordem: 'ultima',
      integracaoId: null,
      etiqueta: null,
      clienteOuterRef: null,
    });
    // Only orderBy + limit — no where clauses.
    expect(specs.filter((s) => s.kind === 'where')).toHaveLength(0);
  });
});
