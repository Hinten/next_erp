import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PERM, hasPerm } from '@delfrance/auth';
import { MercadoPagoContaNotConfiguredError } from '@/lib/payments/mercadoPago';
import {
  MercadoPagoHttpError,
  MercadoPagoReauthRequiredError,
} from '@delfrance/integrations-mercado-pago';
import {
  CODIGO_ERRO_LINK,
  MOTIVO_RECUSA_LINK,
  PERM_LINK_PAGAMENTO,
  ROTA_LINK_PAGAMENTO,
  STATUS_LINK_PAGAMENTO,
} from '@delfrance/schemas';

// verifyCaller, the admin singleton and the orchestration are mocked; the route's
// own logic (the permission mask, the STRICT body, the pass-through, the error
// mapping) and the real respond.ts / lerCorpo.ts run real.
const h = vi.hoisted(() => ({
  db: { __fake: 'db' },
  verifyCaller: vi.fn(),
  cancelarLink: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => h.db,
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/payments/links/cancelarLink', () => ({ cancelarLink: h.cancelarLink }));

const route = await import('./route');
const { POST } = route;

const AGORA = 1_790_000_000_000;
const LINK = 'AAAAAAAAAAAAAAAAAAAA';
const CORPO = { pedidoId: 'ped-1', linkId: LINK };

function req(body: unknown): Request {
  return new Request(`http://localhost:3007${ROTA_LINK_PAGAMENTO.cancelar}`, {
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
  h.cancelarLink.mockResolvedValue({
    status: 200,
    corpo: { linkId: LINK, status: STATUS_LINK_PAGAMENTO.cancelado },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/payments/mercado-pago/links/cancelar — the route itself', () => {
  it('lives at the path the shared contract advertises to the web client', () => {
    const pasta = fileURLToPath(new URL('.', import.meta.url)).replaceAll('\\', '/');
    expect(pasta.endsWith(`/app${ROTA_LINK_PAGAMENTO.cancelar}/`)).toBe(true);
  });

  it('exports POST only, dynamic and on the node runtime', () => {
    expect(Object.keys(route).filter((k) => ['GET', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual(
      [],
    );
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
  });
});

describe('POST …/links/cancelar — authorization', () => {
  it('asks for EXACTLY pedido.write | pagamento.write — one bit is not enough', async () => {
    await POST(req(CORPO));
    const [, mascara] = h.verifyCaller.mock.calls[0] as [Request, bigint];

    expect(mascara).toBe(PERM_LINK_PAGAMENTO.gerenciar);
    expect(mascara).toBe(PERM.pedido.write | PERM.pagamento.write);
    expect(hasPerm(claim(PERM.pedido.write), mascara)).toBe(false);
    expect(hasPerm(claim(PERM.pagamento.write), mascara)).toBe(false);
    expect(hasPerm(claim(PERM.pedido.write, PERM.pagamento.write), mascara)).toBe(true);
  });

  it.each([401, 403])('propagates the %i from verifyCaller and does no work', async (status) => {
    h.verifyCaller.mockResolvedValue({ error: new NextResponse(null, { status }) });
    const res = await POST(req(CORPO));
    expect(res.status).toBe(status);
    expect(h.cancelarLink).not.toHaveBeenCalled();
  });
});

describe('POST …/links/cancelar — the body is STRICT', () => {
  it.each([['{not json'], ['']])('a body that is not JSON (%j) → 400', async (texto) => {
    const res = await POST(req(texto));
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe(CODIGO_ERRO_LINK.corpoInvalido);
    expect(h.cancelarLink).not.toHaveBeenCalled();
  });

  it('a smuggled metodoId is a 400, NOT ignored — the account is read from the link doc', async () => {
    const res = await POST(req({ ...CORPO, metodoId: 'metodo-de-outra-pessoa' }));
    expect(res.status).toBe(400);
    const corpo = await json(res);
    expect(corpo.error).toBe('Body inválido: metodoId.');
    expect(JSON.stringify(corpo)).not.toContain('metodo-de-outra-pessoa');
    expect(h.cancelarLink).not.toHaveBeenCalled();
  });

  it.each([
    ['a link id of 19 characters', { ...CORPO, linkId: LINK.slice(0, 19) }, 'linkId'],
    ['a link id of 21 characters', { ...CORPO, linkId: `${LINK}A` }, 'linkId'],
    ['a link id with a slash', { ...CORPO, linkId: `${LINK.slice(0, 19)}/` }, 'linkId'],
    ['a pedido id with a slash', { ...CORPO, pedidoId: 'ped/1' }, 'pedidoId'],
    ['no pedido id', { linkId: LINK }, 'pedidoId'],
    ['no link id', { pedidoId: 'ped-1' }, 'linkId'],
    ['a numeric link id', { ...CORPO, linkId: 42 }, 'linkId'],
  ])('%s → 400 naming the path', async (_nome, corpo, caminho) => {
    const res = await POST(req(corpo));
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe(`Body inválido: ${caminho}.`);
    expect(h.cancelarLink).not.toHaveBeenCalled();
  });

  it('hands the orchestration the caller uid, the two ids and the clock — nothing else', async () => {
    const res = await POST(req(CORPO));
    expect(res.status).toBe(200);
    expect(h.cancelarLink).toHaveBeenCalledTimes(1);
    expect(h.cancelarLink).toHaveBeenCalledWith(h.db, {
      uid: 'u1',
      pedidoId: 'ped-1',
      linkId: LINK,
      agoraMs: AGORA,
    });
  });
});

describe('POST …/links/cancelar — the orchestration answer goes out verbatim', () => {
  it('200 with the stored status', async () => {
    const res = await POST(req(CORPO));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linkId: LINK, status: STATUS_LINK_PAGAMENTO.cancelado });
  });

  it('200 for an ALREADY-terminal link reports the status it has, not `cancelado`', async () => {
    h.cancelarLink.mockResolvedValue({
      status: 200,
      corpo: { linkId: LINK, status: STATUS_LINK_PAGAMENTO.concluido },
    });
    const res = await POST(req(CORPO));
    expect(await res.json()).toEqual({ linkId: LINK, status: STATUS_LINK_PAGAMENTO.concluido });
  });

  it.each([
    [404, { error: 'Link de pagamento não encontrado.', code: CODIGO_ERRO_LINK.linkNaoEncontrado }],
    [
      409,
      {
        error: 'O Mercado Pago não permite alterar este link.',
        code: CODIGO_ERRO_LINK.naoElegivel,
        reason: MOTIVO_RECUSA_LINK.preferenciaInacessivel,
      },
    ],
    [
      409,
      {
        error: 'Este link não tem uma preferência no Mercado Pago para encerrar.',
        code: CODIGO_ERRO_LINK.naoElegivel,
        reason: MOTIVO_RECUSA_LINK.semPreferencia,
      },
    ],
  ])('a %i refusal keeps its status, code and reason', async (status, corpo) => {
    h.cancelarLink.mockResolvedValue({ status, corpo });
    const res = await POST(req(CORPO));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(corpo);
  });
});

describe('POST …/links/cancelar — error mapping', () => {
  it('a dead Mercado Pago grant → 409 MP_REAUTH_REQUIRED', async () => {
    h.cancelarLink.mockRejectedValue(
      new MercadoPagoReauthRequiredError('no_token', 'desconectada'),
    );
    const res = await POST(req(CORPO));
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('MP_REAUTH_REQUIRED');
  });

  it('an unknown metodo on the link doc → 404 MP_CONTA_NAO_CONFIGURADA', async () => {
    h.cancelarLink.mockRejectedValue(new MercadoPagoContaNotConfiguredError('sem conta'));
    const res = await POST(req(CORPO));
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe(CODIGO_ERRO_LINK.contaNaoConfigurada);
  });

  it('an upstream HTTP failure → 502', async () => {
    h.cancelarLink.mockRejectedValue(new MercadoPagoHttpError('MP 500: boom', 500, {}));
    const res = await POST(req(CORPO));
    expect(res.status).toBe(502);
  });

  it('anything that is not a Mercado Pago error RETHROWS (rule 6)', async () => {
    h.cancelarLink.mockRejectedValue(new TypeError('x is not a function'));
    await expect(POST(req(CORPO))).rejects.toThrow('x is not a function');
  });
});
