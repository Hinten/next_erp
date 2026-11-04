/**
 * `searchOrders` (step 4) and `getOrder` (step 5): the response schemas and the
 * one helper each caller uses. Collected because it lives under `test/` (the
 * package's vitest `include`), where the `semRede` kill-switch runs too: every
 * request here is served by an injected fetch, never the network (D11).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { MARKETPLACE_ID_BR, type SpApiLeituraClient, criarClienteSpApi } from '../src/client';
import { AmazonConfigError, AmazonError, AmazonHttpError, AmazonSchemaError } from '../src/errors';
import {
  CAMINHO_SEARCH_ORDERS,
  DADOS_INCLUIDOS_GET_ORDER,
  OPERACAO_GET_ORDER,
  OPERACAO_SEARCH_ORDERS,
  type OpcoesGetOrder,
  buscarPedido,
  buscarPedidosAtualizados,
  caminhoGetOrder,
  respostaGetOrderSchema,
  respostaSearchOrdersSchema,
} from '../src/pedidos';
import { pedidoWireAmazonSchema } from '../src/types';
import { getOrder200, searchOrders200, searchOrders200ComPacotes } from './_fixtures/sandbox';
import {
  ACCESS_TOKEN,
  USER_AGENT,
  falha,
  fetchQueNuncaResponde,
  json,
  mockFetch,
  observar,
  requisicao,
  texto,
  verificarFormaDasRequisicoes,
} from './_helpers/mockFetch';

afterEach(verificarFormaDasRequisicoes);

/** A deep copy of the BR example, to build variants from IN TEST CODE (never a new fixture). */
function exemplo(): Record<string, unknown> & { orders: Record<string, unknown>[] } {
  return structuredClone(searchOrders200) as unknown as Record<string, unknown> & {
    orders: Record<string, unknown>[];
  };
}

function cliente(fetch: typeof globalThis.fetch): SpApiLeituraClient {
  return criarClienteSpApi({
    obterCredencial: () => ({ accessToken: ACCESS_TOKEN, ref: 'ref-A' }),
    userAgent: USER_AGENT,
    fetch,
    gerarCorrelationId: () => 'corr-1',
    agora: () => 1_000,
  });
}

const FILTRO = {
  lastUpdatedAfter: '2027-01-15T09:50:00Z',
  marketplaceIds: MARKETPLACE_ID_BR,
  maxResultsPerPage: 100,
} as const;

describe('the constants', () => {
  it('pins the Orders v2026-01-01 list path and the model operation id', () => {
    expect(CAMINHO_SEARCH_ORDERS).toBe('/orders/2026-01-01/orders');
    expect(OPERACAO_SEARCH_ORDERS).toBe('searchOrders');
  });
});

describe('respostaSearchOrdersSchema', () => {
  it('parses the BR sandbox example (no pagination: the last page)', () => {
    const lida = respostaSearchOrdersSchema.parse(exemplo());
    expect(lida.orders).toHaveLength(1);
    expect(lida.pagination).toBeUndefined();
    expect(lida.createdBefore).toBe('2024-12-22T16:00:00Z');
    expect(lida.lastUpdatedBefore).toBeUndefined();
  });

  it('a variant with nextToken and the echoed lastUpdatedBefore parses; both are read', () => {
    const corpo = {
      ...exemplo(),
      pagination: { nextToken: 'token-pagina-2' },
      lastUpdatedBefore: '2027-01-15T10:00:00Z',
    };
    const lida = respostaSearchOrdersSchema.parse(corpo);
    expect(lida.pagination?.nextToken).toBe('token-pagina-2');
    expect(lida.lastUpdatedBefore).toBe('2027-01-15T10:00:00Z');
  });

  it('an empty page parses', () => {
    expect(respostaSearchOrdersSchema.parse({ ...exemplo(), orders: [] }).orders).toEqual([]);
  });

  it('a row with NO orderItems still parses — rows are the caller’s to validate, one by one', () => {
    const corpo = exemplo();
    const [linha] = corpo.orders;
    if (linha === undefined) throw new Error('o exemplo tem uma linha');
    delete linha.orderItems;
    const lida = respostaSearchOrdersSchema.safeParse(corpo);
    expect(lida.success).toBe(true);
    // …and so does a row that is not even an object: the PAGE never fails for a row.
    expect(respostaSearchOrdersSchema.safeParse({ orders: [null, 'x', 7] }).success).toBe(true);
  });

  it('keeps unknown keys (passthrough), on the page and on pagination', () => {
    const lida = respostaSearchOrdersSchema.parse({
      orders: [],
      novoCampo: 1,
      pagination: { nextToken: 't', outro: true },
    }) as Record<string, unknown> & { pagination?: Record<string, unknown> };
    expect(lida.novoCampo).toBe(1);
    expect(lida.pagination?.outro).toBe(true);
  });

  it('refuses a page without orders, an EMPTY nextToken and a non-string token', () => {
    const { orders: _semOrders, ...semOrders } = exemplo();
    expect(respostaSearchOrdersSchema.safeParse(semOrders).success).toBe(false);
    expect(
      respostaSearchOrdersSchema.safeParse({ ...exemplo(), pagination: { nextToken: '' } }).success,
    ).toBe(false);
    expect(
      respostaSearchOrdersSchema.safeParse({ ...exemplo(), pagination: { nextToken: 5 } }).success,
    ).toBe(false);
    // Near-miss: a pagination object with no token at all is the last page, not an error.
    expect(respostaSearchOrdersSchema.safeParse({ ...exemplo(), pagination: {} }).success).toBe(
      true,
    );
  });
});

describe('buscarPedidosAtualizados', () => {
  it('GETs the list path with exactly lastUpdatedAfter, marketplaceIds and maxResultsPerPage', async () => {
    const f = mockFetch(() => json(searchOrders200));
    const r = await buscarPedidosAtualizados(cliente(f), FILTRO);
    expect(r.dados.orders).toHaveLength(1);
    const alvo = requisicao(f).url;
    expect(alvo.pathname).toBe(CAMINHO_SEARCH_ORDERS);
    expect([...alvo.searchParams.keys()].sort()).toEqual(
      ['lastUpdatedAfter', 'marketplaceIds', 'maxResultsPerPage'].sort(),
    );
    expect(alvo.searchParams.get('lastUpdatedAfter')).toBe(FILTRO.lastUpdatedAfter);
    expect(alvo.searchParams.get('maxResultsPerPage')).toBe('100');
  });

  it('sends the token on a later page, and only then', async () => {
    const f = mockFetch(() => json(searchOrders200));
    await buscarPedidosAtualizados(cliente(f), { ...FILTRO, paginationToken: 'token+/=2' });
    const alvo = requisicao(f).url;
    expect(alvo.searchParams.get('paginationToken')).toBe('token+/=2');
    // A null token is the first page: no key at all.
    const g = mockFetch(() => json(searchOrders200));
    await buscarPedidosAtualizados(cliente(g), { ...FILTRO, paginationToken: null });
    expect(requisicao(g).url.searchParams.has('paginationToken')).toBe(false);
  });

  it('marketplaceIds is ONE comma-separated query value (client.ts), encoded as %2C', async () => {
    const f = mockFetch(() => json(searchOrders200));
    await buscarPedidosAtualizados(cliente(f), {
      ...FILTRO,
      marketplaceIds: `${MARKETPLACE_ID_BR},ATVPDKIKX0DER`,
    });
    const { url } = requisicao(f);
    expect(url.href).toContain(`marketplaceIds=${MARKETPLACE_ID_BR}%2CATVPDKIKX0DER`);
    expect(url.searchParams.getAll('marketplaceIds')).toEqual([
      `${MARKETPLACE_ID_BR},ATVPDKIKX0DER`,
    ]);
  });

  it('NEVER sends lastUpdatedBefore, includedData, fulfilledBy or fulfillmentStatuses — even when the caller’s object carries them', async () => {
    const f = mockFetch(() => json(searchOrders200));
    const comExtras = {
      ...FILTRO,
      lastUpdatedBefore: '2027-01-15T10:00:00Z',
      includedData: 'BUYER,RECIPIENT',
      fulfilledBy: 'MERCHANT',
      fulfillmentStatuses: 'UNSHIPPED',
      createdAfter: '2027-01-01T00:00:00Z',
    };
    await buscarPedidosAtualizados(cliente(f), comExtras);
    const chaves = [...requisicao(f).url.searchParams.keys()];
    for (const proibida of [
      'lastUpdatedBefore',
      'includedData',
      'fulfilledBy',
      'fulfillmentStatuses',
      'createdAfter',
    ]) {
      expect(chaves, proibida).not.toContain(proibida);
    }
  });

  it('a page outside the schema is the client’s AmazonSchemaError', async () => {
    const f = mockFetch(() => json({ pedidos: [] }));
    const err = await falha(buscarPedidosAtualizados(cliente(f), FILTRO));
    expect(err).toBeInstanceOf(AmazonSchemaError);
  });

  it('labels the call with the model operation id', async () => {
    const operacoes: string[] = [];
    const c = criarClienteSpApi({
      obterCredencial: () => ({ accessToken: ACCESS_TOKEN, ref: 'ref-A' }),
      userAgent: USER_AGENT,
      fetch: mockFetch(() => json(searchOrders200)),
      gerarCorrelationId: () => 'corr-1',
      agora: () => 1_000,
      onChamada: (e) => operacoes.push(e.operacao),
    });
    await buscarPedidosAtualizados(c, FILTRO);
    expect(operacoes).toEqual([OPERACAO_SEARCH_ORDERS]);
  });
});

/* -------------------------------------------------------------------------- */
/*                             getOrder (step 5)                              */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

/** The model's own getOrder example id (static[0]): Amazon's, not an order of ours. */
const ID_DO_MODELO = '171-9876543-2109876';

/** The eight datasets, spelled out: never derived from the constant under test. */
const INCLUDED_DATA = 'BUYER,RECIPIENT,TAX,PAYMENT,PROCEEDS,FULFILLMENT,PACKAGES,CANCELLATION';

/** A deep copy of the BR getOrder example, to build variants from IN TEST CODE (never a new fixture). */
function exemploGetOrder(): Json & { order: Json & { orderItems: Json[] } } {
  return structuredClone(getOrder200) as unknown as Json & {
    order: Json & { orderItems: Json[] };
  };
}

/** The example's one line, mutable. */
function linhaDe(corpo: { order: { orderItems: Json[] } }): Json & { product: Json } {
  const [linha] = corpo.order.orderItems;
  if (linha === undefined) throw new Error('o exemplo tem uma linha');
  return linha as Json & { product: Json };
}

/** The UK searchOrders example's one order, as a getOrder body: the only model example with `packages`. */
function exemploComPacotes(): Json & { order: Json & { packages: Json[] } } {
  const pagina = structuredClone(searchOrders200ComPacotes) as unknown as { orders: Json[] };
  const [ordem] = pagina.orders;
  if (ordem === undefined) throw new Error('o exemplo tem um pedido');
  return { order: ordem as Json & { packages: Json[] } };
}

/** `corpo` with `valor` written at `caminho`, creating the objects and arrays on the way. */
function comValorEm(corpo: Json, caminho: readonly (string | number)[], valor: unknown): Json {
  let alvo = corpo as Record<string | number, unknown>;
  caminho.forEach((chave, i) => {
    if (i === caminho.length - 1) {
      alvo[chave] = valor;
      return;
    }
    if (alvo[chave] === undefined || alvo[chave] === null) {
      alvo[chave] = typeof caminho[i + 1] === 'number' ? [] : {};
    }
    alvo = alvo[chave] as Record<string | number, unknown>;
  });
  return corpo;
}

/** The value at `caminho` of a parsed body. */
function valorEm(dados: unknown, caminho: readonly (string | number)[]): unknown {
  return caminho.reduce<unknown>(
    (atual, chave) =>
      atual !== null && typeof atual === 'object'
        ? (atual as Record<string | number, unknown>)[chave]
        : undefined,
    dados,
  );
}

/** The keys a (nullish-wrapped) object schema DECLARES. */
function chavesDeclaradas(s: z.ZodType): string[] {
  let atual: z.ZodType = s;
  while (atual instanceof z.ZodOptional || atual instanceof z.ZodNullable) {
    atual = atual.unwrap() as z.ZodType;
  }
  if (!(atual instanceof z.ZodObject)) throw new Error('não é um objeto');
  return Object.keys(atual.shape);
}

/** The schema a (nullish-wrapped) object schema declares under `chave`. */
function declarado(s: z.ZodType, chave: string): z.ZodType {
  let atual: z.ZodType = s;
  while (
    atual instanceof z.ZodOptional ||
    atual instanceof z.ZodNullable ||
    atual instanceof z.ZodArray
  ) {
    atual = (atual instanceof z.ZodArray ? atual.element : atual.unwrap()) as z.ZodType;
  }
  if (!(atual instanceof z.ZodObject)) throw new Error('não é um objeto');
  const filho = (atual.shape as Record<string, z.ZodType | undefined>)[chave];
  if (filho === undefined) throw new Error(`${chave} não é declarado`);
  return filho;
}

describe('getOrder: the constants', () => {
  it('pins the model operation id and the one-order path', () => {
    expect(OPERACAO_GET_ORDER).toBe('getOrder');
    expect(caminhoGetOrder(ID_DO_MODELO)).toBe('/orders/2026-01-01/orders/171-9876543-2109876');
  });

  it('requests EXACTLY the eight production datasets, in order, frozen', () => {
    expect([...DADOS_INCLUIDOS_GET_ORDER]).toEqual(INCLUDED_DATA.split(','));
    expect(Object.isFrozen(DADOS_INCLUIDOS_GET_ORDER)).toBe(true);
    // NEAR-MISS: the three datasets the model offers and no step reads yet.
    for (const fora of ['FULFILLMENT_ORDERS', 'EXPENSE', 'PROMOTION']) {
      expect(DADOS_INCLUIDOS_GET_ORDER as readonly string[], fora).not.toContain(fora);
    }
  });
});

describe('respostaGetOrderSchema', () => {
  it('parses the model example; the keyed fields read, an undeclared one survives (passthrough)', () => {
    const lida = respostaGetOrderSchema.parse(exemploGetOrder());
    expect(lida.order.orderId).toBe('000-0000000-2412538');
    expect(lida.order.lastUpdatedTime).toBe('2024-12-25T08:15:00Z');
    expect(lida.order.fulfillment?.fulfillmentStatus).toBe('UNSHIPPED');
    expect(lida.order.fulfillment?.shipByWindow?.latestDateTime).toBe('2024-12-27T23:59:59Z');
    const [linha] = lida.order.orderItems ?? [];
    expect(linha?.orderItemId).toBe('00000253581152');
    expect(linha?.quantityOrdered).toBe(1);
    expect(linha?.product?.price?.unitPrice?.amount).toBe('299.90');
    expect(valorEm(lida, ['order', 'proceeds', 'grandTotal', 'amount'])).toBe('299.90');
    expect(valorEm(lida, ['order', 'fulfillment', 'labelPrintingWindow'])).toEqual({
      earliestDateTime: '2024-12-26T17:00:00Z',
    });
  });

  it('an order with orderItems deleted, null or [] parses — an item-less cancelled order (D17)', () => {
    const semItens = exemploGetOrder();
    delete (semItens.order as Json).orderItems;
    expect(respostaGetOrderSchema.parse(semItens).order.orderItems).toBeUndefined();
    for (const itens of [null, []]) {
      const corpo = comValorEm(exemploGetOrder(), ['order', 'orderItems'], itens);
      expect(respostaGetOrderSchema.parse(corpo).order.orderItems).toEqual(itens);
    }
  });

  it.each<[string, (linha: Json & { product: Json }) => void]>([
    ['quantityOrdered absent', (l) => void delete l.quantityOrdered],
    ['quantityOrdered null', (l) => void (l.quantityOrdered = null)],
    ['no product', (l) => void delete (l as Json).product],
    ['a product without price', (l) => void delete l.product.price],
    ['a price without unitPrice', (l) => void (l.product.price = {})],
  ])('a line with %s parses (C1 item 4b: a cancelled line may drop it)', (_caso, mudar) => {
    const corpo = exemploGetOrder();
    mudar(linhaDe(corpo));
    const lida = respostaGetOrderSchema.safeParse(corpo);
    expect(lida.success).toBe(true);
    expect(lida.data?.order.orderItems?.[0]?.orderItemId).toBe('00000253581152');
  });

  it('the model’s own package example (searchOrders static[1], non-BR) parses, and its package reads', () => {
    const lida = respostaGetOrderSchema.parse(exemploComPacotes());
    const [pacote] = lida.order.packages ?? [];
    expect(pacote?.packageReferenceId).toBe('PKG-Z00000202');
    expect(pacote?.packageStatus?.status).toBe('IN_TRANSIT');
    expect(pacote?.packageStatus?.detailedStatus).toBe('OUT_FOR_DELIVERY');
    expect(pacote?.trackingNumber).toBe('TRKZ0000000202');
    expect(pacote?.packageItems?.[0]?.quantity).toBe(1);
    expect(lida.order.orderItems?.[0]?.measurement).toEqual({ unit: 'COUNT', value: 1 });
  });

  it.each<[string, unknown]>([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
  ])(
    'a package whose packageReferenceId is %s parses — the fold decides, never the parser',
    (_caso, ref) => {
      const corpo = exemploComPacotes();
      const [pacote] = corpo.order.packages;
      if (pacote === undefined) throw new Error('o exemplo tem um pacote');
      if (ref === undefined) delete pacote.packageReferenceId;
      else pacote.packageReferenceId = ref;
      const lida = respostaGetOrderSchema.safeParse(corpo);
      expect(lida.success).toBe(true);
      expect(lida.data?.order.packages?.[0]?.packageReferenceId).toBe(ref);
    },
  );

  it.each(['INVOICE_UNCONFIRMED', 'SOMETHING_NEW'])(
    'a fulfillmentStatus of %s parses and reads verbatim (an open string, never an enum)',
    (status) => {
      const corpo = comValorEm(
        exemploGetOrder(),
        ['order', 'fulfillment', 'fulfillmentStatus'],
        status,
      );
      expect(respostaGetOrderSchema.parse(corpo).order.fulfillment?.fulfillmentStatus).toBe(status);
    },
  );

  it.each(
    (
      [
        ['order', 'fulfillment', 'fulfilledBy'],
        ['order', 'programs', 0],
        ['order', 'packages', 0, 'packageStatus', 'status'],
        ['order', 'packages', 0, 'packageStatus', 'detailedStatus'],
        ['order', 'payment', 'paymentExecutions', 0, 'paymentMethod'],
        ['order', 'payment', 'paymentExecutions', 0, 'cardBrand'],
        ['order', 'tax', 'taxInvoicing', 'invoiceStatus'],
        ['order', 'tax', 'taxRegistrations', 0, 'entityType'],
        ['order', 'tax', 'taxRegistrations', 0, 'taxRegistrationType'],
        ['order', 'recipient', 'deliveryAddress', 'addressType'],
        ['order', 'proceeds', 'breakdowns', 0, 'type'],
        ['order', 'orderItems', 0, 'proceeds', 'breakdowns', 0, 'type'],
        ['order', 'orderItems', 0, 'proceeds', 'breakdowns', 0, 'detailedBreakdowns', 0, 'subtype'],
        ['order', 'orderItems', 0, 'measurement', 'unit'],
      ] as const
    ).map((caminho) => [caminho] as const),
  )('an unknown value at %j parses and reads verbatim', (caminho) => {
    const corpo = comValorEm(exemploGetOrder(), caminho, 'VALOR_NOVO_DA_AMAZON');
    const lida = respostaGetOrderSchema.safeParse(corpo);
    expect(lida.success).toBe(true);
    expect(valorEm(lida.data, caminho)).toBe('VALOR_NOVO_DA_AMAZON');
  });

  it.each<[string, unknown]>([
    ['"1e3"', '1e3'],
    ['""', ''],
    ['12.5 (a JSON number)', 12.5],
    ['null', null],
  ])(
    'a money amount of %s parses and stays VERBATIM — the app’s reader decides',
    (_caso, valor) => {
      const caminho = ['order', 'orderItems', 0, 'product', 'price', 'unitPrice', 'amount'];
      const corpo = comValorEm(exemploGetOrder(), caminho, valor);
      const lida = respostaGetOrderSchema.safeParse(corpo);
      expect(lida.success).toBe(true);
      expect(valorEm(lida.data, caminho)).toBe(valor);
    },
  );

  it('a money object without amount parses too (absent, never 0)', () => {
    const corpo = exemploGetOrder();
    linhaDe(corpo).product.price = { unitPrice: { currencyCode: 'BRL' } };
    const lida = respostaGetOrderSchema.parse(corpo);
    expect(lida.order.orderItems?.[0]?.product?.price?.unitPrice?.amount).toBeUndefined();
  });

  it('a quoted integer reads as a number; a non-integer refuses (the model’s type is integer)', () => {
    const corpo = exemploGetOrder();
    linhaDe(corpo).quantityOrdered = '2';
    linhaDe(corpo).fulfillment = { quantityFulfilled: '0', quantityUnfulfilled: '2' };
    const lida = respostaGetOrderSchema.parse(corpo);
    expect(lida.order.orderItems?.[0]?.quantityOrdered).toBe(2);
    expect(lida.order.orderItems?.[0]?.fulfillment?.quantityUnfulfilled).toBe(2);
    for (const ruim of ['2.5', 2.5, 'dois', '']) {
      const outro = exemploGetOrder();
      linhaDe(outro).quantityOrdered = ruim;
      expect(respostaGetOrderSchema.safeParse(outro).success, String(ruim)).toBe(false);
    }
    // The package quantity and the measured value go through the same tolerance.
    const comPacotes = exemploComPacotes();
    const [pacote] = comPacotes.order.packages;
    if (pacote === undefined) throw new Error('o exemplo tem um pacote');
    pacote.packageItems = [{ quantity: '1' }];
    comValorEm(comPacotes, ['order', 'orderItems', 0, 'measurement', 'value'], '0.5');
    const lidaComPacotes = respostaGetOrderSchema.parse(comPacotes);
    expect(lidaComPacotes.order.packages?.[0]?.packageItems?.[0]?.quantity).toBe(1);
    expect(lidaComPacotes.order.orderItems?.[0]?.measurement?.value).toBe(0.5);
  });

  it('a line without orderItemId (or with an empty one) refuses the WHOLE order — never a silently dropped line', () => {
    const semId = exemploGetOrder();
    delete linhaDe(semId).orderItemId;
    const lida = respostaGetOrderSchema.safeParse(semId);
    expect(lida.success).toBe(false);
    expect(lida.error?.issues.map((i) => i.path.join('.'))).toEqual([
      'order.orderItems.0.orderItemId',
    ]);
    const vazio = exemploGetOrder();
    linhaDe(vazio).orderItemId = '';
    expect(respostaGetOrderSchema.safeParse(vazio).success).toBe(false);
    // A valid line beside it does not save the order: all or nothing.
    const duas = exemploGetOrder();
    duas.order.orderItems.push({ ...linhaDe(exemploGetOrder()), orderItemId: undefined });
    expect(respostaGetOrderSchema.safeParse(duas).success).toBe(false);
  });

  it('orderId and lastUpdatedTime are required strings (a key is built from each); createdTime is not', () => {
    for (const chave of ['orderId', 'lastUpdatedTime']) {
      const sem = exemploGetOrder();
      delete sem.order[chave];
      expect(respostaGetOrderSchema.safeParse(sem).success, `${chave} ausente`).toBe(false);
      const nulo = comValorEm(exemploGetOrder(), ['order', chave], null);
      expect(respostaGetOrderSchema.safeParse(nulo).success, `${chave} null`).toBe(false);
    }
    // NEAR-MISS: a leaf no key is built from may be absent.
    const semCriacao = exemploGetOrder();
    delete semCriacao.order.createdTime;
    expect(respostaGetOrderSchema.safeParse(semCriacao).success).toBe(true);
    // …and so may the whole response wrapper's siblings, but never `order` itself.
    expect(respostaGetOrderSchema.safeParse({}).success).toBe(false);
  });

  it('never DECLARES buyer e-mail, cancel reasons, grandTotal, the phone or addressLine2 — passthrough keeps them unread', () => {
    const pedido = pedidoWireAmazonSchema;
    expect(chavesDeclaradas(declarado(pedido, 'buyer'))).not.toContain('buyerEmail');
    expect(chavesDeclaradas(declarado(pedido, 'proceeds'))).not.toContain('grandTotal');
    const endereco = chavesDeclaradas(declarado(declarado(pedido, 'recipient'), 'deliveryAddress'));
    for (const fora of ['phone', 'addressLine2', 'addressLine3']) {
      expect(endereco, fora).not.toContain(fora);
    }
    const cancelamento = declarado(declarado(pedido, 'orderItems'), 'cancellation');
    expect(chavesDeclaradas(declarado(cancelamento, 'cancellationExecution'))).toEqual([
      'cancelledBy',
    ]);
    expect(chavesDeclaradas(declarado(cancelamento, 'cancellationRequest'))).toEqual(['requester']);
    // Undeclared is not dropped: the parse keeps it, so drift stays visible.
    const corpo = exemploGetOrder();
    linhaDe(corpo).cancellation = {
      cancellationExecution: { cancelledBy: 'BUYER', cancelReason: 'texto livre' },
    };
    const lida = respostaGetOrderSchema.parse(corpo);
    expect(
      valorEm(lida, ['order', 'orderItems', 0, 'cancellation', 'cancellationExecution']),
    ).toEqual({ cancelledBy: 'BUYER', cancelReason: 'texto livre' });
  });
});

/* ------------- the tolerance, leaf by leaf: walked off the schema itself ------------- */

type Caminho = readonly (string | number)[];

/**
 * The ONLY declared paths that may refuse `null` or absence: the response's
 * `order` and the three leaves a key is built from. Everything else the schema
 * declares must take both (a withheld PII leaf's representation is a C1
 * checkpoint), so a new leaf is covered the moment it is declared.
 */
const CAMINHOS_ESTRITOS = [
  'order',
  'order.orderId',
  'order.lastUpdatedTime',
  'order.orderItems.0.orderItemId',
] as const;

/**
 * Every key path `s` DECLARES, depth first, and the path of every object schema
 * met on the way. Optional/nullable wrappers are unwrapped; an array steps into
 * its element as index 0, so a path never ends in an index.
 */
function percorrerSchema(
  s: z.ZodType,
  prefixo: Caminho = [],
  achados: { caminhos: Caminho[]; objetos: Caminho[] } = { caminhos: [], objetos: [] },
): { caminhos: Caminho[]; objetos: Caminho[] } {
  let atual: z.ZodType = s;
  let aqui = prefixo;
  for (;;) {
    if (atual instanceof z.ZodOptional || atual instanceof z.ZodNullable) {
      atual = atual.unwrap() as z.ZodType;
    } else if (atual instanceof z.ZodArray) {
      atual = atual.element as z.ZodType;
      aqui = [...aqui, 0];
    } else break;
  }
  if (!(atual instanceof z.ZodObject)) return achados;
  achados.objetos.push(aqui);
  for (const [chave, filho] of Object.entries(atual.shape as Record<string, z.ZodType>)) {
    const caminho = [...aqui, chave];
    achados.caminhos.push(caminho);
    percorrerSchema(filho, caminho, achados);
  }
  return achados;
}

/** `corpo` with the key at `caminho` DELETED, its parents created on the way. */
function semChaveEm(corpo: Json, caminho: Caminho): Json {
  comValorEm(corpo, caminho, null);
  const pai = valorEm(corpo, caminho.slice(0, -1)) as Record<string | number, unknown>;
  delete pai[caminho[caminho.length - 1] as string | number];
  return corpo;
}

const nomeDe = (c: Caminho) => c.join('.');
const ARVORE_GET_ORDER = percorrerSchema(respostaGetOrderSchema);
const TOLERANTES = ARVORE_GET_ORDER.caminhos.filter(
  (c) => !(CAMINHOS_ESTRITOS as readonly string[]).includes(nomeDe(c)),
);

describe('respostaGetOrderSchema: the tolerance, every declared path', () => {
  it('the walk is not vacuous: it reaches every strict path and the deep leaves', () => {
    const nomes = ARVORE_GET_ORDER.caminhos.map(nomeDe);
    expect(nomes).toEqual(
      expect.arrayContaining([
        ...CAMINHOS_ESTRITOS,
        'order.buyer.buyerName',
        'order.recipient.deliveryAddress.postalCode',
        'order.recipient.deliveryAddress.extendedFields.neighborhood',
        'order.payment.paymentExecutions.0.cardBrand',
        'order.tax.taxInvoicing.invoiceStatus',
        'order.fulfillment.fulfillmentStatus',
        'order.proceeds.breakdowns.0.subtotal.currencyCode',
        'order.orderItems.0.product.price.unitPrice.amount',
        'order.orderItems.0.fulfillment.quantityFulfilled',
        'order.packages.0.packageItems.0.quantity',
      ]),
    );
    expect(TOLERANTES.length).toBeGreaterThan(60);
    expect(nomes.some((n) => /\.\d+$/.test(n))).toBe(false);
  });

  it.each(TOLERANTES.map((c) => [nomeDe(c), c] as const))(
    '%s may be null or absent: the WHOLE order still parses',
    (_nome, caminho) => {
      const nulo = respostaGetOrderSchema.safeParse(comValorEm(exemploGetOrder(), caminho, null));
      expect(nulo.success, 'null').toBe(true);
      const ausente = respostaGetOrderSchema.safeParse(semChaveEm(exemploGetOrder(), caminho));
      expect(ausente.success, 'ausente').toBe(true);
    },
  );

  it.each(CAMINHOS_ESTRITOS.map((n) => [n, n.split('.').map((p) => (/^\d+$/.test(p) ? 0 : p))]))(
    'NEAR-MISS: %s refuses both null and absent (a key is built from it)',
    (_nome, caminho) => {
      const nulo = respostaGetOrderSchema.safeParse(comValorEm(exemploGetOrder(), caminho, null));
      expect(nulo.success, 'null').toBe(false);
      const ausente = respostaGetOrderSchema.safeParse(semChaveEm(exemploGetOrder(), caminho));
      expect(ausente.success, 'ausente').toBe(false);
    },
  );

  it.each(ARVORE_GET_ORDER.objetos.map((c) => [nomeDe(c) || '<the response>', c] as const))(
    'an unknown key on %s survives the parse (passthrough: never refused, never stripped)',
    (_nome, caminho) => {
      const alvo = [...caminho, 'chaveNovaDaAmazon'];
      const lida = respostaGetOrderSchema.safeParse(comValorEm(exemploGetOrder(), alvo, 7));
      expect(lida.success).toBe(true);
      expect(valorEm(lida.data, alvo)).toBe(7);
    },
  );

  it('the model example round-trips unchanged: nothing declared transforms it, nothing is stripped', () => {
    expect(respostaGetOrderSchema.parse(exemploGetOrder())).toStrictEqual(exemploGetOrder());
    expect(respostaGetOrderSchema.parse(exemploComPacotes())).toStrictEqual(exemploComPacotes());
  });
});

describe('buscarPedido', () => {
  /** A getOrder body for `id`, from the model example. */
  const corpoPara = (id: string) => comValorEm(exemploGetOrder(), ['order', 'orderId'], id);

  it('GETs exactly the order path with ONE query key: includedData = the eight, joined by "," in order', async () => {
    const f = mockFetch(() => json(corpoPara(ID_DO_MODELO)));
    const r = await buscarPedido(cliente(f), ID_DO_MODELO);
    expect(r.dados.order.orderId).toBe(ID_DO_MODELO);
    const { url, init } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(url.pathname).toBe('/orders/2026-01-01/orders/171-9876543-2109876');
    expect([...url.searchParams.keys()]).toEqual(['includedData']);
    expect(url.searchParams.getAll('includedData')).toEqual([INCLUDED_DATA]);
    // One value, the commas encoded by client.ts: never a key per dataset.
    expect(url.search).toBe(`?includedData=${INCLUDED_DATA.replaceAll(',', '%2C')}`);
  });

  it('sends no marketplaceIds, and nothing else the caller’s options object carries', async () => {
    const f = mockFetch(() => json(corpoPara(ID_DO_MODELO)));
    const extras = {
      marketplaceIds: MARKETPLACE_ID_BR,
      includedData: 'BUYER',
      fulfilledBy: 'MERCHANT',
    } as unknown as OpcoesGetOrder;
    await buscarPedido(cliente(f), ID_DO_MODELO, extras);
    const { url } = requisicao(f);
    expect([...url.searchParams.keys()]).toEqual(['includedData']);
    expect(url.searchParams.get('includedData')).toBe(INCLUDED_DATA);
    expect(url.searchParams.has('marketplaceIds')).toBe(false);
  });

  it('passes the caller’s abort through: rethrown as itself, never an AmazonError', async () => {
    const controller = new AbortController();
    const f = fetchQueNuncaResponde();
    const { estado, pronto } = observar(
      buscarPedido(cliente(f), ID_DO_MODELO, { sinal: controller.signal }),
    );
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect(requisicao(f).init.signal?.aborted).toBe(false);
    controller.abort();
    await pronto;
    expect(estado.valor).toBe(controller.signal.reason);
    expect(estado.valor).not.toBeInstanceOf(AmazonError);
  });

  it('never follows a redirect: a 3xx is a non-transient AmazonHttpError, fetch called once', async () => {
    const f = mockFetch(() =>
      texto('', 302, { location: 'https://outro-host.example/orders/2026-01-01/orders/x' }),
    );
    const err = await falha(buscarPedido(cliente(f), ID_DO_MODELO));
    expect(err).toBeInstanceOf(AmazonHttpError);
    expect((err as AmazonHttpError).status).toBe(302);
    expect((err as AmazonHttpError).transitorio).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
    expect(requisicao(f).init.redirect).toBe('manual');
  });

  it('a 2xx outside the schema is the client’s AmazonSchemaError, carrying the field path only', async () => {
    const corpo = exemploGetOrder();
    delete linhaDe(corpo).orderItemId;
    const f = mockFetch(() => json(corpo));
    const err = await falha(buscarPedido(cliente(f), ID_DO_MODELO));
    expect(err).toBeInstanceOf(AmazonSchemaError);
    expect((err as AmazonSchemaError).campos).toEqual(['order.orderItems[].orderItemId']);
  });

  it.each(['../x', 'a/b', '171-9876543-2109876/../../sellers'])(
    'an id that would leave its segment (%j) is refused before anything is sent',
    async (id) => {
      const f = mockFetch(() => json(corpoPara(ID_DO_MODELO)));
      const err = await falha(buscarPedido(cliente(f), id));
      expect(err).toBeInstanceOf(AmazonConfigError);
      expect((err as AmazonConfigError).motivo).toBe('caminho');
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('labels the call with the model operation id', async () => {
    const operacoes: string[] = [];
    const c = criarClienteSpApi({
      obterCredencial: () => ({ accessToken: ACCESS_TOKEN, ref: 'ref-A' }),
      userAgent: USER_AGENT,
      fetch: mockFetch(() => json(corpoPara(ID_DO_MODELO))),
      gerarCorrelationId: () => 'corr-1',
      agora: () => 1_000,
      onChamada: (e) => operacoes.push(e.operacao),
    });
    await buscarPedido(c, ID_DO_MODELO);
    expect(operacoes).toEqual([OPERACAO_GET_ORDER]);
  });
});
