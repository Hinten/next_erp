/**
 * The shared link verdict, bound by each flow: refusals 1–4 for every flow,
 * refusal 5 for stock alone, each flow reading its OWN stored outcome, and the
 * fields each flow reads.
 */
import { describe, expect, it } from 'vitest';

import { RECUSAS_VINCULO_ESTOQUE_AMAZON } from '../estoque/motivosEstoque';
import { FALHA_VINCULO_AMAZON, type ResolucaoVinculoAmazon } from '../pedidos/vinculoProdutoAmazon';
import { FLUXO_LISTING_AMAZON, type FluxoListingAmazon } from './fluxoListing';
import {
  CAMPO_ENVIO_LISTING_AMAZON,
  CAMPOS_DONO_LISTING_AMAZON,
  CAMPOS_PAI_DO_VINCULO_LISTING_AMAZON,
  CAMPOS_UNIDADE_VINCULO_LISTING_AMAZON,
  CAMPOS_VINCULO_LISTING_AMAZON,
  type EntradaVinculoListingAmazon,
  type EnvioDoVinculoListingAmazon,
  type LinkDoSkuListingAmazon,
  MOTIVO_VINCULO_LISTING_AMAZON,
  type RegraVinculoListingAmazon,
  type VeredictoVinculoListingAmazon,
  avaliarVinculoListingAmazon,
} from './vinculoListing';

const CONTA = 'conta-1';
const SKU = 'SKU-1';
const ASIN = 'ASIN-UM';
const UNIDADE_P: ResolucaoVinculoAmazon = { produtoId: 'P', via: 'vinculo-amazon' };
const PONTEIRO = 'documents/produtos/PAI/prodAmazon/lp';
const CAMINHO_PAI = 'produtos/PAI/prodAmazon/lp';

/** A flow's stored outcome as these tests store it: a clock and a label. */
interface EnvioDeTeste extends EnvioDoVinculoListingAmazon {
  readonly rotulo: string;
}

/** A reader that accepts `{ emMs: number, rotulo: string }` and refuses anything else. */
function lerEnvioDeTeste(valor: unknown): EnvioDeTeste | null {
  if (typeof valor !== 'object' || valor === null) return null;
  const { emMs, rotulo } = valor as Record<string, unknown>;
  return typeof emMs === 'number' && typeof rotulo === 'string' ? { emMs, rotulo } : null;
}

const regra = (fluxo: FluxoListingAmazon): RegraVinculoListingAmazon<EnvioDeTeste> => ({
  fluxo,
  lerEnvio: lerEnvioDeTeste,
});

const FLUXOS = [FLUXO_LISTING_AMAZON.estoque, FLUXO_LISTING_AMAZON.preco] as const;

function link(
  linkId: string,
  dados: Record<string, unknown> = {},
  donoId = 'P',
): LinkDoSkuListingAmazon {
  return {
    linkId,
    donoId,
    dados: { contaAmazonOuterRef: `documents/integracao/${CONTA}`, sku: SKU, asin: ASIN, ...dados },
  };
}

function entrada(over: Partial<EntradaVinculoListingAmazon> = {}): EntradaVinculoListingAmazon {
  return {
    contaId: CONTA,
    sku: SKU,
    resolucao: UNIDADE_P,
    dono: { id: 'P', raw: {} },
    linksDoSku: [link('l1')],
    paisDosLinks: new Map(),
    unidade: { raw: {}, filhosIds: [] },
    ...over,
  };
}

const veredicto = (e: EntradaVinculoListingAmazon, fluxo: FluxoListingAmazon) =>
  avaliarVinculoListingAmazon(e, regra(fluxo));
const motivo = (v: VeredictoVinculoListingAmazon<EnvioDeTeste>) => (v.apto ? 'apto' : v.motivo);

/** The `dono` switched off for THIS conta and the link's ASIN. */
const DESLIGADO = { statusProdutosMarketplace: { [`${CONTA}_${ASIN}`]: { enviarEstoque: false } } };

describe('★ refusal 5 is the stock flow’s alone', () => {
  it('fluxo preco ignores enviarEstoque === false: an apt link', () => {
    expect(
      veredicto(entrada({ dono: { id: 'P', raw: DESLIGADO } }), FLUXO_LISTING_AMAZON.preco),
    ).toMatchObject({ apto: true, unidadeId: 'P', donoId: 'P', linkIds: ['l1'] });
  });

  it('NEAR-MISS: fluxo estoque, the same entry ⇒ envio-desligado', () => {
    expect(
      veredicto(entrada({ dono: { id: 'P', raw: DESLIGADO } }), FLUXO_LISTING_AMAZON.estoque),
    ).toEqual({ apto: false, motivo: MOTIVO_VINCULO_LISTING_AMAZON.envioDesligado });
  });

  it('NEAR-MISS: enviarEstoque true, or another conta’s key ⇒ an apt link for stock too', () => {
    for (const raw of [
      { statusProdutosMarketplace: { [`${CONTA}_${ASIN}`]: { enviarEstoque: true } } },
      { statusProdutosMarketplace: { [`outra_${ASIN}`]: { enviarEstoque: false } } },
    ]) {
      expect(
        motivo(veredicto(entrada({ dono: { id: 'P', raw } }), FLUXO_LISTING_AMAZON.estoque)),
      ).toBe('apto');
    }
  });
});

describe('★ refusals 1–4 hold for EVERY flow, in their order', () => {
  it.each(FLUXOS)('%s: the resolution, the pointers, the parent identity and the unit', (fluxo) => {
    const v = (e: EntradaVinculoListingAmazon) => motivo(veredicto(e, fluxo));
    expect(v(entrada({ resolucao: { produtoId: null, via: FALHA_VINCULO_AMAZON.ambiguo } }))).toBe(
      'vinculo-ambiguo',
    );
    expect(v(entrada({ resolucao: { produtoId: null, via: 'unresolved' } }))).toBe(
      'produto-ausente',
    );
    expect(v(entrada({ dono: null }))).toBe('produto-ausente');
    expect(v(entrada({ linksDoSku: [link('l1', {}, 'OUTRO')] }))).toBe('produto-ausente');
    expect(v(entrada({ linksDoSku: [link('l1', { produtoAmazonPaiOuterRef: 'lixo' })] }))).toBe(
      'pai-do-vinculo-ilegivel',
    );
    expect(v(entrada({ linksDoSku: [link('l1', { produtoAmazonPaiOuterRef: PONTEIRO })] }))).toBe(
      'pai-do-vinculo-ilegivel',
    );
    expect(
      v(
        entrada({
          linksDoSku: [link('l1', { produtoAmazonPaiOuterRef: PONTEIRO })],
          paisDosLinks: new Map([[CAMINHO_PAI, { sku: SKU, asin: null }]]),
        }),
      ),
    ).toBe('filho-com-sku-do-pai');
    expect(v(entrada({ unidade: { raw: {}, filhosIds: ['F1'] } }))).toBe('unidade-com-variacoes');
    // A kit root's own sole member is no variation.
    expect(
      v(
        entrada({
          unidade: { raw: { ehKit: true, paiId: null, filhoUnicoId: 'PM' }, filhosIds: ['PM'] },
        }),
      ),
    ).toBe('apto');
    // The unit is checked before the stock opt-out, whichever the flow.
    expect(
      v(entrada({ dono: { id: 'P', raw: DESLIGADO }, unidade: { raw: {}, filhosIds: ['F1'] } })),
    ).toBe('unidade-com-variacoes');
  });

  it.each(FLUXOS)('%s: a link with no ASIN is apt and counted', (fluxo) => {
    expect(veredicto(entrada({ linksDoSku: [link('l1', { asin: null })] }), fluxo)).toMatchObject({
      apto: true,
      asinsDoVinculo: [],
      contagens: ['semAsinNoVinculo'],
    });
  });
});

describe('★ each flow reads its OWN stored outcome, never the other flow’s', () => {
  const ambos = entrada({
    linksDoSku: [
      link('l1', {
        [CAMPO_ENVIO_LISTING_AMAZON.estoque]: { emMs: 5_000, rotulo: 'estoque' },
        [CAMPO_ENVIO_LISTING_AMAZON.preco]: { emMs: 9_000, rotulo: 'preco' },
      }),
    ],
  });

  it('stock reads envioEstoqueAmazon; price reads envioPrecoAmazon', () => {
    const e = veredicto(ambos, FLUXO_LISTING_AMAZON.estoque);
    const p = veredicto(ambos, FLUXO_LISTING_AMAZON.preco);
    expect(e.apto && e.envioRecente).toEqual({ emMs: 5_000, rotulo: 'estoque' });
    expect(p.apto && p.envioRecente).toEqual({ emMs: 9_000, rotulo: 'preco' });
  });

  it('NEAR-MISS: a link carrying only the OTHER flow’s outcome reads as none', () => {
    const soEstoque = entrada({
      linksDoSku: [link('l1', { envioEstoqueAmazon: { emMs: 5_000, rotulo: 'estoque' } })],
    });
    const soPreco = entrada({
      linksDoSku: [link('l1', { envioPrecoAmazon: { emMs: 9_000, rotulo: 'preco' } })],
    });
    expect(veredicto(soEstoque, FLUXO_LISTING_AMAZON.preco)).toMatchObject({ envioRecente: null });
    expect(veredicto(soPreco, FLUXO_LISTING_AMAZON.estoque)).toMatchObject({ envioRecente: null });
  });

  it('the latest emMs among the dono’s docs; a tie keeps the smallest link id; a refused entry is skipped', () => {
    const campo = CAMPO_ENVIO_LISTING_AMAZON.preco;
    const v = veredicto(
      entrada({
        linksDoSku: [
          link('l3', { [campo]: { emMs: 7_000, rotulo: 'l3' } }),
          link('l1', { [campo]: { emMs: 7_000, rotulo: 'l1' } }),
          link('l2', { [campo]: { emMs: '9000', rotulo: 'recusado' } }),
          link('l4', { [campo]: { emMs: 6_999, rotulo: 'antigo' } }),
        ],
      }),
      FLUXO_LISTING_AMAZON.preco,
    );
    expect(v.apto && v.envioRecente).toEqual({ emMs: 7_000, rotulo: 'l1' });
  });

  it('NEAR-MISS: a GONE dono’s link outcome is never read', () => {
    const v = veredicto(
      entrada({
        linksDoSku: [
          link('l1'),
          link('l9', { envioPrecoAmazon: { emMs: 9_000, rotulo: 'outro dono' } }, 'GONE'),
        ],
      }),
      FLUXO_LISTING_AMAZON.preco,
    );
    expect(v).toMatchObject({ apto: true, linkIds: ['l1'], envioRecente: null });
  });
});

describe('the closed refusal set', () => {
  it('is the stock vocabulary’s link refusals, member for member and in order', () => {
    expect(Object.values(MOTIVO_VINCULO_LISTING_AMAZON)).toEqual([
      ...RECUSAS_VINCULO_ESTOQUE_AMAZON,
    ]);
  });
});

describe('★ the fields each flow reads', () => {
  it('the link: the ASIN, the pointer and the flow’s OWN outcome field', () => {
    expect([...CAMPOS_VINCULO_LISTING_AMAZON.estoque]).toEqual([
      'asin',
      'produtoAmazonPaiOuterRef',
      'envioEstoqueAmazon',
    ]);
    expect([...CAMPOS_VINCULO_LISTING_AMAZON.preco]).toEqual([
      'asin',
      'produtoAmazonPaiOuterRef',
      'envioPrecoAmazon',
    ]);
  });

  it('the dono: refusal 5’s map for stock; NOTHING for price', () => {
    expect([...CAMPOS_DONO_LISTING_AMAZON.estoque]).toEqual(['statusProdutosMarketplace']);
    expect([...CAMPOS_DONO_LISTING_AMAZON.preco]).toEqual([]);
  });

  it('a projection of every price input to the price fields changes no price verdict', () => {
    const projetar = (raw: Readonly<Record<string, unknown>>, campos: readonly string[]) =>
      Object.fromEntries(Object.entries(raw).filter(([k]) => campos.includes(k)));
    const ruido = {
      productDataJson: { a: 1 },
      issues: [],
      publicado: false,
      envioEstoqueAmazon: 1,
    };
    const casos = [
      entrada(),
      entrada({ dono: { id: 'P', raw: DESLIGADO } }),
      entrada({ linksDoSku: [link('l1', { asin: null })] }),
      entrada({
        linksDoSku: [link('l1', { produtoAmazonPaiOuterRef: PONTEIRO })],
        paisDosLinks: new Map([[CAMINHO_PAI, { sku: 'X', asin: ASIN }]]),
      }),
      entrada({ linksDoSku: [link('l1', { envioPrecoAmazon: { emMs: 1, rotulo: 'x' } })] }),
      entrada({ unidade: { raw: {}, filhosIds: ['F1', 'F2'] } }),
    ];
    for (const e of casos) {
      const cheio: EntradaVinculoListingAmazon = {
        ...e,
        unidade: { ...e.unidade, raw: { ...ruido, ...e.unidade.raw } },
        dono: e.dono === null ? null : { id: e.dono.id, raw: { ...ruido, ...e.dono.raw } },
        linksDoSku: e.linksDoSku.map((l) => ({ ...l, dados: { ...ruido, ...l.dados } })),
      };
      const projetado: EntradaVinculoListingAmazon = {
        ...cheio,
        unidade: {
          ...cheio.unidade,
          raw: projetar(cheio.unidade.raw, CAMPOS_UNIDADE_VINCULO_LISTING_AMAZON),
        },
        dono:
          cheio.dono === null
            ? null
            : {
                id: cheio.dono.id,
                raw: projetar(cheio.dono.raw, CAMPOS_DONO_LISTING_AMAZON.preco),
              },
        linksDoSku: cheio.linksDoSku.map((l) => ({
          ...l,
          dados: projetar(l.dados, CAMPOS_VINCULO_LISTING_AMAZON.preco),
        })),
        paisDosLinks: new Map(
          [...cheio.paisDosLinks].map(([k, alvo]) => [
            k,
            alvo === 'sumido'
              ? alvo
              : (projetar(alvo, CAMPOS_PAI_DO_VINCULO_LISTING_AMAZON) as {
                  sku: unknown;
                  asin: unknown;
                }),
          ]),
        ),
      };
      expect(veredicto(projetado, FLUXO_LISTING_AMAZON.preco)).toEqual(
        veredicto(cheio, FLUXO_LISTING_AMAZON.preco),
      );
    }
  });
});
