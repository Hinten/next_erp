/**
 * The price job's queue entry (`envioPrecoShopeeFilaItemSchema`, in
 * `@delfrance/schemas`) IS the planner's `ItemPlanejadoPreco` — reconcile §2.2.
 *
 * The planner declares the interface here and the schema declares the stored
 * shape there; `packages/schemas` cannot import this app, so the pin lives on
 * the side that can see both. Two declarations of one shape with a comment
 * claiming they agree is the drift root `CLAUDE.md` names (#1369) — this file
 * is what makes the claim compiler-checked.
 *
 * Checked by `tsc` (the app's `typecheck` covers every `*.test.ts`); the
 * runtime half proves the value the planner builds survives a parse unchanged.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  envioPrecoShopeeFilaItemSchema,
  type EnvioPrecoShopeeFilaItem,
  type EnvioPrecoShopeeModelo,
} from '@delfrance/schemas';

import type { VarLinkShopeeCru } from '../core/vinculosShopee';
import {
  type ItemPlanejadoPreco,
  type ModeloPlanejadoPreco,
  montarItensDePreco,
  precificarItem,
} from './planoPreco';

/** The declared fields only — drops the `.passthrough()` index signature. */
type SemIndice<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/**
 * A shape reduced to its FIELDS: `readonly` stripped (deep) and the index
 * signature dropped, so a `readonly` interface and a Zod output type compare by
 * name and type of every field — the only difference the two are allowed.
 */
type Campos<T> = T extends readonly (infer E)[]
  ? Campos<E>[]
  : T extends object
    ? { -readonly [K in keyof SemIndice<T>]: Campos<SemIndice<T>[K]> }
    : T;

const INTEGRACAO = 'int-1';
const ANCORA = 'prod-ancora';
const LINK = 'link-a';
const ITEM = 2500139861;
const MODELO = 2000458802;

function varLink(modelId: number, varLinkDocId: string): VarLinkShopeeCru {
  return {
    contaVariacaoShopeeOuterRef: `integracoes/${INTEGRACAO}`,
    produtoShopeeOuterRef: `produtos/${ANCORA}/prodshopee/${LINK}`,
    model_id: modelId,
    varLinkDocId,
  };
}

const LINK_DA_CONTA = {
  contaProdutoShopeeOuterRef: `integracoes/${INTEGRACAO}`,
  item_id: ITEM,
  linkDocId: LINK,
};

describe('fila do job ≡ ItemPlanejadoPreco', () => {
  it('PAIR — the stored entry and the planned item carry the SAME fields (type level)', () => {
    expectTypeOf<Campos<EnvioPrecoShopeeFilaItem>>().toEqualTypeOf<Campos<ItemPlanejadoPreco>>();
    expectTypeOf<Campos<EnvioPrecoShopeeModelo>>().toEqualTypeOf<Campos<ModeloPlanejadoPreco>>();
  });

  it('a queue entry read back is directly a planned item — the drain prices it with no cast', () => {
    expectTypeOf<EnvioPrecoShopeeFilaItem>().toExtend<ItemPlanejadoPreco>();
    expectTypeOf(precificarItem).parameter(0).toEqualTypeOf<ItemPlanejadoPreco>();
    const lido = envioPrecoShopeeFilaItemSchema.parse({
      produtoId: ANCORA,
      linkDocId: LINK,
      itemId: ITEM,
      modelos: [],
    });
    expect(precificarItem(lido, new Map(), 'tab-normal').itemId).toBe(ITEM);
  });

  it('NEAR-MISS — a field only one side declares breaks the equality', () => {
    // The guard is not vacuous: a price frozen into the entry (the ML shape the
    // daily park made unsafe) or the cut `categoryId` is a DIFFERENT shape.
    expectTypeOf<Campos<EnvioPrecoShopeeFilaItem & { preco: number }>>().not.toEqualTypeOf<
      Campos<ItemPlanejadoPreco>
    >();
    expectTypeOf<
      Campos<Omit<EnvioPrecoShopeeFilaItem, 'itemId'> & { itemId: string }>
    >().not.toEqualTypeOf<Campos<ItemPlanejadoPreco>>();
  });

  it('every item the planner builds survives the fila parse UNCHANGED — no-model and has-model', () => {
    const semModelos = montarItensDePreco(
      { anchorId: ANCORA, precos: null, links: [LINK_DA_CONTA], children: [] },
      INTEGRACAO,
    );
    const comModelos = montarItensDePreco(
      {
        anchorId: ANCORA,
        precos: null,
        links: [LINK_DA_CONTA],
        children: [
          { produtoId: 'filho-1', precos: null, varLinks: [varLink(MODELO, 'var-1')] },
          { produtoId: 'filho-2', precos: null, varLinks: [varLink(MODELO + 1, 'var-2')] },
        ],
      },
      INTEGRACAO,
    );
    const itens = [...semModelos.itens, ...comModelos.itens];
    // Anchor: both shapes were really planned (an empty plan would pass vacuously).
    expect(itens.map((item) => item.modelos.length)).toEqual([0, 2]);
    for (const item of itens) {
      expect(envioPrecoShopeeFilaItemSchema.parse(item)).toEqual(item);
    }
  });
});
