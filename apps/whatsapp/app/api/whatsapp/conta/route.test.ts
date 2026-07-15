import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WhatsappContaNotConfiguredError,
  WhatsappGraphError,
  WhatsappTokenInvalidError,
  WhatsappTokenMissingError,
} from '@/lib/whatsapp/whatsapp';

// verifyCaller, the context loader and the Graph lookup are mocked; the route's
// own logic (param validation, connected/disconnected mapping, error mapping)
// runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  fetchPhone: vi.fn(),
  hasToken: vi.fn(),
  resolveToken: vi.fn(),
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
  return {
    ...actual,
    loadWhatsappContext: h.loadCtx,
    fetchWhatsappPhoneNumber: h.fetchPhone,
  };
});

const { GET } = await import('./route');

function req(params: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3008/api/whatsapp/conta');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.hasToken.mockResolvedValue(true);
  h.resolveToken.mockResolvedValue('TKN');
  h.loadCtx.mockResolvedValue({
    integracaoId: 'i1',
    conta: { phoneNumberId: 'PID', wa_id: 'PID' },
    hasToken: h.hasToken,
    resolveToken: h.resolveToken,
    phoneNumberId: () => 'PID',
  });
  h.fetchPhone.mockResolvedValue({
    display_phone_number: '+55 11 90000-0000',
    verified_name: 'Loja WA',
  });
});

describe('GET /api/whatsapp/conta', () => {
  it('returns connected + the phone identity when a token resolves', async () => {
    const res = await GET(req({ integracaoId: 'i1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connected: true,
      hasToken: true,
      phone: { display_phone_number: '+55 11 90000-0000', verified_name: 'Loja WA' },
    });
  });

  it('returns connected:false + hasToken:false when no token is stored (no Graph call)', async () => {
    h.hasToken.mockResolvedValue(false);
    const res = await GET(req({ integracaoId: 'i1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, hasToken: false, phone: null });
    expect(h.fetchPhone).not.toHaveBeenCalled();
  });

  it('degrades to 200 (hasToken:true, reason) when a token is stored but phoneNumberId is null', async () => {
    // First-connect flow: the operator saved the token before the número.
    // This must NOT 404 — it returns a degraded connected:false with a reason
    // the panel turns into a "fill in the número" hint, and never calls Graph.
    h.loadCtx.mockResolvedValue({
      integracaoId: 'i1',
      conta: { phoneNumberId: null, wa_id: null },
      hasToken: h.hasToken,
      resolveToken: h.resolveToken,
      phoneNumberId: () => {
        throw new WhatsappContaNotConfiguredError('número não configurado');
      },
    });
    const res = await GET(req({ integracaoId: 'i1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connected: false,
      hasToken: true,
      phone: null,
      reason: 'numero_nao_configurado',
    });
    expect(h.fetchPhone).not.toHaveBeenCalled();
  });

  it('returns connected:false + hasToken:true when the stored token is invalid/expired (Graph 401/190)', async () => {
    h.fetchPhone.mockRejectedValue(new WhatsappTokenInvalidError('expired'));
    const res = await GET(req({ integracaoId: 'i1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, hasToken: true, phone: null });
  });

  it('returns connected:false + hasToken:true when the token vanished between hasToken and resolve', async () => {
    h.resolveToken.mockRejectedValue(new WhatsappTokenMissingError('gone'));
    const res = await GET(req({ integracaoId: 'i1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, hasToken: true, phone: null });
  });

  it('400s without integracaoId', async () => {
    const res = await GET(req());
    expect(res.status).toBe(400);
  });

  it('maps an upstream Graph failure through the error mapper (502)', async () => {
    h.fetchPhone.mockRejectedValue(new WhatsappGraphError('boom', 500));
    const res = await GET(req({ integracaoId: 'i1' }));
    expect(res.status).toBe(502);
  });

  it('404s when the account is missing or not a WhatsApp integração', async () => {
    h.loadCtx.mockRejectedValue(new WhatsappContaNotConfiguredError('não encontrada'));
    const res = await GET(req({ integracaoId: 'i1' }));
    expect(res.status).toBe(404);
  });

  it('propagates the auth failure response from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await GET(req({ integracaoId: 'i1' }));
    expect(res.status).toBe(403);
  });
});
