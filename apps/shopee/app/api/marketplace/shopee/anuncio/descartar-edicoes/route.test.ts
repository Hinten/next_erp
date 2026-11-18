/**
 * `POST …/anuncio/descartar-edicoes` — the ROUTE's half: the caller, the strict
 * body, the one clock read, the LAZY Shopee context and the HTTP shape. The
 * decisions are `anuncios/descartarEdicoes.ts`'s and its own suite pins them;
 * here the REAL module runs over the FakeDb, with only the Shopee edge
 * (`loadShopeeContext`, `lerAnuncioShopee`) replaced by counting fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { shopeeItemBaseInfoRowSchema } from '@delfrance/integrations-shopee';
import {
  CAMPOS_DE_EDICAO_ERP_SHOPEE,
  CODIGO_RASCUNHO_SHOPEE,
  ESTADO_ANUNCIO_SHOPEE,
  respostaDescartarEdicoesAnuncioShopeeSchema,
} from '@delfrance/schemas';

import type { ItemLido } from '@/lib/shopee/produtos/itemLido';
import { FakeDb, asDb, type DocData } from '@/lib/shopee/testing/fakeDb';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: { atual: null as unknown },
  loadShopeeContext: vi.fn(),
  lerAnuncioShopee: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
  tryGetAdminBucket: () => null,
}));

// Partial: `ShopeeContaNotConfiguredError` must stay the real class — the route's
// error mapper and `rascunho.ts` both import it from this module.
vi.mock('@/lib/shopee/core/shopee', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shopee/core/shopee')>()),
  loadShopeeContext: h.loadShopeeContext,
}));

vi.mock('@/lib/shopee/produtos/lerAnuncio', () => ({
  lerAnuncioShopee: h.lerAnuncioShopee,
}));

const { POST } = await import('./route');
const { ShopeeContaNotConfiguredError } = await import('@/lib/shopee/core/shopee');

/* --------------------------------- fixtures ------------------------------- */

const CONTA = 'int-1';
const REF_CONTA = `documents/integracao/${CONTA}`;
const PRODUTO = 'prod-1';
const LINK = 'link-1';
const CAMINHO = `produtos/${PRODUTO}/prodshopee/${LINK}`;
const ITEM_ID = 2500139861;
const REVISAO = 2;
const T0 = 1_760_000_000_000;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const LEITOR = { uid: 'u2', permissions: PERM.integracao.read.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

function req(corpo: unknown, headers: Record<string, string> = AUTORIZADO): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/anuncio/descartar-edicoes', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function corpo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { integracaoId: CONTA, produtoId: PRODUTO, linkDocId: LINK, revisao: REVISAO, ...over };
}

function link(extra: DocData = {}): DocData {
  return {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_id: ITEM_ID,
    item_name: 'Título editado no ERP',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    kitNativo: false,
    edicaoErpRevisao: REVISAO,
    edicaoErpPendenteEm: T0 - 1000,
    ...extra,
  };
}

function anuncioDaShopee(): ItemLido {
  const base = shopeeItemBaseInfoRowSchema.parse({
    item_id: ITEM_ID,
    item_name: 'Título da Shopee',
    category_id: 100_017,
  });
  return { base, models: null, taxInfo: null, kit: null, itemId: ITEM_ID };
}

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  h.loadShopeeContext.mockResolvedValue({ createShopClient: () => ({ cliente: true }) });
  h.lerAnuncioShopee.mockResolvedValue(anuncioDaShopee());
  vi.spyOn(Date, 'now').mockReturnValue(T0);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  __resetAllReadCaches();
  vi.restoreAllMocks();
});

/* ------------------------------ auth and body ----------------------------- */

describe('autenticação e corpo', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    db.seed(CAMINHO, link());

    expect((await POST(req(corpo(), {}))).status).toBe(401);
    expect(db.writes).toEqual([]);
    expect(h.loadShopeeContext).not.toHaveBeenCalled();
  });

  it('⛔ responde 403 para quem só tem integracao.READ', async () => {
    db.seed(CAMINHO, link());
    h.verifyIdToken.mockResolvedValue(LEITOR);

    expect((await POST(req(corpo()))).status).toBe(403);
    expect(db.writes).toEqual([]);
    expect(h.loadShopeeContext).not.toHaveBeenCalled();
  });

  it.each([
    ['uma chave desconhecida', { forcar: true }, 'forcar'],
    ['uma revisão 0', { revisao: 0 }, 'revisao'],
    ['uma revisão negativa', { revisao: -1 }, 'revisao'],
    ['uma revisão fracionária', { revisao: 1.5 }, 'revisao'],
    ['sem revisão', { revisao: undefined }, 'revisao'],
    ['sem linkDocId', { linkDocId: undefined }, 'linkDocId'],
  ])('⛔ responde 400 para %s — nomeia o campo, sem ler nada', async (_nome, over, campo) => {
    db.seed(CAMINHO, link());
    const antes = db.opLog.length;

    const res = await POST(req(corpo(over)));

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(campo);
    expect(db.opLog.length).toBe(antes);
    expect(h.loadShopeeContext).not.toHaveBeenCalled();
  });

  it('⛔ responde 400 para um corpo que não é JSON', async () => {
    expect((await POST(req('isto não é json'))).status).toBe(400);
    expect(h.loadShopeeContext).not.toHaveBeenCalled();
  });
});

/* ----------------------------------- 200 ---------------------------------- */

describe('descartar — 200', () => {
  it('descarta: relê a Shopee UMA vez, responde POR NOME e lê o relógio UMA vez', async () => {
    db.seed(CAMINHO, link());

    const res = await POST(req(corpo()));

    expect(res.status).toBe(200);
    const json: unknown = await res.json();
    expect(json).toEqual({ linkDocId: LINK, descartado: true });
    expect(respostaDescartarEdicoesAnuncioShopeeSchema.parse(json)).toEqual(json);
    expect(Date.now).toHaveBeenCalledTimes(1);
    expect(h.loadShopeeContext).toHaveBeenCalledTimes(1);
    expect(h.loadShopeeContext).toHaveBeenCalledWith(db, CONTA);
    expect(h.lerAnuncioShopee).toHaveBeenCalledWith({ cliente: true }, ITEM_ID);

    const depois = db.store[CAMINHO]?.data as DocData;
    expect(depois.item_name).toBe('Título da Shopee');
    expect(depois.edicaoErpPendenteEm).toBeNull();
    expect(depois.edicaoErpRevisao).toBe(REVISAO);
    expect(Object.keys(db.patches[0]?.patch ?? {})).toEqual(
      expect.arrayContaining([...CAMPOS_DE_EDICAO_ERP_SHOPEE]),
    );
  });

  it('nada pendente ⇒ 200 `descartado: false`, SEM carregar o contexto nem gravar', async () => {
    db.seed(CAMINHO, link({ edicaoErpPendenteEm: null }));

    const res = await POST(req(corpo()));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ linkDocId: LINK, descartado: false });
    expect(h.loadShopeeContext).not.toHaveBeenCalled();
    expect(h.lerAnuncioShopee).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });
});

/* -------------------------------- refusals -------------------------------- */

describe('recusas — o contexto da Shopee NUNCA é carregado', () => {
  it('⛔ 404 INEXISTENTE: o vínculo não existe', async () => {
    const res = await POST(req(corpo()));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.inexistente,
      linkDocId: LINK,
    });
    expect(h.loadShopeeContext).not.toHaveBeenCalled();
  });

  it('⛔ 409 ANUNCIO_NAO_EDITAVEL: um rascunho', async () => {
    db.seed(CAMINHO, link({ item_id: null }));

    const res = await POST(req(corpo()));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.anuncioNaoEditavel,
    });
    expect(h.loadShopeeContext).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it('⛔ 409 CONFLITO `conflitos: []`: a revisão enviada não é a gravada', async () => {
    db.seed(CAMINHO, link({ edicaoErpRevisao: REVISAO + 1 }));

    const res = await POST(req(corpo()));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.conflito,
      conflitos: [],
    });
    expect(h.loadShopeeContext).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });
});

describe('o que não é uma recusa do domínio', () => {
  it('um erro da Shopee (conta não configurada) é a resposta DA SHOPEE, não uma recusa — nada gravado', async () => {
    db.seed(CAMINHO, link());
    h.loadShopeeContext.mockRejectedValue(new ShopeeContaNotConfiguredError('conta sumiu'));

    const res = await POST(req(corpo()));

    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ error: 'conta sumiu' });
    expect(json).not.toHaveProperty('code');
    expect(db.writes).toEqual([]);
  });

  it('⛔ uma falha desconhecida propaga — nunca um 4xx inventado (rule 6)', async () => {
    db.seed(CAMINHO, link());
    h.lerAnuncioShopee.mockRejectedValue(new Error('bug inesperado'));

    await expect(POST(req(corpo()))).rejects.toThrow('bug inesperado');
    expect(db.writes).toEqual([]);
  });
});
