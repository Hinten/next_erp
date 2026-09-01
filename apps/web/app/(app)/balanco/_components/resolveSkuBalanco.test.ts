import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';

// `vi.mock` is hoisted above every top-level const, so the doubles have to be
// hoisted with them — the same shape `useClienteLink.test.tsx` uses.
const { getDocsMock, limitMock } = vi.hoisted(() => ({
  getDocsMock: vi.fn(),
  limitMock: vi.fn(),
}));

vi.mock('firebase/firestore', async (importActual) => {
  const actual = await importActual<typeof import('firebase/firestore')>();
  return { ...actual, getDocs: getDocsMock };
});
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: { ref: () => ({ __ref: 'produtos' }) },
}));
// `buildQuery` collapses to the ref; `limit` is spied on because THREE, not two,
// is the whole reason a family of MANY is still refused, and the constraint
// Firebase returns is opaque to an assertion.
vi.mock('@delfrance/data', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/data')>();
  return {
    ...actual,
    buildQuery: (ref: unknown) => ref,
    limit: (n: number) => {
      limitMock(n);
      return actual.limit(n);
    },
  };
});

import { resolverSkuBalanco } from './resolveSkuBalanco';

/**
 * A produto with no variations is a family of ONE, and its sole member copies
 * the parent's SKU verbatim (`upSoleMember.ts:193`). So two documents legally
 * sit behind one SKU, and the scan answered **"SKU duplicado"** about a produto
 * that has exactly one — refusing to count it on the warehouse floor (#1398).
 *
 * ⚠️ Both halves of the fold are asserted. Over-collapsing is the worse failure:
 * it counts a scan against a produto the operator never named, and the balanço
 * writes that quantity to stock at finalize.
 */

const db = {} as Firestore;

/**
 * The shape `getDocs` returns, reduced to what the resolver reads.
 *
 * ⚠️ `data()` COUNTS its calls. The real `snap.data()` is not memoized — the
 * Firebase SDK re-runs the converter every time, and this repo's converter is a
 * full `produtoSchema` safeParse (`defineCollection.ts:65-69`). This is the hot
 * path of a warehouse screen driven by a wedge scanner, so "parsed once per
 * document" is a property worth pinning rather than trusting.
 */
function snapshot(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    size: docs.length,
    docs: docs.map((d) => ({
      id: d.id,
      data: () => {
        parses.push(d.id);
        return d.data;
      },
    })),
  };
}

const produto = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  data: { nome: id, sku: 'BAN-1', paiId: null, ehKit: false, ...over },
});

/** Every `data()` call the resolver made, by doc id. */
let parses: string[] = [];

beforeEach(() => {
  getDocsMock.mockReset();
  limitMock.mockReset();
  parses = [];
});

describe('resolverSkuBalanco — a parent and its own sole member', () => {
  it('resolves to the CHILD instead of reporting a duplicate', async () => {
    getDocsMock.mockResolvedValue(
      snapshot([produto('pai-1'), produto('membro-unico', { paiId: 'pai-1' })]),
    );

    const out = await resolverSkuBalanco(db, 'BAN-1');

    // The child, because that is the produto that owns the stock.
    expect(out).toMatchObject({ kind: 'produto', produtoId: 'membro-unico' });
  });

  it('resolves the same way whatever order the index returned them in', async () => {
    getDocsMock.mockResolvedValue(
      snapshot([produto('membro-unico', { paiId: 'pai-1' }), produto('pai-1')]),
    );

    expect(await resolverSkuBalanco(db, 'BAN-1')).toMatchObject({
      kind: 'produto',
      produtoId: 'membro-unico',
    });
  });

  // The kit refusal is upstream of the collapse and must survive it: a kit holds
  // no stock of its own, so a counted quantity written onto one would ADD to a
  // number already derived from its components (ADR 0014).
  it('still refuses a kit when the sole member is one', async () => {
    getDocsMock.mockResolvedValue(
      snapshot([produto('pai-1'), produto('membro-unico', { paiId: 'pai-1', ehKit: true })]),
    );

    expect(await resolverSkuBalanco(db, 'BAN-1')).toMatchObject({ kind: 'kit' });
  });
});

describe('resolverSkuBalanco — what must still read as duplicado', () => {
  it('two unrelated roots sharing a SKU', async () => {
    getDocsMock.mockResolvedValue(snapshot([produto('raiz-A'), produto('raiz-B')]));
    expect(await resolverSkuBalanco(db, 'BAN-1')).toEqual({ kind: 'duplicado' });
  });

  // ⚠️ Legal and common: a child's SKU is `parentSku + variante.codigo`, so two
  // variantes without a `codigo` collide (`importVariations.ts:352-355`).
  it('two siblings sharing a SKU', async () => {
    getDocsMock.mockResolvedValue(
      snapshot([produto('filho-P', { paiId: 'pai-1' }), produto('filho-M', { paiId: 'pai-1' })]),
    );
    expect(await resolverSkuBalanco(db, 'BAN-1')).toEqual({ kind: 'duplicado' });
  });

  it('a parent and some OTHER parent’s child', async () => {
    getDocsMock.mockResolvedValue(
      snapshot([produto('pai-1'), produto('filho-alheio', { paiId: 'pai-2' })]),
    );
    expect(await resolverSkuBalanco(db, 'BAN-1')).toEqual({ kind: 'duplicado' });
  });

  // ⚠️ The reason the probe reads THREE. Under limit(2) the pair (pai-1, filho-P)
  // would collapse and the scan would count against an arbitrary sibling.
  it('a family of MANY, whose parent shares the SKU with its children', async () => {
    getDocsMock.mockResolvedValue(
      snapshot([
        produto('pai-1'),
        produto('filho-P', { paiId: 'pai-1' }),
        produto('filho-M', { paiId: 'pai-1' }),
      ]),
    );
    expect(await resolverSkuBalanco(db, 'BAN-1')).toEqual({ kind: 'duplicado' });
    // The probe must READ three. Under limit(2) Firestore would never return the
    // third document, the pair would collapse, and the scan would count against
    // an arbitrary sibling.
    expect(limitMock).toHaveBeenCalledWith(3);
  });
});

describe('resolverSkuBalanco — unchanged behaviour', () => {
  it('resolves a single hit exactly as before', async () => {
    getDocsMock.mockResolvedValue(snapshot([produto('so-um')]));
    expect(await resolverSkuBalanco(db, 'BAN-1')).toMatchObject({
      kind: 'produto',
      produtoId: 'so-um',
    });
  });

  it('reports nao-encontrado when nothing matches either candidate form', async () => {
    getDocsMock.mockResolvedValue(snapshot([]));
    expect(await resolverSkuBalanco(db, 'BAN-1')).toEqual({ kind: 'nao-encontrado' });
  });

  // A wedge scanner prepends zeros to a numeric SKU, so the normalized form is
  // tried first and the raw one second — both still get the collapse.
  it('still tries the raw form when normalization changed the code', async () => {
    getDocsMock
      .mockResolvedValueOnce(snapshot([])) // normalized: no hit
      .mockResolvedValueOnce(
        snapshot([produto('pai-1', { sku: '007' }), produto('c1', { sku: '007', paiId: 'pai-1' })]),
      );

    expect(await resolverSkuBalanco(db, '007')).toMatchObject({
      kind: 'produto',
      produtoId: 'c1',
    });
    expect(getDocsMock).toHaveBeenCalledTimes(2);
  });
});

describe('resolverSkuBalanco — each document is parsed exactly once', () => {
  it('parses each candidate once when the pair collapses', async () => {
    getDocsMock.mockResolvedValue(
      snapshot([produto('pai-1'), produto('membro-unico', { paiId: 'pai-1' })]),
    );
    await resolverSkuBalanco(db, 'BAN-1');
    // Two documents, two parses — not four (once to read `paiId`, again to
    // classify the winner).
    expect(parses).toEqual(['pai-1', 'membro-unico']);
  });

  it('parses each candidate once on the duplicado path', async () => {
    getDocsMock.mockResolvedValue(snapshot([produto('raiz-A'), produto('raiz-B')]));
    expect(await resolverSkuBalanco(db, 'BAN-1')).toEqual({ kind: 'duplicado' });
    expect(parses).toEqual(['raiz-A', 'raiz-B']);
  });

  it('parses the single hit once', async () => {
    getDocsMock.mockResolvedValue(snapshot([produto('so-um')]));
    await resolverSkuBalanco(db, 'BAN-1');
    expect(parses).toEqual(['so-um']);
  });
});
