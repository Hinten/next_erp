import { describe, expect, it } from 'vitest';
import { checkCompleteness } from './checkoutCompleteness';
import type { EngineProduto, ScanKind, ScanLogEntry } from './checkoutEngine';
import { itemDoPedidoSchema, type ItemDoPedido } from '../collection/pedido';

function prod(id: string, kit?: Record<string, number>): EngineProduto {
  return {
    id,
    nome: id,
    sku: null,
    ehKit: kit !== undefined,
    componentesKit: kit
      ? Object.fromEntries(Object.entries(kit).map(([k, q]) => [k, { quantidade: q }]))
      : null,
    fotos: null,
  };
}
function item(produtoUid: string | null, quantidade: number, ordem: number): ItemDoPedido {
  return itemDoPedidoSchema.parse({ produtoUid, quantidade, ordem, precoDeVenda: 10 });
}
function mapOf(...ps: EngineProduto[]) {
  return new Map(ps.map((p) => [p.id, p]));
}

let n = 0;
function entry(
  kind: ScanKind,
  targetKey: string | null,
  extra: Partial<ScanLogEntry> = {},
): ScanLogEntry {
  return {
    uid: `e${n++}`,
    produtoId: null,
    produtoNome: '',
    produtoSku: null,
    quantidade: 1,
    kind,
    targetKey,
    componentProdutoId: null,
    error: null,
    timestampMs: 0,
    excluidoMs: null,
    ...extra,
  };
}

describe('checkCompleteness — non-kit', () => {
  const itens = [item('a', 2, 1)];
  const produtos = mapOf(prod('a'));

  it('is complete when the launched sum equals quantidade', () => {
    const r = checkCompleteness({
      itens,
      produtos,
      log: [entry('unit', 'exp-0'), entry('unit', 'exp-0')],
    });
    expect(r.complete).toBe(true);
    expect(r.mismatches).toEqual([]);
  });

  it('reports an under-scan mismatch', () => {
    const r = checkCompleteness({ itens, produtos, log: [entry('unit', 'exp-0')] });
    expect(r.complete).toBe(false);
    expect(r.mismatches[0]).toMatchObject({ pos: 0, produtoUid: 'a', expected: 2, actual: 1 });
  });

  it('reports an over-scan mismatch', () => {
    const log = [entry('unit', 'exp-0'), entry('unit', 'exp-0'), entry('unit', 'exp-0')];
    const r = checkCompleteness({ itens, produtos, log });
    expect(r.complete).toBe(false);
    expect(r.mismatches[0]).toMatchObject({ expected: 2, actual: 3 });
  });
});

describe('checkCompleteness — kit', () => {
  it('a single whole-kit row completes a qty-1 kit (contributes to every component)', () => {
    const r = checkCompleteness({
      itens: [item('K', 1, 1)],
      produtos: mapOf(prod('K', { x: 2, y: 3 })),
      log: [entry('kit', 'exp-0')],
    });
    expect(r.complete).toBe(true);
  });

  it('completes via individual component rows', () => {
    const r = checkCompleteness({
      itens: [item('K', 1, 1)],
      produtos: mapOf(prod('K', { x: 2, y: 1 })),
      log: [
        entry('component', 'exp-0', { componentProdutoId: 'x' }),
        entry('component', 'exp-0', { componentProdutoId: 'x' }),
        entry('component', 'exp-0', { componentProdutoId: 'y' }),
      ],
    });
    expect(r.complete).toBe(true);
  });

  it('completes a qty-2 kit via a mix of whole-kit and component rows', () => {
    const r = checkCompleteness({
      itens: [item('K', 2, 1)],
      produtos: mapOf(prod('K', { x: 1 })),
      log: [entry('kit', 'exp-0'), entry('component', 'exp-0', { componentProdutoId: 'x' })],
    });
    expect(r.complete).toBe(true); // x total = 1 (direct) + 1 (whole-kit×perKit) = 2 == required
  });

  it('flags a per-component shortfall', () => {
    const r = checkCompleteness({
      itens: [item('K', 1, 1)],
      produtos: mapOf(prod('K', { x: 2, y: 1 })),
      log: [entry('component', 'exp-0', { componentProdutoId: 'x' })],
    });
    expect(r.complete).toBe(false);
    expect(r.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ componentProdutoId: 'x', expected: 2, actual: 1 }),
      ]),
    );
  });
});

describe('checkCompleteness — ignored rows & edge lines', () => {
  it('ignores deleted and error rows', () => {
    const r = checkCompleteness({
      itens: [item('a', 1, 1)],
      produtos: mapOf(prod('a')),
      log: [
        entry('unit', 'exp-0'),
        entry('unit', 'exp-0', { excluidoMs: 123 }), // soft-deleted → ignored
        entry('error', null, { error: 'Produto não esperado' }), // error → ignored
      ],
    });
    expect(r.complete).toBe(true);
  });

  it('a missing-produto line is always a mismatch', () => {
    const r = checkCompleteness({ itens: [item('gone', 1, 1)], produtos: mapOf(), log: [] });
    expect(r.complete).toBe(false);
    expect(r.mismatches[0]).toMatchObject({ produtoUid: 'gone' });
  });

  it('skips an unbound (null) line', () => {
    const r = checkCompleteness({ itens: [item(null, 1, 1)], produtos: mapOf(), log: [] });
    expect(r.complete).toBe(true);
  });
});
