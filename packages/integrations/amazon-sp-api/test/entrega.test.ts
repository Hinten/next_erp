import { afterEach, describe, expect, it } from 'vitest';

import {
  type ChamadaAmazon,
  criarClienteSpApi,
  MARKETPLACE_ID_BR,
  type OpcoesClienteSpApi,
  URL_BASE_SP_API,
} from '../src/client';
import {
  CAMINHO_NOTA_FISCAL,
  CAMINHO_STATUS_NOTA_FISCAL,
  consultarStatusNotaFiscal,
  type EntradaEnvioNotaFiscal,
  enviarNotaFiscal,
  OPERACAO_GET_INVOICE_STATUS,
  OPERACAO_SUBMIT_INVOICE,
  PROGRAMA_ENTREGA_AMAZON,
  respostaEnvioNotaFiscalSchema,
  respostaStatusNotaFiscalSchema,
  STATUS_FATURA_ENTREGA_AMAZON,
  STATUS_FATURA_ITEM_AMAZON,
  STATUS_FATURAMENTO_PEDIDO_AMAZON,
  TIPO_FATURA_AMAZON,
} from '../src/entrega';
import {
  AmazonConfigError,
  AmazonHttpError,
  AmazonNotFoundError,
  AmazonSchemaError,
  type MotivoConfigAmazon,
} from '../src/errors';
import { criarClienteEscritaSpApi } from '../src/escrita';
import {
  envioNotaFiscal200,
  erro400EnvioEntityNotFound,
  erro400StatusInvalidInput,
  statusNotaFiscal200,
  statusNotaFiscalSemRemessa,
} from './_fixtures/sandbox';
import {
  ACCESS_TOKEN,
  falha,
  json,
  mockFetch,
  requisicao,
  texto,
  textosDoErro,
  USER_AGENT,
  verificarFormaDasRequisicoesSpApi,
} from './_helpers/mockFetch';

afterEach(verificarFormaDasRequisicoesSpApi);

const PEDIDO = '000-0000000-0000000';
/** The model's own `invoiceContent` example: base64 text. */
const CONTEUDO = 'SGF2ZSB0byBkZWFsIHdpdGggQmFzZTY0IGZvcm1hdD8=';
/** The base64 of the MD5 of `abc`. */
const MD5 = 'kAFQmDzST7DWlj99KOF/cg==';
/** The model's own `contentMD5Value` example: a HEX digest, which the API does not take. */
const MD5_HEX_DO_MODELO = '9906bd8f227f6a43f1e27db4b9258ad4';

function opcoes(fetch: typeof globalThis.fetch, eventos: ChamadaAmazon[], credenciais: string[]) {
  return {
    obterCredencial: () => {
      credenciais.push('lida');
      return { accessToken: ACCESS_TOKEN, ref: 'ref-A' };
    },
    userAgent: USER_AGENT,
    fetch,
    gerarCorrelationId: () => 'corr-1',
    agora: () => 1_000,
    onChamada: (e: ChamadaAmazon) => eventos.push(e),
  } satisfies OpcoesClienteSpApi;
}

function clientes(fetch: typeof globalThis.fetch) {
  const eventos: ChamadaAmazon[] = [];
  const credenciais: string[] = [];
  return {
    leitor: criarClienteSpApi(opcoes(fetch, eventos, credenciais)),
    escritor: criarClienteEscritaSpApi(opcoes(fetch, eventos, credenciais)),
    eventos,
    credenciais,
  };
}

const entrada = (extra: Partial<EntradaEnvioNotaFiscal> = {}): EntradaEnvioNotaFiscal => ({
  orderId: PEDIDO,
  invoiceContent: CONTEUDO,
  contentMD5Value: MD5,
  ...extra,
});

/** The body a mock saw, parsed. */
function corpoEnviado(f: Parameters<typeof requisicao>[0], i = 0): Record<string, unknown> {
  const body = requisicao(f, i).init.body;
  if (typeof body !== 'string') throw new Error('esperava um corpo de texto');
  return JSON.parse(body) as Record<string, unknown>;
}

describe('the constants', () => {
  it('pins the operations, the paths, the invoice type and the program', () => {
    expect(OPERACAO_GET_INVOICE_STATUS).toBe('getInvoiceStatus');
    expect(OPERACAO_SUBMIT_INVOICE).toBe('submitInvoice');
    expect(CAMINHO_STATUS_NOTA_FISCAL).toBe('/delivery/2022-07-01/invoice/status');
    expect(CAMINHO_NOTA_FISCAL).toBe('/delivery/2022-07-01/invoice');
    expect(TIPO_FATURA_AMAZON).toBe('Outbound');
    expect(PROGRAMA_ENTREGA_AMAZON).toBe('EasyShip');
  });

  it('pins the three PascalCase status vocabularies exactly as the model spells them', () => {
    expect(STATUS_FATURA_ENTREGA_AMAZON).toEqual({
      processing: 'Processing',
      accepted: 'Accepted',
      errored: 'Errored',
      notFound: 'NotFound',
    });
    expect(STATUS_FATURAMENTO_PEDIDO_AMAZON).toEqual({
      processing: 'Processing',
      accepted: 'Accepted',
      partiallyAccepted: 'PartiallyAccepted',
      rejected: 'Rejected',
    });
    expect(STATUS_FATURA_ITEM_AMAZON).toEqual({
      processing: 'Processing',
      accepted: 'Accepted',
      rejected: 'Rejected',
      notFound: 'NotFound',
    });
  });

  it('near-miss: no value is the order-level UPPER_SNAKE vocabulary', () => {
    const valores = [
      ...Object.values(STATUS_FATURA_ENTREGA_AMAZON),
      ...Object.values(STATUS_FATURAMENTO_PEDIDO_AMAZON),
      ...Object.values(STATUS_FATURA_ITEM_AMAZON),
    ];
    for (const v of valores) expect(v, v).toMatch(/^(?:[A-Z][a-z]+)+$/);
    for (const v of ['PROCESSING', 'ACCEPTED', 'ERRORED', 'NOT_FOUND', 'NOT_REQUIRED']) {
      expect(valores).not.toContain(v);
    }
    expect([PROGRAMA_ENTREGA_AMAZON]).not.toContain('DELIVERY_BY_AMAZON');
    expect([PROGRAMA_ENTREGA_AMAZON]).not.toContain('AMAZON_EASY_SHIP');
  });
});

describe('consultarStatusNotaFiscal (getInvoiceStatus)', () => {
  it('★ is a GET whose query is EXACTLY orderId, marketplaceId, invoiceType, programType', async () => {
    const f = mockFetch(() => json(statusNotaFiscal200));
    const { leitor, eventos } = clientes(f);
    await consultarStatusNotaFiscal(leitor, PEDIDO);
    const { url, init } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(`${url.origin}${url.pathname}`).toBe(`${URL_BASE_SP_API}${CAMINHO_STATUS_NOTA_FISCAL}`);
    expect([...url.searchParams.entries()]).toEqual([
      ['orderId', PEDIDO],
      ['marketplaceId', MARKETPLACE_ID_BR],
      ['invoiceType', 'Outbound'],
      ['programType', 'EasyShip'],
    ]);
    // Near-miss: the two other selectors of the model are never sent.
    expect(url.searchParams.has('invoiceId')).toBe(false);
    expect(url.searchParams.has('shipmentId')).toBe(false);
    expect(eventos[0]).toMatchObject({ operacao: 'getInvoiceStatus', metodo: 'GET' });
  });

  it('★ the sandbox body parses, as is', async () => {
    const { leitor } = clientes(mockFetch(() => json(statusNotaFiscal200)));
    const r = await consultarStatusNotaFiscal(leitor, PEDIDO);
    expect(r.dados).toEqual(statusNotaFiscal200);
  });

  it('★ the real capture shape (no amazonShipmentId) parses', async () => {
    const { leitor } = clientes(mockFetch(() => json(statusNotaFiscalSemRemessa)));
    const r = await consultarStatusNotaFiscal(leitor, PEDIDO);
    expect(r.dados.amazonShipmentId).toBeUndefined();
    expect(r.dados.orderInvoicingStatus).toBe('Accepted');
    expect(r.dados.invoices).toEqual([{ id: 'ID-DA-FATURA-FALSO', status: 'Accepted' }]);
  });

  it.each([
    ['invoiceStatus', { invoiceStatus: 'ACCEPTED' }],
    ['orderInvoicingStatus', { orderInvoicingStatus: 'accepted' }],
    ['invoices[].status', { invoices: [{ id: 'x', status: 'Accepted ' }] }],
  ])(
    '★ a status outside the constants (%s) PARSES — an open string, the app decides',
    (_campo, corpo) => {
      const r = respostaStatusNotaFiscalSchema.safeParse(corpo);
      expect(r.success).toBe(true);
      expect(r.data).toEqual(corpo);
    },
  );

  it('★ a 200 with a non-empty errors list parses and keeps the list (the app reads it)', async () => {
    const corpo = { invoiceStatus: 'NotFound', errors: [{ code: 'InvalidInput', message: 'm' }] };
    const { leitor } = clientes(mockFetch(() => json(corpo)));
    const r = await consultarStatusNotaFiscal(leitor, PEDIDO);
    expect(r.dados.errors).toEqual([{ code: 'InvalidInput', message: 'm' }]);
  });

  it('every field is optional, null included, and unknown keys survive passthrough', () => {
    expect(respostaStatusNotaFiscalSchema.safeParse({}).success).toBe(true);
    const comNulos = {
      amazonOrderId: null,
      amazonShipmentId: null,
      invoiceStatus: null,
      orderInvoicingStatus: null,
      invoices: null,
      errors: null,
    };
    expect(respostaStatusNotaFiscalSchema.safeParse(comNulos).success).toBe(true);
    expect(
      respostaStatusNotaFiscalSchema.safeParse({ invoices: [{}], campoNovo: { a: 1 } }).data,
    ).toEqual({ invoices: [{}], campoNovo: { a: 1 } });
    // Inside an `invoices[]` row too (a future row field, e.g. the chave in a
    // key of its own): a strict row would refuse the read, a stripped one drop it.
    const comLinhaNova = {
      invoices: [{ id: 'x', status: 'Accepted', campoNovo: 1 }],
      errors: [{ code: 'InvalidInput', campoNovo: 2 }],
    };
    expect(respostaStatusNotaFiscalSchema.safeParse(comLinhaNova).data).toEqual(comLinhaNova);
  });

  it('the getInvoiceStatus 400 sandbox body → AmazonHttpError 400 with codigosErro [InvalidInput]', async () => {
    const { leitor } = clientes(mockFetch(() => json(erro400StatusInvalidInput, 400)));
    const err = await falha(consultarStatusNotaFiscal(leitor, PEDIDO));
    expect(err).toBeInstanceOf(AmazonHttpError);
    expect(err).not.toBeInstanceOf(AmazonNotFoundError);
    expect(err).toMatchObject({ status: 400, codigosErro: ['InvalidInput'] });
    for (const t of textosDoErro(err)) expect(t).not.toContain('BadIDForShipment');
  });

  it('a 404 is AmazonNotFoundError', async () => {
    const { leitor } = clientes(mockFetch(() => texto('', 404)));
    expect(await falha(consultarStatusNotaFiscal(leitor, PEDIDO))).toBeInstanceOf(
      AmazonNotFoundError,
    );
  });
});

describe('enviarNotaFiscal (submitInvoice)', () => {
  it('★ is a POST whose query is EXACTLY orderId, and whose body has EXACTLY the five named keys', async () => {
    const f = mockFetch(() => json(envioNotaFiscal200));
    const { escritor, eventos } = clientes(f);
    await enviarNotaFiscal(escritor, entrada());
    const { url, init } = requisicao(f);
    expect(init.method).toBe('POST');
    expect(`${url.origin}${url.pathname}`).toBe(`${URL_BASE_SP_API}${CAMINHO_NOTA_FISCAL}`);
    expect([...url.searchParams.entries()]).toEqual([['orderId', PEDIDO]]);
    const corpo = corpoEnviado(f);
    expect(Object.keys(corpo).sort()).toEqual([
      'contentMD5Value',
      'invoiceContent',
      'invoiceType',
      'marketplaceId',
      'programType',
    ]);
    expect(corpo).toEqual({
      invoiceContent: CONTEUDO,
      contentMD5Value: MD5,
      invoiceType: 'Outbound',
      programType: 'EasyShip',
      marketplaceId: MARKETPLACE_ID_BR,
    });
    // Near-miss: the order's own `programs[]` vocabulary is never this field.
    expect(['DELIVERY_BY_AMAZON', 'AMAZON_EASY_SHIP']).not.toContain(corpo.programType);
    expect(eventos[0]).toMatchObject({ operacao: 'submitInvoice', metodo: 'POST' });
  });

  it('★ keys a caller smuggles in never reach the query or the body (named keys, no spread)', async () => {
    const f = mockFetch(() => json(envioNotaFiscal200));
    const { escritor } = clientes(f);
    const contrabando = {
      ...entrada(),
      shipmentId: 'REMESSA-X',
      invoiceId: 'FATURA-X',
      programType: 'DELIVERY_BY_AMAZON',
      programas: ['DELIVERY_BY_AMAZON'],
      invoiceType: 'Inbound',
      marketplaceId: 'OUTRO',
    } as EntradaEnvioNotaFiscal;
    await enviarNotaFiscal(escritor, contrabando);
    const { url } = requisicao(f);
    expect([...url.searchParams.keys()]).toEqual(['orderId']);
    expect(corpoEnviado(f)).toEqual({
      invoiceContent: CONTEUDO,
      contentMD5Value: MD5,
      invoiceType: 'Outbound',
      programType: 'EasyShip',
      marketplaceId: MARKETPLACE_ID_BR,
    });
  });

  it.each([
    ['an EMPTY 2xx body (the retired LATAM page)', () => texto('', 200)],
    ['the sandbox `{}`', () => json(envioNotaFiscal200)],
    ['`{ errors: [] }`', () => json({ errors: [] })],
    ['`{ errors: null }`', () => json({ errors: null })],
    ['a 202 with `{}`', () => json({}, 202)],
    // A strict object would turn this into AmazonSchemaError, which a caller
    // reads as "the write MAY HAVE LANDED" — an uncertain submit, not a parse slip.
    ['an unknown top-level key', () => json({ campoNovo: 1 })],
  ])('★ %s ⇒ aceito-para-processamento', async (_caso, resposta) => {
    const { escritor } = clientes(mockFetch(resposta));
    expect(await enviarNotaFiscal(escritor, entrada())).toEqual({
      tipo: 'aceito-para-processamento',
    });
  });

  it('★ the 2xx schema keeps unknown keys, top level and inside an errors entry (passthrough)', () => {
    const corpo = { errors: [{ code: 'X', campoNovo: 2 }], campoNovo: { a: 1 } };
    expect(respostaEnvioNotaFiscalSchema.parse(corpo)).toEqual(corpo);
    expect(respostaEnvioNotaFiscalSchema.parse({ errors: [], campoNovo: { a: 1 } })).toEqual({
      errors: [],
      campoNovo: { a: 1 },
    });
  });

  it('★ a 2xx with a non-empty errors list ⇒ erros, the codes only (never reported as accepted)', async () => {
    const corpo = {
      errors: [
        { code: 'InvalidInput', message: 'MARCADOR-DA-MENSAGEM', details: 'x' },
        { code: 'InvalidInput', message: 'outra' },
        { code: 'Outro\u0000Codigo' },
        { message: 'sem código' },
      ],
    };
    const { escritor } = clientes(mockFetch(() => json(corpo)));
    const r = await enviarNotaFiscal(escritor, entrada());
    expect(r).toEqual({ tipo: 'erros', codigos: ['InvalidInput'] });
    expect(JSON.stringify(r)).not.toContain('MARCADOR-DA-MENSAGEM');
  });

  it('★ the codes are bounded: at most 10 distinct, each at most 64 characters', async () => {
    const onze = Array.from({ length: 11 }, (_, i) => `Codigo${String(i)}`);
    const corpo = {
      errors: [
        { code: 'X'.repeat(65) },
        { code: 'Y'.repeat(64) },
        ...onze.map((code) => ({ code })),
      ],
    };
    const { escritor } = clientes(mockFetch(() => json(corpo)));
    expect(await enviarNotaFiscal(escritor, entrada())).toEqual({
      tipo: 'erros',
      // Near-miss: 64 characters is kept; 65 is dropped; the 11th distinct code is cut.
      codigos: ['Y'.repeat(64), ...onze.slice(0, 9)],
    });
  });

  it('near-miss: a list whose every code is unreadable is still erros, with no codes', async () => {
    const { escritor } = clientes(mockFetch(() => json({ errors: [{ message: 'm' }] })));
    expect(await enviarNotaFiscal(escritor, entrada())).toEqual({ tipo: 'erros', codigos: [] });
  });

  it('a 2xx that is neither empty nor the object (a bare array, HTML) → AmazonSchemaError', async () => {
    for (const [resposta, motivo] of [
      [() => json([{ code: 'x' }]), 'formato'],
      [() => texto('<html>proxy</html>', 200), 'nao-json'],
    ] as const) {
      const { escritor } = clientes(mockFetch(resposta));
      const err = await falha(enviarNotaFiscal(escritor, entrada()));
      expect(err).toBeInstanceOf(AmazonSchemaError);
      expect((err as AmazonSchemaError).motivo).toBe(motivo);
    }
  });

  it('★ a 413 whose body is a BARE ErrorList array → AmazonHttpError 413, codigosErro []', async () => {
    const { escritor, eventos } = clientes(
      mockFetch(() => json([{ code: 'RequestEntityTooLarge', message: 'm' }], 413)),
    );
    const err = await falha(enviarNotaFiscal(escritor, entrada()));
    expect(err).toBeInstanceOf(AmazonHttpError);
    expect(err).toMatchObject({ status: 413, transitorio: false, codigosErro: [] });
    expect(eventos[0]?.codigosErro).toEqual([]);
  });

  it('★ the submitInvoice 400 sandbox body → AmazonHttpError 400 with codigosErro [EntityNotFound]', async () => {
    const { escritor, eventos } = clientes(mockFetch(() => json(erro400EnvioEntityNotFound, 400)));
    const err = await falha(enviarNotaFiscal(escritor, entrada()));
    expect(err).toBeInstanceOf(AmazonHttpError);
    expect(err).not.toBeInstanceOf(AmazonNotFoundError);
    expect(err).toMatchObject({ status: 400, codigosErro: ['EntityNotFound'] });
    expect(eventos[0]?.codigosErro).toEqual(['EntityNotFound']);
    for (const t of textosDoErro(err)) expect(t).not.toContain('BadIDForShipment');
  });
});

describe('★ the caller’s signal reaches the request (a cancelled task sends nothing)', () => {
  it.each<[string, (c: ReturnType<typeof clientes>, s: AbortSignal) => Promise<unknown>]>([
    ['consultarStatusNotaFiscal', (c, s) => consultarStatusNotaFiscal(c.leitor, PEDIDO, s)],
    ['enviarNotaFiscal', (c, s) => enviarNotaFiscal(c.escritor, entrada(), s)],
  ])(
    '%s with a signal already aborted: its reason comes back, nothing sent',
    async (_n, chamar) => {
      const controller = new AbortController();
      controller.abort(new RangeError('motivo do chamador'));
      const f = mockFetch(() => json({}));
      const c = clientes(f);
      await expect(chamar(c, controller.signal)).rejects.toBe(controller.signal.reason);
      expect(f).not.toHaveBeenCalled();
      expect(c.eventos).toEqual([]);
    },
  );
});

describe('shapes are refused before anything is read or sent', () => {
  async function recusa(
    chamada: (c: ReturnType<typeof clientes>) => Promise<unknown>,
    motivo: MotivoConfigAmazon,
    operacao: string,
  ): Promise<void> {
    const f = mockFetch(() => json({}));
    const c = clientes(f);
    const err = await falha(chamada(c));
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect(err).toMatchObject({ motivo, operacao, refCredencial: null });
    expect(f).not.toHaveBeenCalled();
    expect(c.credenciais).toEqual([]);
    expect(c.eventos).toEqual([]);
  }

  const PEDIDOS_RUINS = [
    '',
    '000-0000000-000000',
    '0000-0000000-0000000',
    'abc-defghij-klmnopq',
    ` ${PEDIDO}`,
    `${PEDIDO}\n`,
    `${PEDIDO}&invoiceId=1`,
    '000_0000000_0000000',
    // Nineteen digits and hyphens, each refused by WHERE the hyphens sit.
    '0000000000000000000',
    '00-00000000-0000000',
    '000--000000-0000000',
  ];

  it.each(PEDIDOS_RUINS)('★ status: order id %j → pedido', async (orderId) => {
    await recusa((c) => consultarStatusNotaFiscal(c.leitor, orderId), 'pedido', 'getInvoiceStatus');
  });

  it.each(PEDIDOS_RUINS)('★ submit: order id %j → pedido', async (orderId) => {
    await recusa(
      (c) => enviarNotaFiscal(c.escritor, entrada({ orderId })),
      'pedido',
      'submitInvoice',
    );
  });

  it.each([
    ['the model’s own HEX placeholder (32 hex)', MD5_HEX_DO_MODELO],
    ['empty', ''],
    ['no padding', 'kAFQmDzST7DWlj99KOF/cg'],
    ['one `=` only', 'kAFQmDzST7DWlj99KOF/cg='],
    ['base64url (`-`, `_`)', 'kAFQmDzST7DWlj99KOF_cg=='],
    ['a 20-byte digest (SHA-1 shape)', 'qZk+NkcGgWq6PiVxeFDCbJzQ2J0='],
    ['a trailing newline', `${MD5}\n`],
  ])('★ md5: %s → md5', async (_caso, contentMD5Value) => {
    await recusa(
      (c) => enviarNotaFiscal(c.escritor, entrada({ contentMD5Value })),
      'md5',
      'submitInvoice',
    );
  });

  it.each([
    ['empty', ''],
    ['the model’s own 400 example (not base64)', 'NonBase64EncodedValue'],
    ['a character outside the alphabet', 'QUJ$'],
    ['a length that is not a multiple of 4', 'QUJDR'],
    ['padding in the middle', 'QU=DQUJD'],
    // Each length a multiple of 4, so the regex rule decides, not the length one.
    ['three `=`', 'Q==='],
    ['three `=` after a full quantum', 'QUJDQ==='],
    ['base64url', 'QU-_'],
    ['a line break', 'QUJ\nQUJD'],
  ])('★ base64: %s → base64', async (_caso, invoiceContent) => {
    await recusa(
      (c) => enviarNotaFiscal(c.escritor, entrada({ invoiceContent })),
      'base64',
      'submitInvoice',
    );
  });

  it('near-miss: a 16-byte base64 digest and standard base64 with padding are sent', async () => {
    for (const [md5, conteudo] of [
      [MD5, CONTEUDO],
      ['1B2M2Y8AsgTpgAmY7PhCfg==', 'QUJD'],
      ['a/PoRlrYGXeMk2IMq+1Yhg==', 'QQ=='],
    ] as const) {
      const f = mockFetch(() => json({}));
      const { escritor } = clientes(f);
      await enviarNotaFiscal(escritor, entrada({ contentMD5Value: md5, invoiceContent: conteudo }));
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('a refused value never reaches the message', async () => {
    const { escritor } = clientes(mockFetch(() => json({})));
    const err = await falha(
      enviarNotaFiscal(escritor, entrada({ contentMD5Value: MD5_HEX_DO_MODELO })),
    );
    for (const t of textosDoErro(err)) expect(t).not.toContain(MD5_HEX_DO_MODELO);
  });

  it('the schema of the 2xx accepts null (an empty body) and refuses an array', () => {
    expect(respostaEnvioNotaFiscalSchema.safeParse(null).success).toBe(true);
    expect(respostaEnvioNotaFiscalSchema.safeParse({}).success).toBe(true);
    expect(respostaEnvioNotaFiscalSchema.safeParse([]).success).toBe(false);
  });
});
