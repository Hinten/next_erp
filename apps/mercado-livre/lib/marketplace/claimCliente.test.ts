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
  collection(path: string) {
    const col = this.col(path);
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          col.set(id, opts?.merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
        },
      }),
    };
  }
}
const asDb = (f: FakeDb) => f as unknown as Firestore;

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
