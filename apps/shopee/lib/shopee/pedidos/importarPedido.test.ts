import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { ESTADO_FRETE, ESTADO_PEDIDO, INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  ShopeeApiError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  type ShopeeClient,
  type ShopeeEscrowDetail,
  type ShopeeOrderDetail,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import { mapearItensShopee } from './itens';
import { makePedidoIdShopee } from './orderIds';
import { microsDeSegundosShopee } from './orderMapping';
import { SHOPEE_ERRO_ORDER_NOT_FOUND, importarPedidoShopee } from './importarPedido';

const INT = 'int-1';
const SHOP = 987654;
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(INT, ORDER_SN);
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;
const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const NOW_MS = 1_789_000_000_000;
const NOW_US = NOW_MS * 1000;
const UPDATE_TIME_S = 1_788_973_354;

/** The canonical algorithmically-valid fake documents. Never a real one. */
const CPF_FALSO = '12345678909';

function detalheSG(): ShopeeOrderDetailRow {
  return lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
}

function linha(patch: Record<string, unknown>): ShopeeOrderDetailRow {
  return { ...detalheSG(), ...patch } as ShopeeOrderDetailRow;
}

/** A BR-shaped order with a clear buyer — an inline vector, never a captured body. */
function detalheBR(patch: Record<string, unknown> = {}): ShopeeOrderDetailRow {
  return linha({
    region: 'BR',
    buyer_cpf_id: CPF_FALSO,
    recipient_address: {
      name: 'Comprador de Teste',
      phone: '11999999999',
      town: '',
      district: 'Centro',
      city: 'Sao Paulo',
      state: 'SP',
      region: 'BR',
      zipcode: '01001000',
      full_address: 'Praca da Se, 100, Centro, Sao Paulo, SP',
    },
    ...patch,
  });
}

/** Everything masked, exactly as Shopee sends it outside the unmask window. */
function detalheBRMascarado(): ShopeeOrderDetailRow {
  return detalheBR({
    buyer_cpf_id: '***********',
    recipient_address: { ...detalheBR().recipient_address, name: '****', full_address: '****' },
  });
}

interface Cenario {
  readonly db: FakeDb;
  readonly getOrderDetail: ReturnType<typeof vi.fn>;
  readonly getEscrowDetail: ReturnType<typeof vi.fn>;
  readonly deps: Parameters<typeof importarPedidoShopee>[2];
}

function cenario(
  over: { detalhe?: ShopeeOrderDetailRow; escrow?: ShopeeEscrowDetail } = {},
): Cenario {
  const db = new FakeDb();
  db.seed(`${INTEGRACAO_PATH}/${INT}`, {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja Sandbox',
    shop_id: SHOP,
    tabelaNormalOuterRef: 'documents/listaDePrecos/lp-1',
    operacaoOuterRef: 'documents/operacao/op-1',
  } satisfies DocData);

  const getOrderDetail = vi.fn(
    async (): Promise<ShopeeOrderDetail> => ({
      order_list: [over.detalhe ?? detalheSG()],
    }),
  );
  const getEscrowDetail = vi.fn(
    async (): Promise<ShopeeEscrowDetail> =>
      over.escrow ??
      ({
        order_sn: ORDER_SN,
        buyer_user_name: null,
        return_order_sn_list: null,
        order_income: null,
        buyer_payment_info: null,
      } as unknown as ShopeeEscrowDetail),
  );
  const client = { getOrderDetail, getEscrowDetail } as unknown as ShopeeClient;

  return {
    db,
    getOrderDetail,
    getEscrowDetail,
    deps: {
      clientFor: async () => client,
      // ViaCEP is IO; every vector here either has a mappable UF or asserts the
      // `sem-cep` arm, so a call would itself be the finding.
      viaCep: { buscarCep: vi.fn(async () => null) } as never,
    },
  };
}

function importar(c: Cenario, orderSn = ORDER_SN) {
  return importarPedidoShopee(
    asDb(c.db),
    { integracaoId: INT, shopId: SHOP, orderSn, nowMs: NOW_MS },
    c.deps,
  );
}

const avisos: unknown[][] = [];
const infos: unknown[][] = [];

beforeEach(() => {
  __resetAllReadCaches();
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    infos.push(args);
  });
});
afterEach(() => {
  __resetAllReadCaches();
  vi.restoreAllMocks();
  avisos.length = 0;
  infos.length = 0;
});

/* -------------------------------------------------------------------------- */
/*                              the happy path                                */
/* -------------------------------------------------------------------------- */

describe('importarPedidoShopee — o caminho feliz sobre a fixture SG', () => {
  it('cria o pedido inteiro a partir do detalhe re-buscado', async () => {
    const c = cenario();
    const r = await importar(c);

    expect(r).toMatchObject({
      kind: 'pedido',
      acao: 'criado',
      orderSn: ORDER_SN,
      pedidoId: PEDIDO_ID,
      orderStatus: 'READY_TO_SHIP',
      itensSemProduto: 1,
    });

    const doc = c.db.store[PEDIDO_PATH]!.data;
    expect(doc.numero).toBe(ORDER_SN);
    expect(doc.estado).toBe(ESTADO_PEDIDO.pago);
    // Region SG ⇒ the NF-e block is seeded on create.
    expect(doc.bloquearEmissaoNFe).toBe(true);
    expect(doc.lastMarketplaceUpdate).toBe(microsDeSegundosShopee(UPDATE_TIME_S));
    expect(doc.listaDePrecosOuterRef).toBe('documents/listaDePrecos/lp-1');
    expect(doc.operacaoPedidoOuterRef).toBe('documents/operacao/op-1');

    // A non-BR order can capture nothing, ever — there is no document on the
    // wire, so the diary says `expirado` rather than "wait".
    expect(doc.capturaComprador).toMatchObject({
      estado: 'expirado',
      camposRecusados: ['regiao:nao-br'],
    });
    expect(doc.clientePedidoOuterRef).toBeNull();
    expect(doc.enderecoFiscalOuterRef).toBeNull();

    // Freight: the buyer paid 1.99 while `actual_shipping_fee` is the zero-fill.
    const frete = doc.freteInicial as Record<string, unknown>;
    expect(frete.valorCobrado).toBe(1.99);
    expect(frete.estado).toBe(ESTADO_FRETE.iniciado);
    expect(frete.prazoDespacho).toBe(microsDeSegundosShopee(1789405354));
    expect(frete.volumes).toHaveLength(1);

    // Step 9 has written no link doc, so the line lands unresolved…
    const itens = doc.itens as Record<string, unknown[]>;
    expect(Object.keys(itens)).toEqual(['NONE']);
    // …and gets exactly one incidente.
    expect(c.db.idsEm(`pedidos/${PEDIDO_ID}/incidentes`)).toHaveLength(1);
  });

  it('sempre RE-BUSCA o detalhe — o corpo do push nunca é usado', async () => {
    const c = cenario();
    await importar(c);
    expect(c.getOrderDetail).toHaveBeenCalledTimes(1);
    expect(c.getOrderDetail.mock.calls[0]![0]).toMatchObject({
      orderSnList: [ORDER_SN],
      requestOrderStatusPending: true,
    });
  });

  it('resolve o produto de cada linha com o MESMO sku que o item guarda', async () => {
    // ⚠️ The resolver and the mapper compute the sku independently, so a drift
    // would resolve on one string and store another. Pinned over the vectors
    // where the two rules differ.
    for (const [modelSku, itemSku, esperado] of [
      ['123002002', 'PAI-1', '123002002'],
      ['', 'PAI-1', 'PAI-1'],
      ['', '', null],
      [' ', 'PAI-1', ' '],
    ] as const) {
      const detalhe = linha({
        item_list: [{ ...detalheSG().item_list![0]!, model_sku: modelSku, item_sku: itemSku }],
      });
      const c = cenario({ detalhe });
      await importar(c);
      const mapeado = mapearItensShopee({
        detalhe,
        escrow: null,
        resolucoes: new Map(),
        freteCobrado: null,
        nowUs: NOW_US,
      });
      expect(mapeado.itens[0]!.sku).toBe(esperado);
      // The group query the resolver issued carries the same string (or none was
      // issued at all, when the sku is absent).
      const consultasSku = c.db.consultas.filter((q) => q.fonte === 'produtos');
      const skusConsultados = consultasSku.flatMap((q) =>
        q.clausulas.filter(([campo]) => campo === 'sku').map(([, valor]) => valor),
      );
      if (esperado === null) expect(skusConsultados).toEqual([]);
      else expect(skusConsultados.every((s) => s === esperado)).toBe(true);
    }
  });

  it('uma segunda execução com o MESMO carimbo é ignorada e não escreve nada', async () => {
    const c = cenario();
    await importar(c);
    const antes = structuredClone(c.db.store[PEDIDO_PATH]!.data);
    c.db.opLog.length = 0;
    c.db.writes.length = 0;

    const r = await importar(c);

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(c.db.store[PEDIDO_PATH]!.data).toEqual(antes);
    expect(c.db.writes.filter((w) => w.path === PEDIDO_PATH)).toEqual([]);
    // The incidente is idempotent too: the same deterministic id, swallowed.
    expect(c.db.idsEm(`pedidos/${PEDIDO_ID}/incidentes`)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  the buyer                                  */
/* -------------------------------------------------------------------------- */

describe('importarPedidoShopee — o comprador', () => {
  it('um pedido BR com nome e CPF limpos cria o cliente UMA vez e o vincula', async () => {
    const c = cenario({ detalhe: detalheBR() });
    await importar(c);

    const doc = c.db.store[PEDIDO_PATH]!.data;
    const clientes = c.db.idsEm('clientes');
    expect(clientes).toHaveLength(1);
    expect(doc.clientePedidoOuterRef).toBe(`documents/clientes/${clientes[0]!}`);
    expect(doc.enderecoFiscalOuterRef).toBe(
      `documents/clientes/${clientes[0]!}/enderecos/${c.db.idsEm(`clientes/${clientes[0]!}/enderecos`)[0]!}`,
    );
    expect(doc.capturaComprador).toMatchObject({ estado: 'capturado', camposRecusados: [] });
    // A BR order is not blocked.
    expect(doc.bloquearEmissaoNFe).toBeNull();
  });

  it('o endereço guarda o full_address INTEIRO, sem re-dividir por vírgula', async () => {
    const c = cenario({ detalhe: detalheBR() });
    await importar(c);
    const clienteId = c.db.idsEm('clientes')[0]!;
    const enderecoId = c.db.idsEm(`clientes/${clienteId}/enderecos`)[0]!;
    const endereco = c.db.store[`clientes/${clienteId}/enderecos/${enderecoId}`]!.data;
    expect(endereco.logradouro).toBe('Praca da Se, 100, Centro, Sao Paulo, SP');
    expect(endereco.estado).toBe('SP');
  });

  it('⚠️ uma re-importação MASCARADA não desvincula o cliente já ligado', async () => {
    const c = cenario({ detalhe: detalheBR() });
    await importar(c);
    const doc = c.db.store[PEDIDO_PATH]!.data;
    const refCliente = doc.clientePedidoOuterRef;
    const clientesAntes = c.db.idsEm('clientes').length;

    // The next delivery is masked AND newer, so it is accepted and rewrites the
    // flag — but must touch neither buyer link.
    c.getOrderDetail.mockResolvedValue({
      order_list: [
        { ...detalheBRMascarado(), update_time: UPDATE_TIME_S + 60, order_status: 'SHIPPED' },
      ],
    });
    const r = await importar(c);

    expect(r.acao).toBe('atualizado');
    const depois = c.db.store[PEDIDO_PATH]!.data;
    expect(depois.clientePedidoOuterRef).toBe(refCliente);
    expect(depois.enderecoFiscalOuterRef).toBe(doc.enderecoFiscalOuterRef);
    // No junk cliente was minted for the masked delivery.
    expect(c.db.idsEm('clientes')).toHaveLength(clientesAntes);
  });

  it('um comprador MASCARADO num pedido novo escreve NADA e só carimba o diário', async () => {
    const c = cenario({ detalhe: detalheBRMascarado() });
    await importar(c);

    const doc = c.db.store[PEDIDO_PATH]!.data;
    expect(c.db.idsEm('clientes')).toEqual([]);
    expect(doc.clientePedidoOuterRef).toBeNull();
    expect(doc.enderecoFiscalOuterRef).toBeNull();
    expect(doc.capturaComprador).toMatchObject({
      estado: 'pendente',
      camposRecusados: ['nome:mascarado', 'cpf_cnpj:mascarado'],
    });
  });

  it('um CEP presente mas INVÁLIDO é recusado com o motivo nomeado, e o pedido continua', async () => {
    // ⚠️ The vector is a zipcode that PASSES the usable-value predicate (it is
    // non-empty and carries no `*`) and then fails `sanitizeCep`. An empty one
    // never reaches the builder at all — `enderecoDeShopee` gates on it — and
    // the reason there is already in `camposRecusados` under the buyer's own
    // fields, so this is the arm that would otherwise be silent.
    const c = cenario({
      detalhe: detalheBR({
        recipient_address: { ...detalheBR().recipient_address, zipcode: 'SEM-CEP' },
      }),
    });
    const r = await importar(c);

    expect(r.acao).toBe('criado');
    const doc = c.db.store[PEDIDO_PATH]!.data;
    expect(doc.enderecoFiscalOuterRef).toBeNull();
    // The cliente still linked — fill-once is PER FIELD.
    expect(doc.clientePedidoOuterRef).not.toBeNull();
    expect((doc.capturaComprador as Record<string, unknown>).camposRecusados).toContain(
      'endereco:sem-cep',
    );
  });

  it('nenhum log carrega CPF, nome ou endereço do comprador', async () => {
    const c = cenario({ detalhe: detalheBR() });
    await importar(c);
    const tudo = JSON.stringify([...avisos, ...infos]);
    expect(tudo).not.toContain(CPF_FALSO);
    expect(tudo).not.toContain('Comprador de Teste');
    expect(tudo).not.toContain('Praca da Se');
    expect(tudo).not.toContain('11999999999');
  });
});

/* -------------------------------------------------------------------------- */
/*                            lifecycle transitions                            */
/* -------------------------------------------------------------------------- */

describe('importarPedidoShopee — o ciclo de vida', () => {
  it('CANCELLED depois de pago escreve cancelado', async () => {
    const c = cenario();
    await importar(c);
    c.getOrderDetail.mockResolvedValue({
      order_list: [linha({ order_status: 'CANCELLED', update_time: UPDATE_TIME_S + 60 })],
    });

    const r = await importar(c);
    expect(r.acao).toBe('atualizado');
    expect(c.db.store[PEDIDO_PATH]!.data.estado).toBe(ESTADO_PEDIDO.cancelado);
  });

  it('⚠️ UNPAID depois de pago NÃO desfaz o estado, mas a flag e o watermark avançam', async () => {
    const c = cenario();
    await importar(c);
    const novo = UPDATE_TIME_S + 60;
    c.getOrderDetail.mockResolvedValue({
      order_list: [linha({ order_status: 'UNPAID', update_time: novo })],
    });

    await importar(c);
    const doc = c.db.store[PEDIDO_PATH]!.data;
    expect(doc.estado).toBe(ESTADO_PEDIDO.pago);
    expect(doc.lastMarketplaceUpdate).toBe(microsDeSegundosShopee(novo));
    expect((doc.marketplace as Record<string, unknown>).status).toBe('UNPAID');
  });

  it('uma entrega ATRASADA é descartada como obsoleta', async () => {
    const c = cenario();
    await importar(c);
    c.getOrderDetail.mockResolvedValue({
      order_list: [linha({ order_status: 'UNPAID', update_time: UPDATE_TIME_S - 60 })],
    });

    const r = await importar(c);
    expect(r.acao).toBe('ignorado-obsoleto');
    expect((c.db.store[PEDIDO_PATH]!.data.marketplace as Record<string, unknown>).status).toBe(
      'READY_TO_SHIP',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                              the wire failures                              */
/* -------------------------------------------------------------------------- */

function erroApi(code: string, kind: 'other' | 'transient' = 'other'): ShopeeApiError {
  return new ShopeeApiError(`shopee respondeu ${code}`, {
    code,
    kind,
    httpStatus: 200,
    path: '/api/v2/order/get_order_detail',
  });
}

describe('importarPedidoShopee — as falhas de wire', () => {
  it('order_not_found devolve "ignorado-inexistente" e NÃO relança', async () => {
    const c = cenario();
    c.getOrderDetail.mockRejectedValue(erroApi(SHOPEE_ERRO_ORDER_NOT_FOUND));

    const r = await importar(c);
    expect(r).toMatchObject({
      acao: 'ignorado-inexistente',
      pedidoId: null,
      orderStatus: null,
      detail: 'ignorado-inexistente:order_not_found',
    });
    expect(c.db.writes).toEqual([]);
  });

  it('uma order ausente do order_list também vira "ignorado-inexistente"', async () => {
    // Shopee may answer with FEWER rows than asked for; reconcile by `order_sn`,
    // never by position — a `[0]` read here would import the WRONG order.
    const c = cenario();
    c.getOrderDetail.mockResolvedValue({ order_list: [linha({ order_sn: 'OUTRA-ORDER' })] });

    const r = await importar(c);
    expect(r.acao).toBe('ignorado-inexistente');
    expect(r.detail).toBe('ignorado-inexistente:ausente-no-order_list');
    expect(c.db.writes).toEqual([]);
  });

  it('uma falha do get_escrow_detail é CONTIDA — o pedido é gravado com os preços do detalhe', async () => {
    const c = cenario();
    c.getEscrowDetail.mockRejectedValue(erroApi('error_server', 'transient'));

    const r = await importar(c);
    expect(r.acao).toBe('criado');
    const itens = (
      c.db.store[PEDIDO_PATH]!.data.itens as Record<string, { precoDeVenda: number }[]>
    ).NONE!;
    // 15 per unit, straight off the detail.
    expect(itens[0]!.precoDeVenda).toBe(15);
  });

  it('um ShopeeSchemaError do escrow é contido e NOMEIA kit_items', async () => {
    const c = cenario();
    c.getEscrowDetail.mockRejectedValue(
      new ShopeeSchemaError('corpo inesperado', {
        campos: ['response.order_income.items.0.kit_items.original_product_id'],
        httpStatus: 200,
        path: '/api/v2/payment/get_escrow_detail',
      }),
    );

    const r = await importar(c);
    expect(r.acao).toBe('criado');
    const linhaDeLog = avisos.find((a) => String(a[0]).includes('escrow ilegível'));
    expect(linhaDeLog).toBeDefined();
    expect((linhaDeLog![1] as Record<string, unknown>).kitItems).toBe(true);
  });

  it('⚠️ NEAR-MISS: um reauth do escrow NÃO é contido — ele RELANÇA', async () => {
    // `ShopeeReauthRequiredError` EXTENDS `ShopeeApiError`, so a containment
    // written as a single `instanceof ShopeeApiError` would import the order at
    // detail-only prices and report success on a dead grant.
    const c = cenario();
    const reauth = new ShopeeReauthRequiredError('token morto', {
      code: 'error_auth',
      kind: 'reauth',
      httpStatus: 200,
      path: '/api/v2/payment/get_escrow_detail',
    });
    c.getEscrowDetail.mockRejectedValue(reauth);

    await expect(importar(c)).rejects.toBe(reauth);
    expect(c.db.writes.filter((w) => w.path === PEDIDO_PATH)).toEqual([]);
  });

  it('⚠️ NEAR-MISS: um rate limit do escrow também RELANÇA', async () => {
    const c = cenario();
    const limite = new ShopeeRateLimitError('devagar', {
      code: 'error_burst_limit',
      kind: 'burst',
      httpStatus: 200,
      path: '/api/v2/payment/get_escrow_detail',
    });
    c.getEscrowDetail.mockRejectedValue(limite);
    await expect(importar(c)).rejects.toBe(limite);
  });

  it('um reauth do DETALHE é relançado intacto — este módulo não converte erros', async () => {
    const c = cenario();
    const reauth = new ShopeeReauthRequiredError('token morto', {
      code: 'error_auth',
      kind: 'reauth',
      httpStatus: 200,
      path: '/api/v2/order/get_order_detail',
    });
    c.getOrderDetail.mockRejectedValue(reauth);
    await expect(importar(c)).rejects.toBe(reauth);
  });

  it('uma falha de rede do detalhe é relançada', async () => {
    const c = cenario();
    const rede = new ShopeeNetworkError('sem resposta');
    c.getOrderDetail.mockRejectedValue(rede);
    await expect(importar(c)).rejects.toBe(rede);
  });

  it('um order_not_found do ESCROW é contido, não confundido com o do detalhe', async () => {
    const c = cenario();
    c.getEscrowDetail.mockRejectedValue(erroApi(SHOPEE_ERRO_ORDER_NOT_FOUND));
    const r = await importar(c);
    expect(r.acao).toBe('criado');
  });
});

/* -------------------------------------------------------------------------- */
/*                                   a conta                                   */
/* -------------------------------------------------------------------------- */

describe('importarPedidoShopee — a conta', () => {
  it('uma conta sem tabela nem operação grava null nos dois refs', async () => {
    const c = cenario();
    c.db.seed(`${INTEGRACAO_PATH}/${INT}`, {
      tipo: INTEGRACAO_TIPO.shopee,
      ativo: true,
      nome: 'Loja Sandbox',
      shop_id: SHOP,
    });
    __resetAllReadCaches();

    await importar(c);
    const doc = c.db.store[PEDIDO_PATH]!.data;
    expect(doc.listaDePrecosOuterRef).toBeNull();
    expect(doc.operacaoPedidoOuterRef).toBeNull();
    // The integração ref itself is derived from the id, never from the document.
    expect(doc.integracaoPedidoOuterRef).toBe(`documents/integracao/${INT}`);
  });
});
