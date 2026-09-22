'use client';

import type { IntegracaoRow, IntegracoesStatus } from '@/lib/data/useIntegracoes';
import { integracaoCollection } from '@/lib/data/integracaoCollection';

/**
 * The shared `integracao` lookup, as the pedidos list passes it around.
 *
 * `PedidosListView` resolves it ONCE per page through `useIntegracoes` and hands
 * the same object to every row's cell and to the column's chip formatter, so the
 * whole column costs one cached query rather than one per row.
 *
 * ⚠️ `byId` alone is ambiguous — it is empty while loading, empty when the read
 * was denied (a user without `PERM.integracao.read`), and empty when there
 * genuinely are no integrações. `status` is what tells them apart, and every
 * consumer must read it first.
 */
export interface IntegracaoLookup {
  /** Every integração, ordered by `nome` — the Canal filter's option list. */
  rows: IntegracaoRow[];
  /** The same rows keyed by document id — what a cell resolves its ref against. */
  byId: Map<string, IntegracaoRow['data']>;
  status: IntegracoesStatus;
}

/**
 * The `documents/integracao/<id>` doc-path string a pedido stores in
 * `integracaoPedidoOuterRef`.
 *
 * ⚠️ Built exactly the way `IntegracaoPicker` builds it, because the filter
 * compares it with `==` against what the pedido holds: the two strings have to
 * be byte-identical or the filter matches nothing while looking active.
 */
export function integracaoOuterRef(id: string): string {
  return `documents/${integracaoCollection.resolvePath({})}/${id}`;
}

/** The trailing document id of an outer-ref path, or the value itself if it has none. */
export function integracaoIdFromOuterRef(value: unknown): string {
  const raw = String(value);
  const slash = raw.lastIndexOf('/');
  return slash < 0 ? raw : raw.slice(slash + 1);
}

/**
 * Chip text for the active Canal filter: the channel's name, falling back to its
 * bare id.
 *
 * The fallback is practically unreachable — `useIntegracoes` returns EVERY
 * integração (a handful of rows, cached for five minutes) and the cells read it
 * on first paint, so the map is populated before a chip can render. It exists
 * for the denied-read case, where printing a raw id still beats printing the
 * whole stored path.
 */
export function formatIntegracaoFilterValue(value: unknown, lookup: IntegracaoLookup): string {
  const id = integracaoIdFromOuterRef(value);
  return lookup.byId.get(id)?.nome ?? id;
}
