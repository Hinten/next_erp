import { describe, expect, it } from 'vitest';
import { applyScan, buildEngineState, flattenPedidoItens } from '@delfrance/schemas';
import { buildFixturePedido, fixtureBarcodes } from './buildFixture';

describe('buildFixturePedido', () => {
  it('produces `count` qty-1 items with strictly ascending ordem (default 1000)', () => {
    const data = buildFixturePedido();
    expect(data.itens).toHaveLength(1000);
    for (let i = 0; i < data.itens.length; i++) {
      expect(data.itens[i]!.quantidade).toBe(1);
      if (i > 0) expect(data.itens[i]!.ordem).toBeGreaterThan(data.itens[i - 1]!.ordem);
    }
  });

  it('respects a custom count', () => {
    expect(buildFixturePedido({ count: 7 }).itens).toHaveLength(7);
    expect(buildFixturePedido({ count: 0 }).itens).toHaveLength(0);
  });

  it('uses the documented `p<i>` produtoUid scheme (seed 0) and they are distinct', () => {
    const data = buildFixturePedido({ count: 50 });
    const uids = data.itens.map((i) => i.produtoUid);
    expect(uids[0]).toBe('p0');
    expect(uids[49]).toBe('p49');
    expect(new Set(uids).size).toBe(50);
  });

  it('makes ~kitRatio of the items kits (deterministic 3-of-10 at 0.3)', () => {
    const data = buildFixturePedido({ count: 1000, kitRatio: 0.3 });
    const kits = data.itens.filter((i) => data.produtos.get(i.produtoUid!)?.ehKit).length;
    expect(kits).toBe(300);
    expect(Math.abs(kits / data.itens.length - 0.3)).toBeLessThan(0.01);
  });

  it('honours a custom kitRatio', () => {
    const data = buildFixturePedido({ count: 100, kitRatio: 0.5 });
    const kits = data.itens.filter((i) => data.produtos.get(i.produtoUid!)?.ehKit).length;
    expect(kits).toBe(50);
  });

  it('kits carry exactly two single-unit components', () => {
    const data = buildFixturePedido({ count: 100 });
    const kits = [...data.produtos.values()].filter((p) => p.ehKit);
    expect(kits.length).toBeGreaterThan(0);
    for (const kit of kits) {
      const comps = Object.entries(kit.componentesKit ?? {});
      expect(comps).toHaveLength(2);
      for (const [, c] of comps) expect(c.quantidade).toBe(1);
    }
  });

  it('every item produtoUid resolves in the produtos map', () => {
    const data = buildFixturePedido({ count: 200 });
    for (const item of data.itens) {
      expect(item.produtoUid).not.toBeNull();
      expect(data.produtos.has(item.produtoUid!)).toBe(true);
    }
  });

  it("every kit's component ids resolve in the produtos map", () => {
    const data = buildFixturePedido({ count: 200 });
    for (const p of data.produtos.values()) {
      if (!p.ehKit || !p.componentesKit) continue;
      for (const cid of Object.keys(p.componentesKit)) {
        expect(data.produtos.has(cid)).toBe(true);
      }
    }
  });

  it('the flattened `itens` reconcile with the grouped `pedido.itens`', () => {
    const data = buildFixturePedido({ count: 100 });
    // Re-flattening the parsed grouped record must reproduce `data.itens`.
    expect(flattenPedidoItens(data.pedido.itens)).toEqual(data.itens);
    // The grouped keys are exactly the set of item produtoUids.
    expect(Object.keys(data.pedido.itens).sort()).toEqual(
      data.itens.map((i) => i.produtoUid!).sort(),
    );
  });

  it('builds a valid `pago` saída pedido with no pre-existing checkout', () => {
    const data = buildFixturePedido({ count: 10 });
    expect(data.pedido.estado).toBe('pago');
    expect(data.pedido.ehSaida).toBe(true);
    expect(data.pedidoId).toBe('harness-pedido-0');
    expect(data.existingCheckout).toBeNull();
    expect(data.incidentes).toEqual([]);
  });

  it('is deterministic for identical options', () => {
    const a = buildFixturePedido({ count: 120, kitRatio: 0.4, seed: 3 });
    const b = buildFixturePedido({ count: 120, kitRatio: 0.4, seed: 3 });
    expect(fixtureBarcodes(a)).toEqual(fixtureBarcodes(b));
    expect([...a.produtos.keys()].sort()).toEqual([...b.produtos.keys()].sort());
    expect(a.itens).toEqual(b.itens);
  });

  it('a non-zero seed produces a disjoint id space (fresh pedido on cycle)', () => {
    const a = buildFixturePedido({ count: 20, seed: 0 });
    const b = buildFixturePedido({ count: 20, seed: 1 });
    const aKeys = new Set(a.produtos.keys());
    for (const k of b.produtos.keys()) expect(aKeys.has(k)).toBe(false);
    expect(a.pedidoId).not.toBe(b.pedidoId);
  });

  it('fixtureBarcodes lists every item produtoUid in scan order', () => {
    const data = buildFixturePedido({ count: 100 });
    expect(fixtureBarcodes(data)).toEqual(data.itens.map((i) => i.produtoUid));
    expect(fixtureBarcodes(data)).toHaveLength(100);
  });

  // The fixture's whole purpose: driving the pure engine with its own barcodes
  // (one scan per code) must conclude every line — unit scans for plain
  // produtos, whole-kit scans for kits — leaving nothing remaining.
  it('scanning every barcode once completes the engine', () => {
    const data = buildFixturePedido({ count: 300 });
    let state = buildEngineState({ itens: data.itens, produtos: data.produtos });
    for (const code of fixtureBarcodes(data)) {
      const produto = data.produtos.get(code)!;
      state = applyScan(state, produto, { uid: code, timestampMs: 0 }).state;
    }
    expect(state.remainingCount).toBe(0);
    expect(state.expected.every((e) => e.concluido)).toBe(true);
    // One appended log row per scan, no error rows.
    expect(state.log).toHaveLength(300);
    expect(state.log.every((e) => e.kind !== 'error')).toBe(true);
  });
});
