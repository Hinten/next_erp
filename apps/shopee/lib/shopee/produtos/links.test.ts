import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  shopeeItemBaseInfoRowSchema,
  shopeeKitItemSchema,
  shopeeModelSchema,
  shopeeTaxInfoSchema,
  type ShopeeKitItem,
  type ShopeeModel,
} from '@delfrance/integrations-shopee';
import {
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';
import { importacaoShopeeOptionsSchema } from '@delfrance/schemas';

import { idDaVariacaoDeKit, idDoVinculoDeKit } from '../kits/idsKit';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { importarAnuncioShopee } from './importarAnuncio';
import type { ImportarKitShopeeDeps, ItemLido } from './itemLido';
import { importarKitShopee } from './kitShopee';
import { aplicarLinkDaListagem, aplicarLinkDaVariacao } from './links';
import { caminhoDoLinkDaListagem, dadosLinkListagem, dadosLinkVariacao } from './mapeamento';
import type { EscritaDeLink } from './planoImportacao';
import { idDoFilhoPlanejado, idDoPaiPlanejado } from './resolveProduto';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;
const INTEGRACAO = 'int-1';
const PAI = 'prod-pai';
const FILHO = 'prod-filho';
const AGORA = 1_757_000_000_000;
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;

function item(parcial: Record<string, unknown> = {}, taxInfo: unknown = null): ItemLido {
  return {
    base: shopeeItemBaseInfoRowSchema.parse({
      item_id: ITEM_ID,
      item_name: 'Camiseta Básica',
      ...parcial,
    }),
    models: null,
    taxInfo: taxInfo === null ? null : shopeeTaxInfoSchema.parse(taxInfo),
    kit: null,
    itemId: ITEM_ID,
  };
}

function modelo(parcial: Record<string, unknown> = {}): ShopeeModel {
  return shopeeModelSchema.parse({ model_id: MODEL_ID, ...parcial });
}

function escritaPai(
  entrada: ItemLido,
  existente: { id: string; raw: Record<string, unknown> } | null = null,
): EscritaDeLink {
  return {
    acao: existente === null ? 'add' : 'merge',
    docId: existente?.id ?? null,
    dados: dadosLinkListagem(entrada, existente?.raw ?? null, INTEGRACAO, AGORA),
  };
}

/** A stored `prodshopee` document, as the migrated corpus carries it. */
function semearLinkPai(db: FakeDb, id: string, extra: Record<string, unknown> = {}): void {
  db.seed(`produtos/${PAI}/prodshopee/${id}`, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_name: 'Camiseta Básica',
    item_id: ITEM_ID,
    ...extra,
  });
}

function lerDoc(db: FakeDb, path: string): Record<string, unknown> {
  const doc = db.store[path];
  if (doc === undefined) throw new Error(`fixture: nenhum documento em ${path}`);
  return doc.data;
}

/* ------------------------------- 1. add vs merge -------------------------- */

describe('aplicarLinkDaListagem', () => {
  it('sem vínculo resolvido faz um `add` em um id automático e devolve esse id', async () => {
    const db = new FakeDb();
    const id = await aplicarLinkDaListagem(asDb(db), PAI, escritaPai(item()));

    expect(id).toMatch(/^auto-/);
    expect(db.idsEm(`produtos/${PAI}/prodshopee`)).toEqual([id]);
    expect(lerDoc(db, `produtos/${PAI}/prodshopee/${id}`)).toMatchObject({
      item_id: ITEM_ID,
      contaProdutoShopeeOuterRef: REF_CONTA,
    });
  });

  it('com vínculo resolvido faz `merge` no MESMO documento — nunca um segundo', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-1', { description: 'velha' });

    const id = await aplicarLinkDaListagem(
      asDb(db),
      PAI,
      escritaPai(item({ description: 'nova' }), {
        id: 'link-1',
        raw: lerDoc(db, `produtos/${PAI}/prodshopee/link-1`),
      }),
    );

    expect(id).toBe('link-1');
    expect(db.idsEm(`produtos/${PAI}/prodshopee`)).toEqual(['link-1']);
    expect(lerDoc(db, `produtos/${PAI}/prodshopee/link-1`).description).toBe('nova');
  });

  it('`item_id` chega ao servidor como NÚMERO — uma string não casaria com nada', async () => {
    const db = new FakeDb();
    const id = await aplicarLinkDaListagem(asDb(db), PAI, escritaPai(item()));
    expect(typeof lerDoc(db, `produtos/${PAI}/prodshopee/${id}`).item_id).toBe('number');
  });
});

/* ------------------------- 2. os três renomes de container ---------------- */

describe('aplicarLinkDaListagem — os três renomes de container', () => {
  it('`attribute_list` é gravado como `attributes` — e ⛔ a outra grafia NÃO chega', async () => {
    const db = new FakeDb();
    const atributos = [
      { attribute_id: 100, original_attribute_name: 'Material', attribute_value_list: [] },
    ];
    const id = await aplicarLinkDaListagem(
      asDb(db),
      PAI,
      escritaPai(item({ attribute_list: atributos })),
    );

    const doc = lerDoc(db, `produtos/${PAI}/prodshopee/${id}`);
    expect(doc.attributes).toMatchObject([{ attribute_id: 100 }]);
    expect('attribute_list' in doc).toBe(false);
  });

  it('`wholesales` é gravado como `wholesale` — ⛔ e `unit_price` NÃO vira `unit`', async () => {
    const db = new FakeDb();
    const id = await aplicarLinkDaListagem(
      asDb(db),
      PAI,
      escritaPai(item({ wholesales: [{ min_count: 2, max_count: 5, unit_price: 9.9 }] })),
    );

    const doc = lerDoc(db, `produtos/${PAI}/prodshopee/${id}`);
    expect(doc.wholesale).toMatchObject([{ min_count: 2, unit_price: 9.9 }]);
    expect('wholesales' in doc).toBe(false);
    const [faixa] = doc.wholesale as Record<string, unknown>[];
    expect('unit' in (faixa ?? {})).toBe(false);
  });

  it('`brand.brand_id` é DESEMBRULHADO em `brand_id` — e `0` é um valor, não uma ausência', async () => {
    const db = new FakeDb();
    const id = await aplicarLinkDaListagem(
      asDb(db),
      PAI,
      escritaPai(item({ brand: { brand_id: 0, original_brand_name: 'No brand' } })),
    );

    const doc = lerDoc(db, `produtos/${PAI}/prodshopee/${id}`);
    expect(doc.brand_id).toBe(0);
    expect('brand' in doc).toBe(false);
  });
});

/* ------------------------------ 3. tax_info ------------------------------- */

describe('aplicarLinkDaListagem — tax_info', () => {
  it('grava o bloco fiscal VERBATIM, todo valor uma STRING', async () => {
    const db = new FakeDb();
    const id = await aplicarLinkDaListagem(
      asDb(db),
      PAI,
      escritaPai(item({}, { ncm: '00', origin: '0', cest: '0000000' })),
    );

    const doc = lerDoc(db, `produtos/${PAI}/prodshopee/${id}`);
    expect(doc.tax_info).toMatchObject({ ncm: '00', origin: '0', cest: '0000000' });
    const fiscal = doc.tax_info as Record<string, unknown>;
    expect(typeof fiscal.ncm).toBe('string');
    expect(typeof fiscal.origin).toBe('string');
    expect(typeof fiscal.cest).toBe('string');
  });

  it('⛔ um `tax_info` AUSENTE não apaga o bloco armazenado', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-1', { tax_info: { ncm: '61091000' } });

    await aplicarLinkDaListagem(
      asDb(db),
      PAI,
      escritaPai(item(), { id: 'link-1', raw: lerDoc(db, `produtos/${PAI}/prodshopee/link-1`) }),
    );

    expect(lerDoc(db, `produtos/${PAI}/prodshopee/link-1`).tax_info).toMatchObject({
      ncm: '61091000',
    });
  });
});

/* ---------------------- 4. o que o import NUNCA escreve ------------------- */

describe('aplicarLinkDaListagem — os quatro campos que o import nunca autoriza', () => {
  it('não escreve `violations`, `complaint_policy`, `sku` nem `image`', async () => {
    const db = new FakeDb();
    const escrita = escritaPai(
      item({
        item_sku: 'SKU-PAI',
        image: { image_url_list: ['https://cf.shopee.com.br/file/a'], image_id_list: ['a'] },
      }),
    );

    for (const chave of ['violations', 'complaint_policy', 'sku', 'image', 'image_id_list']) {
      expect(chave in escrita.dados).toBe(false);
    }

    const id = await aplicarLinkDaListagem(asDb(db), PAI, escrita);
    const doc = lerDoc(db, `produtos/${PAI}/prodshopee/${id}`);
    // `violations` / `complaint_policy` são DEFAULTS do schema, não autoria.
    expect(doc.violations).toBeNull();
    expect(doc.complaint_policy).toBeNull();
    expect('sku' in doc).toBe(false);
    expect('image' in doc).toBe(false);
  });

  it('⛔ um `violations` ARMAZENADO (dono: o push de item banido) sobrevive ao merge', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-1', {
      violations: [{ violation_reason: 'produto proibido' }],
      item_status: 'UNLIST',
    });

    await aplicarLinkDaListagem(
      asDb(db),
      PAI,
      escritaPai(item({ item_status: 'NORMAL' }), {
        id: 'link-1',
        raw: lerDoc(db, `produtos/${PAI}/prodshopee/link-1`),
      }),
    );

    const doc = lerDoc(db, `produtos/${PAI}/prodshopee/link-1`);
    expect(doc.violations).toMatchObject([{ violation_reason: 'produto proibido' }]);
    // "last read wins" — o status vem da leitura mais recente.
    expect(doc.item_status).toBe('NORMAL');
  });

  it('a referência da conta é RECARIMBADA depois do spread — um ref que derivou se cura', async () => {
    const db = new FakeDb();
    semearLinkPai(db, 'link-1', { contaProdutoShopeeOuterRef: 'documents/integracao/outra-conta' });

    await aplicarLinkDaListagem(
      asDb(db),
      PAI,
      escritaPai(item(), { id: 'link-1', raw: lerDoc(db, `produtos/${PAI}/prodshopee/link-1`) }),
    );

    expect(lerDoc(db, `produtos/${PAI}/prodshopee/link-1`).contaProdutoShopeeOuterRef).toBe(
      REF_CONTA,
    );
  });
});

/* ------------------------- 5. o link da variação -------------------------- */

describe('aplicarLinkDaVariacao', () => {
  function escritaFilho(
    m: ShopeeModel = modelo(),
    existente: { id: string; raw: Record<string, unknown> } | null = null,
  ): EscritaDeLink {
    const dados = dadosLinkVariacao(m, null, existente?.raw ?? null, INTEGRACAO);
    if (dados === null) throw new Error('fixture: o modelo não produz link');
    return { acao: existente === null ? 'add' : 'merge', docId: existente?.id ?? null, dados };
  }

  it('`produtoShopeeOuterRef` é o caminho completo do documento de VÍNCULO', async () => {
    const db = new FakeDb();
    await aplicarLinkDaVariacao(asDb(db), FILHO, escritaFilho(), PAI, 'link-1');

    const [id] = db.idsEm(`produtos/${FILHO}/variashopee`);
    const doc = lerDoc(db, `produtos/${FILHO}/variashopee/${String(id)}`);
    expect(doc.produtoShopeeOuterRef).toBe(`documents/produtos/${PAI}/prodshopee/link-1`);
  });

  it('⛔ NÃO é o caminho do PRODUTO pai — o vínculo aponta para o documento, não para o produto', async () => {
    const db = new FakeDb();
    await aplicarLinkDaVariacao(asDb(db), FILHO, escritaFilho(), PAI, 'link-1');

    const [id] = db.idsEm(`produtos/${FILHO}/variashopee`);
    const doc = lerDoc(db, `produtos/${FILHO}/variashopee/${String(id)}`);
    expect(doc.produtoShopeeOuterRef).not.toBe(`documents/produtos/${PAI}`);
    expect(caminhoDoLinkDaListagem(PAI, 'link-1')).toBe(`produtos/${PAI}/prodshopee/link-1`);
  });

  it('⛔ um `produtoShopeeOuterRef` esquecido LANÇA — o campo é obrigatório e não anulável', async () => {
    const db = new FakeDb();
    const dados = dadosLinkVariacao(modelo(), null, null, INTEGRACAO);
    expect(dados).not.toBeNull();
    expect('produtoShopeeOuterRef' in (dados ?? {})).toBe(false);

    await expect(
      // A escrita CRUA, sem o carimbo que `aplicarLinkDaVariacao` acrescenta.
      variacaoSemCarimbo(db, dados ?? {}),
    ).rejects.toThrow();
    expect(db.idsEm(`produtos/${FILHO}/variashopee`)).toEqual([]);
  });

  it('`merge` grava no vínculo resolvido e `add` cria um novo', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${FILHO}/variashopee/v-1`, {
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: `documents/produtos/${PAI}/prodshopee/link-1`,
      model_id: MODEL_ID,
      tier_index: [0],
    });

    await aplicarLinkDaVariacao(
      asDb(db),
      FILHO,
      escritaFilho(modelo({ tier_index: [1] }), {
        id: 'v-1',
        raw: lerDoc(db, `produtos/${FILHO}/variashopee/v-1`),
      }),
      PAI,
      'link-1',
    );

    expect(db.idsEm(`produtos/${FILHO}/variashopee`)).toEqual(['v-1']);
    expect(lerDoc(db, `produtos/${FILHO}/variashopee/v-1`).tier_index).toEqual([1]);
  });

  it('`promotion_id` NUNCA é carimbado — um documento novo fica com o default do schema', async () => {
    const db = new FakeDb();
    const escrita = escritaFilho();
    expect('promotion_id' in escrita.dados).toBe(false);

    await aplicarLinkDaVariacao(asDb(db), FILHO, escrita, PAI, 'link-1');
    const [id] = db.idsEm(`produtos/${FILHO}/variashopee`);
    expect(lerDoc(db, `produtos/${FILHO}/variashopee/${String(id)}`).promotion_id).toBeNull();
  });

  it('⛔ um `promotion_id` ARMAZENADO sobrevive — o spread o carrega, nada o reescreve', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${FILHO}/variashopee/v-1`, {
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: `documents/produtos/${PAI}/prodshopee/link-1`,
      model_id: MODEL_ID,
      promotion_id: 987654,
    });

    await aplicarLinkDaVariacao(
      asDb(db),
      FILHO,
      escritaFilho(modelo(), {
        id: 'v-1',
        raw: lerDoc(db, `produtos/${FILHO}/variashopee/v-1`),
      }),
      PAI,
      'link-1',
    );

    expect(lerDoc(db, `produtos/${FILHO}/variashopee/v-1`).promotion_id).toBe(987654);
  });

  it('a referência da conta é recarimbada depois do spread, como no vínculo do pai', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${FILHO}/variashopee/v-1`, {
      contaVariacaoShopeeOuterRef: 'documents/integracao/outra-conta',
      produtoShopeeOuterRef: `documents/produtos/${PAI}/prodshopee/link-1`,
      model_id: MODEL_ID,
    });

    await aplicarLinkDaVariacao(
      asDb(db),
      FILHO,
      escritaFilho(modelo(), {
        id: 'v-1',
        raw: lerDoc(db, `produtos/${FILHO}/variashopee/v-1`),
      }),
      PAI,
      'link-1',
    );

    expect(lerDoc(db, `produtos/${FILHO}/variashopee/v-1`).contaVariacaoShopeeOuterRef).toBe(
      REF_CONTA,
    );
  });

  it('⛔ um `model_id: 0` não produz escrita NENHUMA — não há link a gravar', () => {
    expect(dadosLinkVariacao(modelo({ model_id: 0 }), null, null, INTEGRACAO)).toBeNull();
  });
});

/**
 * A escrita do vínculo da variação SEM o carimbo do pai — o que aconteceria se
 * alguém chamasse o handle diretamente. Existe só para o teste ⛔ acima.
 */
function variacaoSemCarimbo(db: FakeDb, dados: Record<string, unknown>): Promise<unknown> {
  return variacaoShopeeLinkCollection.add(asDb(db), { produtoId: FILHO }, dados);
}

/* -------- 3. passo 19: o kit nativo, a ÚNICA exceção ao id nunca derivado ------- */

/** Papéis do passo 19 (D1): o kit e o seu modelo; o componente é um anúncio comum. */
const KIT_ITEM = 2500139870;
const KIT_MODELO = 2000458820;
const COMPONENTE = 2500139872;
const VINCULO_DO_KIT = idDoVinculoDeKit(INTEGRACAO, KIT_ITEM);

function kitDoPasso19(): ShopeeKitItem {
  return shopeeKitItemSchema.parse({
    item_id: KIT_ITEM,
    item_name: 'Kit Passo 19',
    item_sku: 'KIT-19',
    model_list: [
      {
        model_id: KIT_MODELO,
        model_sku: 'KIT-19-UN',
        original_price: 50,
        component_list: [{ component_item_id: COMPONENTE, component_model_id: 0, quantity: 2 }],
      },
    ],
  });
}

function entradaDoKit(): ItemLido {
  return {
    base: shopeeItemBaseInfoRowSchema.parse({ item_id: KIT_ITEM, tag: { kit: true } }),
    models: null,
    taxInfo: null,
    kit: kitDoPasso19(),
    itemId: KIT_ITEM,
  };
}

function depsDoImport(db: FakeDb): ImportarKitShopeeDeps {
  return {
    db: asDb(db),
    increment,
    integracaoId: INTEGRACAO,
    tabelaNormalOuterRef: null,
    tabelaPromocionalOuterRef: null,
    depositoOuterRef: null,
    options: importacaoShopeeOptionsSchema.parse({ importarFotos: false }),
    nowMs: AGORA,
  };
}

/** O componente, um produto simples ligado pelo `prodshopee` do anúncio dele. */
function semearComponente(db: FakeDb): void {
  db.seed('produtos/comp', { nome: 'Componente', sku: 'COMP', paiId: null });
  db.seed(`produtos/comp/prodshopee/vinc-comp`, {
    item_id: COMPONENTE,
    contaProdutoShopeeOuterRef: REF_CONTA,
  });
}

/** A ESCRITA do vínculo que a criação do kit faz logo depois do `add_kit_item` (R-k, tier 0). */
function escritaDaCriacao(db: FakeDb, produtoId: string): Promise<void> {
  return produtoShopeeLinkCollection.merge(asDb(db), { produtoId }, VINCULO_DO_KIT, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_id: KIT_ITEM,
    item_name: 'Kit Passo 19',
    kitNativo: true,
  });
}

/** Todo `prodshopee` do banco que nomeia o kit — sob QUALQUER produto. */
function vinculosDoKit(db: FakeDb): string[] {
  return Object.entries(db.store)
    .filter(
      ([p, d]) =>
        /\/prodshopee\/[^/]+$/.test(p) && (d.data as { item_id?: unknown }).item_id === KIT_ITEM,
    )
    .map(([p]) => p);
}

describe('passo 19 — o vínculo NOVO de um kit nasce no id derivado (M65)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('um kit sem vínculo importado ⇒ o `prodshopee` mora em `idDoVinculoDeKit(int-1, 2500139870)`', async () => {
    const db = new FakeDb();
    semearComponente(db);

    await importarKitShopee(depsDoImport(db), entradaDoKit());

    const pai = idDoPaiPlanejado(INTEGRACAO, KIT_ITEM);
    expect(db.idsEm(`produtos/${pai}/prodshopee`)).toEqual([VINCULO_DO_KIT]);
    expect(VINCULO_DO_KIT).toBe('0d36512cfa0fe35978c32b283eb23e4506cea04af4781e2bcedc157f96765285');
  });

  it('a escrita da CRIAÇÃO e depois o import ⇒ UM `prodshopee`', async () => {
    const db = new FakeDb();
    semearComponente(db);
    db.seed('produtos/kit-k', { nome: 'Kit', sku: 'KIT-19', paiId: null, ehKit: true });
    await escritaDaCriacao(db, 'kit-k');

    await importarKitShopee(depsDoImport(db), entradaDoKit());

    expect(vinculosDoKit(db)).toEqual([`produtos/kit-k/prodshopee/${VINCULO_DO_KIT}`]);
  });

  it('o import e DEPOIS a escrita da criação (a corrida que o id derivado fecha) ⇒ UM `prodshopee`', async () => {
    const db = new FakeDb();
    semearComponente(db);
    // O import acha K pelo SKU (degrau 2) — o kit criado ainda não tem vínculo.
    db.seed('produtos/kit-k', { nome: 'Kit', sku: 'KIT-19', paiId: null, ehKit: true });

    await importarKitShopee(depsDoImport(db), entradaDoKit());
    await escritaDaCriacao(db, 'kit-k');

    expect(vinculosDoKit(db)).toEqual([`produtos/kit-k/prodshopee/${VINCULO_DO_KIT}`]);
    expect(lerDoc(db, `produtos/kit-k/prodshopee/${VINCULO_DO_KIT}`)).toMatchObject({
      kitNativo: true,
      contaProdutoShopeeOuterRef: REF_CONTA,
    });
  });

  it('⛔ NEAR-MISS: um anúncio COMUM continua fazendo `add` num id automático', async () => {
    const db = new FakeDb();

    await importarAnuncioShopee(depsDoImport(db), item());

    const pai = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);
    const ids = db.idsEm(`produtos/${pai}/prodshopee`);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^auto-/);
  });
});

describe('passo 19 — a linha de um modelo de kit nasce no id derivado (M60)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  it('o `variashopee` do modelo mora em `idDaVariacaoDeKit(vínculo, model_id)` — e um segundo import mantém UMA linha', async () => {
    const db = new FakeDb();
    semearComponente(db);
    const pai = idDoPaiPlanejado(INTEGRACAO, KIT_ITEM);
    const filho = idDoFilhoPlanejado(pai, KIT_MODELO);

    await importarKitShopee(depsDoImport(db), entradaDoKit());
    await importarKitShopee({ ...depsDoImport(db), nowMs: AGORA + 1 }, entradaDoKit());

    expect(db.idsEm(`produtos/${filho}/variashopee`)).toEqual([
      idDaVariacaoDeKit(VINCULO_DO_KIT, KIT_MODELO),
    ]);
    expect(
      lerDoc(db, `produtos/${filho}/variashopee/${idDaVariacaoDeKit(VINCULO_DO_KIT, KIT_MODELO)}`),
    ).toMatchObject({
      model_id: KIT_MODELO,
      produtoShopeeOuterRef: `documents/${caminhoDoLinkDaListagem(pai, VINCULO_DO_KIT)}`,
    });
  });

  it('⛔ NEAR-MISS: um vínculo e uma linha de kit de ANTES do passo 19 (ids automáticos) são reusados — nunca um segundo', async () => {
    const db = new FakeDb();
    semearComponente(db);
    db.seed('produtos/kit-k', { nome: 'Kit', sku: 'KIT-19', paiId: null, ehKit: true });
    db.seed('produtos/kit-k/prodshopee/auto-antigo', {
      contaProdutoShopeeOuterRef: REF_CONTA,
      item_id: KIT_ITEM,
      kitNativo: true,
    });
    db.seed('produtos/filho-k', { nome: 'Kit UN', sku: 'KIT-19-UN', paiId: 'kit-k', ehKit: true });
    db.seed('produtos/filho-k/variashopee/linha-antiga', {
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: 'documents/produtos/kit-k/prodshopee/auto-antigo',
      model_id: KIT_MODELO,
    });

    await importarKitShopee(depsDoImport(db), entradaDoKit());

    expect(db.idsEm('produtos/kit-k/prodshopee')).toEqual(['auto-antigo']);
    expect(db.idsEm('produtos/filho-k/variashopee')).toEqual(['linha-antiga']);
  });
});
