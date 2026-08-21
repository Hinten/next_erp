import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVEDOR_IA, configIaSchema, type ConfigIa } from '@delfrance/schemas';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  config: null as ConfigIa | null,
  suggest: vi.fn(),
  loadCtx: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
  getAdminBucket: () => ({}),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

// Spread the real module: the route imports the provider factories, the model
// cache and the image loader from here too, and a bare object would leave those
// undefined — the route would then fail on the import rather than on the gate
// this test is actually about.
//
// ⚠️ The Vertex factories are stubbed too. `packages/ai` must never reach
// Vertex/ADC/network from a test, and the route calls `createVertexGenerateFn()`
// and `getAiModelosCached(createVertexListModelsFn())` on the way to the work —
// so any test that goes PAST the gates would otherwise try to authenticate.
vi.mock('@delfrance/ai/admin', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/ai/admin')>();
  return {
    ...actual,
    loadConfigIa: async () => h.config,
    createVertexGenerateFn: () => async () => '{}',
    createVertexListModelsFn: () => async () => [],
    getAiModelosCached: async () => ({ fonte: 'fallback' as const, modelos: [], motivo: null }),
  };
});

// Guard: reaching any of these means the gate under test did NOT decline.
vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
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

/** Lets a request run all the way to `suggestAttributes`, offline. */
const deixarPassar = () => {
  h.loadCtx.mockResolvedValue({
    resolveChannelContext: async () => ({ accessToken: 'tok' }),
  });
  h.suggest.mockResolvedValue({ leaf: true, sugestoes: [], atributos: [] });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.config = configIaSchema.parse({});
  // Default: reaching ML means a gate under test did NOT decline.
  h.loadCtx.mockRejectedValue(
    new Error('must not reach ML — the request should have been declined'),
  );
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

/**
 * ⚠️ Both halves of a revise turn are FREE-FORM CLIENT INPUT that lands in a
 * prompt, so both are bounded before a token is spent. `feedback` was capped
 * from the start; `anterior` was not, which left an unbounded prior answer
 * walking into the same prompt on a per-click path.
 */
describe('the revise turn is bounded before anything is spent', () => {
  const anterior = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `A${String(i)}`, value_name: 'x' }));

  it('rejects a feedback longer than the cap', async () => {
    const res = await POST(req({ ...BODY, feedback: 'x'.repeat(1_001) }));
    expect(res.status).toBe(400);
    expect(h.suggest).not.toHaveBeenCalled();
  });

  it('rejects an anterior that is not a list', async () => {
    expect((await POST(req({ ...BODY, anterior: 'BRAND' }))).status).toBe(400);
  });

  it('rejects an anterior longer than the cap', async () => {
    const res = await POST(req({ ...BODY, feedback: 'de novo', anterior: anterior(61) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('60') });
    expect(h.suggest).not.toHaveBeenCalled();
  });

  it('lets an anterior at the cap through to the work', async () => {
    // Without this the cap could be off by any amount and the test above would
    // still pass — including a cap of zero, which would break every revision.
    deixarPassar();
    expect((await POST(req({ ...BODY, feedback: 'de novo', anterior: anterior(60) }))).status).toBe(
      200,
    );
    expect(h.suggest).toHaveBeenCalled();
  });

  /**
   * ⚠️ These assert what reaches `suggestAttributes`, not just the status code.
   *
   * The obvious version — "a malformed body still returns 200" — is VACUOUS:
   * the crash it is meant to prevent happens inside `buildAttributePrompt`,
   * which a mocked `suggestAttributes` never runs. And the type system does not
   * cover it either: `Array.isArray` narrows `unknown` to `any[]`, so restoring
   * the old `as AiAttributeSuggestion[]` cast typechecks clean. Reading the
   * argument is the only thing that actually fails when the normalizer is
   * dropped.
   */
  it('normalizes the prior answer before it reaches the prompt', async () => {
    deixarPassar();
    await POST(
      req({
        ...BODY,
        feedback: 'de novo',
        anterior: [null, 1, 'BRAND', { id: 'BRAND' }, { id: 'COLOR', value_name: 'Azul' }],
      }),
    );
    expect(h.suggest.mock.calls[0]?.[0]).toMatchObject({
      revisao: {
        feedback: 'de novo',
        anterior: [{ id: 'COLOR', value_id: null, value_name: 'Azul', unit_id: null }],
      },
    });
  });

  it('sends no revisao at all when there is no feedback to act on', async () => {
    // A prior answer with nothing to correct would have the model re-derive
    // from the same facts and repeat itself, at full cost.
    deixarPassar();
    await POST(req({ ...BODY, anterior: [{ id: 'COLOR', value_name: 'Azul' }] }));
    expect(h.suggest.mock.calls[0]?.[0]).toMatchObject({ revisao: null });
  });

  it.each([
    ['an empty one', ''],
    ['a whitespace-only one', ' \n\t '],
  ])('treats %s as no feedback rather than a revision', async (_label, feedback) => {
    // The operator opening the box and clicking without typing must cost a
    // FRESH answer, not a revise turn asking the model to correct itself
    // against an empty instruction.
    deixarPassar();
    await POST(req({ ...BODY, feedback, anterior: [{ id: 'COLOR', value_name: 'Azul' }] }));
    expect(h.suggest.mock.calls[0]?.[0]).toMatchObject({ revisao: null });
  });

  it('keeps a revision whose prior answer is empty', async () => {
    // ⚠️ Legitimate, and the reason `anterior` is NOT required alongside
    // `feedback`: when the model answers with nothing, "não achou nada, tente
    // pelo código" is exactly the correction worth sending.
    deixarPassar();
    await POST(req({ ...BODY, feedback: 'tente pelo código' }));
    expect(h.suggest.mock.calls[0]?.[0]).toMatchObject({
      revisao: { feedback: 'tente pelo código', anterior: [] },
    });
  });
});
