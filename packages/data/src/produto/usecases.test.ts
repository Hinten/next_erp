import { describe, expect, it } from 'vitest';
import { estoqueProdutoSchema, produtoExtraDataSchema } from '@delfrance/schemas';
import type { ProdutoDataPort, ProdutoSnapshot, ProdutoWriteOp } from './port';
import {
  ProdutoReferencedError,
  applyPrecosChange,
  buildEstoqueWriteOps,
  buildExtraDataWriteOps,
  buildPrecoHistoryOps,
  deleteProdutoCascade,
  findProdutoReferences,
  propagatePrecosToChildren,
  recordPrecoHistory,
  saveProdutoEstoques,
  saveProdutoExtraData,
} from './usecases';

interface MemoryOpts {
  children?: ProdutoSnapshot[];
  /** Per-produto-id inbound references. */
  refs?: Record<string, { kits?: ProdutoSnapshot[]; subcols?: string[] }>;
}

function memoryPort(opts: MemoryOpts = {}) {
  const committed: ProdutoWriteOp[][] = [];
  let n = 0;
  const port: ProdutoDataPort = {
    newId: () => `id${++n}`,
    now: () => 1000,
    getChildren: async () => opts.children ?? [],
    getKitReferences: async (id) => opts.refs?.[id]?.kits ?? [],
    subcollectionHasDocs: async (id, name) => (opts.refs?.[id]?.subcols ?? []).includes(name),
    commit: async (ops) => {
      committed.push(ops);
    },
  };
  return { port, committed };
}

const snap = (id: string, precos: ProdutoSnapshot['precos'], nome = id): ProdutoSnapshot => ({
  id,
  nome,
  precos,
});

describe('preco/custo history ops', () => {
  it('buildPrecoHistoryOps emits the Flutter wire shape', () => {
    const { port } = memoryPort();
    const ops = buildPrecoHistoryOps(port, 'p1', [
      { listaId: 'L1', valorOriginal: null, valorFinal: 10 },
    ]);
    expect(ops).toEqual([
      {
        type: 'set',
        path: 'produtos/p1/historicoDePrecos/id1',
        data: {
          listaDePrecoHistoricoOuterRef: 'documents/listaDePrecos/L1',
          valorOriginal: null,
          valorFinal: 10,
          timestamp: 1000,
        },
      },
    ]);
  });

  it('recordPrecoHistory is a no-op for an empty change set', async () => {
    const { port, committed } = memoryPort();
    await recordPrecoHistory(port, 'p1', []);
    expect(committed).toEqual([]);
  });
});

describe('produto extra data (Descrição + Google Merchant singleton)', () => {
  it('buildExtraDataWriteOps targets the fixed singleton path and fills wire defaults', () => {
    const ops = buildExtraDataWriteOps('p1', produtoExtraDataSchema.parse({ descricao: 'Olá' }));
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.type).toBe('set');
    expect(op.path).toBe('produtos/p1/extraData/singleton');
    if (op.type !== 'set') throw new Error('expected a set op');
    // The use-case parses, so the persisted doc carries the wire defaults
    // (condicao=1=novo, coteudoAdulto=false) alongside the edited field.
    expect(op.data).toMatchObject({ descricao: 'Olá', condicao: 1, coteudoAdulto: false });
  });

  it('saveProdutoExtraData commits exactly one set op at the singleton path', async () => {
    const { port, committed } = memoryPort();
    await saveProdutoExtraData(port, 'p9', produtoExtraDataSchema.parse({ marca: 'Acme' }));
    expect(committed).toHaveLength(1);
    expect(committed[0]).toHaveLength(1);
    expect(committed[0]![0]).toMatchObject({
      type: 'set',
      path: 'produtos/p9/extraData/singleton',
    });
  });
});

describe('produto estoque (per-depósito stock)', () => {
  const entry = (over: Record<string, unknown> = {}) =>
    estoqueProdutoSchema.parse({ depositoOuterRef: 'documents/depositos/d1', ...over });

  it('buildEstoqueWriteOps targets est-<produto>-<deposito> and stamps parent/dates', () => {
    const ops = buildEstoqueWriteOps(
      'p1',
      [entry({ localizacao: 'A1', quantidade: 3, quantidadeReservada: 1 })],
      1000,
    );
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op).toMatchObject({ type: 'set', path: 'produtos/p1/estoques/est-p1-d1' });
    if (op.type !== 'set') throw new Error('expected a set op');
    // quantidade/reservada are movement-owned — round-tripped, not zeroed.
    expect(op.data).toMatchObject({
      parentId: 'p1',
      depositoOuterRef: 'documents/depositos/d1',
      localizacao: 'A1',
      quantidade: 3,
      quantidadeReservada: 1,
      dataCriacao: 1000,
      ultimaModificacao: 1000,
    });
  });

  it('preserves an existing dataCriacao and only bumps ultimaModificacao', () => {
    const ops = buildEstoqueWriteOps('p1', [entry({ localizacao: 'B2', dataCriacao: 5 })], 1000);
    const op = ops[0]!;
    if (op.type !== 'set') throw new Error('expected a set op');
    expect(op.data).toMatchObject({ dataCriacao: 5, ultimaModificacao: 1000 });
  });

  it('reads the deposito id from a bare depositos/<id> ref too', () => {
    const ops = buildEstoqueWriteOps(
      'p2',
      [entry({ depositoOuterRef: 'depositos/dX', localizacao: 'C3' })],
      1000,
    );
    expect(ops[0]!.path).toBe('produtos/p2/estoques/est-p2-dX');
  });

  it('skips a pristine empty row (no localização / quantity / creation date)', () => {
    expect(buildEstoqueWriteOps('p1', [entry({})], 1000)).toEqual([]);
  });

  it('saveProdutoEstoques is a no-op when nothing carries info', async () => {
    const { port, committed } = memoryPort();
    await saveProdutoEstoques(port, 'p1', [entry({})]);
    expect(committed).toEqual([]);
  });

  it('saveProdutoEstoques commits the informative rows', async () => {
    const { port, committed } = memoryPort();
    await saveProdutoEstoques(port, 'p1', [entry({ localizacao: 'A1' })]);
    expect(committed).toHaveLength(1);
    expect(committed[0]![0]).toMatchObject({
      type: 'set',
      path: 'produtos/p1/estoques/est-p1-d1',
    });
  });
});

describe('propagatePrecosToChildren', () => {
  it('updates only the children whose precos differ', async () => {
    const { port, committed } = memoryPort({
      children: [snap('c1', { L1: { valor: 5 } }), snap('c2', { L1: { valor: 10 } })],
    });
    const updated = await propagatePrecosToChildren(port, 'p1', { L1: { valor: 10 } });
    expect(updated).toEqual(['c1']);
    expect(committed).toEqual([
      [{ type: 'update', path: 'produtos/c1', data: { precos: { L1: { valor: 10 } } } }],
    ]);
  });

  it('does nothing when every child already matches', async () => {
    const { port, committed } = memoryPort({ children: [snap('c1', { L1: { valor: 10 } })] });
    expect(await propagatePrecosToChildren(port, 'p1', { L1: { valor: 10 } })).toEqual([]);
    expect(committed).toEqual([]);
  });
});

describe('applyPrecosChange', () => {
  it('records history + propagates when the map changed', async () => {
    const { port, committed } = memoryPort({ children: [snap('c1', { L1: { valor: 5 } })] });
    const out = await applyPrecosChange(port, {
      produtoId: 'p1',
      oldPrecos: { L1: { valor: 5 } },
      newPrecos: { L1: { valor: 10 } },
    });
    expect(out).toEqual({ changed: true });
    // one commit for history, one for child propagation
    expect(committed).toHaveLength(2);
    expect(committed[0]?.[0]?.path).toBe('produtos/p1/historicoDePrecos/id1');
    expect(committed[1]?.[0]).toMatchObject({ type: 'update', path: 'produtos/c1' });
  });

  it('is a no-op when the map is unchanged', async () => {
    const { port, committed } = memoryPort({ children: [snap('c1', { L1: { valor: 5 } })] });
    const out = await applyPrecosChange(port, {
      produtoId: 'p1',
      oldPrecos: { L1: { valor: 5 } },
      newPrecos: { L1: { valor: 5 } },
    });
    expect(out).toEqual({ changed: false });
    expect(committed).toEqual([]);
  });
});

describe('findProdutoReferences', () => {
  it('reports kit membership and deduped marketplace labels', async () => {
    const { port } = memoryPort({
      refs: {
        p1: { kits: [snap('k1', null, 'Kit A')], subcols: ['variacoesml', 'produtoshopee'] },
      },
    });
    const refs = await findProdutoReferences(port, 'p1');
    expect(refs.kits).toEqual([{ id: 'k1', nome: 'Kit A' }]);
    expect(refs.marketplaces.sort()).toEqual(['Mercado Livre', 'Shopee']);
  });
});

describe('deleteProdutoCascade', () => {
  it('deletes children first and the parent last when nothing references them', async () => {
    const { port, committed } = memoryPort({ children: [snap('c1', null, 'Variação P')] });
    await deleteProdutoCascade(port, 'p1');
    expect(committed).toEqual([
      [
        { type: 'delete', path: 'produtos/c1' },
        { type: 'delete', path: 'produtos/p1' },
      ],
    ]);
  });

  it('throws ProdutoReferencedError and writes nothing when a target is referenced', async () => {
    const { port, committed } = memoryPort({
      children: [snap('c1', null)],
      refs: { c1: { subcols: ['produtomercadolivre'] } },
    });
    await expect(deleteProdutoCascade(port, 'p1')).rejects.toBeInstanceOf(ProdutoReferencedError);
    expect(committed).toEqual([]);
  });
});
