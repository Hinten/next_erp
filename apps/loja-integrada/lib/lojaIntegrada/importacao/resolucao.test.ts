/**
 * The product import's match cascade (`resolucao.ts`), on the fake Firestore.
 *
 * Every sameness the cascade relies on is pinned here as a PAIR: the equal case and the near-miss
 * that must stay distinct (root `CLAUDE.md`, "Writing something that decides whether two values are
 * the same"): the sole-member hop, the root shape, the same SKU on two contas, the targets, a
 * variation by combination, option resolution per conta, the store's repeated SKUs and the
 * one-per-conta scan. And every query the cascade sends is checked against `firestore.indexes.json`
 * (root rule 1: on Enterprise an undeclared one full-scans and bills).
 *
 * Nothing reaches the network (D17): the cascade makes no Loja Integrada call, and the GLOBAL
 * `fetch` is stubbed to throw for the whole file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALVO_IMPORTACAO_LI,
  FORMA_RAIZ_ERP,
  type GrupoComLinksLi,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
  TIPO_PRODUTO_LI,
  varianteFakePath,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { filhoLi, linhaProdutoLi, paiLi, uriOpcaoLi, vistaLi } from '../testing/produtosLi';
import { type FamiliaLi, type MontagemLi, ORIGEM_DO_FILHO_LI } from './familias';
import {
  type DepsResolucaoLi,
  type ResolucaoDaRaizLi,
  SITUACAO_DO_FILHO_LI,
  SITUACAO_DO_VINCULO_NO_PRODUTO_LI,
  VIA_DA_RAIZ_LI,
  VIA_DO_FILHO_LI,
  alvoDaRaizLi,
  escanearVinculosDoProdutoLi,
  familiaNoAlvoLi,
  formaConcordaLi,
  irmaosComMesmasOpcoesLi,
  resolverFilhosLi,
  resolverRaizLi,
  skusRepetidosNaLojaLi,
} from './resolucao';

const CONTA = 'conta-li-resolucao';
const OUTRA = 'conta-li-resolucao-2';
const GRADE = 8946;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('resolucao.test: nenhuma chamada de rede'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------- fixtures --------------------------------- */

function deps(db: FakeDb, contaId = CONTA): DepsResolucaoLi {
  return { db: asDb(db), contaId };
}

/** A store family from synthetic rows (the assembly's shape). */
function familia(raiz: DocData, filhos: readonly DocData[] = []): FamiliaLi {
  return {
    raiz: vistaLi(raiz),
    detalheDaRaiz: null,
    filhos: filhos.map((f) => ({
      linha: vistaLi(f),
      detalhe: null,
      origem: ORIGEM_DO_FILHO_LI.filhos,
    })),
    semDetalhe: [],
    pendencias: [],
  };
}

/** A store simple product with `sku`. */
function simples(id: number, sku: string | null): FamiliaLi {
  return familia(linhaProdutoLi(id, { sku: sku ?? '' }));
}

function seedProduto(db: FakeDb, id: string, campos: DocData = {}): void {
  db.seed(`produtos/${id}`, { nome: `P ${id}`, sku: null, paiId: null, ...campos });
}

/** A link doc of `conta` for store id `idLi` under produto `produtoId`, at `docId`. */
function seedVinculo(
  db: FakeDb,
  produtoId: string,
  idLi: number | string,
  conta = CONTA,
  docId = String(idLi),
): void {
  db.seed(`produtos/${produtoId}/produtolojaintegrada/${docId}`, {
    contaLojaIntegrada: `documents/integracao/${conta}`,
    id: idLi,
    sku: 's',
  });
}

/** An ERP variation of grupo `grupoId`, variante `varianteId`. */
function taxonomia(grupoId: string, varianteId: string): DocData {
  return { variacoesUid: [varianteFakePath(grupoId, varianteId)], grupoDeVariacoesUid: [grupoId] };
}

/** One grupo with this conta's link of grade `GRADE`: option id → variante ids. */
function grupo(
  id: string,
  variantes: readonly string[],
  opcoes: Record<number, readonly string[]>,
  conta = CONTA,
): GrupoComLinksLi {
  return {
    id,
    variantesIds: variantes,
    linksVariacoesli: [
      {
        name: null,
        grade_id: GRADE,
        integracaoLiId: conta,
        variationOptions: Object.entries(opcoes).map(([opcao, ids]) => ({
          li_option_id: Number(opcao),
          li_option_name: null,
          arakene_variation_id: [...ids],
        })),
      },
    ],
  };
}

const NENHUM_REPETIDO: ReadonlySet<string> = new Set();

/** A store variation with ONE option `(GRADE, opcao)`. */
function variacao(id: number, sku: string | null, opcao: number): DocData {
  return filhoLi(id, { sku: sku ?? '', variacoes: [uriOpcaoLi(GRADE, opcao)] });
}

/* --------------------------- the root cascade ----------------------------- */

describe('resolverRaizLi — rung 1, the link of THIS conta', () => {
  it('a link of this conta on a family of many ⇒ vinculado, via the link, target jaNoErp', async () => {
    const db = new FakeDb();
    seedProduto(db, 'pai', { sku: 'CAM' });
    seedProduto(db, 'f1', { paiId: 'pai' });
    seedProduto(db, 'f2', { paiId: 'pai' });
    seedVinculo(db, 'pai', 500);
    const r = await resolverRaizLi(deps(db), familia(paiLi(500, [501])), NENHUM_REPETIDO);
    expect(r).toEqual({
      tipo: SITUACAO_ERP_ITEM_LI.vinculado,
      erpId: 'pai',
      via: VIA_DA_RAIZ_LI.vinculo,
      forma: FORMA_RAIZ_ERP.familiaDeMuitas,
    });
    expect(alvoDaRaizLi(r)).toBe(ALVO_IMPORTACAO_LI.jaNoErp);
  });

  it('EQUAL: the same SKU on two contas ⇒ ONE ERP produto, each conta answered by its OWN link', async () => {
    const db = new FakeDb();
    seedProduto(db, 'r', { sku: 'X' });
    seedVinculo(db, 'r', 500, CONTA);
    seedVinculo(db, 'r', 900, OUTRA);
    const daConta = await resolverRaizLi(deps(db, CONTA), simples(500, 'X'), NENHUM_REPETIDO);
    const daOutra = await resolverRaizLi(deps(db, OUTRA), simples(900, 'X'), NENHUM_REPETIDO);
    expect(daConta).toMatchObject({ tipo: SITUACAO_ERP_ITEM_LI.vinculado, erpId: 'r' });
    expect(daOutra).toMatchObject({ tipo: SITUACAO_ERP_ITEM_LI.vinculado, erpId: 'r' });
  });

  it('⚠️ NEAR-MISS: a link of ANOTHER conta never answers rung 1 — even naming the same store id', async () => {
    const db = new FakeDb();
    seedProduto(db, 'r', { sku: 'X' });
    seedVinculo(db, 'r', 500, OUTRA);
    const r = await resolverRaizLi(deps(db, CONTA), simples(500, 'X'), NENHUM_REPETIDO);
    // Found by its SKU (not linked for this conta yet), never "vinculado" through C2's link.
    expect(r).toMatchObject({ tipo: SITUACAO_ERP_ITEM_LI.encontrado, via: VIA_DA_RAIZ_LI.skuRaiz });
  });

  it('two live owners ⇒ vinculo-ambiguo, in no target; a gone owner beside one live is no ambiguity', async () => {
    const db = new FakeDb();
    seedProduto(db, 'a', { sku: 'A' });
    seedProduto(db, 'b', { sku: 'B' });
    seedVinculo(db, 'a', 500);
    seedVinculo(db, 'b', 500);
    const ambiguo = await resolverRaizLi(deps(db), simples(500, 'A'), NENHUM_REPETIDO);
    expect(ambiguo).toEqual({
      tipo: SITUACAO_ERP_ITEM_LI.conflito,
      pendencia: PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo,
      erpIds: ['a', 'b'],
    });
    expect(alvoDaRaizLi(ambiguo)).toBeNull();

    const db2 = new FakeDb();
    seedProduto(db2, 'vivo', { sku: 'A' });
    seedVinculo(db2, 'vivo', 500);
    seedVinculo(db2, 'apagado', 500); // a link left under a produto that no longer exists
    expect(await resolverRaizLi(deps(db2), simples(500, 'A'), NENHUM_REPETIDO)).toMatchObject({
      tipo: SITUACAO_ERP_ITEM_LI.vinculado,
      erpId: 'vivo',
    });
  });

  it('an owner that is an ERP CHILD ⇒ forma-diferente (a link never sits on a child)', async () => {
    const db = new FakeDb();
    seedProduto(db, 'pai', { sku: 'P' });
    seedProduto(db, 'filho', { sku: 'F', paiId: 'pai' });
    seedVinculo(db, 'filho', 500);
    expect(await resolverRaizLi(deps(db), simples(500, 'F'), NENHUM_REPETIDO)).toEqual({
      tipo: SITUACAO_ERP_ITEM_LI.conflito,
      pendencia: PENDENCIA_IMPORTACAO_LI.formaDiferente,
      erpIds: ['filho'],
    });
  });

  it('no SKU: only rung 1 answers — a linked one is vinculado, an unlinked one is sem-sku', async () => {
    const db = new FakeDb();
    seedProduto(db, 'r');
    seedVinculo(db, 'r', 500);
    expect(await resolverRaizLi(deps(db), simples(500, null), NENHUM_REPETIDO)).toMatchObject({
      tipo: SITUACAO_ERP_ITEM_LI.vinculado,
    });
    expect(await resolverRaizLi(deps(db), simples(501, null), NENHUM_REPETIDO)).toEqual({
      tipo: SITUACAO_ERP_ITEM_LI.conflito,
      pendencia: PENDENCIA_IMPORTACAO_LI.semSku,
      erpIds: [],
    });
  });

  it('a SKU the store repeats: rung 1 still answers, the SKU rungs never do', async () => {
    const db = new FakeDb();
    seedProduto(db, 'r', { sku: 'X' });
    const repetidos = new Set(['X']);
    expect(await resolverRaizLi(deps(db), simples(500, 'X'), repetidos)).toEqual({
      tipo: SITUACAO_ERP_ITEM_LI.conflito,
      pendencia: PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja,
      erpIds: [],
    });
    seedVinculo(db, 'r', 500);
    expect(await resolverRaizLi(deps(db), simples(500, 'X'), repetidos)).toMatchObject({
      tipo: SITUACAO_ERP_ITEM_LI.vinculado,
      erpId: 'r',
    });
  });
});

describe('resolverRaizLi — rungs 2 and 3, by SKU', () => {
  it('two roots with the SKU ⇒ sku-ambiguo, in no target', async () => {
    const db = new FakeDb();
    seedProduto(db, 'a', { sku: 'X' });
    seedProduto(db, 'b', { sku: 'X' });
    const r = await resolverRaizLi(deps(db), simples(500, 'X'), NENHUM_REPETIDO);
    expect(r).toEqual({
      tipo: SITUACAO_ERP_ITEM_LI.conflito,
      pendencia: PENDENCIA_IMPORTACAO_LI.skuAmbiguo,
      erpIds: ['a', 'b'],
    });
    expect(alvoDaRaizLi(r)).toBeNull();
  });

  it('EQUAL (sole-member hop): a store simple `ABC-UN` ⇒ the ROOT whose sole member stores `ABC-UN`', async () => {
    const db = new FakeDb();
    seedProduto(db, 'raiz', { sku: 'ABC', filhoUnicoId: 'membro' });
    seedProduto(db, 'membro', { sku: 'ABC-UN', paiId: 'raiz' });
    const r = await resolverRaizLi(deps(db), simples(500, 'ABC-UN'), NENHUM_REPETIDO);
    expect(r).toEqual({
      tipo: SITUACAO_ERP_ITEM_LI.encontrado,
      erpId: 'raiz',
      via: VIA_DA_RAIZ_LI.membroUnico,
      forma: FORMA_RAIZ_ERP.familiaDeUm,
    });
    expect(alvoDaRaizLi(r)).toBe(ALVO_IMPORTACAO_LI.jaNoErp);
  });

  it('⚠️ NEAR-MISS: `ABC-UN` hitting the child of a ONE-VARIATION family (taxonomy set) ⇒ forma-diferente', async () => {
    const db = new FakeDb();
    seedProduto(db, 'raiz', { sku: 'ABC', filhoUnicoId: 'filho' });
    seedProduto(db, 'filho', { sku: 'ABC-UN', paiId: 'raiz', ...taxonomia('g', 'v') });
    expect(await resolverRaizLi(deps(db), simples(500, 'ABC-UN'), NENHUM_REPETIDO)).toEqual({
      tipo: SITUACAO_ERP_ITEM_LI.conflito,
      pendencia: PENDENCIA_IMPORTACAO_LI.formaDiferente,
      erpIds: ['filho'],
    });
  });

  it.each([' ABC-UN', 'ABC-un', 'ABC-UN ', 'ABC'])(
    '⚠️ NEAR-MISS: the store SKU %j reaches no member — exact bytes, no suffix stripped, nothing trimmed',
    async (sku) => {
      const db = new FakeDb();
      seedProduto(db, 'raiz', { sku: 'OUTRO', filhoUnicoId: 'membro' });
      seedProduto(db, 'membro', { sku: 'ABC-UN', paiId: 'raiz' });
      expect(await resolverRaizLi(deps(db), simples(500, sku), NENHUM_REPETIDO)).toEqual({
        tipo: SITUACAO_ERP_ITEM_LI.ausente,
      });
    },
  );

  it('EQUAL: an ERP ROOT whose OWN SKU is `ABC-UN` ⇒ rung 2 answers it, before any hop', async () => {
    const db = new FakeDb();
    seedProduto(db, 'raiz-un', { sku: 'ABC-UN' });
    expect(await resolverRaizLi(deps(db), simples(500, 'ABC-UN'), NENHUM_REPETIDO)).toMatchObject({
      tipo: SITUACAO_ERP_ITEM_LI.encontrado,
      erpId: 'raiz-un',
      via: VIA_DA_RAIZ_LI.skuRaiz,
    });
  });

  it('⚠️ NEAR-MISS: a store PARENT hitting a sole member, or a child its root does not point at ⇒ forma-diferente', async () => {
    const db = new FakeDb();
    seedProduto(db, 'raiz', { sku: 'ABC', filhoUnicoId: 'membro' });
    seedProduto(db, 'membro', { sku: 'ABC-UN', paiId: 'raiz' });
    seedProduto(db, 'raiz2', { sku: 'DEF' });
    seedProduto(db, 'solto', { sku: 'DEF-UN', paiId: 'raiz2' });
    expect(
      await resolverRaizLi(deps(db), familia(paiLi(500, [], { sku: 'ABC-UN' })), NENHUM_REPETIDO),
    ).toMatchObject({ pendencia: PENDENCIA_IMPORTACAO_LI.formaDiferente });
    expect(await resolverRaizLi(deps(db), simples(501, 'DEF-UN'), NENHUM_REPETIDO)).toMatchObject({
      pendencia: PENDENCIA_IMPORTACAO_LI.formaDiferente,
      erpIds: ['solto'],
    });
  });

  it('a hit with NO paiId field at all is a root rung 2 could not see', async () => {
    const db = new FakeDb();
    db.seed('produtos/legado', { nome: 'Legado', sku: 'L' });
    expect(await resolverRaizLi(deps(db), simples(500, 'L'), NENHUM_REPETIDO)).toMatchObject({
      tipo: SITUACAO_ERP_ITEM_LI.encontrado,
      erpId: 'legado',
      via: VIA_DA_RAIZ_LI.skuRaiz,
    });
  });

  it('nothing by link or SKU ⇒ ausente, target naoNoErp', async () => {
    const db = new FakeDb();
    const r = await resolverRaizLi(deps(db), simples(500, 'NOVO'), NENHUM_REPETIDO);
    expect(r).toEqual({ tipo: SITUACAO_ERP_ITEM_LI.ausente });
    expect(alvoDaRaizLi(r)).toBe(ALVO_IMPORTACAO_LI.naoNoErp);
  });
});

describe('resolverRaizLi — the ERP root shape must agree', () => {
  it('EQUAL: a store family of ONE variation ↔ an ERP one-variation family (a member WITH taxonomy)', async () => {
    const db = new FakeDb();
    seedProduto(db, 'raiz', { sku: 'CAM', filhoUnicoId: 'azul' });
    seedProduto(db, 'azul', { sku: 'CAM-AZ', paiId: 'raiz', ...taxonomia('g', 'v') });
    expect(
      await resolverRaizLi(deps(db), familia(paiLi(500, [501], { sku: 'CAM' })), NENHUM_REPETIDO),
    ).toMatchObject({
      tipo: SITUACAO_ERP_ITEM_LI.encontrado,
      erpId: 'raiz',
      forma: FORMA_RAIZ_ERP.familiaDeUmaVariacao,
    });
  });

  it('⚠️ NEAR-MISS: a store family of one variation ↔ an ERP SOLE MEMBER (no taxonomy) ⇒ forma-diferente', async () => {
    const db = new FakeDb();
    seedProduto(db, 'raiz', { sku: 'CAM', filhoUnicoId: 'membro' });
    seedProduto(db, 'membro', { sku: 'CAM-UN', paiId: 'raiz' });
    expect(
      await resolverRaizLi(deps(db), familia(paiLi(500, [501], { sku: 'CAM' })), NENHUM_REPETIDO),
    ).toEqual({
      tipo: SITUACAO_ERP_ITEM_LI.conflito,
      pendencia: PENDENCIA_IMPORTACAO_LI.formaDiferente,
      erpIds: ['raiz'],
    });
  });

  it('⚠️ NEAR-MISS: a store SIMPLE product ↔ an ERP one-variation family ⇒ forma-diferente', async () => {
    const db = new FakeDb();
    seedProduto(db, 'raiz', { sku: 'CAM', filhoUnicoId: 'azul' });
    seedProduto(db, 'azul', { sku: 'CAM-AZ', paiId: 'raiz', ...taxonomia('g', 'v') });
    expect(await resolverRaizLi(deps(db), simples(500, 'CAM'), NENHUM_REPETIDO)).toMatchObject({
      pendencia: PENDENCIA_IMPORTACAO_LI.formaDiferente,
    });
  });

  it('⚠️ NEAR-MISS: one ERP child and NO filhoUnicoId (drift) ⇒ forma-diferente, never a guess', async () => {
    const db = new FakeDb();
    seedProduto(db, 'raiz', { sku: 'CAM' });
    seedProduto(db, 'unico', { sku: 'CAM-1', paiId: 'raiz' });
    for (const f of [simples(500, 'CAM'), familia(paiLi(500, [501], { sku: 'CAM' }))]) {
      expect(await resolverRaizLi(deps(db), f, NENHUM_REPETIDO)).toMatchObject({
        pendencia: PENDENCIA_IMPORTACAO_LI.formaDiferente,
      });
    }
  });

  it('EQUAL: simple ↔ a root with no child; parent ↔ a family of many', async () => {
    const db = new FakeDb();
    seedProduto(db, 'simples', { sku: 'S' });
    seedProduto(db, 'muitos', { sku: 'M' });
    seedProduto(db, 'm1', { paiId: 'muitos' });
    seedProduto(db, 'm2', { paiId: 'muitos' });
    expect(await resolverRaizLi(deps(db), simples(500, 'S'), NENHUM_REPETIDO)).toMatchObject({
      forma: FORMA_RAIZ_ERP.raizSimples,
    });
    expect(
      await resolverRaizLi(deps(db), familia(paiLi(501, [], { sku: 'M' })), NENHUM_REPETIDO),
    ).toMatchObject({ forma: FORMA_RAIZ_ERP.familiaDeMuitas });
    // ⚠️ and the crossed pairs are both refused
    expect(
      await resolverRaizLi(deps(db), familia(paiLi(502, [], { sku: 'S' })), NENHUM_REPETIDO),
    ).toMatchObject({ pendencia: PENDENCIA_IMPORTACAO_LI.formaDiferente });
    expect(await resolverRaizLi(deps(db), simples(503, 'M'), NENHUM_REPETIDO)).toMatchObject({
      pendencia: PENDENCIA_IMPORTACAO_LI.formaDiferente,
    });
  });

  it('formaConcordaLi: simple ↔ raiz-simples | familia-de-um; parent ↔ familia-de-muitas | familia-de-uma-variacao; nothing else', () => {
    const formas = Object.values(FORMA_RAIZ_ERP);
    const aceitas = (tipo: (typeof TIPO_PRODUTO_LI)[keyof typeof TIPO_PRODUTO_LI]) =>
      formas.filter((f) => formaConcordaLi(tipo, f));
    expect(aceitas(TIPO_PRODUTO_LI.normal)).toEqual([
      FORMA_RAIZ_ERP.raizSimples,
      FORMA_RAIZ_ERP.familiaDeUm,
    ]);
    expect(aceitas(TIPO_PRODUTO_LI.atributo)).toEqual([
      FORMA_RAIZ_ERP.familiaDeUmaVariacao,
      FORMA_RAIZ_ERP.familiaDeMuitas,
    ]);
    expect(aceitas(TIPO_PRODUTO_LI.atributoOpcao)).toEqual([]);
    expect(aceitas(TIPO_PRODUTO_LI.desconhecido)).toEqual([]);
  });
});

describe('skusRepetidosNaLojaLi — exact bytes over every root and attached variation', () => {
  function montagem(familias: readonly FamiliaLi[]): MontagemLi {
    return {
      familias,
      avulsos: [],
      contagens: { reivindicacoesIgnoradas: 0, reivindicacoesDisputadas: 0, filhosIlegiveis: 0 },
    };
  }

  it('EQUAL: a parent and its own variation with one SKU, and two roots with one SKU ⇒ repeated', () => {
    const m = montagem([
      familia(paiLi(1, [2], { sku: 'X' }), [filhoLi(2, { sku: 'X' })]),
      simples(3, 'Y'),
      simples(4, 'Y'),
    ]);
    expect([...skusRepetidosNaLojaLi(m)].sort()).toEqual(['X', 'Y']);
  });

  it('⚠️ NEAR-MISS: `X`, `X ` and `x` are three SKUs; two products with NO SKU are never "repeated"', () => {
    const m = montagem([
      simples(1, 'X'),
      simples(2, 'X '),
      simples(3, 'x'),
      simples(4, null),
      simples(5, null),
    ]);
    expect([...skusRepetidosNaLojaLi(m)]).toEqual([]);
  });
});

describe('targets', () => {
  const vinculado: ResolucaoDaRaizLi = {
    tipo: SITUACAO_ERP_ITEM_LI.vinculado,
    erpId: 'r',
    via: VIA_DA_RAIZ_LI.vinculo,
    forma: FORMA_RAIZ_ERP.raizSimples,
  };
  const encontrado: ResolucaoDaRaizLi = {
    tipo: SITUACAO_ERP_ITEM_LI.encontrado,
    erpId: 'r',
    via: VIA_DA_RAIZ_LI.skuRaiz,
    forma: FORMA_RAIZ_ERP.raizSimples,
  };
  const ausente: ResolucaoDaRaizLi = { tipo: SITUACAO_ERP_ITEM_LI.ausente };
  const conflitos: ResolucaoDaRaizLi[] = [
    PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo,
    PENDENCIA_IMPORTACAO_LI.skuAmbiguo,
    PENDENCIA_IMPORTACAO_LI.formaDiferente,
    PENDENCIA_IMPORTACAO_LI.semSku,
    PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja,
  ].map((pendencia) => ({ tipo: SITUACAO_ERP_ITEM_LI.conflito, pendencia, erpIds: [] }));

  it('EQUAL: a link owner and a SKU root are jaNoErp; neither is naoNoErp', () => {
    expect(alvoDaRaizLi(vinculado)).toBe(ALVO_IMPORTACAO_LI.jaNoErp);
    expect(alvoDaRaizLi(encontrado)).toBe(ALVO_IMPORTACAO_LI.jaNoErp);
    expect(alvoDaRaizLi(ausente)).toBe(ALVO_IMPORTACAO_LI.naoNoErp);
  });

  it('⚠️ NEAR-MISS: two owners, two SKU hits, a shape mismatch, no SKU, a repeated SKU ⇒ neither target — only todos and selecionados take them', () => {
    for (const c of conflitos) {
      expect(alvoDaRaizLi(c)).toBeNull();
      expect(familiaNoAlvoLi({ alvo: ALVO_IMPORTACAO_LI.jaNoErp, selecionados: [] }, 7, c)).toBe(
        false,
      );
      expect(familiaNoAlvoLi({ alvo: ALVO_IMPORTACAO_LI.naoNoErp, selecionados: [] }, 7, c)).toBe(
        false,
      );
      expect(familiaNoAlvoLi({ alvo: ALVO_IMPORTACAO_LI.todos, selecionados: [] }, 7, c)).toBe(
        true,
      );
      expect(
        familiaNoAlvoLi({ alvo: ALVO_IMPORTACAO_LI.selecionados, selecionados: [7] }, 7, c),
      ).toBe(true);
    }
  });

  it('selecionados takes exactly the named roots, whatever their match', () => {
    const job = { alvo: ALVO_IMPORTACAO_LI.selecionados, selecionados: [7, 9] };
    expect(familiaNoAlvoLi(job, 7, ausente)).toBe(true);
    expect(familiaNoAlvoLi(job, 8, vinculado)).toBe(false);
    expect(
      familiaNoAlvoLi({ alvo: ALVO_IMPORTACAO_LI.jaNoErp, selecionados: [] }, 8, ausente),
    ).toBe(false);
    expect(
      familiaNoAlvoLi({ alvo: ALVO_IMPORTACAO_LI.naoNoErp, selecionados: [] }, 8, encontrado),
    ).toBe(false);
  });
});

/* ------------------------------ the variations ---------------------------- */

describe('resolverFilhosLi — the rungs of a matched family', () => {
  /** ERP parent `pai` with children `p` (variante v-p) and `m` (variante v-m) of grupo g. */
  function familiaErp(db: FakeDb, skus: { p?: string; m?: string } = {}): void {
    seedProduto(db, 'pai', { sku: 'CAM' });
    seedProduto(db, 'p', { sku: skus.p ?? 'CAM-P', paiId: 'pai', ...taxonomia('g', 'v-p') });
    seedProduto(db, 'm', { sku: skus.m ?? 'CAM-M', paiId: 'pai', ...taxonomia('g', 'v-m') });
  }
  const grupos = [grupo('g', ['v-p', 'v-m'], { 1: ['v-p'], 2: ['v-m'] })];
  const contexto = { grupos, skusRepetidos: NENHUM_REPETIDO };

  it('EQUAL: equal SKUs ⇒ matched by rung 2', async () => {
    const db = new FakeDb();
    familiaErp(db);
    const r = await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501]), [variacao(501, 'CAM-P', 1)]),
      'pai',
      contexto,
    );
    expect(r.filhos).toEqual([
      expect.objectContaining({
        liId: 501,
        situacao: SITUACAO_DO_FILHO_LI.casado,
        via: VIA_DO_FILHO_LI.sku,
        pendencias: [],
      }),
    ]);
    expect(r.filhos[0]?.erp?.id).toBe('p');
  });

  it('SKUs differ but the combination is equal ⇒ matched by combination + sku-diferente (both SKUs)', async () => {
    const db = new FakeDb();
    familiaErp(db, { p: 'ERP-P' });
    const r = await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501]), [variacao(501, 'LOJA-P', 1)]),
      'pai',
      contexto,
    );
    expect(r.filhos[0]).toMatchObject({
      situacao: SITUACAO_DO_FILHO_LI.casado,
      via: VIA_DO_FILHO_LI.combinacao,
      pendencias: [
        {
          codigo: PENDENCIA_IMPORTACAO_LI.skuDiferente,
          liId: 501,
          referencias: ['LOJA-P', 'ERP-P'],
        },
      ],
    });
    expect(r.filhos[0]?.erp?.id).toBe('p');
  });

  it('⚠️ NEAR-MISS: SKUs differ AND the combination differs ⇒ ausente, never a guess', async () => {
    const db = new FakeDb();
    seedProduto(db, 'pai', { sku: 'CAM' });
    seedProduto(db, 'm', { sku: 'CAM-M', paiId: 'pai', ...taxonomia('g', 'v-m') });
    const r = await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501]), [variacao(501, 'LOJA-P', 1)]),
      'pai',
      contexto,
    );
    expect(r.filhos[0]).toMatchObject({ situacao: SITUACAO_DO_FILHO_LI.ausente, erp: null });
  });

  it('its own link under the matched parent ⇒ matched; under ANOTHER family ⇒ filho-de-outra-familia', async () => {
    const db = new FakeDb();
    familiaErp(db, { p: 'X1', m: 'X2' });
    seedProduto(db, 'outro-pai', { sku: 'O' });
    seedProduto(db, 'alheio', { sku: 'O-1', paiId: 'outro-pai' });
    seedVinculo(db, 'p', 501);
    seedVinculo(db, 'alheio', 502);
    const r = await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501, 502]), [variacao(501, 'Z1', 9), variacao(502, 'Z2', 8)]),
      'pai',
      contexto,
    );
    expect(r.filhos[0]).toMatchObject({ situacao: 'casado', via: VIA_DO_FILHO_LI.vinculo });
    expect(r.filhos[1]).toMatchObject({
      situacao: SITUACAO_DO_FILHO_LI.conflito,
      pendencias: [
        { codigo: PENDENCIA_IMPORTACAO_LI.filhoDeOutraFamilia, referencias: ['alheio'] },
      ],
    });
  });

  it('two ERP children with the SKU ⇒ sku-ambiguo', async () => {
    const db = new FakeDb();
    familiaErp(db, { p: 'DUP', m: 'DUP' });
    const r = await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501]), [variacao(501, 'DUP', 7)]),
      'pai',
      contexto,
    );
    expect(r.filhos[0]).toMatchObject({
      situacao: SITUACAO_DO_FILHO_LI.conflito,
      pendencias: [{ codigo: PENDENCIA_IMPORTACAO_LI.skuAmbiguo, referencias: ['m', 'p'] }],
    });
  });

  it('an option standing for TWO variantes ⇒ variacao-ambigua, no combination match', async () => {
    const db = new FakeDb();
    familiaErp(db, { p: 'E1', m: 'E2' });
    const ambiguo = [grupo('g', ['v-p', 'v-m'], { 1: ['v-p', 'v-m'] })];
    const r = await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501]), [variacao(501, 'L1', 1)]),
      'pai',
      { grupos: ambiguo, skusRepetidos: NENHUM_REPETIDO },
    );
    expect(r.filhos[0]).toMatchObject({
      situacao: SITUACAO_DO_FILHO_LI.ausente,
      pendencias: [
        { codigo: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua, referencias: [`${String(GRADE)}/1`] },
      ],
    });
  });

  it('⚠️ NEAR-MISS (option resolution per conta): the same option linked for ANOTHER conta only ⇒ not resolved here', async () => {
    const db = new FakeDb();
    familiaErp(db, { p: 'E1' });
    const daOutra = [grupo('g', ['v-p', 'v-m'], { 1: ['v-p'] }, OUTRA)];
    const r = await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501]), [variacao(501, 'L1', 1)]),
      'pai',
      { grupos: daOutra, skusRepetidos: NENHUM_REPETIDO },
    );
    expect(r.filhos[0]).toMatchObject({
      situacao: SITUACAO_DO_FILHO_LI.ausente,
      pendencias: [{ codigo: PENDENCIA_IMPORTACAO_LI.gradeSemVinculo }],
    });
    // EQUAL: the same grupos linked for THIS conta resolve it.
    const r2 = await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501]), [variacao(501, 'L1', 1)]),
      'pai',
      contexto,
    );
    expect(r2.filhos[0]).toMatchObject({ situacao: 'casado', via: VIA_DO_FILHO_LI.combinacao });
  });

  it('two store siblings with ONE option set ⇒ no variation of the family matches by combination; rung 2 still does', async () => {
    const db = new FakeDb();
    familiaErp(db, { p: 'CAM-P', m: 'E2' });
    const r = await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501, 502, 503]), [
        variacao(501, 'CAM-P', 1),
        variacao(502, 'OUTRO', 1),
        variacao(503, 'L3', 2),
      ]),
      'pai',
      contexto,
    );
    expect(r.combinacaoAmbiguaNaLoja).toBe(true);
    expect(r.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua, liId: 501, referencias: [] },
      { codigo: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua, liId: 502, referencias: [] },
    ]);
    expect(r.filhos.map((f) => [f.liId, f.situacao, f.via])).toEqual([
      [501, 'casado', 'sku'],
      [502, 'ausente', null],
      // 503 has its own option set, but the FAMILY is ambiguous: no combination match.
      [503, 'ausente', null],
    ]);
  });

  it('⚠️ NEAR-MISS: siblings whose option sets differ in one option are not "the same set"', () => {
    const f = familia(paiLi(500, [501, 502]), [
      filhoLi(501, { variacoes: [uriOpcaoLi(1, 10), uriOpcaoLi(2, 20)] }),
      filhoLi(502, { variacoes: [uriOpcaoLi(2, 20), uriOpcaoLi(1, 11)] }),
    ]);
    expect(irmaosComMesmasOpcoesLi(f)).toEqual([]);
    const g = familia(paiLi(500, [501, 502]), [
      filhoLi(501, { variacoes: [uriOpcaoLi(1, 10), uriOpcaoLi(2, 20)] }),
      filhoLi(502, { variacoes: [uriOpcaoLi(2, 20), uriOpcaoLi(1, 10)] }),
    ]);
    // EQUAL: the same set in another order.
    expect(irmaosComMesmasOpcoesLi(g)).toEqual([501, 502]);
  });

  it('two store variations landing on ONE ERP child ⇒ both refused, whichever came first', async () => {
    const db = new FakeDb();
    familiaErp(db, { p: 'CAM-P', m: 'E2' });
    const r = await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501, 502]), [
        variacao(501, 'CAM-P', 2), // by SKU onto `p`
        variacao(502, 'L2', 1), // by combination onto `p`
      ]),
      'pai',
      contexto,
    );
    expect(r.filhos.map((f) => [f.liId, f.situacao, f.pendencias.map((p) => p.codigo)])).toEqual([
      [501, 'conflito', [PENDENCIA_IMPORTACAO_LI.variacaoAmbigua]],
      [502, 'conflito', [PENDENCIA_IMPORTACAO_LI.variacaoAmbigua]],
    ]);
  });

  it('no SKU ⇒ sem-sku (no link can be written); a SKU the store repeats skips rung 2 only', async () => {
    const db = new FakeDb();
    familiaErp(db, { p: 'REP', m: 'E2' });
    const r = await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501, 502]), [variacao(501, null, 2), variacao(502, 'REP', 1)]),
      'pai',
      { grupos, skusRepetidos: new Set(['REP']) },
    );
    expect(r.filhos[0]).toMatchObject({
      situacao: SITUACAO_DO_FILHO_LI.conflito,
      pendencias: [{ codigo: PENDENCIA_IMPORTACAO_LI.semSku }],
    });
    // Not matched by its (repeated) SKU — by its combination, with the repetition reported.
    expect(r.filhos[1]).toMatchObject({
      situacao: 'casado',
      via: VIA_DO_FILHO_LI.combinacao,
      pendencias: [{ codigo: PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja }],
    });
  });
});

/* -------------------------- the one-per-conta scan ------------------------- */

describe('escanearVinculosDoProdutoLi — one store product per conta per ERP produto', () => {
  it('nothing ⇒ livre; this conta’s link for the id ⇒ proprio (the doc at String(id) first)', async () => {
    const db = new FakeDb();
    seedProduto(db, 'r');
    expect(await escanearVinculosDoProdutoLi(deps(db), 'r', 500)).toEqual({
      situacao: SITUACAO_DO_VINCULO_NO_PRODUTO_LI.livre,
      docIds: [],
      outrosIdsLi: [],
    });
    seedVinculo(db, 'r', 500, CONTA, 'auto-id');
    seedVinculo(db, 'r', 500);
    seedVinculo(db, 'r', 777, OUTRA); // another conta's link: none of this conta's business
    expect(await escanearVinculosDoProdutoLi(deps(db), 'r', 500)).toMatchObject({
      situacao: SITUACAO_DO_VINCULO_NO_PRODUTO_LI.proprio,
      docIds: ['500', 'auto-id'],
    });
  });

  it('⚠️ NEAR-MISS: a link of this conta with ANOTHER id ⇒ vinculado-a-outro (never re-pointed)', async () => {
    const db = new FakeDb();
    seedVinculo(db, 'r', 600);
    expect(await escanearVinculosDoProdutoLi(deps(db), 'r', 500)).toEqual({
      situacao: SITUACAO_DO_VINCULO_NO_PRODUTO_LI.vinculadoAOutro,
      docIds: ['600'],
      outrosIdsLi: [600],
    });
  });

  it('⚠️ NEAR-MISS: a TEXT id of this conta ⇒ vinculo-ilegivel, never proprio', async () => {
    const db = new FakeDb();
    seedVinculo(db, 'r', '500');
    expect(await escanearVinculosDoProdutoLi(deps(db), 'r', 500)).toMatchObject({
      situacao: SITUACAO_DO_VINCULO_NO_PRODUTO_LI.vinculoIlegivel,
      docIds: ['500'],
    });
  });

  it('another conta’s document AT our doc id ⇒ vinculo-ambiguo', async () => {
    const db = new FakeDb();
    seedVinculo(db, 'r', 500, OUTRA);
    expect(await escanearVinculosDoProdutoLi(deps(db), 'r', 500)).toMatchObject({
      situacao: SITUACAO_DO_VINCULO_NO_PRODUTO_LI.vinculoAmbiguo,
      docIds: ['500'],
    });
  });

  it('reads the produto’s OWN subcollection, whole and unfiltered (no index involved)', async () => {
    const db = new FakeDb();
    await escanearVinculosDoProdutoLi(deps(db), 'r', 500);
    expect(db.consultas).toEqual([
      {
        colecao: 'produtos/r/produtolojaintegrada',
        filtros: [],
        ordens: [],
        limite: null,
        apos: null,
      },
    ]);
  });
});

/* ------------------------------ the indexes -------------------------------- */

describe('every query the cascade sends rides a declared index (root rule 1)', () => {
  interface IndiceDeclarado {
    readonly collectionGroup: string;
    readonly queryScope: string;
    readonly fields: readonly { readonly fieldPath: string }[];
  }
  function indices(): IndiceDeclarado[] {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) dir = dirname(dir);
    return (
      JSON.parse(readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8')) as {
        indexes: IndiceDeclarado[];
      }
    ).indexes;
  }

  it('the root rungs, the shape reads and the variation rungs', async () => {
    const db = new FakeDb();
    seedProduto(db, 'raiz', { sku: 'ABC', filhoUnicoId: 'membro' });
    seedProduto(db, 'membro', { sku: 'ABC-UN', paiId: 'raiz' });
    seedProduto(db, 'pai', { sku: 'CAM' });
    seedProduto(db, 'p', { sku: 'CAM-P', paiId: 'pai', ...taxonomia('g', 'v-p') });
    seedProduto(db, 'm', { sku: 'CAM-M', paiId: 'pai', ...taxonomia('g', 'v-m') });
    seedVinculo(db, 'pai', 500);
    await resolverRaizLi(deps(db), familia(paiLi(500, [501])), NENHUM_REPETIDO);
    await resolverRaizLi(deps(db), simples(600, 'ABC-UN'), NENHUM_REPETIDO);
    await resolverRaizLi(deps(db), simples(601, 'CAM'), NENHUM_REPETIDO);
    await resolverFilhosLi(
      deps(db),
      familia(paiLi(500, [501]), [variacao(501, 'CAM-P', 1)]),
      'pai',
      { grupos: [grupo('g', ['v-p'], { 1: ['v-p'] })], skusRepetidos: NENHUM_REPETIDO },
    );

    const declarados = indices();
    const filtradas = db.consultas.filter((c) => c.filtros.length > 0);
    // Anti-vacuity: rung 1, rung 2, rung 3, the two-child shape read and the children read.
    expect(filtradas.map((c) => c.filtros.map(([campo]) => campo).join('+'))).toEqual(
      expect.arrayContaining(['contaLojaIntegrada+id', 'sku+paiId', 'sku', 'paiId']),
    );
    for (const c of filtradas) {
      // Equality filters only: an index serves them when its leading fields ARE those fields.
      expect(c.filtros.every(([, op]) => op === '==' || op === 'in')).toBe(true);
      expect(c.ordens).toEqual([]);
      const campos = c.filtros.map(([campo]) => campo).sort();
      const servida = declarados.some(
        (i) =>
          i.collectionGroup === (c.grupo === true ? c.colecao : c.colecao.split('/').at(-1)) &&
          i.queryScope === (c.grupo === true ? 'COLLECTION_GROUP' : 'COLLECTION') &&
          JSON.stringify(
            i.fields
              .slice(0, campos.length)
              .map((f) => f.fieldPath)
              .sort(),
          ) === JSON.stringify(campos),
      );
      expect(servida, JSON.stringify(c)).toBe(true);
    }
  });
});
