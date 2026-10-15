import { getDoc, type Firestore } from 'firebase/firestore';
import {
  isFreteMarketplaceOwned,
  type FreteDoPedido,
  type IntFrete,
  type IntegracaoFrete,
} from '@delfrance/schemas';

import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';

import type { IntFreteResolvido } from './types';

/**
 * WHICH freight integration an etiqueta action dispatches on (#1523, R-q) — the
 * one rule behind all three entry points (the checkout post-save, the "Outros
 * Checkouts" reprint and the `/pedidos` row action), which used to each read
 * `integracaoFreteOuterRef` and give up without it.
 *
 * ## The rule: a marketplace-owned BLOCK tipo wins
 *
 * The frete block's `externalOptionIntegracao` names a marketplace-owned tipo
 * (`isFreteMarketplaceOwned` — Mercado Livre, Shopee, …) ⇒ that tipo is the
 * dispatch, with or without an `int_frete` document:
 *   - the document is used only when it names the SAME tipo (`fonte: 'doc'`);
 *   - otherwise — no ref, a dangling ref, or a document of another tipo — the
 *     block alone answers (`fonte: 'bloco'`).
 *
 * Why the block and not the document: both label routes already key on it.
 * Mercado Livre's refuses a pedido whose block is not ML
 * (`apps/mercado-livre/app/api/marketplace/mercado-livre/etiqueta/route.ts`),
 * and Shopee's refuses one whose block names any other tipo
 * (`apps/shopee/lib/shopee/etiqueta/alvoEtiqueta.ts`) — so dispatching on a
 * document that disagrees would only reach a route that says no. A Shopee
 * pedido imported by THIS app carries no `int_frete` ref (step 5 sets none),
 * and an imported ML pedido whose ref was degraded to null is the same case.
 * ⚠️ A MIGRATED legacy Shopee pedido does carry one — the legacy FreteShopee
 * document's — and dispatches as `'doc'` when that document's tipo is
 * `shopee`; the Shopee provider reads neither, so nothing here may assume
 * "Shopee ⇒ `'bloco'`".
 *
 * ⚠️ It WIDENS, never narrows. A block naming a NON-marketplace tipo (Melhor
 * Envio, motoboy, …) changes nothing: the document decides exactly as before,
 * and no document ⇒ `null` ("sem integração"), as before. A manual pedido
 * cannot reach the marketplace arm either — the generic tipo Select offers no
 * marketplace tipo, and a duplicated marketplace pedido loses its block tipo
 * (`FRETE_QUOTE_RESET_KEYS`).
 */

/**
 * `isFreteMarketplaceOwned` as a type guard. Sound because `freightCapsFor`
 * answers the all-`false` caps for any string outside `IntegracaoFrete` (a
 * legacy value, a typo, `null`), so `true` is only ever answered for a real
 * tipo.
 */
function ehTipoDeMarketplace(tipo: string | null | undefined): tipo is IntegracaoFrete {
  return isFreteMarketplaceOwned(tipo);
}

/**
 * The tipo the action DISPATCHES on, from the two tipos a caller already holds
 * — the row action's cached `int_frete` tipo and the pedido's block. A
 * marketplace-owned block tipo wins; otherwise the document's tipo, or `null`.
 *
 * ⚠️ `docTipo` is the unparsed Firestore string, exactly as every caller holds
 * it today; an unknown legacy value passes through unchanged and the registry
 * tolerates it (`freightCapsFor`).
 */
export function tipoDeDespacho(
  docTipo: string | null | undefined,
  blocoTipo: string | null | undefined,
): IntegracaoFrete | null {
  if (ehTipoDeMarketplace(blocoTipo)) return blocoTipo;
  return (docTipo ?? null) as IntegracaoFrete | null;
}

/**
 * The rule itself, pure: the `int_frete` document (or `null` when there is
 * none) and the block's tipo ⇒ the resolved integration, or `null` when nothing
 * names one.
 */
export function decidirIntFrete(
  doc: { id: string; data: IntFrete } | null,
  blocoTipo: string | null | undefined,
): IntFreteResolvido | null {
  if (ehTipoDeMarketplace(blocoTipo)) {
    return doc !== null && doc.data.tipo === blocoTipo
      ? { fonte: 'doc', id: doc.id, tipo: doc.data.tipo, data: doc.data }
      : { fonte: 'bloco', id: null, tipo: blocoTipo, data: null };
  }
  // Not a marketplace block: today's behaviour, unchanged (ME / generic / manual).
  return doc !== null ? { fonte: 'doc', id: doc.id, tipo: doc.data.tipo, data: doc.data } : null;
}

/**
 * Read the pedido's `int_frete` document (when its ref names one) and apply
 * {@link decidirIntFrete}. ONE `getDoc` at most, and none when the ref is
 * absent — so a caller's deadline around it bounds the same I/O it did before.
 */
export async function resolverIntFrete(
  db: Firestore,
  frete: FreteDoPedido | null,
): Promise<IntFreteResolvido | null> {
  if (frete === null) return null;
  const ref = dereferenceOuterRef(db, frete.integracaoFreteOuterRef);
  let doc: { id: string; data: IntFrete } | null = null;
  if (ref !== null) {
    const snap = await getDoc(ref);
    // A generic ref reads untyped data; `IntFrete` is the collection's shape,
    // cast exactly as the per-screen copies this replaces did.
    if (snap.exists()) doc = { id: snap.id, data: snap.data() as IntFrete };
  }
  return decidirIntFrete(doc, frete.externalOptionIntegracao);
}
