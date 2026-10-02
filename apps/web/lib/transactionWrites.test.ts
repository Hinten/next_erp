import { describe, expect, it, vi } from 'vitest';
import {
  impostoProdutoSchema,
  impostoCategoriaSchema,
  produtoExtraDataSchema,
  type ImpostoProduto,
  type ImpostoCategoria,
} from '@delfrance/schemas';
import type { TransactionWriteContext } from '@delfrance/ui';

const ref = (path: string) => ({ path, id: path.split('/').at(-1) });
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: { docRef: (_db: unknown, _ctx: unknown, id: string) => ref('produtos/' + id) },
}));
vi.mock('@/lib/data/produtoExtraDataCollection', () => ({
  produtoExtraDataCollection: {
    docRef: (_db: unknown, ctx: { produtoId: string }, id: string) =>
      ref('produtos/' + ctx.produtoId + '/extraData/' + id),
  },
}));
vi.mock('@/lib/data/impostoProdutoCollection', () => ({
  impostoProdutoCollection: {
    docRef: (_db: unknown, ctx: { produtoId: string }, id: string) =>
      ref('produtos/' + ctx.produtoId + '/imposto/' + id),
  },
}));
vi.mock('@/lib/data/impostoCategoriaCollection', () => ({
  impostoCategoriaCollection: {
    docRef: (_db: unknown, ctx: { categoriaId: string }, id: string) =>
      ref('categorias/' + ctx.categoriaId + '/imposto/' + id),
  },
}));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFunctions: () => ({}) }));
import { buildProdutoTransactionWrites } from './produtos/clientPort';
import { buildCategoriaImpostoTransactionWrites } from './categorias/clientPort';

const db = {} as never;
const registry = (
  baseline: Record<string, unknown> | null | undefined,
): TransactionWriteContext => ({ getBaseline: () => baseline });

describe('transactionWrites document bindings', () => {
  it('distinguishes unread product extraData from confirmed absence', () => {
    const values = { extraData: produtoExtraDataSchema.parse({ descricao: 'Historical' }) };
    expect(
      buildProdutoTransactionWrites(db, 'p1', values, 'editar', registry(undefined))[0]?.guard
        ?.baseline,
    ).toBeUndefined();
    expect(
      buildProdutoTransactionWrites(db, 'p1', values, 'editar', registry(null))[0]?.guard?.baseline,
    ).toBeNull();
  });

  it('reloads only the product tax operation identified by the document path after rows reorder', () => {
    const sale = impostoProdutoSchema.parse({
      id: 'venda',
      impostoOpercaoOuterRef: 'operacao/venda',
      cfop: 'local sale',
    });
    const returnRow = impostoProdutoSchema.parse({
      id: 'devolucao',
      impostoOpercaoOuterRef: 'operacao/devolucao',
      cfop: 'unsaved return',
    });
    const writes = buildProdutoTransactionWrites(
      db,
      'p1',
      { impostos: [sale, returnRow] },
      'editar',
      registry(sale),
    );
    const guard = writes.find((write) => write.ref.id === 'venda')!.guard!;
    const next = guard.toFormValue({ ...sale, cfop: 'remote sale' }, [
      returnRow,
      sale,
    ]) as ImpostoProduto[];
    expect(next[0]).toEqual(returnRow);
    expect(next[1]?.cfop).toBe('remote sale');
    const deleted = guard.toFormValue(null, [returnRow, sale]) as ImpostoProduto[];
    expect(deleted[0]).toEqual(returnRow);
    expect(deleted[1]).toMatchObject({
      id: null,
      cfop: null,
      impostoOpercaoOuterRef: 'operacao/venda',
    });
  });

  it('reloads only the corresponding category tax row', () => {
    const sale = impostoCategoriaSchema.parse({
      id: 'venda',
      impostoCategoriaOperacaoOuterRef: 'operacao/venda',
      cfop: 'local sale',
    });
    const other = impostoCategoriaSchema.parse({
      id: 'outra',
      impostoCategoriaOperacaoOuterRef: 'operacao/outra',
      cfop: 'unsaved',
    });
    const writes = buildCategoriaImpostoTransactionWrites(
      db,
      'c1',
      { impostos: [sale, other] },
      registry(sale),
    );
    const guard = writes.find((write) => write.ref.id === 'venda')!.guard!;
    const next = guard.toFormValue({ ...sale, cfop: 'remote' }, [
      other,
      sale,
    ]) as ImpostoCategoria[];
    expect(next[0]).toEqual(other);
    expect(next[1]?.cfop).toBe('remote');
    const deleted = (guard.toFormValue(null, [sale]) as ImpostoCategoria[])[0];
    expect(deleted?.id).toBeNull();
    expect(deleted?.cfop ?? null).toBeNull();
  });

  it('provides guards for both configured and cleared category tax rows', () => {
    const row = impostoCategoriaSchema.parse({
      id: 'venda',
      impostoCategoriaOperacaoOuterRef: 'operacao/venda',
    });
    const write = buildCategoriaImpostoTransactionWrites(
      db,
      'c1',
      { impostos: [row] },
      registry(row),
    )[0];
    expect(write?.type).toBe('delete');
    expect(write?.guard?.baseline).toEqual(row);
  });
});
