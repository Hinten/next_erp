/**
 * `POST …/rascunho` (#1911, P4) — the ROUTE's half: the caller, the strict body,
 * the one clock read and the HTTP shape. The decisions are
 * `anuncios/rascunho.ts`'s and its own suite pins them; here the REAL module
 * runs over the FakeDb (the `publicar` route's discipline), so every answer
 * below is the one a deployed route gives, status and body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  CAMPO_RASCUNHO_SHOPEE,
  CODIGO_RASCUNHO_SHOPEE,
  ESTADO_ANUNCIO_SHOPEE,
  INTEGRACAO_TIPO,
  MOTIVO_RASCUNHO_INVALIDO_SHOPEE,
  MSG_ITEM_NAME_EM_BRANCO_RASCUNHO_SHOPEE,
  respostaCriarRascunhoShopeeSchema,
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
// Firestore's auto-id shape: 20 letters or digits.
const RASCUNHO = 'Rasc0000000000000001';
const OUTRO_RASCUNHO = 'Rasc0000000000000002';
const LISTAGEM = 'link-vivo';
const ITEM_ID = 2500139861;
const T0 = 1_760_000_000_000;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const LEITOR = { uid: 'u2', permissions: PERM.integracao.read.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

const CAMINHO = `produtos/${PRODUTO}/prodshopee/${RASCUNHO}`;

function req(corpo: unknown, headers: Record<string, string> = AUTORIZADO): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/rascunho', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function corpo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { integracaoId: CONTA, produtoId: PRODUTO, linkDocId: RASCUNHO, ...over };
}

function semear(produto: DocData = {}, conta: DocData = {}): void {
  db.seed(`integracao/${CONTA}`, {
    tipo: INTEGRACAO_TIPO.shopee,
    ativo: true,
    nome: 'Loja Sandbox',
    shop_id: 987_654,
    ...conta,
  });
  db.seed(`produtos/${PRODUTO}`, {
    nome: 'Camiseta básica branca',
    sku: 'CAM-BR',
    paiId: null,
    ...produto,
  });
}

function vinculo(id: string, dados: DocData): void {
  db.seed(`produtos/${PRODUTO}/prodshopee/${id}`, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta',
    ...dados,
  });
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

/* ------------------------------ auth and body ------------------------------ */

describe('o chamador e o corpo — decididos ANTES de qualquer leitura', () => {
  it('401 sem o cabeçalho Authorization, nada escrito', async () => {
    semear();

    expect((await POST(req(corpo(), {}))).status).toBe(401);
    expect(db.writes).toEqual([]);
  });

  it('⛔ 403 para quem só tem integracao.READ — criar um rascunho exige .write (D6)', async () => {
    semear();
    h.verifyIdToken.mockResolvedValue(LEITOR);

    expect((await POST(req(corpo()))).status).toBe(403);
    expect(db.writes).toEqual([]);
  });

  it('400 para um body JSON malformado, sem ler nada', async () => {
    const res = await POST(req('{"integracaoId":'));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Body JSON inválido.' });
    expect(db.opLog).toEqual([]);
  });

  it.each([
    ['um id com separador', { linkDocId: 'a/b' }, 'linkDocId'],
    ['um id de 19 caracteres', { linkDocId: 'Rasc000000000000001' }, 'linkDocId'],
    ['o id de um vínculo de kit (64 hex)', { linkDocId: 'a'.repeat(64) }, 'linkDocId'],
    ['`item_id` no conteúdo (é do servidor)', { conteudo: { item_id: 1 } }, 'item_id'],
    [
      '`publicacaoEmCurso` no conteúdo',
      { conteudo: { publicacaoEmCurso: null } },
      'publicacaoEmCurso',
    ],
    ['uma chave desconhecida no corpo', { categoryId: 100_017 }, 'categoryId'],
    [
      '`confirmarSegundoAnuncio` como texto',
      { confirmarSegundoAnuncio: 'true' },
      'confirmarSegundoAnuncio',
    ],
    ['um produtoId com separador', { produtoId: 'a/b' }, 'produtoId'],
  ])('⛔ 400 para %s — nomeia o campo, sem ler nem escrever', async (_nome, over, campo) => {
    semear();
    const leiturasAntes = db.opLog.length;

    const res = await POST(req(corpo(over)));

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(campo);
    expect(db.opLog.length).toBe(leiturasAntes);
    expect(db.writes).toEqual([]);
  });

  it('o 400 de um título em branco carrega a FRASE do schema — o operador lê o motivo', async () => {
    semear();

    const res = await POST(req(corpo({ conteudo: { item_name: '   ' } })));

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(MSG_ITEM_NAME_EM_BRANCO_RASCUNHO_SHOPEE);
    // Zod renders paths and messages — never the value that failed.
    expect(db.writes).toEqual([]);
  });

  it('⛔ o 400 nunca ecoa o VALOR recusado', async () => {
    semear();
    const segredo = 'X'.repeat(2_001);

    const res = await POST(req(corpo({ conteudo: { item_name: segredo } })));

    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(segredo);
  });
});

/* --------------------------------- created -------------------------------- */

describe('201 / 200 — o rascunho criado agora, ou o mesmo rascunho já lá (D2, K1-9)', () => {
  it('201 {linkDocId, criado: true} POR NOME, e o rascunho nasce com o relógio da ROTA', async () => {
    semear();

    const res = await POST(req(corpo()));

    expect(res.status).toBe(201);
    const json: unknown = await res.json();
    expect(json).toEqual({ linkDocId: RASCUNHO, criado: true });
    expect(respostaCriarRascunhoShopeeSchema.parse(json)).toEqual(json);
    expect(db.store[CAMINHO]?.data).toMatchObject({
      contaProdutoShopeeOuterRef: REF_CONTA,
      item_id: null,
      // D2: with no `conteudo.item_name`, the title is the produto's name.
      item_name: 'Camiseta básica branca',
      dataCadastro: T0,
      ultimaModificacao: T0,
    });
    // ONE clock read per request, and it is the one that reached the document.
    expect(Date.now).toHaveBeenCalledTimes(1);
  });

  it('o `conteudo` chega normalizado: a marca grava as DUAS chaves, a descrição em branco é null', async () => {
    semear();

    const res = await POST(
      req(
        corpo({
          conteudo: {
            item_name: 'Camiseta azul',
            description: '   ',
            category_id: 100_017,
            marca: { brand_id: 0, original_brand_name: 'ignorado' },
          },
        }),
      ),
    );

    expect(res.status).toBe(201);
    expect(db.store[CAMINHO]?.data).toMatchObject({
      item_name: 'Camiseta azul',
      description: null,
      category_id: 100_017,
      brand_id: 0,
      original_brand_name: null,
    });
  });

  it('200 {criado: false} num duplo clique com o MESMO conteúdo — uma escrita só', async () => {
    semear();
    const conteudo = { item_name: 'Camiseta', category_id: 100_017 };
    expect((await POST(req(corpo({ conteudo })))).status).toBe(201);
    const escritas = db.writes.length;

    const res = await POST(req(corpo({ conteudo })));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ linkDocId: RASCUNHO, criado: false });
    expect(db.writes.length).toBe(escritas);
  });

  it('⛔ near-miss (K1-9): a repetição com OUTRO título é 409 CONFLITO, e nada muda', async () => {
    semear();
    expect((await POST(req(corpo({ conteudo: { item_name: 'Camiseta' } })))).status).toBe(201);
    const antes = structuredClone(db.store[CAMINHO]?.data);

    const res = await POST(req(corpo({ conteudo: { item_name: 'Camiseta azul' } })));

    expect(res.status).toBe(409);
    // The whole body: only the detail key the code names rides along.
    await expect(res.json()).resolves.toEqual({
      error: expect.any(String),
      code: CODIGO_RASCUNHO_SHOPEE.conflito,
      linkDocId: RASCUNHO,
      conflitos: [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta' }],
    });
    expect(db.store[CAMINHO]?.data).toEqual(antes);
  });
});

/* --------------------------------- refused -------------------------------- */

describe('409 ID_EM_USO — o id já guarda algo que não é ESTE rascunho', () => {
  it('⛔ um ANÚNCIO no id: 409, o vínculo intacto', async () => {
    semear();
    vinculo(RASCUNHO, { item_id: ITEM_ID, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    const antes = structuredClone(db.store[CAMINHO]?.data);

    const res = await POST(req(corpo()));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.idEmUso,
      linkDocId: RASCUNHO,
    });
    expect(db.store[CAMINHO]?.data).toEqual(antes);
  });

  it('⛔ o rascunho de OUTRA conta no id: 409, intacto', async () => {
    semear();
    vinculo(RASCUNHO, {
      contaProdutoShopeeOuterRef: 'documents/integracao/int-2',
      item_id: null,
    });
    const antes = structuredClone(db.store[CAMINHO]?.data);

    const res = await POST(req(corpo()));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: CODIGO_RASCUNHO_SHOPEE.idEmUso });
    expect(db.store[CAMINHO]?.data).toEqual(antes);
  });
});

describe('409 CONTA_JA_TEM_ANUNCIO — o segundo anúncio da conta (D15)', () => {
  function semearIrmaos(): void {
    vinculo(LISTAGEM, { item_id: ITEM_ID, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    vinculo(OUTRO_RASCUNHO, { item_id: null });
  }

  it('⛔ lista o anúncio vivo E o outro rascunho, e não cria', async () => {
    semear();
    semearIrmaos();

    const res = await POST(req(corpo()));

    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; vinculos: unknown[] };
    expect(json.code).toBe(CODIGO_RASCUNHO_SHOPEE.contaJaTemAnuncio);
    expect(json.vinculos).toHaveLength(2);
    expect(json.vinculos).toEqual(
      expect.arrayContaining([
        { linkDocId: LISTAGEM, itemId: ITEM_ID, rascunho: false },
        { linkDocId: OUTRO_RASCUNHO, itemId: null, rascunho: true },
      ]),
    );
    expect(db.store[CAMINHO]).toBeUndefined();
  });

  it('com `confirmarSegundoAnuncio: true` cria (201)', async () => {
    semear();
    semearIrmaos();

    expect((await POST(req(corpo({ confirmarSegundoAnuncio: true })))).status).toBe(201);
    expect(db.store[CAMINHO]?.data).toMatchObject({ item_id: null });
  });

  it('near-miss: um anúncio REMOVIDO não é motivo — cria sem a confirmação (201)', async () => {
    semear();
    vinculo(LISTAGEM, { item_id: ITEM_ID, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });

    expect((await POST(req(corpo()))).status).toBe(201);
  });

  it('near-miss: o anúncio de OUTRA conta não é motivo (201)', async () => {
    semear();
    vinculo(LISTAGEM, {
      contaProdutoShopeeOuterRef: 'documents/integracao/int-2',
      item_id: ITEM_ID,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });

    expect((await POST(req(corpo()))).status).toBe(201);
  });
});

describe('422 PRODUTO_INVALIDO — o produto que não carrega rascunho (K2-10)', () => {
  it('⛔ um filho de variação ⇒ {motivo: filho}, nada escrito', async () => {
    semear({ paiId: 'prod-pai' });

    const res = await POST(req(corpo()));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      error: expect.any(String),
      code: CODIGO_RASCUNHO_SHOPEE.produtoInvalido,
      linkDocId: RASCUNHO,
      motivo: MOTIVO_RASCUNHO_INVALIDO_SHOPEE.filho,
    });
    expect(db.writes).toEqual([]);
  });

  it('⛔ um kit virtual ⇒ {motivo: kit-virtual}, nada escrito', async () => {
    semear({ ehKit: true, ehKitVirtual: true });

    const res = await POST(req(corpo()));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_RASCUNHO_SHOPEE.produtoInvalido,
      motivo: MOTIVO_RASCUNHO_INVALIDO_SHOPEE.kitVirtual,
    });
    expect(db.writes).toEqual([]);
  });

  it('near-miss: `ehKitVirtual` SEM `ehKit` não é kit virtual — cria (201)', async () => {
    semear({ ehKit: false, ehKitVirtual: true });

    expect((await POST(req(corpo()))).status).toBe(201);
  });
});

describe('404 e 400 vindos do módulo', () => {
  it('⛔ a conta não é Shopee ⇒ 404 (a resposta de `shopeeErrorResponse`), nada escrito', async () => {
    semear({}, { tipo: INTEGRACAO_TIPO.mercadoLivre });

    const res = await POST(req(corpo()));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: expect.any(String) });
    expect(db.writes).toEqual([]);
  });

  it('⛔ a conta não existe ⇒ 404, nada escrito', async () => {
    semear();
    delete db.store[`integracao/${CONTA}`];

    expect((await POST(req(corpo()))).status).toBe(404);
    expect(db.writes).toEqual([]);
  });

  it('⛔ o produto não existe ⇒ 404 INEXISTENTE, nada escrito', async () => {
    semear();
    delete db.store[`produtos/${PRODUTO}`];

    const res = await POST(req(corpo()));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: CODIGO_RASCUNHO_SHOPEE.inexistente });
    expect(db.writes).toEqual([]);
  });

  it('um produto sem nome e sem `item_name` ⇒ 400 do módulo, SEM código, nada escrito', async () => {
    semear({ nome: '   ' });

    const res = await POST(req(corpo()));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: expect.any(String), linkDocId: RASCUNHO });
    expect(db.writes).toEqual([]);
  });
});

describe('o que não é uma recusa NÃO vira resposta (rule 6)', () => {
  it('⛔ uma falha do Firestore no `create()` propaga — nunca um 4xx inventado', async () => {
    semear();
    db.falhasDeCriacao.set(CAMINHO, grpc(14, 'UNAVAILABLE'));

    await expect(POST(req(corpo()))).rejects.toThrow('UNAVAILABLE');
  });
});
