/**
 * **The `Imposto` one publish needs** — the shared five-tier cascade, bound to
 * a Shopee conta, memoised for the length of one publish.
 *
 * `taxInfoPublicacao.ts` turns an `Imposto` into Shopee's `tax_info` block and
 * touches nothing; this module is the half that reads. Both halves exist
 * because the cascade itself is NOT ours: it lives in
 * `@delfrance/data/admin/imposto`, promoted there from `apps/nfe` precisely so
 * a marketplace listing and the nota fiscal for a sale off that listing resolve
 * the same tax config instead of two copies drifting toward plausible.
 *
 * ## ⚠️ The PARENT produto id, always
 *
 * Shopee's `tax_info` is **item-level**. There is no per-model fiscal block
 * anywhere on the wire — not on `add_item`, not on `update_item`, not on
 * `init_tier_variation`, not on `add_model`. A child produto's own
 * `produtos/{childId}/imposto` subcollection is therefore ignored **by
 * construction**, and that is a recorded consequence of the wire's shape, not
 * an oversight. Callers pass the family's parent id; passing a child's would
 * resolve a cascade nobody can send.
 *
 * ## ⚠️ Which operação — and why the conta's pedido operação is the RIGHT one
 *
 * The Shopee master plan recorded, from step 9's position, that
 * `integracao.operacaoOuterRef` is the **pedido** operação and warned that
 * reusing it *"would have bound the fiscal block to the wrong operação"*. That
 * was written when the field had no consumer. Step 11's position is different,
 * and the reasoning belongs in the code: **a marketplace sale IS a sale.** The
 * NF-e this shop will issue for an order placed on this listing resolves its
 * `Imposto` through exactly this operação — the order importer stamps the
 * pedido's operação from `conta.operacaoOuterRef`, and the NF-e bundle builds
 * its resolver from the pedido's operação. So Shopee's informational copy
 * agreeing with the nota that will be issued is the **desirable** property, not
 * an accident of reuse.
 *
 * A dedicated publish operação would be a new `integracao` field plus a
 * conta-form change. It is not needed to be correct here, and nothing about
 * this module blocks it later: one deps field changes.
 *
 * ## ⚠️ Cost, and where to hoist it
 *
 * Per instance: **2 reads** for the bundle (the operação document plus its
 * `regras` subcollection), paid once and memoised — including memoised as
 * *absent*, so a missing operação costs one read for the whole publish rather
 * than one per call. Per produto after that: **up to 3** (the produto document,
 * its `imposto` subcollection, its categoria's `imposto` subcollection), and
 * the promoted resolver memoises those per produto id.
 *
 * One publish creates one leitor. A future BULK publish must create ONE leitor
 * for the whole batch — that is the only reason the memo is per instance rather
 * than per call.
 *
 * ## Purity, such as it is
 *
 * This module reads. It never writes, never takes a clock and never opens a
 * transaction — every read goes through an Admin collection handle inside
 * `@delfrance/data/admin/imposto`, and the cascade's own drop-on-invalid policy
 * (a config document that fails its schema never reaches a tier) is inherited
 * whole.
 */
import type { Firestore } from 'firebase-admin/firestore';

import {
  createFirestoreImpostoResolver,
  lerResolverBundle,
  type ImpostoResolver,
} from '@delfrance/data/admin/imposto';
import { parseRef, type Imposto } from '@delfrance/schemas';

import { MOTIVO_TAX_INFO_OMITIDO, type MotivoTaxInfoOmitido } from './taxInfoPublicacao';

export interface DepsImpostoShopee {
  readonly db: Firestore;
  /** `conta.operacaoOuterRef`, verbatim off the loaded Integração. */
  readonly operacaoOuterRef: string | null;
}

/**
 * The resolved `Imposto`, or the reason there is none — the same vocabulary
 * `montarTaxInfo` answers with, so a caller has ONE `taxInfoOmitido` to record
 * whichever half refused.
 */
export interface ResultadoLeituraImposto {
  readonly imposto: Imposto | null;
  readonly motivo: MotivoTaxInfoOmitido | null;
}

export interface LeitorDeImpostoShopee {
  /** Resolve the item-level `Imposto` for the PARENT produto. Memoised per instance. */
  ler(produtoPaiId: string): Promise<ResultadoLeituraImposto>;
}

/**
 * Build the leitor for one conta.
 *
 * ⚠️ No `operacaoOuterRef` ⇒ every `ler()` answers `sem-operacao` having
 * performed **zero reads**. `integracao.operacaoOuterRef` is
 * `.nullable().default(null)`, so a conta that was never pointed at an operação
 * is an ordinary, expected state — not an error, and not a reason to go
 * shopping for a default.
 *
 * ⚠️ The operação id is the ref's **trailing segment**, taken through the
 * schemas' `parseRef` — the same helper `contaIdFromRef` uses. Never a local
 * `split('/')`: the corpus carries the canonical `documents/operacao/<id>`, the
 * bare `operacao/<id>` readers accept defensively, and legacy rows that stored
 * just the id. All three resolve here, which is exactly why the collection
 * segment is NOT checked — a bare id has none, and refusing it would refuse a
 * usable ref.
 */
export function criarLeitorDeImpostoShopee(deps: DepsImpostoShopee): LeitorDeImpostoShopee {
  const { db, operacaoOuterRef } = deps;

  // The memo is a PROMISE, not a resolved value: two `ler()` calls awaited
  // concurrently must share one bundle read, and a boolean flag set after the
  // await would let both slip through. `null` inside the promise is the
  // memoised ABSENCE — no operação, and no second attempt to find one.
  let carregamento: Promise<ImpostoResolver | null> | null = null;

  async function carregarResolvedor(): Promise<ImpostoResolver | null> {
    if (operacaoOuterRef == null) return null;
    const { id } = parseRef(operacaoOuterRef);
    if (id.length === 0) return null;
    const bundle = await lerResolverBundle(db, id);
    return bundle == null ? null : createFirestoreImpostoResolver(db, bundle);
  }

  return {
    async ler(produtoPaiId: string): Promise<ResultadoLeituraImposto> {
      carregamento ??= carregarResolvedor();
      const resolvedor = await carregamento;
      if (resolvedor == null) {
        return { imposto: null, motivo: MOTIVO_TAX_INFO_OMITIDO.semOperacao };
      }

      // ⚠️ `itemImposto` is ALWAYS null here. That parameter is the cascade's
      // tier 1 — the imposto stamped on a pedido item — and there is no pedido
      // on a publish. Passing anything else would stamp a listing with a tax
      // config no sale had.
      const imposto = await resolvedor.resolve(produtoPaiId, null);
      if (imposto == null) {
        return { imposto: null, motivo: MOTIVO_TAX_INFO_OMITIDO.semImposto };
      }
      return { imposto, motivo: null };
    },
  };
}
