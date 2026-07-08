import {
  buildEngineState,
  q2,
  q2eq,
  type EngineProduto,
  type ScanLogEntry,
} from './checkoutEngine';
import type { ItemDoPedido } from '../collection/pedido';

/**
 * A line (or kit component) whose scanned total does not match what the pedido
 * expects. `actual`/`expected` are 2-dp quantities.
 */
export interface CompletenessMismatch {
  pos: number;
  produtoUid: string | null;
  /** null for a non-kit item's line total; the component id for a kit component. */
  componentProdutoId: string | null;
  expected: number;
  actual: number;
}

/**
 * Recompute, from the scan log, whether every expected quantity is met — the
 * save-time gate (port of `checkout.dart:1115-1167`). Independent of the live
 * engine counters: it rebuilds the expected skeleton from the SERVER-FRESH,
 * ordem-sorted items and replays the active log rows (`error === null &&
 * excluidoMs === null`).
 *
 * INVARIANT: this is only sound when the pedido's items are unchanged since the
 * scan session began — the log rows' `targetKey`s (`exp-${pos}`) reference the
 * original ordem positions, and the fresh flatten reproduces them only if the
 * item list is identical. The save flow HARD-BLOCKS on any item change before
 * calling this (checkout port plan §7 PR 4, gate 3).
 *
 * A whole-kit row contributes `requiredPerKit` to each component (via
 * `launched × requiredPerKit`); a component row contributes 1 to its component.
 * A non-kit line is complete iff `Σ units === quantidade`; a kit line iff every
 * component's total equals its required total. Unbound lines (`produtoUid ===
 * null`) are skipped (legacy 1121); a missing-produto line is always a mismatch.
 */
export function checkCompleteness(args: {
  itens: ReadonlyArray<ItemDoPedido>;
  produtos: ReadonlyMap<string, EngineProduto>;
  log: ReadonlyArray<ScanLogEntry>;
}): { complete: boolean; mismatches: CompletenessMismatch[] } {
  const { itens, produtos, log } = args;
  const base = buildEngineState({ itens, produtos });

  // Accumulate active-row credits per item position.
  const launched = new Array<number>(base.expected.length).fill(0);
  const direct: Array<Map<string, number> | null> = base.expected.map((it) =>
    it.componentes ? new Map(it.componentes.map((c) => [c.produtoId, 0])) : null,
  );
  const keyToPos = new Map(base.expected.map((it) => [it.key, it.pos]));

  for (const e of log) {
    if (e.error !== null || e.excluidoMs !== null || e.targetKey === null) continue;
    const pos = keyToPos.get(e.targetKey);
    if (pos === undefined) continue;
    if (e.kind === 'component' && e.componentProdutoId !== null) {
      const m = direct[pos];
      if (m && m.has(e.componentProdutoId)) {
        m.set(e.componentProdutoId, m.get(e.componentProdutoId)! + e.quantidade);
      }
    } else {
      launched[pos]! += e.quantidade;
    }
  }

  const mismatches: CompletenessMismatch[] = [];
  for (const it of base.expected) {
    if (it.produtoUid === null) continue; // unbound line — skipped like legacy 1121
    if (it.error !== null) {
      // Produto doc missing → can never be complete.
      mismatches.push({
        pos: it.pos,
        produtoUid: it.produtoUid,
        componentProdutoId: null,
        expected: it.quantidade,
        actual: 0,
      });
      continue;
    }
    if (!it.ehKit) {
      const actual = launched[it.pos]!;
      if (!q2eq(actual, it.quantidade)) {
        mismatches.push({
          pos: it.pos,
          produtoUid: it.produtoUid,
          componentProdutoId: null,
          expected: it.quantidade,
          actual,
        });
      }
      continue;
    }
    const m = direct[it.pos];
    for (const c of it.componentes ?? []) {
      const d = m?.get(c.produtoId) ?? 0;
      const actual = q2(d + launched[it.pos]! * c.requiredPerKit);
      if (!q2eq(actual, c.requiredTotal)) {
        mismatches.push({
          pos: it.pos,
          produtoUid: it.produtoUid,
          componentProdutoId: c.produtoId,
          expected: c.requiredTotal,
          actual,
        });
      }
    }
  }

  return { complete: mismatches.length === 0, mismatches };
}
