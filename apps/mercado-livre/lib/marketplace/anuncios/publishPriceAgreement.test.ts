/**
 * Publish and the price sync, on the SAME family.
 *
 * `assemblePublishInput` (what a publish lists) and `buildPrecoDrafts` (what
 * "Atualizar preços" sends) each decide the price of every ML item a family
 * owns. Both now read it through `@delfrance/schemas` — `precoDaTabela` for the
 * anchor, `precoDoFilhoNaTabela` for a User-Products member — so they agree
 * because they call one function, not because a comment says they do. Before,
 * publish read the raw stored `valor`: a `7.891` was listed at `7.891` while the
 * sync sent `7.89`, and a `0.004` was listed at all.
 *
 * Each case builds ONE family, hands it to both, and compares the price each
 * puts on every ML item — read off the real wire body on the publish side
 * (`buildItemPayload` / `buildUserProductItemPayload`), off the draft on the
 * sync side. `null` is "no price": a `PRECO_NAO_ENCONTRADO` skip on the sync
 * side, a blocking issue on the publish side (publish is all-or-nothing, so the
 * whole family refuses, naming the produto that has none).
 */
import { describe, expect, it } from 'vitest';
import {
  buildItemPayload,
  buildUserProductItemPayload,
  userProductMemberInputs,
} from '@delfrance/integrations-mercado-livre';
import { propagaPrecoAosFilhos, toOuterRef } from '@delfrance/schemas';
import { produtoMercadoLivreLinkCollection } from '@delfrance/data/admin/collections';

import { type PrecoFamilyRow, buildPrecoDrafts } from '../preco/precoPlan';
import { MercadoLivrePublishError, type PublishProduto, assemblePublishInput } from './publishCore';

const TAB = 'tabNormal1';
const PAI = 'PROD';
const LINK = 'link1';

type Precos = Record<string, { valor: number }> | null;

interface Familia {
  /** User-Products (one ML item per member) vs the legacy model (one item). */
  userProducts: boolean;
  precosPai: Precos;
  /** The PARENT's stored flag, raw — each side folds it on its own. */
  propagate?: boolean | null;
  filhos: Array<{ id: string; precos: Precos }>;
}

/** The price each ML item gets, keyed by the produto that item sells. */
type Precificacao = Record<string, number | null>;

const valor = (v: number): Precos => ({ [TAB]: { valor: v } });

const pai = (f: Familia): PublishProduto => ({
  id: PAI,
  nome: 'Camiseta',
  sku: 'SKU-1',
  ehUsado: false,
  pesoLiquidoKg: 0.3,
  pesoBrutoKg: 0.4,
  alturaCm: 5,
  larguraCm: 30,
  profundidadeCm: 40,
  precos: f.precosPai,
  propagatePriceToChildren: f.propagate,
});

/** What a first publish would put on the wire, or the issues it refuses with. */
function publicar(f: Familia): { precos: Precificacao } | { recusa: string[] } {
  const anchor = pai(f);
  let input;
  try {
    input = assemblePublishInput({
      produto: anchor,
      condicao: 1,
      marca: null,
      priceListId: TAB,
      priceListNome: null,
      availableQuantity: 10,
      pictures: [{ id: 'IMG1' }],
      variations: f.filhos.map((c) => ({
        produto: {
          ...anchor,
          id: c.id,
          nome: `Camiseta ${c.id}`,
          sku: `SKU-1-${c.id}`,
          precos: c.precos,
          propagatePriceToChildren: null,
        },
        variacoesUid: [`documents/grupoDeVariacoes/g-tam/variacoes/v-${c.id}`],
        availableQuantity: 1,
        mlVariationId: null,
      })),
      grupos: [
        {
          grupoId: 'g-tam',
          nome: 'Tamanho',
          tipo: 1,
          variacoes: f.filhos.map((c) => ({ id: `v-${c.id}`, nome: c.id })),
        },
      ],
      link: null,
      linkDocId: LINK,
      categoryId: 'MLB31447',
      listingTypeId: 'gold_special',
      isUserProductSeller: f.userProducts,
    });
  } catch (err) {
    if (err instanceof MercadoLivrePublishError) return { recusa: err.issues };
    throw err;
  }

  if (f.userProducts && f.filhos.length > 0) {
    // One ML item per member, each POSTed with its own body.
    return {
      precos: Object.fromEntries(
        userProductMemberInputs(input).map((m) => [
          m.member.produtoId,
          (buildUserProductItemPayload({ ...m, isUpdate: false }).price as number | undefined) ??
            null,
        ]),
      ),
    };
  }
  // One ML item. A legacy family's variations carry the item price, and ML
  // accepts only ONE price across them.
  const body = buildItemPayload(input) as {
    price?: number;
    variations?: Array<{ price?: number }>;
  };
  const doItem = body.variations ? [...new Set(body.variations.map((v) => v.price))] : [body.price];
  expect(doItem).toHaveLength(1);
  return { precos: { [PAI]: doItem[0] ?? null } };
}

/** What "Atualizar preços" would send for the same family's live listing. */
function sincronizar(f: Familia): Precificacao {
  const row: PrecoFamilyRow = {
    produtoId: PAI,
    precos: f.precosPai,
    // What `fetchPrecoPage` hands the plan: the stored flag through the same fold.
    propagatePriceToChildren: propagaPrecoAosFilhos(f.propagate),
    publicado: true,
    paiId: null,
    links: [
      {
        linkDocId: LINK,
        id: 'MLB-PAI',
        estado: 'p',
        status: 'active',
        sub_status: null,
        isUserProductModel: f.userProducts,
      },
    ],
    children: f.filhos.map((c) => ({
      produtoId: c.id,
      precos: c.precos,
      varLinks: [
        {
          docId: `var-${c.id}`,
          itemId: `MLB-${c.id}`,
          produtoMercadoLivreOuterRef: toOuterRef(
            produtoMercadoLivreLinkCollection.docPath({ produtoId: PAI }, LINK),
          ),
        },
      ],
    })),
  };
  const { drafts, skips } = buildPrecoDrafts(row, { integracaoId: 'conta-A', tabelaNormalId: TAB });
  const out: Precificacao = {};
  for (const d of drafts) out[d.variacaoProdutoId ?? d.produtoId] = d.preco;
  for (const s of skips) {
    expect(s.code).toBe('PRECO_NAO_ENCONTRADO');
    out[s.produtoId] = null;
  }
  return out;
}

/** Both sides priced every item, and identically. */
function concordam(f: Familia, esperado: Precificacao): void {
  expect(sincronizar(f)).toEqual(esperado);
  expect(publicar(f)).toEqual({ precos: esperado });
}

const SEM_PRECO = (nome: string) => `produto "${nome}" sem preço na tabela ${TAB}`;

// Children whose own maps DIFFER from the anchor's — stale under propagation,
// so a side that read them would be caught.
const FILHOS_PROPRIOS = [
  { id: 'M', precos: valor(60) },
  { id: 'G', precos: valor(70) },
];

/** Every shape a family can publish as, and which items each one prices. */
const FORMATOS: Array<{
  nome: string;
  userProducts: boolean;
  itens: (preco: number | null) => Precificacao;
  filhos: Familia['filhos'];
}> = [
  { nome: 'a single item', userProducts: false, filhos: [], itens: (p) => ({ [PAI]: p }) },
  {
    nome: 'a legacy family',
    userProducts: false,
    filhos: FILHOS_PROPRIOS,
    itens: (p) => ({ [PAI]: p }),
  },
  {
    nome: 'a User-Products single',
    userProducts: true,
    filhos: [],
    itens: (p) => ({ [PAI]: p }),
  },
  {
    nome: 'a User-Products family',
    userProducts: true,
    filhos: FILHOS_PROPRIOS,
    itens: (p) => ({ M: p, G: p }),
  },
];

describe('publish and the price sync price the SAME family the same way', () => {
  describe('rounding (precoDaTabela on both sides)', () => {
    it.each(FORMATOS)('PAIR: $nome — a stored 7.891 lists at 7.89, what the sync sends', (fmt) => {
      concordam({ ...fmt, precosPai: valor(7.891) }, fmt.itens(7.89));
    });

    it.each(FORMATOS)('PAIR: $nome — 7.891 and 7.89 are the same centavo', (fmt) => {
      concordam({ ...fmt, precosPai: valor(7.89) }, fmt.itens(7.89));
    });

    it.each(FORMATOS)('NEAR-MISS: $nome — 7.899 lists at 7.9, never folded into 7.89', (fmt) => {
      concordam({ ...fmt, precosPai: valor(7.899) }, fmt.itens(7.9));
    });

    it('User-Products, own prices: members round independently — 7.891 ≡ 7.894, 7.899 stays a centavo apart', () => {
      concordam(
        {
          userProducts: true,
          precosPai: valor(50),
          propagate: false,
          filhos: [
            { id: 'M', precos: valor(7.891) },
            { id: 'G', precos: valor(7.894) },
            { id: 'GG', precos: valor(7.899) },
          ],
        },
        { M: 7.89, G: 7.89, GG: 7.9 },
      );
    });
  });

  describe('sub-centavo (positivity AFTER rounding, on both sides)', () => {
    it.each(FORMATOS)(
      '$nome — an anchor 0.004 is NO price: the sync skips, publish refuses naming the parent once',
      (fmt) => {
        const f = { ...fmt, precosPai: valor(0.004) };
        expect(sincronizar(f)).toEqual(fmt.itens(null));
        expect(publicar(f)).toEqual({ recusa: [SEM_PRECO('Camiseta')] });
      },
    );

    it.each(FORMATOS)(
      'NEAR-MISS: $nome — an anchor 0.005 rounds UP to 0.01 and IS a price',
      (fmt) => {
        concordam({ ...fmt, precosPai: valor(0.005) }, fmt.itens(0.01));
      },
    );

    it('User-Products, own prices: a 0.004 member has no price on either side — and only THAT member is named', () => {
      const f: Familia = {
        userProducts: true,
        precosPai: valor(50),
        propagate: false,
        filhos: [
          { id: 'M', precos: valor(0.004) },
          { id: 'G', precos: valor(10) },
        ],
      };
      // The sync still sends the sibling; publish is all-or-nothing. Both say
      // the same thing about M.
      expect(sincronizar(f)).toEqual({ M: null, G: 10 });
      expect(publicar(f)).toEqual({ recusa: [SEM_PRECO('Camiseta M')] });
    });
  });

  describe('propagation (propagaPrecoAosFilhos → precoDoFilhoNaTabela)', () => {
    it.each([undefined, null, true])(
      'PAIR: User-Products, flag %s propagates — every member at the ANCHOR price, own maps ignored',
      (propagate) => {
        concordam(
          { userProducts: true, precosPai: valor(50.004), propagate, filhos: FILHOS_PROPRIOS },
          { M: 50, G: 50 },
        );
      },
    );

    it('NEAR-MISS: User-Products, a stored literal false — each member at its OWN price', () => {
      concordam(
        { userProducts: true, precosPai: valor(50), propagate: false, filhos: FILHOS_PROPRIOS },
        { M: 60, G: 70 },
      );
    });

    it('legacy: the flag changes nothing — ML takes ONE price, the anchor’s', () => {
      for (const propagate of [true, false]) {
        concordam(
          { userProducts: false, precosPai: valor(50), propagate, filhos: FILHOS_PROPRIOS },
          { [PAI]: 50 },
        );
      }
    });

    it('propagating from an UNPRICED anchor: no member priced on either side — the own map is never a fallback', () => {
      const f: Familia = {
        userProducts: true,
        precosPai: null,
        propagate: true,
        filhos: FILHOS_PROPRIOS,
      };
      expect(sincronizar(f)).toEqual({ M: null, G: null });
      expect(publicar(f)).toEqual({ recusa: [SEM_PRECO('Camiseta')] });
    });

    it('PAIR (#1698): own prices under an UNPRICED anchor — the anchor is never sent, so it gates nothing', () => {
      // No User-Products member body carries the anchor's price on this arm, and
      // a family stamps no `precoPublicado`. Publish used to require it anyway and
      // refuse a family the sync prices; the line above is this case's near-miss —
      // the same unpriced anchor under propagation still refuses on both sides.
      concordam(
        { userProducts: true, precosPai: null, propagate: false, filhos: FILHOS_PROPRIOS },
        { M: 60, G: 70 },
      );
    });

    it('PAIR: a family of ONE, own price under an UNPRICED anchor — published like any family', () => {
      concordam(
        {
          userProducts: true,
          precosPai: null,
          propagate: false,
          filhos: [{ id: 'M', precos: valor(60) }],
        },
        { M: 60 },
      );
    });

    it('a family of ONE with NO price anywhere still refuses — naming the MEMBER, never the parent', () => {
      // The `adotar` shape: `garantirMembroUnico` gives the sole member a COPY of
      // the parent's `precos`, so an unpriced parent means an unpriced member. The
      // relaxed anchor must not let it through with nothing on the wire.
      const f: Familia = {
        userProducts: true,
        precosPai: null,
        propagate: false,
        filhos: [{ id: 'M', precos: null }],
      };
      expect(sincronizar(f)).toEqual({ M: null });
      expect(publicar(f)).toEqual({ recusa: [SEM_PRECO('Camiseta M')] });
    });

    it.each(FORMATOS.filter((fmt) => fmt.nome !== 'a User-Products family'))(
      'NEAR-MISS: $nome under a stored false — an UNPRICED anchor still refuses on both sides, naming the parent',
      (fmt) => {
        // Only a User-Products family with members prices off the children. A
        // legacy family sends ONE price, the anchor's, and a childless listing IS
        // the anchor — the flag changes nothing for either.
        const f: Familia = { ...fmt, precosPai: null, propagate: false };
        expect(sincronizar(f)).toEqual(fmt.itens(null));
        expect(publicar(f)).toEqual({ recusa: [SEM_PRECO('Camiseta')] });
      },
    );
  });
});
