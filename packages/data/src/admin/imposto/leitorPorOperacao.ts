/**
 * **The `Imposto` a marketplace listing needs** — the shared cascade bound to
 * ONE operação reference, memoised for the length of one run.
 *
 * A marketplace sale IS a sale: the NF-e issued for an order placed on a
 * listing resolves its `Imposto` through the pedido's operação, and every order
 * importer stamps that operação from the conta's `integracao.operacaoOuterRef`.
 * So a listing that registers fiscal data with the marketplace (Mercado Livre's
 * `items/fiscal_information`, #745) must resolve through that SAME reference to
 * say what the nota will say. This module is that binding, promoted out of
 * `apps/shopee/lib/shopee/anuncios/lerImpostoDoProduto.ts` (Shopee step 11) when
 * the second channel needed it — the Shopee copy keeps its own motivo
 * vocabulary and is a follow-up to adopt this one.
 *
 * It hands back the operação document too, RAW, because the cascade picks ONE
 * tier whole and the nota then fills a missing CFOP/NCM/CEST/unidade from the
 * operação per field (`camposProdutoFiscal` in `@delfrance/schemas`). A caller
 * that skipped that second step would disagree with the nota exactly when a
 * produto's own tax config omits the NCM.
 *
 * ## Cost
 *
 * The bundle (the operação doc + its `regras`) is **2 reads**, paid once per
 * leitor and memoised as a PROMISE — two concurrent `ler()`s share one read, and
 * an absent operação is memoised as absent, so it costs one read per run rather
 * than one per produto. Each produto then costs up to 3 reads, memoised per id
 * by the resolver. A bulk caller creates ONE leitor for the whole batch.
 *
 * ## Purity, such as it is
 *
 * Reads only: no write, no clock, no transaction.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { parseRef, type Imposto } from '@delfrance/schemas';

import { createFirestoreImpostoResolver, lerResolverBundle } from './firestoreImpostoResolver';
import type { ImpostoResolver } from './resolverImposto';

/** Why a `ler()` produced no `Imposto`. */
export const MOTIVO_LEITURA_IMPOSTO = {
  /** The conta names no operação at all — an ordinary, expected state. */
  semOperacao: 'sem-operacao',
  /** The conta names an operação whose document does not exist. */
  operacaoInexistente: 'operacao-inexistente',
  /** Every tier of the cascade fell through for this produto. */
  semImposto: 'sem-imposto',
} as const;
export type MotivoLeituraImposto =
  (typeof MOTIVO_LEITURA_IMPOSTO)[keyof typeof MOTIVO_LEITURA_IMPOSTO];

export type LeituraImposto =
  | {
      readonly imposto: Imposto;
      /** The operação document, RAW — the per-field fallback reads it. */
      readonly operacao: Readonly<Record<string, unknown>> | null;
      readonly motivo: null;
    }
  | { readonly imposto: null; readonly operacao: null; readonly motivo: MotivoLeituraImposto };

export interface LeitorDeImpostoPorOperacao {
  /** Resolve the `Imposto` for ONE produto id. Memoised per instance. */
  ler(produtoId: string): Promise<LeituraImposto>;
}

export interface DepsLeitorDeImposto {
  readonly db: Firestore;
  /** The conta's `operacaoOuterRef`, verbatim off the loaded Integração. */
  readonly operacaoOuterRef: string | null;
}

type Carregado =
  | {
      readonly ok: true;
      readonly resolvedor: ImpostoResolver;
      readonly operacao: Readonly<Record<string, unknown>> | null;
    }
  | { readonly ok: false; readonly motivo: MotivoLeituraImposto };

/**
 * Build the leitor for one operação reference.
 *
 * ⚠️ No `operacaoOuterRef` ⇒ every `ler()` answers `sem-operacao` having
 * performed **zero reads**; it is `.nullable().default(null)` on the conta, so a
 * conta never pointed at an operação is expected, not an error — and not a
 * reason to go shopping for a default.
 *
 * ⚠️ The id is the ref's trailing segment through `parseRef`, never a local
 * `split('/')`: the corpus carries `documents/operacao/<id>`, `operacao/<id>`
 * and bare ids, and all three must resolve.
 *
 * ⚠️ `itemImposto` is ALWAYS `null` here. That argument is the cascade's tier
 * 1 — the imposto stamped on a pedido item — and a listing has no pedido.
 */
export function criarLeitorDeImpostoPorOperacao(
  deps: DepsLeitorDeImposto,
): LeitorDeImpostoPorOperacao {
  const { db, operacaoOuterRef } = deps;
  let carregamento: Promise<Carregado> | null = null;

  async function carregar(): Promise<Carregado> {
    if (operacaoOuterRef == null) return { ok: false, motivo: MOTIVO_LEITURA_IMPOSTO.semOperacao };
    const { id } = parseRef(operacaoOuterRef);
    if (id.length === 0) return { ok: false, motivo: MOTIVO_LEITURA_IMPOSTO.semOperacao };
    const bundle = await lerResolverBundle(db, id);
    if (bundle == null) return { ok: false, motivo: MOTIVO_LEITURA_IMPOSTO.operacaoInexistente };
    return {
      ok: true,
      resolvedor: createFirestoreImpostoResolver(db, bundle),
      operacao: bundle.operacao ?? null,
    };
  }

  return {
    async ler(produtoId: string): Promise<LeituraImposto> {
      carregamento ??= carregar();
      const carregado = await carregamento;
      if (!carregado.ok) return { imposto: null, operacao: null, motivo: carregado.motivo };
      const imposto = await carregado.resolvedor.resolve(produtoId, null);
      if (imposto == null) {
        return { imposto: null, operacao: null, motivo: MOTIVO_LEITURA_IMPOSTO.semImposto };
      }
      return { imposto, operacao: carregado.operacao, motivo: null };
    },
  };
}
