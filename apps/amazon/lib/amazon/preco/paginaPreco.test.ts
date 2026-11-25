/**
 * A price run's page and its Decide: the per-SKU classification in its order,
 * the page's summary and part, the mass-decrease stop, Decide's branches and
 * the packing under both caps.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ListingAmazon,
  MARKETPLACE_ID_BR,
  TIPO_PRODUTO_LISTING_REGEX,
  patchOfertaAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  DECISAO_EXECUCAO_PRECO_AMAZON,
  type EnvioPrecoAmazon,
  type FaixaPrecoAmazon,
  type FontesPrecoAmazon,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  TIPO_OFERTA_PRECO_AMAZON,
  TIPO_PRODUTO_PRECO_AMAZON_REGEX,
  VIA_ENVIO_ESTOQUE_AMAZON,
  divergenciaPrecoAmazonSchema,
  envioPrecoAmazonSchema,
  fontesPrecoDaUnidadeAmazon,
  itemDivergenciaPrecoAmazonSchema,
} from '@delfrance/schemas';

import type { DecisaoLoteAmazon } from '../core/valvulas';
import type { LeituraSkuListingsAmazon } from '../listings/leituraLoteListings';
import type { PaiDaUnidadeListingAmazon } from '../listings/resolverVinculo';
import type { VeredictoVinculoListingAmazon } from '../listings/vinculoListing';
import { MOTIVO_PRECO_AMAZON } from './motivosPreco';
import {
  CLASSE_SKU_PRECO_AMAZON,
  type ClassificacaoSkuPrecoAmazon,
  type ContextoPaginaPrecoAmazon,
  type EntradaFimPrecoAmazon,
  type EntradaSkuPrecoAmazon,
  type LeituraSkuPrecoAmazon,
  classificarSkuPrecoAmazon,
  compravelNoBrPrecoAmazon,
  decidirFimPrecoAmazon,
  lotesDePartesPrecoAmazon,
  parteDaPaginaPrecoAmazon,
  reducaoEmMassaPrecoAmazon,
  resumirPaginaPrecoAmazon,
  tipoProdutoDoListingPrecoAmazon,
} from './paginaPreco';
import { DIRECAO_PRECO_AMAZON } from './planoPreco';

const AGORA = 1_800_000_000_000;
const MIN = 60_000;
const NORMAL = 'tabelaNormal';
const PROMO = 'tabelaPromo';

const faixa = (base: number, minimo = base, maximo = base): FaixaPrecoAmazon => ({
  base,
  minimo,
  maximo,
});

/** `attributes` holding our offer, in the documented WRITE shape (the package's own body). */
const atributos = (f: FaixaPrecoAmazon, extra: Record<string, unknown> = {}) => ({
  purchasable_offer: (patchOfertaAmazon(f).value ?? []).map((e) => ({ ...e, ...extra })),
});

function listing(
  o: {
    attributes?: unknown;
    status?: readonly string[];
    productType?: string | null;
    issues?: readonly unknown[];
    marketplaceId?: string;
  } = {},
): ListingAmazon {
  return {
    sku: 'SKU-1',
    summaries: [
      {
        marketplaceId: o.marketplaceId ?? MARKETPLACE_ID_BR,
        asin: 'B0ZZPRECO1',
        productType: o.productType === undefined ? 'LUGGAGE' : o.productType,
        status: [...(o.status ?? ['DISCOVERABLE'])],
      },
    ],
    attributes: o.attributes === undefined ? atributos(faixa(50)) : o.attributes,
    relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
    issues: [...(o.issues ?? [])],
  } as ListingAmazon;
}

const apto = (envioRecente: EnvioPrecoAmazon | null = null) =>
  ({
    apto: true,
    unidadeId: 'P1',
    donoId: 'P1',
    linkIds: ['L1'],
    asinsDoVinculo: ['B0ZZPRECO1'],
    envioRecente,
    contagens: [],
  }) satisfies VeredictoVinculoListingAmazon<EnvioPrecoAmazon>;

const fontes = (normal: number | null, promo: number | null = null): FontesPrecoAmazon => ({
  precosDaUnidade: {
    ...(normal === null ? {} : { [NORMAL]: { valor: normal } }),
    ...(promo === null ? {} : { [PROMO]: { valor: promo } }),
  },
  pai: null,
});

const lido = (l: ListingAmazon | 'nao-listado'): LeituraSkuPrecoAmazon => ({
  tipo: 'lido',
  leitura: l,
});

function entrada(o: Partial<EntradaSkuPrecoAmazon> = {}): EntradaSkuPrecoAmazon {
  return {
    sku: 'SKU-1',
    vinculo: 'produtos/P1/prodAmazon/L1',
    veredicto: apto(),
    leitura: lido(listing()),
    fontes: fontes(60),
    ...o,
  };
}

const ctx = (o: Partial<ContextoPaginaPrecoAmazon> = {}): ContextoPaginaPrecoAmazon => ({
  tabelas: { normalId: NORMAL, promocionalId: PROMO },
  baixarPreco: false,
  lidoEmMs: AGORA,
  ...o,
});

const classificar = (e: Partial<EntradaSkuPrecoAmazon> = {}, c = ctx()) =>
  classificarSkuPrecoAmazon(entrada(e), c);

function motivo(r: ClassificacaoSkuPrecoAmazon): string {
  return r.classe === CLASSE_SKU_PRECO_AMAZON.recusado ? r.motivo : r.classe;
}

/* ------------------------------- one SKU ----------------------------------- */

describe('★ page classification, per SKU, in its order', () => {
  it('an enviável SKU (Amazon 50, the ERP 60): its member parses as a part’s, with the live type and the read', () => {
    const r = classificar();
    expect(r.classe).toBe(CLASSE_SKU_PRECO_AMAZON.enviavel);
    if (r.classe !== CLASSE_SKU_PRECO_AMAZON.enviavel) return;
    expect(r.item).toEqual({
      sku: 'SKU-1',
      vinculo: 'produtos/P1/prodAmazon/L1',
      unidadeId: 'P1',
      oferta: { tipo: TIPO_OFERTA_PRECO_AMAZON.lida, base: 50, minimo: 50, maximo: 50 },
      faixa: faixa(60),
      tipoProduto: 'LUGGAGE',
      lidoEmMs: AGORA,
    });
    expect(r.direcao).toBe(DIRECAO_PRECO_AMAZON.sobe);
    expect(r.semCaminho).toBe(false);
    expect(itemDivergenciaPrecoAmazonSchema.parse(r.item)).toEqual(r.item);
    expect(
      divergenciaPrecoAmazonSchema.safeParse({
        execucaoId: 'run_1',
        itens: [r.item],
        expiraEm: new Date(),
      }).success,
    ).toBe(true);
  });

  it('★ the member stores Amazon’s offer as read, price by price (our_price 50, floor 45, ceiling 55), and the move is judged from our_price', () => {
    const r = classificar({ leitura: lido(listing({ attributes: atributos(faixa(50, 45, 55)) })) });
    expect(r.classe).toBe(CLASSE_SKU_PRECO_AMAZON.enviavel);
    if (r.classe !== CLASSE_SKU_PRECO_AMAZON.enviavel) return;
    expect(r.item.oferta).toEqual({
      tipo: TIPO_OFERTA_PRECO_AMAZON.lida,
      base: 50,
      minimo: 45,
      maximo: 55,
    });
    expect(r.referencia).toBe(50);
    expect(r.direcao).toBe(DIRECAO_PRECO_AMAZON.sobe);
    // A floor far below the price: 50 → 55 is an increase, never judged from the floor.
    const baixo = classificar({
      fontes: fontes(55),
      leitura: lido(listing({ attributes: atributos(faixa(50, 40, 50)) })),
    });
    expect(baixo.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && baixo.item.oferta.base).toBe(50);
  });

  it('★ the drop is measured from our_price, not the floor: live {100, 40, 100}, faixa 45 ⇒ quedaExcessiva (NEAR-MISS: faixa 50, exactly half ⇒ not)', () => {
    const vivo = lido(listing({ attributes: atributos(faixa(100, 40, 100)) }));
    const consent = ctx({ baixarPreco: true });
    const funda = classificar({ fontes: fontes(45), leitura: vivo }, consent);
    expect(funda.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && funda.quedaExcessiva).toBe(true);
    const metade = classificar({ fontes: fontes(50), leitura: vivo }, consent);
    expect(metade.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && metade.quedaExcessiva).toBe(false);
    expect(
      resumirPaginaPrecoAmazon([entrada({ sku: 'A', fontes: fontes(45), leitura: vivo })], consent)
        .amostra,
    ).toEqual(['A:100>45']);
  });

  it('the readers’ parent of a unit maps through fontesPrecoDaUnidadeAmazon: a gone parent prices nothing (sem-preco), never the unit’s own map', () => {
    expectTypeOf<PaiDaUnidadeListingAmazon | null>().toMatchTypeOf<
      Parameters<typeof fontesPrecoDaUnidadeAmazon>[1]
    >();
    const unidade = { precos: { [NORMAL]: { valor: 60 } }, paiId: 'P0' };
    const gone: PaiDaUnidadeListingAmazon = { id: 'P0', raw: null };
    expect(motivo(classificar({ fontes: fontesPrecoDaUnidadeAmazon(unidade, gone) }))).toBe(
      MOTIVO_PRECO_AMAZON.semPreco,
    );
    expect(classificar({ fontes: fontesPrecoDaUnidadeAmazon(unidade, null) }).classe).toBe(
      CLASSE_SKU_PRECO_AMAZON.enviavel,
    );
  });

  it('1. a refused link verdict ends it first, with its own motivo (the read and the faixa unread)', () => {
    const r = classificar({
      veredicto: { apto: false, motivo: 'unidade-com-variacoes' },
      leitura: { tipo: 'nao-confirmado' },
      fontes: null,
    });
    expect(r).toEqual({
      classe: CLASSE_SKU_PRECO_AMAZON.recusado,
      motivo: MOTIVO_PRECO_AMAZON.unidadeComVariacoes,
      indicadores: null,
    });
  });

  it('a price verdict answering the stock flow’s own refusal is a wiring bug, thrown', () => {
    expect(() => classificar({ veredicto: { apto: false, motivo: 'envio-desligado' } })).toThrow(
      TypeError,
    );
  });

  it('2. a search miss no GET confirmed, or could (no listings path) ⇒ nao-confirmado', () => {
    expect(motivo(classificar({ leitura: { tipo: 'nao-confirmado' } }))).toBe(
      MOTIVO_PRECO_AMAZON.naoConfirmado,
    );
    expect(motivo(classificar({ leitura: { tipo: 'sem-caminho' } }))).toBe(
      MOTIVO_PRECO_AMAZON.naoConfirmado,
    );
  });

  it('3. the listing gate: not listed (a GET’s 404, or no BR summary), a variation parent', () => {
    expect(motivo(classificar({ leitura: lido('nao-listado') }))).toBe(
      MOTIVO_PRECO_AMAZON.naoListado,
    );
    expect(
      motivo(classificar({ leitura: lido(listing({ marketplaceId: 'ATVPDKIKX0DER' })) })),
    ).toBe(MOTIVO_PRECO_AMAZON.naoListado);
    const pai = {
      ...listing(),
      relationships: [
        {
          marketplaceId: MARKETPLACE_ID_BR,
          relationships: [{ type: 'VARIATION', childSkus: ['F1'] }],
        },
      ],
    } as ListingAmazon;
    expect(motivo(classificar({ leitura: lido(pai) }))).toBe(MOTIVO_PRECO_AMAZON.pai);
  });

  it('4. the faixa: no normal tabela, no normal price, a promotional price above the normal one', () => {
    expect(
      motivo(classificar({}, ctx({ tabelas: { normalId: null, promocionalId: PROMO } }))),
    ).toBe(MOTIVO_PRECO_AMAZON.contaSemTabelaNormal);
    expect(motivo(classificar({ fontes: fontes(null) }))).toBe(MOTIVO_PRECO_AMAZON.semPreco);
    expect(motivo(classificar({ fontes: null }))).toBe(MOTIVO_PRECO_AMAZON.semPreco);
    const invertida = classificar({ fontes: fontes(60, 60.01) });
    expect(motivo(invertida)).toBe(MOTIVO_PRECO_AMAZON.faixaInvertida);
    // Counted past the gate: its offer flags were read.
    expect(invertida.indicadores).not.toBeNull();
  });

  it('4 before 5: a SKU failing both the faixa and the type ends at the faixa (sem-preco, faixa-invertida), never tipo-produto-ilegivel', () => {
    const luggage = lido(listing({ productType: 'luggage' }));
    expect(motivo(classificar({ fontes: fontes(null), leitura: luggage }))).toBe(
      MOTIVO_PRECO_AMAZON.semPreco,
    );
    expect(motivo(classificar({ fontes: fontes(60, 60.01), leitura: luggage }))).toBe(
      MOTIVO_PRECO_AMAZON.faixaInvertida,
    );
  });

  it('★ 5. the live productType: `luggage` ⇒ tipo-produto-ilegivel, never sendable (NEAR-MISS: `LUGGAGE` sendable; no type ⇒ PRODUCT, sendable)', () => {
    expect(motivo(classificar({ leitura: lido(listing({ productType: 'luggage' })) }))).toBe(
      MOTIVO_PRECO_AMAZON.tipoProdutoIlegivel,
    );
    const maiusculo = classificar({ leitura: lido(listing({ productType: 'LUGGAGE' })) });
    expect(
      maiusculo.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && maiusculo.item.tipoProduto,
    ).toBe('LUGGAGE');
    const semTipo = classificar({ leitura: lido(listing({ productType: null })) });
    expect(semTipo.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && semTipo.item.tipoProduto).toBe(
      'PRODUCT',
    );
  });

  it('6. the plan: Amazon already holding the faixa ⇒ igual; a decrease without the run’s consent ⇒ reducao-sem-consentimento (with it ⇒ enviável, desce)', () => {
    expect(classificar({ fontes: fontes(50) }).classe).toBe(CLASSE_SKU_PRECO_AMAZON.igual);
    expect(motivo(classificar({ fontes: fontes(40) }))).toBe(
      MOTIVO_PRECO_AMAZON.reducaoSemConsentimento,
    );
    const com = classificar({ fontes: fontes(40) }, ctx({ baixarPreco: true }));
    expect(com.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && com.direcao).toBe(
      DIRECAO_PRECO_AMAZON.desce,
    );
  });

  it('a page uses NO feed-recent rule and no floor, but the recent-send rule holds: an equal read 5 min after our own patch of another faixa is enviável', () => {
    const recente = (o: FaixaPrecoAmazon) =>
      envioPrecoAmazonSchema.parse({
        via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
        emMs: AGORA - 5 * MIN,
        oferta: o,
        resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
        submissionId: 's',
      });
    expect(classificar({ fontes: fontes(50), veredicto: apto(recente(faixa(30))) }).classe).toBe(
      CLASSE_SKU_PRECO_AMAZON.enviavel,
    );
    expect(classificar({ fontes: fontes(50) }).classe).toBe(CLASSE_SKU_PRECO_AMAZON.igual);
    // Our 70 may still be landing: 50 is a decrease from it, held back without consent…
    expect(motivo(classificar({ fontes: fontes(50), veredicto: apto(recente(faixa(70))) }))).toBe(
      MOTIVO_PRECO_AMAZON.reducaoSemConsentimento,
    );
    // …and with it counted `desce`, sampled and measured from 70.
    const com = classificar(
      { fontes: fontes(30), veredicto: apto(recente(faixa(70))) },
      ctx({ baixarPreco: true }),
    );
    expect(com.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && com.referencia).toBe(70);
    expect(com.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && com.direcao).toBe(
      DIRECAO_PRECO_AMAZON.desce,
    );
    expect(com.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && com.quedaExcessiva).toBe(true);
  });

  it('★ an AMBIGUOUS offer is stored as `ambigua` (not `ilegivel`) and, sent with consent, counted as an unknown direction', () => {
    const duas = {
      purchasable_offer: [
        ...atributos(faixa(50)).purchasable_offer,
        ...atributos(faixa(40)).purchasable_offer,
      ],
    };
    const r = classificar(
      { leitura: lido(listing({ attributes: duas })) },
      ctx({ baixarPreco: true }),
    );
    expect(r.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && r.item.oferta.tipo).toBe(
      TIPO_OFERTA_PRECO_AMAZON.ambigua,
    );
    expect(r.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && r.direcaoDesconhecida).toBe(true);
    expect(motivo(classificar({ leitura: lido(listing({ attributes: duas })) }))).toBe(
      MOTIVO_PRECO_AMAZON.precoAtualIlegivel,
    );
  });

  it('★ an ABSENT offer on a BUYABLE listing is stored as `ilegivel` and needs the run’s consent; on a listing that is not buyable it stays `ausente`, sent without consent', () => {
    const compravel = lido(listing({ attributes: {}, status: ['BUYABLE'] }));
    expect(motivo(classificar({ leitura: compravel }))).toBe(
      MOTIVO_PRECO_AMAZON.precoAtualIlegivel,
    );
    const com = classificar({ leitura: compravel }, ctx({ baixarPreco: true }));
    expect(com.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && com.item.oferta).toEqual({
      tipo: TIPO_OFERTA_PRECO_AMAZON.ilegivel,
      base: null,
      minimo: null,
      maximo: null,
    });
    expect(com.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && com.direcaoDesconhecida).toBe(true);
    const naoCompravel = classificar({ leitura: lido(listing({ attributes: {} })) });
    expect(
      naoCompravel.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && naoCompravel.item.oferta.tipo,
    ).toBe(TIPO_OFERTA_PRECO_AMAZON.ausente);
    // Nothing to lower there: not an unknown direction.
    expect(
      naoCompravel.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && naoCompravel.direcaoDesconhecida,
    ).toBe(false);
    // Missing attributes are no read: unreadable, never absent.
    expect(motivo(classificar({ leitura: lido(listing({ attributes: null })) }))).toBe(
      MOTIVO_PRECO_AMAZON.precoAtualIlegivel,
    );
  });

  it('quedaExcessiva for a decrease of more than half (NEAR-MISS: exactly half is not); semCaminho for a SKU no path carries', () => {
    const consent = ctx({ baixarPreco: true });
    const funda = classificar({ fontes: fontes(24.99) }, consent);
    expect(funda.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && funda.quedaExcessiva).toBe(true);
    const metade = classificar({ fontes: fontes(25) }, consent);
    expect(metade.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && metade.quedaExcessiva).toBe(false);
    const semPath = classificar({ sku: 'A/B' });
    expect(semPath.classe === CLASSE_SKU_PRECO_AMAZON.enviavel && semPath.semCaminho).toBe(true);
  });

  it('the offer flags and a price issue are read past the gate, whatever the end', () => {
    const extra = {
      discounted_price: [{ schedule: [{ value_with_tax: 40 }] }],
      end_at: { value: '2020-01-01T00:00:00Z' },
    };
    const attributes = {
      purchasable_offer: [
        { marketplace_id: MARKETPLACE_ID_BR, currency: 'BRL', audience: 'B2B' },
        ...atributos(faixa(50), extra).purchasable_offer,
      ],
    };
    const r = classificar({
      fontes: fontes(50),
      leitura: lido(listing({ attributes, issues: [{ code: '19037', severity: 'ERROR' }] })),
    });
    expect(r.classe).toBe(CLASSE_SKU_PRECO_AMAZON.igual);
    expect(r.indicadores).toEqual({
      temPrecoComDesconto: true,
      temOfertaB2B: true,
      fechada: true,
      problemaDePreco: true,
    });
    expect(classificar().indicadores).toEqual({
      temPrecoComDesconto: false,
      temOfertaB2B: false,
      fechada: false,
      problemaDePreco: false,
    });
    // NEAR-MISS: a price WARNING alone blocks nothing, so it is no counted problem.
    const aviso = { code: '100708', severity: 'WARNING', categories: ['INVALID_PRICE'] };
    expect(
      classificar({ leitura: lido(listing({ issues: [aviso] })) }).indicadores?.problemaDePreco,
    ).toBe(false);
  });

  it('the read instant is a ms integer', () => {
    expect(() => classificar({}, ctx({ lidoEmMs: -1 }))).toThrow(/lidoEmMs/);
  });

  it('the live read’s answer fits a page’s entry as it is (a type pin)', () => {
    expectTypeOf<LeituraSkuListingsAmazon>().toMatchTypeOf<LeituraSkuPrecoAmazon>();
  });
});

describe('the listing’s own readers', () => {
  it('BUYABLE is read off a BR summary, exactly (NEAR-MISS: another store’s, or `buyable`, is not)', () => {
    expect(compravelNoBrPrecoAmazon(listing({ status: ['BUYABLE'] }))).toBe(true);
    expect(compravelNoBrPrecoAmazon(listing({ status: ['buyable'] }))).toBe(false);
    expect(
      compravelNoBrPrecoAmazon(listing({ status: ['BUYABLE'], marketplaceId: 'ATVPDKIKX0DER' })),
    ).toBe(false);
  });

  it('the type: the BR summaries agreeing on one in the grammar, PRODUCT when none names one, else illegible', () => {
    const doisResumos = (a: string | null, b: string | null) =>
      ({
        ...listing(),
        summaries: [
          { marketplaceId: MARKETPLACE_ID_BR, productType: a },
          { marketplaceId: MARKETPLACE_ID_BR, productType: b },
          { marketplaceId: 'ATVPDKIKX0DER', productType: 'OTHER_TYPE' },
        ],
      }) as ListingAmazon;
    expect(tipoProdutoDoListingPrecoAmazon(doisResumos('SHOES', 'SHOES'))).toBe('SHOES');
    expect(tipoProdutoDoListingPrecoAmazon(doisResumos('SHOES', null))).toBe('SHOES');
    expect(tipoProdutoDoListingPrecoAmazon(doisResumos(null, null))).toBe('PRODUCT');
    expect(tipoProdutoDoListingPrecoAmazon(doisResumos('SHOES', 'BOOTS'))).toBeNull();
    expect(tipoProdutoDoListingPrecoAmazon(listing({ productType: '' }))).toBeNull();
    expect(
      tipoProdutoDoListingPrecoAmazon(listing({ productType: `A${'B'.repeat(64)}` })),
    ).toBeNull();
  });

  it('the part’s type grammar IS the package’s message grammar', () => {
    expect(TIPO_PRODUTO_PRECO_AMAZON_REGEX.source).toBe(TIPO_PRODUTO_LISTING_REGEX.source);
    expect(TIPO_PRODUTO_PRECO_AMAZON_REGEX.flags).toBe(TIPO_PRODUTO_LISTING_REGEX.flags);
  });
});

/* ------------------------------- one page ---------------------------------- */

describe('★ a page, summed', () => {
  it('counts every end under its counter or its motivo, keeps the members in order, and samples the decreases', () => {
    const resumo = resumirPaginaPrecoAmazon(
      [
        entrada({ sku: 'A', fontes: fontes(60) }),
        entrada({ sku: 'B', fontes: fontes(40) }),
        entrada({ sku: 'C', fontes: fontes(50) }),
        entrada({ sku: 'D', veredicto: { apto: false, motivo: 'vinculo-ambiguo' } }),
        entrada({ sku: 'E', leitura: lido('nao-listado') }),
        entrada({ sku: 'F', leitura: { tipo: 'nao-confirmado' } }),
        entrada({ sku: 'G', fontes: fontes(60, 61) }),
        entrada({ sku: 'H', fontes: fontes(10) }),
        entrada({ sku: 'I/J', fontes: fontes(70) }),
        entrada({
          sku: 'K',
          fontes: fontes(50),
          leitura: lido(
            listing({
              attributes: {
                purchasable_offer: [
                  { marketplace_id: MARKETPLACE_ID_BR, currency: 'BRL', audience: 'B2B' },
                  ...atributos(faixa(50), {
                    discounted_price: [{ schedule: [{ value_with_tax: 40 }] }],
                    end_at: { value: '2020-01-01T00:00:00Z' },
                  }).purchasable_offer,
                ],
              },
              issues: [{ code: '19037', severity: 'ERROR' }],
            }),
          ),
        }),
        entrada({ sku: 'L', fontes: fontes(null) }),
        entrada({ sku: 'M', leitura: lido(listing({ productType: 'luggage' })) }),
        entrada({ sku: 'N', leitura: lido(listing({ attributes: {}, status: ['BUYABLE'] })) }),
        entrada({
          sku: 'O',
          fontes: fontes(50),
          leitura: lido(
            listing({
              issues: [{ code: '100708', severity: 'WARNING', categories: ['INVALID_PRICE'] }],
            }),
          ),
        }),
      ],
      ctx({ baixarPreco: true }),
    );
    expect(resumo.contagens).toEqual({
      iguais: 3,
      enviaveis: 5,
      sobe: 2,
      desce: 2,
      quedaExcessiva: 1,
      direcaoDesconhecida: 1,
      reducaoSemConsentimento: 0,
      precoAtualIlegivel: 0,
      faixaInvertida: 1,
      tipoProdutoIlegivel: 1,
      semPreco: 1,
      semCaminho: 1,
      temPrecoComDesconto: 1,
      temOfertaB2B: 1,
      fechada: 1,
      naoConfirmados: 1,
      problemasDePreco: 1,
      porChave: { 'vinculo-ambiguo': 1, 'nao-listado': 1 },
    });
    expect(resumo.itens.map((i) => i.sku)).toEqual(['A', 'B', 'H', 'I/J', 'N']);
    expect(resumo.amostra).toEqual(['H:50>10', 'B:50>40']);
  });

  it('without the run’s consent a decrease is counted and kept out: NO decrease is sendable', () => {
    const resumo = resumirPaginaPrecoAmazon(
      [
        entrada({ sku: 'B', fontes: fontes(40) }),
        entrada({ sku: 'H', fontes: fontes(10) }),
        entrada({ sku: 'N', leitura: lido(listing({ attributes: {}, status: ['BUYABLE'] })) }),
        entrada({ sku: 'P', leitura: lido(listing({ attributes: null })) }),
      ],
      ctx(),
    );
    expect(resumo.contagens.reducaoSemConsentimento).toBe(2);
    expect(resumo.contagens.precoAtualIlegivel).toBe(2);
    expect(resumo.contagens.desce).toBe(0);
    expect(resumo.contagens.quedaExcessiva).toBe(0);
    expect(resumo.contagens.direcaoDesconhecida).toBe(0);
    expect(resumo.contagens.porChave).toEqual({});
    expect(resumo.itens).toEqual([]);
    expect(resumo.amostra).toEqual([]);
  });
});

describe('★ the page’s part: dense, and bounded', () => {
  it('a page with no enviável SKU writes no part; one with any writes part proximaParte', () => {
    expect(parteDaPaginaPrecoAmazon(5, 0)).toEqual({ acao: 'nenhuma' });
    expect(parteDaPaginaPrecoAmazon(5, 3)).toEqual({ acao: 'escrever', parte: 5 });
  });

  it('★ the 1,000th part ⇒ truncar, nothing written (NEAR-MISS: the 999th writes)', () => {
    expect(parteDaPaginaPrecoAmazon(1_000, 1)).toEqual({ acao: 'truncar' });
    expect(parteDaPaginaPrecoAmazon(999, 1)).toEqual({ acao: 'escrever', parte: 999 });
    // Nothing to write is never a truncation.
    expect(parteDaPaginaPrecoAmazon(1_000, 0)).toEqual({ acao: 'nenhuma' });
    expect(() => parteDaPaginaPrecoAmazon(-1, 1)).toThrow(/proximaParte/);
  });
});

/* --------------------------------- Decide ---------------------------------- */

const FEED: DecisaoLoteAmazon = { modo: 'feed' };
const DRY: DecisaoLoteAmazon = { modo: 'dry-run', motivo: 'valvula' };
const CANARIO: DecisaoLoteAmazon = { modo: 'so-patches-do-canario' };
const OFF: DecisaoLoteAmazon = { modo: 'off' };

/** Part sizes summing to `n` (full parts of 300, then the rest). */
function partesDe(n: number): number[] {
  const partes = Array.from({ length: Math.floor(n / 300) }, () => 300);
  return n % 300 === 0 ? partes : [...partes, n % 300];
}

const fim = (o: Partial<EntradaFimPrecoAmazon> = {}) =>
  decidirFimPrecoAmazon({
    itensPorParte: partesDe(31),
    semCaminho: 0,
    decisaoLote: FEED,
    contagens: { desce: 0, quedaExcessiva: 0, direcaoDesconhecida: 0 },
    baixarPreco: true,
    confirmarReducaoEmMassa: false,
    ...o,
  }).decisao;

describe('★ the mass-decrease stop', () => {
  const para = (desce: number, enviaveis: number, quedaExcessiva = 0, o = {}) =>
    reducaoEmMassaPrecoAmazon({
      desce,
      quedaExcessiva,
      direcaoDesconhecida: 0,
      enviaveis,
      baixarPreco: true,
      confirmarReducaoEmMassa: false,
      ...o,
    });

  it('★ 1,500 decreases of 20,000 ⇒ stop (NEAR-MISS: 1,499 of 20,000 ⇒ proceeds)', () => {
    expect(para(1_500, 20_000)).toBe(true);
    expect(para(1_499, 20_000)).toBe(false);
  });

  it('★ 31 decreases of 61 sendable ⇒ stop (NEAR-MISS: 30 of 59 proceeds — not above the switch; 31 of 63 proceeds — not above half)', () => {
    expect(para(31, 61)).toBe(true);
    expect(para(30, 59)).toBe(false);
    expect(para(31, 63)).toBe(false);
    expect(para(31, 62)).toBe(false);
  });

  it('★ one SKU falling by more than half ⇒ stop (NEAR-MISS: none ⇒ proceeds)', () => {
    expect(para(1, 100, 1)).toBe(true);
    expect(para(1, 100, 0)).toBe(false);
  });

  it('★ a send of an unknown direction (an unreadable offer, sent with consent) counts as a possible decrease: 1,500 of them stop it (NEAR-MISS: 1,499), and so do 20 decreases + 11 of them out of 61', () => {
    const desconhecidas = (n: number) => ({ direcaoDesconhecida: n });
    expect(para(0, 20_000, 0, desconhecidas(1_500))).toBe(true);
    expect(para(0, 20_000, 0, desconhecidas(1_499))).toBe(false);
    expect(para(0, 61, 0, desconhecidas(31))).toBe(true);
    expect(para(20, 61, 0, desconhecidas(11))).toBe(true);
    expect(para(20, 61, 0, desconhecidas(10))).toBe(false);
    expect(para(0, 20_000, 0, { ...desconhecidas(1_500), baixarPreco: false })).toBe(false);
    expect(
      fim({
        itensPorParte: partesDe(20_000),
        contagens: { desce: 0, quedaExcessiva: 0, direcaoDesconhecida: 1_500 },
      }),
    ).toBe(DECISAO_EXECUCAO_PRECO_AMAZON.reducaoEmMassa);
  });

  it('★ the request’s confirmation lifts it; a run without consent never stops (no decrease is sendable)', () => {
    expect(para(1_500, 20_000, 1, { confirmarReducaoEmMassa: true })).toBe(false);
    expect(para(1_500, 20_000, 1, { baixarPreco: false })).toBe(false);
  });

  it('★ Decide checks it FIRST, under every valve form (a dry-run shows it too); NEAR-MISS: the same counts confirmed ⇒ the normal plan', () => {
    const massa = {
      itensPorParte: partesDe(20_000),
      contagens: { desce: 1_500, quedaExcessiva: 0, direcaoDesconhecida: 0 },
    };
    for (const decisaoLote of [FEED, DRY, CANARIO, OFF]) {
      expect(fim({ ...massa, decisaoLote }), decisaoLote.modo).toBe(
        DECISAO_EXECUCAO_PRECO_AMAZON.reducaoEmMassa,
      );
    }
    expect(fim({ ...massa, confirmarReducaoEmMassa: true })).toBe(
      DECISAO_EXECUCAO_PRECO_AMAZON.lotes,
    );
    // The stop reads the enviável total from the parts: 31 of 61.
    const desce31 = { desce: 31, quedaExcessiva: 0, direcaoDesconhecida: 0 };
    expect(fim({ itensPorParte: [61], contagens: desce31 })).toBe(
      DECISAO_EXECUCAO_PRECO_AMAZON.reducaoEmMassa,
    );
    expect(fim({ itensPorParte: [63], contagens: desce31 })).toBe(
      DECISAO_EXECUCAO_PRECO_AMAZON.lotes,
    );
  });
});

describe('★ Decide', () => {
  it('★ 30 pathful ⇒ tarefas; 31 ⇒ lotes; 29 with one pathless ⇒ lotes (NEAR-MISS triple)', () => {
    expect(fim({ itensPorParte: [30] })).toBe(DECISAO_EXECUCAO_PRECO_AMAZON.tarefas);
    expect(fim({ itensPorParte: [31] })).toBe(DECISAO_EXECUCAO_PRECO_AMAZON.lotes);
    expect(fim({ itensPorParte: [29], semCaminho: 1 })).toBe(DECISAO_EXECUCAO_PRECO_AMAZON.lotes);
    expect(fim({ itensPorParte: [10, 20] })).toBe(DECISAO_EXECUCAO_PRECO_AMAZON.tarefas);
  });

  it('★ a canary LIST ⇒ canario whatever D (never a feed)', () => {
    for (const d of [1, 30, 31, 20_000]) {
      expect(fim({ itensPorParte: partesDe(d), decisaoLote: CANARIO }), String(d)).toBe(
        DECISAO_EXECUCAO_PRECO_AMAZON.canario,
      );
    }
  });

  it('★ nothing sendable ⇒ nada; an off valve ⇒ dry-run whatever D (before the tasks); a dry-run valve ⇒ dry-run where tasks would go (none would be enqueued), lotes where batches would (each builds and logs)', () => {
    expect(fim({ itensPorParte: [] })).toBe(DECISAO_EXECUCAO_PRECO_AMAZON.nada);
    expect(fim({ itensPorParte: [], decisaoLote: CANARIO })).toBe(
      DECISAO_EXECUCAO_PRECO_AMAZON.nada,
    );
    for (const itensPorParte of [[1], [30], [31]]) {
      expect(fim({ itensPorParte, decisaoLote: OFF }), String(itensPorParte)).toBe(
        DECISAO_EXECUCAO_PRECO_AMAZON.dryRun,
      );
    }
    expect(fim({ decisaoLote: DRY })).toBe(DECISAO_EXECUCAO_PRECO_AMAZON.lotes);
    expect(fim({ itensPorParte: [30], decisaoLote: DRY })).toBe(
      DECISAO_EXECUCAO_PRECO_AMAZON.dryRun,
    );
    expect(fim({ itensPorParte: [29], semCaminho: 1, decisaoLote: DRY })).toBe(
      DECISAO_EXECUCAO_PRECO_AMAZON.lotes,
    );
    // `on` with no canary list is a dry-run too (no member decides `on`), whatever its reason.
    const semCanario: DecisaoLoteAmazon = { modo: 'dry-run', motivo: 'sem-canario' };
    expect(fim({ itensPorParte: [30], decisaoLote: semCanario })).toBe(
      DECISAO_EXECUCAO_PRECO_AMAZON.dryRun,
    );
    expect(fim({ decisaoLote: semCanario })).toBe(DECISAO_EXECUCAO_PRECO_AMAZON.lotes);
    // NEAR-MISS: a feed-form valve at the same D makes the tasks.
    expect(fim({ itensPorParte: [30], decisaoLote: FEED })).toBe(
      DECISAO_EXECUCAO_PRECO_AMAZON.tarefas,
    );
  });

  it('`lotes` carries the packed batches', () => {
    expect(
      decidirFimPrecoAmazon({
        itensPorParte: [300, 300, 1],
        semCaminho: 0,
        decisaoLote: FEED,
        contagens: { desce: 0, quedaExcessiva: 0, direcaoDesconhecida: 0 },
        baixarPreco: false,
        confirmarReducaoEmMassa: false,
      }),
    ).toEqual({
      decisao: DECISAO_EXECUCAO_PRECO_AMAZON.lotes,
      lotes: [{ parteInicial: 0, partes: 3, itens: 601 }],
    });
  });

  it('a count or a part outside its domain is a wiring bug, thrown', () => {
    expect(() => fim({ semCaminho: -1 })).toThrow(/semCaminho/);
    expect(() =>
      fim({ contagens: { desce: 1.5, quedaExcessiva: 0, direcaoDesconhecida: 0 } }),
    ).toThrow(/desce/);
    expect(() =>
      fim({ contagens: { desce: 0, quedaExcessiva: 0, direcaoDesconhecida: -1 } }),
    ).toThrow(/direcaoDesconhecida/);
    expect(() => fim({ itensPorParte: [0] })).toThrow(RangeError);
  });
});

describe('★ the packing: by items AND parts', () => {
  it('★ 31 sendable SKUs over 31 parts of 1 ⇒ ONE batch (the feeds follow the drift, not the pages)', () => {
    expect(lotesDePartesPrecoAmazon(Array.from({ length: 31 }, () => 1))).toEqual([
      { parteInicial: 0, partes: 31, itens: 31 },
    ]);
  });

  it('★ 9,000 items ⇒ one batch; NEAR-MISS: 9,001 ⇒ two (the message cap)', () => {
    const cheias = Array.from({ length: 30 }, () => 300);
    expect(lotesDePartesPrecoAmazon(cheias)).toEqual([
      { parteInicial: 0, partes: 30, itens: 9_000 },
    ]);
    expect(lotesDePartesPrecoAmazon([...cheias, 1])).toEqual([
      { parteInicial: 0, partes: 30, itens: 9_000 },
      { parteInicial: 30, partes: 1, itens: 1 },
    ]);
  });

  it('★ 50 parts of 1 item ⇒ one batch; NEAR-MISS: 51 ⇒ two (the part cap)', () => {
    expect(lotesDePartesPrecoAmazon(Array.from({ length: 50 }, () => 1))).toHaveLength(1);
    expect(lotesDePartesPrecoAmazon(Array.from({ length: 51 }, () => 1))).toEqual([
      { parteInicial: 0, partes: 50, itens: 50 },
      { parteInicial: 50, partes: 1, itens: 1 },
    ]);
  });

  it('the batches cover every part once, consecutively; no part is split', () => {
    const partes = [300, 1, 299, 300, 300, 5, 300, 300];
    const lotes = lotesDePartesPrecoAmazon(partes);
    let proxima = 0;
    for (const l of lotes) {
      expect(l.parteInicial).toBe(proxima);
      expect(l.itens).toBe(
        partes.slice(l.parteInicial, l.parteInicial + l.partes).reduce((a, b) => a + b, 0),
      );
      proxima += l.partes;
    }
    expect(proxima).toBe(partes.length);
    expect(lotesDePartesPrecoAmazon([])).toEqual([]);
  });

  it('refuses a part of 0 or 301 items, and more parts than a run holds', () => {
    expect(() => lotesDePartesPrecoAmazon([0])).toThrow(RangeError);
    expect(() => lotesDePartesPrecoAmazon([301])).toThrow(RangeError);
    expect(() => lotesDePartesPrecoAmazon(Array.from({ length: 1_001 }, () => 1))).toThrow(
      RangeError,
    );
  });
});
