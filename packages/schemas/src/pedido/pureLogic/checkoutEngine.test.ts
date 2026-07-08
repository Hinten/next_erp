import { describe, expect, it } from 'vitest';
import {
  applyDelete,
  applyScan,
  buildEngineState,
  kitEquivalents,
  q2eq,
  toItemCheckoutPedido,
  type CheckoutEngineState,
  type EngineProduto,
  type ExpectedItem,
  type ScanOutcome,
} from './checkoutEngine';
import { ITEM_CHECKOUT_ERRORS } from '../collection/checkout';
import { itemDoPedidoSchema, type ItemDoPedido } from '../collection/pedido';

/* --------------------------------- helpers -------------------------------- */

/** Build an EngineProduto; pass `kit` (component id → perKit qty) to make a kit. */
function prod(
  id: string,
  opts: { nome?: string; sku?: string | null; kit?: Record<string, number> } = {},
): EngineProduto {
  return {
    id,
    nome: opts.nome ?? id,
    sku: opts.sku ?? null,
    ehKit: opts.kit !== undefined,
    componentesKit: opts.kit
      ? Object.fromEntries(Object.entries(opts.kit).map(([k, q]) => [k, { quantidade: q }]))
      : null,
    fotos: null,
  };
}

function item(produtoUid: string | null, quantidade: number, ordem: number): ItemDoPedido {
  return itemDoPedidoSchema.parse({
    produtoUid,
    quantidade,
    ordem,
    precoDeVenda: 10,
    nomeDeVenda: produtoUid,
  });
}

function mapOf(...ps: EngineProduto[]): Map<string, EngineProduto> {
  return new Map(ps.map((p) => [p.id, p]));
}

let uidN = 0;
function scan(state: CheckoutEngineState, p: EngineProduto): ScanOutcome {
  return applyScan(state, p, { uid: `u${uidN++}`, timestampMs: 1_700_000_000_000 });
}

/* ------------------------------ buildEngineState -------------------------- */

describe('buildEngineState', () => {
  it('keys items exp-${pos} in the given (pre-sorted) order and counts remaining', () => {
    // buildEngineState trusts already-flattened, ordem-sorted input (the caller
    // runs flattenPedidoItens first); position === array index.
    const s = buildEngineState({
      itens: [item('a', 1, 1), item('b', 1, 2)],
      produtos: mapOf(prod('a'), prod('b')),
    });
    expect(s.expected.map((e) => e.produtoUid)).toEqual(['a', 'b']);
    expect(s.expected.map((e) => e.key)).toEqual(['exp-0', 'exp-1']);
    expect(s.remainingCount).toBe(2);
  });

  it('expands a kit with requiredTotal = q2(lineQty × perKit)', () => {
    const s = buildEngineState({
      itens: [item('K', 3, 1)],
      produtos: mapOf(prod('K', { kit: { x: 2, y: 1 } })),
    });
    const k = s.expected[0]!;
    expect(k.ehKit).toBe(true);
    expect(k.componentes).toEqual([
      { produtoId: 'x', requiredPerKit: 2, requiredTotal: 6, launchedDirect: 0 },
      { produtoId: 'y', requiredPerKit: 1, requiredTotal: 3, launchedDirect: 0 },
    ]);
    expect(s.byComponentId.get('x')).toEqual([0]);
    expect(s.byComponentId.get('y')).toEqual([0]);
  });

  it('flags a missing produto as error and excludes it from remainingCount', () => {
    const s = buildEngineState({ itens: [item('gone', 1, 1)], produtos: mapOf() });
    expect(s.expected[0]!.error).toBe('Produto não encontrado');
    expect(s.remainingCount).toBe(0);
  });

  it('indexes a duplicate produto at every position', () => {
    const s = buildEngineState({
      itens: [item('d', 1, 1), item('d', 1, 2)],
      produtos: mapOf(prod('d')),
    });
    expect(s.byProdutoId.get('d')).toEqual([0, 1]);
  });

  it('treats an unbound (null produtoUid) line as inert — not in remainingCount', () => {
    const s = buildEngineState({
      itens: [item(null, 1, 1), item('a', 1, 2)],
      produtos: mapOf(prod('a')),
    });
    expect(s.remainingCount).toBe(1);
  });
});

/* --------------------------- applyScan: non-kit --------------------------- */

describe('applyScan — non-kit (a)', () => {
  it('increments and completes at quantidade', () => {
    let s = buildEngineState({ itens: [item('a', 2, 1)], produtos: mapOf(prod('a')) });
    let r = scan(s, prod('a'));
    expect(r.entry.kind).toBe('unit');
    expect(r.state.expected[0]!.launched).toBe(1);
    expect(r.state.expected[0]!.concluido).toBe(false);
    expect(r.state.remainingCount).toBe(1);
    r = scan(r.state, prod('a'));
    expect(r.state.expected[0]!.concluido).toBe(true);
    expect(r.state.remainingCount).toBe(0);
  });

  it('over-scan of a completed item (with others remaining) → Quantidade excedida', () => {
    let s = buildEngineState({
      itens: [item('a', 1, 1), item('b', 1, 2)],
      produtos: mapOf(prod('a'), prod('b')),
    });
    let r = scan(s, prod('a')); // a concluído
    r = scan(r.state, prod('a')); // over-scan a
    expect(r.entry.kind).toBe('error');
    expect(r.entry.error).toBe(ITEM_CHECKOUT_ERRORS.quantidadeExcedida);
  });
});

/* -------------------------- applyScan: whole-kit -------------------------- */

describe('applyScan — whole-kit (b)', () => {
  it('a whole-kit scan credits every component and completes a qty-1 kit', () => {
    const s = buildEngineState({
      itens: [item('K', 1, 1)],
      produtos: mapOf(prod('K', { kit: { x: 2, y: 1 } })),
    });
    const r = scan(s, prod('K', { kit: { x: 2, y: 1 } }));
    expect(r.entry.kind).toBe('kit');
    expect(r.state.expected[0]!.launched).toBe(1);
    expect(r.state.expected[0]!.concluido).toBe(true);
  });

  it('rejects a whole-kit scan that would push a component past its total (mixed history)', () => {
    // kit qty 2, X perKit 2 → requiredTotal 4. Scan X thrice (direct 3).
    let s = buildEngineState({
      itens: [item('K', 2, 1)],
      produtos: mapOf(prod('K', { kit: { x: 2 } })),
    });
    let r = scan(s, prod('x'));
    r = scan(r.state, prod('x'));
    r = scan(r.state, prod('x'));
    expect(r.state.expected[0]!.componentes![0]!.launchedDirect).toBe(3);
    // A whole-kit scan would add 2 → 5 > 4 → reject.
    r = scan(r.state, prod('K', { kit: { x: 2 } }));
    expect(r.entry.error).toBe(ITEM_CHECKOUT_ERRORS.quantidadeExcedida);
  });
});

/* -------------------------- applyScan: component -------------------------- */

describe('applyScan — component (c)', () => {
  it('credits individual components and completes a multi-component kit', () => {
    let s = buildEngineState({
      itens: [item('K', 1, 1)],
      produtos: mapOf(prod('K', { kit: { x: 2, y: 1 } })),
    });
    let r = scan(s, prod('x'));
    expect(r.entry.kind).toBe('component');
    expect(r.entry.componentProdutoId).toBe('x');
    r = scan(r.state, prod('x'));
    expect(r.state.expected[0]!.concluido).toBe(false); // y still missing
    r = scan(r.state, prod('y'));
    expect(r.state.expected[0]!.concluido).toBe(true);
  });

  it('rejects a component scan past its required total → Quantidade excedida', () => {
    // kit qty 1, X perKit 1 → requiredTotal 1, plus a second item so remaining > 0.
    let s = buildEngineState({
      itens: [item('K', 1, 1), item('b', 1, 2)],
      produtos: mapOf(prod('K', { kit: { x: 1 } }), prod('b')),
    });
    let r = scan(s, prod('x')); // K complete (X progress 1 == 1)
    expect(r.state.expected[0]!.concluido).toBe(true);
    r = scan(r.state, prod('x')); // over
    expect(r.entry.error).toBe(ITEM_CHECKOUT_ERRORS.quantidadeExcedida);
  });
});

/* --------------------------- overlap & ordem ------------------------------ */

describe('applyScan — overlap and ordem priority', () => {
  it('scans a produto standalone first, then as a later kit component (overlap)', () => {
    // item A (produto x) non-kit qty 1 at ordem 1; kit K (component x) qty 1 at
    // ordem 2; a spare item z so remainingCount stays > 0 after both x-targets fill.
    let s = buildEngineState({
      itens: [item('x', 1, 1), item('K', 1, 2), item('z', 1, 3)],
      produtos: mapOf(prod('x'), prod('K', { kit: { x: 1 } }), prod('z')),
    });
    let r = scan(s, prod('x')); // lands on the standalone item (pos 0)
    expect(r.entry.kind).toBe('unit');
    expect(r.entry.targetKey).toBe('exp-0');
    r = scan(r.state, prod('x')); // pos 0 done → lands on the kit component (pos 1)
    expect(r.entry.kind).toBe('component');
    expect(r.entry.targetKey).toBe('exp-1');
    r = scan(r.state, prod('x')); // both x-targets saturated, z still remaining
    expect(r.entry.error).toBe(ITEM_CHECKOUT_ERRORS.quantidadeExcedida);
  });

  it('fills duplicate produto lines in position order', () => {
    // Input is pre-sorted (flattenPedidoItens does the ordem sort — tested in
    // itens.test.ts); the walk fills the duplicate positions low-to-high.
    let s = buildEngineState({
      itens: [item('d', 1, 1), item('d', 1, 2)],
      produtos: mapOf(prod('d')),
    });
    let r = scan(s, prod('d'));
    expect(r.entry.targetKey).toBe('exp-0');
    r = scan(r.state, prod('d'));
    expect(r.entry.targetKey).toBe('exp-1');
  });
});

/* --------------------------- error precedence ----------------------------- */

describe('applyScan — error precedence', () => {
  it('empty pedido → Todos os items já foram lançados', () => {
    const s = buildEngineState({ itens: [], produtos: mapOf() });
    expect(scan(s, prod('z')).entry.error).toBe(ITEM_CHECKOUT_ERRORS.todosLancados);
  });

  it('all items concluded → Todos os items já foram lançados (divergence from legacy)', () => {
    let s = buildEngineState({ itens: [item('a', 1, 1)], produtos: mapOf(prod('a')) });
    let r = scan(s, prod('a'));
    expect(r.state.remainingCount).toBe(0);
    r = scan(r.state, prod('a'));
    expect(r.entry.error).toBe(ITEM_CHECKOUT_ERRORS.todosLancados);
  });

  it('unknown produto → Produto não esperado', () => {
    const s = buildEngineState({ itens: [item('a', 1, 1)], produtos: mapOf(prod('a')) });
    expect(scan(s, prod('z')).entry.error).toBe(ITEM_CHECKOUT_ERRORS.produtoNaoEsperado);
  });

  it('saturated component with no later absorber → Quantidade excedida (legacy skip() off-by-one fix)', () => {
    // Legacy skip(index) included the current item, making "Quantidade excedida"
    // unreachable here → it wrongly emitted "Produto não esperado". The port's
    // uniform rule: a candidate existed (this kit) but is saturated → excess.
    let s = buildEngineState({
      itens: [item('K', 1, 1), item('b', 1, 2)],
      produtos: mapOf(prod('K', { kit: { x: 1 } }), prod('b')),
    });
    let r = scan(s, prod('x')); // K complete
    r = scan(r.state, prod('x')); // x is a component only of the now-complete K
    expect(r.entry.error).toBe(ITEM_CHECKOUT_ERRORS.quantidadeExcedida);
  });
});

/* ------------------------------ kitEquivalents ---------------------------- */

describe('kitEquivalents', () => {
  // Direct port of the legacy decrement while-loop (checkout.dart:1585-1600).
  function legacyKitEquivalents(
    launched: number,
    comps: ReadonlyArray<{ perKit: number; direct: number }>,
  ): number {
    let qte = launched;
    const counter = comps.map((c) => c.direct);
    const origin = comps.map((c) => c.direct);
    const guard = () => counter.every((v, i) => v >= 0 && v <= origin[i]!);
    let iter = 0;
    while (guard() && iter++ < 100_000) {
      for (let i = 0; i < counter.length; i++) counter[i]! -= comps[i]!.perKit;
      if (counter.every((v) => v >= 0)) qte += 1;
    }
    return qte;
  }

  function kitItem(
    launched: number,
    comps: ReadonlyArray<{ perKit: number; direct: number }>,
  ): ExpectedItem {
    return {
      key: 'exp-0',
      pos: 0,
      produtoUid: 'K',
      nomeDeVenda: 'K',
      sku: null,
      quantidade: 1,
      ehKit: true,
      componentes: comps.map((c, i) => ({
        produtoId: `c${i}`,
        requiredPerKit: c.perKit,
        requiredTotal: c.perKit,
        launchedDirect: c.direct,
      })),
      launched,
      concluido: false,
      error: null,
    };
  }

  it('matches an explicit table', () => {
    expect(
      kitEquivalents(
        kitItem(0, [
          { perKit: 2, direct: 4 },
          { perKit: 1, direct: 3 },
        ]),
      ),
    ).toBe(2);
    expect(kitEquivalents(kitItem(1, [{ perKit: 2, direct: 0 }]))).toBe(1);
    expect(
      kitEquivalents(
        kitItem(2, [
          { perKit: 3, direct: 7 },
          { perKit: 2, direct: 5 },
        ]),
      ),
    ).toBe(4);
  });

  it('a non-kit item returns launched', () => {
    const nonKit: ExpectedItem = {
      key: 'exp-0',
      pos: 0,
      produtoUid: 'a',
      nomeDeVenda: 'a',
      sku: null,
      quantidade: 3,
      ehKit: false,
      componentes: null,
      launched: 2,
      concluido: false,
      error: null,
    };
    expect(kitEquivalents(nonKit)).toBe(2);
  });

  it('agrees with the legacy loop across a deterministic sweep', () => {
    for (let launched = 0; launched <= 2; launched++) {
      for (let pk1 = 1; pk1 <= 3; pk1++) {
        for (let pk2 = 1; pk2 <= 3; pk2++) {
          for (let d1 = 0; d1 <= 6; d1++) {
            for (let d2 = 0; d2 <= 6; d2++) {
              const comps = [
                { perKit: pk1, direct: d1 },
                { perKit: pk2, direct: d2 },
              ];
              expect(kitEquivalents(kitItem(launched, comps))).toBe(
                legacyKitEquivalents(launched, comps),
              );
            }
          }
        }
      }
    }
  });
});

/* ------------------------------- applyDelete ------------------------------ */

describe('applyDelete', () => {
  it('reverses a unit scan, un-completes, and lets a rescan land on the same item', () => {
    let s = buildEngineState({ itens: [item('a', 2, 1)], produtos: mapOf(prod('a')) });
    let r = scan(s, prod('a'));
    r = scan(r.state, prod('a')); // concluído
    const secondUid = r.entry.uid;
    let state = applyDelete(r.state, secondUid, 1_700_000_001_000);
    expect(state.expected[0]!.launched).toBe(1);
    expect(state.expected[0]!.concluido).toBe(false);
    expect(state.remainingCount).toBe(1);
    expect(state.log.find((e) => e.uid === secondUid)!.excluidoMs).toBe(1_700_000_001_000);
    // rescan lands on the same item
    const again = scan(state, prod('a'));
    expect(again.entry.targetKey).toBe('exp-0');
    expect(again.state.expected[0]!.concluido).toBe(true);
  });

  it('reverses a component scan', () => {
    let s = buildEngineState({
      itens: [item('K', 1, 1)],
      produtos: mapOf(prod('K', { kit: { x: 2 } })),
    });
    let r = scan(s, prod('x'));
    r = scan(r.state, prod('x')); // K concluído (x direct 2 == 2)
    expect(r.state.expected[0]!.concluido).toBe(true);
    const state = applyDelete(r.state, r.entry.uid, 1_700_000_002_000);
    expect(state.expected[0]!.componentes![0]!.launchedDirect).toBe(1);
    expect(state.expected[0]!.concluido).toBe(false);
  });

  it('reverses a whole-kit scan', () => {
    let s = buildEngineState({
      itens: [item('K', 2, 1)],
      produtos: mapOf(prod('K', { kit: { x: 1 } })),
    });
    let r = scan(s, prod('K', { kit: { x: 1 } }));
    r = scan(r.state, prod('K', { kit: { x: 1 } })); // launched 2, concluído
    expect(r.state.expected[0]!.concluido).toBe(true);
    const state = applyDelete(r.state, r.entry.uid, 1_700_000_003_000);
    expect(state.expected[0]!.launched).toBe(1);
    expect(state.expected[0]!.concluido).toBe(false);
  });

  it('marks an error row without touching item counts', () => {
    const s = buildEngineState({ itens: [item('a', 1, 1)], produtos: mapOf(prod('a')) });
    const r = scan(s, prod('z')); // Produto não esperado
    const state = applyDelete(r.state, r.entry.uid, 1_700_000_004_000);
    expect(state.log[0]!.excluidoMs).toBe(1_700_000_004_000);
    expect(state.expected[0]!.launched).toBe(0);
    expect(state.remainingCount).toBe(1);
  });

  it('is a no-op on double-delete and unknown uid', () => {
    let s = buildEngineState({ itens: [item('a', 1, 1)], produtos: mapOf(prod('a')) });
    const r = scan(s, prod('a'));
    const once = applyDelete(r.state, r.entry.uid, 1);
    expect(applyDelete(once, r.entry.uid, 2)).toBe(once); // double-delete: same ref
    expect(applyDelete(once, 'nope', 3)).toBe(once); // unknown uid: same ref
  });
});

/* ----------------------------- 2-decimal edges ---------------------------- */

describe('2-decimal quantity handling', () => {
  it('q2eq is not fooled by float accumulation (0.1 + 0.2 == 0.30)', () => {
    expect(q2eq(0.1 + 0.2, 0.3)).toBe(true);
  });

  it('completes a fractional-kit line whose requiredTotal rounds clean', () => {
    // line qty 1.1, component perKit 10 → requiredTotal q2(11.0000000000000018) = 11.
    let s = buildEngineState({
      itens: [item('K', 1.1, 1)],
      produtos: mapOf(prod('K', { kit: { x: 10 } })),
    });
    expect(s.expected[0]!.componentes![0]!.requiredTotal).toBe(11);
    let r: ScanOutcome | null = null;
    let state = s;
    for (let i = 0; i < 11; i++) {
      r = scan(state, prod('x'));
      state = r.state;
    }
    expect(state.expected[0]!.concluido).toBe(true);
    // a 12th is excess (only item → Todos, so add nothing: remainingCount already 0)
    expect(scan(state, prod('x')).entry.error).toBe(ITEM_CHECKOUT_ERRORS.todosLancados);
  });
});

/* ------------------------------ immutability ------------------------------ */

describe('immutability', () => {
  it('replaces only the touched item; untouched refs stay identical', () => {
    const s = buildEngineState({
      itens: [item('a', 1, 1), item('b', 2, 2), item('c', 1, 3)],
      produtos: mapOf(prod('a'), prod('b'), prod('c')),
    });
    const r = scan(s, prod('b')); // touches pos 1 only
    expect(r.state.expected[0]).toBe(s.expected[0]);
    expect(r.state.expected[2]).toBe(s.expected[2]);
    expect(r.state.expected[1]).not.toBe(s.expected[1]);
    expect(r.state.byProdutoId).toBe(s.byProdutoId); // indexes never change
    expect(r.state.log.length).toBe(1);
    expect(s.log.length).toBe(0); // original untouched
  });
});

/* --------------------------- toItemCheckoutPedido ------------------------- */

describe('toItemCheckoutPedido', () => {
  it('maps a unit entry to the documents/-prefixed ref + ms timestamp', () => {
    const s = buildEngineState({ itens: [item('a', 1, 1)], produtos: mapOf(prod('a')) });
    const r = scan(s, prod('a'));
    expect(toItemCheckoutPedido(r.entry)).toEqual({
      produtoCheckoutPedidoOuterRef: 'documents/produtos/a',
      quantidade: 1,
      dataExclusao: null,
      error: null,
      timestamp: 1_700_000_000_000,
    });
  });

  it('carries the error literal and stamps dataExclusao on a deleted row', () => {
    const s = buildEngineState({ itens: [item('a', 1, 1)], produtos: mapOf(prod('a')) });
    const r = scan(s, prod('z')); // Produto não esperado
    const deleted = applyDelete(r.state, r.entry.uid, 1_700_000_009_000);
    const wire = toItemCheckoutPedido(deleted.log[0]!);
    expect(wire.error).toBe(ITEM_CHECKOUT_ERRORS.produtoNaoEsperado);
    expect(wire.produtoCheckoutPedidoOuterRef).toBe('documents/produtos/z');
    expect(wire.dataExclusao).toBe(1_700_000_009_000);
  });
});
