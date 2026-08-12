import {
  estoqueProdutoMeta,
  estoqueProdutoSchema,
  impostoProdutoMeta,
  impostoProdutoSchema,
  makeEstoqueUid,
  operacaoIdFromImpostoRef,
  produtoExtraDataMeta,
  produtoExtraDataSchema,
  produtoMeta,
  PRODUTO_EXTRA_DATA_DOC_ID,
  PRODUTO_SUBCOLLECTION_NAMES,
  type ComponentesKit,
  type ImpostoProduto,
  type ProdutoExtraData,
} from '@delfrance/schemas';
import type { ProdutoDataPort, ProdutoWriteOp } from './port';

// ---------------------------------------------------------------------------
// Paths (derived from the schema metas so they can never drift from the rules)
//
// Price/cost history (`historicoDePrecos`/`historicoDeCusto`) and the
// parent→children precos propagation used to live here (`buildPrecoHistoryOps`,
// `recordPrecoHistory`, `buildCustoHistoryOp`, `recordCustoHistory`,
// `propagatePrecosToChildren`, `applyPrecosChange`) — removed 2026-07-21. Both
// are now server-owned by the `onProdutoChanged` Cloud Function trigger
// (apps/functions), which fires on every produto write, diffs the changed
// top-level fields against the previous doc into one unified
// `historicoDeModificacoes` entry, and propagates precos to children (gated on
// `paiId == null` and `propagatePriceToChildren`). There is no remaining
// client-side history write; a newly created variation child's initial precos
// deliberately gets no entry either (the trigger's `produtoExtraIgnores` drops
// `precos` from the diff for any produto with a `paiId` set).
// ---------------------------------------------------------------------------

const PRODUTOS = produtoMeta.collectionPath; // produtos
const EXTRA_DATA = produtoExtraDataMeta.collectionPath; // produtos/{produtoId}/extraData
const ESTOQUE = estoqueProdutoMeta.collectionPath; // produtos/{produtoId}/estoques
const IMPOSTO = impostoProdutoMeta.collectionPath; // produtos/{produtoId}/imposto

const produtoDocPath = (id: string) => `${PRODUTOS}/${id}`;
const subDocPath = (template: string, produtoId: string, docId: string) =>
  `${template.replace('{produtoId}', produtoId)}/${docId}`;

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

/**
 * The estoque counters the movement lands ON TOP of. Optional for entrada/saída
 * (their delta is known without reading anything, which is what keeps that path
 * read-free — #387), **required for a balanço**, whose signed delta exists only
 * relative to the value it replaces.
 */
export interface EstoqueAtual {
  quantidade: number;
  quantidadeReservada: number;
}

/** The resolved movement: what to write on the estoque doc + the audit record. */
export interface MovimentacaoPlan {
  /** `true` for a balanço (absolute set) vs a regular increment movement. */
  ehBalanco: boolean;
  /** Entrada/saída: the signed delta to `increment`. Balanço: the absolute value. */
  quantidade: number;
  /**
   * Same split as `quantidade` — and on a **balanço** it is already clamped ≥ 0,
   * so it always equals `historico.saldoReservada`: the plan describes exactly
   * what lands on the doc, and the caller writes it verbatim. On entrada/saída
   * it is a signed delta, so a negative value is correct and expected there.
   */
  quantidadeReservada: number;
  /**
   * The `HistoricoEstoque` v2 record to append. `movimento` is a **signed delta
   * on every row, balanço included** — the ledger has to stay summable (ADR
   * 0014). `null` only when a balanço was planned without `atual`, which every
   * caller should avoid; consumers read null as *unknown* and fail open.
   */
  historico: {
    movimento: number | null;
    movimentoReservada: number | null;
    saldo: number | null;
    saldoReservada: number | null;
    motivo: string | null;
    timestamp: number;
  };
}

/**
 * Resolve a movement into the estoque write + its audit record — pure mirror of
 * the Flutter `Estoque.movimentar` (`models.dart:4164`). Saída negates the
 * magnitudes (the delta the caller `increment`s); balanço passes them through as
 * the absolute counted values. The caller applies the conflict-safe write:
 * `increment` for entrada/saída (never overwrites the server count), an absolute
 * set for balanço — plus this `historico` record.
 *
 * ⚠️ `atual` is what makes a **balanço** summable: its `movimento` is
 * `contado − atual`, so the caller must read the doc inside a transaction first.
 * Entrada/saída need no read and pass `null`, so their `saldo` is null too —
 * best-effort by design, not an omission.
 *
 * ⚠️ Known imprecision on the read-free path: `quantidadeReservada` is floored at
 * 0 by the caller's follow-up transform, so a saída that would drive the
 * reservation negative records the *requested* `movimentoReservada` rather than
 * the effective one. Supplying `atual` removes the gap (the floor is applied
 * here too); without it there is nothing to floor against.
 */
export function planMovimentacao(
  input: MovimentacaoInput,
  now: number,
  atual: EstoqueAtual | null = null,
): MovimentacaoPlan {
  const sign = input.tipo === 'saida' ? -1 : 1;
  const quantidade = sign * input.quantidade;
  const quantidadeReservada = sign * input.quantidadeReservada;
  const ehBalanco = input.tipo === 'balanco';

  if (ehBalanco) {
    // The absolute set the caller writes. Clamped ONCE, here, so the plan is
    // self-consistent: for a balanço `quantidadeReservada` IS the value that
    // lands on the doc, and it must equal the `saldoReservada` the ledger
    // records. (Entrada/saída below stay unclamped — there the field is a
    // signed delta the caller `increment`s, and a negative one is correct.)
    const saldoReservada = Math.max(0, input.quantidadeReservada);
    return {
      ehBalanco,
      quantidade: input.quantidade,
      quantidadeReservada: saldoReservada,
      historico: {
        movimento: atual ? input.quantidade - atual.quantidade : null,
        movimentoReservada: atual ? saldoReservada - atual.quantidadeReservada : null,
        saldo: input.quantidade,
        saldoReservada,
        motivo: input.motivo,
        timestamp: now,
      },
    };
  }

  const saldoReservada = atual
    ? Math.max(0, atual.quantidadeReservada + quantidadeReservada)
    : null;
  return {
    ehBalanco,
    quantidade,
    quantidadeReservada,
    historico: {
      movimento: quantidade,
      // With `atual` the floor is observable, so record the delta that actually
      // applied; without it, the requested one is the best available answer.
      movimentoReservada: atual ? saldoReservada! - atual.quantidadeReservada : quantidadeReservada,
      saldo: atual ? atual.quantidade + quantidade : null,
      saldoReservada,
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
  // The deep tribute configs (now typed) each count as a real override — an
  // entry that sets only ICMS/IPI/PIS/COFINS/ISSQN/retenção (no Dados Gerais)
  // must still persist.
  const configs = [
    imp.configuracaoICMS,
    imp.configuracaoIPI,
    imp.configuracaoPIS,
    imp.configuracaoCOFINS,
    imp.configuracaoPISST,
    imp.configuracaoISSQN,
    imp.retencao,
  ];
  // An explicit `compoeValorTotalDaNFe` (true OR false) is a real override worth
  // keeping; only a pristine `null` counts as empty.
  return (
    strings.some((v) => typeof v === 'string' && v.trim() !== '') ||
    imp.compoeValorTotalDaNFe != null ||
    configs.some((c) => c != null) ||
    rtcConfigHasValue(imp)
  );
}

/**
 * True when the passthrough Reforma Tributária blob (`configuracaoIBSCBS`)
 * carries at least one non-null value. The RTC config rides on the imposto row
 * via `.passthrough()` (not typed on `ImpostoProduto`), so a row whose ONLY
 * content is RTC config must still persist — `impostoCarriesInfo` would
 * otherwise drop it. A toggled-on-but-empty blob (all null) counts as empty.
 */
function rtcConfigHasValue(imp: ImpostoProduto): boolean {
  return hasNonNullLeaf((imp as { configuracaoIBSCBS?: unknown }).configuracaoIBSCBS);
}

/**
 * True when `v` is, or recursively contains, a non-null leaf. A nested all-null
 * object (e.g. an empty `is` sub-config) correctly reads as empty — a plain
 * top-level non-null check would treat the non-null nested object as a value.
 */
function hasNonNullLeaf(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).some(hasNonNullLeaf);
  }
  return true;
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
// Kit "Gerar Variações" child flush (each kit-variation child's componentesKit)
// ---------------------------------------------------------------------------

/** One variation child's generated kit map, ready to flush onto its produto doc. */
export interface ChildComponentesKit {
  id: string;
  componentesKit: ComponentesKit | null;
}

/**
 * Build the per-child `componentesKit` updates produced by "Gerar Variações".
 * Each kit-variation child is a separate produto doc, so this is an `update` on
 * `produtos/<childId>` carrying the generated map plus the order-stable
 * `componentesKitKeys` denorm (the same sorted-keys shape the parent uses, which
 * the delete-guard queries via `array-contains`). An empty/null map clears both.
 */
export function buildChildrenComponentesKitOps(children: ChildComponentesKit[]): ProdutoWriteOp[] {
  return children.map((c) => {
    const map =
      c.componentesKit && Object.keys(c.componentesKit).length > 0 ? c.componentesKit : null;
    return {
      type: 'update',
      path: produtoDocPath(c.id),
      data: {
        componentesKit: map,
        componentesKitKeys: map ? Object.keys(map).sort() : null,
      },
    };
  });
}

/** Persist each kit-variation child's generated `componentesKit` (no-op when none). */
export async function saveChildrenComponentesKit(
  port: ProdutoDataPort,
  children: ChildComponentesKit[],
): Promise<void> {
  if (children.length === 0) return;
  await port.commit(buildChildrenComponentesKitOps(children));
}

// ---------------------------------------------------------------------------
// Kit-status child propagation (Flutter `Produto.save()` variation loop)
//
// When a parent's `ehKit`/`ehKitVirtual` flips, every EXISTING variation child
// must follow — a child of a non-kit can't stay a kit. Mirror of
// `produtoTableProvider.dart:556-589`: set the child's `ehKit`/`ehKitVirtual`
// (a non-kit can't be a virtual kit — Flutter `ehKit == false ? false :
// ehKitVirtual`) and CLEAR its `componentesKit` (+ the denorm keys) only when
// the parent stops being a kit. A kit parent leaves each child's own generated
// map intact (it's populated by "Gerar Variações").
// ---------------------------------------------------------------------------

/** The parent kit-status transition observed across one save. */
export interface KitStatusChange {
  ehKit: boolean;
  ehKitVirtual: boolean;
  oldEhKit: boolean;
  oldEhKitVirtual: boolean;
}

/** True when `ehKit` or `ehKitVirtual` actually changed across the save. */
function kitStatusChanged(c: KitStatusChange): boolean {
  return c.ehKit !== c.oldEhKit || c.ehKitVirtual !== c.oldEhKitVirtual;
}

/**
 * Build the per-child updates that sync a kit-status change onto existing
 * variation children. `ehKitVirtual` collapses to false when the parent is no
 * longer a kit; `componentesKit` (+ keys) is cleared only when the parent stops
 * being a kit. Empty when nothing changed.
 */
export function buildKitStatusChildOps(
  change: KitStatusChange,
  children: Array<{ id: string }>,
): ProdutoWriteOp[] {
  if (!kitStatusChanged(change)) return [];
  const ehKitVirtual = change.ehKit ? change.ehKitVirtual : false;
  return children.map((c) => {
    const data: Record<string, unknown> = { ehKit: change.ehKit, ehKitVirtual };
    if (!change.ehKit) {
      data.componentesKit = null;
      data.componentesKitKeys = null;
    }
    return { type: 'update', path: produtoDocPath(c.id), data };
  });
}

/**
 * Propagate a parent's kit-status change to its variation children (no-op when
 * nothing changed or there are no children). Returns the ids that were updated.
 * The editor's `onAfterSave` and a future agent both call this.
 */
export async function propagateKitStatusToChildren(
  port: ProdutoDataPort,
  parentId: string,
  change: KitStatusChange,
): Promise<string[]> {
  if (!kitStatusChanged(change)) return [];
  const children = await port.getChildren(parentId);
  if (children.length === 0) return [];
  await port.commit(buildKitStatusChildOps(change, children));
  return children.map((c) => c.id);
}

// ---------------------------------------------------------------------------
// Cross-document kit-guard input resolution (agent/MCP save path — #479)
//
// `produtoPageIssues` (packages/schemas pageModel) guards two cross-document kit
// invariants via inputs the React editar page fills from the UI: `componentKitIds`
// (kit-of-kit, #239 — the KitManager picker excludes kits) and `parentIsKit`
// (child-of-kit-parent, #298 — a page-level `paiId` lookup). A non-UI save path
// (agent/MCP) has neither, so it resolves the same two inputs itself by reading
// each component's `ehKit` and the parent's `ehKit`.
// ---------------------------------------------------------------------------

/** The cross-document kit inputs the PageModel guards need, resolved from docs. */
export interface ResolvedKitGuards {
  /**
   * Ids among `componentesKit` whose produto is itself a kit (`ehKit === true`) —
   * a forbidden kit-of-kit (#239). Empty when no component is a kit.
   */
  componentKitIds: string[];
  /**
   * The parent's `ehKit` when this produto is a variation child (has a `paiId`).
   * `null` when it has no `paiId` — a top-level produto resolves as absent, never
   * `false`, so the child-of-kit-parent guard (#298) doesn't misfire on a parent.
   */
  parentIsKit: boolean | null;
}

/**
 * Resolve the two cross-document kit inputs (`componentKitIds`, `parentIsKit`)
 * that {@link ProdutoPageValidationInput} carries, for a picker-less save path
 * (agent/MCP). Reads each `componentesKit` key's `ehKit` and — when `paiId` is
 * set — the parent doc's `ehKit`, in one batched {@link ProdutoDataPort.getKitFlags}.
 *
 * A component or parent id that doesn't resolve to a produto is treated as a
 * non-kit (absent from `componentKitIds`; a set-but-missing `paiId` resolves
 * `parentIsKit` false). A produto with no `paiId` resolves `parentIsKit` as
 * `null`. No fetch happens when there are no components and no `paiId`.
 */
export async function resolveKitGuardInputs(
  port: ProdutoDataPort,
  args: { componentesKit?: ComponentesKit | null; paiId?: string | null },
): Promise<ResolvedKitGuards> {
  // A component id / paiId is a produto doc id, so drop any empty string: it's
  // never a real produto, and it would be an invalid Firestore doc reference
  // (`doc(db, 'produtos', '')` throws) — treat it as a non-kit, not a crash.
  const componentIds = Object.keys(args.componentesKit ?? {}).filter((id) => id !== '');
  // `|| null` (not `?? null`): a top-level produto's "no parent" may arrive as
  // null OR an empty string; both must resolve `parentIsKit` to null (absent),
  // never false — the guard (#298) must not misfire on a parent produto.
  const paiId = args.paiId || null;
  if (componentIds.length === 0 && paiId === null) {
    return { componentKitIds: [], parentIsKit: null };
  }
  const ids = [...new Set([...componentIds, ...(paiId !== null ? [paiId] : [])])];
  const flags = await port.getKitFlags(ids);
  const ehKitById = new Map(flags.map((f) => [f.id, f.ehKit] as const));
  return {
    componentKitIds: componentIds.filter((id) => ehKitById.get(id) === true),
    parentIsKit: paiId === null ? null : ehKitById.get(paiId) === true,
  };
}

// ---------------------------------------------------------------------------
// Inbound-reference guard + cascade delete (#117 / #135)
// ---------------------------------------------------------------------------

/** Max concurrent reference probes in the delete guard (each target ~8 reads). */
const GUARD_PROBE_CONCURRENCY = 4;

/** Human channel label per marketplace subcollection, for guard messages. */
export const MARKETPLACE_CHANNEL_LABELS: Record<string, string> = {
  produtoMercadoLivre: 'Mercado Livre',
  variacaoMercadoLivre: 'Mercado Livre',
  prodshopee: 'Shopee',
  variashopee: 'Shopee',
  produtoMagalu2: 'Magalu',
  prodAmazon: 'Amazon',
  produtolojaintegrada: 'Loja Integrada',
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
 * Delete a produto — but only after every target (the parent AND each of its
 * variation children) passes the inbound-reference guard (a produto still in a
 * kit or linked to a marketplace listing blocks the whole operation; the old
 * Flutter app deletes blindly). Throws {@link ProdutoReferencedError} when
 * blocked.
 *
 * The client deletes ONLY the parent doc. The `onProdutoDeleted` Cloud Function
 * trigger is the authoritative cascade: it deletes the variation children
 * (`paiId == id`, #199) and sweeps every subcollection Firestore would orphan
 * (#136). We still fetch + probe the children here so a still-referenced child
 * blocks the parent delete before the server ever cascades it (the guard stays
 * client-side — ADR 0010; the allow-then-cleanup model of #135 is deferred).
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

  // Delete only the parent; `onProdutoDeleted` cascades children + subcollections.
  await port.commit([{ type: 'delete', path: produtoDocPath(produtoId) }]);
}
