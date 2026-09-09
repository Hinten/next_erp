import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  criarResolvedorDeLinhasShopee,
  resolverProdutoDaLinhaShopee,
  type ResolvedShopeeLineProduto,
} from './produtoResolve';
import { chaveDaLinhaShopee } from './orderIds';

/* -------------------------------------------------------------------------- */
/*  Identidades de teste — nenhuma real.                                      */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const OUTRA_CONTA = 'int-2';
const REF_CONTA = `documents/integracao/${CONTA}`;
const REF_OUTRA_CONTA = `documents/integracao/${OUTRA_CONTA}`;
const ITEM_ID = 846056136;
const MODEL_ID = 12984093;

function semearProduto(db: FakeDb, id: string, over: Record<string, unknown> = {}): void {
  // ⚠️ `paiId` e `sku` SEMPRE explícitos: o FakeDb casa por igualdade estrita,
  // como o índice do Firestore — um documento sem o campo não entra no índice e
  // não pode casar `where('paiId', '==', null)`.
  db.seed(`produtos/${id}`, { sku: null, paiId: null, filhoUnicoId: null, ...over });
}

/** `produtos/{paiId}/prodshopee/{docId}` — o link do anúncio. */
function semearLinkDeAnuncio(
  db: FakeDb,
  opts: { produtoId: string; itemId?: number; conta?: string },
): void {
  db.seed(`produtos/${opts.produtoId}/prodshopee/link-1`, {
    contaProdutoShopeeOuterRef: opts.conta ?? REF_CONTA,
    item_name: 'Camiseta',
    item_id: opts.itemId ?? ITEM_ID,
  });
}

/** `produtos/{filhoId}/variashopee/{docId}` — o link da variação, sob o FILHO. */
function semearLinkDeVariacao(
  db: FakeDb,
  opts: { produtoId: string; modelId?: number; conta?: string },
): void {
  db.seed(`produtos/${opts.produtoId}/variashopee/var-1`, {
    contaVariacaoShopeeOuterRef: opts.conta ?? REF_CONTA,
    produtoShopeeOuterRef: 'documents/produtos/pai-1/prodshopee/link-1',
    model_id: opts.modelId ?? MODEL_ID,
  });
}

function resolver(
  db: FakeDb,
  over: { itemId?: number; modelId?: number | null; sku?: string | null } = {},
): Promise<ResolvedShopeeLineProduto> {
  return resolverProdutoDaLinhaShopee(asDb(db), {
    integracaoId: CONTA,
    itemId: over.itemId ?? ITEM_ID,
    modelId: over.modelId === undefined ? MODEL_ID : over.modelId,
    sku: over.sku ?? null,
  });
}

const consultasDeGrupo = (db: FakeDb, nome: string) =>
  db.consultas.filter((c) => c.fonte === `group:${nome}`);

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('degrau 1 — variashopee.model_id', () => {
  it('resolve o produto FILHO, que é o que tem estoque', async () => {
    const db = new FakeDb();
    semearProduto(db, 'pai-1');
    semearProduto(db, 'filho-1', { paiId: 'pai-1' });
    semearLinkDeAnuncio(db, { produtoId: 'pai-1' });
    semearLinkDeVariacao(db, { produtoId: 'filho-1' });

    expect(await resolver(db)).toEqual({ produtoId: 'filho-1', via: 'variashopee' });
  });

  it('a consulta compara NÚMERO, não string — o legado buscava "0"', async () => {
    const db = new FakeDb();
    semearLinkDeVariacao(db, { produtoId: 'filho-1' });
    await resolver(db);
    const [consulta] = consultasDeGrupo(db, 'variashopee');
    expect(consulta!.clausulas).toEqual([
      ['model_id', MODEL_ID],
      ['contaVariacaoShopeeOuterRef', REF_CONTA],
    ]);
    expect(typeof consulta!.clausulas[0]![1]).toBe('number');
    expect(consulta!.limite).toBe(1);
  });

  it('model_id 0 PULA o degrau — zero consultas em variashopee', async () => {
    const db = new FakeDb();
    semearProduto(db, 'pai-1');
    semearLinkDeAnuncio(db, { produtoId: 'pai-1' });
    // Um link de variação com model_id 0 existe no banco e NÃO pode ser tocado:
    // 0 é "sem variação", e buscá-lo casaria qualquer anúncio simples.
    semearLinkDeVariacao(db, { produtoId: 'filho-armadilha', modelId: 0 });

    expect(await resolver(db, { modelId: 0 })).toEqual({ produtoId: 'pai-1', via: 'prodshopee' });
    expect(consultasDeGrupo(db, 'variashopee')).toHaveLength(0);
  });

  it('model_id null PULA o degrau — zero consultas em variashopee', async () => {
    const db = new FakeDb();
    semearProduto(db, 'pai-1');
    semearLinkDeAnuncio(db, { produtoId: 'pai-1' });

    expect(await resolver(db, { modelId: null })).toEqual({
      produtoId: 'pai-1',
      via: 'prodshopee',
    });
    expect(consultasDeGrupo(db, 'variashopee')).toHaveLength(0);
  });

  it('⚠️ NEAR-MISS: um link de OUTRA conta não resolve — o filtro é do SERVIDOR', async () => {
    const db = new FakeDb();
    semearProduto(db, 'filho-alheio', { paiId: 'pai-alheio' });
    semearLinkDeVariacao(db, { produtoId: 'filho-alheio', conta: REF_OUTRA_CONTA });

    expect(await resolver(db)).toEqual({ produtoId: null, via: 'unresolved' });
    expect(consultasDeGrupo(db, 'variashopee')[0]!.clausulas).toContainEqual([
      'contaVariacaoShopeeOuterRef',
      REF_CONTA,
    ]);
  });
});

describe('degrau 2 — prodshopee.item_id', () => {
  it('resolve o item simples e leva o filtro de conta ao servidor', async () => {
    const db = new FakeDb();
    semearProduto(db, 'pai-1');
    semearLinkDeAnuncio(db, { produtoId: 'pai-1' });

    expect(await resolver(db, { modelId: 0 })).toEqual({ produtoId: 'pai-1', via: 'prodshopee' });
    const [consulta] = consultasDeGrupo(db, 'prodshopee');
    expect(consulta!.clausulas).toEqual([
      ['item_id', ITEM_ID],
      ['contaProdutoShopeeOuterRef', REF_CONTA],
    ]);
    expect(consulta!.limite).toBe(1);
  });

  it('⚠️ NEAR-MISS: um anúncio de OUTRA conta não resolve', async () => {
    const db = new FakeDb();
    semearProduto(db, 'pai-alheio');
    semearLinkDeAnuncio(db, { produtoId: 'pai-alheio', conta: REF_OUTRA_CONTA });

    expect(await resolver(db, { modelId: 0 })).toEqual({ produtoId: null, via: 'unresolved' });
  });

  it('⚠️ uma linha COM variação NÃO vincula o produto PAI quando o link da variação falta', async () => {
    // O pai de uma família de muitos não tem linhas de estoque: vincular a linha
    // nele faria `aplicarPlano` criar uma em `0 + delta` — negativa, do nada.
    // O par igual é o teste acima (model_id 0 vincula o pai).
    const db = new FakeDb();
    semearProduto(db, 'pai-1');
    semearLinkDeAnuncio(db, { produtoId: 'pai-1' });

    expect(await resolver(db, { modelId: MODEL_ID })).toEqual({
      produtoId: null,
      via: 'unresolved',
    });
  });
});

describe('degrau 3 — os degraus de SKU promovidos', () => {
  it('sem vínculo nenhum, o SKU resolve pela RAIZ e reporta o rung', async () => {
    const db = new FakeDb();
    semearProduto(db, 'raiz-1', { sku: 'CAM-P' });

    expect(await resolver(db, { modelId: 0, sku: 'CAM-P' })).toEqual({
      produtoId: 'raiz-1',
      via: 'sku-root',
    });
  });

  it('com o anúncio vinculado, o SKU é buscado ESCOPADO no pai (sku-child)', async () => {
    const db = new FakeDb();
    semearProduto(db, 'pai-1');
    semearProduto(db, 'filho-1', { paiId: 'pai-1', sku: 'CAM-P' });
    semearLinkDeAnuncio(db, { produtoId: 'pai-1' });

    expect(await resolver(db, { modelId: MODEL_ID, sku: 'CAM-P' })).toEqual({
      produtoId: 'filho-1',
      via: 'sku-child',
    });
    const consultaEscopada = db.consultas.find(
      (c) => c.fonte === 'produtos' && c.clausulas.some(([campo]) => campo === 'paiId'),
    );
    expect(consultaEscopada!.clausulas).toContainEqual(['paiId', 'pai-1']);
  });

  it('sku ambíguo NÃO vincula e diz por quê', async () => {
    const db = new FakeDb();
    semearProduto(db, 'raiz-1', { sku: 'DUPLICADO' });
    semearProduto(db, 'raiz-2', { sku: 'DUPLICADO' });

    expect(await resolver(db, { modelId: 0, sku: 'DUPLICADO' })).toEqual({
      produtoId: null,
      via: 'ambiguous-sku',
    });
  });

  it('⚠️ NEAR-MISS: um KIT nunca é resolvido pelo membro único', async () => {
    const db = new FakeDb();
    semearProduto(db, 'kit-1', { sku: 'KIT-A', filhoUnicoId: 'membro-1', ehKit: true });

    expect(await resolver(db, { modelId: 0, sku: 'KIT-A' })).toEqual({
      produtoId: 'kit-1',
      via: 'sku-root',
    });
  });

  it('o par igual do near-miss: a mesma raiz SEM ehKit cai no membro único', async () => {
    const db = new FakeDb();
    semearProduto(db, 'raiz-1', { sku: 'CAM-A', filhoUnicoId: 'membro-1', ehKit: false });

    expect(await resolver(db, { modelId: 0, sku: 'CAM-A' })).toEqual({
      produtoId: 'membro-1',
      via: 'sku-membro-unico',
    });
  });

  it('um sku vazio não consulta nada e devolve unresolved', async () => {
    const db = new FakeDb();
    const antes = db.consultas.length;
    expect(await resolver(db, { modelId: 0, sku: '' })).toEqual({
      produtoId: null,
      via: 'unresolved',
    });
    // Só a consulta do degrau 2; nenhuma dos degraus de SKU.
    expect(db.consultas.filter((c) => c.fonte === 'produtos')).toHaveLength(0);
    expect(db.consultas.length).toBeGreaterThan(antes);
  });
});

describe('o braço de kit', () => {
  it('uma linha de KIT resolve pelo prodshopee.item_id — kit_items nunca é lido aqui', async () => {
    const db = new FakeDb();
    semearProduto(db, 'kit-erp');
    semearLinkDeAnuncio(db, { produtoId: 'kit-erp' });

    expect(await resolver(db, { modelId: 0 })).toEqual({ produtoId: 'kit-erp', via: 'prodshopee' });
    // Uma única linha resolvida: nada foi explodido em componentes.
    expect(db.consultas.filter((c) => c.fonte.startsWith('group:'))).toHaveLength(1);
  });
});

describe('a memoização por (item_id, model_id)', () => {
  it('duas linhas do mesmo anúncio custam UM conjunto de consultas', async () => {
    const db = new FakeDb();
    semearProduto(db, 'pai-1');
    semearProduto(db, 'filho-1', { paiId: 'pai-1' });
    semearLinkDeAnuncio(db, { produtoId: 'pai-1' });
    semearLinkDeVariacao(db, { produtoId: 'filho-1' });

    const memo = criarResolvedorDeLinhasShopee(asDb(db), CONTA);
    const linha = { itemId: ITEM_ID, modelId: MODEL_ID, sku: null };
    const a = await memo.resolver(linha);
    const consultasApos1 = db.consultas.length;
    const b = await memo.resolver(linha);

    expect(a).toEqual(b);
    expect(db.consultas.length).toBe(consultasApos1);
  });

  it('modelos DIFERENTES do mesmo anúncio não compartilham o memo', async () => {
    const db = new FakeDb();
    semearProduto(db, 'pai-1');
    semearLinkDeAnuncio(db, { produtoId: 'pai-1' });

    const memo = criarResolvedorDeLinhasShopee(asDb(db), CONTA);
    await memo.resolver({ itemId: ITEM_ID, modelId: 1, sku: null });
    const apos1 = db.consultas.length;
    await memo.resolver({ itemId: ITEM_ID, modelId: 2, sku: null });
    expect(db.consultas.length).toBeGreaterThan(apos1);
  });

  it('guarda o VEREDITO inteiro: a segunda linha repete o mesmo motivo de falha', async () => {
    const db = new FakeDb();
    semearProduto(db, 'raiz-1', { sku: 'DUPLICADO' });
    semearProduto(db, 'raiz-2', { sku: 'DUPLICADO' });

    const memo = criarResolvedorDeLinhasShopee(asDb(db), CONTA);
    const linha = { itemId: ITEM_ID, modelId: 0, sku: 'DUPLICADO' };
    expect(await memo.resolver(linha)).toEqual({ produtoId: null, via: 'ambiguous-sku' });
    expect(await memo.resolver(linha)).toEqual({ produtoId: null, via: 'ambiguous-sku' });
  });

  it('resultados() é indexado pela chave da linha — o que o mapeador consome', async () => {
    const db = new FakeDb();
    semearProduto(db, 'pai-1');
    semearLinkDeAnuncio(db, { produtoId: 'pai-1' });

    const memo = criarResolvedorDeLinhasShopee(asDb(db), CONTA);
    await memo.resolver({ itemId: ITEM_ID, modelId: 0, sku: null });
    expect(memo.resultados().get(chaveDaLinhaShopee(ITEM_ID, 0))).toEqual({
      produtoId: 'pai-1',
      via: 'prodshopee',
    });
  });
});
