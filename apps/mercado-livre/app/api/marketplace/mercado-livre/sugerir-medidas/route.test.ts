import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVEDOR_IA, configIaSchema, type ConfigIa } from '@delfrance/schemas';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  config: null as ConfigIa | null,
  /** The doc id the route asked `loadConfigIa` for. */
  configDocId: null as string | null,
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

// Spread the real module: the route imports the provider factories, the model
// cache and the image loader from here too, and a bare object would leave those
// undefined — the route would then fail on the import rather than on the gate
// each test is actually about.
vi.mock('@delfrance/ai/admin', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/ai/admin')>();
  return {
    ...actual,
    loadConfigIa: async (_db: unknown, docId: string) => {
      h.configDocId = docId;
      return h.config;
    },
  };
});

// Guard: reaching this means a gate under test did NOT decline.
vi.mock('@/lib/ai/suggestMedidas', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/ai/suggestMedidas')>();
  return { ...actual, suggestMedidas: h.suggest };
});

const { POST } = await import('./route');

const req = (body: unknown) =>
  new Request('http://localhost:3006/api/marketplace/mercado-livre/sugerir-medidas', {
    method: 'POST',
    body: JSON.stringify(body),
  });

const ROWS = [{ key: 'g/1/v/p', size: 'P' }];
const COLUMNS = [
  {
    attributeId: 'CHEST',
    label: 'Tórax',
    kind: 'number',
    values: [],
    unitId: 'cm',
    required: true,
  },
];
const ok = { tabMediId: 'tm1', rows: ROWS, columns: COLUMNS };

beforeEach(() => {
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1' } });
  h.config = configIaSchema.parse({});
  h.configDocId = null;
  h.suggest.mockReset();
  h.suggest.mockResolvedValue({ sugestoes: [], celulas: 1, comFoto: true, truncado: false });
});

describe('POST /sugerir-medidas — the gates', () => {
  it('reads the MEDIDAS agent settings, not the attribute agent', async () => {
    // Two agents, two documents, two kill switches. Reading the wrong one would
    // make this button obey a switch labelled for the other feature.
    await POST(req(ok));
    expect(h.configDocId).toBe('ml-medidas');
  });

  it('declines when the agent is switched off, WITHOUT calling the model', async () => {
    h.config = configIaSchema.parse({ ativo: false });
    const res = await POST(req(ok));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'AI_DESATIVADA' });
    expect(h.suggest).not.toHaveBeenCalled();
  });

  it('declines a provider that is not wired, rather than silently using Vertex', async () => {
    h.config = configIaSchema.parse({ provedor: PROVEDOR_IA.googleai });
    const res = await POST(req(ok));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'AI_PROVEDOR_NAO_SUPORTADO' });
    expect(h.suggest).not.toHaveBeenCalled();
  });
});

describe('POST /sugerir-medidas — body validation', () => {
  it('rejects a non-JSON body and a non-object body', async () => {
    const bad = new Request('http://localhost:3006/x', { method: 'POST', body: 'nope' });
    expect((await POST(bad)).status).toBe(400);
    expect((await POST(req([1, 2]))).status).toBe(400);
  });

  it('requires tabMediId', async () => {
    expect((await POST(req({ rows: ROWS, columns: COLUMNS }))).status).toBe(400);
    expect((await POST(req({ ...ok, tabMediId: '' }))).status).toBe(400);
  });

  it('rejects a malformed grid', async () => {
    expect((await POST(req({ ...ok, rows: 'nope' }))).status).toBe(400);
    expect((await POST(req({ ...ok, rows: [{ key: 1, size: 'P' }] }))).status).toBe(400);
    expect((await POST(req({ ...ok, columns: [{ attributeId: 'X' }] }))).status).toBe(400);
    expect((await POST(req({ ...ok, columns: [{ ...COLUMNS[0], kind: 'weird' }] }))).status).toBe(
      400,
    );
  });

  it('caps the grid, so a huge body cannot buy a huge schema', async () => {
    // The grid arrives from the client because `extractColumns` lives in
    // apps/web and is the single implementation. That is safe — a bad list can
    // only mislead the caller's own suggestion — but it still has to be bounded,
    // because the schema (and the bill) scale with it.
    const rows = Array.from({ length: 76 }, (_, i) => ({
      key: `k${String(i)}`,
      size: `S${String(i)}`,
    }));
    expect((await POST(req({ ...ok, rows }))).status).toBe(400);

    const columns = Array.from({ length: 16 }, (_, i) => ({
      ...COLUMNS[0],
      attributeId: `A${String(i)}`,
    }));
    expect((await POST(req({ ...ok, columns }))).status).toBe(400);

    const values = Array.from({ length: 201 }, (_, i) => ({
      id: String(i),
      name: `v${String(i)}`,
    }));
    expect((await POST(req({ ...ok, columns: [{ ...COLUMNS[0], values }] }))).status).toBe(400);
  });

  it('declines an EMPTY grid with 422 instead of spending a call', async () => {
    const res = await POST(req({ ...ok, rows: [] }));
    expect(res.status).toBe(422);
    expect(h.suggest).not.toHaveBeenCalled();
  });
});

describe('POST /sugerir-medidas — the happy path', () => {
  it('asks for the FULL-SIZE image variant, not the thumbnail', async () => {
    // 400 px cannot resolve digits on a printed table, so the cheap variant
    // would buy a confident wrong answer rather than a cheap one.
    await POST(req(ok));
    const deps = h.suggest.mock.calls[0]![0] as {
      loadImage: (fotos: unknown) => Promise<unknown>;
    };
    const prefer: string[] = [];
    vi.spyOn(await import('@delfrance/ai/admin'), 'loadFotoImage').mockImplementation(
      async (_deps, _fotos, options) => {
        prefer.push(...(options?.prefer ?? []));
        return null;
      },
    );
    await deps.loadImage([]);
    expect(prefer[0]).toBe('jpeg');
  });

  it('passes the parsed grid straight through and returns the result', async () => {
    h.suggest.mockResolvedValue({
      sugestoes: [{ rowKey: 'g/1/v/p', attributeId: 'CHEST', value_id: null, value_name: '52' }],
      celulas: 1,
      comFoto: true,
      truncado: false,
    });
    const res = await POST(req({ ...ok, measureType: 'BODY_MEASURE' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ comFoto: true, celulas: 1 });

    const args = h.suggest.mock.calls[0]![1] as Record<string, unknown>;
    expect(args).toMatchObject({ tabMediId: 'tm1', measureType: 'BODY_MEASURE' });
    expect(args.rows).toEqual(ROWS);
  });

  it('does not lock the operator out of the OTHER agent', async () => {
    // The two agents share the in-flight map. A key that is not namespaced would
    // make a pending attribute suggestion block this button, and vice versa.
    const { runSingleFlight } = await import('@delfrance/ai');
    const keys: string[] = [];
    const spy = vi.fn(async (key: string, task: () => Promise<unknown>) => {
      keys.push(key);
      return task();
    });
    vi.spyOn(await import('@delfrance/ai'), 'runSingleFlight').mockImplementation(
      spy as typeof runSingleFlight,
    );

    await POST(req(ok));
    expect(keys[0]).toBe('medidas:u1');
  });
});
