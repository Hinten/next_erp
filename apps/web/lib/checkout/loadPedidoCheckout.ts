import { getDoc, getDocs, type Firestore } from 'firebase/firestore';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import {
  flattenPedidoItens,
  type EngineProduto,
  type Incidente,
  type ItemDoPedido,
  type Pedido,
  type Produto,
} from '@delfrance/schemas';
import { pedidoCollection } from '../data/pedidoCollection';
import { produtoCollection } from '../data/produtoCollection';
import { checkoutCollection } from '../data/checkoutCollection';
import { incidenteCollection } from '../data/incidenteCollection';
import { getDocsByIds } from '../data/getDocsByIds';

/** A pedido the finder resolved from typed/scanned text. */
export interface PedidoCandidate {
  id: string;
  numero: string | null;
}

export type FindPedidoResult =
  | { kind: 'none' }
  | { kind: 'one'; candidate: PedidoCandidate }
  | { kind: 'many'; candidates: PedidoCandidate[] };

/**
 * Resolve typed/scanned text to a **saída** pedido — by doc id AND by `numero`,
 * deduped by id. Port of `_findPedido` (`checkout.dart:423`): 0 hits → `none`,
 * exactly 1 → `one`, >1 → `many` (the UI shows a picker). Only `ehSaida` pedidos
 * qualify (checkout is dispatch, never an entrada).
 */
export async function findPedidoCandidates(db: Firestore, text: string): Promise<FindPedidoResult> {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'none' };

  const found = new Map<string, PedidoCandidate>();

  // By doc id — but a doc id can't contain '/', which would make an invalid ref.
  if (!trimmed.includes('/')) {
    const byId = await getDoc(pedidoCollection.docRef(db, {}, trimmed));
    if (byId.exists() && byId.data().ehSaida) {
      found.set(byId.id, { id: byId.id, numero: byId.data().numero });
    }
  }

  // By numero (saída only).
  const byNumero = await getDocs(
    buildQuery(pedidoCollection.ref(db, {}), [
      whereEqual('numero', trimmed),
      whereEqual('ehSaida', true),
    ]),
  );
  for (const d of byNumero.docs) found.set(d.id, { id: d.id, numero: d.data().numero });

  const candidates = [...found.values()];
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'one', candidate: candidates[0]! };
  return { kind: 'many', candidates };
}

/** The pedido id passed to `loadCheckoutData` resolved to no document. */
export class CheckoutPedidoNotFoundError extends Error {
  constructor(readonly pedidoId: string) {
    super(`Pedido ${pedidoId} não encontrado`);
    this.name = 'CheckoutPedidoNotFoundError';
  }
}

/** Everything the checkout screen needs to build its engine state and banners. */
export interface CheckoutData {
  pedido: Pedido;
  pedidoId: string;
  /** flattened + ordem-sorted line items. */
  itens: ItemDoPedido[];
  /** produtoId → engine projection (line produtos + kit components). */
  produtos: Map<string, EngineProduto>;
  /** the first pre-existing checkout doc, if any (warns the operator). */
  existingCheckout: { id: string; timestampMs: number | null } | null;
  incidentes: Incidente[];
}

/** Project a Firestore Produto onto the engine's minimal view (id from the doc key). */
function toEngineProduto(id: string, p: Produto): EngineProduto {
  return {
    id,
    nome: p.nome ?? null,
    sku: p.sku ?? null,
    ehKit: p.ehKit,
    componentesKit: p.componentesKit,
    fotos: p.fotos,
    // Only a MEMBER may contribute a parent-form sku to the scan index.
    paiId: p.paiId ?? null,
  };
}

/**
 * The kit-component produto ids referenced by the wave-1 produtos but not
 * already fetched — the wave-2 fetch set. Pure/testable.
 */
export function collectComponentIds(wave1: ReadonlyMap<string, EngineProduto>): string[] {
  const out = new Set<string>();
  for (const p of wave1.values()) {
    if (p.ehKit && p.componentesKit) {
      for (const cid of Object.keys(p.componentesKit)) {
        if (!wave1.has(cid)) out.add(cid);
      }
    }
  }
  return [...out];
}

/**
 * Load a pedido and everything the checkout engine + banners need. Produtos are
 * bulk-fetched in two waves (line items, then unseen kit components) via
 * `getDocsByIds` — ~34+34 chunked concurrent queries for a 1000-item pedido, not
 * ~2000 serial reads. Photos are NOT loaded here (lazy per visible row, PR 5).
 */
export async function loadCheckoutData(db: Firestore, pedidoId: string): Promise<CheckoutData> {
  const pedidoSnap = await getDoc(pedidoCollection.docRef(db, {}, pedidoId));
  if (!pedidoSnap.exists()) throw new CheckoutPedidoNotFoundError(pedidoId);
  const pedido = pedidoSnap.data();
  const itens = flattenPedidoItens(pedido.itens);

  // Wave 1: line-item produtos.
  const itemIds = [...new Set(itens.map((i) => i.produtoUid).filter((x): x is string => !!x))];
  const wave1Docs = await getDocsByIds(db, produtoCollection, itemIds);
  const produtos = new Map<string, EngineProduto>();
  for (const [id, p] of wave1Docs) produtos.set(id, toEngineProduto(id, p));

  // Wave 2: kit-component produtos not already fetched.
  const wave2Docs = await getDocsByIds(db, produtoCollection, collectComponentIds(produtos));
  for (const [id, p] of wave2Docs) produtos.set(id, toEngineProduto(id, p));

  // Existing-checkout warning + incidentes (parallel).
  const [existingSnap, incidentesSnap] = await Promise.all([
    // Order by timestamp desc so the warning refers to the NEWEST checkout,
    // not an arbitrary one (the warning shows its timestamp).
    getDocs(
      buildQuery(checkoutCollection.ref(db, { pedidoId }), [
        orderByField('timestamp', 'desc'),
        limit(1),
      ]),
    ),
    getDocs(incidenteCollection.ref(db, { pedidoId })),
  ]);
  const firstCheckout = existingSnap.docs[0];
  const existingCheckout = firstCheckout
    ? { id: firstCheckout.id, timestampMs: firstCheckout.data().timestamp }
    : null;
  const incidentes = incidentesSnap.docs.map((d) => d.data());

  return { pedido, pedidoId, itens, produtos, existingCheckout, incidentes };
}
