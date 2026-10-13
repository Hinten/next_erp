/**
 * `GET …/conta/[id]` — the status projection, through the real store against
 * the fake. It makes no Loja Integrada call, which the stubbed `fetch` proves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODIGO_ERRO_LI, statusContaLojaIntegradaSchema } from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '@/lib/lojaIntegrada/avisos/avisos';
import { fingerprintDoToken, refDaCredencial } from '@/lib/lojaIntegrada/core/credencial';
import { FakeDb, asDb } from '@/lib/lojaIntegrada/testing/fakeDb';
import { AGORA_MS, TOKEN_A, seedConta, seedCredencial } from '@/lib/lojaIntegrada/testing/fixtures';
import {
  ESCRITOR,
  ESTRANHO,
  LEITOR,
  type ChamadaFetch,
  contexto,
  requisicao,
  stubFetch,
} from '@/lib/lojaIntegrada/testing/rotas';

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn(), db: undefined as unknown }));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));

const { GET } = await import('./route');

const ID = 'conta-li-1';
const REF = refDaCredencial({ personalToken: TOKEN_A, tokenAtualizadoEmMs: AGORA_MS });

let db: FakeDb;
let chamadas: ChamadaFetch[];

function status(id = ID) {
  return GET(requisicao('GET', id), contexto(id));
}

async function corpoDe(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA_MS);
  db = new FakeDb();
  h.db = asDb(db);
  h.verifyIdToken.mockResolvedValue(LEITOR);
  seedConta(db, ID);
  chamadas = stubFetch(() => {
    throw new Error('o status não chama a Loja Integrada');
  });
});

afterEach(() => {
  expect(chamadas).toHaveLength(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GET …/conta/[id]', () => {
  it('401 without a bearer token, 403 without integracao.read; a reader and a writer pass', async () => {
    expect((await GET(requisicao('GET', ID, { semAuth: true }), contexto(ID))).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    expect((await status()).status).toBe(403);
    h.verifyIdToken.mockResolvedValue(ESCRITOR);
    expect((await status()).status).toBe(200);
  });

  it('não configurado: 200, all null, not cached', async () => {
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(statusContaLojaIntegradaSchema.parse(await corpoDe(res))).toEqual({
      configurado: false,
      expiraEm: null,
      diasParaExpirar: null,
      situacaoValidade: null,
      atualizadoEmMs: null,
      versaoCredencialUs: null,
      reconexaoPendente: null,
    });
  });

  it('configured: the projection with versaoCredencialUs = µs of the doc updateTime', async () => {
    const carimbo = seedCredencial(db, ID);
    const res = await status();
    expect(res.status).toBe(200);
    const corpo = statusContaLojaIntegradaSchema.parse(await corpoDe(res));
    expect(corpo).toMatchObject({
      configurado: true,
      // fixtures: AGORA_MS + 60 days.
      diasParaExpirar: 60,
      situacaoValidade: 'ok',
      versaoCredencialUs: relogioDoDocumentoUs(carimbo),
      reconexaoPendente: null,
    });
  });

  it('a parked, INACTIVE conta still answers 200 — with the park, never its ref or the token', async () => {
    seedConta(db, ID, { ativo: false });
    seedCredencial(db, ID, {
      reconexaoPendente: { desdeMs: AGORA_MS, status: 403, refCredencial: REF },
    });
    const res = await status();
    expect(res.status).toBe(200);
    const texto = await res.text();
    expect(JSON.parse(texto)).toMatchObject({
      reconexaoPendente: { desdeMs: AGORA_MS, status: 403 },
    });
    expect(texto).not.toContain(REF);
    expect(texto).not.toContain(TOKEN_A);
    expect(texto).not.toContain(fingerprintDoToken(TOKEN_A));
  });

  it('a corrupt credential is 409 LI_CREDENCIAL_INVALIDA with paths, not a 500', async () => {
    seedCredencial(db, ID, { reconexaoPendente: { desdeMs: 1, status: 400, refCredencial: REF } });
    const res = await status();
    expect(res.status).toBe(409);
    expect(await corpoDe(res)).toMatchObject({
      code: CODIGO_ERRO_LI.credencialInvalida,
      issues: ['reconexaoPendente.status'],
    });
  });

  it('404 for a missing conta and for another tipo; 400 for a bad id with no read', async () => {
    expect((await status('nao-existe')).status).toBe(404);
    seedConta(db, 'shopee-1', { tipo: 5 });
    const shopee = await status('shopee-1');
    expect(shopee.status).toBe(404);
    expect(await corpoDe(shopee)).toMatchObject({ code: CODIGO_ERRO_LI.contaNaoEncontrada });

    const leiturasAntes = db.leituras.length;
    const ruim = await status('a/b');
    expect(ruim.status).toBe(400);
    expect(await corpoDe(ruim)).toMatchObject({ code: CODIGO_ERRO_LI.idInvalido });
    expect(db.leituras).toHaveLength(leiturasAntes);
  });
});
