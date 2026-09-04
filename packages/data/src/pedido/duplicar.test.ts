import { describe, expect, it } from 'vitest';
import type { ItemDoPedido } from '@delfrance/schemas';
import { createFakeDevolucaoPort } from './fakePort';
import { PedidoConflictError } from './usecases';
import {
  DUPLICAR_PEDIDO_STRIP_KEYS,
  FRETE_QUOTE_RESET_KEYS,
  buildDuplicarPedidoSeed,
} from './duplicar';

const item = (produtoUid: string | null, quantidade: number, precoDeVenda = 10): ItemDoPedido =>
  ({ produtoUid, quantidade, precoDeVenda }) as unknown as ItemDoPedido;

describe('buildDuplicarPedidoSeed', () => {
  const origin = {
    ehSaida: true,
    estado: 'pago',
    numero: 'VEN-000010',
    itens: {
      p1: [
        {
          produtoUid: 'p1',
          quantidade: 3,
          precoDeVenda: 25,
          custo: 9,
          mktplaceId: 'MLB123',
          // Mercado Livre line identity + the origin line's creation stamp:
          // neither describes a line on a manually created pedido.
          ensureUniqueId: 'sha-of-the-origin-order-line',
          timestamp: 777,
        },
      ],
    },
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
    infCpl: 'texto complementar',
    error: 'boom',
    dtImpressao: 111,
    lastMarketplaceUpdate: 222,
    dataIndisponivelEstoque: 333,
    dataRemocaoEstoque: 444,
    ultimaModificacao: 555,
    timestamp: 666,
    dataFinalExpedicao: 888,
    foiImpresso: true,
    bloquearEmissaoNFe: true,
    // The four legacy money pass-throughs #1151 removed from `pedidoSchema`.
    // Kept on the ORIGIN fixture on purpose: the migrated corpus still stores
    // them, so this is what a real origin doc looks like and what the re-parse
    // has to drop.
    valorComissoes: 12.5,
    valorDespesasIncidentes: 3.5,
    valorFretesIncidentes: 4.5,
    impostos: 7.25,
    freteInicial: {
      estado: 'entregue',
      // Quote / label / carrier progress — all of it belongs to the origin.
      externalId: 'ext-1',
      printLabelId: 'label-1',
      externalOptionId: 'PAC',
      externalOptionIntegracao: 'melhorEnvios',
      externalOptionData: { agency: '42' },
      externalOptionSelectionDate: 1_000,
      codRastreio: 'BR123',
      valorCobrado: 30,
      custoCalculado: 21,
      custoFinal: 22,
      prazoDespacho: 2_000,
      dataEntrega: 3_000,
      dataPrevisaoEntrega: 4_000,
      ultimaModificacao: 5_000,
      timestamp: 6_000,
      // Shipping intent — carries through.
      integracaoFreteOuterRef: 'documents/int_frete/if-me',
      integracaoTargetOuterRef: 'documents/int_frete/if-me-target',
      enderecoFreteOuterReference: 'documents/enderecos/e1',
      modalidade: '1',
      transportadora: { nome: 'Transportadora X' },
      volumes: [{ quantidade: 2, pesoBruto: 1.5 }],
      valor_assegurado: 100,
      prazoExtra: 3,
    },
  };

  function setup() {
    return createFakeDevolucaoPort({ docs: { 'pedidos/o1': origin } });
  }

  function seed(overrides?: Record<string, unknown>, usuarioRef: string | null = null) {
    const { port } = createFakeDevolucaoPort({
      docs: { 'pedidos/o1': { ...origin, ...overrides } },
    });
    return buildDuplicarPedidoSeed(port, { originId: 'o1', usuarioRef });
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

    // Named one by one on purpose — see the same note in the freteInicial
    // test: the loop below iterates the constant under test, so it cannot
    // notice a key being DELETED from it.
    expect(values.dtImpressao).toBeNull();
    expect(values.lastMarketplaceUpdate).toBeNull();
    expect(values.ultimaModificacao).toBeNull();
    expect(values.timestamp).toBeNull();
    expect(values.error).toBeNull();
    expect(values.chNFeReferenciadas).toBeNull();
    expect(values.itensDevolvidos).toBeNull();
    expect(values.entradasRelacionadas).toBeNull();
    expect(values.saidasRelacionadas).toBeNull();
    expect(values.estoqueAplicado).toBeNull();
    expect(values.dataIndisponivelEstoque).toBeNull();
    expect(values.dataRemocaoEstoque).toBeNull();

    // Backstop for the other direction: a key ADDED to the constant but never
    // actually deleted from the clone.
    const refilledToNull = DUPLICAR_PEDIDO_STRIP_KEYS.filter(
      (k) => k !== 'estado' && k !== 'foiImpresso',
    );
    for (const key of refilledToNull) {
      expect(values[key], `expected ${key} to be stripped`).toBeNull();
    }
  });

  it('drops the four legacy money pass-throughs — they are not modeled at all (#1151)', async () => {
    // These were strip-list entries until #1151 removed them from
    // `pedidoSchema`. They need no entry now: `pedidoSchema` has no
    // `.passthrough()` (#462), so the re-parse drops an unmodeled origin key on
    // its own. `not.toHaveProperty` rather than `toBeNull` is the point — a
    // null would mean the field is still declared, and this asserts the
    // stronger property that the seed cannot carry the key at all.
    const { values } = await seed();
    expect(values).not.toHaveProperty('valorComissoes');
    expect(values).not.toHaveProperty('valorDespesasIncidentes');
    expect(values).not.toHaveProperty('valorFretesIncidentes');
    expect(values).not.toHaveProperty('impostos');
  });

  it('strips dataFinalExpedicao and the origin bloquearEmissaoNFe', async () => {
    const { values } = await seed();
    expect(values.dataFinalExpedicao).toBeNull();
    // Operator intent scoped to the ORIGIN; carried over it silently blocks the
    // duplicate's emission with a 409 only visible at emit time.
    expect(values.bloquearEmissaoNFe).toBeNull();
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

  it('keeps observacoesInternas — a duplicate is the SAME order placed again', async () => {
    // Deliberate divergence from `DEVOLUCAO_INTEGRAL_STRIP_KEYS`, which drops
    // it: a devolução is a DIFFERENT order, so the saída's notes do not
    // describe it. Pinned so the two lists are not "aligned" by mistake.
    const { values } = await seed();
    expect(values.observacoesInternas).toBe('nota interna');
    expect(values.infCpl).toBe('texto complementar');
  });

  it('drops the origin per-line ids from every cloned item', async () => {
    const { values } = await seed();
    const itens = values.itens as Record<string, Array<Record<string, unknown>>>;
    const line = itens.p1?.[0];
    expect(line?.ensureUniqueId).toBeNull();
    expect(line?.timestamp).toBeNull();
    // Everything that describes WHAT is being sold survives.
    expect(line?.produtoUid).toBe('p1');
    expect(line?.quantidade).toBe(3);
    expect(line?.precoDeVenda).toBe(25);
    expect(line?.custo).toBe(9);
    expect(line?.mktplaceId).toBe('MLB123');
  });

  it('resets the whole freteInicial quote/label/carrier surface', async () => {
    const { values } = await seed();
    const frete = values.freteInicial as Record<string, unknown>;
    expect(frete.estado).toBe('iniciado');

    // Named one by one on purpose. The loop below iterates the very constant
    // under test, so it cannot notice a key being DELETED from it — dropping
    // `codRastreio` from `FRETE_QUOTE_RESET_KEYS` also drops it from the loop
    // and the suite stays green. These literals are what actually fails.
    expect(frete.codRastreio).toBeNull();
    expect(frete.externalId).toBeNull();
    expect(frete.printLabelId).toBeNull();
    expect(frete.externalOptionId).toBeNull();
    expect(frete.externalOptionData).toBeNull();
    expect(frete.externalOptionIntegracao).toBeNull();
    expect(frete.externalOptionSelectionDate).toBeNull();
    expect(frete.valorCobrado).toBeNull();
    expect(frete.custoCalculado).toBeNull();
    expect(frete.custoFinal).toBeNull();
    expect(frete.prazoDespacho).toBeNull();
    expect(frete.dataEntrega).toBeNull();
    expect(frete.dataPrevisaoEntrega).toBeNull();
    expect(frete.ultimaModificacao).toBeNull();
    expect(frete.timestamp).toBeNull();

    // Backstop for the other direction: a key ADDED to the constant but never
    // actually deleted by `resetFreteInicial`.
    for (const key of FRETE_QUOTE_RESET_KEYS) {
      expect(frete[key], `expected freteInicial.${key} to be reset`).toBeNull();
    }
  });

  it('keeps the shipping intent inside freteInicial', async () => {
    const { values } = await seed();
    const frete = values.freteInicial as Record<string, unknown>;
    expect(frete.modalidade).toBe('1');
    expect(frete.enderecoFreteOuterReference).toBe('documents/enderecos/e1');
    expect((frete.transportadora as Record<string, unknown>).nome).toBe('Transportadora X');
    expect(frete.volumes).toHaveLength(1);
    expect(frete.valor_assegurado).toBe(100);
    expect(frete.prazoExtra).toBe(3);
    // Not marketplace-owned → the freight integração binding survives, so the
    // operator can re-quote against the same provider.
    expect(frete.integracaoFreteOuterRef).toBe('documents/int_frete/if-me');
    expect(frete.integracaoTargetOuterRef).toBe('documents/int_frete/if-me-target');
  });

  it('drops the freight integração refs when the origin block was marketplace-owned', async () => {
    // Otherwise `FreteTab` resolves an `int_frete` whose tipo is marketplace,
    // and `isFreteMarketplaceOwned` locks the whole tab — including the
    // integração picker itself — so the operator could never point the
    // duplicate at Melhor Envio.
    const { values } = await seed({
      freteInicial: { ...origin.freteInicial, externalOptionIntegracao: 'mercadoLivre' },
    });
    const frete = values.freteInicial as Record<string, unknown>;
    expect(frete.integracaoFreteOuterRef).toBeNull();
    expect(frete.integracaoTargetOuterRef).toBeNull();
    // The rest of the shipping intent still carries.
    expect(frete.enderecoFreteOuterReference).toBe('documents/enderecos/e1');
    expect(frete.volumes).toHaveLength(1);
  });

  it('leaves a null freteInicial untouched', async () => {
    const { values } = await seed({ freteInicial: null });
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
