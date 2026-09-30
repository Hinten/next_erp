import { describe, expect, it } from 'vitest';

import { flattenAndValidate } from '../../../lib/nfe/orchestrator/bundle';
import type { PedidoBundle } from '../../../lib/nfe/orchestrator/bundle';

/**
 * The order `flattenAndValidate` returns IS the `det/@nItem` numbering
 * (`buildGenItems` numbers by position). It must be the pedido's line order
 * (`ordem`), the one the pedido screen shows and labels its per-item references
 * with (#330) — not the `itens` map's grouping by produto.
 */

const IMPOSTO = { origem: '0', configuracaoICMS: { crt: '1', csosn: '102' } } as const;

function linha(sku: string, ordem: unknown): Record<string, unknown> {
  return {
    sku,
    nomeDeVenda: `Produto ${sku}`,
    precoDeVenda: 10,
    quantidade: 1,
    imposto: IMPOSTO,
    ...(ordem === undefined ? {} : { ordem }),
  };
}

function bundle(itens: Record<string, unknown[]>): PedidoBundle {
  return { pedidoId: 'PED-ORDEM', pedido: { itens } } as unknown as PedidoBundle;
}

const skus = (b: PedidoBundle) => flattenAndValidate(b).map((it) => it.sku);

describe('flattenAndValidate — det order is the pedido line order (#330)', () => {
  it('interleaved lines of one produto come back in the order they were entered', () => {
    // Entered A₁, B₁, A₂ → stored {A: [A₁, A₂], B: [B₁]}.
    const b = bundle({ 'p-A': [linha('A1', 1), linha('A2', 3)], 'p-B': [linha('B1', 2)] });
    expect(skus(b)).toEqual(['A1', 'B1', 'A2']);
  });

  it('keeps each item identified by its produto key and index in that key', () => {
    const b = bundle({ 'p-A': [linha('A1', 1), linha('A2', 3)], 'p-B': [linha('B1', 2)] });
    expect(flattenAndValidate(b).map((it) => `${it.produtoUid}#${it.itemIndex}`)).toEqual([
      'p-A#0',
      'p-B#0',
      'p-A#1',
    ]);
  });

  it('legacy lines with no ordem keep the stored order (the schema default, all tied)', () => {
    // Near-miss of the case above: without ordem there is nothing to reorder by.
    const b = bundle({
      'p-A': [linha('A1', undefined), linha('A2', undefined)],
      'p-B': [linha('B1', undefined)],
    });
    expect(skus(b)).toEqual(['A1', 'A2', 'B1']);
  });
});
