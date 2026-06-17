import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  tracking: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/freight/melhorEnvio', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/freight/melhorEnvio')>();
  return { ...actual, loadMelhorEnvioContext: h.loadCtx };
});

const { POST } = await import('./route');

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3001/api/freight/melhor-envio/rastrear', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const READER = { uid: 'u1', permissions: PERM.frete.read.toString() };
const VALID_BODY = { intFreteId: 'int-1', printLabelId: 'label-1' };

beforeEach(() => {
  vi.clearAllMocks();
  h.tracking.mockResolvedValue({ 'label-1': { status: 'posted', tracking: 'ME123BR' } });
  h.loadCtx.mockResolvedValue({ intFreteId: 'int-1', api: { tracking: h.tracking } });
});

describe('POST /api/freight/melhor-envio/rastrear', () => {
  it('returns 401 without an Authorization header', async () => {
    expect((await POST(req(VALID_BODY))).status).toBe(401);
  });

  it('returns 403 for a caller without frete.read', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: (1n << 0n).toString() });
    expect((await POST(req(VALID_BODY, { authorization: 'Bearer t' }))).status).toBe(403);
  });

  it('returns 400 when printLabelId is missing', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    expect((await POST(req({ intFreteId: 'int-1' }, { authorization: 'Bearer t' }))).status).toBe(
      400,
    );
  });

  it('returns 200 with the tracking payload', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tracking: { 'label-1': { status: 'posted', tracking: 'ME123BR' } },
    });
    expect(h.tracking).toHaveBeenCalledWith(['label-1']);
  });
});
