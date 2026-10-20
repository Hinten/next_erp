/**
 * `searchOrders` (step 4): the page schema and the one helper the backstop poll
 * calls. Collected because it lives under `test/` (the package's vitest
 * `include`), where the `semRede` kill-switch runs too: every request here is
 * served by an injected fetch, never the network (D11).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { MARKETPLACE_ID_BR, type SpApiLeituraClient, criarClienteSpApi } from '../src/client';
import { AmazonSchemaError } from '../src/errors';
import {
  CAMINHO_SEARCH_ORDERS,
  OPERACAO_SEARCH_ORDERS,
  buscarPedidosAtualizados,
  respostaSearchOrdersSchema,
} from '../src/pedidos';
import { searchOrders200 } from './_fixtures/sandbox';
import {
  ACCESS_TOKEN,
  USER_AGENT,
  falha,
  json,
  mockFetch,
  requisicao,
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
