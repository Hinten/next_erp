/**
 * The listing gate: every refusal of the closed list with its near-miss,
 * the shapes accepted and counted, and the quantity Amazon shows.
 */
import { describe, expect, it } from 'vitest';
import {
  CANAL_MFN,
  type ListingAmazon,
  MARKETPLACE_ID_BR,
  listingAmazonSchema,
} from '@delfrance/integrations-amazon-sp-api';

import {
  TIPO_RELACAO_LISTING_AMAZON,
  type VeredictoListingEstoqueAmazon,
  avaliarListingEstoqueAmazon,
} from './gateListing';
import { MOTIVO_ESTOQUE_AMAZON, RECUSAS_LISTING_ESTOQUE_AMAZON } from './motivosEstoque';

const ASIN = 'ASIN-UM';
const OUTRO_MARKETPLACE = 'ATVPDKIKX0DER';
const COM_ASIN = { asinsDoVinculo: [ASIN] };
const SEM_ASIN = { asinsDoVinculo: [] };

/** A simple BR listing: one BR summary with the ASIN, a BR block with no relationship, DEFAULT 3. */
function listing(over: Partial<ListingAmazon> = {}): ListingAmazon {
  return {
    sku: 'SKU-1',
    summaries: [
      { marketplaceId: MARKETPLACE_ID_BR, asin: ASIN, productType: 'PRODUCT', status: ['BUYABLE'] },
    ],
    relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 3 }],
    ...over,
  };
}

const gate = (l: ListingAmazon | 'nao-listado', v = COM_ASIN) => avaliarListingEstoqueAmazon(l, v);
const motivo = (v: VeredictoListingEstoqueAmazon) => (v.enviavel ? 'enviavel' : v.motivo);

describe('an enviável listing', () => {
  it('a simple BR listing ⇒ enviável with its quantity, nothing counted', () => {
    expect(gate(listing())).toEqual({ enviavel: true, quantidadeAmazon: 3, contagens: [] });
  });

  it('the fixtures are what the package’s tolerant schema reads', () => {
    expect(listingAmazonSchema.safeParse(listing()).success).toBe(true);
  });

  it('★ NOT BUYABLE at quantity 0 ⇒ still enviável (the restock case): the status is never read', () => {
    const v = gate(
      listing({
        summaries: [{ marketplaceId: MARKETPLACE_ID_BR, asin: ASIN, status: ['DISCOVERABLE'] }],
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 0 }],
      }),
    );
    expect(v).toEqual({ enviavel: true, quantidadeAmazon: 0, contagens: [] });
    expect(
      gate(listing({ summaries: [{ marketplaceId: MARKETPLACE_ID_BR, asin: ASIN, status: [] }] }))
        .enviavel,
    ).toBe(true);
  });
});

describe('★ refusal 1: nao-listado', () => {
  it('no listing ⇒ nao-listado', () => {
    expect(motivo(gate('nao-listado'))).toBe('nao-listado');
  });

  it('no summary for the BR store ⇒ nao-listado', () => {
    expect(motivo(gate(listing({ summaries: [] })))).toBe('nao-listado');
    expect(motivo(gate(listing({ summaries: null })))).toBe('nao-listado');
    expect(
      motivo(gate(listing({ summaries: [{ marketplaceId: OUTRO_MARKETPLACE, asin: ASIN }] }))),
    ).toBe('nao-listado');
    expect(motivo(gate(listing({ summaries: [{ marketplaceId: null, asin: ASIN }] })))).toBe(
      'nao-listado',
    );
  });

  it('NEAR-MISS: one BR summary among others ⇒ enviável', () => {
    const v = gate(
      listing({
        summaries: [
          { marketplaceId: OUTRO_MARKETPLACE, asin: 'ASIN-OUTRO' },
          { marketplaceId: MARKETPLACE_ID_BR, asin: ASIN },
        ],
      }),
    );
    expect(v.enviavel).toBe(true);
  });

  it('the marketplace id is compared exactly (a case change is another store)', () => {
    expect(
      motivo(
        gate(
          listing({ summaries: [{ marketplaceId: MARKETPLACE_ID_BR.toLowerCase(), asin: ASIN }] }),
        ),
      ),
    ).toBe('nao-listado');
  });
});

/** One `ItemRelationship`, as the package reads it. */
type Relacao = NonNullable<
  NonNullable<ListingAmazon['relationships']>[number]['relationships']
>[number];

describe('★ refusal 2: pai', () => {
  const relacoes = (marketplaceId: string, rel: Relacao[]) =>
    listing({ relationships: [{ marketplaceId, relationships: rel }] });

  it('a BR VARIATION relationship with childSkus ⇒ pai', () => {
    expect(
      motivo(gate(relacoes(MARKETPLACE_ID_BR, [{ type: 'VARIATION', childSkus: ['F1', 'F2'] }]))),
    ).toBe('pai');
  });

  it('NEAR-MISS: a PACKAGE_HIERARCHY container with childSkus ⇒ enviável, counted pacote', () => {
    expect(
      gate(relacoes(MARKETPLACE_ID_BR, [{ type: 'PACKAGE_HIERARCHY', childSkus: ['F1'] }])),
    ).toEqual({
      enviavel: true,
      quantidadeAmazon: 3,
      contagens: ['pacote'],
    });
  });

  it('NEAR-MISS: a VARIATION under ANOTHER store ⇒ enviável', () => {
    const v = gate(
      listing({
        relationships: [
          {
            marketplaceId: OUTRO_MARKETPLACE,
            relationships: [{ type: 'VARIATION', childSkus: ['F1'] }],
          },
          { marketplaceId: MARKETPLACE_ID_BR, relationships: [] },
        ],
      }),
    );
    expect(v).toEqual({ enviavel: true, quantidadeAmazon: 3, contagens: [] });
  });

  it('NEAR-MISS: a PACKAGE_HIERARCHY with an empty or absent childSkus is no container ⇒ enviável, NOT counted pacote', () => {
    for (const rel of [
      { type: 'PACKAGE_HIERARCHY', childSkus: [] },
      { type: 'PACKAGE_HIERARCHY', parentSkus: ['C'] },
    ] satisfies Relacao[]) {
      expect(gate(relacoes(MARKETPLACE_ID_BR, [rel])), JSON.stringify(rel)).toEqual({
        enviavel: true,
        quantidadeAmazon: 3,
        contagens: [],
      });
    }
  });

  it('NEAR-MISS: a VARIATION with an empty or absent childSkus (a child) ⇒ enviável', () => {
    expect(gate(relacoes(MARKETPLACE_ID_BR, [{ type: 'VARIATION', childSkus: [] }])).enviavel).toBe(
      true,
    );
    expect(
      gate(relacoes(MARKETPLACE_ID_BR, [{ type: 'VARIATION', parentSkus: ['PAI'] }])).enviavel,
    ).toBe(true);
  });

  it('a VARIATION parent among other relationships of the BR block ⇒ pai', () => {
    expect(
      motivo(
        gate(
          relacoes(MARKETPLACE_ID_BR, [
            { type: 'PACKAGE_HIERARCHY', childSkus: ['C1'] },
            { type: 'VARIATION', childSkus: ['F1'] },
          ]),
        ),
      ),
    ).toBe('pai');
  });

  it('the type is compared exactly, as the model spells it', () => {
    expect(TIPO_RELACAO_LISTING_AMAZON).toEqual({
      variacao: 'VARIATION',
      pacote: 'PACKAGE_HIERARCHY',
    });
    expect(
      gate(relacoes(MARKETPLACE_ID_BR, [{ type: 'variation', childSkus: ['F1'] }])).enviavel,
    ).toBe(true);
  });

  it('★ no relationship block for the BR store ⇒ enviável, counted semRelacoes', () => {
    for (const over of [
      { relationships: undefined },
      { relationships: null },
      { relationships: [] },
      { relationships: [{ marketplaceId: OUTRO_MARKETPLACE, relationships: [] }] },
      // ★ Another store's VARIATION parent, and NO block for the BR store: still no BR parent.
      {
        relationships: [
          {
            marketplaceId: OUTRO_MARKETPLACE,
            relationships: [{ type: 'VARIATION', childSkus: ['F1'] }],
          },
        ],
      },
    ] satisfies Partial<ListingAmazon>[]) {
      expect(gate(listing(over)), JSON.stringify(over)).toEqual({
        enviavel: true,
        quantidadeAmazon: 3,
        contagens: ['semRelacoes'],
      });
    }
    const semCampo: ListingAmazon = {
      sku: 'SKU-1',
      summaries: listing().summaries,
      fulfillmentAvailability: [],
    };
    expect(gate(semCampo)).toMatchObject({ enviavel: true, contagens: ['semRelacoes'] });
  });

  it('NEAR-MISS: a BR block with no relationship is information ⇒ not counted', () => {
    expect(gate(listing())).toMatchObject({ contagens: [] });
  });
});

describe('★ refusal 3: afn', () => {
  it('any fulfillmentAvailability entry other than DEFAULT ⇒ afn', () => {
    for (const disponibilidade of [
      [{ fulfillmentChannelCode: 'AMAZON_NA', quantity: 5 }],
      [{ fulfillmentChannelCode: 'AMAZON_BR' }],
      [
        { fulfillmentChannelCode: 'DEFAULT', quantity: 3 },
        { fulfillmentChannelCode: 'AMAZON_BR', quantity: 5 },
      ],
      [{ fulfillmentChannelCode: 'default', quantity: 3 }],
      [{ fulfillmentChannelCode: 'DEFAULT ', quantity: 3 }],
      [{ fulfillmentChannelCode: null, quantity: 3 }],
      [{ quantity: 3 }],
    ]) {
      expect(
        motivo(gate(listing({ fulfillmentAvailability: disponibilidade }))),
        JSON.stringify(disponibilidade),
      ).toBe('afn');
    }
  });

  it('NEAR-MISS: [{ DEFAULT, 3 }] ⇒ enviável with 3', () => {
    expect(CANAL_MFN).toBe('DEFAULT');
    expect(
      gate(
        listing({ fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 3 }] }),
      ),
    ).toEqual({
      enviavel: true,
      quantidadeAmazon: 3,
      contagens: [],
    });
  });

  it('★ an empty or absent fulfillmentAvailability ⇒ enviável with a null quantity', () => {
    for (const over of [
      { fulfillmentAvailability: [] },
      { fulfillmentAvailability: null },
      { fulfillmentAvailability: undefined },
    ] satisfies Partial<ListingAmazon>[]) {
      expect(gate(listing(over)), JSON.stringify(over)).toEqual({
        enviavel: true,
        quantidadeAmazon: null,
        contagens: [],
      });
    }
  });
});

describe('the quantity Amazon shows', () => {
  const com = (fulfillmentAvailability: ListingAmazon['fulfillmentAvailability']) =>
    gate(listing({ fulfillmentAvailability }));

  it('a DEFAULT entry without a quantity ⇒ null', () => {
    expect(com([{ fulfillmentChannelCode: 'DEFAULT' }])).toMatchObject({ quantidadeAmazon: null });
  });

  it('two DEFAULT entries that agree ⇒ that quantity; that disagree, or one without ⇒ null', () => {
    const d = (quantity?: number) => ({ fulfillmentChannelCode: 'DEFAULT', quantity });
    expect(com([d(4), d(4)])).toMatchObject({ quantidadeAmazon: 4 });
    expect(com([d(4), d(5)])).toMatchObject({ quantidadeAmazon: null });
    expect(com([d(4), d()])).toMatchObject({ quantidadeAmazon: null });
  });

  it('a quantity that is not a non-negative integer ⇒ null (unknown, never a number)', () => {
    for (const quantity of [-1, 2.5, Number.NaN]) {
      expect(
        com([{ fulfillmentChannelCode: 'DEFAULT', quantity }]),
        String(quantity),
      ).toMatchObject({
        quantidadeAmazon: null,
      });
    }
  });
});

describe('★ refusal 4: asin-divergente', () => {
  const comAsinNaAmazon = (asin: string | null | undefined) =>
    listing({ summaries: [{ marketplaceId: MARKETPLACE_ID_BR, asin }] });

  it('the link’s non-null ASIN differs from the BR summary’s ⇒ asin-divergente', () => {
    expect(motivo(gate(comAsinNaAmazon('ASIN-OUTRO')))).toBe('asin-divergente');
  });

  it('★ the ASIN is compared EXACTLY: equal ⇒ enviável; a case or space change stays distinct ⇒ refused', () => {
    expect(gate(comAsinNaAmazon(ASIN)).enviavel).toBe(true);
    for (const quase of [ASIN.toLowerCase(), `${ASIN} `, `${ASIN}2`]) {
      expect(motivo(gate(comAsinNaAmazon(quase))), quase).toBe('asin-divergente');
    }
  });

  it('NEAR-MISS: the link’s ASIN null ⇒ enviável', () => {
    expect(gate(comAsinNaAmazon('ASIN-OUTRO'), SEM_ASIN)).toEqual({
      enviavel: true,
      quantidadeAmazon: 3,
      contagens: [],
    });
  });

  it('NEAR-MISS: the summary without an ASIN ⇒ enviável, counted semAsinNaAmazon', () => {
    for (const asin of [undefined, null, '']) {
      expect(gate(comAsinNaAmazon(asin)), String(asin)).toEqual({
        enviavel: true,
        quantidadeAmazon: 3,
        contagens: ['semAsinNaAmazon'],
      });
    }
  });

  it('two link ASINs, one of them Amazon’s ⇒ asin-divergente (fail closed)', () => {
    expect(motivo(gate(listing(), { asinsDoVinculo: [ASIN, 'ASIN-OUTRO'] }))).toBe(
      'asin-divergente',
    );
  });

  it('the converse case: two BR summary ASINs, the link’s one of them ⇒ asin-divergente (fail closed)', () => {
    const v = gate(
      listing({
        summaries: [
          { marketplaceId: MARKETPLACE_ID_BR, asin: ASIN },
          { marketplaceId: MARKETPLACE_ID_BR, asin: 'ASIN-OUTRO' },
        ],
      }),
    );
    expect(motivo(v)).toBe('asin-divergente');
  });

  it('another store’s summary ASIN is never compared', () => {
    const v = gate(
      listing({
        summaries: [
          { marketplaceId: OUTRO_MARKETPLACE, asin: 'ASIN-OUTRO' },
          { marketplaceId: MARKETPLACE_ID_BR, asin: ASIN },
        ],
      }),
    );
    expect(v.enviavel).toBe(true);
  });
});

describe('the order of the refusals, and the counters together', () => {
  it('nao-listado first, then pai, then afn, then asin-divergente', () => {
    const tudo = (over: Partial<ListingAmazon>) =>
      listing({
        summaries: [{ marketplaceId: MARKETPLACE_ID_BR, asin: 'ASIN-OUTRO' }],
        relationships: [
          {
            marketplaceId: MARKETPLACE_ID_BR,
            relationships: [{ type: 'VARIATION', childSkus: ['F'] }],
          },
        ],
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_BR', quantity: 1 }],
        ...over,
      });
    expect(motivo(gate(tudo({ summaries: [] })))).toBe('nao-listado');
    expect(motivo(gate(tudo({})))).toBe('pai');
    expect(motivo(gate(tudo({ relationships: [] })))).toBe('afn');
    expect(motivo(gate(tudo({ relationships: [], fulfillmentAvailability: [] })))).toBe(
      'asin-divergente',
    );
  });

  it('every refusal it answers is in the closed listing-refusal set', () => {
    for (const m of ['nao-listado', 'pai', 'afn', 'asin-divergente'] as const) {
      expect(RECUSAS_LISTING_ESTOQUE_AMAZON.has(m), m).toBe(true);
    }
    expect(RECUSAS_LISTING_ESTOQUE_AMAZON.has(MOTIVO_ESTOQUE_AMAZON.vinculoAmbiguo)).toBe(false);
  });

  it('several accepted shapes are all counted', () => {
    const v = gate(
      listing({
        summaries: [{ marketplaceId: MARKETPLACE_ID_BR }],
        relationships: null,
      }),
    );
    expect(v).toEqual({
      enviavel: true,
      quantidadeAmazon: 3,
      contagens: ['semRelacoes', 'semAsinNaAmazon'],
    });
  });
});
