import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { shopeeModelSchema, type ShopeeModel } from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE, SHOPEE_MODEL_STATUS } from '@delfrance/schemas';

import { INDICES_COMPOSTOS_SHOPEE } from '../pedidos/produtoResolve';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  lerLinksDeVariacao,
  resolverLinkPorItemId,
  resolverLinkPorProduto,
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
const AGORA = 1_757_000_000_000;

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

    const links = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI);

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

    const links = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI);
    expect(links).toHaveLength(1);
    expect(links[0]?.modelId).toBeNull();
  });

  it('um model_status que ninguém reconhece lê como null', async () => {
    const db = new FakeDb();
    semearFilho(db, FILHO_A);
    semearLinkFilho(db, FILHO_A, 'va-1', { model_status: 'MODEL_INVENTADO' });

    const links = await lerLinksDeVariacao(asDb(db), INTEGRACAO, PAI);
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
    const a = await sincronizarLinksDeVariacao(asDb(naOrdem), INTEGRACAO, PAI, lidos, AGORA);

    const trocado = new FakeDb();
    semear(trocado);
    const b = await sincronizarLinksDeVariacao(
      asDb(trocado),
      INTEGRACAO,
      PAI,
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

    const r = await sincronizarLinksDeVariacao(asDb(db), INTEGRACAO, PAI, [], AGORA);

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

    const r = await sincronizarLinksDeVariacao(asDb(db), INTEGRACAO, PAI, [], AGORA);

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

    const r = await sincronizarLinksDeVariacao(asDb(db), INTEGRACAO, PAI, [], AGORA);

    expect(r).toEqual({ atualizados: 0, marcados: 0, modelosSemFilho: [] });
    expect(db.writes).toEqual([]);
    // The conta field the filter reads is the one the declared composite names.
    expect(INDICE_VARIACAO.campos[1]).toBe('contaVariacaoShopeeOuterRef');
  });
});
