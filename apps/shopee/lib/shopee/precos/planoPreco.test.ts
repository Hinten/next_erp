import { describe, expect, it } from 'vitest';
import { SHOPEE_UPDATE_PRICE_MAX_MODELS } from '@delfrance/integrations-shopee';

import type { VarLinkShopeeCru } from '../core/vinculosShopee';
import { SHOPEE_PRECO_MODEL_ID_SEM_MODELO } from './constantesPreco';
import { MOTIVO_PRECO_SHOPEE } from './errosPreco';
import {
  type FamiliaDePreco,
  type FilhoDePreco,
  type ItemPlanejadoPreco,
  type LinkPrecoCru,
  montarItensDePreco,
  precificarItem,
  precosDaFamilia,
} from './planoPreco';

/* -------------------------------------------------------------------------- */
/*   Fixtures — invented ids only. Never a real partner, shop or credential.   */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const OUTRA_INTEGRACAO = 'int-12';
const ANCORA = 'prod-ancora';
const LINK_A = 'link-a';
const LINK_B = 'link-b';
const ITEM_A = 2500139861;
const ITEM_B = 2500139862;
const MODELO = 2000458802;
const TABELA = 'tab-normal';

function link(extra: LinkPrecoCru = {}): LinkPrecoCru {
  return {
    contaProdutoShopeeOuterRef: `integracoes/${INTEGRACAO}`,
    item_id: ITEM_A,
    linkDocId: LINK_A,
    ...extra,
  };
}

/** A model link naming the listing `linkDocId` of the anchor. */
function varLink(linkDocId: string, modelId: unknown, varLinkDocId: string): VarLinkShopeeCru {
  return {
    contaVariacaoShopeeOuterRef: `integracoes/${INTEGRACAO}`,
    produtoShopeeOuterRef: `produtos/${ANCORA}/prodshopee/${linkDocId}`,
    model_id: modelId,
    varLinkDocId,
  };
}

function filho(
  produtoId: string,
  varLinks: readonly VarLinkShopeeCru[],
  precos: unknown = null,
): FilhoDePreco {
  return { produtoId, precos, varLinks };
}

function familia(extra: Partial<FamiliaDePreco> = {}): FamiliaDePreco {
  return { anchorId: ANCORA, precos: null, links: [link()], children: [], ...extra };
}

/** `n` children, each carrying ONE model of listing A. */
function filhosComUmModeloCada(n: number): FilhoDePreco[] {
  return Array.from({ length: n }, (_, i) =>
    filho(`filho-${String(i).padStart(3, '0')}`, [
      varLink(LINK_A, MODELO + i, `var-${String(i).padStart(3, '0')}`),
    ]),
  );
}

function precos(valor: unknown): unknown {
  return { [TABELA]: { valor } };
}

/* -------------------------------------------------------------------------- */
/*                          rung 0 — the conta filter                          */
/* -------------------------------------------------------------------------- */

describe('montarItensDePreco — rung 0: só os vínculos DESTA conta', () => {
  it('PAR — as duas codificações do ref da conta planejam o MESMO anúncio', () => {
    for (const ref of [`documents/integracoes/${INTEGRACAO}`, `integracoes/${INTEGRACAO}`]) {
      const plano = montarItensDePreco(
        familia({ links: [link({ contaProdutoShopeeOuterRef: ref })] }),
        INTEGRACAO,
      );
      expect(plano.pulos).toEqual([]);
      expect(plano.itens).toEqual([
        { produtoId: ANCORA, linkDocId: LINK_A, itemId: ITEM_A, modelos: [] },
      ]);
    }
  });

  it('⚠️ QUASE-IGUAL — um vínculo de OUTRA conta ao lado do desta: só o desta é planejado, o outro é ignorado SEM linha', () => {
    const plano = montarItensDePreco(
      familia({
        links: [
          link({
            contaProdutoShopeeOuterRef: `integracoes/${OUTRA_INTEGRACAO}`,
            linkDocId: LINK_B,
            item_id: ITEM_B,
          }),
          link(),
        ],
      }),
      INTEGRACAO,
    );
    expect(plano.itens.map((i) => i.linkDocId)).toEqual([LINK_A]);
    expect(plano.pulos).toEqual([]);
  });

  it('uma família só com vínculos de OUTRA conta responde UM `sem-link` (int-12 não é int-1)', () => {
    const plano = montarItensDePreco(
      familia({
        links: [
          link({ contaProdutoShopeeOuterRef: `integracoes/${OUTRA_INTEGRACAO}` }),
          link({ contaProdutoShopeeOuterRef: `documents/integracoes/${OUTRA_INTEGRACAO}` }),
        ],
      }),
      INTEGRACAO,
    );
    expect(plano.itens).toEqual([]);
    expect(plano.pulos).toEqual([
      {
        produtoId: ANCORA,
        linkDocId: null,
        itemId: null,
        motivo: MOTIVO_PRECO_SHOPEE.semLink,
        modelos: [],
      },
    ]);
  });

  it('uma família sem vínculo nenhum responde UM `sem-link`', () => {
    const plano = montarItensDePreco(familia({ links: [] }), INTEGRACAO);
    expect(plano.pulos.map((p) => p.motivo)).toEqual([MOTIVO_PRECO_SHOPEE.semLink]);
    expect(plano.itens).toEqual([]);
  });

  it('um vínculo desta conta sem `linkDocId` (deriva da projeção) é `sem-link` sem id, e não derruba o vizinho', () => {
    const plano = montarItensDePreco(
      familia({ links: [link({ linkDocId: '' }), link({ linkDocId: LINK_B, item_id: ITEM_B })] }),
      INTEGRACAO,
    );
    expect(plano.pulos).toEqual([
      {
        produtoId: ANCORA,
        linkDocId: null,
        itemId: null,
        motivo: MOTIVO_PRECO_SHOPEE.semLink,
        modelos: [],
      },
    ]);
    expect(plano.itens.map((i) => i.linkDocId)).toEqual([LINK_B]);
  });
});

/* -------------------------------------------------------------------------- */
/*                            rung 2 — the item id                             */
/* -------------------------------------------------------------------------- */

describe('montarItensDePreco — rung 2: `sem-item-id`', () => {
  it('PAR — um `item_id` inteiro positivo é planejado como NÚMERO', () => {
    const [item] = montarItensDePreco(familia(), INTEGRACAO).itens;
    expect(item?.itemId).toBe(ITEM_A);
    expect(typeof item?.itemId).toBe('number');
  });

  it('QUASE-IGUAL — `0`, negativo, fracionário, TEXTO numérico, `null` e ausente são todos `sem-item-id`', () => {
    for (const bruto of [0, -1, 1.5, String(ITEM_A), null, undefined, Number.NaN]) {
      const plano = montarItensDePreco(familia({ links: [link({ item_id: bruto })] }), INTEGRACAO);
      expect(plano.itens).toEqual([]);
      expect(plano.pulos).toEqual([
        {
          produtoId: ANCORA,
          linkDocId: LINK_A,
          itemId: null,
          motivo: MOTIVO_PRECO_SHOPEE.semItemId,
          modelos: [],
        },
      ]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                       rung 3 — the native kit (M52/M24)                     */
/* -------------------------------------------------------------------------- */

describe('montarItensDePreco — rung 3: o kit NATIVO da Shopee, nunca o kit do ERP', () => {
  it('⚠️ PAR (M52) — `kitNativo: true` no VÍNCULO ⇒ `kit-derivado`, nenhum item', () => {
    const plano = montarItensDePreco(familia({ links: [link({ kitNativo: true })] }), INTEGRACAO);
    expect(plano.itens).toEqual([]);
    expect(plano.pulos).toEqual([
      {
        produtoId: ANCORA,
        linkDocId: LINK_A,
        itemId: ITEM_A,
        motivo: MOTIVO_PRECO_SHOPEE.kitDerivado,
        modelos: [],
      },
    ]);
  });

  it('⚠️ QUASE-IGUAL (M52/M24) — um kit do ERP (`ehKit`, `ehKitVirtual`) com `kitNativo` falso ou ausente É planejado', () => {
    // A família não carrega flag de produto nenhuma; os campos extras abaixo
    // chegam só para provar que nada os lê.
    const kitDoErp = { ...familia(), ehKit: true, ehKitVirtual: true };
    for (const kitNativo of [false, undefined, null]) {
      const plano = montarItensDePreco({ ...kitDoErp, links: [link({ kitNativo })] }, INTEGRACAO);
      expect(plano.pulos).toEqual([]);
      expect(plano.itens).toHaveLength(1);
    }
  });

  it('QUASE-IGUAL — só o booleano `true` é kit nativo: `"true"` e `1` são planejados', () => {
    for (const kitNativo of ['true', 1]) {
      const plano = montarItensDePreco(familia({ links: [link({ kitNativo })] }), INTEGRACAO);
      expect(plano.itens).toHaveLength(1);
    }
  });

  it('a ORDEM: sem `item_id` vence o kit (rung 2 antes do 3)', () => {
    const plano = montarItensDePreco(
      familia({ links: [link({ item_id: 0, kitNativo: true })] }),
      INTEGRACAO,
    );
    expect(plano.pulos.map((p) => p.motivo)).toEqual([MOTIVO_PRECO_SHOPEE.semItemId]);
  });
});

/* -------------------------------------------------------------------------- */
/*                     rung 4 — the stored deleted lifecycle                   */
/* -------------------------------------------------------------------------- */

describe('montarItensDePreco — rung 4: `anuncio-removido` pelo que está GRAVADO', () => {
  it('PAR — `SELLER_DELETE`, `SHOPEE_DELETE` e o `estadoAnuncio: removido` recusam com o MESMO slug', () => {
    for (const extra of [
      { item_status: 'SELLER_DELETE' },
      { item_status: 'SHOPEE_DELETE' },
      { estadoAnuncio: 'removido' },
    ]) {
      const plano = montarItensDePreco(familia({ links: [link(extra)] }), INTEGRACAO);
      expect(plano.itens).toEqual([]);
      expect(plano.pulos).toEqual([
        {
          produtoId: ANCORA,
          linkDocId: LINK_A,
          itemId: ITEM_A,
          motivo: MOTIVO_PRECO_SHOPEE.anuncioRemovido,
          modelos: [],
        },
      ]);
    }
  });

  it('⚠️ QUASE-IGUAL — banido, em revisão, pausado, minúsculo e ausente são PLANEJADOS (a leitura fresca do envio decide)', () => {
    for (const extra of [
      { item_status: 'BANNED' },
      { item_status: 'REVIEWING' },
      { item_status: 'UNLIST' },
      { item_status: 'NORMAL' },
      { item_status: 'seller_delete' },
      { item_status: null },
      { estadoAnuncio: 'banido' },
      { estadoAnuncio: 'em_revisao' },
      { estadoAnuncio: 'desconhecido' },
      {},
    ]) {
      const plano = montarItensDePreco(familia({ links: [link(extra)] }), INTEGRACAO);
      expect(plano.pulos).toEqual([]);
      expect(plano.itens).toHaveLength(1);
    }
  });

  it('a ORDEM: o kit vence o removido (rung 3 antes do 4), e o removido vence a forma dos modelos', () => {
    const kitRemovido = montarItensDePreco(
      familia({ links: [link({ kitNativo: true, item_status: 'SELLER_DELETE' })] }),
      INTEGRACAO,
    );
    expect(kitRemovido.pulos.map((p) => p.motivo)).toEqual([MOTIVO_PRECO_SHOPEE.kitDerivado]);

    const removidoComFormaRuim = montarItensDePreco(
      familia({
        links: [link({ item_status: 'SHOPEE_DELETE' })],
        children: [
          filho('filho-1', [
            varLink(LINK_A, MODELO, 'var-1'),
            varLink(LINK_A, MODELO + 1, 'var-2'),
          ]),
        ],
      }),
      INTEGRACAO,
    );
    expect(removidoComFormaRuim.pulos.map((p) => p.motivo)).toEqual([
      MOTIVO_PRECO_SHOPEE.anuncioRemovido,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                   rungs 5–8 — the models of THIS listing                    */
/* -------------------------------------------------------------------------- */

describe('montarItensDePreco — os modelos DESTE anúncio', () => {
  it('PAR — nenhum vínculo de modelo nomeia o anúncio ⇒ UM item SEM modelos (o preço da âncora)', () => {
    const plano = montarItensDePreco(
      familia({ children: [filho('filho-1', [varLink(LINK_B, MODELO, 'var-1')])] }),
      INTEGRACAO,
    );
    expect(plano.itens).toEqual([
      { produtoId: ANCORA, linkDocId: LINK_A, itemId: ITEM_A, modelos: [] },
    ]);
  });

  it('⚠️ QUASE-IGUAL (M54/M25) — o único vínculo de modelo tem `model_id: 0` ⇒ `sem-modelos`, NUNCA um item sem modelos no modelo 0', () => {
    const plano = montarItensDePreco(
      familia({ children: [filho('filho-1', [varLink(LINK_A, 0, 'var-1')])] }),
      INTEGRACAO,
    );
    expect(plano.itens).toEqual([]);
    expect(plano.pulos).toEqual([
      {
        produtoId: ANCORA,
        linkDocId: LINK_A,
        itemId: ITEM_A,
        motivo: MOTIVO_PRECO_SHOPEE.semModelos,
        modelos: [],
      },
    ]);
  });

  it('vínculos todos marcados ausentes, ou sem id de documento, também são `sem-modelos`', () => {
    const ausente = montarItensDePreco(
      familia({
        children: [
          filho('filho-1', [{ ...varLink(LINK_A, MODELO, 'var-1'), modeloAusenteEm: 1_700 }]),
        ],
      }),
      INTEGRACAO,
    );
    expect(ausente.pulos.map((p) => p.motivo)).toEqual([MOTIVO_PRECO_SHOPEE.semModelos]);

    const semDocId = montarItensDePreco(
      familia({ children: [filho('filho-1', [varLink(LINK_A, MODELO, '')])] }),
      INTEGRACAO,
    );
    expect(semDocId.pulos.map((p) => p.motivo)).toEqual([MOTIVO_PRECO_SHOPEE.semModelos]);
  });

  it('um modelo sem id de documento sai; o vizinho com id continua planejado', () => {
    const plano = montarItensDePreco(
      familia({
        children: [
          filho('filho-1', [varLink(LINK_A, MODELO, '')]),
          filho('filho-2', [varLink(LINK_A, MODELO + 1, 'var-2')]),
        ],
      }),
      INTEGRACAO,
    );
    expect(plano.itens[0]?.modelos).toEqual([
      { modelId: MODELO + 1, produtoId: 'filho-2', varLinkDocId: 'var-2' },
    ]);
  });

  it('⚠️ (M23) dois `prodshopee` sob UMA âncora: cada item leva SÓ os modelos do seu vínculo', () => {
    const plano = montarItensDePreco(
      familia({
        links: [link(), link({ linkDocId: LINK_B, item_id: ITEM_B })],
        children: [
          filho('filho-1', [
            varLink(LINK_A, MODELO, 'var-1a'),
            varLink(LINK_B, MODELO + 10, 'var-1b'),
          ]),
          filho('filho-2', [varLink(LINK_A, MODELO + 1, 'var-2a')]),
        ],
      }),
      INTEGRACAO,
    );
    expect(plano.pulos).toEqual([]);
    expect(plano.itens).toEqual([
      {
        produtoId: ANCORA,
        linkDocId: LINK_A,
        itemId: ITEM_A,
        modelos: [
          { modelId: MODELO, produtoId: 'filho-1', varLinkDocId: 'var-1a' },
          { modelId: MODELO + 1, produtoId: 'filho-2', varLinkDocId: 'var-2a' },
        ],
      },
      {
        produtoId: ANCORA,
        linkDocId: LINK_B,
        itemId: ITEM_B,
        modelos: [{ modelId: MODELO + 10, produtoId: 'filho-1', varLinkDocId: 'var-1b' }],
      },
    ]);
  });

  it('⚠️ PAR (M53) — UM filho com DOIS modelos utilizáveis do anúncio ⇒ `forma-de-modelo-divergente`, sem lista de modelos', () => {
    const plano = montarItensDePreco(
      familia({
        children: [
          filho('filho-1', [
            varLink(LINK_A, MODELO, 'var-1'),
            varLink(LINK_A, MODELO + 1, 'var-2'),
          ]),
        ],
      }),
      INTEGRACAO,
    );
    expect(plano.itens).toEqual([]);
    expect(plano.pulos).toEqual([
      {
        produtoId: ANCORA,
        linkDocId: LINK_A,
        itemId: ITEM_A,
        motivo: MOTIVO_PRECO_SHOPEE.formaDeModeloDivergente,
        modelos: [],
      },
    ]);
  });

  it('⚠️ QUASE-IGUAL (M53) — DOIS filhos com UM modelo cada ⇒ planejado com os dois', () => {
    const plano = montarItensDePreco(
      familia({
        children: [
          filho('filho-1', [varLink(LINK_A, MODELO, 'var-1')]),
          filho('filho-2', [varLink(LINK_A, MODELO + 1, 'var-2')]),
        ],
      }),
      INTEGRACAO,
    );
    expect(plano.pulos).toEqual([]);
    expect(plano.itens[0]?.modelos.map((m) => m.produtoId)).toEqual(['filho-1', 'filho-2']);
  });

  it('QUASE-IGUAL — um filho com um modelo em CADA um de dois anúncios não é forma divergente', () => {
    const plano = montarItensDePreco(
      familia({
        links: [link(), link({ linkDocId: LINK_B, item_id: ITEM_B })],
        children: [
          filho('filho-1', [
            varLink(LINK_A, MODELO, 'var-a'),
            varLink(LINK_B, MODELO + 1, 'var-b'),
          ]),
        ],
      }),
      INTEGRACAO,
    );
    expect(plano.pulos).toEqual([]);
    expect(plano.itens).toHaveLength(2);
  });

  it('QUASE-IGUAL — o MESMO `model_id` repetido num filho colapsa (dobra 3) e NÃO é forma divergente', () => {
    const plano = montarItensDePreco(
      familia({
        children: [
          filho('filho-1', [varLink(LINK_A, MODELO, 'var-1'), varLink(LINK_A, MODELO, 'var-2')]),
        ],
      }),
      INTEGRACAO,
    );
    expect(plano.pulos).toEqual([]);
    expect(plano.itens[0]?.modelos).toEqual([
      { modelId: MODELO, produtoId: 'filho-1', varLinkDocId: 'var-1' },
    ]);
  });

  it(`PAR — ${String(SHOPEE_UPDATE_PRICE_MAX_MODELS)} modelos cabem numa chamada e são planejados`, () => {
    const plano = montarItensDePreco(
      familia({ children: filhosComUmModeloCada(SHOPEE_UPDATE_PRICE_MAX_MODELS) }),
      INTEGRACAO,
    );
    expect(plano.pulos).toEqual([]);
    expect(plano.itens[0]?.modelos).toHaveLength(SHOPEE_UPDATE_PRICE_MAX_MODELS);
  });

  it(`⚠️ QUASE-IGUAL — ${String(SHOPEE_UPDATE_PRICE_MAX_MODELS + 1)} modelos ⇒ \`modelos-excedem-limite\`, recusado INTEIRO (nunca dividido) e com os modelos na linha`, () => {
    const n = SHOPEE_UPDATE_PRICE_MAX_MODELS + 1;
    const plano = montarItensDePreco(familia({ children: filhosComUmModeloCada(n) }), INTEGRACAO);
    expect(plano.itens).toEqual([]);
    expect(plano.pulos).toHaveLength(1);
    expect(plano.pulos[0]?.motivo).toBe(MOTIVO_PRECO_SHOPEE.modelosExcedemLimite);
    expect(plano.pulos[0]?.modelos).toHaveLength(n);
    expect(plano.pulos[0]?.itemId).toBe(ITEM_A);
  });

  it('a recusa de um anúncio não toca o vizinho: kit num vínculo, item no outro', () => {
    const plano = montarItensDePreco(
      familia({
        links: [link({ kitNativo: true }), link({ linkDocId: LINK_B, item_id: ITEM_B })],
      }),
      INTEGRACAO,
    );
    expect(plano.pulos.map((p) => [p.linkDocId, p.motivo])).toEqual([
      [LINK_A, MOTIVO_PRECO_SHOPEE.kitDerivado],
    ]);
    expect(plano.itens.map((i) => i.linkDocId)).toEqual([LINK_B]);
  });

  it('toda linha do plano é da ÂNCORA e usa um motivo do vocabulário', () => {
    const vocabulario = new Set<string>(Object.values(MOTIVO_PRECO_SHOPEE));
    const plano = montarItensDePreco(
      familia({
        links: [
          link({ item_id: 0 }),
          link({ linkDocId: LINK_B, item_id: ITEM_B, kitNativo: true }),
          link({ linkDocId: 'link-c', item_id: ITEM_B + 1, item_status: 'SELLER_DELETE' }),
        ],
      }),
      INTEGRACAO,
    );
    expect(plano.pulos).toHaveLength(3);
    for (const pulo of plano.pulos) {
      expect(pulo.produtoId).toBe(ANCORA);
      expect(vocabulario.has(pulo.motivo)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                                 THE PRICES                                  */
/* -------------------------------------------------------------------------- */

const ITEM_SEM_MODELOS: ItemPlanejadoPreco = {
  produtoId: ANCORA,
  linkDocId: LINK_A,
  itemId: ITEM_A,
  modelos: [],
};

const ITEM_COM_MODELOS: ItemPlanejadoPreco = {
  produtoId: ANCORA,
  linkDocId: LINK_A,
  itemId: ITEM_A,
  modelos: [
    { modelId: MODELO, produtoId: 'filho-1', varLinkDocId: 'var-1' },
    { modelId: MODELO + 1, produtoId: 'filho-2', varLinkDocId: 'var-2' },
  ],
};

describe('precosDaFamilia', () => {
  it('põe a âncora e CADA filho sob o SEU próprio id', () => {
    const mapa = precosDaFamilia(
      familia({
        precos: precos(10),
        children: [filho('filho-1', [], precos(12)), filho('filho-2', [], precos(13))],
      }),
    );
    expect([...mapa.keys()]).toEqual([ANCORA, 'filho-1', 'filho-2']);
    expect(mapa.get('filho-1')).toEqual(precos(12));
    expect(mapa.get(ANCORA)).toEqual(precos(10));
  });
});

describe('precificarItem', () => {
  it('um item SEM modelos ⇒ UM alvo no id sem-modelo (o NÚMERO zero), sem vínculo de modelo, com o preço da ÂNCORA', () => {
    const item = precificarItem(ITEM_SEM_MODELOS, new Map([[ANCORA, precos(10)]]), TABELA);
    expect(item).toEqual({
      produtoId: ANCORA,
      linkDocId: LINK_A,
      itemId: ITEM_A,
      semModelos: true,
      alvos: [{ modelId: 0, produtoId: ANCORA, varLinkDocId: null, precoAlvo: 10 }],
    });
    expect(item.alvos[0]?.modelId).toBe(SHOPEE_PRECO_MODEL_ID_SEM_MODELO);
  });

  it('⚠️ PAR (M51) — o preço de um MODELO é o do FILHO: filho 12, âncora 10 ⇒ 12', () => {
    const item = precificarItem(
      ITEM_COM_MODELOS,
      new Map([
        [ANCORA, precos(10)],
        ['filho-1', precos(12)],
        ['filho-2', precos(12)],
      ]),
      TABELA,
    );
    expect(item.semModelos).toBe(false);
    expect(item.alvos).toEqual([
      { modelId: MODELO, produtoId: 'filho-1', varLinkDocId: 'var-1', precoAlvo: 12 },
      { modelId: MODELO + 1, produtoId: 'filho-2', varLinkDocId: 'var-2', precoAlvo: 12 },
    ]);
  });

  it('⚠️ QUASE-IGUAL (M51) — um filho SEM preço fica `null`, nunca herda o da âncora', () => {
    const item = precificarItem(
      ITEM_COM_MODELOS,
      new Map([
        [ANCORA, precos(10)],
        ['filho-1', precos(12)],
      ]),
      TABELA,
    );
    expect(item.alvos.map((a) => a.precoAlvo)).toEqual([12, null]);
  });

  it('PAR — um preço de duas casas passa intacto (10.5 ⇒ 10.5) e um de três é arredondado ao centavo (10.567 ⇒ 10.57)', () => {
    const doisDecimais = precificarItem(
      ITEM_SEM_MODELOS,
      new Map([[ANCORA, precos(10.5)]]),
      TABELA,
    );
    expect(doisDecimais.alvos[0]?.precoAlvo).toBe(10.5);
    const tresDecimais = precificarItem(
      ITEM_SEM_MODELOS,
      new Map([[ANCORA, precos(10.567)]]),
      TABELA,
    );
    expect(tresDecimais.alvos[0]?.precoAlvo).toBe(10.57);
  });

  it('⚠️ QUASE-IGUAL — um preço SUB-CENTAVO (0.004) é "sem preço" (`null`), nunca um preço zero', () => {
    for (const valor of [0.004, 0, -1, Number.NaN, '10']) {
      const item = precificarItem(ITEM_SEM_MODELOS, new Map([[ANCORA, precos(valor)]]), TABELA);
      expect(item.alvos[0]?.precoAlvo).toBeNull();
    }
  });

  it('outra tabela, ou nenhum mapa para o produto, também é `null`', () => {
    const outraTabela = precificarItem(
      ITEM_SEM_MODELOS,
      new Map([[ANCORA, { 'tab-atacado': { valor: 10 } }]]),
      TABELA,
    );
    expect(outraTabela.alvos[0]?.precoAlvo).toBeNull();
    const semMapa = precificarItem(ITEM_SEM_MODELOS, new Map(), TABELA);
    expect(semMapa.alvos[0]?.precoAlvo).toBeNull();
  });

  it('os alvos seguem a ORDEM dos modelos planejados, um por modelo', () => {
    const item = precificarItem(ITEM_COM_MODELOS, new Map(), TABELA);
    expect(item.alvos.map((a) => a.modelId)).toEqual([MODELO, MODELO + 1]);
  });
});
