import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsappContaNotConfiguredError } from '@/lib/whatsapp/whatsapp';

// verifyCaller + the aggregator are mocked; the route's own logic (param
// validation, error mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  buildHealth: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/whatsapp/health', () => ({ buildWhatsappHealth: h.buildHealth }));

const { GET } = await import('./route');

function req(params: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3008/api/whatsapp/health');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

const HEALTH = {
  generatedAt: 1_700_000_000_000,
  canSend: true,
  canReceive: true,
  checks: [{ id: 'token', status: 'ok', label: 'Token', detail: 'Token cadastrado', hint: null }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.buildHealth.mockResolvedValue(HEALTH);
});

describe('GET /api/whatsapp/health', () => {
  it('returns the aggregation', async () => {
    const res = await GET(req({ integracaoId: 'i1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(HEALTH);
    expect(h.buildHealth).toHaveBeenCalledWith(expect.anything(), 'i1');
  });

  it('400s without integracaoId', async () => {
    const res = await GET(req());
    expect(res.status).toBe(400);
    expect(h.buildHealth).not.toHaveBeenCalled();
  });

  it('404s when the account is missing or not a WhatsApp integração', async () => {
    h.buildHealth.mockRejectedValue(new WhatsappContaNotConfiguredError('não encontrada'));
    const res = await GET(req({ integracaoId: 'i1' }));
    expect(res.status).toBe(404);
  });

  it('propagates the auth failure response from verifyCaller', async () => {
    h.verifyCaller.mockResolvedValue({
      error: new (await import('next/server')).NextResponse(null, { status: 403 }),
    });
    const res = await GET(req({ integracaoId: 'i1' }));
    expect(res.status).toBe(403);
    expect(h.buildHealth).not.toHaveBeenCalled();
  });
});
