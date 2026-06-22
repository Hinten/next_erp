import {
  diffPrecos,
  estoqueProdutoMeta,
  estoqueProdutoSchema,
  historicoCustoMeta,
  historicoPrecoMeta,
  impostoProdutoMeta,
  impostoProdutoSchema,
  makeEstoqueUid,
  operacaoIdFromImpostoRef,
  produtoExtraDataMeta,
  produtoExtraDataSchema,
  produtoMeta,
  samePrecos,
  PRODUTO_EXTRA_DATA_DOC_ID,
  PRODUTO_SUBCOLLECTION_NAMES,
  type ImpostoProduto,
  type PrecoChange,
  type PrecosMap,
  type ProdutoExtraData,
} from '@delfrance/schemas';
import type { ProdutoDataPort, ProdutoWriteOp } from './port';

// ---------------------------------------------------------------------------
// Paths (derived from the schema metas so they can never drift from the rules)
// ---------------------------------------------------------------------------

const PRODUTOS = produtoMeta.collectionPath; // produtos
const HISTORICO_PRECO = historicoPrecoMeta.collectionPath; // produtos/{produtoId}/historicoDePrecos
const HISTORICO_CUSTO = historicoCustoMeta.collectionPath; // produtos/{produtoId}/historicoDeCusto
const EXTRA_DATA = produtoExtraDataMeta.collectionPath; // produtos/{produtoId}/extraData
const ESTOQUE = estoqueProdutoMeta.collectionPath; // produtos/{produtoId}/estoques
const IMPOSTO = impostoProdutoMeta.collectionPath; // produtos/{produtoId}/imposto

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
// Produto extra data (Descrição + Google Merchant — the singleton subdocument)
// ---------------------------------------------------------------------------

/**
 * Build the single `set` op that persists the produto's extra-data singleton
 * (`produtos/<id>/extraData/singleton`). The doc id is the fixed
 * `PRODUTO_EXTRA_DATA_DOC_ID`; the value is parsed through
 * `produtoExtraDataSchema` so defaults are filled and the wire shape is enforced
 * here in the use-case (the agent/admin path has no Zod converter to lean on).
 */
export function buildExtraDataWriteOps(
  produtoId: string,
  extraData: ProdutoExtraData,
): ProdutoWriteOp[] {
  return [
    {
      type: 'set',
      path: subDocPath(EXTRA_DATA, produtoId, PRODUTO_EXTRA_DATA_DOC_ID),
      data: produtoExtraDataSchema.parse(extraData) as Record<string, unknown>,
    },
  ];
}

/** Persist the produto's extra-data singleton (Descrição + Google Merchant). */
export async function saveProdutoExtraData(
  port: ProdutoDataPort,
  produtoId: string,
  extraData: ProdutoExtraData,
): Promise<void> {
  await port.commit(buildExtraDataWriteOps(produtoId, extraData));
}

// ---------------------------------------------------------------------------
// Produto estoque (per-depósito stock — the `estoques` subcollection)
//
// Stock editing is decoupled from the parent produto save (it spans the parent
// AND its variation children — each a separate produto doc with its own
// `estoques`). The Estoque tab edits each row directly, like the Flutter app:
// `localizacao` via a `localizacao`-only update, and quantities via a
// conflict-safe movement (atomic increment + a HistoricoEstoque record).
// ---------------------------------------------------------------------------

/** Deterministic estoque doc path for `(produto, depósito)`. */
function estoqueDocPath(produtoId: string, depositoId: string): string {
  return subDocPath(ESTOQUE, produtoId, makeEstoqueUid(produtoId, depositoId));
}

/**
 * Build the write that sets a depósito's `localizacao` for a produto — mirror of
 * the Flutter `editarLocalizacao` (`produtoTableProvider.dart:1301`). On an
 * EXISTING estoque doc it is a `localizacao`-only `update` (so `quantidade` /
 * `quantidadeReservada` — owned by stock movements — are never touched); when no
 * doc exists yet it `set`s a fresh estoque (`quantidade: 0`). An empty string
 * clears the field (stored `null`).
 */
export function buildLocalizacaoOp(
  produtoId: string,
  depositoId: string,
  localizacao: string | null,
  hasExisting: boolean,
  now: number,
): ProdutoWriteOp {
  const path = estoqueDocPath(produtoId, depositoId);
  const loc = localizacao != null && localizacao.trim() !== '' ? localizacao : null;
  if (hasExisting) {
    return { type: 'update', path, data: { localizacao: loc, ultimaModificacao: now } };
  }
  return {
    type: 'set',
    path,
    data: estoqueProdutoSchema.parse({
      parentId: produtoId,
      depositoOuterRef: `documents/depositos/${depositoId}`,
      localizacao: loc,
      quantidade: 0,
      quantidadeReservada: 0,
      dataCriacao: now,
      ultimaModificacao: now,
    }) as Record<string, unknown>,
  };
}

/** A stock movement kind (Flutter `movimentar` tipos). */
export type TipoMovimentacao = 'entrada' | 'saida' | 'balanco';

/** Raw movement input as entered in the editor (magnitudes — non-negative). */
export interface MovimentacaoInput {
  tipo: TipoMovimentacao;
  quantidade: number;
  quantidadeReservada: number;
  motivo: string | null;
}

/** The resolved movement: signed deltas (or absolutes for balanço) + audit record. */
export interface MovimentacaoPlan {
  /** `true` for a balanço (absolute set) vs a regular increment movement. */
  ehBalanco: boolean;
  /** Entrada/saída: the signed delta to `increment`. Balanço: the absolute value. */
  quantidade: number;
  quantidadeReservada: number;
  /** The `HistoricoEstoque` audit record to append (signed delta, Flutter parity). */
  historico: {
    ehBalanco: boolean | null;
    quantidade: number;
    quantidadeReservada: number;
    motivo: string | null;
    timestamp: number;
  };
}

/**
 * Resolve a movement into signed quantities + its audit record — pure mirror of
 * the Flutter `Estoque.movimentar` (`models.dart:4164`). Saída negates the
 * magnitudes (the delta the caller `increment`s); balanço passes them through as
 * the absolute counted values. The caller (client adapter) applies the
 * conflict-safe write: `increment` for entrada/saída (never overwrites the server
 * count), an absolute set for balanço — plus this `historico` record.
 */
export function planMovimentacao(input: MovimentacaoInput, now: number): MovimentacaoPlan {
  const sign = input.tipo === 'saida' ? -1 : 1;
  const quantidade = sign * input.quantidade;
  const quantidadeReservada = sign * input.quantidadeReservada;
  const ehBalanco = input.tipo === 'balanco';
  return {
    ehBalanco,
    quantidade,
    quantidadeReservada,
    historico: {
      ehBalanco: ehBalanco ? true : null,
      quantidade,
      quantidadeReservada,
      motivo: input.motivo,
      timestamp: now,
    },
  };
}

// ---------------------------------------------------------------------------
// Produto imposto (per-operação fiscal override — the `imposto` subcollection)
//
// Persisted with the produto doc (Flutter saves imposto in the same batch). One
// doc per active operação, keyed by the operação id (deterministic, idempotent).
// ---------------------------------------------------------------------------

/** True when an imposto entry has any Dados Gerais value worth persisting. */
function impostoCarriesInfo(imp: ImpostoProduto): boolean {
  const strings = [
    imp.origem,
    imp.cfop,
    imp.cfopInterestadual,
    imp.NCM,
    imp.NVE,
    imp.CEST,
    imp.indEscala,
    imp.CNPJFab,
    imp.cBenef,
    imp.extipi,
    imp.unidade,
  ];
  return (
    strings.some((v) => typeof v === 'string' && v.trim() !== '') ||
    imp.compoeValorTotalDaNFe === true
  );
}

/**
 * Build the imposto writes for a produto save (Flutter `Produto.save()` imposto
 * loop, `produtoTableProvider.dart:597`). Each entry maps to one doc at
 * `produtos/<id>/imposto/<operacaoId>` (deterministic id = operação id, so a
 * re-save is idempotent). A configured entry is `set` (full doc, configs
 * preserved via passthrough); an entry that was loaded (`id` set) but is now
 * fully cleared is `delete`d; a pristine empty row is skipped. The wire shape is
 * parsed here so the agent/admin path has no Zod converter to lean on.
 */
export function buildImpostoWriteOps(
  produtoId: string,
  impostos: ImpostoProduto[],
  now: number,
): ProdutoWriteOp[] {
  const ops: ProdutoWriteOp[] = [];
  for (const imp of impostos) {
    const operacaoId = operacaoIdFromImpostoRef(imp.impostoOpercaoOuterRef);
    if (!operacaoId) continue; // the produto UI only edits per-operação entries
    const path = subDocPath(IMPOSTO, produtoId, operacaoId);
    if (impostoCarriesInfo(imp)) {
      ops.push({
        type: 'set',
        path,
        data: impostoProdutoSchema.parse({
          ...imp,
          id: operacaoId,
          impostoOpercaoOuterRef: `operacao/${operacaoId}`,
          timestamp: imp.timestamp ?? now,
        }) as Record<string, unknown>,
      });
    } else if (imp.id != null) {
      ops.push({ type: 'delete', path });
    }
  }
  return ops;
}

/** Persist the produto's per-operação imposto docs (no-op when none changed). */
export async function saveProdutoImpostos(
  port: ProdutoDataPort,
  produtoId: string,
  impostos: ImpostoProduto[],
): Promise<void> {
  const ops = buildImpostoWriteOps(produtoId, impostos, port.now());
  if (ops.length === 0) return;
  await port.commit(ops);
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
