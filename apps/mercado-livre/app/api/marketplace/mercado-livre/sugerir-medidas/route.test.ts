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
  h.suggest.mockResolvedValue({
    sugestoes: [],
    celulas: 1,
    contexto: { fotos: 1, anexadas: 1, descricao: false, codigo: false, referencia: false },
    truncado: false,
  });
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
  it('asks for the FULL-SIZE variant first and the ORIGINAL last', async () => {
    // 400 px cannot resolve digits on a printed table, so the cheap variant
    // would buy a confident wrong answer rather than a cheap one. And the
    // ORIGINAL is what makes this work at all today: nothing generates
    // derivatives for tabMedi photos until the functions deploy lands.
    await POST(req(ok));
    const deps = h.suggest.mock.calls[0]![0] as {
      loadImages: (fotos: unknown) => Promise<unknown>;
    };
    let seen: { prefer?: readonly string[]; max?: number } = {};
    vi.spyOn(await import('@delfrance/ai/admin'), 'loadFotoImages').mockImplementation(
      async (_deps, _fotos, options) => {
        seen = options ?? {};
        return [];
      },
    );
    await deps.loadImages([]);
    expect(seen.prefer?.[0]).toBe('jpeg');
    expect(seen.prefer?.at(-1)).toBe('original');
    // Several photos, because a supplier table is often two or three.
    expect(seen.max).toBeGreaterThan(1);
  });

  it("accepts the caller's facts and passes them through", async () => {
    // The editor sits inside an ObjectView form, so an unsaved descrição or a
    // freshly uploaded photo is not on the document yet.
    const facts = { descricao: 'recém digitada', fotos: [{ arquivoOuterRef: 'arquivos/x' }] };
    const res = await POST(req({ ...ok, facts }));
    expect(res.status).toBe(200);
    expect((h.suggest.mock.calls[0]![1] as { facts?: unknown }).facts).toMatchObject({
      descricao: 'recém digitada',
    });
  });

  it('rejects facts that are malformed or over the caps', async () => {
    expect((await POST(req({ ...ok, facts: 'nope' }))).status).toBe(400);
    expect((await POST(req({ ...ok, facts: { nome: 42 } }))).status).toBe(400);
    expect((await POST(req({ ...ok, facts: { descricao: 'x'.repeat(1001) } }))).status).toBe(400);
    // A body that is simply enormous is still refused.
    const fotos = Array.from({ length: 51 }, () => ({ arquivoOuterRef: 'arquivos/x' }));
    expect((await POST(req({ ...ok, facts: { fotos } }))).status).toBe(400);
  });

  it('accepts MORE photos than reach the model, instead of failing the request', async () => {
    // ⚠️ The regression this pins. The body cap used to BE the model cap, so a
    // tabela with five photos — a front, a back and three pages, the case this
    // feature exists for — answered `400 facts inválido.`, which the toast now
    // shows verbatim. `loadFotoImages` already stops at `max`, so a longer
    // gallery costs nothing; rejecting it just re-broke the feature.
    const fotos = Array.from({ length: 8 }, (_, i) => ({
      arquivoOuterRef: `arquivos/f${String(i)}`,
    }));
    const res = await POST(req({ ...ok, facts: { fotos } }));
    expect(res.status).toBe(200);
    expect(
      (h.suggest.mock.calls[0]![1] as { facts?: { fotos?: unknown[] } }).facts?.fotos,
    ).toHaveLength(8);
  });

  it('accepts a nome and codigo the SCHEMA allows, not just a cell label', async () => {
    // `tabelaDeMedidasSchema` allows 255 for both; the grid's `MAX_LABEL` is 200
    // and is a cell bound. Reusing it made a saved 201-char nome return 400 on
    // every click — the client always sends both fields, touched or not.
    const facts = { nome: 'n'.repeat(255), codigo: 'c'.repeat(255) };
    expect((await POST(req({ ...ok, facts }))).status).toBe(200);
    expect((await POST(req({ ...ok, facts: { nome: 'n'.repeat(256) } }))).status).toBe(400);
  });

  it('rejects a foto ref that would crash the loader, with 400 rather than 500', async () => {
    // `loadFotoImages` does `outerRef.replace(...)` then `docRef` with no guard
    // of its own: a non-string throws TypeError, a slash-bearing id throws
    // "documentPath must point to a document". Neither matches a catch branch in
    // POST, so both would surface as an unhandled 500.
    expect((await POST(req({ ...ok, facts: { fotos: [{ arquivoOuterRef: 42 }] } }))).status).toBe(
      400,
    );
    expect(
      (await POST(req({ ...ok, facts: { fotos: [{ arquivoJpegOuterRef: 'a/b/c' }] } }))).status,
    ).toBe(400);
    // An empty string is legitimate — that variant simply does not exist yet.
    expect(
      (await POST(req({ ...ok, facts: { fotos: [{ arquivo400pxOuterRef: '' }] } }))).status,
    ).toBe(200);
  });

  it('works with NO facts at all, so an older client keeps running', async () => {
    const res = await POST(req(ok));
    expect(res.status).toBe(200);
    expect((h.suggest.mock.calls[0]![1] as { facts?: unknown }).facts).toBeUndefined();
  });

  it('passes the parsed grid straight through and returns the result', async () => {
    h.suggest.mockResolvedValue({
      sugestoes: [{ rowKey: 'g/1/v/p', attributeId: 'CHEST', value_id: null, value_name: '52' }],
      celulas: 1,
      contexto: { fotos: 2, anexadas: 2, descricao: true, codigo: false, referencia: true },
      truncado: false,
    });
    const res = await POST(req({ ...ok, measureType: 'BODY_MEASURE' }));
    expect(res.status).toBe(200);
    // The per-source summary reaches the UI intact — it is what lets the modal
    // say "2 fotos · descrição" instead of implying the model saw everything.
    expect(await res.json()).toMatchObject({
      celulas: 1,
      contexto: { fotos: 2, descricao: true, referencia: true },
    });

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
