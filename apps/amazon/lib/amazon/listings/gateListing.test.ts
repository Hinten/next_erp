/**
 * The shared listing gate: the three refusals every flow shares, the shapes
 * counted, the binding's own refusal at its point of the order, and what the
 * gate never reads (the fulfilment channel, the quantity, the status).
 */
import { describe, expect, it } from 'vitest';
import { type ListingAmazon, MARKETPLACE_ID_BR } from '@delfrance/integrations-amazon-sp-api';

import { avaliarListingEstoqueAmazon } from '../estoque/gateListing';
import {
  CONTADOR_GATE_LISTING_AMAZON,
  MOTIVO_GATE_LISTING_AMAZON,
  TIPO_RELACAO_LISTING_AMAZON,
  type VeredictoGateListingAmazon,
  avaliarGateListingAmazon,
} from './gateListing';

const ASIN = 'ASIN-UM';
const OUTRO_MARKETPLACE = 'ATVPDKIKX0DER';
const COM_ASIN = { asinsDoVinculo: [ASIN] };

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

const motivo = <M extends string>(v: VeredictoGateListingAmazon<M>) =>
  v.enviavel ? 'enviavel' : v.motivo;

/** A listing an Amazon channel fulfils. */
const AFN = listing({
  fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_NA', quantity: 5 }],
});

/** A binding's own refusal, refusing every listing it is asked about. */
const sempreRecusa = () => 'propria' as const;

describe('an enviável listing', () => {
  it('a simple BR listing ⇒ enviável, nothing counted, the listing handed back', () => {
    const l = listing();
    expect(avaliarGateListingAmazon(l, COM_ASIN)).toEqual({
      enviavel: true,
      listing: l,
      contagens: [],
    });
  });

  it('★ the status is never read: a listing Amazon shows as not buyable is enviável', () => {
    const v = avaliarGateListingAmazon(
      listing({ summaries: [{ marketplaceId: MARKETPLACE_ID_BR, asin: ASIN, status: [] }] }),
      COM_ASIN,
    );
    expect(v.enviavel).toBe(true);
  });

  it('the quantity is never read: no availability at all ⇒ enviável', () => {
    expect(
      avaliarGateListingAmazon(listing({ fulfillmentAvailability: [] }), COM_ASIN).enviavel,
    ).toBe(true);
  });
});

describe('★ the fulfilment channel is a flow’s own question', () => {
  it('the shared gate, with no binding refusal, passes an AFN listing', () => {
    expect(avaliarGateListingAmazon(AFN, COM_ASIN)).toMatchObject({ enviavel: true });
  });

  it('NEAR-MISS: the stock binding refuses the same listing afn', () => {
    expect(avaliarListingEstoqueAmazon(AFN, COM_ASIN)).toEqual({ enviavel: false, motivo: 'afn' });
  });
});

describe('★ the shared refusals', () => {
  it('nao-listado: no listing, or no BR summary', () => {
    expect(avaliarGateListingAmazon(MOTIVO_GATE_LISTING_AMAZON.naoListado, COM_ASIN)).toEqual({
      enviavel: false,
      motivo: 'nao-listado',
    });
    const fora = listing({ summaries: [{ marketplaceId: OUTRO_MARKETPLACE, asin: ASIN }] });
    expect(motivo(avaliarGateListingAmazon(fora, COM_ASIN))).toBe('nao-listado');
  });

  it('pai: a BR VARIATION with children; NEAR-MISS a container is counted pacote, another store’s VARIATION passes', () => {
    const relacao = (marketplaceId: string, type: string) => ({
      relationships: [{ marketplaceId, relationships: [{ type, childSkus: ['F1'] }] }],
    });
    expect(
      motivo(
        avaliarGateListingAmazon(
          listing(relacao(MARKETPLACE_ID_BR, TIPO_RELACAO_LISTING_AMAZON.variacao)),
          COM_ASIN,
        ),
      ),
    ).toBe('pai');
    expect(
      avaliarGateListingAmazon(
        listing(relacao(MARKETPLACE_ID_BR, TIPO_RELACAO_LISTING_AMAZON.pacote)),
        COM_ASIN,
      ),
    ).toMatchObject({ enviavel: true, contagens: [CONTADOR_GATE_LISTING_AMAZON.pacote] });
    expect(
      avaliarGateListingAmazon(
        listing(relacao(OUTRO_MARKETPLACE, TIPO_RELACAO_LISTING_AMAZON.variacao)),
        COM_ASIN,
      ),
    ).toMatchObject({ enviavel: true, contagens: [CONTADOR_GATE_LISTING_AMAZON.semRelacoes] });
  });

  it('asin-divergente: the two ASINs differ; NEAR-MISS equal ⇒ enviável, none on the summary ⇒ counted', () => {
    expect(motivo(avaliarGateListingAmazon(listing(), { asinsDoVinculo: ['OUTRO'] }))).toBe(
      'asin-divergente',
    );
    expect(motivo(avaliarGateListingAmazon(listing(), { asinsDoVinculo: [] }))).toBe('enviavel');
    expect(
      avaliarGateListingAmazon(listing({ summaries: [{ marketplaceId: MARKETPLACE_ID_BR }] }), {
        asinsDoVinculo: ['OUTRO'],
      }),
    ).toMatchObject({ enviavel: true, contagens: [CONTADOR_GATE_LISTING_AMAZON.semAsinNaAmazon] });
  });

  it('pacote is counted for a BR PACKAGE_HIERARCHY with children only; NEAR-MISS a relationship of another type with children is neither refused nor counted', () => {
    const comFilhos = (type: string) =>
      listing({
        relationships: [
          { marketplaceId: MARKETPLACE_ID_BR, relationships: [{ type, childSkus: ['F1'] }] },
        ],
      });
    const outro = comFilhos('OUTRO');
    expect(avaliarGateListingAmazon(outro, COM_ASIN)).toEqual({
      enviavel: true,
      listing: outro,
      contagens: [],
    });
    const pacote = comFilhos(TIPO_RELACAO_LISTING_AMAZON.pacote);
    expect(avaliarGateListingAmazon(pacote, COM_ASIN)).toEqual({
      enviavel: true,
      listing: pacote,
      contagens: [CONTADOR_GATE_LISTING_AMAZON.pacote],
    });
  });

  it('the counters, all three, in their order', () => {
    expect(
      avaliarGateListingAmazon(
        listing({ relationships: [], summaries: [{ marketplaceId: MARKETPLACE_ID_BR }] }),
        COM_ASIN,
      ),
    ).toMatchObject({ contagens: ['semRelacoes', 'semAsinNaAmazon'] });
  });
});

describe('★ the binding’s own refusal sits between refusal 2 and refusal 3', () => {
  it('a variation parent is refused pai BEFORE the binding is asked', () => {
    const v = avaliarGateListingAmazon(
      listing({
        relationships: [
          {
            marketplaceId: MARKETPLACE_ID_BR,
            relationships: [{ type: TIPO_RELACAO_LISTING_AMAZON.variacao, childSkus: ['F1'] }],
          },
        ],
      }),
      COM_ASIN,
      sempreRecusa,
    );
    expect(motivo(v)).toBe('pai');
  });

  it('a divergent ASIN is refused by the binding FIRST; NEAR-MISS: without a binding, asin-divergente', () => {
    const outro = { asinsDoVinculo: ['OUTRO'] };
    expect(motivo(avaliarGateListingAmazon(listing(), outro, sempreRecusa))).toBe('propria');
    expect(motivo(avaliarGateListingAmazon(listing(), outro))).toBe('asin-divergente');
  });

  it('a binding that answers null lets the listing through', () => {
    expect(avaliarGateListingAmazon(AFN, COM_ASIN, () => null).enviavel).toBe(true);
  });
});
