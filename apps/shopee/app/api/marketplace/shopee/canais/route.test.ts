/**
 * `GET /api/marketplace/shopee/canais` (#1911 P15) — the ROUTE's half: the
 * PERM bit, the query ladder, the order of the reads (conta → produto →
 * channels), the 200 parsed with the ONE schema `apps/web` also parses it
 * with, the passthrough of every Shopee error, rule 6, one uncached read per
 * request and `Cache-Control: no-store` on every answer. The verdicts are
 * `anuncios/canaisDoRascunho.ts`'s and the publisher's; their suites pin them.
 *
 * `lerCanaisDoRascunhoShopee` runs REAL over the FakeDb, with a stub client
 * whose `getChannelList` answers a body through the package's own schema.
 *
 * ⚠️ Invented ids only: conta `int-1`, shop 987654, produto `p1`, channels
 * 90003/90005. Nothing reaches a network or a real Firestore.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_CHANNEL_LIST_PATH,
  SHOPEE_LOGISTICS_FEE_TYPE,
  SHOPEE_SURFACE,
  shopeeChannelListPayloadSchema,
  shopeeErrorFromEnvelope,
  type ShopeeApiError,
} from '@delfrance/integrations-shopee';
import { INTEGRACAO_TIPO, respostaCanaisShopeeSchema } from '@delfrance/schemas';

import { MSG_PRODUTO_ID_INVALIDO } from '@/lib/shopee/anuncios/corpoPublicacao';
import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { FakeDb, asDb } from '@/lib/shopee/testing/fakeDb';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  getChannelList: vi.fn(),
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
  tryGetAdminBucket: () => null,
}));

vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

const { GET } = await import('./route');

/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const PRODUTO = 'p1';
const CANAL_A = 90003;
const CANAL_B = 90005;

const AUTORIZADO = { authorization: 'Bearer t' };
const URL_BASE = 'http://localhost:3009/api/marketplace/shopee/canais';
const QUERY = { integracaoId: CONTA, produtoId: PRODUTO };

const CANAIS = shopeeChannelListPayloadSchema.parse({
  logistics_channel_list: [
    {
      logistics_channel_id: CANAL_A,
      logistics_channel_name: 'Canal A',
      enabled: true,
      fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
      mask_channel_id: 0,
    },
    {
      logistics_channel_id: CANAL_B,
      logistics_channel_name: 'Canal B',
      enabled: false,
      fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
      mask_channel_id: 0,
    },
  ],
});

let db: FakeDb;

function autorizar(permissions: string): void {
  h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions });
}

function contexto(): void {
  h.loadCtx.mockResolvedValue({
    integracaoId: CONTA,
    conta: { tipo: INTEGRACAO_TIPO.shopee, ativo: true, shop_id: 987654 },
    createShopClient: () => ({ getChannelList: h.getChannelList }),
  });
}

function semearProduto(): void {
  db.seed(`produtos/${PRODUTO}`, {
    nome: 'Produto de teste',
    pesoBrutoKg: 0.5,
    alturaCm: 10,
    larguraCm: 10,
    profundidadeCm: 10,
    ofereceFreteGratis: false,
  });
}

function url(query: Record<string, string>): string {
  const u = new URL(URL_BASE);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

async function responder(
  query: Record<string, string> = QUERY,
  headers: Record<string, string> = AUTORIZADO,
) {
  const res = await GET(new Request(url(query), { method: 'GET', headers }));
  return {
    status: res.status,
    cache: res.headers.get('Cache-Control'),
    body: (await res.json()) as Record<string, unknown>,
  };
}

function recusa(error: string, message: string): ShopeeApiError {
  return shopeeErrorFromEnvelope(
    { error, message, request_id: 'req-teste', warning: null },
    { path: SHOPEE_GET_CHANNEL_LIST_PATH, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

/** Every read of the produto document, in call order. */
function leiturasDoProduto(): number {
  return db.opLog.filter((op) => op.path === `produtos/${PRODUTO}`).length;
}

beforeEach(() => {
  h.verifyIdToken.mockReset();
  h.loadCtx.mockReset();
  h.getChannelList.mockReset();
  db = new FakeDb();
  h.db.atual = asDb(db);
  autorizar(PERM.integracao.read.toString());
  contexto();
  semearProduto();
  h.getChannelList.mockResolvedValue(CANAIS);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('GET canais — a escada da rota (#1911 P15)', () => {
  it('sem Bearer ⇒ 401 + no-store', async () => {
    const { status, cache } = await responder(QUERY, {});
    expect(status).toBe(401);
    expect(cache).toBe('no-store');
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('sem integracao.read ⇒ 403 + no-store', async () => {
    autorizar('0');
    const { status, cache } = await responder();
    expect(status).toBe(403);
    expect(cache).toBe('no-store');
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('⛔ PAR: SÓ integracao.read (sem write) ⇒ 200', async () => {
    autorizar(PERM.integracao.read.toString());
    const { status } = await responder();
    expect(status).toBe(200);
  });

  it("sem integracaoId ⇒ 400 'integracaoId é obrigatório.'", async () => {
    const { status, cache, body } = await responder({ produtoId: PRODUTO });
    expect(status).toBe(400);
    expect(cache).toBe('no-store');
    expect(body).toEqual({ error: 'integracaoId é obrigatório.' });
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it.each([
    ['ausente', { integracaoId: CONTA }],
    ['em branco', { integracaoId: CONTA, produtoId: '   ' }],
  ])("sem produtoId, ou em branco ⇒ 400 'produtoId é obrigatório.' (%s)", async (_t, query) => {
    const { status, cache, body } = await responder(query);
    expect(status).toBe(400);
    expect(cache).toBe('no-store');
    expect(body).toEqual({ error: 'produtoId é obrigatório.' });
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it.each(['a/b', '..', '.'])(
    "produtoId '%s' ⇒ 400 MSG_PRODUTO_ID_INVALIDO + no-store, sem carregar a conta",
    async (produtoId) => {
      const { status, cache, body } = await responder({ integracaoId: CONTA, produtoId });
      expect(status).toBe(400);
      expect(cache).toBe('no-store');
      expect(body).toEqual({ error: MSG_PRODUTO_ID_INVALIDO });
      expect(h.loadCtx).not.toHaveBeenCalled();
      expect(db.opLog).toEqual([]);
    },
  );

  it('conta não configurada ⇒ 404 do shopeeErrorResponse + no-store', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    const { status, cache, body } = await responder();
    expect(status).toBe(404);
    expect(cache).toBe('no-store');
    expect(body).toEqual({ error: 'não é do tipo Shopee' });
    // The conta decides BEFORE the produto is read, and nothing calls Shopee.
    expect(leiturasDoProduto()).toBe(0);
    expect(h.getChannelList).not.toHaveBeenCalled();
  });

  it("produto ausente ⇒ 404 {error: 'Produto p1 não encontrado.'} + no-store, getChannelList 0 vezes", async () => {
    db = new FakeDb();
    h.db.atual = asDb(db);
    const { status, cache, body } = await responder();
    expect(status).toBe(404);
    expect(cache).toBe('no-store');
    expect(body).toEqual({ error: 'Produto p1 não encontrado.' });
    expect(h.getChannelList).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('200: o corpo passa por respostaCanaisShopeeSchema (o MESMO objeto da web) + no-store, nenhuma escrita', async () => {
    const { status, cache, body } = await responder();

    expect(status).toBe(200);
    expect(cache).toBe('no-store');
    expect(Object.keys(body)).toEqual(['medidasCompletas', 'canais']);
    const resposta = respostaCanaisShopeeSchema.parse(body);
    expect(resposta).toEqual(body);
    expect(resposta).toEqual({
      medidasCompletas: true,
      canais: [
        {
          logisticsChannelId: CANAL_A,
          nome: 'Canal A',
          selecionavel: true,
          obrigatorio: false,
          bloqueiaFreteGratisDoVendedor: false,
          indisponivel: null,
          automatica: { isFree: false },
        },
        {
          logisticsChannelId: CANAL_B,
          nome: 'Canal B',
          selecionavel: false,
          obrigatorio: false,
          bloqueiaFreteGratisDoVendedor: false,
          indisponivel: null,
          automatica: null,
        },
      ],
    });
    expect(h.loadCtx).toHaveBeenCalledWith(expect.anything(), CONTA);
    expect(h.getChannelList).toHaveBeenCalledTimes(1);
    expect(leiturasDoProduto()).toBe(1);
    expect(db.writes).toEqual([]);
  });

  it.each([
    ['burst', 'error_rate_limit', SHOPEE_ERROR_KIND.burst],
    ['cota diária', 'error_limit', SHOPEE_ERROR_KIND.daily],
  ])('erro da Shopee ⇒ 502 + kind + no-store (%s)', async (_t, code, kind) => {
    h.getChannelList.mockRejectedValue(recusa(code, 'too many'));
    const { status, cache, body } = await responder();
    expect(status).toBe(502);
    expect(cache).toBe('no-store');
    expect(body).toMatchObject({ code: 'SHOPEE_HTTP_ERROR', kind });
    expect(h.getChannelList).toHaveBeenCalledTimes(1);
  });

  it('regra 6: um TypeError do getChannelList REJEITA o GET (relançado, nunca um 500 em JSON)', async () => {
    h.getChannelList.mockRejectedValue(new TypeError('bug nosso'));
    await expect(GET(new Request(url(QUERY), { headers: AUTORIZADO }))).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('duas chamadas ⇒ duas getChannelList (sem cache)', async () => {
    expect((await responder()).status).toBe(200);
    expect((await responder()).status).toBe(200);
    expect(h.getChannelList).toHaveBeenCalledTimes(2);
  });

  it("PAR: produtoId ' p1' é aparado ⇒ 200 do p1 ⟷ QUASE: 'p 1' ⇒ 404", async () => {
    const aparado = await responder({ integracaoId: CONTA, produtoId: ' p1' });
    expect(aparado.status).toBe(200);
    expect(leiturasDoProduto()).toBe(1);

    const comEspaco = await responder({ integracaoId: CONTA, produtoId: 'p 1' });
    expect(comEspaco.status).toBe(404);
    expect(comEspaco.body).toEqual({ error: 'Produto p 1 não encontrado.' });
  });
});

describe('GET canais — a fonte (#1911 P15)', () => {
  it('route.ts não lê por cache nem pelo contexto da taxonomia', () => {
    const fonte = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8');
    // ÂNCORA: the file really was read and really builds the shop client itself.
    expect(fonte).toContain('createShopClient()');
    expect(fonte).not.toContain('createReadCache');
    expect(fonte).not.toContain('taxonomiaCtx');
  });
});
