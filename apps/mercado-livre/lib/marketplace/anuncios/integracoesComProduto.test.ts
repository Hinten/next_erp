import { describe, expect, it } from 'vitest';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { linkHasLiveListing, variacaoLinkHasListing } from '@delfrance/schemas';

import {
  adicionarConta,
  contaIdFromRef,
  contaRefForms,
  lerLinkPai,
  planLinkChange,
  removerContaSeOrfa,
  resolverContaRefDaVariacao,
  sobrevivemLinksDoProduto,
  sobrevivemVariacoesDoProduto,
  variacaoPodeMudarMembership,
} from './integracoesComProduto';

/* ------------------------------ fake Firestore ---------------------------- */
// Own copy, per this folder's convention. Scoped to what the module touches:
// `produtos/<id>` (`update`, which must throw gRPC 5 when absent — the cascade
// case), the two link subcollections (a plain `get` and an `in` query), and a
// read-write transaction. `opLog` is real so the zero-read assertions mean
// something.

type DocData = Record<string, unknown>;

class NotFoundError extends Error {
  readonly code = 5;
  constructor(path: string) {
    super(`NOT_FOUND: ${path}`);
    this.name = 'NotFoundError';
  }
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: 'get' | 'query' | 'update'; path: string }> = [];
  /** Patches handed to `update`, in call order — the assertion surface. */
  readonly patches: Array<{ path: string; patch: DocData }> = [];

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }

  seed(path: string, id: string, data: DocData): this {
    this.col(path).set(id, data);
    return this;
  }

  private makeQuery(path: string, clauses: Array<[string, string, unknown]>) {
    const self = this;
    return {
      path,
      where(field: string, op: string, value: unknown) {
        return self.makeQuery(path, [...clauses, [field, op, value]]);
      },
      async get() {
        self.opLog.push({ op: 'query', path });
        const rows = [...self.col(path).entries()].filter(([, d]) =>
          clauses.every(([f, op, v]) =>
            op === 'in' ? (v as unknown[]).includes(d[f]) : d[f] === v,
          ),
        );
        return { docs: rows.map(([id, d]) => ({ id, data: () => d, exists: true })) };
      },
    };
  }

  collection(path: string) {
    const self = this;
    const q = this.makeQuery(path, []);
    return {
      ...q,
      doc(id: string) {
        const docPath = `${path}/${id}`;
        return {
          id,
          path: docPath,
          async get() {
            self.opLog.push({ op: 'get', path: docPath });
            const col = self.col(path);
            return { exists: col.has(id), id, data: () => col.get(id) };
          },
          async update(patch: DocData) {
            self.opLog.push({ op: 'update', path: docPath });
            const col = self.col(path);
            if (!col.has(id)) throw new NotFoundError(docPath);
            self.patches.push({ path: docPath, patch });
          },
        };
      },
    };
  }

  /**
   * Reads run live; writes are buffered and applied on commit, so a `tx.update`
   * on a produto the cascade already removed fails at COMMIT the way the real
   * SDK does — which is the path `removerContaSeOrfa`'s narrowing exists for.
   */
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const self = this;
    const buffered: Array<{ path: string; patch: DocData }> = [];
    const tx = {
      get: async (alvo: { get: () => Promise<unknown> }) => alvo.get(),
      update: (ref: { path: string }, patch: DocData) => {
        buffered.push({ path: ref.path, patch });
      },
    };
    const saida = await fn(tx);
    for (const w of buffered) {
      const corte = w.path.lastIndexOf('/');
      const col = self.col(w.path.slice(0, corte));
      const id = w.path.slice(corte + 1);
      self.opLog.push({ op: 'update', path: w.path });
      if (!col.has(id)) throw new NotFoundError(w.path);
      self.patches.push(w);
    }
    return saida;
  }
}

const db = (f: FakeDb): Firestore => f as unknown as Firestore;

const CONTA = 'conta1';
const REF_CANONICO = `documents/integracao/${CONTA}`;
const PML = 'produtos/p1/produtoMercadoLivre';
const VML = 'produtos/c1/variacaoMercadoLivre';

/* ------------------------------- pure helpers ----------------------------- */

describe('contaIdFromRef', () => {
  it('accepts both stored ref forms, since readers tolerate both', () => {
    expect(contaIdFromRef(`documents/integracao/${CONTA}`)).toBe(CONTA);
    expect(contaIdFromRef(`integracao/${CONTA}`)).toBe(CONTA);
  });

  it('returns null for a ref that points somewhere other than integracao', () => {
    expect(contaIdFromRef('documents/produtos/p1')).toBeNull();
  });

  it('returns null rather than throwing on junk — a bad doc must not ride the Eventarc retry forever', () => {
    expect(contaIdFromRef(undefined)).toBeNull();
    expect(contaIdFromRef(null)).toBeNull();
    expect(contaIdFromRef(42)).toBeNull();
    expect(contaIdFromRef('')).toBeNull();
    expect(contaIdFromRef('integracao')).toBeNull(); // odd segment count
  });
});

describe('contaRefForms', () => {
  it('enumerates both forms — `endsWith` is not a Firestore predicate', () => {
    expect(contaRefForms(CONTA)).toEqual([`documents/integracao/${CONTA}`, `integracao/${CONTA}`]);
  });
});

describe('linkHasLiveListing (parent membership rule)', () => {
  it('counts a published listing', () => {
    expect(linkHasLiveListing({ id: 'MLB1', estado: 'p' })).toBe(true);
  });

  it('does NOT count a draft that never reached ML', () => {
    expect(linkHasLiveListing({ id: null, estado: 'r' })).toBe(false);
  });

  it('does NOT count a cancelled listing — the doc survives the cancel, so estado is the only signal', () => {
    expect(linkHasLiveListing({ id: 'MLB1', estado: 'c' })).toBe(false);
  });

  it('does NOT count a listing Mercado Livre REMOVED (#1226)', () => {
    // The `integracoesComProduto` half of #1226: the doc survives the removal
    // with its now-dead item id, so — exactly as with a cancel — `estado` is the
    // only signal, and without this the produto stays in the anchor pre-filter
    // both sweeps open with for a listing ML deleted.
    expect(linkHasLiveListing({ id: 'MLB1', estado: 'rm' })).toBe(false);
  });

  it('still counts paused/erro/aguardando-migracao — only `c` and `rm` mean the listing is gone', () => {
    // ⚠️ The expensive direction: a false negative here is a SILENT stock and
    // price outage, so only the two ML-TERMINAL estados may drop out. `'v'` is
    // the near-miss that matters — a listing merely under review is savable.
    for (const estado of ['pa', 'E', 'am', 'a', 'v', 'ep']) {
      expect(linkHasLiveListing({ id: 'MLB1', estado })).toBe(true);
    }
  });

  it('is false for a missing link', () => {
    expect(linkHasLiveListing(null)).toBe(false);
  });
});

describe('variacaoLinkHasListing (child membership rule)', () => {
  it('counts a legacy numeric variation id and a User-Products itemId alike', () => {
    expect(variacaoLinkHasListing({ id: 123, itemId: null })).toBe(true);
    expect(variacaoLinkHasListing({ id: null, itemId: 'MLB9' })).toBe(true);
  });

  it('does NOT count a link naming no ML listing', () => {
    expect(variacaoLinkHasListing({ id: null, itemId: null })).toBe(false);
    expect(variacaoLinkHasListing(null)).toBe(false);
  });

  it('ignores `estado` entirely — it lives on the parent link, and honouring it would force a fan-out', () => {
    expect(variacaoLinkHasListing({ id: 123, estado: 'c' })).toBe(true);
  });
});

describe('planLinkChange', () => {
  const live = { contaOuterRef: REF_CANONICO, id: 'MLB1', estado: 'p' };
  const cancelado = { contaOuterRef: REF_CANONICO, id: 'MLB1', estado: 'c' };

  it('adds on create', () => {
    expect(planLinkChange(null, live, linkHasLiveListing)).toEqual({ add: [CONTA], check: [] });
  });

  it('checks on cancel — the link doc is still there, so only estado moved', () => {
    expect(planLinkChange(live, cancelado, linkHasLiveListing)).toEqual({
      add: [],
      check: [CONTA],
    });
  });

  it('adds again when a cancelled listing is relisted (self-healing)', () => {
    expect(planLinkChange(cancelado, live, linkHasLiveListing)).toEqual({
      add: [CONTA],
      check: [],
    });
  });

  it('checks on delete', () => {
    expect(planLinkChange(live, null, linkHasLiveListing)).toEqual({ add: [], check: [CONTA] });
  });

  it('is remove-from-old + add-to-new when the conta ref is re-pointed', () => {
    const outra = { ...live, contaOuterRef: 'documents/integracao/conta2' };
    expect(planLinkChange(live, outra, linkHasLiveListing)).toEqual({
      add: ['conta2'],
      check: [CONTA],
    });
  });

  it('does NOT check a conta this doc never contributed to — that buys a transaction and nothing else', () => {
    const draft = { contaOuterRef: REF_CANONICO, id: null, estado: 'r' };
    const outraDraft = { ...draft, contaOuterRef: 'documents/integracao/conta2' };
    expect(planLinkChange(draft, outraDraft, linkHasLiveListing)).toEqual({ add: [], check: [] });
  });

  it('is a no-op for a routine writeback — THE fast path, since these docs are rewritten constantly', () => {
    const depois = { ...live, ultimaModificacao: 123, errors: ['x'] };
    expect(planLinkChange(live, depois, linkHasLiveListing)).toEqual({ add: [], check: [] });
  });

  it('is a no-op for a draft written and rewritten', () => {
    const draft = { contaOuterRef: REF_CANONICO, id: null, estado: 'r' };
    expect(planLinkChange(draft, { ...draft, sku: 'X' }, linkHasLiveListing)).toEqual({
      add: [],
      check: [],
    });
  });

  it('ignores a link whose conta ref is unresolvable rather than acting on it', () => {
    expect(planLinkChange(null, { id: 'MLB1', estado: 'p' }, linkHasLiveListing)).toEqual({
      add: [],
      check: [],
    });
  });
});

describe('variacaoPodeMudarMembership', () => {
  const link = { contaOuterRef: REF_CANONICO, produtoMercadoLivreOuterRef: 'x', id: 7 };

  it('is true on create and on delete', () => {
    expect(variacaoPodeMudarMembership(null, link)).toBe(true);
    expect(variacaoPodeMudarMembership(link, null)).toBe(true);
  });

  it('is true when the conta ref or the parent-link ref moves', () => {
    expect(
      variacaoPodeMudarMembership(link, { ...link, contaOuterRef: 'documents/integracao/z' }),
    ).toBe(true);
    expect(variacaoPodeMudarMembership(link, { ...link, produtoMercadoLivreOuterRef: 'y' })).toBe(
      true,
    );
  });

  it('is true when the doc gains an ML identifier', () => {
    expect(variacaoPodeMudarMembership({ ...link, id: null }, link)).toBe(true);
  });

  it('is false for a writeback that touches none of those', () => {
    expect(variacaoPodeMudarMembership(link, { ...link, sku: 'novo' })).toBe(false);
  });
});

/* ----------------------------------- IO ----------------------------------- */

describe('adicionarConta', () => {
  it('writes ONLY the array key — no stamps, or every publish churns the TableView monitors', async () => {
    const f = new FakeDb().seed('produtos', 'p1', { nome: 'x' });
    await expect(adicionarConta(db(f), 'p1', CONTA)).resolves.toBe(true);
    expect(f.patches).toHaveLength(1);
    expect(Object.keys(f.patches[0]!.patch)).toEqual(['integracoesComProduto']);
    expect(f.patches[0]!.patch.integracoesComProduto).toEqual(FieldValue.arrayUnion(CONTA));
  });

  it('reports the produto is gone instead of resurrecting it as a husk', async () => {
    const f = new FakeDb();
    await expect(adicionarConta(db(f), 'sumiu', CONTA)).resolves.toBe(false);
    expect(f.patches).toHaveLength(0);
  });
});

describe('sobrevivemLinksDoProduto', () => {
  const rodar = async (f: FakeDb) =>
    f.runTransaction(async (tx) => sobrevivemLinksDoProduto(db(f), 'p1', CONTA)(tx as never));

  it('sees a live listing on the conta', async () => {
    const f = new FakeDb().seed(PML, 'l1', {
      contaOuterRef: REF_CANONICO,
      id: 'MLB1',
      estado: 'p',
    });
    await expect(rodar(f)).resolves.toBe(true);
  });

  it('does not count a cancelled one', async () => {
    const f = new FakeDb().seed(PML, 'l1', {
      contaOuterRef: REF_CANONICO,
      id: 'MLB1',
      estado: 'c',
    });
    await expect(rodar(f)).resolves.toBe(false);
  });

  it('keeps the conta while ANY of its listings is live — a produto can carry several on one conta', async () => {
    const f = new FakeDb()
      .seed(PML, 'l1', { contaOuterRef: REF_CANONICO, id: 'MLB1', estado: 'c' })
      .seed(PML, 'l2', { contaOuterRef: REF_CANONICO, id: 'MLB2', estado: 'p' });
    await expect(rodar(f)).resolves.toBe(true);
  });

  it('ignores another conta’s live listing', async () => {
    const f = new FakeDb().seed(PML, 'l1', {
      contaOuterRef: 'documents/integracao/outra',
      id: 'MLB1',
      estado: 'p',
    });
    await expect(rodar(f)).resolves.toBe(false);
  });

  it('matches the bare ref form too', async () => {
    const f = new FakeDb().seed(PML, 'l1', {
      contaOuterRef: `integracao/${CONTA}`,
      id: 'MLB1',
      estado: 'p',
    });
    await expect(rodar(f)).resolves.toBe(true);
  });
});

describe('removerContaSeOrfa', () => {
  it('removes once no listing survives', async () => {
    const f = new FakeDb()
      .seed('produtos', 'p1', { integracoesComProduto: [CONTA] })
      .seed(PML, 'l1', { contaOuterRef: REF_CANONICO, id: 'MLB1', estado: 'c' });
    await expect(
      removerContaSeOrfa(db(f), 'p1', CONTA, sobrevivemLinksDoProduto(db(f), 'p1', CONTA)),
    ).resolves.toBe(true);
    expect(f.patches[0]!.patch.integracoesComProduto).toEqual(FieldValue.arrayRemove(CONTA));
  });

  it('writes NOTHING while a listing survives — a wrong removal is the silent-outage direction', async () => {
    const f = new FakeDb()
      .seed('produtos', 'p1', { integracoesComProduto: [CONTA] })
      .seed(PML, 'l1', { contaOuterRef: REF_CANONICO, id: 'MLB1', estado: 'p' });
    await expect(
      removerContaSeOrfa(db(f), 'p1', CONTA, sobrevivemLinksDoProduto(db(f), 'p1', CONTA)),
    ).resolves.toBe(false);
    expect(f.patches).toHaveLength(0);
  });

  it('swallows the cascade race — the produto vanished mid-transaction', async () => {
    const f = new FakeDb(); // produto absent, no links
    await expect(
      removerContaSeOrfa(db(f), 'p1', CONTA, sobrevivemLinksDoProduto(db(f), 'p1', CONTA)),
    ).resolves.toBe(false);
    expect(f.patches).toHaveLength(0);
  });

  it('re-derives the verdict INSIDE the transaction, never from a value captured before it', async () => {
    const f = new FakeDb()
      .seed('produtos', 'p1', { integracoesComProduto: [CONTA] })
      .seed(PML, 'l1', { contaOuterRef: REF_CANONICO, id: 'MLB1', estado: 'c' });
    // A competing publish lands between the caller deciding to check and the
    // transaction reading. Because the survivor scan runs inside, it sees it.
    const sobrevivem = sobrevivemLinksDoProduto(db(f), 'p1', CONTA);
    f.seed(PML, 'l2', { contaOuterRef: REF_CANONICO, id: 'MLB2', estado: 'p' });
    await expect(removerContaSeOrfa(db(f), 'p1', CONTA, sobrevivem)).resolves.toBe(false);
    expect(f.patches).toHaveLength(0);
  });
});

describe('resolverContaRefDaVariacao', () => {
  it('uses the link’s own contaOuterRef and reads nothing', async () => {
    const f = new FakeDb();
    await expect(
      resolverContaRefDaVariacao({ contaOuterRef: REF_CANONICO }, lerLinkPai(db(f))),
    ).resolves.toBe(REF_CANONICO);
    expect(f.opLog).toHaveLength(0);
  });

  it('falls back to the parent link for a row that predates the field', async () => {
    const f = new FakeDb().seed(PML, 'l1', { contaOuterRef: REF_CANONICO });
    await expect(
      resolverContaRefDaVariacao(
        { produtoMercadoLivreOuterRef: 'documents/produtos/p1/produtoMercadoLivre/l1' },
        lerLinkPai(db(f)),
      ),
    ).resolves.toBe(REF_CANONICO);
  });

  it('resolves to null when the parent link is already gone — pruneMigratedSource drops both in one batch', async () => {
    const f = new FakeDb();
    await expect(
      resolverContaRefDaVariacao(
        { produtoMercadoLivreOuterRef: 'documents/produtos/p1/produtoMercadoLivre/l1' },
        lerLinkPai(db(f)),
      ),
    ).resolves.toBeNull();
  });

  it('resolves to null on a ref that is not a parent-link path', async () => {
    const f = new FakeDb();
    await expect(
      resolverContaRefDaVariacao(
        { produtoMercadoLivreOuterRef: 'documents/produtos/p1' },
        lerLinkPai(db(f)),
      ),
    ).resolves.toBeNull();
  });
});

describe('sobrevivemVariacoesDoProduto', () => {
  const rodar = async (f: FakeDb) =>
    f.runTransaction(async (tx) => sobrevivemVariacoesDoProduto(db(f), 'c1', CONTA)(tx as never));

  it('sees a sibling carrying the conta on its own field', async () => {
    const f = new FakeDb().seed(VML, 'v1', { contaOuterRef: REF_CANONICO, id: 7 });
    await expect(rodar(f)).resolves.toBe(true);
  });

  it('does not count a sibling with no ML identifier', async () => {
    const f = new FakeDb().seed(VML, 'v1', { contaOuterRef: REF_CANONICO, id: null, itemId: null });
    await expect(rodar(f)).resolves.toBe(false);
  });

  it('ignores another conta’s sibling', async () => {
    const f = new FakeDb().seed(VML, 'v1', {
      contaOuterRef: 'documents/integracao/outra',
      id: 7,
    });
    await expect(rodar(f)).resolves.toBe(false);
  });

  it('resolves a PRE-BACKFILL sibling through its parent link — reading contaOuterRef directly here would remove a live conta', async () => {
    const f = new FakeDb()
      .seed(PML, 'l1', { contaOuterRef: REF_CANONICO, id: 'MLB1', estado: 'p' })
      .seed(VML, 'v1', {
        // no contaOuterRef — the shape every imported legacy row arrives in
        produtoMercadoLivreOuterRef: 'documents/produtos/p1/produtoMercadoLivre/l1',
        id: 7,
      });
    await expect(rodar(f)).resolves.toBe(true);
  });

  it('reports no survivor once the child holds nothing', async () => {
    const f = new FakeDb();
    await expect(rodar(f)).resolves.toBe(false);
  });
});
