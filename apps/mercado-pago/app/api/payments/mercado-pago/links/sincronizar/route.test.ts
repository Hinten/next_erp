import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PERM, hasPerm } from '@delfrance/auth';
import { MercadoPagoContaNotConfiguredError } from '@/lib/payments/mercadoPago';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
} from '@delfrance/integrations-mercado-pago';
import {
  CODIGO_ERRO_LINK,
  ESTADO_PEDIDO,
  MOTIVO_RECUSA_LINK,
  PERM_LINK_PAGAMENTO,
  ROTA_LINK_PAGAMENTO,
} from '@delfrance/schemas';

// verifyCaller, the admin singleton and the orchestration are mocked; the route's
// own logic (the permission mask, the STRICT body, the pass-through, the error
// mapping) and the real respond.ts / lerCorpo.ts run real.
const h = vi.hoisted(() => ({
  db: { __fake: 'db' },
  verifyCaller: vi.fn(),
  sincronizarPedido: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => h.db,
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/payments/links/sincronizarPedido', () => ({
  sincronizarPedido: h.sincronizarPedido,
}));

const route = await import('./route');
const { POST } = route;

const AGORA = 1_790_000_000_000;
const CORPO = { pedidoId: 'ped-1' };

const RESUMO = {
  status: 200,
  corpo: {
    encontrados: 3,
    reconciliados: 2,
    ignorados: 1,
    falhas: [],
    transicoes: [ESTADO_PEDIDO.pago],
    truncado: false,
  },
};

function req(body: unknown): Request {
  return new Request(`http://localhost:3007${ROTA_LINK_PAGAMENTO.sincronizar}`, {
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.sincronizarPedido.mockResolvedValue(RESUMO);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/payments/mercado-pago/links/sincronizar — the route itself', () => {
  it('lives at the path the shared contract advertises to the web client', () => {
    const pasta = fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/');
    expect(pasta.endsWith(`/app${ROTA_LINK_PAGAMENTO.sincronizar}/`)).toBe(true);
  });

  it('exports POST only, dynamic and on the node runtime', () => {
    expect(Object.keys(route).filter((k) => ['GET', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual(
      [],
    );
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
  });
});

describe('POST …/links/sincronizar — authorization', () => {
  it('asks for EXACTLY pedido.write | pagamento.write — it WRITES pagamentos, so `ler` is not enough', async () => {
    await POST(req(CORPO));
    const [, mascara] = h.verifyCaller.mock.calls[0] as [Request, bigint];

    expect(mascara).toBe(PERM_LINK_PAGAMENTO.gerenciar);
    expect(mascara).toBe(PERM.pedido.write | PERM.pagamento.write);
    // The read mask of the tab, and each single bit, would all be one bit short.
    expect(hasPerm(claim(PERM_LINK_PAGAMENTO.ler), mascara)).toBe(false);
    expect(hasPerm(claim(PERM.pedido.write), mascara)).toBe(false);
    expect(hasPerm(claim(PERM.pagamento.write), mascara)).toBe(false);
    expect(hasPerm(claim(PERM.pedido.write, PERM.pagamento.write), mascara)).toBe(true);
  });

  it.each([401, 403])('propagates the %i from verifyCaller and does no work', async (status) => {
    h.verifyCaller.mockResolvedValue({ error: new NextResponse(null, { status }) });
    const res = await POST(req(CORPO));
    expect(res.status).toBe(status);
    expect(h.sincronizarPedido).not.toHaveBeenCalled();
  });
});

describe('POST …/links/sincronizar — the body is STRICT', () => {
  it.each([['{not json'], ['']])('a body that is not JSON (%j) → 400', async (texto) => {
    const res = await POST(req(texto));
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe(CODIGO_ERRO_LINK.corpoInvalido);
    expect(h.sincronizarPedido).not.toHaveBeenCalled();
  });

  it('a smuggled metodoId is a 400 — the accounts are derived server-side, never chosen', async () => {
    const res = await POST(req({ ...CORPO, metodoId: 'metodo-de-outra-pessoa' }));
    expect(res.status).toBe(400);
    const corpo = await json(res);
    expect(corpo.error).toBe('Body inválido: metodoId.');
    expect(JSON.stringify(corpo)).not.toContain('metodo-de-outra-pessoa');
    expect(h.sincronizarPedido).not.toHaveBeenCalled();
  });

  it.each([
    ['no pedido id', {}, 'pedidoId'],
    ['an empty pedido id', { pedidoId: '' }, 'pedidoId'],
    ['a pedido id with a slash', { pedidoId: 'ped/1' }, 'pedidoId'],
    ['a pedido id of 65 characters', { pedidoId: 'p'.repeat(65) }, 'pedidoId'],
    ['a numeric pedido id', { pedidoId: 42 }, 'pedidoId'],
  ])('%s → 400 naming the path', async (_nome, corpo, caminho) => {
    const res = await POST(req(corpo));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe(`Body inválido: ${caminho}.`);
    expect(h.sincronizarPedido).not.toHaveBeenCalled();
  });

  it('accepts a pedido id of exactly 64 characters (the external_reference limit)', async () => {
    const pedidoId = 'p'.repeat(64);
    const res = await POST(req({ pedidoId }));
    expect(res.status).toBe(200);
    expect(h.sincronizarPedido).toHaveBeenCalledWith(h.db, { pedidoId, agoraMs: AGORA });
  });

  it('hands the orchestration the pedido id and the clock — nothing else', async () => {
    const res = await POST(req(CORPO));
    expect(res.status).toBe(200);
    expect(h.sincronizarPedido).toHaveBeenCalledTimes(1);
    expect(h.sincronizarPedido).toHaveBeenCalledWith(h.db, { pedidoId: 'ped-1', agoraMs: AGORA });
  });
});

describe('POST …/links/sincronizar — the orchestration answer goes out verbatim', () => {
  it('200 with the summary', async () => {
    const res = await POST(req(CORPO));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESUMO.corpo);
  });

  it('keeps a truncated search and its per-payment failures visible', async () => {
    const parcial = {
      status: 200,
      corpo: {
        ...RESUMO.corpo,
        falhas: [{ paymentId: '987', motivo: 'conta divergente' }],
        truncado: true,
      },
    };
    h.sincronizarPedido.mockResolvedValue(parcial);
    const res = await POST(req(CORPO));
    expect(await res.json()).toEqual(parcial.corpo);
  });

  it.each([
    [404, { error: 'Pedido não encontrado.', code: CODIGO_ERRO_LINK.pedidoNaoEncontrado }],
    [
      409,
      {
        error: 'Este pedido não tem uma conta do Mercado Pago para sincronizar.',
        code: CODIGO_ERRO_LINK.naoElegivel,
        reason: MOTIVO_RECUSA_LINK.semConta,
      },
    ],
    [
      429,
      {
        error: 'Aguarde um minuto antes de sincronizar novamente.',
        code: CODIGO_ERRO_LINK.requisicaoRepetida,
      },
    ],
  ])('a %i refusal keeps its status, code and reason', async (status, corpo) => {
    h.sincronizarPedido.mockResolvedValue({ status, corpo });
    const res = await POST(req(CORPO));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(corpo);
  });
});

describe('POST …/links/sincronizar — error mapping', () => {
  it('a dead Mercado Pago grant → 409 MP_REAUTH_REQUIRED', async () => {
    h.sincronizarPedido.mockRejectedValue(
      new MercadoPagoReauthRequiredError('no_token', 'desconectada'),
    );
    const res = await POST(req(CORPO));
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('MP_REAUTH_REQUIRED');
  });

  it('an unknown metodo → 404 MP_CONTA_NAO_CONFIGURADA', async () => {
    h.sincronizarPedido.mockRejectedValue(new MercadoPagoContaNotConfiguredError('sem conta'));
    const res = await POST(req(CORPO));
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe(CODIGO_ERRO_LINK.contaNaoConfigurada);
  });

  it('a Mercado Pago HTTP failure that is NOT the repeated-request refusal → 502', async () => {
    h.sincronizarPedido.mockRejectedValue(new MercadoPagoHttpError('MP 500: boom', 500, {}));
    const res = await POST(req(CORPO));
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ code: 'MP_HTTP_ERROR', upstreamStatus: 500 });
  });

  it('a network failure → 503', async () => {
    h.sincronizarPedido.mockRejectedValue(new MercadoPagoNetworkError('sem rede'));
    const res = await POST(req(CORPO));
    expect(res.status).toBe(503);
  });

  it('anything that is not a Mercado Pago error RETHROWS (rule 6)', async () => {
    h.sincronizarPedido.mockRejectedValue(new TypeError('x is not a function'));
    await expect(POST(req(CORPO))).rejects.toThrow('x is not a function');
  });
});
