import { describe, expect, it } from 'vitest';
import type { ItemDoPedido } from '@delfrance/schemas';
import { createFakeDevolucaoPort } from './fakePort';
import { PedidoConflictError } from './usecases';
import { DUPLICAR_PEDIDO_STRIP_KEYS, buildDuplicarPedidoSeed } from './duplicar';

const item = (produtoUid: string | null, quantidade: number, precoDeVenda = 10): ItemDoPedido =>
  ({ produtoUid, quantidade, precoDeVenda }) as unknown as ItemDoPedido;

describe('buildDuplicarPedidoSeed', () => {
  const origin = {
    ehSaida: true,
    estado: 'pago',
    numero: 'VEN-000010',
    itens: { p1: [item('p1', 3, 25)] },
    itensIds: ['p1'],
    clientePedidoOuterRef: 'documents/clientes/c1',
    operacaoPedidoOuterRef: 'documents/operacao/op1',
    integracaoPedidoOuterRef: 'documents/integracao/i1',
    vendedorPedidoOuterRef: 'documents/usuarios/original-seller',
    entradasRelacionadas: ['x'],
    saidasRelacionadas: ['y'],
    chNFeReferenciadas: ['CH1'],
    itensDevolvidos: { o0: { p1: [item('p1', 1, 25)] } },
    estoqueAplicado: { depositoId: 'd1', ehSaida: true },
    observacoesInternas: 'nota interna',
    error: 'boom',
    dtImpressao: 111,
    lastMarketplaceUpdate: 222,
    dataIndisponivelEstoque: 333,
    dataRemocaoEstoque: 444,
    ultimaModificacao: 555,
    timestamp: 666,
    foiImpresso: true,
    freteInicial: {
      estado: 'entregue',
      externalId: 'ext-1',
      printLabelId: 'label-1',
      modalidade: '1',
      codRastreio: 'BR123',
    },
  };

  function setup() {
    return createFakeDevolucaoPort({ docs: { 'pedidos/o1': origin } });
  }

  it('strips state/print/marketplace/error/relational metadata back to defaults', async () => {
    const { port } = setup();
    const { values } = await buildDuplicarPedidoSeed(port, {
      originId: 'o1',
      usuarioRef: 'documents/usuarios/u9',
    });
    expect(values.estado).toBe('iniciado');
    // Pairs with dtImpressao — carrying `true` over with no real print date
    // would mark a never-printed draft as printed.
    expect(values.foiImpresso).toBe(false);
    const refilledToNull = DUPLICAR_PEDIDO_STRIP_KEYS.filter(
      (k) => k !== 'estado' && k !== 'foiImpresso',
    );
    for (const key of refilledToNull) {
      expect(values[key]).toBeNull();
    }
  });

  it('keeps cliente/operação/itens unchanged and resets the vendedor to the current user', async () => {
    const { port } = setup();
    const { values, originNumero } = await buildDuplicarPedidoSeed(port, {
      originId: 'o1',
      usuarioRef: 'documents/usuarios/u9',
    });
    expect(values.ehSaida).toBe(true);
    expect(values.clientePedidoOuterRef).toBe('documents/clientes/c1');
    expect(values.operacaoPedidoOuterRef).toBe('documents/operacao/op1');
    expect(values.integracaoPedidoOuterRef).toBe('documents/integracao/i1');
    expect(values.vendedorPedidoOuterRef).toBe('documents/usuarios/u9');
    const itens = values.itens as Record<string, ItemDoPedido[]>;
    expect(itens.p1?.map((i) => [i.quantidade, i.precoDeVenda])).toEqual([[3, 25]]);
    expect(values.numero).toBeNull();
    expect(originNumero).toBe('VEN-000010');
  });

  it('strips only externalId/printLabelId/estado inside freteInicial, keeping the rest', async () => {
    const { port } = setup();
    const { values } = await buildDuplicarPedidoSeed(port, {
      originId: 'o1',
      usuarioRef: null,
    });
    const frete = values.freteInicial as Record<string, unknown>;
    expect(frete.estado).toBe('iniciado');
    expect(frete.externalId).toBeNull();
    expect(frete.printLabelId).toBeNull();
    // Untouched — not in the #370 audit's strip list.
    expect(frete.modalidade).toBe('1');
    expect(frete.codRastreio).toBe('BR123');
  });

  it('leaves a null freteInicial untouched', async () => {
    const { port } = createFakeDevolucaoPort({
      docs: { 'pedidos/o1': { ...origin, freteInicial: null } },
    });
    const { values } = await buildDuplicarPedidoSeed(port, { originId: 'o1', usuarioRef: null });
    expect(values.freteInicial).toBeNull();
  });

  it('accepts a null usuarioRef (no authenticated user resolved yet)', async () => {
    const { port } = setup();
    const { values } = await buildDuplicarPedidoSeed(port, { originId: 'o1', usuarioRef: null });
    expect(values.vendedorPedidoOuterRef).toBeNull();
  });

  it('never carries pagamentos/incidentes — they are subcollections, never read here', async () => {
    const { port } = setup();
    const { values } = await buildDuplicarPedidoSeed(port, {
      originId: 'o1',
      usuarioRef: 'documents/usuarios/u9',
    });
    expect(values).not.toHaveProperty('pagamentos');
    expect(values).not.toHaveProperty('incidentes');
  });

  it('throws PedidoConflictError when the origin no longer exists', async () => {
    const { port } = createFakeDevolucaoPort();
    await expect(
      buildDuplicarPedidoSeed(port, { originId: 'gone', usuarioRef: null }),
    ).rejects.toBeInstanceOf(PedidoConflictError);
  });
});
