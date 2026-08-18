import { describe, expect, it } from 'vitest';

import { PRODUTO_HISTORY_ROOT } from '../lib/historyRoots';
import { buildModificationEntry } from '../lib/modificationHistory';
import { extraDataHistorySource } from './onProdutoExtraDataChanged';
import { impostoHistorySource } from './onProdutoImpostoChanged';

describe('extraDataHistorySource', () => {
  it('has the fixed subcolecao/ignoreFields/requireParentExists', () => {
    expect(extraDataHistorySource.subcolecao).toBe('extraData');
    expect(extraDataHistorySource.ignoreFields).toEqual(['timestamp', 'ultimaModificacao']);
    expect(extraDataHistorySource.requireParentExists).toBe(true);
  });

  it('is bound to the produto root (entries land under the produto, not elsewhere)', () => {
    // The root is what `recordModification` writes through now that the factory
    // is parameterized — a source pointed at the wrong one would silently file
    // produto history under pedidos.
    expect(extraDataHistorySource.root).toBe(PRODUTO_HISTORY_ROOT);
    expect(extraDataHistorySource.root.parentIdParam).toBe('produtoId');
  });

  it('opts into NO field expansion, keeping produto entries shallow as before', () => {
    expect(extraDataHistorySource.expand).toBeUndefined();
  });

  it('resolve() maps {produtoId, docId} params to the owning produto path', () => {
    expect(extraDataHistorySource.resolve({ produtoId: 'p1', docId: 'singleton' })).toEqual({
      parentId: 'p1',
      docId: 'singleton',
      path: 'produtos/p1/extraData/singleton',
    });
  });

  it('drops timestamp/ultimaModificacao-only churn (no entry)', () => {
    const entry = buildModificationEntry({
      before: { descricao: 'A', timestamp: 1, ultimaModificacao: 1 },
      after: { descricao: 'A', timestamp: 2, ultimaModificacao: 2 },
      ignore: extraDataHistorySource.ignoreFields,
      path: 'produtos/p1/extraData/singleton',
      subcolecao: 'extraData',
      docId: 'singleton',
      eventId: 'evt1',
      eventTimeMicros: 1_000_000,
      usuarioOuterRef: null,
    });
    expect(entry).toBeNull();
  });

  it('still reports a real field change alongside the ignored stamps', () => {
    const entry = buildModificationEntry({
      before: { descricao: 'A', timestamp: 1, ultimaModificacao: 1 },
      after: { descricao: 'B', timestamp: 2, ultimaModificacao: 2 },
      ignore: extraDataHistorySource.ignoreFields,
      path: 'produtos/p1/extraData/singleton',
      subcolecao: 'extraData',
      docId: 'singleton',
      eventId: 'evt1',
      eventTimeMicros: 1_000_000,
      usuarioOuterRef: null,
    });
    expect(entry?.campos).toEqual(['descricao']);
  });
});

describe('impostoHistorySource', () => {
  it('has the fixed subcolecao/ignoreFields/requireParentExists', () => {
    expect(impostoHistorySource.subcolecao).toBe('imposto');
    expect(impostoHistorySource.ignoreFields).toEqual(['id', 'timestamp']);
    expect(impostoHistorySource.requireParentExists).toBe(true);
  });

  it('is bound to the produto root and opts into no expansion', () => {
    expect(impostoHistorySource.root).toBe(PRODUTO_HISTORY_ROOT);
    expect(impostoHistorySource.expand).toBeUndefined();
  });

  it('resolve() maps {produtoId, docId} params to the owning produto path', () => {
    expect(impostoHistorySource.resolve({ produtoId: 'p1', docId: 'op1' })).toEqual({
      parentId: 'p1',
      docId: 'op1',
      path: 'produtos/p1/imposto/op1',
    });
  });

  it('drops id/timestamp-only churn (no entry)', () => {
    const entry = buildModificationEntry({
      before: { id: 'op1', timestamp: 1, NCM: '12345678' },
      after: { id: 'op1', timestamp: 2, NCM: '12345678' },
      ignore: impostoHistorySource.ignoreFields,
      path: 'produtos/p1/imposto/op1',
      subcolecao: 'imposto',
      docId: 'op1',
      eventId: 'evt1',
      eventTimeMicros: 1_000_000,
      usuarioOuterRef: null,
    });
    expect(entry).toBeNull();
  });

  it('still reports a real field change alongside the ignored stamps', () => {
    const entry = buildModificationEntry({
      before: { id: 'op1', timestamp: 1, NCM: '12345678' },
      after: { id: 'op1', timestamp: 2, NCM: '87654321' },
      ignore: impostoHistorySource.ignoreFields,
      path: 'produtos/p1/imposto/op1',
      subcolecao: 'imposto',
      docId: 'op1',
      eventId: 'evt1',
      eventTimeMicros: 1_000_000,
      usuarioOuterRef: null,
    });
    expect(entry?.campos).toEqual(['NCM']);
  });
});
