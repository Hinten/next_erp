import { describe, expect, it } from 'vitest';
import type { GrupoComId } from './variacoes';
import { varianteFakePath } from './variacoes';
import {
  type GenerateKitVariacoesInput,
  type KitComponente,
  generateKitForVariacoes,
  resolveStagedKitVariacoes,
} from './kitVariacoes';

const fp = varianteFakePath;

/**
 * Tamanhos (P/M/G): `P` is linked to `P2` (an alternate size); Cores (AZ/VM).
 * The linked variant lets the matcher substitute `P → P2` when a component only
 * carries the `P2` variation.
 */
function grupos(): GrupoComId[] {
  return [
    {
      id: 'gT',
      data: {
        nome: 'Tamanho',
        ordem: 1,
        permiteFotos: false,
        variacoesIds: ['P', 'P2', 'M', 'G'],
        variacoes: [
          { id: 'P', nome: 'P', codigo: 'P', variantesVinculadasIds: [fp('gT', 'P2')] },
          { id: 'P2', nome: 'P2', codigo: 'P2' },
          { id: 'M', nome: 'M', codigo: 'M' },
          { id: 'G', nome: 'G', codigo: 'G' },
        ],
      },
    },
    {
      id: 'gC',
      data: {
        nome: 'Cor',
        ordem: 2,
        permiteFotos: false,
        variacoesIds: ['AZ', 'VM'],
        variacoes: [
          { id: 'AZ', nome: 'Azul', codigo: 'AZ' },
          { id: 'VM', nome: 'Vermelho', codigo: 'VM' },
        ],
      },
    },
  ];
}

const comp = (produtoId: string, quantidade = 2, limitarEstoque = true): KitComponente => ({
  produtoId,
  quantidade,
  limitarEstoque,
});

function run(partial: Partial<GenerateKitVariacoesInput>) {
  return generateKitForVariacoes({
    componentes: [],
    kitVariacoes: [],
    componentVariacoesByComponentId: {},
    grupos: grupos(),
    ...partial,
  });
}

describe('generateKitForVariacoes', () => {
  it('returns empty when there are no kit variations', () => {
    const r = run({ componentes: [comp('cA')] });
    expect(r).toEqual({ porFilho: {}, warnings: [], errors: [] });
  });

  it('A — a component with no variations is used as-is on every kit variation', () => {
    const r = run({
      componentes: [comp('cA', 3, false)],
      kitVariacoes: [{ id: 'kP', variacoesUid: [fp('gT', 'P')] }],
      componentVariacoesByComponentId: { cA: [] },
    });
    expect(r.porFilho).toEqual({
      kP: { cA: { quantidade: 3, limitarEstoque: false, timestamp: null } },
    });
    expect(r.errors).toEqual([]);
  });

  it('B — a component with exactly one variation uses that variation child', () => {
    const r = run({
      componentes: [comp('cA')],
      kitVariacoes: [{ id: 'kP', variacoesUid: [fp('gT', 'P')] }],
      componentVariacoesByComponentId: { cA: [{ id: 'cA-only', variacoesUid: [fp('gT', 'M')] }] },
    });
    expect(r.porFilho).toEqual({
      kP: { 'cA-only': { quantidade: 2, limitarEstoque: true, timestamp: null } },
    });
  });

  it('C1 — picks the single variation child that shares a variant with the kit variation', () => {
    const r = run({
      componentes: [comp('cA')],
      kitVariacoes: [{ id: 'kP', variacoesUid: [fp('gT', 'P')] }],
      componentVariacoesByComponentId: {
        cA: [
          { id: 'cA-P', variacoesUid: [fp('gT', 'P')] },
          { id: 'cA-M', variacoesUid: [fp('gT', 'M')] },
          { id: 'cA-G', variacoesUid: [fp('gT', 'G')] },
        ],
      },
    });
    expect(Object.keys(r.porFilho.kP!)).toEqual(['cA-P']);
    expect(r.errors).toEqual([]);
  });

  it('C2 — when several overlap, picks the variation child that is a superset of the kit variation', () => {
    const r = run({
      componentes: [comp('cA')],
      kitVariacoes: [{ id: 'kPAZ', variacoesUid: [fp('gT', 'P'), fp('gC', 'AZ')] }],
      componentVariacoesByComponentId: {
        cA: [
          { id: 'cA-P', variacoesUid: [fp('gT', 'P')] }, // overlaps P but not a superset
          { id: 'cA-P-AZ', variacoesUid: [fp('gT', 'P'), fp('gC', 'AZ')] }, // superset
        ],
      },
    });
    expect(Object.keys(r.porFilho.kPAZ!)).toEqual(['cA-P-AZ']);
  });

  it('C3 — substitutes a linked variant (P → P2) when no direct overlap matches', () => {
    const r = run({
      componentes: [comp('cA')],
      kitVariacoes: [{ id: 'kP', variacoesUid: [fp('gT', 'P')] }],
      componentVariacoesByComponentId: {
        cA: [
          { id: 'cA-P2', variacoesUid: [fp('gT', 'P2')] },
          { id: 'cA-M', variacoesUid: [fp('gT', 'M')] },
        ],
      },
    });
    expect(Object.keys(r.porFilho.kP!)).toEqual(['cA-P2']);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('C3 fallback — no linked match → picks the variation child with the most overlap', () => {
    const r = run({
      // Color VM is not a linked variant; size M not linked → no substitution.
      componentes: [comp('cA')],
      kitVariacoes: [{ id: 'kPAZ', variacoesUid: [fp('gT', 'M'), fp('gC', 'AZ')] }],
      componentVariacoesByComponentId: {
        cA: [
          { id: 'cA-M-VM', variacoesUid: [fp('gT', 'M'), fp('gC', 'VM')] }, // shares M (1)
          { id: 'cA-G-AZ', variacoesUid: [fp('gT', 'G'), fp('gC', 'AZ')] }, // shares AZ (1)
        ],
      },
    });
    // Both overlap by 1; the first max wins (deterministic).
    expect(Object.keys(r.porFilho.kPAZ!)).toEqual(['cA-M-VM']);
    expect(r.errors).toEqual([]);
  });

  it('error — several variations, none overlapping and no linked substitution', () => {
    const r = run({
      componentes: [comp('cA')],
      kitVariacoes: [{ id: 'kG', variacoesUid: [fp('gT', 'G')] }],
      componentVariacoesByComponentId: {
        cA: [
          { id: 'cA-M', variacoesUid: [fp('gT', 'M')] },
          { id: 'cA-AZ', variacoesUid: [fp('gC', 'AZ')] },
        ],
      },
    });
    expect(r.porFilho.kG).toBeUndefined();
    expect(r.errors).toEqual([
      'Não foi possível encontrar uma variação válida para o componente cA',
    ]);
  });

  it('warning — linked slots exhausted across components on the same kit variation', () => {
    // Two components both need the single P→P2 linked slot; the second exhausts it.
    const r = run({
      componentes: [comp('c1'), comp('c2')],
      kitVariacoes: [{ id: 'kP', variacoesUid: [fp('gT', 'P')] }],
      componentVariacoesByComponentId: {
        c1: [
          { id: 'c1-P2', variacoesUid: [fp('gT', 'P2')] },
          { id: 'c1-M', variacoesUid: [fp('gT', 'M')] },
        ],
        c2: [
          { id: 'c2-P2', variacoesUid: [fp('gT', 'P2')] },
          { id: 'c2-M', variacoesUid: [fp('gT', 'M')] },
        ],
      },
    });
    // c1 consumed the linked slot; c2 hits the exhaustion warning + cannot resolve.
    expect(Object.keys(r.porFilho.kP!)).toEqual(['c1-P2']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('variações vinculadas suficientes');
    expect(r.errors).toEqual([
      'Não foi possível encontrar uma variação válida para o componente c2',
    ]);
  });

  it('combines multiple components into one kit-variation child map', () => {
    const r = run({
      componentes: [comp('cA', 1), comp('cB', 5)],
      kitVariacoes: [{ id: 'kP', variacoesUid: [fp('gT', 'P')] }],
      componentVariacoesByComponentId: {
        cA: [], // used as-is
        cB: [{ id: 'cB-P', variacoesUid: [fp('gT', 'P')] }], // single variation
      },
    });
    expect(r.porFilho.kP).toEqual({
      cA: { quantidade: 1, limitarEstoque: true, timestamp: null },
      'cB-P': { quantidade: 5, limitarEstoque: true, timestamp: null },
    });
  });

  it('resolves each kit variation independently', () => {
    const r = run({
      componentes: [comp('cA')],
      kitVariacoes: [
        { id: 'kP', variacoesUid: [fp('gT', 'P')] },
        { id: 'kM', variacoesUid: [fp('gT', 'M')] },
      ],
      componentVariacoesByComponentId: {
        cA: [
          { id: 'cA-P', variacoesUid: [fp('gT', 'P')] },
          { id: 'cA-M', variacoesUid: [fp('gT', 'M')] },
        ],
      },
    });
    expect(Object.keys(r.porFilho.kP!)).toEqual(['cA-P']);
    expect(Object.keys(r.porFilho.kM!)).toEqual(['cA-M']);
  });
});

describe('resolveStagedKitVariacoes', () => {
  const mapFor = (componentId: string) => ({
    [componentId]: { quantidade: 1, limitarEstoque: true, timestamp: null },
  });
  /** No id reuse happened — the common case. */
  const NO_PAIRING: Record<string, string> = {};

  it('maps a saved row directly by its real id', () => {
    const out = resolveStagedKitVariacoes({
      stagedByKey: { childP: mapFor('cA-P') },
      rows: [{ key: 'childP', id: 'childP', variacoesUid: [fp('gT', 'P')] }],
      realChildren: [{ id: 'childP', variacoesUid: [fp('gT', 'P')] }],
      resolvedByKey: NO_PAIRING,
    });
    expect(out.writes).toEqual([{ key: 'childP', id: 'childP', componentesKit: mapFor('cA-P') }]);
    expect(out.unresolved).toEqual([]);
  });

  it('resolves a staged row by its pre-minted key once that child exists', () => {
    // `apps/web` mints the child's doc id when the row is staged, so the key IS
    // the id the moment the document lands.
    const out = resolveStagedKitVariacoes({
      stagedByKey: { minted1: mapFor('cA-P') },
      rows: [{ key: 'minted1', id: null, variacoesUid: [fp('gT', 'P')] }],
      realChildren: [{ id: 'minted1', variacoesUid: [fp('gT', 'P')] }],
      resolvedByKey: NO_PAIRING,
    });
    expect(out.writes).toEqual([{ key: 'minted1', id: 'minted1', componentesKit: mapFor('cA-P') }]);
  });

  it('resolves an absorbed row by the pairing even though its row is GONE', () => {
    // The #117 SKU id reuse: the flush UPDATED `real-P` and never wrote a
    // document under `tmp1`, then cleared the staged row — so by now `rows` does
    // not contain it. The pairing has to carry the entry on its own; requiring a
    // row here drops the operator's map, which is what the old combo fallback did.
    const out = resolveStagedKitVariacoes({
      stagedByKey: { tmp1: mapFor('cA-P') },
      rows: [],
      realChildren: [{ id: 'real-P', variacoesUid: [fp('gT', 'P')] }],
      resolvedByKey: { tmp1: 'real-P' },
    });
    expect(out.writes).toEqual([{ key: 'tmp1', id: 'real-P', componentesKit: mapFor('cA-P') }]);
    expect(out.unresolved).toEqual([]);
  });

  it('prefers the pairing over the pre-minted key', () => {
    // Both ids exist; only the pairing knows which document the flush wrote.
    const out = resolveStagedKitVariacoes({
      stagedByKey: { tmp1: mapFor('cA-P') },
      rows: [{ key: 'tmp1', id: null, variacoesUid: [fp('gT', 'P')] }],
      realChildren: [
        { id: 'tmp1', variacoesUid: [fp('gT', 'P')] },
        { id: 'real-P', variacoesUid: [fp('gT', 'P')] },
      ],
      resolvedByKey: { tmp1: 'real-P' },
    });
    expect(out.writes.map((w) => w.id)).toEqual(['real-P']);
  });

  it('never targets a sibling that merely shares the combo', () => {
    // The retired fallback resolved exactly this to `real-P` — a guess onto
    // another variation's document, and `componentesKit` is a full overwrite.
    const out = resolveStagedKitVariacoes({
      stagedByKey: { tmp1: mapFor('cA-P') },
      rows: [{ key: 'tmp1', id: null, variacoesUid: [fp('gT', 'P')] }],
      realChildren: [{ id: 'real-P', variacoesUid: [fp('gT', 'P')] }],
      resolvedByKey: NO_PAIRING,
    });
    expect(out.writes).toEqual([]);
    expect(out.unresolved).toEqual(['tmp1']);
  });

  it('reports a live row that resolved to nothing, and stays silent on deliberate drops', () => {
    const out = resolveStagedKitVariacoes({
      stagedByKey: {
        gone: mapFor('x'), // delete-marked — the operator removed it
        ghost: mapFor('y'), // no matching row at all
        live: mapFor('z'), // a real row whose document is missing
      },
      rows: [
        { key: 'gone', id: 'g', variacoesUid: [fp('gT', 'G')], deleteMark: true },
        { key: 'live', id: null, variacoesUid: [fp('gT', 'P')] },
      ],
      realChildren: [],
      resolvedByKey: NO_PAIRING,
    });
    expect(out.writes).toEqual([]);
    expect(out.unresolved).toEqual(['live']);
    // Deliberate drops must come back so the caller RELEASES them. Leaving a
    // delete-marked variation's map staged is what lets the #117 reuse resurrect
    // its doc id and have the stale map overwrite the new variation's.
    expect(out.dropped.sort()).toEqual(['ghost', 'gone']);
  });

  it('puts every staged key in exactly one bucket', () => {
    const out = resolveStagedKitVariacoes({
      stagedByKey: { written: mapFor('a'), deleted: mapFor('b'), lost: mapFor('c') },
      rows: [
        { key: 'written', id: 'written', variacoesUid: [] },
        { key: 'deleted', id: 'deleted', variacoesUid: [], deleteMark: true },
        { key: 'lost', id: null, variacoesUid: [] },
      ],
      realChildren: [{ id: 'written', variacoesUid: [] }],
      resolvedByKey: NO_PAIRING,
    });
    expect([...out.writes.map((w) => w.key), ...out.dropped, ...out.unresolved].sort()).toEqual([
      'deleted',
      'lost',
      'written',
    ]);
  });

  it('claims each real child at most once', () => {
    const out = resolveStagedKitVariacoes({
      stagedByKey: { a: mapFor('cA'), b: mapFor('cB') },
      rows: [
        { key: 'a', id: null, variacoesUid: [fp('gT', 'P')] },
        { key: 'b', id: null, variacoesUid: [fp('gT', 'P')] },
      ],
      realChildren: [{ id: 'real-P', variacoesUid: [fp('gT', 'P')] }],
      // Both paired onto the same document — only the first may write, and the
      // loser is reported rather than silently dropped.
      resolvedByKey: { a: 'real-P', b: 'real-P' },
    });
    expect(out.writes).toEqual([{ key: 'a', id: 'real-P', componentesKit: mapFor('cA') }]);
    expect(out.unresolved).toEqual(['b']);
  });

  it('emits writes in stagedByKey order', () => {
    const out = resolveStagedKitVariacoes({
      stagedByKey: { second: mapFor('c2'), first: mapFor('c1') },
      rows: [
        { key: 'first', id: 'first', variacoesUid: [] },
        { key: 'second', id: 'second', variacoesUid: [] },
      ],
      realChildren: [
        { id: 'first', variacoesUid: [] },
        { id: 'second', variacoesUid: [] },
      ],
      resolvedByKey: NO_PAIRING,
    });
    expect(out.writes.map((w) => w.key)).toEqual(['second', 'first']);
  });
});
