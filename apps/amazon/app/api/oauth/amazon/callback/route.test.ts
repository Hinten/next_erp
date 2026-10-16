/**
 * `GET /api/oauth/amazon/callback` — the thin route over `tratarCallbackAmazon`
 * (whose fifteen steps `conectar.test.ts` covers one by one). Here: the
 * redirect it builds, the closed query-key set of every family, the headers,
 * and that nothing secret reaches the `Location` or the log sink.
 *
 * Mocked: the Admin singleton (the fake db), the attempt store (in memory) and
 * `FieldValue.increment`; stubbed: the global `fetch` (LWA answers from a
 * script — D11, nothing reaches Amazon). Everything between is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { amazonOauthState } from '@/lib/amazon/conta/oauthState';
import { iniciarConexaoAmazon } from '@/lib/amazon/conta/iniciar';
import { FakeDb, asDb } from '@/lib/amazon/testing/fakeDb';
import type { FakeOauthState } from '@/lib/amazon/testing/fakeOauthState';
import {
  AGORA_MS,
  AMBIENTE_DESLIGADO,
  AMBIENTE_LIGADO,
  CODIGO,
  SEGREDOS,
  SPID_A,
  SPID_B,
  URL_CALLBACK,
  WEB_APP_URL,
  erroLwa,
  espiaoDeFetch,
  espiarStdout,
  loggerEspiao,
  seedConta,
  stubAmbiente,
  tokensDeAutorizacao,
} from '@/lib/amazon/testing/fixtures';

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => {
    throw new Error('o callback é público: não verifica token');
  },
  getAdminFirestore: () => h.db,
}));

vi.mock('@/lib/amazon/conta/oauthState', async () => {
  const { criarFakeOauthState } = await import('@/lib/amazon/testing/fakeOauthState');
  return { amazonOauthState: criarFakeOauthState() };
});

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { increment: (by: number) => ({ __increment: by }) },
}));

const { GET } = await import('./route');

const ID = 'conta-1';
const estado = amazonOauthState as FakeOauthState;
let db: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
let fetchSpy: ReturnType<typeof espiaoDeFetch>;

function stubFetch(responder: Parameters<typeof espiaoDeFetch>[0]) {
  fetchSpy = espiaoDeFetch(responder);
  vi.stubGlobal('fetch', fetchSpy.fetch);
}

async function iniciar(): Promise<string> {
  const { authorizeUrl } = await iniciarConexaoAmazon(asDb(db), ID, {
    ambiente: AMBIENTE_LIGADO,
    agoraMs: AGORA_MS,
    estado,
    logger: loggerEspiao().logger,
  });
  return new URL(authorizeUrl).searchParams.get('state') ?? '';
}

function callback(params: Record<string, string>) {
  return GET(new Request(`${URL_CALLBACK}?${new URLSearchParams(params).toString()}`));
}

function destino(res: Response): URL {
  return new URL(res.headers.get('location') ?? 'about:blank');
}

function cabecalhosOk(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

beforeEach(() => {
  __resetAllReadCaches();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA_MS);
  db = new FakeDb();
  h.db = asDb(db);
  stubAmbiente(AMBIENTE_LIGADO);
  stdout = espiarStdout();
  stubFetch(() => tokensDeAutorizacao());
  seedConta(db, ID);
  // The mocked attempt store is module-scoped: start every case from a clean log.
  estado.puts.length = 0;
  estado.consumos.length = 0;
});

afterEach(() => {
  stdout.restaurar();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GET /api/oauth/amazon/callback', () => {
  it('connected → `${WEB_APP_URL}/canais/amazon/<id>?amazon=connected`, exactly one key', async () => {
    const state = await iniciar();
    const res = await callback({ state, selling_partner_id: SPID_A, spapi_oauth_code: CODIGO });
    expect([302, 303, 307]).toContain(res.status);
    cabecalhosOk(res);
    const url = destino(res);
    expect(`${url.origin}${url.pathname}`).toBe(`${WEB_APP_URL}/canais/amazon/${ID}`);
    expect([...url.searchParams.entries()]).toEqual([['amazon', 'connected']]);
    expect(fetchSpy.chamadas).toHaveLength(1);
  });

  it('a conta-family error → the conta page with exactly {amazon, reason}', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    const state = await iniciar();
    const res = await callback({ state, selling_partner_id: SPID_B, spapi_oauth_code: CODIGO });
    cabecalhosOk(res);
    const url = destino(res);
    expect(url.pathname).toBe(`/canais/amazon/${ID}`);
    expect([...url.searchParams.entries()]).toEqual([
      ['amazon', 'error'],
      ['reason', 'vendedor_diferente'],
    ]);
    expect(fetchSpy.chamadas).toHaveLength(0);
  });

  it('a list-family error (bad_state) → the LIST with exactly {amazon, reason}; a replay lands there too', async () => {
    const state = await iniciar();
    const params = { state, selling_partner_id: SPID_A, spapi_oauth_code: CODIGO };
    await callback(params);
    const replay = await callback(params);
    cabecalhosOk(replay);
    const url = destino(replay);
    expect(url.pathname).toBe('/canais/amazon');
    expect([...url.searchParams.entries()]).toEqual([
      ['amazon', 'error'],
      ['reason', 'bad_state'],
    ]);
    expect(fetchSpy.chamadas).toHaveLength(1);
  });

  it('the switch off → integracao_desligada, nothing consumed or fetched', async () => {
    const state = await iniciar();
    stubAmbiente(AMBIENTE_DESLIGADO);
    const res = await callback({ state, selling_partner_id: SPID_A, spapi_oauth_code: CODIGO });
    expect(destino(res).searchParams.get('reason')).toBe('integracao_desligada');
    expect(estado.consumos.filter(([id]) => id === ID)).toHaveLength(0);
    expect(fetchSpy.chamadas).toHaveLength(0);
  });

  it('WEB_APP_URL unset → a plain-text 500 with both headers, no redirect', async () => {
    stubAmbiente({ ...AMBIENTE_LIGADO, WEB_APP_URL: undefined });
    const res = await callback({ state: 'x' });
    expect(res.status).toBe(500);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toContain('text/plain');
    cabecalhosOk(res);
  });

  it('hygiene: no code, token, secret, state or seller id in any Location or log line', async () => {
    const proibidos: string[] = [...SEGREDOS, SPID_A, SPID_B];
    const locations: string[] = [];
    const cenarios: [Record<string, string>, Parameters<typeof espiaoDeFetch>[0]][] = [
      [{ selling_partner_id: SPID_A }, () => tokensDeAutorizacao()],
      [{ selling_partner_id: SPID_A }, () => erroLwa(401, 'invalid_client')],
      [{ selling_partner_id: SPID_A }, () => erroLwa(400, 'invalid_grant')],
    ];
    for (const [over, responder] of cenarios) {
      seedConta(db, ID);
      const state = await iniciar();
      proibidos.push(state);
      stubFetch(responder);
      const res = await callback({ state, spapi_oauth_code: CODIGO, ...over });
      locations.push(res.headers.get('location') ?? '');
    }
    const texto = [...locations, ...stdout.linhas()].join('\n');
    expect(stdout.linhas().length).toBeGreaterThan(0);
    for (const p of proibidos) expect(texto, p).not.toContain(p);
  });
});
