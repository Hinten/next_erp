import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsappContaNotConfiguredError } from '@/lib/whatsapp/whatsapp';

// verifyCaller and the WhatsApp context loader are mocked; the route's own logic
// (param validation, save/revoke, never-echo-the-token, error mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  save: vi.fn(async () => undefined),
  revoke: vi.fn(async () => undefined),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/whatsapp/whatsapp', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/whatsapp/whatsapp')>();
  return { ...actual, loadWhatsappContext: h.loadCtx };
});

const { POST, DELETE } = await import('./route');

function postReq(body?: unknown): Request {
  return new Request('http://localhost:3008/api/whatsapp/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deleteReq(params: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3008/api/whatsapp/token');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url, { method: 'DELETE' });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.loadCtx.mockResolvedValue({
    integracaoId: 'i1',
    conta: { phoneNumberId: 'PID', wa_id: 'PID' },
    store: { save: h.save, revoke: h.revoke },
  });
});

describe('POST /api/whatsapp/token', () => {
  it('stores the token and returns { ok: true } WITHOUT echoing the token', async () => {
    const res = await POST(postReq({ integracaoId: 'i1', token: 'SECRET-TKN' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    // The token must never be reflected back to the caller.
    expect(JSON.stringify(json)).not.toContain('SECRET-TKN');

    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledWith({
      permanent_token: 'SECRET-TKN',
      phoneNumberId: 'PID',
      wa_id: 'PID',
      // Passed as null so store.save carries any stored pin forward.
      pin: null,
      createdAt: expect.any(Number),
    });
  });

  it('400s when integracaoId is missing', async () => {
    const res = await POST(postReq({ token: 'SECRET-TKN' }));
    expect(res.status).toBe(400);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('400s when token is missing', async () => {
    const res = await POST(postReq({ integracaoId: 'i1' }));
    expect(res.status).toBe(400);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('404s (via the error mapper) when the account is not a WhatsApp integração', async () => {
    h.loadCtx.mockRejectedValue(new WhatsappContaNotConfiguredError('não é WhatsApp'));
    const res = await POST(postReq({ integracaoId: 'i1', token: 'SECRET-TKN' }));
    expect(res.status).toBe(404);
  });

  it('propagates the auth failure response from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await POST(postReq({ integracaoId: 'i1', token: 'SECRET-TKN' }));
    expect(res.status).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/whatsapp/token', () => {
  it('revokes the stored credential and returns { ok: true }', async () => {
    const res = await DELETE(deleteReq({ integracaoId: 'i1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.revoke).toHaveBeenCalledTimes(1);
  });

  it('400s without integracaoId', async () => {
    const res = await DELETE(deleteReq());
    expect(res.status).toBe(400);
    expect(h.revoke).not.toHaveBeenCalled();
  });

  it('propagates the auth failure response from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await DELETE(deleteReq({ integracaoId: 'i1' }));
    expect(res.status).toBe(403);
    expect(h.revoke).not.toHaveBeenCalled();
  });
});
