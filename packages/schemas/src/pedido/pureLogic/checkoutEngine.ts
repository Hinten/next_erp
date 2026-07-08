import { roundReais } from '@delfrance/core/money';
import {
  ITEM_CHECKOUT_ERRORS,
  type ItemCheckoutError,
  type ItemCheckoutPedido,
} from '../collection/checkout';
import type { ItemDoPedido } from '../collection/pedido';
import type { Produto } from '../../produto/collection/produto';

/**
 * The pure kit-matching checkout engine — the heart of the dispatch/checkout
 * screen. A behavioral port of the legacy Flutter engine
 * (`.old/lib/despacho/pages/checkout.dart` — `lancarProduto` 1449-1619,
 * `deleteItem` 713-742, models 26-163), restructured to be O(1)-amortized per
 * scan (prebuilt position indexes, zero async in the hot path) and fully
 * immutable (React can `memo` rows on reference identity).
 *
 * Shared by BOTH the scanning UI (PR 5) and the save-side completeness check
 * (`checkoutCompleteness.ts`, consumed by the save flow), so the types below are
 * the single cross-PR contract. Zero React / Firestore deps.
 *
 * Two DELIBERATE divergences from the buggy legacy (see the checkout port plan
 * §2.3 — "do not port, fix + pin"):
 *   1. "Todos os items já foram lançados" fires on `remainingCount === 0` (every
 *      scannable item concluded), not only on a genuinely empty expected list.
 *      Legacy fell through to "Produto não esperado" once all were concluded.
 *   2. The legacy component look-ahead had an off-by-one (`skip(index)` included
 *      the current item, so the "Quantidade excedida" branch was unreachable).
 *      Here the rule is uniform: candidates exist but all are
 *      concluded/saturated → "Quantidade excedida"; no candidate at all →
 *      "Produto não esperado".
 */

/* -------------------------------------------------------------------------- */
/*                         2-decimal quantity helpers                         */
/* -------------------------------------------------------------------------- */

/**
 * Half-up 2-decimal rounding — the repo canonical (`@delfrance/core/money`),
 * replacing the legacy `duasCasasDecimais` (`toStringAsFixed(2)`;
 * `.old/packages/global/lib/src/mathExtensions.dart:3-7`). Same documented
 * x.xx5-edge divergence stance as `totals.ts`. Never `.toFixed(2)` (lint-banned).
 */
export const q2 = roundReais;

/** 2-decimal equality: `q2(a) === q2(b)`. */
export function q2eq(a: number, b: number): boolean {
  return q2(a) === q2(b);
}

/* -------------------------------------------------------------------------- */
/*                                   Types                                     */
/* -------------------------------------------------------------------------- */

/**
 * The engine's view of a produto — built by the caller (PR 4 `loadCheckoutData`)
 * from a Firestore `Produto` doc. The engine never touches the Firestore SDK; it
 * consumes this projection only.
 */
export interface EngineProduto {
  id: string;
  nome: string | null;
  sku: string | null;
  ehKit: boolean;
  /** component produto id → per-kit quantity (`Kit.quantidade`, int ≥ 1). */
  componentesKit: Record<string, { quantidade: number }> | null;
  /** passthrough for UI photo resolution (PR 5); the engine ignores it. */
  fotos: Produto['fotos'] | null;
}

/** One component of a kit expected-item. */
export interface ExpectedComponent {
  produtoId: string;
  /** per-kit quantity of this component (`Kit.quantidade`). */
  requiredPerKit: number;
  /** total required across the whole line: `q2(item.quantidade × requiredPerKit)`. */
  requiredTotal: number;
  /** units of this component scanned INDIVIDUALLY (not via a whole-kit scan). */
  launchedDirect: number;
}

/** One expected line item to verify by scanning. */
export interface ExpectedItem {
  /** stable React key + completeness attribution key: `exp-${pos}`. */
  key: string;
  /** position in the ordem-sorted flattened item list (never moves). */
  pos: number;
  produtoUid: string | null;
  nomeDeVenda: string | null;
  sku: string | null;
  quantidade: number;
  ehKit: boolean;
  componentes: readonly ExpectedComponent[] | null;
  /** non-kit: units scanned; kit: WHOLE-kit scans (components tracked per-component). */
  launched: number;
  concluido: boolean;
  /** `'Produto não encontrado'` when the produto doc is missing; else null. */
  error: string | null;
}

export type ScanKind = 'unit' | 'kit' | 'component' | 'error';

/**
 * One row of the scan audit log. `timestampMs` / `excluidoMs` are MILLISECONDS
 * since epoch (the wire unit — see `collection/checkout.ts`); the wire mapping
 * `toItemCheckoutPedido` writes them straight through to `timestamp` /
 * `dataExclusao`.
 */
export interface ScanLogEntry {
  /** injected uuid — React key AND the wire-order key (log is emitted in insertion order). */
  uid: string;
  produtoId: string | null;
  produtoNome: string;
  produtoSku: string | null;
  quantidade: number;
  kind: ScanKind;
  /** the ExpectedItem.key this scan credited (null for error rows). */
  targetKey: string | null;
  /** for `kind:'component'`, which component produto id was credited. */
  componentProdutoId: string | null;
  error: string | null;
  timestampMs: number;
  excluidoMs: number | null;
}

export interface CheckoutEngineState {
  expected: readonly ExpectedItem[];
  /** scanned produto id → positions where it is a unit / whole-kit target (ordem asc). */
  byProdutoId: ReadonlyMap<string, readonly number[]>;
  /** scanned produto id → positions of kit items that contain it as a component (ordem asc). */
  byComponentId: ReadonlyMap<string, readonly number[]>;
  log: readonly ScanLogEntry[];
  /** scannable (produto-bound, non-error) items not yet concluded. */
  remainingCount: number;
}

export interface ScanOutcome {
  state: CheckoutEngineState;
  /** the appended log entry (its `kind` / `error` tell the caller what happened). */
  entry: ScanLogEntry;
}

/* -------------------------------------------------------------------------- */
/*                                 Selectors                                   */
/* -------------------------------------------------------------------------- */

/**
 * Total units of a component accounted for = individually-scanned
 * (`launchedDirect`) + the contribution of every whole-kit scan
 * (`item.launched × requiredPerKit`). 2-dp rounded.
 */
export function componentProgress(item: ExpectedItem, c: ExpectedComponent): number {
  return q2(c.launchedDirect + item.launched * c.requiredPerKit);
}

/**
 * How many whole kits' worth have been assembled for this item — closed form
 * replacing the legacy decrement `while`-loop (`checkout.dart:1585-1600`):
 * whole-kit scans + the extra complete kits assemblable from the individually
 * scanned components. `requiredPerKit ≥ 1` (Kit.quantidade min 1) → no div-by-0.
 */
export function kitEquivalents(item: ExpectedItem): number {
  if (!item.ehKit || !item.componentes || item.componentes.length === 0) return item.launched;
  let minAdditional = Infinity;
  for (const c of item.componentes) {
    // requiredPerKit is schema-guaranteed ≥ 1; guard defensively against a
    // malformed 0 so a bad projection can't leak NaN into the UI badge.
    const per = c.requiredPerKit;
    minAdditional = Math.min(minAdditional, per > 0 ? Math.floor(c.launchedDirect / per) : 0);
  }
  return item.launched + (minAdditional === Infinity ? 0 : minAdditional);
}

/** A kit item is complete when every component's progress hits its required total. */
function kitConcluido(item: ExpectedItem, componentes: readonly ExpectedComponent[]): boolean {
  return componentes.every((c) =>
    q2eq(c.launchedDirect + item.launched * c.requiredPerKit, c.requiredTotal),
  );
}

/* -------------------------------------------------------------------------- */
/*                              buildEngineState                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the initial engine state from the ordem-sorted flattened pedido items
 * and a produto lookup. Kit components carry `requiredTotal = q2(lineQty ×
 * perKit)` (legacy pre-multiply, `checkout.dart:139`). A produto-bound item
 * whose produto doc is absent is flagged `error: 'Produto não encontrado'`
 * (legacy 213-216) and excluded from `remainingCount`; an unbound item
 * (`produtoUid === null`) is inert (never scannable, skipped at save).
 */
export function buildEngineState(args: {
  itens: ReadonlyArray<ItemDoPedido>;
  produtos: ReadonlyMap<string, EngineProduto>;
}): CheckoutEngineState {
  const { itens, produtos } = args;
  const expected: ExpectedItem[] = [];
  const byProdutoId = new Map<string, number[]>();
  const byComponentId = new Map<string, number[]>();

  const push = (m: Map<string, number[]>, k: string, pos: number): void => {
    const arr = m.get(k);
    if (arr) arr.push(pos);
    else m.set(k, [pos]);
  };

  itens.forEach((item, pos) => {
    const produtoUid = item.produtoUid ?? null;
    const produto = produtoUid !== null ? produtos.get(produtoUid) : undefined;
    const missing = produtoUid !== null && produto === undefined;
    const ehKit = produto?.ehKit ?? false;

    let componentes: ExpectedComponent[] | null = null;
    if (ehKit && produto?.componentesKit) {
      componentes = Object.entries(produto.componentesKit).map(([cid, { quantidade }]) => ({
        produtoId: cid,
        requiredPerKit: quantidade,
        requiredTotal: q2(item.quantidade * quantidade),
        launchedDirect: 0,
      }));
    }

    expected.push({
      key: `exp-${pos}`,
      pos,
      produtoUid,
      nomeDeVenda: item.nomeDeVenda ?? null,
      sku: item.sku ?? null,
      quantidade: item.quantidade,
      ehKit,
      componentes,
      launched: 0,
      concluido: false,
      error: missing ? 'Produto não encontrado' : null,
    });

    // Index unit/whole-kit targets by produtoUid, kit components by component id.
    if (produtoUid !== null) push(byProdutoId, produtoUid, pos);
    if (componentes) for (const c of componentes) push(byComponentId, c.produtoId, pos);
  });

  const remainingCount = expected.reduce(
    (n, it) => (it.produtoUid !== null && it.error === null && !it.concluido ? n + 1 : n),
    0,
  );

  return { expected, byProdutoId, byComponentId, log: [], remainingCount };
}

/* -------------------------------------------------------------------------- */
/*                                 applyScan                                  */
/* -------------------------------------------------------------------------- */

/** Merge two ascending position lists into one ascending, de-duplicated list. */
function mergePositions(a: readonly number[], b: readonly number[]): number[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]! < b[j]!) out.push(a[i++]!);
    else if (a[i]! > b[j]!) out.push(b[j++]!);
    else {
      out.push(a[i++]!);
      j++;
    }
  }
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

/**
 * Apply one scan of `produto` (a single physical unit). Returns the new state
 * plus the appended log entry. O(1) amortized: walks the 1–3-element candidate
 * merge, no async. Behavioral port of `lancarProduto` (`checkout.dart:1449-1619`).
 */
export function applyScan(
  state: CheckoutEngineState,
  produto: EngineProduto,
  meta: { uid: string; timestampMs: number },
): ScanOutcome {
  const errorOutcome = (error: ItemCheckoutError): ScanOutcome => {
    const entry: ScanLogEntry = {
      uid: meta.uid,
      produtoId: produto.id,
      produtoNome: produto.nome ?? '',
      produtoSku: produto.sku,
      quantidade: 1,
      kind: 'error',
      targetKey: null,
      componentProdutoId: null,
      error,
      timestampMs: meta.timestampMs,
      excluidoMs: null,
    };
    return { state: { ...state, log: [...state.log, entry] }, entry };
  };

  // 1. Everything scannable is already done.
  if (state.remainingCount === 0) return errorOutcome(ITEM_CHECKOUT_ERRORS.todosLancados);

  // 2. Candidate positions where this produto is a unit/whole-kit target OR a component.
  const candidates = mergePositions(
    state.byProdutoId.get(produto.id) ?? [],
    state.byComponentId.get(produto.id) ?? [],
  );
  // The produto is expected nowhere in this pedido.
  if (candidates.length === 0) return errorOutcome(ITEM_CHECKOUT_ERRORS.produtoNaoEsperado);

  const success = (
    newItem: ExpectedItem,
    pos: number,
    kind: Exclude<ScanKind, 'error'>,
    componentProdutoId: string | null,
  ): ScanOutcome => {
    const becameConcluido = newItem.concluido && !state.expected[pos]!.concluido;
    const expected = state.expected.map((it, i) => (i === pos ? newItem : it));
    const entry: ScanLogEntry = {
      uid: meta.uid,
      produtoId: produto.id,
      produtoNome: produto.nome ?? '',
      produtoSku: produto.sku,
      quantidade: 1,
      kind,
      targetKey: newItem.key,
      componentProdutoId,
      error: null,
      timestampMs: meta.timestampMs,
      excluidoMs: null,
    };
    return {
      state: {
        ...state,
        expected,
        log: [...state.log, entry],
        remainingCount: becameConcluido ? state.remainingCount - 1 : state.remainingCount,
      },
      entry,
    };
  };

  // 3. Walk candidates in ordem order, skipping concluded / error items.
  for (const pos of candidates) {
    const item = state.expected[pos]!;
    if (item.concluido || item.error !== null) continue;

    if (!item.ehKit) {
      // (a) non-kit exact match — always admits (over-scan is caught once the
      //     item concludes and is thereafter skipped → "Quantidade excedida").
      if (item.produtoUid === produto.id) {
        const launched = item.launched + 1;
        return success(
          { ...item, launched, concluido: q2eq(launched, item.quantidade) },
          pos,
          'unit',
          null,
        );
      }
      continue;
    }

    // (b) whole-kit scan.
    if (item.produtoUid === produto.id) {
      const componentes = item.componentes ?? [];
      const admissible = componentes.every(
        (c) => q2(c.launchedDirect + (item.launched + 1) * c.requiredPerKit) <= c.requiredTotal,
      );
      if (!admissible) continue; // saturated → try a later candidate
      const launched = item.launched + 1;
      const newItem: ExpectedItem = {
        ...item,
        launched,
        concluido: kitConcluido({ ...item, launched }, componentes),
      };
      return success(newItem, pos, 'kit', null);
    }

    // (c) kit where the scanned produto is one of its components.
    const componentes = item.componentes ?? [];
    const ci = componentes.findIndex((c) => c.produtoId === produto.id);
    if (ci >= 0) {
      const c = componentes[ci]!;
      // admit only if this unit keeps the component ≤ its required total.
      if (q2(componentProgress(item, c) + 1) > c.requiredTotal) continue; // saturated → next candidate
      const newComponentes = componentes.map((x, i) =>
        i === ci ? { ...x, launchedDirect: x.launchedDirect + 1 } : x,
      );
      const newItem: ExpectedItem = {
        ...item,
        componentes: newComponentes,
        concluido: kitConcluido(item, newComponentes),
      };
      return success(newItem, pos, 'component', produto.id);
    }
  }

  // 4. Candidates existed but all were concluded/saturated → excess.
  return errorOutcome(ITEM_CHECKOUT_ERRORS.quantidadeExcedida);
}

/* -------------------------------------------------------------------------- */
/*                                applyDelete                                 */
/* -------------------------------------------------------------------------- */

/**
 * Soft-delete a scan-log row by uuid: stamp `excluidoMs` and reverse its credit
 * (unit/kit → `launched-1`; component → that component's `launchedDirect-1`),
 * recomputing `concluido`. Error rows only get the mark. Double-delete and
 * unknown-uid are no-ops. Port of `deleteItem` (`checkout.dart:713-742`).
 */
export function applyDelete(
  state: CheckoutEngineState,
  entryUid: string,
  nowMs: number,
): CheckoutEngineState {
  const idx = state.log.findIndex((e) => e.uid === entryUid);
  if (idx < 0) return state;
  const entry = state.log[idx]!;
  if (entry.excluidoMs !== null) return state; // double-delete no-op

  const log = state.log.map((e, i) => (i === idx ? { ...e, excluidoMs: nowMs } : e));

  // Error rows credited nothing.
  if (entry.kind === 'error' || entry.targetKey === null) return { ...state, log };

  const pos = state.expected.findIndex((it) => it.key === entry.targetKey);
  if (pos < 0) return { ...state, log }; // defensive: target vanished
  const item = state.expected[pos]!;

  let newItem: ExpectedItem;
  if (entry.kind === 'component' && entry.componentProdutoId !== null) {
    const componentes = (item.componentes ?? []).map((c) =>
      c.produtoId === entry.componentProdutoId
        ? { ...c, launchedDirect: c.launchedDirect - entry.quantidade }
        : c,
    );
    newItem = { ...item, componentes, concluido: kitConcluido(item, componentes) };
  } else {
    const launched = item.launched - entry.quantidade;
    const withLaunched = { ...item, launched };
    newItem = {
      ...withLaunched,
      concluido: item.ehKit
        ? kitConcluido(withLaunched, item.componentes ?? [])
        : q2eq(launched, item.quantidade),
    };
  }

  const expected = state.expected.map((it, i) => (i === pos ? newItem : it));
  const remainingCount =
    item.concluido && !newItem.concluido ? state.remainingCount + 1 : state.remainingCount;
  return { ...state, expected, log, remainingCount };
}

/* -------------------------------------------------------------------------- */
/*                              Wire mapping                                  */
/* -------------------------------------------------------------------------- */

/**
 * Map a scan-log entry to the persisted `ItemCheckoutPedido` wire shape. The
 * save flow emits `state.log.map(toItemCheckoutPedido)` — ALL rows in insertion
 * (`uid`) order, active + soft-deleted + deleted-error (the full audit trail).
 * Timestamps are milliseconds (§4 decision).
 */
export function toItemCheckoutPedido(entry: ScanLogEntry): ItemCheckoutPedido {
  return {
    produtoCheckoutPedidoOuterRef: entry.produtoId ? `documents/produtos/${entry.produtoId}` : null,
    quantidade: entry.quantidade,
    dataExclusao: entry.excluidoMs,
    error: entry.error,
    timestamp: entry.timestampMs,
  };
}
