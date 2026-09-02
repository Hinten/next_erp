import { describe, expect, it } from 'vitest';
import type { ComponentesKit } from '../collection/embedded/kit';
import type { GoogleMerchantData } from '../collection/extraData';
import {
  buildGoogleMerchantFeedItems,
  type FeedComponenteInfo,
  type FeedProdutoInput,
  gerarFeedComplementarGoogleMerchantXml,
  renderGoogleMerchantFeedXml,
  resolveCorTamanho,
} from './googleMerchantFeed';
import { type GrupoComId, varianteFakePath } from './variacoes';

/** Cores (tipo cor): Azul/Verde — Tamanhos (tipo tamanho): P/M. */
function gruposFixture(): GrupoComId[] {
  return [
    {
      id: 'CORES',
      data: {
        nome: 'Cores',
        ordem: 2,
        tipo: 2, // TIPO_VARIACAO.cor
        permiteFotos: true,
        variacoesIds: ['az', 'vd'],
        variacoes: [
          { id: 'az', nome: 'Azul', codigo: 'AZ' },
          { id: 'vd', nome: 'Verde', codigo: 'VD' },
        ],
      },
    },
    {
      id: 'TAM',
      data: {
        nome: 'Tamanhos',
        ordem: 1,
        tipo: 1, // TIPO_VARIACAO.tamanho
        permiteFotos: false,
        variacoesIds: ['p', 'm'],
        variacoes: [
          { id: 'p', nome: 'P', codigo: 'P' },
          { id: 'm', nome: 'M', codigo: 'M' },
        ],
      },
    },
    {
      id: 'OUTROS',
      data: {
        nome: 'Outros',
        ordem: 3,
        tipo: 0, // TIPO_VARIACAO.outros — never color/size
        permiteFotos: false,
        variacoesIds: ['x'],
        variacoes: [{ id: 'x', nome: 'Edição especial', codigo: 'X' }],
      },
    },
  ];
}

function merchantData(over: Partial<GoogleMerchantData> = {}): GoogleMerchantData {
  return {
    id: null,
    title: null,
    google_product_category: null,
    product_type: null,
    age_group: null,
    gender: null,
    material: null,
    pattern: null,
    ...over,
  };
}

function produto(over: Partial<FeedProdutoInput> = {}): FeedProdutoInput {
  return {
    id: 'p1',
    paiId: null,
    sku: 'SKU1',
    precos: { LISTA: { valor: 10 } },
    ehKit: false,
    componentesKit: null,
    variacoesUid: null,
    googleMerchantData: null,
    ...over,
  };
}

const comp = (): ComponentesKit[string] => ({
  quantidade: 1,
  limitarEstoque: true,
  timestamp: null,
});
const kit = (ids: string[]): ComponentesKit => Object.fromEntries(ids.map((id) => [id, comp()]));

describe('resolveCorTamanho', () => {
  it('resolves color and size from separate groups', () => {
    const uids = [varianteFakePath('CORES', 'az'), varianteFakePath('TAM', 'p')];
    expect(resolveCorTamanho(uids, gruposFixture())).toEqual({ color: 'Azul', size: 'P' });
  });

  it('ignores a tipo:outros group — never surfaces as color or size', () => {
    const uids = [varianteFakePath('OUTROS', 'x')];
    expect(resolveCorTamanho(uids, gruposFixture())).toEqual({ color: null, size: null });
  });

  it('tolerates an unparseable uid, an unknown group and an unknown variante', () => {
    const uids = [
      'not-a-fake-path',
      varianteFakePath('ZZZ', 'az'),
      varianteFakePath('CORES', 'unknown-variante'),
      varianteFakePath('TAM', 'm'),
    ];
    expect(resolveCorTamanho(uids, gruposFixture())).toEqual({ color: null, size: 'M' });
  });

  it('returns nulls for an absent/empty uid list', () => {
    expect(resolveCorTamanho(null, gruposFixture())).toEqual({ color: null, size: null });
    expect(resolveCorTamanho([], gruposFixture())).toEqual({ color: null, size: null });
  });

  it('last uid wins when two resolve to the same tipo', () => {
    const uids = [varianteFakePath('CORES', 'az'), varianteFakePath('CORES', 'vd')];
    expect(resolveCorTamanho(uids, gruposFixture())).toEqual({ color: 'Verde', size: null });
  });
});

describe('buildGoogleMerchantFeedItems — skip rules', () => {
  const opts = { listaId: 'LISTA', grupos: [], componenteInfoById: {} };

  it('skips a produto with no sku', () => {
    expect(buildGoogleMerchantFeedItems([produto({ sku: null })], opts)).toEqual([]);
    expect(buildGoogleMerchantFeedItems([produto({ sku: '' })], opts)).toEqual([]);
  });

  it('skips a produto with no price at the chosen lista', () => {
    expect(buildGoogleMerchantFeedItems([produto({ precos: {} })], opts)).toEqual([]);
    expect(
      buildGoogleMerchantFeedItems([produto({ precos: { OUTRA_LISTA: { valor: 10 } } })], opts),
    ).toEqual([]);
  });

  it('skips a produto priced <= 0 at the chosen lista', () => {
    expect(
      buildGoogleMerchantFeedItems([produto({ precos: { LISTA: { valor: 0 } } })], opts),
    ).toEqual([]);
  });

  it('keeps a produto priced above zero with a sku', () => {
    const items = buildGoogleMerchantFeedItems([produto()], opts);
    expect(items).toHaveLength(1);
  });
});

describe('buildGoogleMerchantFeedItems — id / item_group_id', () => {
  const opts = { listaId: 'LISTA', grupos: [], componenteInfoById: {} };

  it('defaults id to the sku when googleMerchantData has none', () => {
    const [item] = buildGoogleMerchantFeedItems([produto({ sku: 'SKU1' })], opts);
    expect(item?.id).toBe('SKU1');
  });

  it('prefers an explicit googleMerchantData.id override', () => {
    const [item] = buildGoogleMerchantFeedItems(
      [produto({ sku: 'SKU1', googleMerchantData: merchantData({ id: 'CUSTOM-ID' }) })],
      opts,
    );
    expect(item?.id).toBe('CUSTOM-ID');
  });

  it('uses paiId as item_group_id for a variation child', () => {
    const [item] = buildGoogleMerchantFeedItems(
      [produto({ id: 'child1', paiId: 'parent1' })],
      opts,
    );
    expect(item?.itemGroupId).toBe('parent1');
  });

  it('uses its own id as item_group_id when there is no parent', () => {
    const [item] = buildGoogleMerchantFeedItems(
      [produto({ id: 'standalone1', paiId: null })],
      opts,
    );
    expect(item?.itemGroupId).toBe('standalone1');
  });
});

describe('buildGoogleMerchantFeedItems — color/size', () => {
  it('resolves color/size via variacoesUid against the supplied grupos', () => {
    const [item] = buildGoogleMerchantFeedItems(
      [produto({ variacoesUid: [varianteFakePath('CORES', 'vd'), varianteFakePath('TAM', 'm')] })],
      { listaId: 'LISTA', grupos: gruposFixture(), componenteInfoById: {} },
    );
    expect(item).toMatchObject({ color: 'Verde', size: 'M' });
  });
});

describe('buildGoogleMerchantFeedItems — kit field inheritance', () => {
  const componenteInfoById: Record<string, FeedComponenteInfo> = {
    barato: {
      precoResolvido: 5,
      googleMerchantData: merchantData({ material: 'Algodão', pattern: 'Liso' }),
    },
    caro: {
      precoResolvido: 50,
      googleMerchantData: merchantData({
        age_group: 'adult',
        gender: 'unisex',
        material: 'Poliéster',
        pattern: 'Estampado',
      }),
    },
  };
  const opts = { listaId: 'LISTA', grupos: [], componenteInfoById };

  it('a non-kit produto never inherits — an empty own field simply stays empty', () => {
    const [item] = buildGoogleMerchantFeedItems(
      [produto({ ehKit: false, componentesKit: kit(['caro']), googleMerchantData: null })],
      opts,
    );
    expect(item).toMatchObject({ ageGroup: null, gender: null, material: null, pattern: null });
  });

  it('a kit with no own googleMerchantData inherits every field from the priciest component', () => {
    const [item] = buildGoogleMerchantFeedItems(
      [produto({ ehKit: true, componentesKit: kit(['barato', 'caro']), googleMerchantData: null })],
      opts,
    );
    expect(item).toMatchObject({
      ageGroup: 'adult',
      gender: 'unisex',
      material: 'Poliéster',
      pattern: 'Estampado',
    });
  });

  it('inheritance is PER FIELD, not all-or-nothing: an own value wins field by field', () => {
    // Own `material` is set; own `pattern`/`age_group`/`gender` are empty.
    // A naive all-or-nothing rule (own googleMerchantData present -> never
    // inherit) would leave pattern/age_group/gender empty too; the per-field
    // rule fills them in from the priciest component while keeping the own
    // material untouched.
    const [item] = buildGoogleMerchantFeedItems(
      [
        produto({
          ehKit: true,
          componentesKit: kit(['barato', 'caro']),
          googleMerchantData: merchantData({ material: 'Algodão Orgânico' }),
        }),
      ],
      opts,
    );
    expect(item).toMatchObject({
      material: 'Algodão Orgânico', // kept — the kit's own value
      pattern: 'Estampado', // inherited from "caro", the priciest
      ageGroup: 'adult',
      gender: 'unisex',
    });
  });

  it('picks the MOST expensive component, not merely the first with a value', () => {
    // "barato" resolves material/pattern but is cheaper than "caro", whose
    // OWN pattern is set but material/age_group/gender are null. The pick is
    // by price, so "caro" wins even though it leaves material/age_group/
    // gender unresolved — there is no fall-through to "barato".
    const info: Record<string, FeedComponenteInfo> = {
      barato: {
        precoResolvido: 5,
        googleMerchantData: merchantData({ material: 'Algodão', pattern: 'Liso' }),
      },
      caro: { precoResolvido: 50, googleMerchantData: merchantData({ pattern: 'Estampado' }) },
    };
    const [item] = buildGoogleMerchantFeedItems(
      [produto({ ehKit: true, componentesKit: kit(['barato', 'caro']), googleMerchantData: null })],
      { listaId: 'LISTA', grupos: [], componenteInfoById: info },
    );
    expect(item).toMatchObject({ pattern: 'Estampado', material: null });
  });

  it('a kit component absent from componenteInfoById (dangling ref) never wins and never throws', () => {
    const [item] = buildGoogleMerchantFeedItems(
      [
        produto({
          ehKit: true,
          componentesKit: kit(['dangling', 'barato']),
          googleMerchantData: null,
        }),
      ],
      opts,
    );
    expect(item).toMatchObject({ material: 'Algodão', pattern: 'Liso' });
  });

  it('a kit with no components (or empty componentesKit) inherits nothing', () => {
    for (const componentesKit of [null, undefined, {} as ComponentesKit]) {
      const [item] = buildGoogleMerchantFeedItems(
        [produto({ ehKit: true, componentesKit, googleMerchantData: null })],
        opts,
      );
      expect(item).toMatchObject({ ageGroup: null, gender: null, material: null, pattern: null });
    }
  });
});

describe('renderGoogleMerchantFeedXml', () => {
  it('omits a null field entirely rather than emitting an empty tag', () => {
    const xml = renderGoogleMerchantFeedXml([
      {
        id: 'A',
        itemGroupId: 'A',
        ageGroup: null,
        gender: null,
        material: null,
        pattern: null,
        color: null,
        size: null,
      },
    ]);
    expect(xml).not.toContain('<g:age_group');
    expect(xml).not.toContain('<g:color');
    expect(xml).toContain('<g:id>A</g:id>');
    expect(xml).toContain('<g:item_group_id>A</g:item_group_id>');
  });

  it('escapes XML-special characters in text content', () => {
    const xml = renderGoogleMerchantFeedXml([
      {
        id: 'A&B',
        itemGroupId: 'A',
        ageGroup: null,
        gender: null,
        material: null,
        pattern: null,
        color: '<Preto & Branco>',
        size: null,
      },
    ]);
    expect(xml).toContain('<g:id>A&amp;B</g:id>');
    expect(xml).toContain('<g:color>&lt;Preto &amp; Branco&gt;</g:color>');
  });

  it('wraps items in a valid RSS 2.0 + g: namespace channel', () => {
    const xml = renderGoogleMerchantFeedXml([]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns:g="http://base.google.com/ns/1.0"');
    expect(xml).toContain('<channel>');
    expect(xml).toContain('</channel>');
    expect(xml).toContain('</rss>');
  });
});

describe('gerarFeedComplementarGoogleMerchantXml — end to end', () => {
  it('builds items and renders them in one call', () => {
    const xml = gerarFeedComplementarGoogleMerchantXml(
      [
        produto({
          id: 'child1',
          paiId: 'parent1',
          sku: 'CAMISETA-P-AZ',
          variacoesUid: [varianteFakePath('CORES', 'az'), varianteFakePath('TAM', 'p')],
        }),
        produto({ id: 'skip-me', sku: null }),
      ],
      { listaId: 'LISTA', grupos: gruposFixture(), componenteInfoById: {} },
    );
    expect(xml).toContain('<g:id>CAMISETA-P-AZ</g:id>');
    expect(xml).toContain('<g:item_group_id>parent1</g:item_group_id>');
    expect(xml).toContain('<g:color>Azul</g:color>');
    expect(xml).toContain('<g:size>P</g:size>');
    // Only one <item> — the skipped (no-sku) produto contributes nothing.
    expect(xml.match(/<item>/g)).toHaveLength(1);
  });
});
