import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppHttpError } from '@delfrance/integrations-whatsapp-cloud-api';
import { WhatsappTokenMissingError } from '@/lib/whatsapp/whatsapp';

// verifyCaller + the context loader are mocked; the route's own logic (param
// validation, client call, error mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  buildClient: vi.fn(),
  requestVerificationCode: vi.fn(async () => undefined),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

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
  return new Request('http://localhost:3008/api/whatsapp/verificacao/solicitar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.buildClient.mockResolvedValue({ requestVerificationCode: h.requestVerificationCode });
  h.loadCtx.mockResolvedValue({ integracaoId: 'i1', buildClient: h.buildClient });
});

describe('POST /api/whatsapp/verificacao/solicitar', () => {
  it('requests the code and returns { ok: true }', async () => {
    const res = await POST(postReq({ integracaoId: 'i1', metodo: 'SMS' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.requestVerificationCode).toHaveBeenCalledWith({ codeMethod: 'SMS' });
  });

  it('accepts VOICE too', async () => {
    await POST(postReq({ integracaoId: 'i1', metodo: 'VOICE' }));
    expect(h.requestVerificationCode).toHaveBeenCalledWith({ codeMethod: 'VOICE' });
  });

  it('400s without integracaoId', async () => {
    const res = await POST(postReq({ metodo: 'SMS' }));
    expect(res.status).toBe(400);
    expect(h.requestVerificationCode).not.toHaveBeenCalled();
  });

  it('400s on an invalid metodo', async () => {
    const res = await POST(postReq({ integracaoId: 'i1', metodo: 'EMAIL' }));
    expect(res.status).toBe(400);
    expect(h.requestVerificationCode).not.toHaveBeenCalled();
  });

  it('409s (reauth) when no token is stored', async () => {
    h.buildClient.mockRejectedValue(new WhatsappTokenMissingError('sem token'));
    const res = await POST(postReq({ integracaoId: 'i1', metodo: 'SMS' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('WA_REAUTH_REQUIRED');
  });

  it('surfaces error_user_msg on an upstream 400', async () => {
    h.requestVerificationCode.mockRejectedValue(
      new WhatsAppHttpError(
        'requestVerificationCode',
        400,
        JSON.stringify({ error: { message: 'generic', error_user_msg: 'Número já verificado.' } }),
      ),
    );
    const res = await POST(postReq({ integracaoId: 'i1', metodo: 'SMS' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Número já verificado.');
  });

  it('propagates the auth failure response from verifyCaller', async () => {
    h.verifyCaller.mockResolvedValue({
      error: new (await import('next/server')).NextResponse(null, { status: 403 }),
    });
    const res = await POST(postReq({ integracaoId: 'i1', metodo: 'SMS' }));
    expect(res.status).toBe(403);
    expect(h.requestVerificationCode).not.toHaveBeenCalled();
  });
});
