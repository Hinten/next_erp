import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  MelhorEnvioReauthRequiredError,
  MelhorEnvioValidationError,
} from '@delfrance/integrations-freight-br';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  calculate: vi.fn(),
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
  return new Request('http://localhost:3001/api/freight/melhor-envio/calculate', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const READER = { uid: 'u1', permissions: PERM.frete.read.toString() };

const VALID_BODY = {
  intFreteId: 'int-1',
  from: { postal_code: '01001000' },
  to: { postal_code: '20040002' },
  package: { width: 20, height: 20, length: 20, weight: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.loadCtx.mockResolvedValue({ intFreteId: 'int-1', api: { calculate: h.calculate } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/freight/melhor-envio/calculate', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a caller without frete.read', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: (1n << 0n).toString() });
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(403);
  });

  it('returns 400 for an invalid JSON body', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    const res = await POST(req('not json', { authorization: 'Bearer t' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when the body fails schema validation', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    const res = await POST(req({ intFreteId: 'int-1' }, { authorization: 'Bearer t' }));
    expect(res.status).toBe(400);
    expect(h.calculate).not.toHaveBeenCalled();
  });

  it('returns 200 with the quotes, including per-service error entries', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    const quotes = [
      { id: 1, name: 'PAC', price: '25.00', company: { id: 1, name: 'Correios' } },
      { id: 2, name: 'Sedex', error: 'Indisponível para a rota' },
    ];
    h.calculate.mockResolvedValue(quotes);

    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(quotes);
    // The route strips intFreteId before proxying to the ME API.
    expect(h.calculate).toHaveBeenCalledWith(
      expect.objectContaining({ from: VALID_BODY.from, to: VALID_BODY.to }),
    );
    expect(h.calculate.mock.calls[0]![0]).not.toHaveProperty('intFreteId');
  });

  it('maps a 422 validation failure to 422 with the field errors', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    h.calculate.mockRejectedValue(
      new MelhorEnvioValidationError('CEP inválido', { 'to.postal_code': ['inválido'] }, {}),
    );
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toEqual({ 'to.postal_code': ['inválido'] });
  });

  it('maps a dead token to 409 ME_REAUTH', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    h.calculate.mockRejectedValue(
      new MelhorEnvioReauthRequiredError('no_token', 'Conta não conectada.'),
    );
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ME_REAUTH');
  });
});
