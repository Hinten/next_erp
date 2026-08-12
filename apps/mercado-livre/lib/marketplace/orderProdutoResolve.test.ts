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

    expect(out).toBeNull();
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

    expect(out).toBeNull();
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

    expect(out).toBeNull();
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

    expect(out).toBeNull();
  });

  it('does not run any SKU query when the line has no seller_sku', async () => {
    const db = new FakeDb();

    const out = await resolveOrderLineProduto(asDb(db), {
      itemId: 'MLB-NADA',
      variationId: null,
      sku: null,
      integracaoId: CONTA,
    });

    expect(out).toBeNull();
    expect(db.queries.some((q) => q.source === 'produtos')).toBe(false);
  });
});
