/**
 * `POST …/rascunho/descartar` (#1911, P4) — the ROUTE's half: the caller, the
 * strict body, the one clock read and the HTTP shape of this app's ONE
 * `prodshopee` delete. The decisions are `anuncios/rascunho.ts`'s and its own
 * suite pins them; here the REAL module runs over the FakeDb and its `deletes`
 * log, so every answer below is the one a deployed route gives — and every
 * refusal leaves the draft BYTE-identical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  CAMPO_RASCUNHO_SHOPEE,
  CODIGO_RASCUNHO_SHOPEE,
  ESTADO_ANUNCIO_SHOPEE,
  INTEGRACAO_TIPO,
  PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
  respostaDescartarRascunhoShopeeSchema,
} from '@delfrance/schemas';

import { FakeDb, asDb, grpc, type DocData } from '@/lib/shopee/testing/fakeDb';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
  tryGetAdminBucket: () => null,
}));

const { POST } = await import('./route');

/* --------------------------------- fixtures ------------------------------- */

const CONTA = 'int-1';
const REF_CONTA = `documents/integracao/${CONTA}`;
const PRODUTO = 'prod-1';
const RASCUNHO = 'Rasc0000000000000001';
const ITEM_ID = 2500139861;
const T0 = 1_760_000_000_000;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const LEITOR = { uid: 'u2', permissions: PERM.integracao.read.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

const CAMINHO = `produtos/${PRODUTO}/prodshopee/${RASCUNHO}`;

/** What the operator SAW — the projection of {@link rascunho}'s defaults. */
const BASE = {
  item_name: 'Camiseta',
  description: null,
  category_id: 100_017,
  marca: { brand_id: 0, original_brand_name: null },
  // P6: the projection carries `attributes` too (`null` = nothing stored).
  attributes: null,
};

function req(corpo: unknown, headers: Record<string, string> = AUTORIZADO): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/rascunho/descartar', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function corpo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { integracaoId: CONTA, produtoId: PRODUTO, linkDocId: RASCUNHO, base: BASE, ...over };
}

function rascunho(extra: DocData = {}): DocData {
  return {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta',
    item_id: null,
    description: null,
    category_id: 100_017,
    brand_id: 0,
    original_brand_name: null,
    ...extra,
  };
}

function semear(link: DocData | null = rascunho()): void {
  db.seed(`integracao/${CONTA}`, {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja Sandbox',
    shop_id: 987_654,
  });
  db.seed(`produtos/${PRODUTO}`, { nome: 'Camiseta básica branca', sku: 'CAM-BR', paiId: null });
  if (link !== null) db.seed(CAMINHO, link);
}

/**
 * A FOREIGN publish lock expiring at `expiraEm` (ms), taken one TTL before it,
 * STAMPED by its run's pre-send re-read (`sku`): a create may be in flight, so
 * past `expiraEm` it serves the grace, then reads `incerta` (batch-A review).
 */
function trava(expiraEm: number): DocData {
  const { publicacaoEmCurso } = travaSemCarimbo(expiraEm);
  return { publicacaoEmCurso: { ...(publicacaoEmCurso as DocData), sku: 'CAM-BR' } };
}

/** The same lock, never stamped: its run died before the send — past `expiraEm`, `livre`. */
function travaSemCarimbo(expiraEm: number): DocData {
  return {
    publicacaoEmCurso: {
      desde: expiraEm - PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
      expiraEm,
      token: 'tok-outro',
    },
  };
}

/** A lock past its expiry AND its grace — the reading is `incerta`. */
const INCERTA = trava(T0 - AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS - 1);

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  vi.spyOn(Date, 'now').mockReturnValue(T0);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __resetAllReadCaches();
  vi.restoreAllMocks();
});

describe('autenticação e corpo', () => {
  it('responde 401 sem o cabeçalho Authorization — o rascunho fica', async () => {
    semear();
    expect((await POST(req(corpo(), {}))).status).toBe(401);
    expect(db.store[CAMINHO]).toBeDefined();
    expect(db.deletes).toEqual([]);
  });

  it('⛔ responde 403 para quem só tem integracao.READ — o rascunho fica', async () => {
    semear();
    h.verifyIdToken.mockResolvedValue(LEITOR);

    expect((await POST(req(corpo()))).status).toBe(403);
    expect(db.deletes).toEqual([]);
  });

  it.each([
    ['sem `base`', { base: undefined }, 'base'],
    [
      'uma `base` sem a marca (K1-13: todo campo projetado)',
      { base: { ...BASE, marca: undefined } },
      'base.marca',
    ],
    [
      'uma `base` sem os atributos (P6: projetados também, K1-13)',
      { base: { ...BASE, attributes: undefined } },
      'base.attributes',
    ],
    [
      'uma atestação que não é booleana',
      { confirmarCriacaoIncerta: 'sim' },
      'confirmarCriacaoIncerta',
    ],
    ['uma chave desconhecida', { forcar: true }, 'forcar'],
  ])('⛔ responde 400 para %s — nomeia o campo, sem ler nem apagar', async (_nome, over, campo) => {
    semear();
    const antes = db.opLog.length;
    const res = await POST(req(corpo(over)));

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(campo);
    expect(db.opLog.length).toBe(antes);
    expect(db.deletes).toEqual([]);
  });
});

describe('descartar — 200', () => {
  it('apaga um rascunho `livre` SEM atestação, com precondição, e responde POR NOME', async () => {
    semear();

    const res = await POST(req(corpo()));

    expect(res.status).toBe(200);
    const json: unknown = await res.json();
    expect(json).toEqual({ linkDocId: RASCUNHO, descartado: true, criacaoIncerta: false });
    expect(respostaDescartarRascunhoShopeeSchema.parse(json)).toEqual(json);
    expect(db.store[CAMINHO]).toBeUndefined();
    // Rule 7 tier 1: the ONE delete carries the snapshot's stamp.
    expect(db.deletes).toEqual([{ path: CAMINHO, comPrecondicao: true }]);
    expect(Date.now).toHaveBeenCalledTimes(1);
  });

  it('⛔ NEAR-MISS (batch-A review): a trava vencida NUNCA carimbada, sem registro, é `livre` — apaga SEM atestação', async () => {
    semear(rascunho(travaSemCarimbo(T0 - AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS - 1)));

    const res = await POST(req(corpo()));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      linkDocId: RASCUNHO,
      descartado: true,
      criacaoIncerta: false,
    });
    expect(db.store[CAMINHO]).toBeUndefined();
  });

  it('`incerta` COM `confirmarCriacaoIncerta: true` apaga e responde `criacaoIncerta: true` (K1-6)', async () => {
    semear(rascunho(INCERTA));

    const res = await POST(req(corpo({ confirmarCriacaoIncerta: true })));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      linkDocId: RASCUNHO,
      descartado: true,
      criacaoIncerta: true,
    });
    expect(db.store[CAMINHO]).toBeUndefined();
  });
});

describe('descartar — recusas (o rascunho fica BYTE a byte)', () => {
  it('⛔ 409 CRIACAO_INCERTA: `incerta` SEM a atestação (K1-6)', async () => {
    semear(rascunho(INCERTA));
    const antes = structuredClone(db.store[CAMINHO]?.data);

    const res = await POST(req(corpo()));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.criacaoIncerta,
    });
    expect(db.store[CAMINHO]?.data).toEqual(antes);
    expect(db.deletes).toEqual([]);
  });

  it('⛔ 409 CONFLITO: uma edição concorrente mudou o rascunho que o operador viu (K1-13)', async () => {
    semear(rascunho({ item_name: 'Camiseta editada noutra aba' }));
    const antes = structuredClone(db.store[CAMINHO]?.data);

    const res = await POST(req(corpo()));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.conflito,
      conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta editada noutra aba' }],
    });
    expect(db.store[CAMINHO]?.data).toEqual(antes);
    expect(db.deletes).toEqual([]);
  });

  it('⛔ 409 EM_ANDAMENTO: uma trava viva — nem a atestação apaga', async () => {
    semear(rascunho(trava(T0 + 60_000)));

    const res = await POST(req(corpo({ confirmarCriacaoIncerta: true })));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento,
      aguardarMs: 60_000,
    });
    expect(db.deletes).toEqual([]);
  });

  it('⛔ 409 JA_PUBLICADO: o vínculo já é um anúncio — nunca se apaga um anúncio', async () => {
    semear(rascunho({ item_id: ITEM_ID, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo }));

    const res = await POST(req(corpo()));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.jaPublicado,
      linkDocId: RASCUNHO,
    });
    expect(db.deletes).toEqual([]);
  });

  it('⛔ 404 INEXISTENTE: o rascunho de OUTRA conta', async () => {
    semear(rascunho({ contaProdutoShopeeOuterRef: 'documents/integracao/int-2' }));

    const res = await POST(req(corpo()));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: CODIGO_RASCUNHO_SHOPEE.inexistente });
    expect(db.deletes).toEqual([]);
  });

  it('⛔ 404 INEXISTENTE: um rascunho que não existe (nada a apagar)', async () => {
    semear(null);

    expect((await POST(req(corpo()))).status).toBe(404);
    expect(db.deletes).toEqual([]);
  });

  it('⛔ a precondição perdida em TODA tentativa ⇒ 409 CONFLITO `conflitos: []`, o rascunho fica', async () => {
    semear();
    db.falhasDeDelete.set(CAMINHO, grpc(9, 'FAILED_PRECONDITION'));

    const res = await POST(req(corpo()));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: expect.any(String),
      code: CODIGO_RASCUNHO_SHOPEE.conflito,
      linkDocId: RASCUNHO,
      conflitos: [],
    });
    expect(db.store[CAMINHO]).toBeDefined();
  });
});

describe('o que não é uma recusa NÃO vira resposta (rule 6)', () => {
  it('⛔ uma falha do Firestore no `delete` propaga — nunca um 4xx inventado', async () => {
    semear();
    db.falhasDeDelete.set(CAMINHO, grpc(14, 'UNAVAILABLE'));

    await expect(POST(req(corpo()))).rejects.toThrow('UNAVAILABLE');
    expect(db.store[CAMINHO]).toBeDefined();
  });
});
