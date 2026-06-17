import {
  diffPrecos,
  historicoCustoMeta,
  historicoPrecoMeta,
  produtoMeta,
  samePrecos,
  PRODUTO_SUBCOLLECTION_NAMES,
  type PrecoChange,
  type PrecosMap,
} from '@delfrance/schemas';
import type { ProdutoDataPort, ProdutoWriteOp } from './port';

// ---------------------------------------------------------------------------
// Paths (derived from the schema metas so they can never drift from the rules)
// ---------------------------------------------------------------------------

const PRODUTOS = produtoMeta.collectionPath; // produtos
const HISTORICO_PRECO = historicoPrecoMeta.collectionPath; // produtos/{produtoId}/historicoDePrecos
const HISTORICO_CUSTO = historicoCustoMeta.collectionPath; // produtos/{produtoId}/historicoDeCusto

const produtoDocPath = (id: string) => `${PRODUTOS}/${id}`;
const subDocPath = (template: string, produtoId: string, docId: string) =>
  `${template.replace('{produtoId}', produtoId)}/${docId}`;

// ---------------------------------------------------------------------------
// Price / cost history (Flutter `Produto.save()` history writes)
// ---------------------------------------------------------------------------

/**
 * Build one `historicoDePrecos` set-op per price change — mirror of the Flutter
 * history writes (`models.dart:2078-2130`). Wire shape: outerRef =
 * `documents/listaDePrecos/<id>` (`pathWithDocuments`), `valorOriginal` /
 * `valorFinal` explicitly null when absent, `timestamp` = ms epoch.
 */
export function buildPrecoHistoryOps(
  port: ProdutoDataPort,
  produtoId: string,
  changes: PrecoChange[],
): ProdutoWriteOp[] {
  const timestamp = port.now();
  return changes.map((change) => ({
    type: 'set',
    path: subDocPath(HISTORICO_PRECO, produtoId, port.newId()),
    data: {
      listaDePrecoHistoricoOuterRef: `documents/listaDePrecos/${change.listaId}`,
      valorOriginal: change.valorOriginal,
      valorFinal: change.valorFinal,
      timestamp,
    },
  }));
}

/** Build one `historicoDeCusto` set-op (`{ valor, timestamp: ms-epoch }`). */
export function buildCustoHistoryOp(
  port: ProdutoDataPort,
  produtoId: string,
  valor: number,
): ProdutoWriteOp {
  return {
    type: 'set',
    path: subDocPath(HISTORICO_CUSTO, produtoId, port.newId()),
    data: { valor, timestamp: port.now() },
  };
}

/** Record price-change history (no-op when there are no changes). */
export async function recordPrecoHistory(
  port: ProdutoDataPort,
  produtoId: string,
  changes: PrecoChange[],
): Promise<void> {
  if (changes.length === 0) return;
  await port.commit(buildPrecoHistoryOps(port, produtoId, changes));
}

/** Record one cost-change history record. */
export async function recordCustoHistory(
  port: ProdutoDataPort,
  produtoId: string,
  valor: number,
): Promise<void> {
  await port.commit([buildCustoHistoryOp(port, produtoId, valor)]);
}

// ---------------------------------------------------------------------------
// Child precos propagation (Flutter per-child `updateOnly`, NO history)
// ---------------------------------------------------------------------------

/**
 * Refresh the `precos` of every existing variation child whose map differs
 * from the parent's value — Flutter's `produtoTableProvider.dart:556-568`.
 * Pedidos resolve the price on the SOLD child doc, so a stale child would sell
 * at the old price. Returns the ids that were updated.
 *
 * (The adapter forces the children read to the server — a cache-served read on
 * a freshly navigated editor can be cold and silently skip the propagation.)
 */
export async function propagatePrecosToChildren(
  port: ProdutoDataPort,
  parentId: string,
  precos: PrecosMap,
): Promise<string[]> {
  const children = await port.getChildren(parentId);
  const stale = children.filter((c) => !samePrecos(c.precos, precos));
  if (stale.length === 0) return [];
  await port.commit(
    stale.map((c) => ({
      type: 'update',
      path: produtoDocPath(c.id),
      data: { precos: precos ?? null },
    })),
  );
  return stale.map((c) => c.id);
}

/**
 * Diff old→new precos, record the history, and — when the map changed —
 * propagate it to the variation children. The composite the editor's
 * `onAfterSave` and a future agent both call. Returns whether anything changed.
 */
export async function applyPrecosChange(
  port: ProdutoDataPort,
  args: { produtoId: string; oldPrecos: PrecosMap; newPrecos: PrecosMap },
): Promise<{ changed: boolean }> {
  const changes = diffPrecos(args.oldPrecos, args.newPrecos);
  if (changes.length === 0) return { changed: false };
  await recordPrecoHistory(port, args.produtoId, changes);
  await propagatePrecosToChildren(port, args.produtoId, args.newPrecos);
  return { changed: true };
}

// ---------------------------------------------------------------------------
// Inbound-reference guard + cascade delete (#117 / #135)
// ---------------------------------------------------------------------------

/** Max concurrent reference probes in the delete guard (each target ~8 reads). */
const GUARD_PROBE_CONCURRENCY = 4;

/** Human channel label per marketplace subcollection, for guard messages. */
export const MARKETPLACE_CHANNEL_LABELS: Record<string, string> = {
  produtomercadolivre: 'Mercado Livre',
  variacoesml: 'Mercado Livre',
  produtoshopee: 'Shopee',
  variacaoshopee: 'Shopee',
  produtomagalu: 'Magalu',
  produtoamazon: 'Amazon',
  produtointegrada: 'Loja Integrada',
};

/** Inbound references that make a produto unsafe to delete. */
export interface ProdutoReferences {
  /** Kits (other produtos) whose `componentesKit` contains this doc id. */
  kits: Array<{ id: string; nome: string }>;
  /** Channel labels with at least one marketplace-link doc (deduped). */
  marketplaces: string[];
}

/** Everything that still points at a produto (kit membership + marketplace links). */
export async function findProdutoReferences(
  port: ProdutoDataPort,
  produtoId: string,
): Promise<ProdutoReferences> {
  const [kits, ...links] = await Promise.all([
    port.getKitReferences(produtoId, 5),
    ...PRODUTO_SUBCOLLECTION_NAMES.map(
      async (name): Promise<string | null> =>
        (await port.subcollectionHasDocs(produtoId, name))
          ? (MARKETPLACE_CHANNEL_LABELS[name] ?? name)
          : null,
    ),
  ]);
  return {
    kits: kits.map((k) => ({ id: k.id, nome: k.nome ?? k.id })),
    marketplaces: [...new Set(links.filter((l): l is string => l !== null))],
  };
}

/** True when any reference exists (the produto must not be deleted). */
export function hasReferences(refs: ProdutoReferences): boolean {
  return refs.kits.length > 0 || refs.marketplaces.length > 0;
}

/** Guard message describing what still points at a produto. */
export function describeReferences(refs: ProdutoReferences): string {
  const parts: string[] = [];
  if (refs.marketplaces.length > 0) {
    parts.push(`vinculado(a) a anúncio(s): ${refs.marketplaces.join(', ')}`);
  }
  if (refs.kits.length > 0) {
    parts.push(`usado(a) no(s) kit(s): ${refs.kits.map((k) => k.nome).join(', ')}`);
  }
  return parts.join('; ');
}

/** Thrown by {@link deleteProdutoCascade} when a target is still referenced. */
export class ProdutoReferencedError extends Error {
  constructor(
    message: string,
    readonly blocked: Array<{ id: string; nome: string; refs: ProdutoReferences }>,
  ) {
    super(message);
    this.name = 'ProdutoReferencedError';
  }
}

/**
 * Delete a produto and cascade its variation children — but only after every
 * target passes the inbound-reference guard (a produto still in a kit or linked
 * to a marketplace listing blocks the whole operation; the old Flutter app
 * deletes blindly). The parent goes LAST so a partial failure leaves it (and
 * the delete affordance) in place. Throws {@link ProdutoReferencedError} when
 * blocked; subcollection orphans are swept server-side (#136).
 */
export async function deleteProdutoCascade(
  port: ProdutoDataPort,
  produtoId: string,
): Promise<void> {
  const children = await port.getChildren(produtoId);
  const targets = [
    { id: produtoId, nome: 'o produto' },
    ...children.map((c) => ({ id: c.id, nome: `a variação "${c.nome ?? c.id}"` })),
  ];

  // Probe references in parallel but BOUNDED — each target costs ~8 reads (the
  // kit query + one probe per marketplace subcollection), so a parent with many
  // variation children must not fan every id out in one burst. `Promise.all`
  // rejects on the first failure, which is the correct fail-closed behaviour for
  // a deletion guard (a partial result must never green-light a delete).
  const refsById = new Map<string, ProdutoReferences>();
  for (let i = 0; i < targets.length; i += GUARD_PROBE_CONCURRENCY) {
    const slice = targets.slice(i, i + GUARD_PROBE_CONCURRENCY);
    const probed = await Promise.all(
      slice.map(async (t) => [t.id, await findProdutoReferences(port, t.id)] as const),
    );
    for (const [id, refs] of probed) refsById.set(id, refs);
  }
  const blocked = targets
    .map((t) => ({ ...t, refs: refsById.get(t.id)! }))
    .filter((t) => hasReferences(t.refs));
  if (blocked.length > 0) {
    const message = `${blocked
      .map((t) => `${t.nome} está ${describeReferences(t.refs)}`)
      .join('; ')}. Remova os vínculos antes de excluir.`;
    throw new ProdutoReferencedError(message, blocked);
  }

  // Children first, parent last (the adapter preserves order while chunking).
  await port.commit([
    ...children.map((c) => ({ type: 'delete' as const, path: produtoDocPath(c.id) })),
    { type: 'delete', path: produtoDocPath(produtoId) },
  ]);
}
