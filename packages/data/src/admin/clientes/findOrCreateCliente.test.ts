import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { TIPO_CLIENTE, type ClienteResolveFields } from '@delfrance/schemas';

import { buildClienteUpdatePatch, findOrCreateCliente } from './findOrCreateCliente';

/* ------------------------------ fake Firestore ---------------------------- */
// Copied from apps/mercado-livre/lib/marketplace/orderCliente.test.ts, where
// this suite lived before #786 promoted the module. packages/data cannot import
// from apps/, and per-suite in-memory fakes are this repo's convention
// (pedidoReconcile.test.ts, notifications/pipeline.test.ts).
//
// Two additions over the original: `docOrder` reverses iteration order so a
// test can prove the pick does not depend on insertion order, and `seedMany`
// bulk-seeds the paging cases.

type DocData = Record<string, unknown>;

function matchClause(fieldValue: unknown, op: string, value: unknown): boolean {
  if (op === 'in') return Array.isArray(value) && value.includes(fieldValue);
  return fieldValue === value;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  private autoN = 0;
  /** Rows examined by the last `.get()` — proves `.limit()` actually applied. */
  lastPageSize = 0;
  /** Iteration order handed to a query, mimicking an unspecified index order. */
  docOrder: 'insertion' | 'reverse' = 'insertion';

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  seedMany(path: string, docs: Array<[string, DocData]>): void {
    for (const [id, data] of docs) this.seed(path, id, data);
  }
  storedDoc(path: string, id: string): DocData | undefined {
    return this.col(path).get(id);
  }
  docCount(path: string): number {
    return this.col(path).size;
  }

  private query(entries: Array<[string, DocData]>) {
    const self = this;
    const rowsIn = self.docOrder === 'reverse' ? [...entries].reverse() : entries;
    const clauses: Array<[string, string, unknown]> = [];
    let lim: number | null = null;
    const q = {
      where(field: string, op: string, value: unknown) {
        clauses.push([field, op, value]);
        return q;
      },
      limit(n: number) {
        lim = n;
        return q;
      },
      async get() {
        let rows = rowsIn.filter(([, d]) =>
          clauses.every(([f, op, v]) => matchClause(d[f], op, v)),
        );
        if (lim != null) rows = rows.slice(0, lim);
        self.lastPageSize = rows.length;
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
      doc: (id?: string) => {
        const docId = id ?? `auto-${++self.autoN}`;
        return {
          id: docId,
          get: async () => ({ exists: col.has(docId), id: docId, data: () => col.get(docId) }),
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            col.set(docId, opts?.merge ? { ...(col.get(docId) ?? {}), ...data } : { ...data });
          },
          update: async (patch: DocData) => {
            col.set(docId, { ...(col.get(docId) ?? {}), ...patch });
          },
        };
      },
      where: (field: string, op: string, value: unknown) =>
        self.query([...col.entries()]).where(field, op, value),
      limit: (n: number) => self.query([...col.entries()]).limit(n),
      add: async (data: DocData) => {
        const id = `auto-${++self.autoN}`;
        col.set(id, { ...data });
        return { id };
      },
    };
  }
}

function db(fake: FakeDb): Firestore {
  return fake as unknown as Firestore;
}

const NOW_MS = 1_753_180_800_000; // 2026-07-22T00:00:00.000Z (arbitrary, fixed)
const CLIENTES = 'clientes';

// Real mod-11-valid documents: the create path round-trips clienteSchema's
// `validateCpfCnpj` refine, so a made-up number would throw instead of testing
// the cascade.
const CPF_A = '52998224725';
const CPF_A_PUNCTUATED = '529.982.247-25';
const CPF_B = '11144477735';
const TELEFONE_RAW = '11999998888';
const TELEFONE_NORMALIZED = '5511999998888';

function fields(overrides: Partial<ClienteResolveFields> = {}): ClienteResolveFields {
  return {
    tipo: TIPO_CLIENTE.pessoaFisica,
    nome: 'Ana Maria Souza',
    cpf_cnpj: CPF_A,
    idEstrangeiro: null,
    ie: null,
    telefone: null,
    email: null,
    ...overrides,
  };
}

/* ----------------------------- acceptance cases ---------------------------- */

describe('findOrCreateCliente — identity gate (#786)', () => {
  it('creates a new cliente when the telefone hit carries a DIFFERENT cpf_cnpj', async () => {
    // The headline case. Buyer B's phone matches cliente A, a different person.
    // Before #786 this merged and rewrote A's cpf_cnpj with B's.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', {
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      telefone: TELEFONE_NORMALIZED,
      ultimaModificacao: 1,
    });

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ nome: 'Beatriz Lima', cpf_cnpj: CPF_B, telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(result.created).toBe(true);
    expect(result.clienteId).not.toBe('cli-a');
    expect(result.matchedBy).toBeNull();
    expect(result.rejected).toEqual([
      {
        id: 'cli-a',
        matchedBy: 'telefone',
        candidateCpfCnpj: CPF_A,
        candidateIdEstrangeiro: null,
      },
    ]);

    // A is completely untouched — document, name and stamp.
    expect(fake.storedDoc(CLIENTES, 'cli-a')).toEqual({
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      telefone: TELEFONE_NORMALIZED,
      ultimaModificacao: 1,
    });
    expect(fake.storedDoc(CLIENTES, result.clienteId)).toMatchObject({
      nome: 'Beatriz Lima',
      cpf_cnpj: CPF_B,
      telefone: TELEFONE_NORMALIZED,
    });
  });

  it('matches a telefone hit whose cpf_cnpj is null, and fills the document in', async () => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', {
      nome: 'Ana',
      cpf_cnpj: null,
      telefone: TELEFONE_NORMALIZED,
      ultimaModificacao: 1,
    });

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ nome: 'Ana Maria Souza', cpf_cnpj: CPF_A, telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ clienteId: 'cli-a', created: false, matchedBy: 'telefone' });
    expect(result.rejected).toEqual([]);
    expect(fake.storedDoc(CLIENTES, 'cli-a')).toMatchObject({
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      ultimaModificacao: NOW_MS,
    });
  });

  it('compares normalized values on BOTH sides — punctuation alone never rejects', async () => {
    // The live asymmetry: the lookup normalized, the patch compared raw, so a
    // stored `529.982.247-25` vs an incoming `52998224725` patched over itself.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A_PUNCTUATED,
      telefone: TELEFONE_NORMALIZED,
      ultimaModificacao: 1,
    });

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ cpf_cnpj: CPF_A, telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ clienteId: 'cli-a', created: false });
    // No spurious re-canonicalization: nothing changed, so nothing was written.
    expect(fake.storedDoc(CLIENTES, 'cli-a')).toMatchObject({
      cpf_cnpj: CPF_A_PUNCTUATED,
      ultimaModificacao: 1,
    });
  });

  it('rejects an e-mail hit whose cpf_cnpj differs, exactly like telefone', async () => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', { nome: 'Ana', cpf_cnpj: CPF_A, email: 'casa@example.com' });

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ cpf_cnpj: CPF_B, email: 'casa@example.com' }),
      nowMs: NOW_MS,
    });

    expect(result.created).toBe(true);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({ id: 'cli-a', matchedBy: 'email' });
  });

  it('rejects on an idEstrangeiro contradiction even when the cpf_cnpj agrees', async () => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', {
      nome: 'Ana',
      cpf_cnpj: null,
      idEstrangeiro: 'ZZ-999999',
      telefone: TELEFONE_NORMALIZED,
    });

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ cpf_cnpj: null, idEstrangeiro: 'AB-123456', telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(result.created).toBe(true);
  });

  it('matches when both sides carry no document — the pre-billing_info case', async () => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', { nome: 'Ana', cpf_cnpj: null, telefone: TELEFONE_NORMALIZED });

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ nome: 'Ana', cpf_cnpj: null, telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ clienteId: 'cli-a', created: false });
  });
});

/* --------------------------------- paging ---------------------------------- */

describe('findOrCreateCliente — candidate paging', () => {
  it('skips a conflicting candidate and takes the next COMPATIBLE one', async () => {
    // `.limit(1)` used to mean "reject the first ⇒ give up".
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', { nome: 'Ana', cpf_cnpj: CPF_B, telefone: TELEFONE_NORMALIZED });
    fake.seed(CLIENTES, 'cli-b', { nome: 'Bia', cpf_cnpj: null, telefone: TELEFONE_NORMALIZED });

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ cpf_cnpj: CPF_A, telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ clienteId: 'cli-b', created: false, matchedBy: 'telefone' });
    expect(result.rejected).toHaveLength(1);
  });

  it('picks the same row regardless of the order the query yields', async () => {
    // No `orderBy` is issued (Enterprise would need a new composite index), so
    // the doc-id sort is what makes the pick deterministic within a page.
    const seed = (fake: FakeDb): void => {
      fake.seedMany(CLIENTES, [
        ['cli-a', { nome: 'Ana', cpf_cnpj: null, telefone: TELEFONE_NORMALIZED }],
        ['cli-b', { nome: 'Bia', cpf_cnpj: null, telefone: TELEFONE_NORMALIZED }],
      ]);
    };
    const forward = new FakeDb();
    seed(forward);
    const reversed = new FakeDb();
    seed(reversed);
    reversed.docOrder = 'reverse';

    const args = { fields: fields({ telefone: TELEFONE_RAW }), nowMs: NOW_MS };
    expect((await findOrCreateCliente(db(forward), args)).clienteId).toBe('cli-a');
    expect((await findOrCreateCliente(db(reversed), args)).clienteId).toBe('cli-a');
  });

  it('creates exactly one cliente when every candidate in the page conflicts', async () => {
    const fake = new FakeDb();
    fake.seedMany(
      CLIENTES,
      Array.from({ length: 15 }, (_, i) => [
        `cli-${String(i).padStart(2, '0')}`,
        { nome: `C${i}`, cpf_cnpj: CPF_B, telefone: TELEFONE_NORMALIZED },
      ]),
    );

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ cpf_cnpj: CPF_A, telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(result.created).toBe(true);
    expect(fake.docCount(CLIENTES)).toBe(16);
    // The limit is real: at most `candidateLimit` rows were ever examined.
    expect(result.rejected.length).toBeLessThanOrEqual(10);
    expect(fake.lastPageSize).toBeLessThanOrEqual(10);
  });

  it('honours an explicit candidateLimit', async () => {
    const fake = new FakeDb();
    fake.seedMany(CLIENTES, [
      ['cli-a', { nome: 'Ana', cpf_cnpj: CPF_B, telefone: TELEFONE_NORMALIZED }],
      ['cli-b', { nome: 'Bia', cpf_cnpj: null, telefone: TELEFONE_NORMALIZED }],
    ]);

    // Only one row fetched, and it conflicts → create rather than reach cli-b.
    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ cpf_cnpj: CPF_A, telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
      candidateLimit: 1,
    });

    expect(result.created).toBe(true);
  });
});

/* --------------------------- cascade order + stamps ------------------------ */

describe('findOrCreateCliente — cascade and stamps', () => {
  it('creates with both stamps and the canonical document form', async () => {
    const fake = new FakeDb();

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ cpf_cnpj: CPF_A_PUNCTUATED, telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ created: true, matchedBy: null });
    expect(fake.storedDoc(CLIENTES, result.clienteId)).toMatchObject({
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Ana Maria Souza',
      // Stored normalized — clienteSchema's `^[0-9A-Z]*$` rejects punctuation,
      // and the cpf_cnpj leg queries this exact form.
      cpf_cnpj: CPF_A,
      telefone: TELEFONE_NORMALIZED,
      timestamp: NOW_MS,
      ultimaModificacao: NOW_MS,
    });
  });

  it('dedups by cpf_cnpj first, reporting the leg that matched', async () => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', { nome: 'Ana Maria Souza', cpf_cnpj: CPF_A });

    const result = await findOrCreateCliente(db(fake), { fields: fields(), nowMs: NOW_MS });

    expect(result).toMatchObject({ clienteId: 'cli-a', created: false, matchedBy: 'cpf_cnpj' });
  });

  it('dedups by idEstrangeiro when there is no document', async () => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', { nome: 'Ana', cpf_cnpj: null, idEstrangeiro: 'AB-123456' });

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ cpf_cnpj: null, idEstrangeiro: 'AB-123456' }),
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ clienteId: 'cli-a', matchedBy: 'idEstrangeiro' });
  });

  it.each([
    ['the raw BR shape stored by the Flutter app', TELEFONE_RAW],
    ['the normalized shape this app writes', TELEFONE_NORMALIZED],
  ])('dedups by telefone against %s', async (_label, stored) => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', { nome: 'Ana', cpf_cnpj: null, telefone: stored });

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ cpf_cnpj: null, telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ clienteId: 'cli-a', matchedBy: 'telefone' });
  });

  it('dedups by e-mail case-insensitively', async () => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', { nome: 'Ana', cpf_cnpj: null, email: 'ana@example.com' });

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ cpf_cnpj: null, email: 'Ana@Example.com' }),
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ clienteId: 'cli-a', matchedBy: 'email' });
  });

  it('writes nothing at all when the hit needs no change', async () => {
    const fake = new FakeDb();
    const stored = {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      ultimaModificacao: 1,
    };
    fake.seed(CLIENTES, 'cli-a', stored);

    await findOrCreateCliente(db(fake), { fields: fields(), nowMs: NOW_MS });

    // `ultimaModificacao` untouched — an empty patch must not bump the stamp
    // that drives clienteMeta.defaultQuery's sort.
    expect(fake.storedDoc(CLIENTES, 'cli-a')).toEqual(stored);
  });

  it('patches only the fields that changed, preserving unrelated ones', async () => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Ana',
      cpf_cnpj: CPF_A,
      observacoesInternas: 'cliente antigo',
      ultimaModificacao: 1,
    });

    await findOrCreateCliente(db(fake), {
      fields: fields({ nome: 'Ana Maria Souza' }),
      nowMs: NOW_MS,
    });

    expect(fake.storedDoc(CLIENTES, 'cli-a')).toEqual({
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      observacoesInternas: 'cliente antigo',
      ultimaModificacao: NOW_MS,
    });
  });
});

/* ------------------------------ telefone hygiene --------------------------- */

describe('findOrCreateCliente — telefone hygiene', () => {
  it('drops a MASKED telefone on the CREATE path instead of throwing', async () => {
    // Before #786 the `*` skip existed only on the merge path: on create,
    // `normalizeTelefone` stripped the mask down to 6 digits, which failed
    // clienteSchema's refine and threw a ZodError that aborted the import.
    const fake = new FakeDb();

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ telefone: '11*****8888' }),
      nowMs: NOW_MS,
    });

    expect(result.created).toBe(true);
    expect(result.dropped).toEqual(['telefone']);
    expect(fake.storedDoc(CLIENTES, result.clienteId)).toMatchObject({ telefone: null });
  });

  it('drops an invalid telefone rather than storing an unwritable value', async () => {
    const fake = new FakeDb();

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ telefone: '123' }),
      nowMs: NOW_MS,
    });

    expect(result.dropped).toEqual(['telefone']);
    expect(fake.storedDoc(CLIENTES, result.clienteId)).toMatchObject({ telefone: null });
  });

  it('never rewrites a stored raw BR telefone to the 55… shape', async () => {
    // Re-canonicalizing stored data is a migration (tools/migrations), not a
    // side effect of an import that would bump ultimaModificacao for nothing.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      telefone: TELEFONE_RAW,
      ultimaModificacao: 1,
    });

    await findOrCreateCliente(db(fake), {
      fields: fields({ telefone: TELEFONE_NORMALIZED }),
      nowMs: NOW_MS,
    });

    expect(fake.storedDoc(CLIENTES, 'cli-a')).toMatchObject({
      telefone: TELEFONE_RAW,
      ultimaModificacao: 1,
    });
  });

  it('writes a genuinely different telefone', async () => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', { nome: 'Ana', cpf_cnpj: CPF_A, telefone: TELEFONE_RAW });

    await findOrCreateCliente(db(fake), {
      fields: fields({ telefone: '11777776666' }),
      nowMs: NOW_MS,
    });

    expect(fake.storedDoc(CLIENTES, 'cli-a')).toMatchObject({ telefone: '5511777776666' });
  });
});

/* ---------------------------- buildClienteUpdatePatch ---------------------- */

describe('buildClienteUpdatePatch', () => {
  const stored = {
    tipo: TIPO_CLIENTE.pessoaJuridica,
    nome: 'Ana Maria Souza',
    cpf_cnpj: CPF_A,
    idEstrangeiro: 'AB-123456',
    ie: 'ISENTO',
    telefone: TELEFONE_NORMALIZED,
    email: 'ana@example.com',
    userCliente: 'documents/usuarios/u-1',
  } as never;

  it('never overwrites a cpf_cnpj that is already on file', () => {
    // Reachable only by calling directly — findOrCreateCliente's gate rejects
    // such a candidate first. Pinned as the second line of defence.
    expect(buildClienteUpdatePatch(stored, fields({ cpf_cnpj: CPF_B }))).not.toHaveProperty(
      'cpf_cnpj',
    );
  });

  it('never overwrites an idEstrangeiro that is already on file', () => {
    expect(
      buildClienteUpdatePatch(stored, fields({ idEstrangeiro: 'ZZ-999999' })),
    ).not.toHaveProperty('idEstrangeiro');
  });

  it('does not wipe a stored tipo when the caller does not know one', () => {
    expect(buildClienteUpdatePatch(stored, fields({ tipo: null }))).not.toHaveProperty('tipo');
  });

  it('asserts a tipo the caller does know', () => {
    expect(
      buildClienteUpdatePatch(stored, fields({ tipo: TIPO_CLIENTE.pessoaFisica })),
    ).toMatchObject({ tipo: TIPO_CLIENTE.pessoaFisica });
  });

  it('refuses to let a lone-word name clobber the stored multi-word one', () => {
    expect(buildClienteUpdatePatch(stored, fields({ nome: 'Ana' }))).not.toHaveProperty('nome');
  });

  it('never touches userCliente — that field belongs to the chat link paths', () => {
    expect(buildClienteUpdatePatch(stored, fields())).not.toHaveProperty('userCliente');
  });

  it('is empty when nothing changed', () => {
    expect(
      buildClienteUpdatePatch(
        stored,
        fields({
          tipo: TIPO_CLIENTE.pessoaJuridica,
          idEstrangeiro: 'AB-123456',
          ie: 'ISENTO',
          telefone: TELEFONE_NORMALIZED,
          email: 'ana@example.com',
        }),
      ),
    ).toEqual({});
  });
});
