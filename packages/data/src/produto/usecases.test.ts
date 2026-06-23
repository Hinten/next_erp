import { describe, expect, it } from 'vitest';
import { impostoProdutoSchema, produtoExtraDataSchema } from '@delfrance/schemas';
import type { ProdutoDataPort, ProdutoSnapshot, ProdutoWriteOp } from './port';
import {
  ProdutoReferencedError,
  applyPrecosChange,
  buildExtraDataWriteOps,
  buildImpostoWriteOps,
  buildLocalizacaoOp,
  buildPrecoHistoryOps,
  deleteProdutoCascade,
  findProdutoReferences,
  planMovimentacao,
  propagatePrecosToChildren,
  recordPrecoHistory,
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

describe('produto estoque — localização (buildLocalizacaoOp)', () => {
  it('updates ONLY localizacao on an existing estoque (quantities untouched)', () => {
    const op = buildLocalizacaoOp('p1', 'd1', 'A1', true, 1000);
    expect(op).toEqual({
      type: 'update',
      path: 'produtos/p1/estoques/est-p1-d1',
      data: { localizacao: 'A1', ultimaModificacao: 1000 },
    });
  });

  it('clears localizacao to null on an empty string', () => {
    const op = buildLocalizacaoOp('p1', 'd1', '   ', true, 1000);
    if (op.type !== 'update') throw new Error('expected an update op');
    expect(op.data).toMatchObject({ localizacao: null });
  });

  it('sets a fresh estoque (quantidade 0) when none exists yet', () => {
    const op = buildLocalizacaoOp('p1', 'd1', 'B2', false, 1000);
    expect(op.type).toBe('set');
    expect(op.path).toBe('produtos/p1/estoques/est-p1-d1');
    if (op.type !== 'set') throw new Error('expected a set op');
    expect(op.data).toMatchObject({
      parentId: 'p1',
      depositoOuterRef: 'documents/depositos/d1',
      localizacao: 'B2',
      quantidade: 0,
      quantidadeReservada: 0,
      dataCriacao: 1000,
      ultimaModificacao: 1000,
    });
  });
});

describe('produto estoque — movimentação (planMovimentacao)', () => {
  it('entrada keeps the magnitudes positive and records a non-balanço history', () => {
    const plan = planMovimentacao(
      { tipo: 'entrada', quantidade: 5, quantidadeReservada: 0, motivo: 'compra' },
      1000,
    );
    expect(plan).toMatchObject({ ehBalanco: false, quantidade: 5, quantidadeReservada: 0 });
    expect(plan.historico).toEqual({
      ehBalanco: null,
      quantidade: 5,
      quantidadeReservada: 0,
      motivo: 'compra',
      timestamp: 1000,
    });
  });

  it('saída negates both magnitudes (the delta the caller increments)', () => {
    const plan = planMovimentacao(
      { tipo: 'saida', quantidade: 3, quantidadeReservada: 1, motivo: null },
      1000,
    );
    expect(plan).toMatchObject({ ehBalanco: false, quantidade: -3, quantidadeReservada: -1 });
    expect(plan.historico).toMatchObject({ quantidade: -3, quantidadeReservada: -1 });
  });

  it('balanço passes through the absolute counted values and flags ehBalanco', () => {
    const plan = planMovimentacao(
      { tipo: 'balanco', quantidade: 42, quantidadeReservada: 2, motivo: 'contagem' },
      1000,
    );
    expect(plan).toMatchObject({ ehBalanco: true, quantidade: 42, quantidadeReservada: 2 });
    expect(plan.historico).toMatchObject({ ehBalanco: true, quantidade: 42 });
  });
});

describe('produto imposto (per-operação override)', () => {
  const imp = (over: Record<string, unknown> = {}) =>
    impostoProdutoSchema.parse({ impostoOpercaoOuterRef: 'operacao/op1', ...over });

  it('sets one doc per configured operação, keyed by the operação id', () => {
    const ops = buildImpostoWriteOps('p1', [imp({ cfop: '5102', NCM: '61091000' })], 1000);
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op).toMatchObject({ type: 'set', path: 'produtos/p1/imposto/op1' });
    if (op.type !== 'set') throw new Error('expected a set op');
    // Wire shape: Flutter typo key + operação id mirrored into `id` + timestamp.
    expect(op.data).toMatchObject({
      id: 'op1',
      impostoOpercaoOuterRef: 'operacao/op1',
      cfop: '5102',
      NCM: '61091000',
      timestamp: 1000,
    });
  });

  it('preserves a passthrough ICMS config on re-save', () => {
    const ops = buildImpostoWriteOps(
      'p1',
      [imp({ cfop: '5102', configuracaoICMS: { csosn: '102' } })],
      1000,
    );
    const op = ops[0]!;
    if (op.type !== 'set') throw new Error('expected a set op');
    expect(op.data.configuracaoICMS).toEqual({ csosn: '102' });
  });

  it('deletes a previously-saved imposto that was fully cleared', () => {
    const ops = buildImpostoWriteOps('p1', [imp({ id: 'op1' })], 1000);
    expect(ops).toEqual([{ type: 'delete', path: 'produtos/p1/imposto/op1' }]);
  });

  it('skips a pristine empty row (never persisted)', () => {
    expect(buildImpostoWriteOps('p1', [imp({})], 1000)).toEqual([]);
  });

  it('keeps an entry whose only value is an explicit compoeValorTotalDaNFe=false', () => {
    const ops = buildImpostoWriteOps('p1', [imp({ compoeValorTotalDaNFe: false })], 1000);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: 'set', path: 'produtos/p1/imposto/op1' });
  });

  it('reads the operação id from a documents/operacao/<id> ref too', () => {
    const ops = buildImpostoWriteOps(
      'p2',
      [imp({ impostoOpercaoOuterRef: 'documents/operacao/opX', cfop: '6102' })],
      1000,
    );
    expect(ops[0]!.path).toBe('produtos/p2/imposto/opX');
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
