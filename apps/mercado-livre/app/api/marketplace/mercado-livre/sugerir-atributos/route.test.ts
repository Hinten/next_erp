import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVEDOR_IA, configIaSchema, type ConfigIa } from '@delfrance/schemas';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  config: null as ConfigIa | null,
  suggest: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
  getAdminBucket: () => ({}),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/ai/configIa', () => ({
  loadConfigIa: async () => h.config,
}));

// Guard: reaching any of these means the gate under test did NOT decline.
vi.mock('@/lib/marketplace/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/mercadoLivre')>();
  return {
    ...actual,
    loadMercadoLivreContext: async () => {
      throw new Error('must not reach ML — the request should have been declined');
    },
  };
});
vi.mock('@/lib/ai/suggestAttributes', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/ai/suggestAttributes')>();
  return { ...actual, suggestAttributes: h.suggest };
});

const { POST } = await import('./route');

const req = (body: unknown) =>
  new Request('http://localhost:3006/api/marketplace/mercado-livre/sugerir-atributos', {
    method: 'POST',
    body: JSON.stringify(body),
  });

const BODY = { integracaoId: 'int-1', produtoId: 'prod-1', categoryId: 'MLB31447' };

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.config = configIaSchema.parse({});
});

describe('the settings gates run BEFORE anything is spent', () => {
  it('declines when the agent is switched off', async () => {
    h.config = configIaSchema.parse({ ativo: false });
    const res = await POST(req(BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'AI_DESATIVADA' });
  });

  it('declines a provedor that is not wired, instead of silently using Vertex', async () => {
    // ⚠️ `provedor` used to be WRITE-ONLY: the route calls
    // `createVertexGenerateFn()` unconditionally, so an operator could select
    // "Google AI", save, get a green confirmation, and every suggestion would
    // still run on Vertex with nothing anywhere saying so. A silent no-op is
    // worse than a refusal, and this is also the place a future second provider
    // fails loudly until it is actually implemented.
    h.config = configIaSchema.parse({ provedor: PROVEDOR_IA.googleai });
    const res = await POST(req(BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'AI_PROVEDOR_NAO_SUPORTADO' });
    expect(h.suggest).not.toHaveBeenCalled();
  });

  it('lets Vertex through to the work', async () => {
    // The gate must not reject the one provider that IS wired — otherwise the
    // two tests above would pass with the feature entirely disabled.
    h.config = configIaSchema.parse({ provedor: PROVEDOR_IA.vertex });
    // Reaching `loadMercadoLivreContext` is the proof; its mock throws, which
    // this route does not catch, so the rejection IS the signal.
    await expect(POST(req(BODY))).rejects.toThrow(/must not reach ML/);
  });

  it('still validates the body before consulting the settings', async () => {
    expect((await POST(req({ produtoId: 'p', categoryId: 'c' }))).status).toBe(400);
  });
});
