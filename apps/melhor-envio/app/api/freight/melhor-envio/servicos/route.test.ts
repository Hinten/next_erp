import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  MelhorEnvioHttpError,
  MelhorEnvioReauthRequiredError,
} from '@delfrance/integrations-freight-br';
import {
  createFreightHttpClient,
  FreightNotFoundError,
} from '@delfrance/integrations-freight-br/http-client';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  docRefGet: vi.fn(),
  parseRead: vi.fn(),
  listServices: vi.fn(),
  loadCtx: vi.fn(),
  loadReal: null as null | ((...args: never[]) => Promise<unknown>),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

// The `int_frete` doc the REAL loader reads in the refusal cases — the doc read
// and its parse are faked, every other handle stays real.
vi.mock('@delfrance/data/admin/collections', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/data/admin/collections')>();
  return {
    ...actual,
    intFreteCollection: {
      docRef: () => ({ get: h.docRefGet }),
      parseRead: (...args: unknown[]) => h.parseRead(...args),
      docPath: (_ctx: unknown, id: string) => `int_frete/${id}`,
    },
  };
});

// Each test picks the loader: a fake context (the default), or the real one.
vi.mock('@/lib/freight/melhorEnvio', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/freight/melhorEnvio')>();
  h.loadReal = actual.loadMelhorEnvioContext as never;
  return { ...actual, loadMelhorEnvioContext: h.loadCtx };
});

const { GET } = await import('./route');

const URL_ROTA = 'http://localhost:3005/api/freight/melhor-envio/servicos';

function req(params: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL(URL_ROTA);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url, { headers });
}

const BEARER = { authorization: 'Bearer t' };
const READER = { uid: 'u1', permissions: PERM.frete.read.toString() };
const SERVICOS = [
  { id: 1, name: 'Econômico', company: { id: 1, name: 'Transportadora A', picture: null } },
  { id: 3, name: 'Expresso', company: { id: 2, name: 'Transportadora B' }, type: 'normal' },
];

/** Run the real `loadMelhorEnvioContext` over a faked `int_frete` read. */
function usarLoaderReal(doc: { tipo: string } | null): void {
  if (h.loadReal === null) throw new TypeError('the real loader was never captured');
  h.loadCtx.mockImplementation(h.loadReal);
  h.docRefGet.mockResolvedValue(
    doc === null ? { exists: false } : { exists: true, data: () => doc },
  );
  h.parseRead.mockReturnValue(doc);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  // No test reaches a network: an accidental Melhor Envio call fails loudly.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('network is forbidden in this suite');
    }),
  );
  h.listServices.mockResolvedValue(SERVICOS);
  h.loadCtx.mockImplementation(async () => ({
    intFreteId: 'int-1',
    api: { listServices: h.listServices },
  }));
});

afterEach(() => {
  __resetAllReadCaches();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GET /api/freight/melhor-envio/servicos', () => {
  it('returns 401 without an Authorization header', async () => {
    expect((await GET(req({ intFreteId: 'int-1' }))).status).toBe(401);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('returns 403 to a caller who may write freight configs but not read them', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: PERM.frete.write.toString() });

    const res = await GET(req({ intFreteId: 'int-1' }, BEARER));

    expect(res.status).toBe(403);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', {}],
    ['empty', { intFreteId: '' }],
    ['a path (an odd segment count)', { intFreteId: 'int-1/tokenMelEnv' }],
    ['a path (an even segment count)', { intFreteId: 'int-1/tokenMelEnv/current' }],
  ])('returns 400 when intFreteId is %s, before any read', async (_caso, params) => {
    h.verifyIdToken.mockResolvedValue(READER);

    const res = await GET(req(params, BEARER));

    expect(res.status).toBe(400);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.listServices).not.toHaveBeenCalled();
  });

  it("returns the account's services as { servicos }", async () => {
    h.verifyIdToken.mockResolvedValue(READER);

    const res = await GET(req({ intFreteId: 'int-1' }, BEARER));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ servicos: SERVICOS });
    expect(h.loadCtx).toHaveBeenCalledWith(expect.anything(), 'int-1');
    expect(h.listServices).toHaveBeenCalledTimes(1);
  });

  describe('the int_frete doc, through the real loader', () => {
    it('refuses a doc of another freight tipo with 404, without listing services', async () => {
      h.verifyIdToken.mockResolvedValue(READER);
      usarLoaderReal({ tipo: 'motoboy' });

      const res = await GET(req({ intFreteId: 'int-1' }, BEARER));

      expect(res.status).toBe(404);
      expect(h.docRefGet).toHaveBeenCalledTimes(1);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses an absent doc with 404', async () => {
      h.verifyIdToken.mockResolvedValue(READER);
      usarLoaderReal(null);

      const res = await GET(req({ intFreteId: 'int-1' }, BEARER));

      expect(res.status).toBe(404);
    });

    it('near-miss: a Melhor Envio doc passes the tipo check (and stops at the missing credentials)', async () => {
      // Proves the 404 above is the TIPO refusal, not a blanket one. The
      // credentials are blanked so the context is never built and no call leaves.
      h.verifyIdToken.mockResolvedValue(READER);
      vi.stubEnv('MELHOR_ENVIO_CLIENT_ID', '');
      usarLoaderReal({ tipo: 'melhorEnvios' });

      const res = await GET(req({ intFreteId: 'int-1' }, BEARER));

      expect(res.status).toBe(500);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  it('maps an account that needs reconnecting to 409 ME_REAUTH', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    h.listServices.mockRejectedValue(
      new MelhorEnvioReauthRequiredError('no_token', 'Conta não conectada.'),
    );

    const res = await GET(req({ intFreteId: 'int-1' }, BEARER));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ME_REAUTH' });
  });

  it('maps an upstream Melhor Envio failure to 502', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    h.listServices.mockRejectedValue(new MelhorEnvioHttpError('ME caiu', 500, null));

    const res = await GET(req({ intFreteId: 'int-1' }, BEARER));

    expect(res.status).toBe(502);
  });

  it('rethrows an error it does not know', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    h.listServices.mockRejectedValue(new RangeError('bug'));

    await expect(GET(req({ intFreteId: 'int-1' }, BEARER))).rejects.toBeInstanceOf(RangeError);
  });
});

describe('the browser client against this route', () => {
  // The client is what apps/web calls, so the contract is the pair: the path,
  // the query param and a body that passes the client's response schema. Any
  // other path answers like a backend without the route.
  function cliente() {
    return createFreightHttpClient({
      baseUrl: 'http://localhost:3005',
      getAuthToken: async () => 't',
      fetch: async (input, init) => {
        const pedido = new Request(input, init);
        if (new URL(pedido.url).pathname !== new URL(URL_ROTA).pathname) {
          return new Response('<!DOCTYPE html><html>404</html>', { status: 404 });
        }
        return GET(pedido);
      },
    });
  }

  it('reads the services through its schema', async () => {
    h.verifyIdToken.mockResolvedValue(READER);

    await expect(cliente().servicos('int-1')).resolves.toEqual({ servicos: SERVICOS });
    expect(h.loadCtx).toHaveBeenCalledWith(expect.anything(), 'int-1');
  });

  it('reads the tipo refusal as FreightNotFoundError', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    usarLoaderReal({ tipo: 'motoboy' });

    await expect(cliente().servicos('int-1')).rejects.toBeInstanceOf(FreightNotFoundError);
  });
});
