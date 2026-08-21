import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import {
  PRECO_RECONCILIACAO_FLAG_ENV,
  classificarLinkNaoEnumerado,
  fetchPrecoReconPage,
  precoReconPageLimit,
  precoReconciliacaoHabilitada,
} from './precoReconciliacao';

/* ------------------------------ fake Firestore ----------------------------- */
// The walk is one COLLECTION GROUP query plus one batched key read. The fake
// models exactly that — and, unlike precoPlan.test.ts's, it carries real
// document REFS (`path`, `parent.parent.id`) because both of this module's
// sharp edges live there: the parent-produto id comes off the ref, and the
// keyset cursor is a DocumentReference rather than a bare id.

type DocData = Record<string, unknown>;

interface FakeRef {
  readonly path: string;
  readonly id: string;
  readonly parent: { readonly parent: { readonly id: string } | null };
}

function refOf(path: string): FakeRef {
  const parts = path.split('/');
  const id = parts[parts.length - 1]!;
  // `produtos/<pid>/produtoMercadoLivre/<lid>` — the grandparent is the produto.
  const produtoId = parts.length >= 4 ? parts[parts.length - 3]! : null;
  return { path, id, parent: { parent: produtoId == null ? null : { id: produtoId } } };
}

class FakeDb {
  /** Seeded link docs, keyed by full path. */
  readonly links = new Map<string, DocData>();
  /** Seeded produtos, keyed by id. */
  readonly produtos = new Map<string, DocData>();
  /** What `startAfter` was handed — the cursor-shape assertion reads this. */
  startAfterArg: unknown = undefined;
  /** What `select()` was handed — the projection-mask assertion reads this. */
  selectedFields: string[] | null = null;
  /** Field masks passed to `getAll`. */
  getAllMask: string[] | null = null;

  seedLink(path: string, data: DocData): void {
    this.links.set(path, data);
  }
  seedProduto(id: string, data: DocData): void {
    this.produtos.set(id, data);
  }

  doc(path: string): FakeRef {
    return refOf(path);
  }

  collectionGroup(groupId: string) {
    const self = this;
    const clauses: Array<{ field: string; op: string; value: unknown }> = [];
    let after: string | null = null;
    let max: number | null = null;
    const q = {
      where(field: string, op: string, value: unknown) {
        clauses.push({ field, op, value });
        return q;
      },
      select(...fields: string[]) {
        self.selectedFields = fields;
        return q;
      },
      orderBy(_fieldPath: unknown) {
        return q;
      },
      startAfter(cursor: unknown) {
        self.startAfterArg = cursor;
        // Mirrors the real thing: a collection-group `__name__` cursor is a
        // DocumentReference. A bare id would throw against real Firestore, so
        // the fake refuses it rather than quietly paging on a string.
        if (cursor == null || typeof cursor !== 'object' || !('path' in cursor)) {
          throw new Error(
            'FakeDb: a collection-group startAfter needs a DocumentReference, got ' +
              JSON.stringify(cursor),
          );
        }
        after = (cursor as FakeRef).path;
        return q;
      },
      limit(n: number) {
        max = n;
        return q;
      },
      async get() {
        let rows = [...self.links.entries()].filter(
          ([path, d]) =>
            path.split('/').slice(-2, -1)[0] === groupId &&
            clauses.every(({ field, op, value }) => matches(d[field], op, value)),
        );
        rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (after != null) rows = rows.filter(([path]) => path > after!);
        if (max != null) rows = rows.slice(0, max);
        return {
          docs: rows.map(([path, d]) => ({ ref: refOf(path), data: () => d })),
          size: rows.length,
        };
      },
    };
    return q;
  }

  /**
   * `defineAdminCollection`'s `docRef` is `db.collection(path).doc(id)` — used
   * here for the produtos batch read AND for rebuilding the keyset cursor's
   * DocumentReference, so the path has to be honoured rather than assumed.
   */
  collection(path: string) {
    return { doc: (id: string) => refOf(`${path}/${id}`) };
  }

  getAll(...args: unknown[]) {
    const opts = args[args.length - 1];
    if (opts != null && typeof opts === 'object' && 'fieldMask' in opts) {
      this.getAllMask = (opts as { fieldMask: string[] }).fieldMask;
      args = args.slice(0, -1);
    }
    const refs = args as FakeRef[];
    return Promise.resolve(
      refs.map((ref) => {
        const data = this.produtos.get(ref.id);
        return { id: ref.id, exists: data != null, data: () => data };
      }),
    );
  }
}

function matches(stored: unknown, op: string, value: unknown): boolean {
  switch (op) {
    case '==':
      return stored === value;
    case 'in':
      return Array.isArray(value) && value.includes(stored);
    default:
      throw new Error(`FakeDb: unsupported operator ${op}`);
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures -------------------------------- */

const CONTA = 'conta-A';
const REF_CANONICO = `documents/integracao/${CONTA}`;
const REF_BARE = `integracao/${CONTA}`;

const TOUCHED_ENV = [PRECO_RECONCILIACAO_FLAG_ENV, 'MERCADO_LIVRE_PRECO_RECON_PAGE_LIMIT'];

function linkPath(produtoId: string, linkId = 'link1'): string {
  return `produtos/${produtoId}/produtoMercadoLivre/${linkId}`;
}

/** A LIVE link (an item id, and not cancelled) on the conta. */
function seedLiveLink(db: FakeDb, produtoId: string, over: DocData = {}): void {
  db.seedLink(linkPath(produtoId), {
    contaOuterRef: REF_CANONICO,
    id: 'MLB1',
    estado: 'p',
    ...over,
  });
}

/** An anchor the plan WOULD have enumerated. */
function seedAnchorEnumeravel(db: FakeDb, produtoId: string, over: DocData = {}): void {
  db.seedProduto(produtoId, { paiId: null, integracoesComProduto: [CONTA], ...over });
}

async function run(db: FakeDb, afterLinkPath: string | null = null) {
  return fetchPrecoReconPage(asDb(db), { integracaoId: CONTA, afterLinkPath });
}

beforeEach(() => {
  for (const k of TOUCHED_ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of TOUCHED_ENV) delete process.env[k];
});

/* ---------------------------------- config --------------------------------- */

describe('configuration', () => {
  it('the phase is OFF unless the flag is exactly "1"', () => {
    expect(precoReconciliacaoHabilitada()).toBe(false);
    process.env[PRECO_RECONCILIACAO_FLAG_ENV] = 'true';
    expect(precoReconciliacaoHabilitada()).toBe(false);
    process.env[PRECO_RECONCILIACAO_FLAG_ENV] = '0';
    expect(precoReconciliacaoHabilitada()).toBe(false);
    process.env[PRECO_RECONCILIACAO_FLAG_ENV] = '1';
    expect(precoReconciliacaoHabilitada()).toBe(true);
  });

  it('re-reads the page limit lazily and floors it at 1', () => {
    expect(precoReconPageLimit()).toBe(500);
    process.env.MERCADO_LIVRE_PRECO_RECON_PAGE_LIMIT = '40';
    expect(precoReconPageLimit()).toBe(40);
    // A 0 would inspect nothing and re-enqueue forever.
    process.env.MERCADO_LIVRE_PRECO_RECON_PAGE_LIMIT = '0';
    expect(precoReconPageLimit()).toBe(1);
  });
});

/* ------------------------------ the classifier ----------------------------- */

describe('classificarLinkNaoEnumerado', () => {
  it('says nothing when the anchor query would have found the produto', () => {
    expect(
      classificarLinkNaoEnumerado({ paiId: null, integracoesComProduto: [CONTA] }, CONTA),
    ).toBeNull();
  });

  it('reports a missing produto doc as an orphan link', () => {
    expect(classificarLinkNaoEnumerado(null, CONTA)).toBe('NAO_ENUMERADO_PRODUTO_AUSENTE');
  });

  it('reports a link on a variation child (#804 class 3)', () => {
    expect(
      classificarLinkNaoEnumerado({ paiId: 'ANCHOR', integracoesComProduto: [CONTA] }, CONTA),
    ).toBe('NAO_ENUMERADO_LINK_EM_VARIACAO');
  });

  it('reports a drifted denorm (#804 class 2)', () => {
    expect(classificarLinkNaoEnumerado({ paiId: null, integracoesComProduto: [] }, CONTA)).toBe(
      'NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO',
    );
  });

  it('ranks the child check ABOVE the denorm check', () => {
    // Both hold. `paiId` is the more specific, more actionable diagnosis — and
    // the denorm legitimately lands on the CHILD (the trigger stamps the link's
    // own produto), so reporting drift here would name a state that is correct.
    expect(classificarLinkNaoEnumerado({ paiId: 'ANCHOR', integracoesComProduto: [] }, CONTA)).toBe(
      'NAO_ENUMERADO_LINK_EM_VARIACAO',
    );
  });

  it('treats a junk or absent integracoesComProduto as "not listed", never as a throw', () => {
    expect(classificarLinkNaoEnumerado({ paiId: null }, CONTA)).toBe(
      'NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO',
    );
    expect(classificarLinkNaoEnumerado({ paiId: null, integracoesComProduto: 'nope' }, CONTA)).toBe(
      'NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO',
    );
    expect(
      classificarLinkNaoEnumerado({ paiId: null, integracoesComProduto: [1, null, CONTA] }, CONTA),
    ).toBeNull();
  });

  it('reports a paiId that is neither null nor a usable id', () => {
    // `where('paiId','==',null)` is an EXACT equality, so `''` is matched by
    // neither the query nor "is a variation child". Calling it enumerable would
    // leave a live anúncio reported by nobody on a `completed` job — the exact
    // silence this phase exists to end.
    expect(classificarLinkNaoEnumerado({ paiId: '', integracoesComProduto: [CONTA] }, CONTA)).toBe(
      'NAO_ENUMERADO_PAI_ID_INVALIDO',
    );
  });

  it('reports an ABSENT paiId — a missing field satisfies no equality, not even == null', () => {
    // Firestore does not index an absent field, so such a document matches no
    // equality at all. `produto.ts:215` says both writers always write `paiId`,
    // which should make this unreachable — reported anyway rather than trusted,
    // because the legacy corpus is not bound by the schema (rule 8).
    expect(classificarLinkNaoEnumerado({ integracoesComProduto: [CONTA] }, CONTA)).toBe(
      'NAO_ENUMERADO_PAI_ID_INVALIDO',
    );
  });

  it('a real paiId still reports as a variation child, not as invalid', () => {
    // The two arms must not collapse: the remedies differ ("re-point the
    // anúncio" vs "fix the produto's cadastro").
    expect(
      classificarLinkNaoEnumerado({ paiId: 'ANCHOR', integracoesComProduto: [CONTA] }, CONTA),
    ).toBe('NAO_ENUMERADO_LINK_EM_VARIACAO');
  });
});

/* -------------------------------- the walk --------------------------------- */

describe('fetchPrecoReconPage', () => {
  it('reports a produto whose integracoesComProduto no longer names a conta it is still linked to', async () => {
    // The issue's explicit acceptance criterion: a LIVE link on the conta, and
    // a produto the anchor query cannot select because the denorm dropped it.
    const db = new FakeDb();
    seedLiveLink(db, 'P1');
    db.seedProduto('P1', { paiId: null, integracoesComProduto: [] });

    const page = await run(db);

    expect(page.naoEnumerados).toEqual([
      { produtoId: 'P1', itemId: 'MLB1', code: 'NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO' },
    ]);
    expect(page.inspecionados).toBe(1);
  });

  it('says nothing about a produto the plan did enumerate', async () => {
    const db = new FakeDb();
    seedLiveLink(db, 'P1');
    seedAnchorEnumeravel(db, 'P1');

    const page = await run(db);

    expect(page.naoEnumerados).toEqual([]);
    // Still counted as inspected — "no findings" and "did not look" differ.
    expect(page.inspecionados).toBe(1);
  });

  it('does NOT report an unpublished produto — #1072 made the plan enumerate it', async () => {
    // Class 1 must not double-report: the plan sends it, so naming it here
    // would be a row the operator cannot act on and does not need.
    const db = new FakeDb();
    seedLiveLink(db, 'P1');
    seedAnchorEnumeravel(db, 'P1', { publicado: false });

    expect((await run(db)).naoEnumerados).toEqual([]);
  });

  it('reports a link sitting on a variation child', async () => {
    const db = new FakeDb();
    seedLiveLink(db, 'CHILD');
    db.seedProduto('CHILD', { paiId: 'ANCHOR', integracoesComProduto: [CONTA] });

    expect((await run(db)).naoEnumerados).toEqual([
      { produtoId: 'CHILD', itemId: 'MLB1', code: 'NAO_ENUMERADO_LINK_EM_VARIACAO' },
    ]);
  });

  it('reports a link whose produto is gone', async () => {
    const db = new FakeDb();
    seedLiveLink(db, 'GONE');

    expect((await run(db)).naoEnumerados).toEqual([
      { produtoId: 'GONE', itemId: 'MLB1', code: 'NAO_ENUMERADO_PRODUTO_AUSENTE' },
    ]);
  });

  /* ---- the noise guard: without it the report is worthless on a real conta -- */

  it('ignores a CLOSED listing even though its produto fails the predicate', async () => {
    // `estado 'c'` is exactly why the trigger dropped the conta from the
    // denorm. Reporting it would emit a row for every listing the seller has
    // ever closed — the healthy steady state rendered as drift.
    const db = new FakeDb();
    seedLiveLink(db, 'P1', { estado: 'c' });
    db.seedProduto('P1', { paiId: null, integracoesComProduto: [] });

    const page = await run(db);

    expect(page.naoEnumerados).toEqual([]);
    expect(page.inspecionados).toBe(0);
  });

  it('ignores a never-published link even though its produto fails the predicate', async () => {
    const db = new FakeDb();
    seedLiveLink(db, 'P1', { id: null });
    db.seedProduto('P1', { paiId: null, integracoesComProduto: [] });

    expect((await run(db)).naoEnumerados).toEqual([]);
  });

  /* --------------------------------- scoping -------------------------------- */

  it('accepts BOTH stored contaOuterRef forms', async () => {
    const db = new FakeDb();
    db.seedLink(linkPath('P1'), { contaOuterRef: REF_CANONICO, id: 'MLB1', estado: 'p' });
    db.seedLink(linkPath('P2'), { contaOuterRef: REF_BARE, id: 'MLB2', estado: 'p' });

    const page = await run(db);

    expect(page.naoEnumerados.map((o) => o.produtoId).sort()).toEqual(['P1', 'P2']);
  });

  it('ignores links belonging to another conta', async () => {
    const db = new FakeDb();
    db.seedLink(linkPath('P1'), {
      contaOuterRef: 'documents/integracao/outra-conta',
      id: 'MLB1',
      estado: 'p',
    });

    const page = await run(db);

    expect(page.naoEnumerados).toEqual([]);
    expect(page.inspecionados).toBe(0);
  });

  it('reports every live link on one produto, not just the first', async () => {
    // The join has no `limit(1)`: two listings on one produto is a modelled case.
    const db = new FakeDb();
    db.seedLink(linkPath('P1', 'a'), { contaOuterRef: REF_CANONICO, id: 'MLB1', estado: 'p' });
    db.seedLink(linkPath('P1', 'b'), { contaOuterRef: REF_CANONICO, id: 'MLB2', estado: 'p' });
    db.seedProduto('P1', { paiId: null, integracoesComProduto: [] });

    const page = await run(db);

    expect(page.naoEnumerados.map((o) => o.itemId)).toEqual(['MLB1', 'MLB2']);
    // One produto, one key read — the batch is deduped.
    expect(page.inspecionados).toBe(2);
  });

  /* ------------------------- paging and the cursor -------------------------- */

  it('pages with a full document PATH cursor, not a bare id', async () => {
    const db = new FakeDb();
    for (const p of ['P1', 'P2', 'P3']) {
      seedLiveLink(db, p);
      db.seedProduto(p, { paiId: null, integracoesComProduto: [] });
    }

    const first = await fetchPrecoReconPage(asDb(db), { integracaoId: CONTA, pageLimit: 2 });
    expect(first.naoEnumerados.map((o) => o.produtoId)).toEqual(['P1', 'P2']);
    expect(first.nextAfterLinkPath).toBe(linkPath('P2'));

    // The resume hands Firestore a DocumentReference — the fake throws on a
    // bare id, which is what real Firestore does ("must result in a valid
    // document path"). This is the one bug a laxer fake would hide.
    const second = await fetchPrecoReconPage(asDb(db), {
      integracaoId: CONTA,
      afterLinkPath: first.nextAfterLinkPath,
      pageLimit: 2,
    });
    expect(second.naoEnumerados.map((o) => o.produtoId)).toEqual(['P3']);
    expect(db.startAfterArg).toMatchObject({ path: linkPath('P2') });
    // A short page drains the walk.
    expect(second.nextAfterLinkPath).toBeNull();
  });

  it('throws on a corrupt cursor rather than silently restarting the walk', async () => {
    // The cursor is machine-written from `doc.ref.path`, so a shape that does
    // not parse is corruption. Both graceful options are worse: ignoring it
    // restarts from the beginning every dispatch (a loop), and concluding early
    // truncates the report silently.
    const db = new FakeDb();
    seedLiveLink(db, 'P1');

    await expect(run(db, 'produtos/P1')).rejects.toThrow(/cursor de reconciliação/);
    await expect(run(db, '')).rejects.toThrow(/cursor de reconciliação/);
  });

  it('concludes on a short page even when every row was filtered out', async () => {
    const db = new FakeDb();
    seedLiveLink(db, 'P1', { estado: 'c' });

    const page = await fetchPrecoReconPage(asDb(db), { integracaoId: CONTA, pageLimit: 5 });

    expect(page.nextAfterLinkPath).toBeNull();
  });

  it('keeps the cursor on a FULL page whose rows were all filtered out', async () => {
    // The cursor must advance on documents READ, never on rows reported —
    // otherwise a page of closed listings would end the walk early and hide
    // every finding behind it.
    const db = new FakeDb();
    seedLiveLink(db, 'P1', { estado: 'c' });
    seedLiveLink(db, 'P2', { estado: 'c' });

    const page = await fetchPrecoReconPage(asDb(db), { integracaoId: CONTA, pageLimit: 2 });

    expect(page.naoEnumerados).toEqual([]);
    expect(page.nextAfterLinkPath).toBe(linkPath('P2'));
  });

  it('reads nothing at all when the page has no live links', async () => {
    const db = new FakeDb();
    seedLiveLink(db, 'P1', { estado: 'c' });

    await run(db);

    // No `getAll` round trip for a page with nothing to classify.
    expect(db.getAllMask).toBeNull();
  });

  /* ------------------------------ the projections --------------------------- */

  it('masks both reads — link docs and produtos are heavy', async () => {
    const db = new FakeDb();
    seedLiveLink(db, 'P1');
    seedAnchorEnumeravel(db, 'P1');

    await run(db);

    // A link doc carries `descricao` (<=50k chars) and an `attributes` array;
    // Enterprise bills what is scanned.
    expect(db.selectedFields).toEqual(['id', 'estado']);
    expect(db.getAllMask).toEqual(['paiId', 'integracoesComProduto']);
  });
});
