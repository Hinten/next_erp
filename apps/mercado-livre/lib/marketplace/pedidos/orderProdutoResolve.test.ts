import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import { resolveOrderLineProduto } from './orderProdutoResolve';

/* -------------------------------------------------------------------------- */
/*                               fake Firestore                               */
/* -------------------------------------------------------------------------- */
// `resolveExistingProduto` (./import) is deliberately NOT mocked: the whole
// point of #792 is how the parent link, the child links and the SKU steps
// COMPOSE, so the shared link step runs for real against this fake. Scoped to
// what the cascade touches: the `produtoMercadoLivre` / `variacaoMercadoLivre`
// collection groups, a `produtos` collection query, and a single PML doc get.

type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  /** Every query issued, in order — lets a test assert the read COUNT/shape. */
  readonly queries: Array<{
    source: string;
    clauses: Array<[string, unknown]>;
    limit: number | null;
  }> = [];
  readonly docGets: string[] = [];

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }

  /**
   * A collection-group row must expose `ref.parent.parent.id` — the OWNING
   * produto doc id — because that is how the cascade recovers the produto from a
   * link doc (`produtos/<produtoId>/<name>/<docId>`).
   */
  private groupRows(name: string): Array<[string, DocData, string]> {
    const rows: Array<[string, DocData, string]> = [];
    for (const [path, docs] of this.cols) {
      const segs = path.split('/').filter(Boolean);
      if (segs[segs.length - 1] !== name || segs.length < 2) continue;
      const ownerId = segs[segs.length - 2]!;
      for (const [id, data] of docs) rows.push([id, data, ownerId]);
    }
    return rows;
  }

  private query(source: string, rows: Array<[string, DocData, string | null]>) {
    const clauses: Array<[string, unknown]> = [];
    let lim: number | null = null;
    const self = this;
    const q = {
      where(field: string, _op: string, value: unknown) {
        clauses.push([field, value]);
        return q;
      },
      limit(n: number) {
        lim = n;
        return q;
      },
      async get() {
        self.queries.push({ source, clauses: [...clauses], limit: lim });
        let hits = rows.filter(([, d]) =>
          clauses.every(([f, v]) => (d[f] ?? null) === (v ?? null)),
        );
        if (lim != null) hits = hits.slice(0, lim);
        return {
          docs: hits.map(([id, d, ownerId]) => ({
            id,
            exists: true,
            data: () => d,
            ref: { parent: { parent: ownerId == null ? null : { id: ownerId } } },
          })),
          empty: hits.length === 0,
        };
      },
    };
    return q;
  }

  collectionGroup(name: string) {
    return this.query(`group:${name}`, this.groupRows(name));
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    return {
      doc: (id: string) => ({
        id,
        get: async () => {
          self.docGets.push(`${path}/${id}`);
          return { exists: col.has(id), id, data: () => col.get(id) };
        },
      }),
      where: (field: string, op: string, value: unknown) =>
        self
          .query(
            path,
            [...col.entries()].map(([id, d]) => [id, d, null] as [string, DocData, null]),
          )
          .where(field, op, value),
      get: async () => ({
        docs: [...col.entries()].map(([id, d]) => ({ id, exists: true, data: () => d })),
      }),
    };
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */

const CONTA = 'conta-A';
const OUTRA_CONTA = 'conta-B';

/** A parent/simple listing: the produto + its `produtoMercadoLivre` link. */
function seedParentListing(
  db: FakeDb,
  opts: {
    produtoId: string;
    linkId: string;
    mlItemId: string;
    integracaoId?: string;
    isUserProductModel?: boolean;
    sku?: string | null;
  },
): string {
  db.seed('produtos', opts.produtoId, {
    nome: 'Camiseta',
    sku: opts.sku ?? null,
    paiId: null,
  });
  db.seed(`produtos/${opts.produtoId}/produtoMercadoLivre`, opts.linkId, {
    id: opts.mlItemId,
    contaOuterRef: `documents/integracao/${opts.integracaoId ?? CONTA}`,
    isUserProductModel: opts.isUserProductModel ?? false,
  });
  return `documents/produtos/${opts.produtoId}/produtoMercadoLivre/${opts.linkId}`;
}

/** A variation child: the child produto + its `variacaoMercadoLivre` link. */
function seedVariationChild(
  db: FakeDb,
  opts: {
    childId: string;
    parentProdutoId: string;
    parentLinkOuterRef: string;
    /** legacy `variations[]` — the numeric ML variation id. */
    variationId?: number | null;
    /** User-Products — the member's own MLB item id. */
    itemId?: string | null;
    sku?: string | null;
  },
): void {
  db.seed('produtos', opts.childId, {
    nome: 'Camiseta P Azul',
    sku: opts.sku ?? null,
    paiId: opts.parentProdutoId,
  });
  db.seed(`produtos/${opts.childId}/variacaoMercadoLivre`, `link-${opts.childId}`, {
    id: opts.variationId ?? null,
    itemId: opts.itemId ?? null,
    produtoVariacaoOuterRef: `documents/produtos/${opts.childId}`,
    produtoMercadoLivreOuterRef: opts.parentLinkOuterRef,
    sku: opts.sku ?? null,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('resolveOrderLineProduto — simple listing (unchanged behaviour)', () => {
  it('resolves the produto from its own link, with NO extra read', async () => {
    const db = new FakeDb();
    seedParentListing(db, { produtoId: 'prod-1', linkId: 'L1', mlItemId: 'MLB1' });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB1',
      variationId: null,
      sku: 'ABC',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'prod-1', via: 'parent-link' });
    // Exactly the one link query the code always did — child-first costs nothing
    // for a simple listing, because `isUserProductModel: false` settles it.
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]!.source).toBe('group:produtoMercadoLivre');
    expect(db.docGets).toEqual([]);
  });

  it('ignores a link owned by another integração', async () => {
    const db = new FakeDb();
    seedParentListing(db, {
      produtoId: 'prod-1',
      linkId: 'L1',
      mlItemId: 'MLB1',
      integracaoId: OUTRA_CONTA,
    });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB1',
      variationId: null,
      sku: null,
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: null, via: 'unresolved' });
  });
});

describe('resolveOrderLineProduto — legacy variations[] listing', () => {
  it('resolves the CHILD produto from the variation link scoped to the parent link', async () => {
    const db = new FakeDb();
    const parentLinkRef = seedParentListing(db, {
      produtoId: 'pai-1',
      linkId: 'L1',
      mlItemId: 'MLB1',
    });
    seedVariationChild(db, {
      childId: 'filho-1',
      parentProdutoId: 'pai-1',
      parentLinkOuterRef: parentLinkRef,
      variationId: 456,
    });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB1',
      variationId: '456',
      sku: null,
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'filho-1', via: 'variation-link' });
    const varQuery = db.queries.find((q) => q.source === 'group:variacaoMercadoLivre')!;
    expect(varQuery.clauses).toEqual([
      ['id', 456], // NUMBER — the unit the link doc stores
      ['produtoMercadoLivreOuterRef', parentLinkRef],
    ]);
    expect(varQuery.limit).toBe(1);
  });

  it('does NOT match a same-id variation link belonging to a DIFFERENT parent', async () => {
    const db = new FakeDb();
    const parentLinkRef = seedParentListing(db, {
      produtoId: 'pai-1',
      linkId: 'L1',
      mlItemId: 'MLB1',
    });
    const outroLinkRef = seedParentListing(db, {
      produtoId: 'pai-2',
      linkId: 'L2',
      mlItemId: 'MLB2',
    });
    // Variation id 456 exists under the OTHER listing — ids are only unique
    // within their own item, which is why the query is parent-scoped.
    seedVariationChild(db, {
      childId: 'filho-outro',
      parentProdutoId: 'pai-2',
      parentLinkOuterRef: outroLinkRef,
      variationId: 456,
    });
    void parentLinkRef;

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB1',
      variationId: '456',
      sku: null,
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: null, via: 'unresolved' });
  });

  it('skips the link step for a non-numeric variation_id and falls through to SKU', async () => {
    const db = new FakeDb();
    const parentLinkRef = seedParentListing(db, {
      produtoId: 'pai-1',
      linkId: 'L1',
      mlItemId: 'MLB1',
    });
    seedVariationChild(db, {
      childId: 'filho-1',
      parentProdutoId: 'pai-1',
      parentLinkOuterRef: parentLinkRef,
      variationId: 456,
      sku: 'CAM-P',
    });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB1',
      variationId: 'nao-numerico',
      sku: 'CAM-P',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'filho-1', via: 'sku-child' });
    expect(db.queries.some((q) => q.source === 'group:variacaoMercadoLivre')).toBe(false);
  });
});

describe('resolveOrderLineProduto — User-Products family', () => {
  it('resolves the CHILD when the parent link carries the family id (step 1 misses)', async () => {
    const db = new FakeDb();
    // The family parent's link holds `id == family_id`, NOT the member's item id.
    const parentLinkRef = seedParentListing(db, {
      produtoId: 'pai-up',
      linkId: 'Lup',
      mlItemId: 'FAM-1',
      isUserProductModel: true,
    });
    seedVariationChild(db, {
      childId: 'membro-1',
      parentProdutoId: 'pai-up',
      parentLinkOuterRef: parentLinkRef,
      itemId: 'MLB-MEMBRO-1',
    });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-MEMBRO-1',
      variationId: null,
      sku: null,
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'membro-1', via: 'up-member-link' });
    // Ownership is verified through the family PML doc, which has the conta.
    expect(db.docGets).toEqual(['produtos/pai-up/produtoMercadoLivre/Lup']);
  });

  it('prefers the CHILD when canonicalId == item.id (family_id null → step 1 also matches)', async () => {
    const db = new FakeDb();
    const parentLinkRef = seedParentListing(db, {
      produtoId: 'pai-up',
      linkId: 'Lup',
      mlItemId: 'MLB-SOLO', // canonicalId fell back to the item id
      isUserProductModel: true,
    });
    seedVariationChild(db, {
      childId: 'membro-solo',
      parentProdutoId: 'pai-up',
      parentLinkOuterRef: parentLinkRef,
      itemId: 'MLB-SOLO',
    });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SOLO',
      variationId: null,
      sku: null,
      integracaoId: CONTA,
    });

    // The child owns the stock — the family parent must not win here.
    expect(out).toEqual({ produtoId: 'membro-solo', via: 'up-member-link' });
  });

  it('rejects a member link whose family PML doc belongs to another integração', async () => {
    const db = new FakeDb();
    const parentLinkRef = seedParentListing(db, {
      produtoId: 'pai-up',
      linkId: 'Lup',
      mlItemId: 'FAM-1',
      isUserProductModel: true,
      integracaoId: OUTRA_CONTA,
    });
    seedVariationChild(db, {
      childId: 'membro-1',
      parentProdutoId: 'pai-up',
      parentLinkOuterRef: parentLinkRef,
      itemId: 'MLB-MEMBRO-1',
    });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-MEMBRO-1',
      variationId: null,
      sku: null,
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: null, via: 'unresolved' });
  });
});

describe('resolveOrderLineProduto — SKU fallbacks', () => {
  it('prefers a child of the KNOWN parent over a root sharing the SKU', async () => {
    const db = new FakeDb();
    const parentLinkRef = seedParentListing(db, {
      produtoId: 'pai-1',
      linkId: 'L1',
      mlItemId: 'MLB1',
    });
    seedVariationChild(db, {
      childId: 'filho-1',
      parentProdutoId: 'pai-1',
      parentLinkOuterRef: parentLinkRef,
      variationId: 999, // NOT the sold variation → the link step misses
      sku: 'DUP',
    });
    db.seed('produtos', 'raiz-dup', { nome: 'Outro', sku: 'DUP', paiId: null });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB1',
      variationId: '456',
      sku: 'DUP',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'filho-1', via: 'sku-child' });
    // Two produtos share 'DUP', but the `paiId` scope leaves this rung exactly
    // one hit — so the ambiguity count must come from the SCOPED probe, never
    // from an unscoped one.
    expect(db.queries.filter((q) => q.source === 'produtos')).toHaveLength(1);
  });

  it('falls back to a ROOT produto by SKU (the pre-#792 shape)', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'raiz-1', { nome: 'Solto', sku: 'RAIZ', paiId: null });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'RAIZ',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'raiz-1', via: 'sku-root' });
  });

  it('can match a variation CHILD by SKU alone — the acceptance case the paiId==null filter blocked', async () => {
    const db = new FakeDb();
    // A child of a parent this account has no link to: no link step can reach it.
    db.seed('produtos', 'filho-orfao', { nome: 'Filho', sku: 'SO-SKU', paiId: 'pai-desconhecido' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: '456',
      sku: 'SO-SKU',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'filho-orfao', via: 'sku-any' });
    // Neither account- nor parent-verified — must be loud.
    expect(warn).toHaveBeenCalled();
  });

  it('returns null when nothing matches — the caller keeps produtoUid null', async () => {
    const db = new FakeDb();

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-NADA',
      variationId: '1',
      sku: 'INEXISTENTE',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: null, via: 'unresolved' });
    // A ZERO-hit rung must still fall through: no parent ⇒ sku-child skipped,
    // then sku-root and sku-any both ran. A guard that stopped on anything other
    // than "two or more" would cut this short.
    expect(db.queries.filter((q) => q.source === 'produtos')).toHaveLength(2);
  });

  it('does not run any SKU query when the line has no seller_sku', async () => {
    const db = new FakeDb();

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-NADA',
      variationId: null,
      sku: null,
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: null, via: 'unresolved' });
    expect(db.queries.some((q) => q.source === 'produtos')).toBe(false);
  });
});

/**
 * Every SKU rung binds only when the SKU names EXACTLY ONE produto. Sibling and
 * root SKUs are legally non-unique here, and with `limit(1)` and no `orderBy`
 * these rungs used to bind whichever document the index returned first.
 *
 * ⚠️ Assert BINDINGS and QUERY COUNTS, never just the verdict. "Stopped at this
 * rung" and "fell through and the next rung also declined" produce the SAME
 * verdict — only the number of `produtos` queries separates them.
 *
 * ⚠️ The double's `limit` is `hits.slice(0, n)` over an insertion-ordered `Map`,
 * so `db.seed` order is index order and `limit(1)` returns the FIRST-SEEDED
 * match. That is what makes the `it.each` pairs meaningful: under `limit(1)`
 * the two orders bind different produtos, so they cannot both stay green.
 */
describe('resolveOrderLineProduto — SKU ambiguity guard', () => {
  const produtosQueries = (db: FakeDb) => db.queries.filter((q) => q.source === 'produtos');

  it.each([
    ['A first', ['filho-A', 'filho-B']],
    ['B first', ['filho-B', 'filho-A']],
  ] as const)(
    'rung sku-child: two children of the parent sharing a SKU bind nothing (%s)',
    async (_rotulo, ordemDeSeed) => {
      const db = new FakeDb();
      const parentLinkRef = seedParentListing(db, {
        produtoId: 'pai-1',
        linkId: 'L1',
        mlItemId: 'MLB1',
      });
      const variationIds: Record<string, number> = { 'filho-A': 999, 'filho-B': 998 };
      for (const childId of ordemDeSeed) {
        seedVariationChild(db, {
          childId,
          parentProdutoId: 'pai-1',
          parentLinkOuterRef: parentLinkRef,
          variationId: variationIds[childId]!, // neither is the sold variation
          sku: 'DUP',
        });
      }

      const out = await resolveOrderLineProduto(asDb(db), {
        itemId: 'MLB1',
        variationId: '456',
        sku: 'DUP',
        integracaoId: CONTA,
      });

      expect(out).toEqual({ produtoId: null, via: 'ambiguous-sku' });
      // ONE produtos query: the stage stopped here rather than widening to the
      // root/unscoped rungs, which could only bind something less related.
      expect(produtosQueries(db)).toHaveLength(1);
      expect(produtosQueries(db)[0]!.limit).toBe(2);
      expect(produtosQueries(db)[0]!.clauses).toEqual([
        ['sku', 'DUP'],
        ['paiId', 'pai-1'],
      ]);
    },
  );

  it.each([
    ['A first', ['raiz-A', 'raiz-B']],
    ['B first', ['raiz-B', 'raiz-A']],
  ] as const)(
    'rung sku-root: two roots sharing a SKU bind nothing (%s)',
    async (_rotulo, ordemDeSeed) => {
      const db = new FakeDb();
      for (const id of ordemDeSeed) {
        db.seed('produtos', id, { nome: 'Solto', sku: 'RAIZ-DUP', paiId: null });
      }

      const out = await resolveOrderLineProduto(asDb(db), {
        itemId: 'MLB-SEM-LINK',
        variationId: null,
        sku: 'RAIZ-DUP',
        integracaoId: CONTA,
      });

      expect(out).toEqual({ produtoId: null, via: 'ambiguous-sku' });
      // No parent ⇒ sku-child was skipped, so this ONE query is sku-root. Without
      // the count, a fall-through implementation would look identical: sku-any
      // would see the same two roots and also decline.
      expect(produtosQueries(db)).toHaveLength(1);
      expect(produtosQueries(db)[0]!.limit).toBe(2);
    },
  );

  it('rung sku-any: two produtos of other parents sharing a SKU bind nothing', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'orfao-A', { nome: 'A', sku: 'SO-SKU', paiId: 'pai-desconhecido' });
    db.seed('produtos', 'orfao-B', { nome: 'B', sku: 'SO-SKU', paiId: 'outro-pai' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: '456',
      sku: 'SO-SKU',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: null, via: 'ambiguous-sku' });
    // sku-root ran (0 hits, fell through), then sku-any stopped.
    expect(produtosQueries(db)).toHaveLength(2);

    // The warn is the ONLY surface that names both colliding produtos — the
    // incidente message is operator-facing and deliberately stays short.
    const ambiguo = warn.mock.calls.find((c) => String(c[0]).includes('mais de um produto'));
    expect(ambiguo?.[1]).toMatchObject({ rung: 'sku-any', produtoIds: ['orfao-A', 'orfao-B'] });
    // The single-hit "resolvido apenas pelo SKU" warn must NOT fire: nothing bound.
    expect(warn.mock.calls.some((c) => String(c[0]).includes('resolvido apenas pelo SKU'))).toBe(
      false,
    );
  });

  it('a link rung still pre-empts the SKU stage, ambiguous SKU or not', async () => {
    const db = new FakeDb();
    const parentLinkRef = seedParentListing(db, {
      produtoId: 'pai-1',
      linkId: 'L1',
      mlItemId: 'MLB1',
    });
    seedVariationChild(db, {
      childId: 'filho-1',
      parentProdutoId: 'pai-1',
      parentLinkOuterRef: parentLinkRef,
      variationId: 456, // the sold variation — the link answers
      sku: 'DUP',
    });
    db.seed('produtos', 'raiz-dup', { nome: 'Outro', sku: 'DUP', paiId: null });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB1',
      variationId: '456',
      sku: 'DUP',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'filho-1', via: 'variation-link' });
    expect(produtosQueries(db)).toHaveLength(0);
  });
});

/**
 * The `sku-root` rung filters `paiId == null`, so it can only ever match a ROOT
 * — and after #1398 a root with no variations is a WRAPPER whose stock lives on
 * its sole member.
 *
 * ⚠️ This is a WRONG BIND, not an ambiguity, which is why it is fixed here and
 * not in the SKU-duplicate PR: `calcularAlteracoesEstoque` moves stock on the
 * produto the line names, and `aplicarPlano` creates a row at `0 + delta` for a
 * produto that owns none — negative, from nothing, on a live Mercado Livre order.
 */
describe('resolveOrderLineProduto — sku-root binds the sellable child', () => {
  const produtosQueries = (db: FakeDb) => db.queries.filter((q) => q.source === 'produtos');

  it('binds the CHILD when the SKU names a family-of-one parent', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'pai-1', {
      nome: 'Bandeja',
      sku: 'BAN-1',
      paiId: null,
      filhoUnicoId: 'membro-unico',
    });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'BAN-1',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'membro-unico', via: 'sku-membro-unico' });
    // ⚠️ No extra read: the family fields ride along on the probe the rung
    // already ran. sku-child is skipped (no parent link), so this is the ONE query.
    expect(produtosQueries(db)).toHaveLength(1);
    expect(produtosQueries(db)[0]!.clauses).toEqual([
      ['sku', 'BAN-1'],
      ['paiId', null],
    ]);
  });

  it('still reports sku-root for an ordinary root produto', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'raiz', { nome: 'Solto', sku: 'UNI', paiId: null, filhoUnicoId: null });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'UNI',
      integracaoId: CONTA,
    });

    // The `via` must stay `sku-root` when nothing was re-pointed — it is
    // persisted diagnostic and a reader distinguishes the two cases by it.
    expect(out).toEqual({ produtoId: 'raiz', via: 'sku-root' });
  });

  // A stored empty pointer is not a pointer.
  it('treats an empty filhoUnicoId as absent', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'raiz', { nome: 'Solto', sku: 'UNI', paiId: null, filhoUnicoId: '' });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'UNI',
      integracaoId: CONTA,
    });
    expect(out).toEqual({ produtoId: 'raiz', via: 'sku-root' });
  });

  // ⚠️ The narrower rungs must be untouched. `sku-child` is already scoped to
  // children of a known parent, so it can never match a wrapper — and its verdict
  // must keep saying `sku-child`.
  it('leaves the sku-child rung reporting sku-child', async () => {
    const db = new FakeDb();
    const parentLinkRef = seedParentListing(db, {
      produtoId: 'pai-1',
      linkId: 'L1',
      mlItemId: 'MLB1',
    });
    seedVariationChild(db, {
      childId: 'filho-1',
      parentProdutoId: 'pai-1',
      parentLinkOuterRef: parentLinkRef,
      variationId: 999, // not the sold variation — the link rung misses
      sku: 'DUP',
    });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB1',
      variationId: '456',
      sku: 'DUP',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'filho-1', via: 'sku-child' });
  });

  // ⚠️ Named for what it actually pins. It does NOT reach `unidadeVendavel`'s
  // drift guard: the seeded produto has a `paiId`, so `sku-root` cannot match it
  // and the UNSCOPED rung answers — and that rung binds what it matched without
  // resolving. The guard is unreachable from this entry point by construction
  // (`sku-root` filters `paiId == null`), which is why the projection was
  // dropped rather than left as coverage-shaped decoration.
  it('leaves the unscoped rung binding exactly what it matched', async () => {
    const db = new FakeDb();
    // `paiId` is non-null, so `sku-root` cannot match it; the unscoped rung does.
    db.seed('produtos', 'estranho', {
      nome: 'X',
      sku: 'ODD',
      paiId: 'algum-pai',
      filhoUnicoId: 'nao-seguir',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: '456',
      sku: 'ODD',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'estranho', via: 'sku-any' });
  });
});

/**
 * ⛔ A KIT is never resolved to its sole member (found by adversarial review).
 *
 * A kit's sole member carries `ehKit: true` and NO `componentesKit` —
 * `planejarMembroUnico` does not copy the map — so binding it hands
 * `calcularAlteracoesEstoque` a kit with a null map. Its `if (!componentes)
 * continue;` then moves **nothing**: the components of a real Mercado Livre sale
 * are never reserved and never removed, and they stay fully sellable.
 *
 * ⚠️ Worse than the wrong-row case the redirect exists to fix, because nothing
 * reports it. The pedido line HAS a produto, so `recordItensSemProduto` raises no
 * incidente — the sale simply consumes no stock.
 *
 * The ERP pick path reached this conclusion one commit earlier
 * (`PrincipalTab.tsx`); this is the surface with LIVE traffic and the two must not
 * disagree.
 */
describe('resolveOrderLineProduto — a kit stays on the parent', () => {
  it('binds the KIT itself, not its sole member', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'kit-1', {
      sku: 'KIT-SKU',
      paiId: null,
      ehKit: true,
      filhoUnicoId: 'membro-1',
      componentesKit: { 'comp-a': { quantidade: 6, limitarEstoque: true } },
    });
    db.seed('produtos', 'membro-1', { sku: 'KIT-SKU', paiId: 'kit-1', ehKit: true });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'KIT-SKU',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'kit-1', via: 'sku-root' });
  });

  // ...and the near-miss that keeps the redirect alive: the SAME shape without
  // `ehKit` must still resolve, or the guard has swallowed the fix it guards.
  it('still redirects a NON-kit family-of-one parent', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'p-1', {
      sku: 'SKU-1',
      paiId: null,
      ehKit: false,
      filhoUnicoId: 'membro-1',
    });
    db.seed('produtos', 'membro-1', { sku: 'SKU-1', paiId: 'p-1', ehKit: false });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'SKU-1',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'membro-1', via: 'sku-membro-unico' });
  });
});

/**
 * ⛔ ML sends the MEMBER's `seller_sku`, and a sole member's sku is DERIVED
 * (`<paiSku>-UN`) — so for a família de um the incoming string matches NO root.
 *
 * Without a second, stripped probe the resolution falls through to the unscoped
 * `sku-any` rung, which has no `ehKit` guard. For a KIT that binds its own sole
 * member, whose `componentesKit` publish never copied, and
 * `calcularAlteracoesEstoque`'s `if (!componentes) continue;` then moves
 * NOTHING: a live ML sale reserves no components and raises no incidente,
 * because the pedido does have a produto. Silent overselling.
 */
describe('resolveOrderLineProduto — a familia de um arrives with the derived SKU', () => {
  const produtosQueries = (db: FakeDb) => db.queries.filter((q) => q.source === 'produtos');

  it('⛔ keeps a KIT on the parent, so the sale still expands componentesKit', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'pai-kit', {
      nome: 'Kit Camiseta',
      sku: 'KIT-1',
      paiId: null,
      ehKit: true,
      filhoUnicoId: 'membro-kit',
    });
    // The member EXISTS and carries the sku ML sent, so the unscoped rung would
    // happily bind it — that is precisely the wrong answer being guarded here.
    db.seed('produtos', 'membro-kit', {
      nome: 'Kit Camiseta',
      sku: 'KIT-1-UN',
      paiId: 'pai-kit',
      ehKit: true,
      componentesKit: null,
    });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'KIT-1-UN',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'pai-kit', via: 'sku-pai-do-membro' });
  });

  // ⚠️ The `via` is the assertion that matters here, not the id: the unscoped
  // rung would reach the SAME produto by matching the member's own sku, and
  // report `sku-any` with its "sem vínculo" warning. A test asserting only
  // `produtoId` would pass with this rung deleted.
  it('binds the CHILD of a non-kit, through the guarded rung', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'pai-1', {
      nome: 'Bandeja',
      sku: 'BAN-1',
      paiId: null,
      filhoUnicoId: 'membro-unico',
    });
    db.seed('produtos', 'membro-unico', {
      nome: 'Bandeja',
      sku: 'BAN-1-UN',
      paiId: 'pai-1',
    });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'BAN-1-UN',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'membro-unico', via: 'sku-pai-do-membro' });
  });

  /**
   * ⛔ THE near-miss, and the one this rung was shipped without.
   *
   * `cartesianVariations` builds a variation child as `parentSku + codigo`, so a
   * variante whose código is `-UN` produces a sku byte-identical to what a sole
   * member of the same parent would carry. Stripping is a string transform and
   * cannot tell them apart — only `filhoUnicoId` can, which is why the rung is
   * gated on `ehFamiliaDeUm` rather than on the sku's shape.
   *
   * Without that guard this bound `pai-muitos`: `unidadeVendavel` returns the
   * ROOT for a família de muitos, and the root owns no estoque rows, so
   * `aplicarPlano` would create one at `0 + delta` — negative, from nothing, on a
   * live ML sale.
   */
  it('⛔ does NOT bind the parent when the sku belongs to a variation of a familia de MUITOS', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'pai-muitos', {
      nome: 'Camiseta',
      sku: 'CAM',
      paiId: null,
      // A família de muitos has NO sole member — this is the whole distinction.
      filhoUnicoId: null,
    });
    db.seed('produtos', 'filho-un', {
      nome: 'Camiseta UN',
      // `CAM` + a variante whose código is `-UN`.
      sku: 'CAM-UN',
      paiId: 'pai-muitos',
    });
    db.seed('produtos', 'filho-p', { nome: 'Camiseta P', sku: 'CAM-P', paiId: 'pai-muitos' });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'CAM-UN',
      integracaoId: CONTA,
    });

    // The unscoped rung finds the real variation child — the produto that holds
    // the stock — instead of the wrapper the stripped probe would have named.
    expect(out).toEqual({ produtoId: 'filho-un', via: 'sku-any' });
  });

  // A `many` on the STRIPPED sku must not end the stage: the ambiguity is about
  // a string nobody sent, and the unscoped rung below can still match exactly.
  it('falls through when the stripped sku is ambiguous, instead of refusing', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'raiz-a', { nome: 'A', sku: 'DUP', paiId: null, filhoUnicoId: null });
    db.seed('produtos', 'raiz-b', { nome: 'B', sku: 'DUP', paiId: null, filhoUnicoId: null });
    // ⚠️ A CHILD, so the FIRST root probe misses and the stripped one is really
    // the rung under test. As a root it would match directly and this test would
    // pass with the fall-through removed.
    db.seed('produtos', 'exato', { nome: 'Exato', sku: 'DUP-UN', paiId: 'raiz-a' });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'DUP-UN',
      integracaoId: CONTA,
    });

    // Reached the unscoped rung and bound the exact match, rather than ending
    // the stage with `ambiguous-sku` about `DUP`.
    expect(out).toEqual({ produtoId: 'exato', via: 'sku-any' });
  });

  // The near-miss on COST: the stripped probe must not run for a sku that never
  // carried the suffix, or every unresolved line pays a second indexed read.
  it('does not pay a second read for a sku with no suffix', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'raiz', { nome: 'Solto', sku: 'UNI', paiId: null, filhoUnicoId: null });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'UNI',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'raiz', via: 'sku-root' });
    // sku-child is skipped (no parent link), so this is the ONE query.
    expect(produtosQueries(db)).toHaveLength(1);
  });

  // ...and a produto that genuinely OWNS a sku ending in the suffix is matched
  // by the FIRST probe, so it is never mistaken for somebody's sole member.
  it('an own-sku root wins before the stripped probe runs', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'raiz-un', {
      nome: 'Parafuso',
      sku: 'PARAFUSO-UN',
      paiId: null,
      filhoUnicoId: null,
    });

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-SEM-LINK',
      variationId: null,
      sku: 'PARAFUSO-UN',
      integracaoId: CONTA,
    });

    expect(out).toEqual({ produtoId: 'raiz-un', via: 'sku-root' });
    expect(produtosQueries(db)).toHaveLength(1);
  });
});
