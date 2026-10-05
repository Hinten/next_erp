import { describe, expect, it } from 'vitest';

import {
  shopeeItemBaseInfoRowSchema,
  shopeeModelSchema,
  shopeeTaxInfoSchema,
  type ShopeeModel,
} from '@delfrance/integrations-shopee';
import { variacaoShopeeLinkCollection } from '@delfrance/data/admin/collections';

import { FakeDb, asDb } from '../testing/fakeDb';
import type { ItemLido } from './itemLido';
import { aplicarLinkDaListagem, aplicarLinkDaVariacao } from './links';
import { caminhoDoLinkDaListagem, dadosLinkListagem, dadosLinkVariacao } from './mapeamento';
import type { EscritaDeLink } from './planoImportacao';

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
