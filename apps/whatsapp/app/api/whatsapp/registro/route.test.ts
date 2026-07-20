import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppHttpError } from '@delfrance/integrations-whatsapp-cloud-api';
import { WhatsappTokenMissingError } from '@/lib/whatsapp/whatsapp';

// verifyCaller + the context loader are mocked; the route's own logic (pin
// resolution, register/deregister, pin persistence + never-echo, error mapping)
// runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  buildClient: vi.fn(),
  register: vi.fn(async () => undefined),
  deregister: vi.fn(async () => undefined),
  load: vi.fn(),
  save: vi.fn(async () => undefined),
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

const { POST, DELETE } = await import('./route');

function postReq(body?: unknown): Request {
  return new Request('http://localhost:3008/api/whatsapp/registro', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deleteReq(params: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3008/api/whatsapp/registro');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url, { method: 'DELETE' });
}

const STORED = {
  permanent_token: 'TKN',
  phoneNumberId: 'PID',
  wa_id: 'PID',
  pin: null as string | null,
  createdAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.buildClient.mockResolvedValue({ register: h.register, deregister: h.deregister });
  h.load.mockResolvedValue({ ...STORED });
  h.loadCtx.mockResolvedValue({
    integracaoId: 'i1',
    buildClient: h.buildClient,
    store: { load: h.load, save: h.save },
  });
});

describe('POST /api/whatsapp/registro', () => {
  it('registers with an explicit 6-digit pin and persists it (never echoed)', async () => {
    const res = await POST(postReq({ integracaoId: 'i1', pin: '135790' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    // The pin must never appear in the response.
    expect(JSON.stringify(json)).not.toContain('135790');
    expect(h.register).toHaveBeenCalledWith({ pin: '135790' });
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ pin: '135790' }));
  });

  it('reuses the stored pin when the body has none (re-register)', async () => {
    h.load.mockResolvedValue({ ...STORED, pin: '246810' });
    const res = await POST(postReq({ integracaoId: 'i1' }));
    expect(res.status).toBe(200);
    expect(h.register).toHaveBeenCalledWith({ pin: '246810' });
  });

  it('400s when neither a body pin nor a stored pin exists', async () => {
    h.load.mockResolvedValue({ ...STORED, pin: null });
    const res = await POST(postReq({ integracaoId: 'i1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/PIN não cadastrado/);
    expect(h.register).not.toHaveBeenCalled();
  });

  it('400s on a malformed pin', async () => {
    const res = await POST(postReq({ integracaoId: 'i1', pin: '12ab' }));
    expect(res.status).toBe(400);
    expect(h.register).not.toHaveBeenCalled();
  });

  it('400s without integracaoId', async () => {
    const res = await POST(postReq({ pin: '135790' }));
    expect(res.status).toBe(400);
  });

  it('maps the register cap (code 133016) to 429', async () => {
    h.register.mockRejectedValue(
      new WhatsAppHttpError(
        'register',
        400,
        JSON.stringify({ error: { code: 133016, message: 'too many attempts' } }),
      ),
    );
    const res = await POST(postReq({ integracaoId: 'i1', pin: '135790' }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.code).toBe('WA_RATE_LIMIT');
    // Even on the cap error, the pin never leaks into the response.
    expect(JSON.stringify(json)).not.toContain('135790');
  });

  it('409s (reauth) when there is no token to register with', async () => {
    h.buildClient.mockRejectedValue(new WhatsappTokenMissingError('sem token'));
    const res = await POST(postReq({ integracaoId: 'i1', pin: '135790' }));
    expect(res.status).toBe(409);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('propagates the auth failure response from verifyCaller', async () => {
    h.verifyCaller.mockResolvedValue({
      error: new (await import('next/server')).NextResponse(null, { status: 403 }),
    });
    const res = await POST(postReq({ integracaoId: 'i1', pin: '135790' }));
    expect(res.status).toBe(403);
    expect(h.register).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/whatsapp/registro', () => {
  it('deregisters and returns { ok: true }, keeping the stored pin', async () => {
    const res = await DELETE(deleteReq({ integracaoId: 'i1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.deregister).toHaveBeenCalledTimes(1);
    // The pin store is untouched on deregister.
    expect(h.save).not.toHaveBeenCalled();
  });

  it('400s without integracaoId', async () => {
    const res = await DELETE(deleteReq());
    expect(res.status).toBe(400);
    expect(h.deregister).not.toHaveBeenCalled();
  });

  it('propagates the auth failure response from verifyCaller', async () => {
    h.verifyCaller.mockResolvedValue({
      error: new (await import('next/server')).NextResponse(null, { status: 403 }),
    });
    const res = await DELETE(deleteReq({ integracaoId: 'i1' }));
    expect(res.status).toBe(403);
    expect(h.deregister).not.toHaveBeenCalled();
  });
});
