import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PERM, hasPerm } from '@delfrance/auth';
import {
  MercadoPagoConfigError,
  MercadoPagoContaNotConfiguredError,
} from '@/lib/payments/mercadoPago';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
} from '@delfrance/integrations-mercado-pago';
import {
  CODIGO_ERRO_LINK,
  ESTADO_PEDIDO,
  MODO_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  PERM_LINK_PAGAMENTO,
  ROTA_LINK_PAGAMENTO,
  TIPO_PAGAMENTO_MP,
} from '@delfrance/schemas';

// verifyCaller, the admin singleton and the orchestration are mocked; the route's
// own logic (the permission mask, body validation, the pass-through of the
// orchestration's status/body, the error mapping) and the REAL respond.ts,
// lerCorpo.ts and body schema run real.
const h = vi.hoisted(() => ({
  db: { __fake: 'db' },
  verifyCaller: vi.fn(),
  criarLinks: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => h.db,
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/payments/links/criarLinks', () => ({ criarLinks: h.criarLinks }));

const route = await import('./route');
const { POST } = route;

const AGORA = 1_790_000_000_000;
const LINK_A = 'AAAAAAAAAAAAAAAAAAAA';
const LINK_B = 'BBBBBBBBBBBBBBBBBBBB';

/** The smallest valid body: one individual link. */
const CORPO = {
  pedidoId: 'ped-1',
  metodoId: 'metodo-1',
  modo: MODO_LINK_PAGAMENTO.individual,
  valorCobradoEsperado: 100,
  expiraEm: '2026-10-05',
  links: [{ linkId: LINK_A, nomePagador: 'Maria', valor: 100 }],
};

/** What the route hands the orchestration: the body AFTER the schema applied its defaults. */
const CORPO_PARSEADO = {
  ...CORPO,
  tiposExcluidos: [],
  parcelasMaximas: null,
  quantidadeMaxima: null,
  preencherPagador: false,
};

/**
 * Each row breaks exactly ONE rule of the shared body schema. The route must answer
 * 400 naming that field's PATH, must not run the orchestration, and must never echo
 * `valor` — a value that appears in the broken body.
 */
const CORPOS_INVALIDOS: ReadonlyArray<{
  nome: string;
  alteracao: Record<string, unknown>;
  caminho: string;
  valor?: string;
}> = [
  {
    nome: 'a total that is not a number',
    alteracao: { valorCobradoEsperado: 'SEGREDO-987' },
    caminho: 'valorCobradoEsperado',
    valor: 'SEGREDO-987',
  },
  {
    nome: 'an unknown key (strict body)',
    alteracao: { notification_url: 'https://evil.example/hook' },
    caminho: 'notification_url',
    valor: 'evil.example',
  },
  {
    nome: 'a pedido id with a slash',
    alteracao: { pedidoId: 'ped/../x' },
    caminho: 'pedidoId',
    valor: 'ped/../x',
  },
  {
    nome: 'a third decimal on a link',
    alteracao: { links: [{ linkId: LINK_A, nomePagador: 'Maria', valor: 33.333 }] },
    caminho: 'links.0.valor',
    valor: '33.333',
  },
  {
    nome: 'a payer label with a digit',
    alteracao: { links: [{ linkId: LINK_A, nomePagador: 'Maria3', valor: 100 }] },
    caminho: 'links.0.nomePagador',
    valor: 'Maria3',
  },
  {
    nome: 'a link id of the wrong length',
    alteracao: { links: [{ linkId: 'curto', nomePagador: null, valor: 100 }] },
    caminho: 'links.0.linkId',
    valor: 'curto',
  },
  {
    nome: 'a repeated link id',
    alteracao: {
      links: [
        { linkId: LINK_A, nomePagador: 'A', valor: 50 },
        { linkId: LINK_A, nomePagador: 'B', valor: 50 },
      ],
    },
    caminho: 'links.1.linkId',
  },
  {
    nome: 'a shared link with two links',
    alteracao: {
      modo: MODO_LINK_PAGAMENTO.compartilhado,
      quantidadeMaxima: 2,
      links: [
        { linkId: LINK_A, nomePagador: null, valor: 50 },
        { linkId: LINK_B, nomePagador: null, valor: 50 },
      ],
    },
    caminho: 'links',
  },
  {
    nome: 'a shared link without a quantity',
    alteracao: { modo: MODO_LINK_PAGAMENTO.compartilhado },
    caminho: 'quantidadeMaxima',
  },
  {
    nome: 'a quantity on an individual link',
    alteracao: { quantidadeMaxima: 3 },
    caminho: 'quantidadeMaxima',
  },
  {
    nome: 'a payer prefill on a shared link',
    alteracao: {
      modo: MODO_LINK_PAGAMENTO.compartilhado,
      quantidadeMaxima: 2,
      preencherPagador: true,
    },
    caminho: 'preencherPagador',
  },
  {
    nome: 'a civil date that does not exist',
    alteracao: { expiraEm: '2026-02-30' },
    caminho: 'expiraEm',
    valor: '2026-02-30',
  },
  { nome: 'no links at all', alteracao: { links: [] }, caminho: 'links' },
];

function req(body: unknown): Request {
  return new Request(`http://localhost:3007${ROTA_LINK_PAGAMENTO.criar}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A claim string as `hasPerm` reads it: the decimal bitmask of a user's grants. */
const claim = (...bits: bigint[]): string => bits.reduce((acc, bit) => acc | bit, 0n).toString();

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const CRIADO = {
  status: 201,
  corpo: {
    links: [
      {
        linkId: LINK_A,
        preferenceId: 'pref-1',
        link: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-1',
        valorCobrado: 100,
        nomePagador: 'Maria',
        dataExpiracao: 1_791_000_000_000,
        modo: MODO_LINK_PAGAMENTO.individual,
        quantidadeMaxima: 1,
      },
    ],
    estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
    reaproveitado: false,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.criarLinks.mockResolvedValue(CRIADO);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/payments/mercado-pago/links/criar — the route itself', () => {
  it('lives at the path the shared contract advertises to the web client', () => {
    const pasta = fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/');
    expect(pasta.endsWith(`/app${ROTA_LINK_PAGAMENTO.criar}/`)).toBe(true);
  });

  it('exports POST only — a GET on a money-writing route must 405, not run', () => {
    expect(Object.keys(route).filter((k) => ['GET', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual(
      [],
    );
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
  });
});

describe('POST …/links/criar — authorization', () => {
  it('asks for EXACTLY pedido.write | pagamento.write — one bit is not enough', async () => {
    await POST(req(CORPO));
    expect(h.verifyCaller).toHaveBeenCalledTimes(1);
    const [, mascara] = h.verifyCaller.mock.calls[0] as [Request, bigint];

    expect(mascara).toBe(PERM_LINK_PAGAMENTO.gerenciar);
    expect(mascara).toBe(PERM.pedido.write | PERM.pagamento.write);
    // `hasPerm` requires EVERY bit of the mask: each near-miss below is one bit short.
    expect(hasPerm(claim(PERM.pedido.write), mascara)).toBe(false);
    expect(hasPerm(claim(PERM.pagamento.write), mascara)).toBe(false);
    expect(hasPerm(claim(PERM.pedido.write, PERM.pagamento.read), mascara)).toBe(false);
    expect(hasPerm(claim(PERM.pedido.write, PERM.pagamento.write), mascara)).toBe(true);
  });

  it.each([401, 403])('propagates the %i from verifyCaller and does no work', async (status) => {
    h.verifyCaller.mockResolvedValue({ error: new NextResponse(null, { status }) });
    const res = await POST(req(CORPO));
    expect(res.status).toBe(status);
    expect(h.criarLinks).not.toHaveBeenCalled();
  });

  it('authenticates BEFORE reading the body — a bad body from an outsider is a 403, not a 400', async () => {
    h.verifyCaller.mockResolvedValue({ error: new NextResponse(null, { status: 403 }) });
    const res = await POST(req('{not json'));
    expect(res.status).toBe(403);
  });
});

describe('POST …/links/criar — the body', () => {
  it.each([['{not json'], ['']])(
    'a body that is not JSON (%j) → 400 LINK_BODY_INVALIDO',
    async (t) => {
      const res = await POST(req(t));
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe(CODIGO_ERRO_LINK.corpoInvalido);
      expect(h.criarLinks).not.toHaveBeenCalled();
    },
  );

  it.each(CORPOS_INVALIDOS)('$nome → 400 naming the path', async (linha) => {
    const res = await POST(req({ ...CORPO, ...linha.alteracao }));
    expect(res.status).toBe(400);
    const corpo = await json(res);
    expect(corpo.code).toBe(CODIGO_ERRO_LINK.corpoInvalido);
    // Exactly the one offending path — not merely a message that happens to mention it.
    expect(corpo.error).toBe(`Body inválido: ${linha.caminho}.`);
    if (linha.valor !== undefined) {
      expect(JSON.stringify(corpo)).not.toContain(linha.valor);
    }
    expect(h.criarLinks).not.toHaveBeenCalled();
  });

  it('hands the orchestration the PARSED body (defaults applied), the caller uid and the clock', async () => {
    const res = await POST(req(CORPO));
    expect(res.status).toBe(201);
    expect(h.criarLinks).toHaveBeenCalledTimes(1);
    expect(h.criarLinks).toHaveBeenCalledWith(h.db, {
      uid: 'u1',
      corpo: CORPO_PARSEADO,
      agoraMs: AGORA,
    });
  });

  it('keeps what the client chose for the optional fields (a default must not overwrite it)', async () => {
    await POST(
      req({
        ...CORPO,
        tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto],
        parcelasMaximas: 3,
        preencherPagador: true,
      }),
    );
    const [, entrada] = h.criarLinks.mock.calls[0] as [unknown, { corpo: Record<string, unknown> }];
    expect(entrada.corpo).toMatchObject({
      tiposExcluidos: [TIPO_PAGAMENTO_MP.boleto],
      parcelasMaximas: 3,
      preencherPagador: true,
    });
  });

  it('passes a shared link with its quantity through untouched', async () => {
    await POST(
      req({
        ...CORPO,
        modo: MODO_LINK_PAGAMENTO.compartilhado,
        quantidadeMaxima: 3,
        links: [{ linkId: LINK_A, nomePagador: null, valor: 33.34 }],
      }),
    );
    const [, entrada] = h.criarLinks.mock.calls[0] as [unknown, { corpo: Record<string, unknown> }];
    expect(entrada.corpo).toMatchObject({
      modo: MODO_LINK_PAGAMENTO.compartilhado,
      quantidadeMaxima: 3,
    });
  });
});

describe('POST …/links/criar — the orchestration answer goes out verbatim', () => {
  it('201 created', async () => {
    const res = await POST(req(CORPO));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(CRIADO.corpo);
  });

  it('200 for a replay (reaproveitado) — a different status than a creation', async () => {
    const replay = { status: 200, corpo: { ...CRIADO.corpo, estado: null, reaproveitado: true } };
    h.criarLinks.mockResolvedValue(replay);
    const res = await POST(req(CORPO));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(replay.corpo);
  });

  it.each([
    [400, { error: 'Data inválida.', code: CODIGO_ERRO_LINK.corpoInvalido }],
    [404, { error: 'Pedido não encontrado.', code: CODIGO_ERRO_LINK.pedidoNaoEncontrado }],
    [
      409,
      {
        error: 'Os links somam mais do que o valor restante.',
        code: CODIGO_ERRO_LINK.naoElegivel,
        reason: MOTIVO_RECUSA_LINK.excedeRestante,
      },
    ],
    [
      409,
      {
        error: 'O total do pedido mudou.',
        code: CODIGO_ERRO_LINK.naoElegivel,
        reason: MOTIVO_RECUSA_LINK.valorDesatualizado,
      },
    ],
  ])('a %i refusal keeps its status, code and reason', async (status, corpo) => {
    h.criarLinks.mockResolvedValue({ status, corpo });
    const res = await POST(req(CORPO));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(corpo);
  });
});

describe('POST …/links/criar — error mapping', () => {
  it('a dead Mercado Pago grant → 409 MP_REAUTH_REQUIRED', async () => {
    h.criarLinks.mockRejectedValue(new MercadoPagoReauthRequiredError('no_token', 'desconectada'));
    const res = await POST(req(CORPO));
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('MP_REAUTH_REQUIRED');
  });

  it('an unknown metodo → 404 MP_CONTA_NAO_CONFIGURADA (a real answer, not a stale backend)', async () => {
    h.criarLinks.mockRejectedValue(new MercadoPagoContaNotConfiguredError('sem conta'));
    const res = await POST(req(CORPO));
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe(CODIGO_ERRO_LINK.contaNaoConfigurada);
  });

  it('an upstream HTTP failure → 502 carrying the upstream status', async () => {
    h.criarLinks.mockRejectedValue(new MercadoPagoHttpError('MP 500: boom', 500, {}));
    const res = await POST(req(CORPO));
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ code: 'MP_HTTP_ERROR', upstreamStatus: 500 });
  });

  it('a network failure → 503', async () => {
    h.criarLinks.mockRejectedValue(new MercadoPagoNetworkError('sem rede'));
    const res = await POST(req(CORPO));
    expect(res.status).toBe(503);
  });

  it('missing app credentials → 500 with the config message', async () => {
    h.criarLinks.mockRejectedValue(new MercadoPagoConfigError('MERCADO_PAGO_CLIENT_ID ausente'));
    const res = await POST(req(CORPO));
    expect(res.status).toBe(500);
  });

  it('anything that is not a Mercado Pago error RETHROWS (rule 6) — a TypeError is a bug, not a 4xx', async () => {
    h.criarLinks.mockRejectedValue(new TypeError('x is not a function'));
    await expect(POST(req(CORPO))).rejects.toThrow('x is not a function');
  });

  it('a Firestore-shaped failure rethrows too, never answering a made-up status', async () => {
    h.criarLinks.mockRejectedValue(Object.assign(new Error('DEADLINE_EXCEEDED'), { code: 4 }));
    await expect(POST(req(CORPO))).rejects.toThrow('DEADLINE_EXCEEDED');
  });
});
