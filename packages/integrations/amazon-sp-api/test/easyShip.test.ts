import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as barril from '../src/index';
import {
  type ChamadaAmazon,
  MARKETPLACE_ID_BR,
  type OpcoesClienteSpApi,
  URL_BASE_SP_API,
} from '../src/client';
import {
  agendarPacotesEasyShip,
  CAMINHO_AGENDAMENTO_EASY_SHIP,
  CODIGO_DIMENSOES_AUSENTES_EASY_SHIP,
  CODIGO_PACOTE_JA_AGENDADO_EASY_SHIP,
  type EntradaAgendamentoEasyShip,
  FORMATO_ETIQUETA_EASY_SHIP,
  OPERACAO_AGENDAMENTO_EASY_SHIP,
  respostaAgendamentoEasyShipSchema,
} from '../src/easyShip';
import {
  AmazonConfigError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonTimeoutError,
} from '../src/errors';
import { criarClienteEscritaSpApi } from '../src/escrita';
import { PRAZO_AMAZON_MS } from '../src/prazos';
import { agendamentoEasyShip200, erro400AgendamentoInvalidInput } from './_fixtures/sandbox';
import {
  ACCESS_TOKEN,
  falha,
  fetchQueNuncaResponde,
  json,
  mockFetch,
  observar,
  requisicao,
  texto,
  textosDoErro,
  USER_AGENT,
  verificarFormaDasRequisicoesSpApi,
} from './_helpers/mockFetch';

afterEach(verificarFormaDasRequisicoesSpApi);

const PEDIDO = '000-0000000-0000301';

function escritor(fetch: typeof globalThis.fetch) {
  const eventos: ChamadaAmazon[] = [];
  const credenciais: string[] = [];
  const opcoes: OpcoesClienteSpApi = {
    obterCredencial: () => {
      credenciais.push('lida');
      return { accessToken: ACCESS_TOKEN, ref: 'ref-rdt' };
    },
    userAgent: USER_AGENT,
    fetch,
    gerarCorrelationId: () => 'corr-1',
    agora: () => 1_000,
    onChamada: (e) => eventos.push(e),
  };
  return { c: criarClienteEscritaSpApi(opcoes), eventos, credenciais };
}

/** The body a mock saw, parsed. */
function corpoEnviado(f: Parameters<typeof requisicao>[0], i = 0): Record<string, unknown> {
  const body = requisicao(f, i).init.body;
  if (typeof body !== 'string') throw new Error('esperava um corpo de texto');
  return JSON.parse(body) as Record<string, unknown>;
}

describe('the constants', () => {
  it('pins the operation, the path, the format and the two codes', () => {
    expect(OPERACAO_AGENDAMENTO_EASY_SHIP).toBe('createScheduledPackageBulk');
    expect(CAMINHO_AGENDAMENTO_EASY_SHIP).toBe('/easyShip/2022-03-23/packages/bulk');
    expect(FORMATO_ETIQUETA_EASY_SHIP).toBe('ZPL');
    expect(CODIGO_PACOTE_JA_AGENDADO_EASY_SHIP).toBe('ScheduledPackageAlreadyExists');
    expect(CODIGO_DIMENSOES_AUSENTES_EASY_SHIP).toBe('MissingPackageDimensions');
  });
});

describe('agendarPacotesEasyShip (createScheduledPackageBulk)', () => {
  it('★ is a POST with no query whose body is EXACTLY the three named keys, one order, one key', async () => {
    const f = mockFetch(() => json(agendamentoEasyShip200));
    const { c, eventos } = escritor(f);
    await agendarPacotesEasyShip(c, { orderId: PEDIDO });
    const { url, init } = requisicao(f);
    expect(init.method).toBe('POST');
    expect(`${url.origin}${url.pathname}`).toBe(
      `${URL_BASE_SP_API}${CAMINHO_AGENDAMENTO_EASY_SHIP}`,
    );
    expect(url.search).toBe('');
    // The literal pin: NEAR-MISS `packageDetails: null`, a second order or a
    // `PDF` format would each fail it.
    expect(requisicao(f).init.body).toBe(
      `{"marketplaceId":"${MARKETPLACE_ID_BR}","orderScheduleDetailsList":[{"amazonOrderId":"${PEDIDO}"}],"labelFormat":"ZPL"}`,
    );
    const corpo = corpoEnviado(f);
    expect(Object.keys(corpo).sort()).toEqual([
      'labelFormat',
      'marketplaceId',
      'orderScheduleDetailsList',
    ]);
    const lista = corpo.orderScheduleDetailsList as Record<string, unknown>[];
    expect(lista).toHaveLength(1);
    expect(Object.keys(lista[0] ?? {})).toEqual(['amazonOrderId']);
    expect(eventos[0]).toMatchObject({
      operacao: 'createScheduledPackageBulk',
      metodo: 'POST',
      caminho: CAMINHO_AGENDAMENTO_EASY_SHIP,
      query: [],
    });
  });

  it('★ labelFormat is ZPL, and no exported function takes a format', async () => {
    const f = mockFetch(() => json({}));
    const { c } = escritor(f);
    await agendarPacotesEasyShip(c, { orderId: PEDIDO });
    expect(corpoEnviado(f).labelFormat).toBe('ZPL');
    // The helper's arity: the client, the ONE-key input and the signal.
    expect(agendarPacotesEasyShip.length).toBe(3);
    // A caller that smuggles a format, a slot or a second order changes nothing.
    const contrabando = {
      orderId: PEDIDO,
      labelFormat: 'PDF',
      packageDetails: null,
      orderScheduleDetailsList: [{ amazonOrderId: '000-0000000-0000999' }],
      marketplaceId: 'OUTRO',
    } as EntradaAgendamentoEasyShip;
    const g = mockFetch(() => json({}));
    await agendarPacotesEasyShip(escritor(g).c, contrabando);
    expect(corpoEnviado(g)).toEqual({
      marketplaceId: MARKETPLACE_ID_BR,
      orderScheduleDetailsList: [{ amazonOrderId: PEDIDO }],
      labelFormat: 'ZPL',
    });
    // No exported name of the barrel speaks of PDF.
    expect(Object.keys(barril).filter((n) => /pdf/i.test(n))).toEqual([]);
  });

  it.each([
    '',
    '000-0000000-000030',
    '0000-0000000-0000301',
    `${PEDIDO}\n`,
    ` ${PEDIDO}`,
    '000_0000000_0000301',
    'abc-defghij-klmnopq',
  ])(
    '★ an order id outside 3-7-7 (%j) → AmazonConfigError pedido, before fetch',
    async (orderId) => {
      const f = mockFetch(() => json({}));
      const { c, eventos, credenciais } = escritor(f);
      const err = await falha(agendarPacotesEasyShip(c, { orderId }));
      expect(err).toBeInstanceOf(AmazonConfigError);
      expect(err).toMatchObject({
        motivo: 'pedido',
        operacao: 'createScheduledPackageBulk',
        refCredencial: null,
      });
      expect(f).not.toHaveBeenCalled();
      expect(credenciais).toEqual([]);
      expect(eventos).toEqual([]);
    },
  );

  it('★ the sandbox 200 (ids faked) parses: units IN, three orders, one InvalidInput rejection', async () => {
    const { c } = escritor(mockFetch(() => json(agendamentoEasyShip200)));
    const r = await agendarPacotesEasyShip(c, { orderId: PEDIDO });
    expect(r.dados).toEqual(agendamentoEasyShip200);
    const dados = r.dados;
    if (dados === null) throw new Error('esperava um objeto');
    expect(dados.scheduledPackages).toHaveLength(2);
    expect(dados.rejectedOrders).toHaveLength(1);
    expect(dados.rejectedOrders?.[0]?.error?.code).toBe('InvalidInput');
    const pedidos = [
      ...(dados.scheduledPackages ?? []).map((p) => p.scheduledPackageId?.amazonOrderId),
      ...(dados.rejectedOrders ?? []).map((p) => p.amazonOrderId),
    ];
    expect(pedidos).toEqual(['000-0000000-0000301', '000-0000000-0000302', '000-0000000-0000303']);
    expect(dados.scheduledPackages?.[0]?.packageTimeSlot?.handoverMethod).toBe('PICKUP');
    expect(dados.scheduledPackages?.[0]?.trackingDetails?.trackingId).toBe('1652969339691');
    expect(dados.printableDocumentsUrl).toBe('https://www.amazon.com/documents.zip');
  });

  it('★ the sandbox 400 → AmazonHttpError 400 with codigosErro [InvalidInput]', async () => {
    const { c, eventos } = escritor(mockFetch(() => json(erro400AgendamentoInvalidInput, 400)));
    const err = await falha(agendarPacotesEasyShip(c, { orderId: PEDIDO }));
    expect(err).toBeInstanceOf(AmazonHttpError);
    expect(err).not.toBeInstanceOf(AmazonNotFoundError);
    expect(err).toMatchObject({ status: 400, transitorio: false, codigosErro: ['InvalidInput'] });
    expect(eventos[0]?.codigosErro).toEqual(['InvalidInput']);
    for (const t of textosDoErro(err)) expect(t).not.toContain('cannot be parsed');
  });

  it('★ a top-level 400 ScheduledPackageAlreadyExists keeps its code for the caller', async () => {
    const corpo = { errors: [{ code: CODIGO_PACOTE_JA_AGENDADO_EASY_SHIP, message: 'm' }] };
    const { c } = escritor(mockFetch(() => json(corpo, 400)));
    const err = await falha(agendarPacotesEasyShip(c, { orderId: PEDIDO }));
    expect(err).toMatchObject({ status: 400, codigosErro: ['ScheduledPackageAlreadyExists'] });
  });

  it.each([
    ['an EMPTY 2xx body', () => texto('', 200), null],
    ['`{}`', () => json({}), {}],
  ])('★ %s parses', async (_caso, resposta, esperado) => {
    const { c } = escritor(mockFetch(resposta));
    const r = await agendarPacotesEasyShip(c, { orderId: PEDIDO });
    expect(r.dados).toEqual(esperado);
  });

  it('★ open strings: packageStatus Scheduled, unit IN and an unknown handoverMethod parse (no enum)', () => {
    const corpo = {
      scheduledPackages: [
        {
          scheduledPackageId: { amazonOrderId: PEDIDO, packageId: 'p' },
          packageStatus: 'Scheduled',
          packageDimensions: { length: 1, width: 1, height: 1, unit: 'IN' },
          packageWeight: { value: 1, unit: 'ounces' },
          packageTimeSlot: { slotId: 's', handoverMethod: 'METODO_NOVO' },
          trackingDetails: { trackingId: 't' },
          campoNovo: 1,
        },
      ],
      rejectedOrders: [{ amazonOrderId: PEDIDO, error: { code: 'CodigoNovo', campoNovo: 2 } }],
      campoNovo: { a: 1 },
    };
    const r = respostaAgendamentoEasyShipSchema.safeParse(corpo);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(corpo);
  });

  it('★ a 2xx without printableDocumentsUrl parses, and every declared field may be null', () => {
    const semUrl = { scheduledPackages: [{ scheduledPackageId: { amazonOrderId: PEDIDO } }] };
    expect(respostaAgendamentoEasyShipSchema.safeParse(semUrl).success).toBe(true);
    const comNulos = {
      scheduledPackages: [
        {
          scheduledPackageId: null,
          packageStatus: null,
          trackingDetails: null,
          packageTimeSlot: null,
        },
      ],
      rejectedOrders: [{ amazonOrderId: null, error: null }],
      printableDocumentsUrl: null,
    };
    expect(respostaAgendamentoEasyShipSchema.safeParse(comNulos).success).toBe(true);
    // A rejection entry with an error but no code (the model's `Error` requires
    // one; a tolerant read does not).
    expect(
      respostaAgendamentoEasyShipSchema.safeParse({ rejectedOrders: [{ error: { message: 'm' } }] })
        .success,
    ).toBe(true);
  });

  it('near-miss: a 2xx that is a bare array is not the answer (AmazonSchemaError)', async () => {
    const { c } = escritor(mockFetch(() => json([{ amazonOrderId: PEDIDO }])));
    const err = await falha(agendarPacotesEasyShip(c, { orderId: PEDIDO }));
    expect(err).toBeInstanceOf(AmazonSchemaError);
  });

  it('the caller’s signal reaches the request: already aborted, nothing is sent', async () => {
    const controller = new AbortController();
    controller.abort(new RangeError('motivo do chamador'));
    const f = mockFetch(() => json({}));
    const { c } = escritor(f);
    await expect(agendarPacotesEasyShip(c, { orderId: PEDIDO }, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
    expect(f).not.toHaveBeenCalled();
  });
});

describe('★ the bulk travels through the WRITE client, with the escrita deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('NEAR-MISS: still pending at 29 s (the 20-s read deadline would have cut it); cut at 30 s', async () => {
    expect(PRAZO_AMAZON_MS.escrita).toBe(30_000);
    const f = fetchQueNuncaResponde();
    const { c, eventos } = escritor(f);
    const { estado, pronto } = observar(agendarPacotesEasyShip(c, { orderId: PEDIDO }));

    await vi.advanceTimersByTimeAsync(29_000);
    expect(estado.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.escrita - 29_000 - 1);
    expect(estado.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toBeInstanceOf(AmazonTimeoutError);
    expect(estado.valor).toBeInstanceOf(AmazonNetworkError);
    expect((estado.valor as AmazonTimeoutError).prazoMs).toBe(PRAZO_AMAZON_MS.escrita);
    expect(eventos.map((e) => e.resultado)).toEqual(['tempo-esgotado']);
    expect(requisicao(f).init.method).toBe('POST');
    expect(vi.getTimerCount()).toBe(0);
  });
});
