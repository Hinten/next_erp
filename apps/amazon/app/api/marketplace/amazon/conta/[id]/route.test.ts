/**
 * `GET …/conta/[id]` — the status projection, through the real store against
 * the fake. It makes no Amazon call (the stubbed `fetch` proves it) and is not
 * gated by the read switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODIGO_ERRO_AMAZON, statusContaAmazonSchema } from '@delfrance/schemas';

import { FakeDb, asDb } from '@/lib/amazon/testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_DESLIGADO,
  AMBIENTE_LIGADO,
  ESCRITOR,
  ESTRANHO,
  LEITOR,
  REFRESH_TOKEN_A,
  SPID_A,
  contexto,
  espiaoDeFetch,
  requisicao,
  seedConta,
  seedCredencial,
  stubAmbiente,
} from '@/lib/amazon/testing/fixtures';

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn(), db: undefined as unknown }));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));

const { GET } = await import('./route');

const ID = 'conta-1';
let db: FakeDb;
let chamadas: unknown[];

function status(id = ID, opts: { semAuth?: boolean } = {}) {
  return GET(requisicao('GET', id, opts), contexto(id));
}

function cabecalhosOk(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA_MS);
  db = new FakeDb();
  h.db = asDb(db);
  h.verifyIdToken.mockResolvedValue(LEITOR);
  stubAmbiente(AMBIENTE_LIGADO);
  const espiao = espiaoDeFetch();
  chamadas = espiao.chamadas;
  vi.stubGlobal('fetch', espiao.fetch);
});

afterEach(() => {
  expect(chamadas).toHaveLength(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET …/conta/[id]', () => {
  it('401 without a bearer token, 403 without integracao.read — both with the two headers', async () => {
    seedConta(db, ID);
    const semAuth = await status(ID, { semAuth: true });
    expect(semAuth.status).toBe(401);
    cabecalhosOk(semAuth);
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    const proibido = await status();
    expect(proibido.status).toBe(403);
    cabecalhosOk(proibido);
    h.verifyIdToken.mockResolvedValue(ESCRITOR);
    expect((await status()).status).toBe(200);
  });

  it('200: the projection parses, with no-store and no-referrer', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    seedCredencial(db, ID);
    const res = await status();
    expect(res.status).toBe(200);
    cabecalhosOk(res);
    const texto = await res.text();
    expect(statusContaAmazonSchema.parse(JSON.parse(texto))).toMatchObject({
      connected: true,
      chamadasLigadas: true,
    });
    expect(texto).not.toContain(REFRESH_TOKEN_A);
    expect(texto).not.toContain(SPID_A);
  });

  it('is NOT gated by the read switch (no Amazon call happens here)', async () => {
    stubAmbiente(AMBIENTE_DESLIGADO);
    seedConta(db, ID);
    const res = await status();
    expect(res.status).toBe(200);
    expect(statusContaAmazonSchema.parse(await res.json())).toMatchObject({
      chamadasLigadas: false,
    });
  });

  it('404 for a missing conta; 400 for a malformed id with nothing read', async () => {
    const ausente = await status('nao-existe');
    expect(ausente.status).toBe(404);
    expect(await ausente.json()).toMatchObject({ code: CODIGO_ERRO_AMAZON.CONTA_NAO_ENCONTRADA });
    cabecalhosOk(ausente);

    const leituras = db.leituras.length;
    const ruim = await status('a.b');
    expect(ruim.status).toBe(400);
    expect(await ruim.json()).toMatchObject({ code: CODIGO_ERRO_AMAZON.ID_INVALIDO });
    cabecalhosOk(ruim);
    expect(db.leituras).toHaveLength(leituras);
  });
});
