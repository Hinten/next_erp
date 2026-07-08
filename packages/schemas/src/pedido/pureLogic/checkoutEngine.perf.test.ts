import { describe, expect, it } from 'vitest';
import {
  applyScan,
  buildEngineState,
  type CheckoutEngineState,
  type EngineProduto,
} from './checkoutEngine';
import { checkCompleteness } from './checkoutCompleteness';
import { itemDoPedidoSchema, type ItemDoPedido } from '../collection/pedido';

/**
 * CI-deterministic algorithmic guard for the scan engine. It does NOT rely on
 * wall-clock (which flakes on shared runners) for its primary assertions: it
 * counts how many candidate positions each scan considers (via counting-wrapper
 * index Maps — production state stays clean) and asserts (a) the per-scan
 * candidate count is O(1), bounded regardless of the 1000-item size, and (b) the
 * total scales linearly with the number of scans, not quadratically. Wall-time
 * is a generous secondary check. The full render/scroll/leak budget lives in the
 * PR 7 local Playwright spec.
 */

/** A pedido of `n` qty-1 items, 30% of them kits with 2–4 unique components. */
function buildFixture(n: number): { itens: ItemDoPedido[]; produtos: Map<string, EngineProduto> } {
  const itens: ItemDoPedido[] = [];
  const produtos = new Map<string, EngineProduto>();
  for (let i = 0; i < n; i++) {
    const id = `p${i}`;
    const isKit = i % 10 < 3; // 30%
    let kit: Record<string, { quantidade: number }> | null = null;
    if (isKit) {
      const nc = 2 + (i % 3); // 2–4 components
      kit = {};
      for (let j = 0; j < nc; j++) kit[`${id}-c${j}`] = { quantidade: 1 + (j % 2) }; // perKit 1|2
    }
    produtos.set(id, { id, nome: id, sku: null, ehKit: isKit, componentesKit: kit, fotos: null });
    itens.push(
      itemDoPedidoSchema.parse({ produtoUid: id, quantidade: 1, ordem: i, precoDeVenda: 10 }),
    );
  }
  return { itens, produtos };
}

/** ReadonlyMap wrapper that sums the length of every array `applyScan` looks up. */
function countingMap(
  orig: ReadonlyMap<string, readonly number[]>,
  counter: { n: number },
): ReadonlyMap<string, readonly number[]> {
  return {
    get(k: string) {
      const v = orig.get(k);
      if (v) counter.n += v.length;
      return v;
    },
  } as unknown as ReadonlyMap<string, readonly number[]>;
}

function runScenario(n: number) {
  const { itens, produtos } = buildFixture(n);
  const base = buildEngineState({ itens, produtos });
  const counter = { n: 0 };
  let state: CheckoutEngineState = {
    ...base,
    byProdutoId: countingMap(base.byProdutoId, counter),
    byComponentId: countingMap(base.byComponentId, counter),
  };
  const t0 = performance.now();
  for (const it of itens) {
    // Scan each item's produto once — a non-kit unit or a whole-kit scan, either
    // of which completes a qty-1 line.
    const p = produtos.get(it.produtoUid!)!;
    state = applyScan(state, p, { uid: `s${it.ordem}`, timestampMs: 0 }).state;
  }
  const ms = performance.now() - t0;
  const complete = checkCompleteness({ itens, produtos, log: state.log }).complete;
  return { candidatesVisited: counter.n, ms, state, complete, scans: itens.length };
}

describe('checkoutEngine perf (algorithmic bounds)', () => {
  it('1000 items: ≤4 candidates/scan, all completed, and well under 2s', () => {
    const r = runScenario(1000);
    expect(r.state.remainingCount).toBe(0);
    expect(r.state.expected.every((e) => e.concluido)).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.candidatesVisited / r.scans).toBeLessThanOrEqual(4);
    expect(r.ms).toBeLessThan(2000);
  });

  it('scales linearly: 2000-item candidatesVisited ≤ 2.2× the 1000-item run', () => {
    const a = runScenario(1000);
    const b = runScenario(2000);
    expect(b.scans).toBe(2 * a.scans);
    expect(b.candidatesVisited).toBeLessThanOrEqual(a.candidatesVisited * 2.2);
  });
});
