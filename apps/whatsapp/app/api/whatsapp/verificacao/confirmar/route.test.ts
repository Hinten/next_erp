import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppHttpError } from '@delfrance/integrations-whatsapp-cloud-api';

// verifyCaller, the context loader and the admin collection merge are mocked;
// the route's own logic (param validation, verify → flag verified, error
// mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  buildClient: vi.fn(),
  verifyCode: vi.fn(async () => undefined),
  merge: vi.fn(async () => undefined),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@delfrance/data/admin/collections', () => ({
  integracaoCollection: { merge: h.merge },
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/whatsapp/whatsapp', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/whatsapp/whatsapp')>();
  return { ...actual, loadWhatsappContext: h.loadCtx };
});

const { POST } = await import('./route');

function postReq(body?: unknown): Request {
  return new Request('http://localhost:3008/api/whatsapp/verificacao/confirmar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.buildClient.mockResolvedValue({ verifyCode: h.verifyCode });
  h.loadCtx.mockResolvedValue({ integracaoId: 'i1', buildClient: h.buildClient });
});

describe('POST /api/whatsapp/verificacao/confirmar', () => {
  it('verifies the code, flags the account verified, and returns { ok, verificado }', async () => {
    const res = await POST(postReq({ integracaoId: 'i1', codigo: '123456' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, verificado: true });
    expect(h.verifyCode).toHaveBeenCalledWith({ code: '123456' });
    expect(h.merge).toHaveBeenCalledWith(expect.anything(), {}, 'i1', { verificado: true });
  });

  it('400s without integracaoId or codigo', async () => {
    expect((await POST(postReq({ codigo: '123456' }))).status).toBe(400);
    expect((await POST(postReq({ integracaoId: 'i1' }))).status).toBe(400);
    expect(h.verifyCode).not.toHaveBeenCalled();
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('does NOT flag verified when the code is rejected (2xx without success)', async () => {
    h.verifyCode.mockRejectedValue(new WhatsAppHttpError('verifyCode', 200, '{"success":false}'));
    const res = await POST(postReq({ integracaoId: 'i1', codigo: '000000' }));
    // A 2xx-without-success maps to the "other HTTP" branch → 502.
    expect(res.status).toBe(502);
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('surfaces error_user_msg on an upstream 400', async () => {
    h.verifyCode.mockRejectedValue(
      new WhatsAppHttpError(
        'verifyCode',
        400,
        JSON.stringify({ error: { message: 'x', error_user_msg: 'Código incorreto.' } }),
      ),
    );
    const res = await POST(postReq({ integracaoId: 'i1', codigo: '999999' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Código incorreto.');
    expect(h.merge).not.toHaveBeenCalled();
  });

  it('propagates the auth failure response from verifyCaller', async () => {
    h.verifyCaller.mockResolvedValue({
      error: new (await import('next/server')).NextResponse(null, { status: 403 }),
    });
    const res = await POST(postReq({ integracaoId: 'i1', codigo: '123456' }));
    expect(res.status).toBe(403);
    expect(h.verifyCode).not.toHaveBeenCalled();
  });
});
