import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import { vincularClienteMercadoLivre } from './claimCliente';

type DocData = Record<string, unknown>;

/** Own FakeDb — the in-repo convention is deliberately NOT to share them. */
class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }
  /** Bumped on every write, so `updateTime` behaves like a real version. */
  private versoes = new Map<string, number>();
  /** Set by a test to simulate the doc moving between the read and the write. */
  mexerAntesDoUpdate: (() => void) | null = null;

  /** Advance a doc's version without going through `set` — a concurrent writer. */
  bumpVersao(path: string, id: string): void {
    const k = `${path}/${id}`;
    this.versoes.set(k, (this.versoes.get(k) ?? 0) + 1);
  }

  collection(path: string) {
    const col = this.col(path);
    const versoes = this.versoes;
    const chave = (id: string) => `${path}/${id}`;
    const escrever = (id: string, data: DocData, merge: boolean) => {
      col.set(id, merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
      versoes.set(chave(id), (versoes.get(chave(id)) ?? 0) + 1);
    };
    const self = this;
    const q = (clauses: Array<{ field: string; value: unknown }>, lim: number | null) => ({
      where: (field: string, _op: string, value: unknown) => q([...clauses, { field, value }], lim),
      limit: (n: number) => q(clauses, n),
      get: async () => {
        let docs = [...col.entries()].filter(([, d]) =>
          clauses.every((c) => d[c.field] === c.value),
        );
        if (lim != null) docs = docs.slice(0, lim);
        return { docs: docs.map(([id, d]) => ({ id, data: () => d })) };
      },
    });
    return {
      where: (field: string, _op: string, value: unknown) => q([{ field, value }], null),
      doc: (id: string) => ({
        id,
        get: async () => ({
          exists: col.has(id),
          id,
          data: () => col.get(id),
          updateTime: versoes.get(chave(id)) ?? 0,
        }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          escrever(id, data, opts?.merge === true);
        },
        /**
         * ⚠️ Models the tier-1 precondition, which is the whole point of the
         * test: the write only lands if the doc has not moved since the read.
         */
        update: async (data: DocData, precond?: { lastUpdateTime?: unknown }) => {
          self.mexerAntesDoUpdate?.();
          const atual = versoes.get(chave(id)) ?? 0;
          if (precond?.lastUpdateTime != null && precond.lastUpdateTime !== atual) {
            throw new FakePreconditionError();
          }
          escrever(id, data, true);
        },
      }),
    };
  }
}
const asDb = (f: FakeDb) => f as unknown as Firestore;

/**
 * ⚠️ Shaped like what Firestore Admin ACTUALLY raises: a gRPC error with
 * `code: 9` (FAILED_PRECONDITION), not a `FirebaseError`. Getting this fake
 * right is what caught the production narrowing being wrong.
 */
class FakePreconditionError extends Error {
  readonly code = 9;
  constructor() {
    super('the document has changed');
  }
}

const REF = 'documents/clientes/cli-1';
const BUYER = 301110805;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('vincularClienteMercadoLivre', () => {
  it('stamps idMercadoLivre on a cliente that has none', async () => {
    // ⚠️ The whole point. A buyer resolved BY their ML id from a pre-sale
    // question and a buyer resolved by CPF from their order are two clientes
    // until one of them learns the other's key. The claim is the first moment
    // both facts are in hand.
    const db = new FakeDb();
    db.seed('clientes', 'cli-1', { nome: 'Fulano', idMercadoLivre: null });

    const r = await vincularClienteMercadoLivre(asDb(db), {
      clienteOuterRef: REF,
      buyerUserId: BUYER,
    });

    expect(r).toEqual({ clienteOuterRef: REF, carimbouIdMercadoLivre: true });
    expect(db.docs('clientes').get('cli-1')).toMatchObject({
      nome: 'Fulano', // merge, not overwrite
      idMercadoLivre: '301110805', // STRING — ML ids outgrew Int32
    });
  });

  it('is a no-op when the same id is already stored', async () => {
    const db = new FakeDb();
    db.seed('clientes', 'cli-1', { nome: 'Fulano', idMercadoLivre: '301110805' });

    const r = await vincularClienteMercadoLivre(asDb(db), {
      clienteOuterRef: REF,
      buyerUserId: BUYER,
    });

    expect(r.carimbouIdMercadoLivre).toBe(false);
    expect(db.docs('clientes').get('cli-1')).toEqual({
      nome: 'Fulano',
      idMercadoLivre: '301110805',
    });
  });

  it('NEVER overwrites a different stored id — it warns and leaves it', async () => {
    // ⚠️ Two ML accounts sharing one cliente, or an earlier wrong stamp. Either
    // way rewriting it would move the identity under whichever claim arrived
    // last (root CLAUDE.md rule 7) — a human's call, not a webhook's.
    const db = new FakeDb();
    db.seed('clientes', 'cli-1', { nome: 'Fulano', idMercadoLivre: '999999999' });

    const r = await vincularClienteMercadoLivre(asDb(db), {
      clienteOuterRef: REF,
      buyerUserId: BUYER,
    });

    expect(r.carimbouIdMercadoLivre).toBe(false);
    expect(db.docs('clientes').get('cli-1')).toMatchObject({ idMercadoLivre: '999999999' });
    expect(console.warn).toHaveBeenCalled();
  });

  it('treats a whitespace-only stored id as absent', async () => {
    const db = new FakeDb();
    db.seed('clientes', 'cli-1', { idMercadoLivre: '   ' });

    const r = await vincularClienteMercadoLivre(asDb(db), {
      clienteOuterRef: REF,
      buyerUserId: BUYER,
    });

    expect(r.carimbouIdMercadoLivre).toBe(true);
    expect(db.docs('clientes').get('cli-1')).toMatchObject({ idMercadoLivre: '301110805' });
  });

  it('degrades when the cliente doc is gone, rather than blocking the claim', async () => {
    // The pedido still names it, and the conversa still imports — it just
    // carries a ref to a deleted document, exactly as the old usuario path did.
    const db = new FakeDb();

    const r = await vincularClienteMercadoLivre(asDb(db), {
      clienteOuterRef: REF,
      buyerUserId: BUYER,
    });

    expect(r).toEqual({ clienteOuterRef: REF, carimbouIdMercadoLivre: false });
    expect(db.docs('clientes').size).toBe(0);
  });

  it('creates NOTHING — this path never mints a cliente', async () => {
    // Legacy blind-created a `usuarios` doc here. The replacement must not
    // reintroduce the same unbounded growth under a different collection.
    const db = new FakeDb();
    await vincularClienteMercadoLivre(asDb(db), { clienteOuterRef: REF, buyerUserId: BUYER });
    expect(db.docs('clientes').size).toBe(0);
    expect(db.docs('usuarios').size).toBe(0);
  });
});

describe('vincularClienteMercadoLivre — one identity, one owner', () => {
  it('REFUSES to stamp when another cliente already owns this ML id', async () => {
    // ⚠️ The correction. This module used to claim it made the question-cliente
    // and the order-cliente converge, and it did not: `questionImport` resolves
    // a pre-sale asker BY this key, so the buyer routinely already owns a second
    // doc. Stamping regardless would leave TWO strong owners of one identity and
    // `findOrCreateCliente`'s match leg could return either — manufacturing the
    // exact ambiguity #1067 exists to prevent.
    const db = new FakeDb();
    db.seed('clientes', 'cli-1', { nome: 'Do pedido', idMercadoLivre: null });
    db.seed('clientes', 'cli-da-pergunta', { nome: 'Da pergunta', idMercadoLivre: '301110805' });

    const r = await vincularClienteMercadoLivre(asDb(db), {
      clienteOuterRef: REF,
      buyerUserId: BUYER,
    });

    expect(r.carimbouIdMercadoLivre).toBe(false);
    expect(r.clienteConflitante).toBe('cli-da-pergunta');
    expect(db.docs('clientes').get('cli-1')!.idMercadoLivre).toBeNull();
    // Merging two clientes moves pedidos, conversas and endereços — a migration,
    // not a webhook's job. It is logged instead.
    expect(console.warn).toHaveBeenCalled();
  });

  it('still stamps when the only doc carrying the id IS this cliente', async () => {
    // The `limit(2)` matters here: one hit that is the target itself is fine, so
    // the query has to be able to see a second before it can tell them apart.
    const db = new FakeDb();
    db.seed('clientes', 'cli-1', { nome: 'Do pedido', idMercadoLivre: '301110805' });

    const r = await vincularClienteMercadoLivre(asDb(db), {
      clienteOuterRef: REF,
      buyerUserId: BUYER,
    });

    expect(r.carimbouIdMercadoLivre).toBe(false);
    expect(r.clienteConflitante).toBeUndefined();
  });
});

describe('vincularClienteMercadoLivre — the write carries a precondition', () => {
  it('DISCARDS the stamp when the cliente moved between the read and the write', async () => {
    // ⚠️ Without `lastUpdateTime` the merge is last-write-wins: two claim
    // deliveries carrying DIFFERENT buyer ids can both observe an empty field,
    // and the later write silently replaces the first — while this module
    // advertises that it never overwrites. Tier 1, Admin-only (rule 7).
    const db = new FakeDb();
    db.seed('clientes', 'cli-1', { nome: 'Fulano', idMercadoLivre: null });
    // A concurrent delivery wins the race after our snapshot was taken.
    db.mexerAntesDoUpdate = () => {
      db.seed('clientes', 'cli-1', { nome: 'Fulano', idMercadoLivre: '999999999' });
      db.bumpVersao('clientes', 'cli-1');
    };

    const r = await vincularClienteMercadoLivre(asDb(db), {
      clienteOuterRef: REF,
      buyerUserId: BUYER,
    });

    expect(r.carimbouIdMercadoLivre).toBe(false);
    // The winner survives untouched — the loser does NOT overwrite it.
    expect(db.docs('clientes').get('cli-1')!.idMercadoLivre).toBe('999999999');
  });
});
