import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shopeeModelSchema, type ShopeeModel } from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE, SHOPEE_MODEL_STATUS } from '@delfrance/schemas';

import { idDoVinculoDeKit } from '../kits/idsKit';
import { INDICES_COMPOSTOS_SHOPEE } from '../pedidos/produtoResolve';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  lerLinksDeVariacao,
  resolverLinkPorItemId,
  resolverLinkPorProduto,
  resolverLinkVivoPorProduto,
  sincronizarLinksDeVariacao,
} from './linkAnuncio';

/* ---------------------------------- fixtures ------------------------------ */

const [INDICE_VARIACAO, INDICE_LISTAGEM] = INDICES_COMPOSTOS_SHOPEE;

const ITEM_ID = 2500139861;
const MODEL_A = 2000458802;
const MODEL_B = 2000458803;
const INTEGRACAO = 'int-1';
const OUTRA = 'int-2';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const REF_OUTRA_CONTA = `documents/integracao/${OUTRA}`;
const PAI = 'prod-pai';
const FILHO_A = 'prod-filho-a';
const FILHO_B = 'prod-filho-b';
/** The listing every {@link semearLinkFilho} row points at by default. */
const LINK = 'link-1';
const AGORA = 1_757_000_000_000;

/* Step 19 roles (D1): the native kit, and the second kit of a recriar. */
const ITEM_KIT = 2500139870;
const ITEM_KIT_NOVO = 2500139873;
const MODELO_KIT_A = 2000458820;
const MODELO_KIT_B = 2000458822;

function semearLinkPai(
  db: FakeDb,
  id: string,
  extra: Record<string, unknown> = {},
  produtoId: string = PAI,
): void {
  db.seed(`produtos/${produtoId}/prodshopee/${id}`, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta Básica',
    item_id: ITEM_ID,
    ...extra,
  });
}

function semearFilho(db: FakeDb, filhoId: string): void {
  db.seed(`produtos/${filhoId}`, { nome: 'Camiseta Básica P', paiId: PAI });
}

function semearLinkFilho(
  db: FakeDb,
  filhoId: string,
  id: string,
  extra: Record<string, unknown> = {},
): void {
  db.seed(`produtos/${filhoId}/variashopee/${id}`, {
    contaVariacaoShopeeOuterRef: REF_CONTA,
    produtoShopeeOuterRef: `documents/produtos/${PAI}/prodshopee/link-1`,
    model_id: MODEL_A,
    tier_index: [0],
    model_status: SHOPEE_MODEL_STATUS.normal,
    ...extra,
  });
}

/**
 * One `get_model_list` row. ⚠️ `model_status` defaults to `MODEL_NORMAL` so it
 * AGREES with {@link semearLinkFilho}'s stored value: the point of most of these
 * cases is what a CHANGE writes, and a fixture that silently disagreed on a
 * second field would make every one of them write for the wrong reason.
 */
function modelo(parcial: Record<string, unknown> = {}): ShopeeModel {
  return shopeeModelSchema.parse({
    model_id: MODEL_A,
    tier_index: [0],
    model_status: SHOPEE_MODEL_STATUS.normal,
    ...parcial,
  });
}

/** The last query the double recorded, whole. */
function ultimaConsulta(db: FakeDb): FakeDb['consultasCompletas'][number] {
  const linha = db.consultasCompletas.at(-1);
  if (linha === undefined) throw new Error('fixture: nenhuma consulta registrada');
  return linha;
}

let avisos: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                      (1) resolverLinkPorItemId — the index                  */
/* -------------------------------------------------------------------------- */

describe('resolverLinkPorItemId', () => {
  it('resolverLinkPorItemId usa o índice DECLARADO, com item_id NÚMERO', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-1', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });

    const link = await resolverLinkPorItemId(asDb(db), INTEGRACAO, ITEM_ID);

    expect(link).toMatchObject({
      produtoId: PAI,
      linkDocId: 'link-1',
      itemId: ITEM_ID,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });

    const consulta = ultimaConsulta(db);
    expect(consulta.fonte).toBe(`group:${INDICE_LISTAGEM.collectionGroup}`);
    // The clause FIELDS are the declared composite's, in its order — the same
    // constant `produtoResolve.test.ts` reads against `firestore.indexes.json`.
    expect(consulta.clausulas.map(([campo]) => campo)).toEqual([...INDICE_LISTAGEM.campos]);
    expect(consulta.clausulas.map(([, op]) => op)).toEqual(['==', '==']);
    // ⚠️ A NUMBER on the wire, not a string.
    expect(typeof consulta.clausulas[0]?.[2]).toBe('number');
    expect(consulta.clausulas[1]?.[2]).toBe(REF_CONTA);
    // `limit(2)` is the ambiguity detector, not a page size.
    expect(consulta.limite).toBe(2);
  });

  it('⚠️ NEAR-MISS: um item_id em STRING não casa nada', async () => {
    const db = new FakeDb();
    // The legacy bug, pinned: a stringified id is a different value to Firestore
    // and the query silently answers nothing.
    semearLinkPai(db, 'link-1', { item_id: String(ITEM_ID) });

    expect(await resolverLinkPorItemId(asDb(db), INTEGRACAO, ITEM_ID)).toBeNull();
  });

  it('dois links para o mesmo item_id escolhem o lexicograficamente PRIMEIRO, e nada é apagado', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-b');
    semearLinkPai(db, 'link-a');

    const link = await resolverLinkPorItemId(asDb(db), INTEGRACAO, ITEM_ID);

    expect(link?.linkDocId).toBe('link-a');
    expect(avisos).toHaveBeenCalledTimes(1);
    // NOTHING is deleted — a link document is the only record of a binding an
    // operator may have made by hand.
    expect(db.store[`produtos/${PAI}/prodshopee/link-b`]).toBeDefined();
    expect(db.store[`produtos/${PAI}/prodshopee/link-a`]).toBeDefined();
    expect(db.writes).toEqual([]);
  });

  it('um link de outra conta com o mesmo item_id não é devolvido', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-1', { contaProdutoShopeeOuterRef: REF_OUTRA_CONTA });

    expect(await resolverLinkPorItemId(asDb(db), INTEGRACAO, ITEM_ID)).toBeNull();
  });

  it('um item_id não publicado (0 ou null) dobra para null em itemId', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-1', { item_id: 0 });

    // The query is by `item_id`, so a `0` still resolves when asked for `0` —
    // and the folded `itemId` says "never published", which is the one check
    // every caller makes.
    const link = await resolverLinkPorItemId(asDb(db), INTEGRACAO, 0);
    expect(link?.linkDocId).toBe('link-1');
    expect(link?.itemId).toBeNull();
  });

  it('um estadoAnuncio armazenado que ninguém reconhece lê como null, sem lançar', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-1', { estadoAnuncio: 'ESTADO_QUE_NAO_EXISTE' });

    const link = await resolverLinkPorItemId(asDb(db), INTEGRACAO, ITEM_ID);
    expect(link?.estadoAnuncio).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                   (2) resolverLinkPorProduto — no `where`                   */
/* -------------------------------------------------------------------------- */

describe('resolverLinkPorProduto', () => {
  it('resolverLinkPorProduto NÃO roda where — a filtragem é em memória', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-1');

    const link = await resolverLinkPorProduto(asDb(db), INTEGRACAO, PAI);

    expect(link?.linkDocId).toBe('link-1');
    const consulta = ultimaConsulta(db);
    expect(consulta.fonte).toBe(`produtos/${PAI}/prodshopee`);
    // ⚠️ The index claim, mechanised: ZERO clauses, no ordering, no limit. On
    // Enterprise an undeclared `where` does not throw — it full-scans and bills
    // the scan — and a produto holds a handful of link docs.
    expect(consulta.clausulas).toEqual([]);
    expect(consulta.ordens).toEqual([]);
    expect(consulta.limite).toBeNull();
  });

  it('um link de OUTRA conta sob o mesmo produto não é devolvido', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-alheio', { contaProdutoShopeeOuterRef: REF_OUTRA_CONTA });

    expect(await resolverLinkPorProduto(asDb(db), INTEGRACAO, PAI)).toBeNull();

    // …and it is invisible even when ours sits beside it.
    semearLinkPai(db, 'link-nosso');
    const link = await resolverLinkPorProduto(asDb(db), INTEGRACAO, PAI);
    expect(link?.linkDocId).toBe('link-nosso');
  });

  it('linkDocId nomeando um documento de outra conta devolve null', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-nosso');
    semearLinkPai(db, 'link-alheio', { contaProdutoShopeeOuterRef: REF_OUTRA_CONTA });

    // The conta filter runs FIRST, so the id can only narrow within what this
    // conta owns — it can never reach across.
    expect(await resolverLinkPorProduto(asDb(db), INTEGRACAO, PAI, 'link-alheio')).toBeNull();
    const nosso = await resolverLinkPorProduto(asDb(db), INTEGRACAO, PAI, 'link-nosso');
    expect(nosso?.linkDocId).toBe('link-nosso');
  });

  it('um linkDocId vazio não estreita nada', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-1');

    expect((await resolverLinkPorProduto(asDb(db), INTEGRACAO, PAI, ''))?.linkDocId).toBe('link-1');
    expect((await resolverLinkPorProduto(asDb(db), INTEGRACAO, PAI, null))?.linkDocId).toBe(
      'link-1',
    );
  });

  it('⚠️ continua LÉXICO no passo 19: um vínculo removido que ordena primeiro ainda é o escolhido', async () => {
    // L10(3)/L10-R1: este é o resolvedor da PUBLICAÇÃO, e publicar um produto
    // que não é kit não pode mudar. O tiered é o irmão `resolverLinkVivoPorProduto`.
    const db = new FakeDb();
    semearLinkPai(db, 'link-a', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });
    semearLinkPai(db, 'link-b', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo, item_id: 1 });
    semearLinkPai(db, 'link-c', {
      kitNativo: true,
      item_id: ITEM_KIT,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });

    expect((await resolverLinkPorProduto(asDb(db), INTEGRACAO, PAI))?.linkDocId).toBe('link-a');
  });
});

/* -------------------------------------------------------------------------- */
/*          (2b) resolverLinkVivoPorProduto — the tiered sibling (step 19)      */
/* -------------------------------------------------------------------------- */

describe('resolverLinkVivoPorProduto', () => {
  it('M118: um vínculo SUBSTITUÍDO que ordena primeiro perde para o kit nativo ativo', async () => {
    // L8: o anúncio comum convertido continua VIVO na Shopee, mas quem vende o
    // produto agora é o kit. "Reverificar/pausar este produto" é o kit.
    const db = new FakeDb();
    semearLinkPai(db, 'link-a', {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      kitNativo: false,
      substituidoPorLinkDocId: 'link-b',
      substituidoEm: AGORA,
    });
    semearLinkPai(db, 'link-b', {
      kitNativo: true,
      item_id: ITEM_KIT,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });

    expect((await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI))?.linkDocId).toBe('link-b');
    // ⚠️ NEAR-MISS: o resolvedor da PUBLICAÇÃO, sobre os MESMOS documentos,
    // continua léxico — é por isso que ele não é o chamado aqui.
    expect((await resolverLinkPorProduto(asDb(db), INTEGRACAO, PAI))?.linkDocId).toBe('link-a');
  });

  it('M118 (variante): um kit nativo ANTIGO substituído (o delete do recriar não pegou) perde para o novo', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-a', {
      kitNativo: true,
      item_id: ITEM_KIT,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      substituidoPorLinkDocId: 'link-b',
      substituidoEm: AGORA,
    });
    semearLinkPai(db, 'link-b', {
      kitNativo: true,
      item_id: ITEM_KIT_NOVO,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });

    expect((await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI))?.linkDocId).toBe('link-b');
  });

  it('M122: depois de um recriar, o kit REMOVIDO perde para o novo — nas DUAS ordens sha256', async () => {
    // Os ids reais dos vínculos de kit (`idDoVinculoDeKit`): trocar os PAPÉIS dos
    // dois item_ids garante que, numa das rodadas, o removido ordena primeiro.
    const idA = idDoVinculoDeKit(INTEGRACAO, ITEM_KIT);
    const idB = idDoVinculoDeKit(INTEGRACAO, ITEM_KIT_NOVO);
    expect(idA).not.toBe(idB);
    for (const [antigo, novo] of [
      [idA, idB],
      [idB, idA],
    ] as const) {
      const db = new FakeDb();
      semearLinkPai(db, antigo, {
        kitNativo: true,
        item_id: antigo === idA ? ITEM_KIT : ITEM_KIT_NOVO,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      });
      semearLinkPai(db, novo, {
        kitNativo: true,
        item_id: novo === idA ? ITEM_KIT : ITEM_KIT_NOVO,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      });

      const link = await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI);
      expect(link?.linkDocId).toBe(novo);
    }
  });

  it('o kit nativo ativo vence até um anúncio comum VIVO não substituído que ordena primeiro (conversão interrompida)', async () => {
    // RT14 V2: a converter crashed after the new kit's link write and BEFORE the
    // supersede, so both links are live. Re-verify/pause address the kit — the
    // dispatcher's native-first rule, so the operator's view matches publish's.
    const db = new FakeDb();
    semearLinkPai(db, 'link-a', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo, kitNativo: false });
    semearLinkPai(db, 'link-b', {
      kitNativo: true,
      item_id: ITEM_KIT,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });

    expect((await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI))?.linkDocId).toBe('link-b');
  });

  it('sem kit nativo: um anúncio comum SUBSTITUÍDO que ordena primeiro perde para o comum vivo', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-a', {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      substituidoPorLinkDocId: 'link-x',
    });
    semearLinkPai(db, 'link-b', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });

    expect((await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI))?.linkDocId).toBe('link-b');
    // ⚠️ NEAR-MISS: an EMPTY `substituidoPorLinkDocId` is "not superseded" — the
    // shared predicate's rule, so a stray '' never hides a live link.
    const vazio = new FakeDb();
    semearLinkPai(vazio, 'link-a', {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      substituidoPorLinkDocId: '',
    });
    semearLinkPai(vazio, 'link-b', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });
    expect((await resolverLinkVivoPorProduto(asDb(vazio), INTEGRACAO, PAI))?.linkDocId).toBe(
      'link-a',
    );
  });

  it('sem kit nativo: um anúncio comum VIVO vence o removido que ordena primeiro', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-a', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });
    semearLinkPai(db, 'link-b', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });

    expect((await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI))?.linkDocId).toBe('link-b');
  });

  it('⚠️ NEAR-MISS: um estadoAnuncio que ninguém reconhece NÃO é remoção — o vínculo continua vivo', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-a', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });
    semearLinkPai(db, 'link-b', { estadoAnuncio: 'ESTADO_QUE_NAO_EXISTE' });

    expect((await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI))?.linkDocId).toBe('link-b');
  });

  it('⚠️ NEAR-MISS: um kitNativo sem item_id endereçável não é "ativo" — fica no segundo degrau', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-a', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo, item_id: 1 });
    semearLinkPai(db, 'link-b', {
      kitNativo: true,
      item_id: null,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });

    // Nenhum dos dois é kit nativo ATIVO; ambos estão vivos ⇒ o léxico decide.
    expect((await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI))?.linkDocId).toBe('link-a');
  });

  it('todos removidos: ainda resolve (o léxico) — o chamador relata o estado, não um 404', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-b', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });
    semearLinkPai(db, 'link-a', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });

    expect((await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI))?.linkDocId).toBe('link-a');
  });

  it('um linkDocId NOMEADO vence qualquer degrau — é como o operador confirma o anúncio antigo', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-a', {
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      substituidoPorLinkDocId: 'link-b',
    });
    semearLinkPai(db, 'link-b', {
      kitNativo: true,
      item_id: ITEM_KIT,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });

    const link = await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI, 'link-a');
    expect(link?.linkDocId).toBe('link-a');
  });

  it('a conta filtra PRIMEIRO: o kit nativo ativo de OUTRA conta é invisível, e sem where', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-a', {
      contaProdutoShopeeOuterRef: REF_OUTRA_CONTA,
      kitNativo: true,
      item_id: ITEM_KIT,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });
    semearLinkPai(db, 'link-b', { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo });

    expect((await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI))?.linkDocId).toBe('link-b');
    expect(await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, PAI, 'link-a')).toBeNull();
    const consulta = ultimaConsulta(db);
    expect(consulta.fonte).toBe(`produtos/${PAI}/prodshopee`);
    expect(consulta.clausulas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (3) lerLinksDeVariacao                               */
/* -------------------------------------------------------------------------- */

describe('lerLinksDeVariacao', () => {
  it('lerLinksDeVariacao lê os filhos por paiId e filtra a conta EM MEMÓRIA', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearFilho(db, FILHO_B);
    semearLinkFilho(db, FILHO_A, 'va-1', { model_id: MODEL_A });
    semearLinkFilho(db, FILHO_B, 'vb-1', { model_id: MODEL_B, tier_index: [1] });
    semearLinkFilho(db, FILHO_B, 'vb-alheio', {
      model_id: MODEL_B,
      contaVariacaoShopeeOuterRef: REF_OUTRA_CONTA,
    });
    // A produto of ANOTHER family must not be walked.
    db.seed('produtos/prod-outro-filho', { paiId: 'prod-outro-pai' });
    db.seed('produtos/prod-outro-filho/variashopee/vx', {
      contaVariacaoShopeeOuterRef: REF_CONTA,
      model_id: 999,
    });

    const links = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI, LINK);

    expect(links.map((l) => [l.produtoId, l.linkDocId, l.modelId])).toEqual([
      [FILHO_A, 'va-1', MODEL_A],
      [FILHO_B, 'vb-1', MODEL_B],
    ]);
    expect(links[1]?.tierIndex).toEqual([1]);

    // The children come from ONE `paiId ==` query; every `variashopee` read is
    // UNFILTERED and the conta is compared in memory.
    const consultas = db.consultasCompletas;
    expect(consultas[0]).toMatchObject({
      fonte: 'produtos',
      clausulas: [['paiId', '==', PAI]],
    });
    for (const c of consultas.slice(1)) {
      expect(c.fonte).toMatch(/\/variashopee$/);
      expect(c.clausulas).toEqual([]);
    }
    // 1 produtos query + one per child — stated so the read budget is visible.
    expect(consultas).toHaveLength(3);
  });

  it('o sentinela model_id 0 dobra para null — ele nunca é reconciliado', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1', { model_id: 0 });

    const links = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI, LINK);
    expect(links).toHaveLength(1);
    expect(links[0]?.modelId).toBeNull();
  });

  it('um model_status que ninguém reconhece lê como null', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1', { model_status: 'MODEL_INVENTADO' });

    const links = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI, LINK);
    expect(links[0]?.modelStatus).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                     (4) sincronizarLinksDeVariacao                          */
/* -------------------------------------------------------------------------- */

function ehObjetoSimples(valor: unknown): boolean {
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) return false;
  const proto: unknown = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

describe('sincronizarLinksDeVariacao', () => {
  it('sincronizarLinksDeVariacao reconcilia POR model_id — ⚠️ PAR: a ordem das linhas lidas não muda nada', async () => {
    const semear = (db: FakeDb): void => {
      semearFilho(db, FILHO_A);
      semearFilho(db, FILHO_B);
      semearLinkFilho(db, FILHO_A, 'va-1', { model_id: MODEL_A, tier_index: [0] });
      semearLinkFilho(db, FILHO_B, 'vb-1', { model_id: MODEL_B, tier_index: [1] });
    };
    const lidos = [
      modelo({ model_id: MODEL_A, tier_index: [5] }),
      modelo({ model_id: MODEL_B, tier_index: [6] }),
    ];

    const naOrdem = new FakeDb();
    semear(naOrdem);
    const a = await sincronizarLinksDeVariacao(asDb(naOrdem), INTEGRACAO, PAI, LINK, lidos, AGORA);

    const trocado = new FakeDb();
    semear(trocado);
    const b = await sincronizarLinksDeVariacao(
      asDb(trocado),
      INTEGRACAO,
      PAI,
      LINK,
      [...lidos].reverse(),
      AGORA,
    );

    // ⚠️ PAR: reconciled BY `model_id`. A swapped read order marks NOTHING and
    // hands each child its OWN model's `tier_index`.
    expect(a).toEqual({ atualizados: 2, marcados: 0, modelosSemFilho: [] });
    expect(b).toEqual(a);
    for (const db of [naOrdem, trocado]) {
      expect(db.store[`produtos/${FILHO_A}/variashopee/va-1`]?.data.tier_index).toEqual([5]);
      expect(db.store[`produtos/${FILHO_B}/variashopee/vb-1`]?.data.tier_index).toEqual([6]);
    }
  });

  it('um modelo que sumiu é MARCADO MODEL_UNAVAILABLE, NUNCA apagado', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearFilho(db, FILHO_B);
    semearLinkFilho(db, FILHO_A, 'va-1', { model_id: MODEL_A });
    semearLinkFilho(db, FILHO_B, 'vb-1', { model_id: MODEL_B, tier_index: [1] });

    // The fresh reading no longer reports MODEL_B.
    const r = await sincronizarLinksDeVariacao(
      asDb(db),
      INTEGRACAO,
      PAI,
      LINK,
      [modelo({ model_id: MODEL_A })],
      AGORA,
    );

    expect(r).toEqual({ atualizados: 0, marcados: 1, modelosSemFilho: [] });
    const marcado = db.store[`produtos/${FILHO_B}/variashopee/vb-1`];
    expect(marcado?.data).toMatchObject({
      model_status: SHOPEE_MODEL_STATUS.unavailable,
      modeloAusenteEm: AGORA,
      // ⚠️ Everything the operator needs to rebuild the member survives.
      model_id: MODEL_B,
      tier_index: [1],
    });
    // ⚠️ NOTHING is deleted, on any path — both child links are still there.
    expect(db.store[`produtos/${FILHO_A}/variashopee/va-1`]).toBeDefined();
    expect(db.writes.map((w) => w.path)).toEqual([`produtos/${FILHO_B}/variashopee/vb-1`]);
  });

  it('⚠️ NEAR-MISS: um modelo que voltou limpa modeloAusenteEm em vez de deixar a marca', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1', {
      model_id: MODEL_A,
      model_status: SHOPEE_MODEL_STATUS.unavailable,
      modeloAusenteEm: AGORA - 86_400_000,
    });

    const r = await sincronizarLinksDeVariacao(
      asDb(db),
      INTEGRACAO,
      PAI,
      LINK,
      [modelo({ model_id: MODEL_A, model_status: SHOPEE_MODEL_STATUS.normal })],
      AGORA,
    );

    expect(r.atualizados).toBe(1);
    expect(r.marcados).toBe(0);
    expect(db.store[`produtos/${FILHO_A}/variashopee/va-1`]?.data).toMatchObject({
      model_status: SHOPEE_MODEL_STATUS.normal,
      modeloAusenteEm: null,
    });
  });

  it('uma leitura idêntica à armazenada escreve NADA', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1', {
      model_id: MODEL_A,
      tier_index: [0],
      model_status: SHOPEE_MODEL_STATUS.normal,
      modeloAusenteEm: null,
    });

    const r = await sincronizarLinksDeVariacao(
      asDb(db),
      INTEGRACAO,
      PAI,
      LINK,
      [modelo({ model_id: MODEL_A, tier_index: [0], model_status: SHOPEE_MODEL_STATUS.normal })],
      AGORA,
    );

    expect(r).toEqual({ atualizados: 0, marcados: 0, modelosSemFilho: [] });
    expect(db.writes).toEqual([]);
    expect(db.patches).toEqual([]);
  });

  it('um vínculo JÁ marcado não reescreve o carimbo — ele diz QUANDO o modelo sumiu', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1', {
      model_id: MODEL_A,
      model_status: SHOPEE_MODEL_STATUS.unavailable,
      modeloAusenteEm: AGORA - 604_800_000,
    });

    const r = await sincronizarLinksDeVariacao(asDb(db), INTEGRACAO, PAI, LINK, [], AGORA);

    expect(r).toEqual({ atualizados: 0, marcados: 0, modelosSemFilho: [] });
    expect(db.writes).toEqual([]);
    expect(db.store[`produtos/${FILHO_A}/variashopee/va-1`]?.data.modeloAusenteEm).toBe(
      AGORA - 604_800_000,
    );
  });

  it('⚠️ PAR/NEAR-MISS do fold de tier_index: [0,1] ≡ [0,1] não escreve; [1,0] é DISTINTO', async () => {
    const igual = new FakeDb();
    semearFilho(igual, FILHO_A);
    semearLinkFilho(igual, FILHO_A, 'va-1', { model_id: MODEL_A, tier_index: [0, 1] });
    await sincronizarLinksDeVariacao(
      asDb(igual),
      INTEGRACAO,
      PAI,
      LINK,
      [modelo({ model_id: MODEL_A, tier_index: [0, 1] })],
      AGORA,
    );
    expect(igual.writes).toEqual([]);

    // ⚠️ NEAR-MISS: `tier_index` is POSITIONAL — it names the option chosen at
    // each tier LEVEL — so a swapped pair is a different variação, not the same
    // set. A set comparison here would leave a link pointing at the wrong one.
    const trocado = new FakeDb();
    semearFilho(trocado, FILHO_A);
    semearLinkFilho(trocado, FILHO_A, 'va-1', { model_id: MODEL_A, tier_index: [0, 1] });
    await sincronizarLinksDeVariacao(
      asDb(trocado),
      INTEGRACAO,
      PAI,
      LINK,
      [modelo({ model_id: MODEL_A, tier_index: [1, 0] })],
      AGORA,
    );
    expect(trocado.store[`produtos/${FILHO_A}/variashopee/va-1`]?.data.tier_index).toEqual([1, 0]);

    // …and a PREFIX is distinct too.
    const prefixo = new FakeDb();
    semearFilho(prefixo, FILHO_A);
    semearLinkFilho(prefixo, FILHO_A, 'va-1', { model_id: MODEL_A, tier_index: [0] });
    await sincronizarLinksDeVariacao(
      asDb(prefixo),
      INTEGRACAO,
      PAI,
      LINK,
      [modelo({ model_id: MODEL_A, tier_index: [0, 0] })],
      AGORA,
    );
    expect(prefixo.store[`produtos/${FILHO_A}/variashopee/va-1`]?.data.tier_index).toEqual([0, 0]);
  });

  it('o patch de ciclo de vida é PLANO — mergeIfExists lança em objeto aninhado', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearFilho(db, FILHO_B);
    semearLinkFilho(db, FILHO_A, 'va-1', { model_id: MODEL_A, tier_index: [9] });
    semearLinkFilho(db, FILHO_B, 'vb-1', { model_id: MODEL_B });

    await sincronizarLinksDeVariacao(
      asDb(db),
      INTEGRACAO,
      PAI,
      LINK,
      [modelo({ model_id: MODEL_A, tier_index: [0] })],
      AGORA,
    );

    // ⚠️ Both write families ran (one refresh, one mark) and EVERY key is flat:
    // `mergeIfExists` is `update()` plus a NOT_FOUND narrow, and it THROWS a
    // TypeError on a nested plain object or a dotted key — because `update()`
    // REPLACES a map where set-merge deep-merges it. Adding `falhaPublicacao` or
    // `ultimaPublicacao` to a lifecycle patch is a runtime error, not a subtle
    // difference.
    expect(db.patches.length).toBe(2);
    for (const { patch } of db.patches) {
      for (const [chave, valor] of Object.entries(patch)) {
        expect(chave).not.toContain('.');
        expect(ehObjetoSimples(valor)).toBe(false);
      }
    }
  });

  it('modelosSemFilho REPORTA um modelo sem filho e não cria nada', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1', { model_id: MODEL_A });

    const r = await sincronizarLinksDeVariacao(
      asDb(db),
      INTEGRACAO,
      PAI,
      LINK,
      [
        modelo({ model_id: MODEL_A }),
        modelo({ model_id: MODEL_B, tier_index: [1], model_sku: 'CAM-M' }),
      ],
      AGORA,
    );

    expect(r.modelosSemFilho).toEqual([{ modelId: MODEL_B, tierIndex: [1], modelSku: 'CAM-M' }]);
    // Minting a child link needs a child produto — the publisher's job, not
    // this one's. NOTHING was created.
    expect(db.idsEm(`produtos/${FILHO_A}/variashopee`)).toEqual(['va-1']);
    expect(db.writes.every((w) => w.path === `produtos/${FILHO_A}/variashopee/va-1`)).toBe(true);
  });

  it('um modelo lido com model_id 0 não entra em modelosSemFilho — nada pode vinculá-lo', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1', { model_id: MODEL_A });

    const r = await sincronizarLinksDeVariacao(
      asDb(db),
      INTEGRACAO,
      PAI,
      LINK,
      [modelo({ model_id: MODEL_A }), modelo({ model_id: 0 })],
      AGORA,
    );

    // `0` is Shopee's "this item has no variation": a link carrying it binds any
    // line of any listing, so reporting it as bindable would invite exactly that.
    expect(r.modelosSemFilho).toEqual([]);
    expect(avisos).toHaveBeenCalledTimes(1);
  });

  it('um model_id repetido na leitura usa a PRIMEIRA linha e avisa', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1', { model_id: MODEL_A, tier_index: [9] });

    await sincronizarLinksDeVariacao(
      asDb(db),
      INTEGRACAO,
      PAI,
      LINK,
      [
        modelo({ model_id: MODEL_A, tier_index: [0] }),
        modelo({ model_id: MODEL_A, tier_index: [1] }),
      ],
      AGORA,
    );

    expect(db.store[`produtos/${FILHO_A}/variashopee/va-1`]?.data.tier_index).toEqual([0]);
    expect(avisos).toHaveBeenCalledTimes(1);
  });

  it('um vínculo apagado no meio não é ressuscitado — mergeIfExists responde false', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1', { model_id: MODEL_A, tier_index: [9] });
    // Gone between the READ and the WRITE — the one window `mergeIfExists`
    // exists for.
    db.falhasDeUpdate.set(`produtos/${FILHO_A}/variashopee/va-1`, grpc(5, 'NOT_FOUND'));

    const r = await sincronizarLinksDeVariacao(
      asDb(db),
      INTEGRACAO,
      PAI,
      LINK,
      [modelo({ model_id: MODEL_A, tier_index: [0] })],
      AGORA,
    );

    // Nothing is counted and nothing is recreated: `merge` would have written a
    // ghost carrying only the patch keys, under a produto that may be gone too.
    expect(r).toEqual({ atualizados: 0, marcados: 0, modelosSemFilho: [] });
    expect(db.store[`produtos/${FILHO_A}/variashopee/va-1`]?.data.tier_index).toEqual([9]);
    expect(avisos).toHaveBeenCalledTimes(1);
  });

  it('o sentinela model_id 0 ARMAZENADO nunca é marcado nem atualizado', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1', { model_id: 0 });

    const r = await sincronizarLinksDeVariacao(asDb(db), INTEGRACAO, PAI, LINK, [], AGORA);

    expect(r).toEqual({ atualizados: 0, marcados: 0, modelosSemFilho: [] });
    expect(db.writes).toEqual([]);
  });

  it('um vínculo de OUTRA conta sob o mesmo filho não é sincronizado', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-alheio', {
      model_id: MODEL_A,
      contaVariacaoShopeeOuterRef: REF_OUTRA_CONTA,
    });

    const r = await sincronizarLinksDeVariacao(asDb(db), INTEGRACAO, PAI, LINK, [], AGORA);

    expect(r).toEqual({ atualizados: 0, marcados: 0, modelosSemFilho: [] });
    expect(db.writes).toEqual([]);
    // The conta field the filter reads is the one the declared composite names.
    expect(INDICE_VARIACAO.campos[1]).toBe('contaVariacaoShopeeOuterRef');
  });
});

/* -------------------------------------------------------------------------- */
/*              (5) PER LISTING — step 19 (#1527, L8, R-12(e))                 */
/* -------------------------------------------------------------------------- */

/** The canonical ref a writer stores for a `prodshopee` doc of {@link PAI}. */
function refDaListagem(linkId: string): string {
  return `documents/produtos/${PAI}/prodshopee/${linkId}`;
}

/** The LEGACY bare encoding of the same ref — the migrated corpus carries both. */
function refNuaDaListagem(linkId: string): string {
  return `produtos/${PAI}/prodshopee/${linkId}`;
}

/**
 * A family whose two children carry the rows of TWO listings: the ordinary
 * listing `L_ORD` (models A/B) and the native kit `L_KIT` that replaced it
 * (models kit-A/kit-B) — the L8 converter's state, and a recriar's too.
 */
const L_ORD = 'link-ordinario';
const L_KIT = idDoVinculoDeKit(INTEGRACAO, ITEM_KIT);

function semearDuasListagens(db: FakeDb): void {
  semearFilho(db, FILHO_A);
  semearFilho(db, FILHO_B);
  semearLinkFilho(db, FILHO_A, 'va-ord', {
    produtoShopeeOuterRef: refDaListagem(L_ORD),
    model_id: MODEL_A,
    tier_index: [0],
  });
  semearLinkFilho(db, FILHO_B, 'vb-ord', {
    produtoShopeeOuterRef: refDaListagem(L_ORD),
    model_id: MODEL_B,
    tier_index: [1],
  });
  semearLinkFilho(db, FILHO_A, 'va-kit', {
    produtoShopeeOuterRef: refDaListagem(L_KIT),
    model_id: MODELO_KIT_A,
    tier_index: [0],
  });
  semearLinkFilho(db, FILHO_B, 'vb-kit', {
    produtoShopeeOuterRef: refDaListagem(L_KIT),
    model_id: MODELO_KIT_B,
    tier_index: [1],
  });
}

describe('lerLinksDeVariacao — por LISTAGEM', () => {
  it('⚠️ PAR: as duas grafias do ref (documents/… e a nua) são a MESMA listagem', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearFilho(db, FILHO_B);
    semearLinkFilho(db, FILHO_A, 'va-1', { produtoShopeeOuterRef: refDaListagem(LINK) });
    semearLinkFilho(db, FILHO_B, 'vb-1', {
      produtoShopeeOuterRef: refNuaDaListagem(LINK),
      model_id: MODEL_B,
    });

    const links = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI, LINK);
    expect(links.map((l) => l.linkDocId)).toEqual(['va-1', 'vb-1']);
  });

  it('⚠️ NEAR-MISS: a linha de OUTRA listagem do mesmo filho fica de fora', async () => {
    const db = new FakeDb();
    semearDuasListagens(db);

    const doKit = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI, L_KIT);
    expect(doKit.map((l) => [l.produtoId, l.linkDocId, l.modelId])).toEqual([
      [FILHO_A, 'va-kit', MODELO_KIT_A],
      [FILHO_B, 'vb-kit', MODELO_KIT_B],
    ]);
    const doOrdinario = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI, L_ORD);
    expect(doOrdinario.map((l) => l.linkDocId)).toEqual(['va-ord', 'vb-ord']);
  });

  it('null = SEM filtro — o primeiro publish, que ainda não tem vínculo, lê todas as linhas da conta', async () => {
    const db = new FakeDb();
    semearDuasListagens(db);

    const todas = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI, null);
    expect(todas.map((l) => l.linkDocId).sort()).toEqual(['va-kit', 'va-ord', 'vb-kit', 'vb-ord']);
  });

  it('uma linha com ref ILEGÍVEL é pulada com UMA linha de log — nunca entra numa listagem', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1');
    semearLinkFilho(db, FILHO_A, 'va-sem-ref', { produtoShopeeOuterRef: null, model_id: MODEL_B });
    semearLinkFilho(db, FILHO_A, 'va-ref-vazio', { produtoShopeeOuterRef: '', model_id: 7 });

    const links = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI, LINK);
    expect(links.map((l) => l.linkDocId)).toEqual(['va-1']);
    expect(avisos).toHaveBeenCalledTimes(2);
    // …and the unfiltered read still returns them: the skip is the FILTER's.
    avisos.mockClear();
    const todas = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI, null);
    expect(todas).toHaveLength(3);
    expect(avisos).not.toHaveBeenCalled();
  });
});

describe('sincronizarLinksDeVariacao — por LISTAGEM (M121)', () => {
  it('M121: reverificar o KIT não marca as linhas do anúncio comum — e vice-versa', async () => {
    // Before step 19 the sync read every row of the produto, so the kit's
    // reading (which knows nothing of models A/B) stamped the OLD listing's rows
    // `modeloAusenteEm` — and steps 12/13 then stop serving a listing that is
    // still selling (L8). One listing's reading may only touch its own rows.
    const db = new FakeDb();
    semearDuasListagens(db);
    const antesOrd = {
      a: { ...db.store[`produtos/${FILHO_A}/variashopee/va-ord`]?.data },
      b: { ...db.store[`produtos/${FILHO_B}/variashopee/vb-ord`]?.data },
    };

    const doKit = await sincronizarLinksDeVariacao(
      asDb(db),
      INTEGRACAO,
      PAI,
      L_KIT,
      [modelo({ model_id: MODELO_KIT_A, tier_index: [0] })],
      AGORA,
    );

    // Only the kit's vanished model B is marked; the ordinary rows are untouched.
    expect(doKit).toEqual({ atualizados: 0, marcados: 1, modelosSemFilho: [] });
    expect(db.writes.map((w) => w.path)).toEqual([`produtos/${FILHO_B}/variashopee/vb-kit`]);
    expect(db.store[`produtos/${FILHO_A}/variashopee/va-ord`]?.data).toEqual(antesOrd.a);
    expect(db.store[`produtos/${FILHO_B}/variashopee/vb-ord`]?.data).toEqual(antesOrd.b);

    // …and the other way round: the ORDINARY listing's reading never marks the kit.
    const db2 = new FakeDb();
    semearDuasListagens(db2);
    const doOrdinario = await sincronizarLinksDeVariacao(
      asDb(db2),
      INTEGRACAO,
      PAI,
      L_ORD,
      [modelo({ model_id: MODEL_A }), modelo({ model_id: MODEL_B, tier_index: [1] })],
      AGORA,
    );
    expect(doOrdinario).toEqual({ atualizados: 0, marcados: 0, modelosSemFilho: [] });
    expect(db2.writes).toEqual([]);
  });

  it('um modelo VIVO da listagem sem linha DESTA listagem é reportado — a linha da outra não o "cobre"', async () => {
    const db = new FakeDb();
    semearDuasListagens(db);

    const r = await sincronizarLinksDeVariacao(
      asDb(db),
      INTEGRACAO,
      PAI,
      L_KIT,
      [
        modelo({ model_id: MODELO_KIT_A, tier_index: [0] }),
        modelo({ model_id: MODELO_KIT_B, tier_index: [1] }),
        // A model id the ORDINARY listing's row carries — not this listing's row.
        modelo({ model_id: MODEL_A, tier_index: [2] }),
      ],
      AGORA,
    );
    expect(r.modelosSemFilho).toEqual([{ modelId: MODEL_A, tierIndex: [2], modelSku: null }]);
    expect(db.writes).toEqual([]);
  });

  it('uma linha com ref ilegível NUNCA é marcada, mesmo com o modelo ausente da leitura', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-sem-ref', { produtoShopeeOuterRef: null, model_id: MODEL_B });

    const r = await sincronizarLinksDeVariacao(asDb(db), INTEGRACAO, PAI, LINK, [], AGORA);
    expect(r).toEqual({ atualizados: 0, marcados: 0, modelosSemFilho: [] });
    expect(db.writes).toEqual([]);
  });
});
