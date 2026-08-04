import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import {
  ClaimClienteNotFoundError,
  claimUsuarioExternalId,
  resolveClaimUsuario,
} from './claimUsuario';

/* ------------------------------ fake Firestore ---------------------------- */
// Adapted from orderCliente.test.ts's FakeDb: operator-aware `where()` ('==' is
// all this suite needs), a `.create()` that throws gRPC ALREADY_EXISTS (code 6)
// on a doc that already exists, a write log (to assert "no write happened"),
// and a `missQueries` knob that makes the next N queries return empty — the
// lever that simulates the create/create race (both callers miss the lookup,
// one loses the `.create()`).

type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly writes: Array<{ path: string; data: DocData }> = [];
  /** While > 0, every query returns empty (decremented per query `.get()`). */
  missQueries = 0;

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  storedDoc(path: string, id: string): DocData | undefined {
    return this.col(path).get(id);
  }

  private query(entries: Array<[string, DocData]>) {
    const self = this;
    const clauses: Array<[string, unknown]> = [];
    let lim: number | null = null;
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
        if (self.missQueries > 0) {
          self.missQueries -= 1;
          return { docs: [], empty: true };
        }
        let rows = entries.filter(([, d]) => clauses.every(([f, v]) => d[f] === v));
        if (lim != null) rows = rows.slice(0, lim);
        return {
          docs: rows.map(([id, d]) => ({ id, data: () => d, exists: true })),
          empty: rows.length === 0,
        };
      },
    };
    return q;
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          self.writes.push({ path: `${path}/${id}`, data });
          col.set(id, opts?.merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
        },
        create: async (data: DocData) => {
          if (col.has(id)) throw Object.assign(new Error('already exists'), { code: 6 });
          self.writes.push({ path: `${path}/${id}`, data });
          col.set(id, { ...data });
        },
      }),
      where: (field: string, op: string, value: unknown) =>
        self.query([...col.entries()]).where(field, op, value),
    };
  }
}

function db(fake: FakeDb): Firestore {
  return fake as unknown as Firestore;
}

/* -------------------------------- fixtures -------------------------------- */

const CONTA = 'conta_abc123';
const BUYER = 301110805;
// sha256('/documents/integracao/conta_abc123-301110805') — the legacy
// `generateExternalId(conta.docId.path, mlUserId)` golden vector.
const EXT_ID = '92ba54c7fac91eaa2221b4f07a155f846bf42642e9e16daa4eb9964a6d501014';

function args(overrides: Partial<Parameters<typeof resolveClaimUsuario>[1]> = {}) {
  return {
    contaId: CONTA,
    clienteOuterRef: 'documents/clientes/cli1',
    buyerUserId: BUYER,
    buyerNickname: null,
    ...overrides,
  };
}

/* ---------------------------------- tests --------------------------------- */

describe('claimUsuarioExternalId', () => {
  it('matches the legacy generateExternalId formula (leading-slash conta path)', () => {
    expect(claimUsuarioExternalId(CONTA, BUYER)).toBe(EXT_ID);
  });
});

describe('resolveClaimUsuario', () => {
  it('throws ClaimClienteNotFoundError when the cliente doc is missing', async () => {
    const fake = new FakeDb();
    await expect(resolveClaimUsuario(db(fake), args())).rejects.toBeInstanceOf(
      ClaimClienteNotFoundError,
    );
  });

  it('short-circuits on a live userCliente link — no lookup, no writes', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli1', { nome: 'Maria', userCliente: 'documents/usuarios/u77' });
    fake.seed('usuarios', 'u77', { nome: 'Maria', externalId: null });

    const out = await resolveClaimUsuario(db(fake), args({ buyerNickname: 'NICK' }));

    expect(out).toEqual({ usuarioId: 'u77' });
    expect(fake.writes).toEqual([]); // no refresh, no re-link, no create
  });

  it('finds by the externalId FIELD (any doc id) and links the cliente', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli1', { nome: 'Maria', userCliente: null });
    // Legacy-created doc: located by field, its (legacy-formula) doc id kept.
    fake.seed('usuarios', 'legacy-doc-id', { nome: 'Maria', apelido: null, externalId: EXT_ID });

    const out = await resolveClaimUsuario(db(fake), args());

    expect(out).toEqual({ usuarioId: 'legacy-doc-id' });
    expect(fake.storedDoc('clientes', 'cli1')).toMatchObject({
      userCliente: 'documents/usuarios/legacy-doc-id',
    });
    // Same nome, null nickname → the usuario itself was not rewritten.
    expect(fake.writes.filter((w) => w.path.startsWith('usuarios/'))).toEqual([]);
  });

  it('refreshes nome and apelido on a hit when they changed', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli1', { nome: 'Maria Silva', userCliente: null });
    fake.seed('usuarios', 'u1', { nome: 'Anônimo', apelido: null, externalId: EXT_ID });

    const out = await resolveClaimUsuario(db(fake), args({ buyerNickname: 'MARIA123' }));

    expect(out).toEqual({ usuarioId: 'u1' });
    expect(fake.storedDoc('usuarios', 'u1')).toMatchObject({
      nome: 'Maria Silva',
      apelido: 'MARIA123',
      externalId: EXT_ID,
    });
  });

  it('never downgrades a real nome to the empty/null cliente name', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli1', { nome: null, userCliente: null });
    fake.seed('usuarios', 'u1', { nome: 'Maria Silva', apelido: 'MARIA123', externalId: EXT_ID });

    const out = await resolveClaimUsuario(db(fake), args({ buyerNickname: 'MARIA123' }));

    expect(out).toEqual({ usuarioId: 'u1' });
    expect(fake.storedDoc('usuarios', 'u1')).toMatchObject({ nome: 'Maria Silva' });
    expect(fake.writes.filter((w) => w.path.startsWith('usuarios/'))).toEqual([]);
  });

  it('creates the sem-auth usuario at the externalId doc id on a miss', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli1', { nome: 'Maria Silva', userCliente: null });

    const out = await resolveClaimUsuario(db(fake), args({ buyerNickname: 'MARIA123' }));

    expect(out).toEqual({ usuarioId: EXT_ID });
    expect(fake.storedDoc('usuarios', EXT_ID)).toMatchObject({
      nome: 'Maria Silva',
      apelido: 'MARIA123',
      colaborador: false,
      externalId: EXT_ID,
      email: null,
    });
    expect(fake.storedDoc('clientes', 'cli1')).toMatchObject({
      userCliente: `documents/usuarios/${EXT_ID}`,
    });
  });

  it("falls back to 'Anônimo' when the cliente carries no nome", async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli1', { nome: null, userCliente: null });

    const out = await resolveClaimUsuario(db(fake), args());

    expect(out).toEqual({ usuarioId: EXT_ID });
    expect(fake.storedDoc('usuarios', EXT_ID)).toMatchObject({
      nome: 'Anônimo',
      apelido: null,
    });
  });

  it('converges on the winner after an ALREADY_EXISTS create race', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli1', { nome: 'Maria', userCliente: null });
    // The concurrent winner's doc exists, but this call's first lookup misses
    // it (the race window) → `.create()` throws code 6 → re-lookup finds it.
    fake.seed('usuarios', EXT_ID, { nome: 'Raced', apelido: 'WINNER', externalId: EXT_ID });
    fake.missQueries = 1;

    const out = await resolveClaimUsuario(db(fake), args({ buyerNickname: 'MARIA123' }));

    expect(out).toEqual({ usuarioId: EXT_ID });
    // The loser converges without clobbering the winner's doc.
    expect(fake.storedDoc('usuarios', EXT_ID)).toMatchObject({ nome: 'Raced', apelido: 'WINNER' });
    expect(fake.storedDoc('clientes', 'cli1')).toMatchObject({
      userCliente: `documents/usuarios/${EXT_ID}`,
    });
  });

  it('re-links a DANGLING userCliente (target usuario gone) instead of returning a ghost', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli1', { nome: 'Maria', userCliente: 'documents/usuarios/ghost' });
    fake.seed('usuarios', 'u1', { nome: 'Maria', apelido: null, externalId: EXT_ID });

    const out = await resolveClaimUsuario(db(fake), args());

    expect(out).toEqual({ usuarioId: 'u1' });
    expect(fake.storedDoc('clientes', 'cli1')).toMatchObject({
      userCliente: 'documents/usuarios/u1',
    });
  });
});
