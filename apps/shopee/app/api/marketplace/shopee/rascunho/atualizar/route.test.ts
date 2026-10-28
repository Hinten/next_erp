/**
 * `POST …/rascunho/atualizar` (#1911, P4) — the ROUTE's half: the caller, the
 * strict body, the one clock read and the HTTP shape. The decisions are
 * `anuncios/rascunho.ts`'s and its own suite pins them; here the REAL module
 * runs over the FakeDb, so every answer below is the one a deployed route
 * gives — and the lock waits prove that `nowMs` is the route's clock.
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
  MSG_BASE_DIFERENTE_DO_PATCH_RASCUNHO_SHOPEE,
  MSG_PATCH_VAZIO_RASCUNHO_SHOPEE,
  respostaAtualizarRascunhoShopeeSchema,
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

function req(corpo: unknown, headers: Record<string, string> = AUTORIZADO): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/rascunho/atualizar', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function corpo(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return { integracaoId: CONTA, produtoId: PRODUTO, linkDocId: RASCUNHO, base, patch, ...over };
}

function rascunho(extra: DocData = {}): DocData {
  return {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta',
    item_id: null,
    description: null,
    category_id: 100_017,
    brand_id: null,
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

/** A FOREIGN publish lock expiring at `expiraEm` (ms), taken one TTL before it. */
function trava(expiraEm: number): DocData {
  return {
    publicacaoEmCurso: {
      desde: expiraEm - PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
      expiraEm,
      token: 'tok-outro',
    },
  };
}

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
  it('responde 401 sem o cabeçalho Authorization', async () => {
    semear();
    expect((await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'X' }), {}))).status).toBe(
      401,
    );
    expect(db.writes).toEqual([]);
  });

  it('⛔ responde 403 para quem só tem integracao.READ', async () => {
    semear();
    h.verifyIdToken.mockResolvedValue(LEITOR);

    expect((await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'X' })))).status).toBe(
      403,
    );
    expect(db.writes).toEqual([]);
  });

  it.each([
    ['um patch vazio', corpo({}, {}), MSG_PATCH_VAZIO_RASCUNHO_SHOPEE],
    [
      'uma base que não nomeia os campos do patch',
      corpo({ description: null }, { item_name: 'X' }),
      MSG_BASE_DIFERENTE_DO_PATCH_RASCUNHO_SHOPEE,
    ],
    ['`item_id` no patch', corpo({ item_name: 'Camiseta' }, { item_id: 1 }), 'item_id'],
    [
      '`publicacaoEmCurso` no patch',
      corpo({ item_name: 'Camiseta' }, { publicacaoEmCurso: null }),
      'publicacaoEmCurso',
    ],
    [
      'uma chave desconhecida no corpo',
      corpo({ item_name: 'Camiseta' }, { item_name: 'X' }, { forcar: true }),
      'forcar',
    ],
  ])('⛔ responde 400 para %s, sem ler nem escrever', async (_nome, body, frase) => {
    semear();
    const antes = db.opLog.length;
    const res = await POST(req(body));

    expect(res.status).toBe(400);
    // Zod's rendering: the schema's sentence, or the path it names.
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(frase);
    expect(db.opLog.length).toBe(antes);
    expect(db.writes).toEqual([]);
  });
});

describe('editar — 200', () => {
  it('grava o campo pedido e responde {linkDocId, gravados} POR NOME, com o relógio da rota', async () => {
    semear();
    const res = await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'Camiseta azul' })));

    expect(res.status).toBe(200);
    const json: unknown = await res.json();
    expect(json).toEqual({ linkDocId: RASCUNHO, gravados: [CAMPO_RASCUNHO_SHOPEE.itemName] });
    expect(respostaAtualizarRascunhoShopeeSchema.parse(json)).toEqual(json);
    expect(db.store[CAMINHO]?.data).toMatchObject({
      item_name: 'Camiseta azul',
      ultimaModificacao: T0,
    });
    expect(Date.now).toHaveBeenCalledTimes(1);
  });

  it('um patch igual ao que está gravado responde `gravados: []` e NÃO escreve', async () => {
    semear();
    const res = await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'Camiseta' })));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ linkDocId: RASCUNHO, gravados: [] });
    expect(db.writes).toEqual([]);
  });

  it('near-miss: a descrição mudou por outra mão, mas o patch só toca o título ⇒ 200', async () => {
    semear(rascunho({ description: 'escrita por outro operador' }));

    const res = await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'Camiseta azul' })));

    expect(res.status).toBe(200);
    expect(db.store[CAMINHO]?.data).toMatchObject({
      item_name: 'Camiseta azul',
      description: 'escrita por outro operador',
    });
  });

  it('K2-4: um rascunho legado SEM `item_name` aceita `base: {item_name: null}`', async () => {
    const legado = rascunho();
    delete legado.item_name;
    semear(legado);

    const res = await POST(req(corpo({ item_name: null }, { item_name: 'Camiseta nova' })));

    expect(res.status).toBe(200);
    expect(db.store[CAMINHO]?.data).toMatchObject({ item_name: 'Camiseta nova' });
  });

  it("K2-4: o `description: ''` legado contra a base `''` não é conflito", async () => {
    semear(rascunho({ description: '' }));

    const res = await POST(req(corpo({ description: '' }, { description: 'Algodão.' })));

    expect(res.status).toBe(200);
  });

  it("⛔ K2-4 near-miss: o mesmo `''` legado contra a base `null` É conflito (409)", async () => {
    semear(rascunho({ description: '' }));

    const res = await POST(req(corpo({ description: null }, { description: 'Algodão.' })));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.conflito,
      conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.description, atual: '' }],
    });
    expect(db.writes).toEqual([]);
  });

  it('a marca grava as DUAS chaves, e `gravados` traz a lista INTEIRA, na ordem canônica', async () => {
    semear(rascunho({ attributes: [{ attribute_id: 1 }] }));

    const res = await POST(
      req(
        corpo(
          { category_id: 100_017, marca: null },
          { marca: { brand_id: 77, original_brand_name: 'Marca X' }, category_id: 100_009 },
        ),
      ),
    );

    expect(res.status).toBe(200);
    // The category change also cleared the OLD category's attributes, and the
    // answer says so — every field written reaches the web, none dropped.
    await expect(res.json()).resolves.toEqual({
      linkDocId: RASCUNHO,
      gravados: [
        CAMPO_RASCUNHO_SHOPEE.categoryId,
        CAMPO_RASCUNHO_SHOPEE.marca,
        CAMPO_RASCUNHO_SHOPEE.attributes,
      ],
    });
    expect(db.store[CAMINHO]?.data).toMatchObject({
      category_id: 100_009,
      brand_id: 77,
      original_brand_name: 'Marca X',
      attributes: null,
    });
  });
});

describe('editar — recusas', () => {
  it('⛔ 409 CONFLITO quando o gravado não é o que o operador viu — nada escrito', async () => {
    semear(rascunho({ item_name: 'Camiseta editada noutra aba' }));
    const antes = structuredClone(db.store[CAMINHO]?.data);

    const res = await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'Camiseta azul' })));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.conflito,
      conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta editada noutra aba' }],
    });
    expect(db.store[CAMINHO]?.data).toEqual(antes);
  });

  it('⛔ 404 INEXISTENTE para um rascunho que não existe', async () => {
    semear(null);

    const res = await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'X' })));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: CODIGO_RASCUNHO_SHOPEE.inexistente });
  });

  it('⛔ 404 INEXISTENTE para o rascunho de OUTRA conta — intacto', async () => {
    semear(rascunho({ contaProdutoShopeeOuterRef: 'documents/integracao/int-2' }));
    const antes = structuredClone(db.store[CAMINHO]?.data);

    const res = await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'X' })));

    expect(res.status).toBe(404);
    expect(db.store[CAMINHO]?.data).toEqual(antes);
  });

  it('⛔ 409 JA_PUBLICADO para um vínculo que já é anúncio (D8a), com o `linkDocId`', async () => {
    semear(rascunho({ item_id: ITEM_ID, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo }));

    const res = await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'X' })));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.jaPublicado,
      linkDocId: RASCUNHO,
    });
    expect(db.writes).toEqual([]);
  });

  it('⛔ 409 EM_ANDAMENTO com `aguardarMs` medido pelo relógio da ROTA (trava viva)', async () => {
    semear(rascunho(trava(T0 + 60_000)));

    const res = await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'X' })));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento,
      aguardarMs: 60_000,
    });
    expect(db.writes).toEqual([]);
  });

  it('⛔ 409 EM_ANDAMENTO também na carência pós-expiração (K1-2)', async () => {
    semear(rascunho(trava(T0 - 1_000)));

    const res = await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'X' })));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento,
      aguardarMs: AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS - 1_000,
    });
  });

  it('⛔ 409 CATEGORIA_TRAVADA: mudar a categoria de um rascunho `incerta` (C-11)', async () => {
    semear(rascunho(trava(T0 - AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS - 1)));
    const antes = structuredClone(db.store[CAMINHO]?.data);

    const res = await POST(req(corpo({ category_id: 100_017 }, { category_id: 100_009 })));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.categoriaTravada,
    });
    expect(db.store[CAMINHO]?.data).toEqual(antes);
  });

  it('near-miss: o TÍTULO do mesmo rascunho `incerta` muda (200), e a trava sobrevive', async () => {
    const travaIncerta = trava(T0 - AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS - 1);
    semear(rascunho(travaIncerta));

    const res = await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'Camiseta azul' })));

    expect(res.status).toBe(200);
    expect(db.store[CAMINHO]?.data).toMatchObject({
      item_name: 'Camiseta azul',
      publicacaoEmCurso: travaIncerta.publicacaoEmCurso,
    });
  });

  it('⛔ a precondição perdida em TODA tentativa ⇒ 409 CONFLITO com `conflitos: []` (presente, vazio)', async () => {
    semear();
    db.falhasDeUpdate.set(CAMINHO, grpc(9, 'FAILED_PRECONDITION'));

    const res = await POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'Camiseta azul' })));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: expect.any(String),
      code: CODIGO_RASCUNHO_SHOPEE.conflito,
      linkDocId: RASCUNHO,
      conflitos: [],
    });
  });
});

describe('o que não é uma recusa NÃO vira resposta (rule 6)', () => {
  it('⛔ uma falha do Firestore no `update` propaga — nunca um 4xx inventado', async () => {
    semear();
    db.falhasDeUpdate.set(CAMINHO, grpc(14, 'UNAVAILABLE'));

    await expect(
      POST(req(corpo({ item_name: 'Camiseta' }, { item_name: 'Camiseta azul' }))),
    ).rejects.toThrow('UNAVAILABLE');
  });
});
