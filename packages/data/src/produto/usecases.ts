import {
  estoqueProdutoMeta,
  estoqueProdutoSchema,
  impostoProdutoMeta,
  impostoProdutoSchema,
  makeEstoqueUid,
  derivarFilhoUnico,
  montarMembroUnico,
  operacaoIdFromImpostoRef,
  produtoExtraDataMeta,
  produtoExtraDataSchema,
  produtoMeta,
  PRODUTO_EXTRA_DATA_DOC_ID,
  PRODUTO_SUBCOLLECTION_NAMES,
  type ComponentesKit,
  type ImpostoProduto,
  type ParentParaMembroUnico,
  type Produto,
  camposDeKitDoMembroUnico,
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
  /**
   * The parent's component map, carried onto the SOLE MEMBER when `ehKit` goes
   * true. See {@link buildKitStatusChildOps} — omitting it reproduces the bug it
   * was added for.
   */
  componentesKit?: Record<string, unknown> | null;
  /**
   * The parent's `filhoUnicoId`. ⚠️ ONLY that child mirrors the parent's map: a
   * real variation authors its own (`buildChildrenComponentesKitOps`), and
   * writing the parent's over it would destroy a per-variation composition.
   */
  membroUnicoId?: string | null;
}

/** True when `ehKit` or `ehKitVirtual` actually changed across the save. */
function kitStatusChanged(c: KitStatusChange): boolean {
  return c.ehKit !== c.oldEhKit || c.ehKitVirtual !== c.oldEhKitVirtual;
}

/**
 * Build the per-child updates that sync a kit-status change onto existing
 * variation children. `ehKitVirtual` collapses to false when the parent is no
 * longer a kit. Empty when nothing changed.
 *
 * ## ⛔ Why the propagation is SYMMETRIC now
 *
 * It used to clear `componentesKit` (+ keys) when the parent stopped being a kit
 * and write nothing when it BECAME one. That left the sole member of a produto
 * turned into a kit after creation holding `ehKit: true` with a **null map** —
 * and `calcularAlteracoesEstoque` reads exactly that as "kit with no components"
 * (`if (!componentes) continue;`), so a pedido line for that produto moved **no
 * stock at all**: not the kit's own, not its components'. Silent, and the badge
 * read 0 to match.
 *
 * The mirror is only ever built once, at create time, so nothing else closed the
 * gap. `camposDeKitDoMembroUnico` is now the single definition of the group and
 * both directions go through it — the invariant "`ehKit` and the map travel
 * together" holds on the child the way `montarMembroUnico` already made it hold
 * at birth.
 *
 * ⚠️ The map is written onto the SOLE MEMBER only. A real variation authors its
 * own composition through `buildChildrenComponentesKitOps`, and copying the
 * parent's over it would destroy that. Without `membroUnicoId` the arm is inert,
 * which is the pre-#1398 behaviour.
 */
export function buildKitStatusChildOps(
  change: KitStatusChange,
  children: Array<{ id: string }>,
): ProdutoWriteOp[] {
  if (!kitStatusChanged(change)) return [];
  const grupo = camposDeKitDoMembroUnico(change);
  const membroUnicoId = change.membroUnicoId ?? null;
  return children.map((c) => {
    // The whole group for the sole member — flag, virtual flag, map and keys —
    // so it can never hold a flag without the map it gates.
    if (membroUnicoId !== null && c.id === membroUnicoId) {
      return { type: 'update', path: produtoDocPath(c.id), data: { ...grupo } };
    }
    // A real variation takes the flags only. Its own map is authored by
    // `buildChildrenComponentesKitOps`, and the clear stays because a non-kit
    // must not keep a map — the direction that was always right.
    const data: Record<string, unknown> = {
      ehKit: grupo.ehKit,
      ehKitVirtual: grupo.ehKitVirtual,
    };
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

// ---------------------------------------------------------------------------
// The sole member a produto is born with (#1398)
// ---------------------------------------------------------------------------

/**
 * The two writes that turn a freshly created produto into a FAMILY OF ONE: the
 * sole member's document, and the parent's pointer at it.
 *
 * ⚠️ They belong to ONE atomic boundary and the caller must keep them there.
 * The pointer is what every reader resolves through; a parent written without
 * its child points at nothing, and a child written without the pointer is
 * invisible to every surface that looks the family up. Both halves are wrong in
 * ways nothing later repairs, which is why this returns a pair rather than two
 * callables — `saveRecord`'s `siblingWrites` commit with the produto doc or not
 * at all.
 *
 * ⚠️ `filhoUnicoId` goes through {@link derivarFilhoUnico} rather than being set
 * to `childId` directly. It is the same value here — there is exactly one child
 * — but routing every writer through the one producer is what keeps the
 * denormalisation honest when a later writer has a child SET rather than a
 * single id.
 */
export function buildMembroUnicoWriteOps(
  parentId: string,
  childId: string,
  parent: ParentParaMembroUnico,
): ProdutoWriteOp[] {
  return [
    { type: 'set', path: produtoDocPath(childId), data: montarMembroUnico(parentId, parent) },
    {
      type: 'update',
      path: produtoDocPath(parentId),
      data: { filhoUnicoId: derivarFilhoUnico([{ id: childId }]) },
    },
  ];
}

// ---------------------------------------------------------------------------
// Duplicar produto (#556) — clone a parent + its variation children
// ---------------------------------------------------------------------------

/** Flutter caps a produto name at 100 (`produto.ts:45`); the renamed clone must too. */
const PRODUTO_NOME_MAX = 100;

/** Port of the legacy `CopiarProdutoAction`'s "(cópia)" suffix. */
const SUFIXO_DUPLICATA = ' (cópia)';

/**
 * Fields a duplicate must never inherit from its source, on BOTH the cloned
 * parent and every re-created child.
 *
 * **Exclusive identifiers.** A second document carrying one of these does not
 * merely look wrong — it makes an existing lookup answer the wrong question:
 *
 * - `sku` — the app's de-facto unique produto key, and the one that costs money
 *   to get wrong. `orderProdutoResolve` (apps/mercado-livre) resolves an ML
 *   order line by SKU through `probeSkuUnico`: two produtos sharing one yields
 *   `via: 'ambiguous-sku'` with `produtoId: null`, so a LIVE sale moves no
 *   stock and only an incidente records it. `resolveScan` (despacho checkout)
 *   is worse — `where('sku','==',x) limit(1)` silently binds whichever produto
 *   Firestore returns first. `SkuField`'s "gerar SKU único" button already
 *   probes that same query, so uniqueness is an assumption the app makes
 *   today, and `firestore.indexes.json` carries `produtos(sku)` plus
 *   `produtos(sku, paiId)` to serve it. Cleared here; the caller supplies a
 *   FRESHLY MINTED unique value per document (`novoSku` below).
 * - `gtin` — catalogue-owned: it identifies the physical product, not our
 *   record of it (`categoriaAtributos.ts` says exactly that of the ML
 *   attribute), so two produtos may never claim the same one.
 * - `codPai` — the parent's own code, mirrored onto its members by
 *   `espelhoDoMembroUnico`. The clone no longer carries that code, so a copy
 *   would name a produto that is not its parent.
 * - `codFornecedor` — the supplier's code for that one stocked item.
 *
 * **Marketplace links** (`marketplace`/`marketplaceIds`/`integracoesComProduto`/
 * `statusProdutosMarketplace`) — copying a live external listing id onto a new
 * produto would make two documents claim the same anúncio. ⚠️ The anúncios
 * THEMSELVES are the produto's `PRODUTO_SUBCOLLECTION_NAMES` subcollections and
 * are never cloned at all: {@link buildDuplicarProdutoWriteOps} emits no
 * subcollection path except the produto's own `extraData`/`imposto`, which is
 * pinned by a test rather than left true by accident.
 *
 * **Media** (`fotos`/`videos`/`anexos`/`fotosArquivosIds`) — arquivos are
 * content-addressed and doc-anchored (the `arquivos` skill); duplicating the
 * REFERENCE here would double-count the same file in the orphan sweep without
 * duplicating anything the operator could actually reuse.
 *
 * **Lifecycle** — `publicado` goes back to `false`. A produto is born a draft
 * and is published explicitly (see that field's own docstring); a clone that
 * arrived already visible in the catalogue would have been published by nobody.
 *
 * **Server-managed** — `nome_embedding` describes the SOURCE's name, which the
 * parent clone changes below; stale from the moment it is written.
 *
 * ⚠️ What deliberately DOES carry over, because none of it is an identity:
 * `categoriaProdutoOuterRef`; `tabelaDeMedidasModaUid` (a tabela de medidas is
 * a shared document meant to be reused across produtos); `precos`/`custo`; the
 * five dimensions; the kit fields — `componentesKit` names OTHER produtos, so a
 * duplicated kit assembles from the same components, which is the point; and
 * the variation taxonomy (`variacoesUid`/`grupoDeVariacoesUid`, ids of shared
 * `grupoDeVariacoes` docs).
 */
function limparParaDuplicar(dados: Produto): Record<string, unknown> {
  return {
    ...dados,
    sku: null,
    gtin: null,
    codPai: null,
    codFornecedor: null,
    marketplace: [],
    marketplaceIds: null,
    statusProdutosMarketplace: null,
    integracoesComProduto: [],
    fotos: null,
    videos: null,
    anexos: null,
    fotosArquivosIds: null,
    publicado: false,
    nome_embedding: null,
  };
}

/**
 * The clone's name — the legacy `" (cópia)"` suffix, always present.
 *
 * ⚠️ Truncating the CONCATENATION instead drops the suffix exactly when it
 * matters most: a source already at the 100-char cap would clone to a name
 * character-for-character identical to its source, with nothing on screen
 * saying which of the two rows is the copy. Truncate the base, then append.
 */
function nomeDuplicado(nome: string): string {
  return `${nome.slice(0, PRODUTO_NOME_MAX - SUFIXO_DUPLICATA.length)}${SUFIXO_DUPLICATA}`;
}

/**
 * The new PARENT document for a "Duplicar produto" clone: every field of
 * `origem` except the exclusive ones (see {@link limparParaDuplicar}), renamed
 * with the legacy suffix and carrying the freshly minted SKU.
 */
function montarProdutoPaiDuplicado(
  origem: Produto,
  novoSku: string | null,
  now: number,
): Record<string, unknown> {
  return {
    ...limparParaDuplicar(origem),
    paiId: null,
    nome: nomeDuplicado(origem.nome),
    sku: novoSku,
    timestamp: now,
    ultimaModificacao: now,
  };
}

/**
 * One re-created variation CHILD for a "Duplicar produto" clone: every field of
 * `origem` except the exclusive ones, re-parented onto the new clone and
 * carrying its OWN freshly minted SKU.
 *
 * ⚠️ Unlike the parent, `nome` is copied VERBATIM. A variation's name is what
 * tells two siblings apart (Camisa Azul — P / G), not a marker that this is a
 * copy; the copy is named on the parent.
 */
function montarProdutoFilhoDuplicado(
  origem: Produto,
  novoPaiId: string,
  novoSku: string | null,
  now: number,
): Record<string, unknown> {
  return {
    ...limparParaDuplicar(origem),
    paiId: novoPaiId,
    sku: novoSku,
    // A child never points at a child (`familia.ts`'s `montarMembroUnico`
    // makes the same choice for the sole-member case this mirrors).
    filhoUnicoId: null,
    timestamp: now,
    ultimaModificacao: now,
  };
}

/** One existing variation child, paired with the fresh identity its clone gets. */
export interface FilhoParaDuplicar {
  /** The SOURCE child's doc id — what the family-of-one check compares against. */
  id: string;
  dados: Produto;
  /** Fresh doc id for the clone; this module has no id generator (the adapter does). */
  novoId: string;
  /**
   * Fresh unique SKU for the clone, or null to leave it empty.
   *
   * ⚠️ Ignored for the genuine family-of-one member, whose SKU is DERIVED from
   * the parent's rather than minted here — `espelhoDoMembroUnico` runs it
   * through `skuDoMembroUnico`, which appends `SUFIXO_MEMBRO_UNICO`. See
   * {@link ehFamiliaDeUmParaDuplicar}.
   */
  novoSku: string | null;
  /** The source child's `extraData` singleton, when it has one. */
  extraData?: ProdutoExtraData | null;
  /** The source child's per-operação `imposto` docs. */
  impostos?: readonly ImpostoProduto[];
}

/** Everything {@link buildDuplicarProdutoWriteOps} needs — read and minted by the caller. */
export interface DuplicarProdutoInput {
  novoParentId: string;
  parentOrigem: Produto;
  /** Freshly minted unique SKU for the clone, or null to leave it empty. */
  novoParentSku: string | null;
  parentExtraData?: ProdutoExtraData | null;
  parentImpostos?: readonly ImpostoProduto[];
  filhos: readonly FilhoParaDuplicar[];
  now: number;
}

/**
 * Is the source a GENUINE family of one — exactly one child, and that child is
 * the parent's REGISTERED `filhoUnicoId` (#1398)?
 *
 * Exported because the SDK adapter needs the same answer before this runs: the
 * mirrored sole member's SKU is DERIVED from the parent's (`skuDoMembroUnico`,
 * suffix included), so a SKU minted for it would cost a server probe and then
 * be dropped. One rule in one place — two copies of it would drift toward
 * plausible and disagree silently (root `CLAUDE.md`).
 *
 * ⚠️ One child is NOT sufficient, because what the mirror branch does is
 * DISCARD the source child's own document and re-derive the member from the
 * renamed parent clone. That is right for a registered family of one and wrong
 * for a produto whose `filhoUnicoId` disagrees with its actual single child (a
 * data anomaly #1402 exists to find): there the stored child is the only record
 * of what that variation is, so it is re-created field-for-field like any other
 * family member.
 *
 * ⚠️ This says nothing about the clone's OWN `filhoUnicoId` — neither branch
 * copies it. `buildDuplicarProdutoWriteOps` always re-derives it from the fresh
 * ids in the same batch, so a source's dangling pointer is not reproduced on the
 * clone; reproducing it would just mint a second #1402 case.
 */
export function ehFamiliaDeUmParaDuplicar(
  parentOrigem: Pick<Produto, 'filhoUnicoId'>,
  filhos: readonly Pick<FilhoParaDuplicar, 'id'>[],
): boolean {
  return filhos.length === 1 && parentOrigem.filhoUnicoId === filhos[0]!.id;
}

/**
 * The produto-owned subdocuments that ride a clone: the `extraData` singleton
 * and the per-operação `imposto` docs. Both are catalog CONTENT (descrição,
 * marca, SEO copy; the produto's tax overrides) — what an operator duplicating
 * a produto expects to keep — and both go through the same builders every other
 * produto save uses, so their wire shapes cannot drift from those.
 *
 * ⚠️ `googleMerchantData.id` is cleared: that is the Google Merchant OFFER id,
 * an external identifier for one produto, and the reasoning that clears
 * `marketplaceIds` applies to it unchanged. `title` stays — operator copy, not
 * an identifier.
 *
 * ⚠️ Each cloned `imposto` row is re-stamped `now` (`timestamp: null` makes
 * `buildImpostoWriteOps` do it); inheriting the source's stamp would date the
 * new produto's tax row from before the produto existed. Only `set` ops ride
 * along: a brand-new produto has nothing to delete, so a fully-cleared source
 * row simply does not come with it.
 */
function buildSubdocsDuplicadosOps(
  produtoId: string,
  extraData: ProdutoExtraData | null | undefined,
  impostos: readonly ImpostoProduto[] | undefined,
  now: number,
): ProdutoWriteOp[] {
  const ops: ProdutoWriteOp[] = [];
  if (extraData) {
    const merchant = extraData.googleMerchantData;
    ops.push(
      ...buildExtraDataWriteOps(produtoId, {
        ...extraData,
        googleMerchantData: merchant ? { ...merchant, id: null } : null,
      }),
    );
  }
  if (impostos && impostos.length > 0) {
    const semStamp = impostos.map((imp) => ({ ...imp, timestamp: null }));
    ops.push(...buildImpostoWriteOps(produtoId, semStamp, now).filter((op) => op.type === 'set'));
  }
  return ops;
}

/**
 * The full write set for "Duplicar produto" (#556): a new parent document, one
 * re-created document per existing variation child, and each of those
 * produtos' `extraData`/`imposto` subdocuments — never a `copyHref` pre-fill,
 * because a produto owns children, kit composition and marketplace links a
 * plain create-form seed can't touch (the issue's own opening line).
 *
 * Every fresh id and every fresh SKU is the CALLER's: this module is pure, and
 * minting a unique SKU needs a server probe (`gerarSkuUnico`, apps/web).
 *
 * ⚠️ **What the clone does not inherit is the whole point** — see
 * {@link limparParaDuplicar} for the exclusive-field list and the failure each
 * entry prevents.
 *
 * ⚠️ **The family-of-one case reuses {@link buildMembroUnicoWriteOps}, not a
 * field-by-field child clone.** When `parentOrigem` has exactly one child AND
 * that child is its registered `filhoUnicoId` (a genuine family of one,
 * #1398), the new child is MIRRORED from the renamed clone — the same mechanism
 * every other creation path in the app uses to mint a sole member — rather than
 * copied verbatim from the old child, which would leave the new child naming
 * the OLD (pre-rename) produto and carrying the OLD SKU. Every other shape
 * (zero children, or more than one — a real variation family) re-creates each
 * child's own document.
 */
export function buildDuplicarProdutoWriteOps(input: DuplicarProdutoInput): ProdutoWriteOp[] {
  const { novoParentId, parentOrigem, novoParentSku, filhos, now } = input;

  const ehFamiliaDeUm = ehFamiliaDeUmParaDuplicar(parentOrigem, filhos);
  const parentClonado = montarProdutoPaiDuplicado(parentOrigem, novoParentSku, now);
  // ⚠️ Never inherited: `parentOrigem.filhoUnicoId` names the OLD child, which
  // would be actively wrong on the clone rather than merely stale. For a
  // genuine family of one it stays null here and `buildMembroUnicoWriteOps`
  // sets the real value in its own `update`; otherwise it is derived from the
  // fresh child ids in this same batch (`derivarFilhoUnico`).
  parentClonado.filhoUnicoId = ehFamiliaDeUm
    ? null
    : derivarFilhoUnico(filhos.map((f) => ({ id: f.novoId })));

  const ops: ProdutoWriteOp[] = [
    { type: 'set', path: produtoDocPath(novoParentId), data: parentClonado },
  ];

  if (ehFamiliaDeUm) {
    ops.push(
      ...buildMembroUnicoWriteOps(
        novoParentId,
        filhos[0]!.novoId,
        parentClonado as ParentParaMembroUnico,
      ),
    );
  } else {
    for (const filho of filhos) {
      ops.push({
        type: 'set',
        path: produtoDocPath(filho.novoId),
        data: montarProdutoFilhoDuplicado(filho.dados, novoParentId, filho.novoSku, now),
      });
    }
  }

  // Subdocuments last, after every produto doc: they are separate documents
  // whose relative write order does not matter, and keeping them at the tail
  // leaves the produto ops at stable indices for the caller and the tests.
  ops.push(
    ...buildSubdocsDuplicadosOps(novoParentId, input.parentExtraData, input.parentImpostos, now),
  );
  for (const filho of filhos) {
    ops.push(...buildSubdocsDuplicadosOps(filho.novoId, filho.extraData, filho.impostos, now));
  }
  return ops;
}
