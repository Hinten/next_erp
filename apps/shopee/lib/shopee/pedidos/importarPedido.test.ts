import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { ESTADO_FRETE, ESTADO_PEDIDO, INTEGRACAO_TIPO, pagamentoSchema } from '@delfrance/schemas';
import type { ZodError } from 'zod';
import {
  ShopeeApiError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  shopeePackageDetailRowSchema,
  type ShopeeClient,
  type ShopeeEscrowDetail,
  type ShopeeOrderDetail,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import { observadoDoPacoteDetalhe, type PacoteObservadoShopee } from './fretePushShopee';
import { salvarFreteShopee } from './freteTx';
import { mapearItensShopee } from './itens';
import { makePagamentoIdShopee, makePedidoIdShopee } from './orderIds';
import { microsDeSegundosShopee } from './orderMapping';

/**
 * The step-6 write is reached through a seam (#1514) so ONE test can inject a
 * real `ZodError` at exactly the place `pagamentoCollection.parse` raises one.
 *
 * ⚠️ Every other test in this file still runs through the REAL transaction: the
 * factory delegates to the original module unless `pag.erro` is set, so the
 * call-order, skip-matrix and log assertions below are about production code and
 * not about a double.
 */
const pag = vi.hoisted(() => ({ erro: null as unknown }));
vi.mock('./pagamentoTx', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pagamentoTx')>();
  return {
    ...real,
    salvarPagamentosShopee: async (
      ...args: Parameters<typeof real.salvarPagamentosShopee>
    ): ReturnType<typeof real.salvarPagamentosShopee> => {
      if (pag.erro != null) throw pag.erro;
      return real.salvarPagamentosShopee(...args);
    },
  };
});

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
  pag.erro = null;
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
    // ⚠️ Step 5 SEEDS `iniciado` and step 7's backstop (#1515) immediately folds
    // the order's own `package_list[]` over it — the SG body carries
    // `LOGISTICS_READY` — so the estado the document ends this import with is
    // the FOLD's, not the seed's. That is the whole point of the backstop: the
    // pushes that would otherwise carry it are lossy.
    expect(frete.estado).toBe(ESTADO_FRETE.despachoAutorizado);
    expect(frete.prazoDespacho).toBe(microsDeSegundosShopee(1789405354));
    expect(frete.volumes).toHaveLength(1);
    // …and the per-package diary the same transaction wrote.
    expect(frete.pacotes).toHaveLength(1);

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

  it('⚠️ o diário é um DIÁRIO, não um portão: um EXPIRADO armazenado não impede a captura seguinte', async () => {
    // W4/R4's load-bearing sentence, and the one mutation that survived every
    // other assertion in this file: gating `resolverComprador` on the stored
    // `capturaComprador.estado === 'expirado'` would make a pedido whose first
    // delivery arrived masked and out of the window NEVER capture its buyer —
    // no cliente, no endereço, no NF-e — even when a later `get_order_detail`
    // returns the name and the CPF in the clear. Silent and permanent.
    //
    // Delivery 1: masked AND `SHIPPED` (a status in STATUS_SHOPEE_FORA_DA_JANELA),
    // so the stored diary really says `expirado` and there is a real latch to
    // survive.
    const c = cenario({
      detalhe: { ...detalheBRMascarado(), order_status: 'SHIPPED' } as ShopeeOrderDetailRow,
    });
    await importar(c);
    expect(c.db.store[PEDIDO_PATH]!.data.capturaComprador).toMatchObject({
      estado: 'expirado',
    });
    expect(c.db.store[PEDIDO_PATH]!.data.clientePedidoOuterRef).toBeNull();
    expect(c.db.idsEm('clientes')).toEqual([]);

    // Delivery 2: the SAME order, newer, with the buyer UNMASKED.
    c.getOrderDetail.mockResolvedValue({
      order_list: [{ ...detalheBR(), update_time: UPDATE_TIME_S + 60, order_status: 'SHIPPED' }],
    });
    await importar(c);

    const depois = c.db.store[PEDIDO_PATH]!.data;
    expect(depois.clientePedidoOuterRef).not.toBeNull();
    expect(depois.enderecoFiscalOuterRef).not.toBeNull();
    expect(c.db.idsEm('clientes')).toHaveLength(1);
    // ⚠️ And the diary is the OTHER fact, pinned separately: the record moves to
    // `capturado` because something WAS captured. The two are independent —
    // `orderPedidoTx.test.ts` pins the latch, this pins that the latch never
    // decides whether an attempt happens.
    expect(depois.capturaComprador).toMatchObject({ estado: 'capturado' });
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

/* -------------------------------------------------------------------------- */
/*                    os pagamentos (#1514, step 6)                            */
/* -------------------------------------------------------------------------- */

const PAGAMENTOS_PATH = `${PEDIDO_PATH}/pagamentos`;
const PAGAMENTO_ID = makePagamentoIdShopee(INT, ORDER_SN);

/**
 * Um `ZodError` DE VERDADE, vindo do schema de verdade — nunca um `Error`
 * qualquer com o nome trocado, que provaria só que um `throw` propaga.
 */
function zodErrorReal(): ZodError {
  const r = pagamentoSchema.safeParse({ valor: -1 });
  if (r.success) {
    throw new Error('o schema aceitou um valor negativo — este teste perdeu a âncora');
  }
  return r.error;
}

describe('importarPedidoShopee — os pagamentos', () => {
  it('grava o pagamento DEPOIS do pedido e ANTES dos incidentes', async () => {
    const c = cenario();
    const r = await importar(c);

    expect(r.acaoPagamentos).toBe('criado');
    expect(r.pagamentosGravados).toBe(1);
    expect(c.db.idsEm(PAGAMENTOS_PATH)).toEqual([PAGAMENTO_ID]);

    // ⚠️ A ORDEM é a asserção: o pedido tem de existir antes (a transação de
    // pagamento recusa um ancestral ausente) e os incidentes vêm depois, porque
    // eles leem o snapshot que a transação do pedido enxergou.
    const ordem = c.db.caminhos;
    const iPedido = ordem.indexOf(PEDIDO_PATH);
    const iPagamento = ordem.indexOf(PAGAMENTOS_PATH);
    const iIncidente = ordem.findIndex((p) => p.includes('/incidentes'));
    expect(iPedido).toBeGreaterThanOrEqual(0);
    expect(iPagamento).toBeGreaterThan(iPedido);
    expect(iIncidente).toBeGreaterThan(iPagamento);
  });

  it('⚠️ `ignorado-sem-mudanca` no pedido NÃO pula o pagamento', async () => {
    const c = cenario();
    await importar(c);
    c.db.caminhos.length = 0;

    const r = await importar(c);

    // O escrow não tem relógio próprio: as tarifas podem andar enquanto a linha
    // da order não anda, então a segunda entrega TEM de entrar.
    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(c.db.caminhos).toContain(PAGAMENTOS_PATH);
    expect(r.acaoPagamentos).toBe('ignorado-sem-mudanca');
    expect(r.pagamentosGravados).toBe(0);
  });

  it('`ignorado-obsoleto` no pedido PULA o pagamento inteiro', async () => {
    const c = cenario();
    await importar(c);
    c.getOrderDetail.mockResolvedValue({
      order_list: [linha({ order_status: 'UNPAID', update_time: UPDATE_TIME_S - 60 })],
    });
    c.db.caminhos.length = 0;

    const r = await importar(c);

    expect(r.acao).toBe('ignorado-obsoleto');
    expect(r.acaoPagamentos).toBeNull();
    expect(r.pagamentosGravados).toBe(0);
    expect(c.db.caminhos).not.toContain(PAGAMENTOS_PATH);
  });

  it('`ignorado-inexistente` nunca chega no pagamento', async () => {
    const c = cenario();
    c.getOrderDetail.mockRejectedValue(erroApi(SHOPEE_ERRO_ORDER_NOT_FOUND));

    const r = await importar(c);

    expect(r.acao).toBe('ignorado-inexistente');
    expect(r.acaoPagamentos).toBeNull();
    expect(r.pagamentosGravados).toBe(0);
    expect(c.db.caminhos).not.toContain(PAGAMENTOS_PATH);
  });

  it('⚠️ um ZodError da escrita do pagamento PROPAGA — este módulo não converte erro nenhum', async () => {
    const c = cenario();
    const erro = zodErrorReal();
    // Âncora: o objeto injetado é mesmo o que o schema de escrita produz.
    expect(erro.name).toBe('ZodError');
    expect(erro.issues.length).toBeGreaterThan(0);
    pag.erro = erro;

    // Regra 6: nada é capturado aqui. Quem decide a disposição é o braço da
    // notificação (`disposicaoDaFalhaDeImportacao` PARQUEIA um ZodError).
    await expect(importar(c)).rejects.toBe(erro);
    // O pedido já tinha sido gravado — o parque é sobre a notificação, não um
    // rollback que o Firestore não tem.
    expect(c.db.store[PEDIDO_PATH]).toBeDefined();
  });

  it('a linha de log do import carrega os números do pagamento e NENHUM dado sensível', async () => {
    const c = cenario({ detalhe: detalheBR() });
    await importar(c);

    const linhaDoImport = infos.find((args) => String(args[0]).includes('pedido importado'));
    expect(linhaDoImport).toBeDefined();
    const campos = linhaDoImport![1] as Record<string, unknown>;
    expect(campos.acaoPagamentos).toBe('criado');
    expect(campos.pagamentos).toBe(1);
    expect(campos.gruposPagamento).toEqual(expect.arrayContaining(['dados']));
    expect(campos.somaPagante).toBe(31.99);
    expect(campos.divergenciaDeSoma).toBe(0);
    expect(campos).toHaveProperty('tarifas');
    expect(campos).toHaveProperty('tarifasBrutas');
    // BR ⇒ a contagem de `payment_info` viaja (item 22 do registro settle-live).
    expect(campos.entradasPaymentInfo).toBe(0);

    // …e num pedido SG a chave nem aparece: "não se aplica" e "não veio nenhuma"
    // são fatos diferentes.
    const d = cenario();
    infos.length = 0;
    await importar(d);
    const sg = infos.find((args) => String(args[0]).includes('pedido importado'))![1] as Record<
      string,
      unknown
    >;
    expect(Object.prototype.hasOwnProperty.call(sg, 'entradasPaymentInfo')).toBe(false);

    // Nenhum log desta suíte carrega um CNPJ, um código de autorização ou um
    // campo do comprador.
    const tudo = [...infos, ...avisos]
      .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n');
    expect(tudo.length).toBeGreaterThan(0);
    // ⚠️ As âncoras da borda são obrigatórias e são a parte interessante: esta
    // linha de log carrega carimbos em MICROssegundos (16 dígitos), e um
    // `/\d{14}/` solto casaria dentro de qualquer um deles — um teste vermelho
    // por um µs legítimo é um teste que alguém desliga. O alvo é um CNPJ, que
    // tem exatamente 14 dígitos e não vive dentro de um número maior.
    expect(tudo).not.toMatch(/(?<!\d)\d{14}(?!\d)/);
    expect(tudo).not.toContain(CPF_FALSO);
    expect(tudo).not.toContain('AUT-');
    expect(tudo).not.toContain('buyer_');
  });

  it('Σ pagante do resultado bate com o `valorCobrado` que o pedido guardou', async () => {
    const c = cenario();
    await importar(c);
    const pedido = c.db.store[PEDIDO_PATH]!.data;
    const pagamento = c.db.store[`${PAGAMENTOS_PATH}/${PAGAMENTO_ID}`]!.data;
    expect(pagamento.valor).toBe(pedido.valorCobrado);
  });
});

/* -------------------------------------------------------------------------- */
/*                 step 7 — the code-3 BACKSTOP and its convergence            */
/* -------------------------------------------------------------------------- */

/** The SG body's own package, and the channel it rides. */
const PACOTE_SG = 'OFG242672552205937';
const CANAL_SG = 11006;
const SHIP_BY_DATE_S = 1789405354;

/** What a `get_package_detail` pull would observe for that same package. */
function observadoDoPull(over: Record<string, unknown> = {}) {
  return observadoDoPacoteDetalhe(
    shopeePackageDetailRowSchema.parse({
      order_sn: ORDER_SN,
      package_number: PACOTE_SG,
      fulfillment_status: 'LOGISTICS_READY',
      logistics_channel_id: CANAL_SG,
      ship_by_date: SHIP_BY_DATE_S,
      update_time: UPDATE_TIME_S,
      ...over,
    }),
  )!;
}

function freteDoPedido(db: FakeDb): Record<string, unknown> {
  return db.store[PEDIDO_PATH]!.data.freteInicial as Record<string, unknown>;
}

function salvarFrete(db: FakeDb, observados: PacoteObservadoShopee[], nowUs = NOW_US) {
  return salvarFreteShopee(asDb(db), {
    pedidoId: PEDIDO_ID,
    orderSn: ORDER_SN,
    observados,
    relogioDaOrdemUs: null,
    prazoDaOrdemUs: null,
    nowUs,
  });
}

describe('importarPedidoShopee — o frete (passo 7)', () => {
  it('35 — grava o frete DEPOIS do pedido e DEPOIS dos pagamentos', async () => {
    const c = cenario();

    const r = await importar(c);

    expect(r.acaoFrete).toBe('atualizado');
    expect(r.pacotesGravados).toBe(1);

    // ⚠️ A ORDEM é a asserção: a transação de frete recusa um pedido ausente, e
    // ela é a TERCEIRA — o pagamento tem de ter entrado antes, senão um
    // `ZodError` do frete pararia a importação com o dinheiro por gravar.
    const escritas = c.db.writes.map((w) => w.path);
    const iPedido = escritas.indexOf(PEDIDO_PATH);
    const iPagamento = escritas.findIndex((p) => p.startsWith(`${PAGAMENTOS_PATH}/`));
    const iFrete = escritas.lastIndexOf(PEDIDO_PATH);
    expect(iPedido).toBe(0);
    expect(iPagamento).toBeGreaterThan(iPedido);
    expect(iFrete).toBeGreaterThan(iPagamento);
    // …e a última escrita no pedido é mesmo a do frete.
    expect(Object.keys(c.db.patches.at(-1)!.patch).sort()).toEqual([
      'freteInicial',
      'ultimaModificacao',
    ]);
  });

  it('35 — o diário sai do `package_list[]` que a MESMA chamada já trouxe — nenhuma chamada nova', async () => {
    const c = cenario();

    await importar(c);

    // O backstop não busca nada: uma segunda chamada Shopee aqui seria o custo
    // que ele existe para não pagar.
    expect(c.getOrderDetail).toHaveBeenCalledTimes(1);
    expect(c.getEscrowDetail).toHaveBeenCalledTimes(1);

    const frete = freteDoPedido(c.db);
    const pacotes = frete.pacotes as Record<string, unknown>[];
    expect(pacotes).toHaveLength(1);
    expect(pacotes[0]).toMatchObject({
      numero: PACOTE_SG,
      estadoMarketplace: 'LOGISTICS_READY',
      estado: ESTADO_FRETE.despachoAutorizado,
      canalId: String(CANAL_SG),
      // ⚠️ R2: uma order de UM pacote herda o prazo da ORDEM — em µs, convertido
      // uma vez na fronteira. Um valor em segundos aqui cairia em 1970.
      prazoDespacho: microsDeSegundosShopee(SHIP_BY_DATE_S),
      atualizadoEm: microsDeSegundosShopee(UPDATE_TIME_S),
      fonte: 'get_order_detail',
    });
    // `get_order_detail` não carrega rastreio nenhum — e um null nunca apaga.
    expect(pacotes[0]!.codRastreio).toBeNull();
  });

  it('36 — `ignorado-sem-mudanca` no pedido NÃO pula o frete', async () => {
    const c = cenario();
    await importar(c);
    // ⚠️ A entrega seguinte difere em UMA coisa só: o `logistics_status` do
    // PACOTE. Nada que `mesmoFrete` compare mudou — os sete campos refrescáveis
    // não incluem nenhum deles, e `mapearFreteInicialShopee` nem lê esse campo —
    // então o pedido responde `ignorado-sem-mudanca` enquanto o pacote andou.
    // É exatamente por isso que esse desfecho não pula o braço do frete.
    const pacote = detalheSG().package_list![0]!;
    c.getOrderDetail.mockResolvedValue({
      order_list: [
        linha({ package_list: [{ ...pacote, logistics_status: 'LOGISTICS_PICKUP_DONE' }] }),
      ],
    });
    c.db.caminhos.length = 0;
    c.db.writes.length = 0;

    const r = await importar(c);

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(r.acaoFrete).toBe('atualizado');
    expect(r.pacotesGravados).toBe(1);
    expect(freteDoPedido(c.db).estado).toBe(ESTADO_FRETE.postado);
    // O pedido FOI escrito — pela transação do frete, e só por ela.
    expect(c.db.writes.filter((w) => w.path === PEDIDO_PATH)).toHaveLength(1);
    expect(Object.keys(c.db.patches.at(-1)!.patch).sort()).toEqual([
      'freteInicial',
      'ultimaModificacao',
    ]);
  });

  it('36 — ⚠️ QUASE-ERRO: a fonte de fidelidade MENOR ainda SOBRESCREVE o token', async () => {
    // A propriedade real, pinada porque a prova de convergência do relatório de
    // desenho a descreve como "a chamada do pacote ganha": ganha o RELÓGIO e a
    // FONTE, não o token. `estadoMarketplace` é take-new-when-present por
    // desenho (§5.4: um fill-or-keep no token tornaria a máquina de estados de
    // mão única e um `PICKUP_RETRY` depois de um `PICKUP_FAILED` inalcançável),
    // então um detalhe de ORDER mais velho que o pull realmente reescreve o
    // token — e o diário volta a dizer READY. As duas redes que contêm o dano
    // são a escada (o estado do BLOCO não regride) e o relógio/fonte, que não
    // são re-carimbados. Se um dia as duas leituras divergirem ao vivo (item 28
    // do registro), isto é o que acontece.
    const c = cenario();
    await importar(c);
    await salvarFrete(c.db, [observadoDoPull({ fulfillment_status: 'LOGISTICS_PICKUP_DONE' })]);
    expect(freteDoPedido(c.db).estado).toBe(ESTADO_FRETE.postado);

    const r = await importar(c);

    expect(r.acaoFrete).toBe('atualizado');
    const pacotes = freteDoPedido(c.db).pacotes as Record<string, unknown>[];
    expect(pacotes[0]!.estadoMarketplace).toBe('LOGISTICS_READY');
    // Rede 1: o estado do BLOCO não anda para trás.
    expect(freteDoPedido(c.db).estado).toBe(ESTADO_FRETE.postado);
    // Rede 2: nem o relógio nem a fonte do pull são re-carimbados.
    expect(pacotes[0]!.fonte).toBe('get_package_detail');
  });

  it('36 — `ignorado-obsoleto` no pedido PULA o frete inteiro', async () => {
    const c = cenario();
    await importar(c);
    c.getOrderDetail.mockResolvedValue({
      order_list: [linha({ order_status: 'UNPAID', update_time: UPDATE_TIME_S - 60 })],
    });
    c.db.writes.length = 0;

    const r = await importar(c);

    expect(r.acao).toBe('ignorado-obsoleto');
    expect(r.acaoFrete).toBeNull();
    expect(r.pacotesGravados).toBe(0);
    expect(c.db.writes).toEqual([]);
  });

  it('36 — `ignorado-inexistente` nunca chega no frete', async () => {
    const c = cenario();
    c.getOrderDetail.mockRejectedValue(erroApi(SHOPEE_ERRO_ORDER_NOT_FOUND));

    const r = await importar(c);

    expect(r.acao).toBe('ignorado-inexistente');
    expect(r.acaoFrete).toBeNull();
    expect(r.pacotesGravados).toBe(0);
  });

  it('37 — CONVERGÊNCIA: uma escrita do PULL e depois um import ⇒ patch vazio, ZERO escritas', async () => {
    const c = cenario();
    await importar(c);

    // A entrega por push: o MESMO estado físico, pela fonte de fidelidade maior,
    // trazendo o rastreio que o detalhe da order não tem.
    const push = await salvarFrete(c.db, [observadoDoPull({ tracking_number: 'BR000000001BR' })]);
    expect(push.acao).toBe('atualizado');
    expect(push.campos).toEqual(['freteInicial.codRastreio', 'freteInicial.pacotes']);

    c.db.writes.length = 0;
    const antes = structuredClone(c.db.store[PEDIDO_PATH]!.data);

    const r = await importar(c);

    // ⚠️ A prova de §7.2: a mesma tabela lê os dois vocabulários, o rastreio
    // sobrevive por fill-or-keep e a fonte de fidelidade MENOR não re-carimba o
    // relógio — então o documento fica byte-idêntico.
    expect(r.acaoFrete).toBe('ignorado-sem-mudanca');
    expect(c.db.writes.filter((w) => w.path === PEDIDO_PATH)).toEqual([]);
    expect(c.db.store[PEDIDO_PATH]!.data).toEqual(antes);
    expect(freteDoPedido(c.db).codRastreio).toBe('BR000000001BR');
  });

  it('38 — a ordem INVERSA: import, depois pull ⇒ exatamente UMA escrita, e depois estável', async () => {
    const c = cenario();
    await importar(c);
    c.db.writes.length = 0;

    const primeira = await salvarFrete(c.db, [
      observadoDoPull({ tracking_number: 'BR000000001BR' }),
    ]);
    expect(primeira.acao).toBe('atualizado');
    expect(c.db.writes.filter((w) => w.path === PEDIDO_PATH)).toHaveLength(1);
    // A fonte de fidelidade MAIOR carimba o relógio do PACOTE e toma a fonte.
    const linhaDoDiario = (freteDoPedido(c.db).pacotes as Record<string, unknown>[])[0]!;
    expect(linhaDoDiario.fonte).toBe('get_package_detail');

    const segunda = await salvarFrete(
      c.db,
      [observadoDoPull({ tracking_number: 'BR000000001BR' })],
      NOW_US + 900_000_000,
    );

    expect(segunda.acao).toBe('ignorado-sem-mudanca');
    expect(c.db.writes.filter((w) => w.path === PEDIDO_PATH)).toHaveLength(1);
  });

  it('38 — dois imports seguidos, sem o pacote andar, não escrevem nada no segundo', async () => {
    const c = cenario();
    await importar(c);
    c.db.writes.length = 0;

    const r = await importar(c);

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(r.acaoFrete).toBe('ignorado-sem-mudanca');
    expect(c.db.writes.filter((w) => w.path === PEDIDO_PATH)).toEqual([]);
  });

  it('39 — a linha de log carrega acaoFrete/estadoFrete/pacotes e NENHUM payload de pacote', async () => {
    const c = cenario();
    await importar(c);

    const linhaDoImport = infos.find((args) => String(args[0]).includes('pedido importado'));
    const campos = linhaDoImport![1] as Record<string, unknown>;
    expect(campos.acaoFrete).toBe('atualizado');
    expect(campos.estadoFrete).toBe(ESTADO_FRETE.despachoAutorizado);
    expect(campos.motivoFrete).toBeNull();
    expect(campos.pacotes).toBe(1);
    expect(campos.tokensFreteDesconhecidos).toEqual([]);

    // ⚠️ Nada do pacote em si: o `get_order_detail.package_list[]` carrega um
    // `shipping_carrier` e um `product_location_id`, e nenhum dos dois é um id
    // que um log deste canal deva repetir.
    const tudo = [...infos, ...avisos]
      .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n');
    expect(tudo).toContain('pedido importado');
    expect(tudo).not.toContain('Standard Express');
    expect(tudo).not.toContain('SGZ');
    expect(tudo).not.toContain('shipping_carrier');
  });
});
