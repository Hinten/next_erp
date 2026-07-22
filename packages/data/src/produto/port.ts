import type { PrecosMap } from '@delfrance/schemas';

/**
 * The produto data-access **port** — the surface the produto use-cases
 * (`usecases.ts`) need, abstracted from any Firestore SDK. The same
 * orchestration therefore runs under the client SDK (apps/web adapter) and
 * firebase-admin (a future agent / MCP adapter); each SDK supplies its own thin
 * adapter, and ALL wire-shape + path knowledge stays in the use-cases.
 *
 * This is the `@delfrance/data` half of issue #145 (extract the produto
 * use-case layer behind an SDK port).
 */

/** A produto document as the use-cases read it (id + the fields they touch). */
export interface ProdutoSnapshot {
  id: string;
  nome: string | null;
  precos: PrecosMap;
}

/**
 * The kit-flag view of a produto, keyed by id — the minimal shape the kit-guard
 * resolver reads (a produto's `ehKit`). Only ids that resolve to an existing
 * produto doc are returned; a missing id is simply absent from the result.
 */
export interface ProdutoKitFlag {
  id: string;
  ehKit: boolean;
}

/**
 * One write in a logical batch. `path` is a full Firestore document path
 * (e.g. `produtos/<id>/imposto/<docId>`). The adapter chunks an op list into
 * ≤499-operation batches, preserving order (so a delete cascade can keep the
 * parent last).
 */
export type ProdutoWriteOp =
  | { type: 'set'; path: string; data: Record<string, unknown> }
  | { type: 'update'; path: string; data: Record<string, unknown> }
  | { type: 'delete'; path: string };

export interface ProdutoDataPort {
  /** Mint a new document id (client random id or admin auto-id). */
  newId(): string;
  /** Current time as an ms-epoch int — the wire shape for `timestamp` fields. */
  now(): number;
  /** Variation children of a parent (`paiId == parentId`). */
  getChildren(parentId: string): Promise<ProdutoSnapshot[]>;
  /** Up to `max` kits whose `componentesKitKeys` array contains `produtoId`. */
  getKitReferences(produtoId: string, max: number): Promise<ProdutoSnapshot[]>;
  /**
   * Batch-read the `ehKit` flag of each produto by id (order-independent). Ids
   * that don't resolve to a produto doc are omitted. Used by the agent/MCP
   * kit-guard resolver to classify a produto's `componentesKit` components and
   * its `paiId` parent — the picker-less save path can't lean on the UI.
   */
  getKitFlags(ids: string[]): Promise<ProdutoKitFlag[]>;
  /** True when the produto has at least one doc in the named subcollection. */
  subcollectionHasDocs(produtoId: string, subcollection: string): Promise<boolean>;
  /** Apply all ops; the adapter chunks them into ≤499-op batches, in order. */
  commit(ops: ProdutoWriteOp[]): Promise<void>;
}
