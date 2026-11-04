/**
 * `POST …/conta/[id]/oauth/start` — through the real `iniciarConexaoAmazon`,
 * against the fake db and the in-memory attempt store (the shared seam is
 * mocked to it), with the global `fetch` stubbed to prove no Amazon call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyState } from '@delfrance/data/admin/oauth-state';
import { CODIGO_ERRO_AMAZON, respostaInicioOAuthAmazonSchema } from '@delfrance/schemas';

import { amazonOauthState } from '@/lib/amazon/conta/oauthState';
import { FakeDb, asDb } from '@/lib/amazon/testing/fakeDb';
import type { FakeOauthState } from '@/lib/amazon/testing/fakeOauthState';
import {
  AGORA_MS,
  AMBIENTE_DESLIGADO,
  AMBIENTE_LIGADO,
  CLIENT_SECRET,
  ESCRITOR,
  LEITOR,
  STATE_SECRET,
  contexto,
  espiaoDeFetch,
  espiarStdout,
  requisicao,
  seedConta,
  stubAmbiente,
} from '@/lib/amazon/testing/fixtures';

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn(), db: undefined as unknown }));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));

vi.mock('@/lib/amazon/conta/oauthState', async () => {
  const { criarFakeOauthState } = await import('@/lib/amazon/testing/fakeOauthState');
  return { amazonOauthState: criarFakeOauthState() };
});

const { POST } = await import('./route');

const ID = 'conta-1';
const estado = amazonOauthState as FakeOauthState;
let db: FakeDb;
let chamadas: unknown[];
let stdout: ReturnType<typeof espiarStdout>;

function iniciar(id = ID) {
  return POST(requisicao('POST', `${id}/oauth/start`), contexto(id));
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
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  stubAmbiente(AMBIENTE_LIGADO);
  stdout = espiarStdout();
  const espiao = espiaoDeFetch();
  chamadas = espiao.chamadas;
  vi.stubGlobal('fetch', espiao.fetch);
  estado.puts.length = 0;
  estado.consumos.length = 0;
});

afterEach(() => {
  // Starting a consent never calls Amazon, whatever the outcome.
  expect(chamadas).toHaveLength(0);
  stdout.restaurar();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST …/conta/[id]/oauth/start', () => {
  it('a reader (no integracao.write) → 403, with both headers, nothing minted', async () => {
    seedConta(db, ID);
    h.verifyIdToken.mockResolvedValue(LEITOR);
    const res = await iniciar();
    expect(res.status).toBe(403);
    cabecalhosOk(res);
    expect(estado.puts).toHaveLength(0);
  });

  it('200 { authorizeUrl }: the state is signed for this conta and persisted BEFORE the answer', async () => {
    seedConta(db, ID);
    const res = await iniciar();
    expect(res.status).toBe(200);
    cabecalhosOk(res);
    const { authorizeUrl } = respostaInicioOAuthAmazonSchema.parse(await res.json());
    const url = new URL(authorizeUrl);
    expect([...url.searchParams.keys()]).toEqual([
      'application_id',
      'state',
      'version',
      'redirect_uri',
    ]);
    const { id, nonce } = verifyState(url.searchParams.get('state') ?? '', STATE_SECRET, AGORA_MS);
    expect(id).toBe(ID);
    expect(estado.puts).toEqual([[ID, nonce]]);
    expect(authorizeUrl).not.toContain(CLIENT_SECRET);
  });

  it('switch off → 503 AMAZON_CHAMADAS_DESLIGADAS, ZERO Firestore operations, one blocked line', async () => {
    stubAmbiente(AMBIENTE_DESLIGADO);
    seedConta(db, ID);
    const res = await iniciar();
    expect(res.status).toBe(503);
    cabecalhosOk(res);
    expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS });
    expect(db.operacoes).toBe(0);
    expect(estado.puts).toHaveLength(0);
    const linhas = stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(linhas).toEqual([
      expect.objectContaining({
        severity: 'INFO',
        evento: 'chamada-bloqueada',
        rota: 'oauth-start',
      }),
    ]);
  });

  it('config missing → 500 AMAZON_CONFIG_AUSENTE naming keys, never values', async () => {
    stubAmbiente({ ...AMBIENTE_LIGADO, AMAZON_APPLICATION_ID: undefined });
    seedConta(db, ID);
    const res = await iniciar();
    expect(res.status).toBe(500);
    cabecalhosOk(res);
    const texto = await res.text();
    expect(JSON.parse(texto)).toMatchObject({ code: CODIGO_ERRO_AMAZON.CONFIG_AUSENTE });
    expect(texto).toContain('AMAZON_APPLICATION_ID');
    expect(texto).not.toContain(STATE_SECRET);
    expect(texto).not.toContain(CLIENT_SECRET);
  });

  it('404 for a missing conta; 400 for a malformed id with nothing read', async () => {
    const ausente = await iniciar('nao-existe');
    expect(ausente.status).toBe(404);
    cabecalhosOk(ausente);
    const ruim = await iniciar('a%2Fb');
    expect(ruim.status).toBe(400);
    cabecalhosOk(ruim);
    expect(db.leituras).toEqual(['integracao/nao-existe']);
  });

  it('a parked or inactive conta can start', async () => {
    seedConta(db, ID, { ativo: false });
    expect((await iniciar()).status).toBe(200);
  });
});
