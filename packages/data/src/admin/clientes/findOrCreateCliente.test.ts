import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { TIPO_CLIENTE, type ClienteResolveFields } from '@delfrance/schemas';

import { buildClienteUpdatePatch, findOrCreateCliente } from './findOrCreateCliente';

/* ------------------------------ fake Firestore ---------------------------- */
// Copied from apps/mercado-livre/lib/marketplace/pedidos/orderCliente.test.ts, where
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
  /**
   * Queries issued. The collision guard (#1087) is only affordable because it
   * reuses the `idMercadoLivre` leg's own page instead of asking again, and a
   * "free" claim nothing counts is a claim that quietly stops being true.
   */
  queryCount = 0;
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
        self.queryCount += 1;
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
        candidateIdMercadoLivre: null,
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

  it('stores an EMPTY e-mail as null on create instead of throwing', async () => {
    // `clienteSchema.email` is `.email()`, which rejects '' — passing it
    // through would ZodError inside `add` and abort the whole import.
    const fake = new FakeDb();

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ email: '' }),
      nowMs: NOW_MS,
    });

    expect(result.created).toBe(true);
    expect(fake.storedDoc(CLIENTES, result.clienteId)).toMatchObject({ email: null });
  });

  it('never patches an EMPTY e-mail onto a matched cliente', async () => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      email: 'ana@example.com',
      ultimaModificacao: 1,
    });

    await findOrCreateCliente(db(fake), { fields: fields({ email: '   ' }), nowMs: NOW_MS });

    // Nothing changed ⇒ no write at all, and the stored e-mail survives.
    expect(fake.storedDoc(CLIENTES, 'cli-a')).toMatchObject({
      email: 'ana@example.com',
      ultimaModificacao: 1,
    });
  });

  it('stores a WHITESPACE-ONLY nome as null on create', async () => {
    const fake = new FakeDb();

    const result = await findOrCreateCliente(db(fake), {
      fields: fields({ nome: '   ' }),
      nowMs: NOW_MS,
    });

    expect(fake.storedDoc(CLIENTES, result.clienteId)).toMatchObject({ nome: null });
  });

  it('never patches a whitespace-only nome over a real one', async () => {
    // clienteSchema.nome accepts any string, so this wrote blanks rather than
    // failing loudly.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      ultimaModificacao: 1,
    });

    await findOrCreateCliente(db(fake), { fields: fields({ nome: '   ' }), nowMs: NOW_MS });

    expect(fake.storedDoc(CLIENTES, 'cli-a')).toMatchObject({
      nome: 'Ana Maria Souza',
      ultimaModificacao: 1,
    });
  });

  it('stores the collapsed nome, and does not rewrite when only padding differs', async () => {
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      ultimaModificacao: 1,
    });

    await findOrCreateCliente(db(fake), {
      fields: fields({ nome: '  Ana   Maria  Souza ' }),
      nowMs: NOW_MS,
    });

    expect(fake.storedDoc(CLIENTES, 'cli-a')).toMatchObject({
      nome: 'Ana Maria Souza',
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

/* ------------------------- Mercado Livre buyer key ------------------------- */

const ML_BUYER_A = '301110805';
const ML_BUYER_B = '987654321';

/**
 * The shape a PRE-SALE Mercado Livre question resolves to: an ML buyer id and a
 * nickname, and genuinely nothing else. No CPF, no phone, no e-mail — the asker
 * has not bought anything yet, so none of those exist.
 */
function perguntaFields(overrides: Partial<ClienteResolveFields> = {}): ClienteResolveFields {
  return {
    tipo: null,
    nome: 'comprador_ml',
    cpf_cnpj: null,
    idEstrangeiro: null,
    ie: null,
    telefone: null,
    email: null,
    idMercadoLivre: ML_BUYER_A,
    ...overrides,
  };
}

describe('findOrCreateCliente — Mercado Livre buyer id', () => {
  it('resolves a pre-sale question to the existing cliente instead of blind-creating', async () => {
    // The headline case, and the reason the field exists. Without an
    // idMercadoLivre leg every one of the four original legs is null, the
    // cascade falls through to `clienteCollection.add`, and each question
    // notification mints a fresh junk cliente.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-ml', {
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      idMercadoLivre: ML_BUYER_A,
    });

    const res = await findOrCreateCliente(db(fake), { fields: perguntaFields(), nowMs: NOW_MS });

    expect(res).toMatchObject({ clienteId: 'cli-ml', created: false, matchedBy: 'idMercadoLivre' });
    expect(fake.docCount(CLIENTES)).toBe(1);
  });

  it('two deliveries of the same question converge on ONE cliente', async () => {
    // At-least-once delivery is the contract from both ML and Cloud Tasks, so
    // the second run is not hypothetical. Before the leg existed this produced
    // two rows; the assertion that matters is the count.
    const fake = new FakeDb();

    const first = await findOrCreateCliente(db(fake), { fields: perguntaFields(), nowMs: NOW_MS });
    const second = await findOrCreateCliente(db(fake), { fields: perguntaFields(), nowMs: NOW_MS });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.clienteId).toBe(first.clienteId);
    expect(fake.docCount(CLIENTES)).toBe(1);
  });

  it('stores the id on the created cliente so the second delivery can find it', async () => {
    const fake = new FakeDb();

    const res = await findOrCreateCliente(db(fake), { fields: perguntaFields(), nowMs: NOW_MS });

    expect(fake.storedDoc(CLIENTES, res.clienteId)).toMatchObject({
      idMercadoLivre: ML_BUYER_A,
      nome: 'comprador_ml',
      // Nothing was invented for the fields a pre-sale asker does not have.
      cpf_cnpj: null,
      telefone: null,
      email: null,
    });
  });

  it('fills the id onto a cliente that was created from an order first', async () => {
    // The convergence direction that matters commercially: the buyer ordered
    // (so we have their CPF) and only later asked a question.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', { nome: 'Ana Maria Souza', cpf_cnpj: CPF_A });

    const res = await findOrCreateCliente(db(fake), {
      fields: fields({ idMercadoLivre: ML_BUYER_A }),
      nowMs: NOW_MS,
    });

    expect(res).toMatchObject({ clienteId: 'cli-a', created: false, matchedBy: 'cpf_cnpj' });
    expect(fake.storedDoc(CLIENTES, 'cli-a')).toMatchObject({ idMercadoLivre: ML_BUYER_A });
  });

  it('treats a DIFFERENT stored ML id as a different person', async () => {
    // Two ML accounts are two buyers. The phone leg would otherwise merge them
    // and attribute one buyer's questions to the other.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-other', {
      nome: 'Bruno Lima',
      telefone: TELEFONE_NORMALIZED,
      idMercadoLivre: ML_BUYER_B,
    });

    const res = await findOrCreateCliente(db(fake), {
      fields: perguntaFields({ telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(res.created).toBe(true);
    expect(res.clienteId).not.toBe('cli-other');
    expect(fake.storedDoc(CLIENTES, 'cli-other')).toMatchObject({ idMercadoLivre: ML_BUYER_B });
  });

  it('stores the id TRIMMED, so a padded value still round-trips the lookup', async () => {
    // The cascade leg queries `identityValue(...)`, which trims. Storing the
    // caller's value verbatim meant `' 301110805 '` was written raw and every
    // later lookup asked for `'301110805'` and missed — one junk cliente per
    // question notification, the exact failure this key exists to prevent,
    // reintroduced by whitespace.
    const fake = new FakeDb();

    const first = await findOrCreateCliente(db(fake), {
      fields: perguntaFields({ idMercadoLivre: `  ${ML_BUYER_A}  ` }),
      nowMs: NOW_MS,
    });
    expect(fake.storedDoc(CLIENTES, first.clienteId)).toMatchObject({
      idMercadoLivre: ML_BUYER_A,
    });

    // The delivery that follows carries the clean value and must find it.
    const second = await findOrCreateCliente(db(fake), { fields: perguntaFields(), nowMs: NOW_MS });
    expect(second.created).toBe(false);
    expect(second.clienteId).toBe(first.clienteId);
    expect(fake.docCount(CLIENTES)).toBe(1);
  });

  it('trims on the fill-in path too', () => {
    expect(
      buildClienteUpdatePatch({ cpf_cnpj: CPF_A } as never, {
        ...fields(),
        idMercadoLivre: `  ${ML_BUYER_A}  `,
      }),
    ).toMatchObject({ idMercadoLivre: ML_BUYER_A });
  });

  it('reports the ML id on a rejected candidate, so the log states the reason', async () => {
    // With only the two fiscal identifiers printed, a rejection caused by a
    // contradicting ML id logs as `{ candidateCpfCnpj: null,
    // candidateIdEstrangeiro: null }` — which reads as a bug in the gate rather
    // than the correct verdict it is. And for ML contacts this is the COMMON
    // rejection: they have an ML id and a name and nothing else.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-other', {
      nome: 'Bruno Lima',
      telefone: TELEFONE_NORMALIZED,
      idMercadoLivre: ML_BUYER_B,
    });

    const res = await findOrCreateCliente(db(fake), {
      fields: perguntaFields({ telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(res.rejected).toEqual([
      {
        id: 'cli-other',
        matchedBy: 'telefone',
        candidateCpfCnpj: null,
        candidateIdEstrangeiro: null,
        candidateIdMercadoLivre: ML_BUYER_B,
      },
    ]);
  });

  it('never overwrites a stored ML id (fill-only-when-absent)', () => {
    expect(
      buildClienteUpdatePatch({ idMercadoLivre: ML_BUYER_A } as never, {
        ...perguntaFields(),
        idMercadoLivre: ML_BUYER_A,
      }),
    ).not.toHaveProperty('idMercadoLivre');
  });

  it('leaves the cascade untouched for callers that never pass an ML id', async () => {
    // `idMercadoLivre` is optional on ClienteResolveFields precisely so the
    // WhatsApp and billing-info callers keep compiling AND keep behaving.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', { nome: 'Ana Maria Souza', cpf_cnpj: CPF_A });

    const res = await findOrCreateCliente(db(fake), { fields: fields(), nowMs: NOW_MS });

    expect(res).toMatchObject({ clienteId: 'cli-a', created: false, matchedBy: 'cpf_cnpj' });
    expect(fake.storedDoc(CLIENTES, 'cli-a')).not.toHaveProperty('idMercadoLivre');
  });
});

/* ------------------- ML order import: the id, and its cost ------------------ */

/**
 * #1087. The ML ORDER import supplied no `idMercadoLivre` until now, so its
 * third leg was always null and every order fell through to telefone/e-mail.
 * Live on 2026-09-01 that linked a real buyer to an e2e seed fixture over a
 * shared placeholder phone.
 *
 * Supplying the key is most of the fix. The rest is that stamping it is no
 * longer unconditionally safe: `buildClienteUpdatePatch` is pure, so it can only
 * ask whether THIS doc holds an id — never whether another doc already owns the
 * incoming one. Writing it anyway leaves two strong owners of one identity, and
 * the leg above would then return either of them.
 */
describe('findOrCreateCliente — ML order import (#1087)', () => {
  /** The shape an ML ORDER now resolves to: fiscal identity AND the buyer id. */
  function pedidoFields(overrides: Partial<ClienteResolveFields> = {}): ClienteResolveFields {
    return fields({ idMercadoLivre: ML_BUYER_A, ...overrides });
  }

  it('prefers the ML id over a compatible telefone hit — the staging shape', async () => {
    // Both candidates PASS `isSameCliente`: the fixture carries no strong key at
    // all, so it contradicts nothing and the #786 gate waves it through. Only
    // the cascade ORDER separates them, which is why supplying the key is the
    // whole fix — with `idMercadoLivre` absent the telefone leg wins and the
    // buyer lands on `ci-mqbdw6rn-cliente`.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-ml', { nome: 'comprador_ml', idMercadoLivre: ML_BUYER_A });
    fake.seed(CLIENTES, 'cli-fixture', { nome: 'APRO APRO', telefone: TELEFONE_NORMALIZED });

    const res = await findOrCreateCliente(db(fake), {
      fields: pedidoFields({ cpf_cnpj: null, telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(res).toMatchObject({ clienteId: 'cli-ml', matchedBy: 'idMercadoLivre', created: false });
    // The placeholder row is not touched, and does not acquire this buyer.
    expect(fake.storedDoc(CLIENTES, 'cli-fixture')).toEqual({
      nome: 'APRO APRO',
      telefone: TELEFONE_NORMALIZED,
    });
  });

  it('known-good: a buyer with no prior cliente still creates one, now carrying the id', async () => {
    const fake = new FakeDb();

    const res = await findOrCreateCliente(db(fake), { fields: pedidoFields(), nowMs: NOW_MS });

    expect(res).toMatchObject({ created: true, idMercadoLivreConflito: null });
    expect(fake.storedDoc(CLIENTES, res.clienteId)).toMatchObject({
      cpf_cnpj: CPF_A,
      idMercadoLivre: ML_BUYER_A,
    });
  });

  it('refuses to stamp an id another cliente owns, and drops ONLY that key', async () => {
    // Window A: `cpf_cnpj` matches first, so the ML leg never runs and nothing
    // has asked whether the id is free. It is not — a pre-sale question already
    // created `cli-ml` for this buyer.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-ml', { nome: 'comprador_ml', idMercadoLivre: ML_BUYER_A });
    fake.seed(CLIENTES, 'cli-pedido', { nome: 'Ana Maria Souza', cpf_cnpj: CPF_A });

    const res = await findOrCreateCliente(db(fake), {
      fields: pedidoFields({ telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(res).toMatchObject({
      clienteId: 'cli-pedido',
      matchedBy: 'cpf_cnpj',
      idMercadoLivreConflito: { outroCliente: 'cli-ml', carimboRecusado: true },
    });
    // Only the identity key was withheld — the unrelated enrichment still lands.
    expect(fake.storedDoc(CLIENTES, 'cli-pedido')).toMatchObject({
      telefone: TELEFONE_NORMALIZED,
      ultimaModificacao: NOW_MS,
    });
    expect(fake.storedDoc(CLIENTES, 'cli-pedido')).not.toHaveProperty('idMercadoLivre');
    // The other owner is byte-identical: no write, no stamp bump.
    expect(fake.storedDoc(CLIENTES, 'cli-ml')).toEqual({
      nome: 'comprador_ml',
      idMercadoLivre: ML_BUYER_A,
    });
  });

  it('writes NOTHING when the refused stamp was the only change', async () => {
    // The patch is emptied by the refusal, so the merge is skipped entirely —
    // `ultimaModificacao` must not move. On Enterprise a needless bump is
    // re-sorted, re-read and BILLED against two index-mandatory queries.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-ml', { nome: 'comprador_ml', idMercadoLivre: ML_BUYER_A });
    // Seeded already agreeing on every OTHER field — `tipo` included, or the
    // patch would carry that instead and the test would pass for the wrong
    // reason. The refused id has to be the only candidate write.
    const jaIgual = {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      ultimaModificacao: 1,
    };
    fake.seed(CLIENTES, 'cli-pedido', { ...jaIgual });

    const res = await findOrCreateCliente(db(fake), { fields: pedidoFields(), nowMs: NOW_MS });

    expect(res.idMercadoLivreConflito).toEqual({ outroCliente: 'cli-ml', carimboRecusado: true });
    expect(fake.storedDoc(CLIENTES, 'cli-pedido')).toEqual(jaIgual);
  });

  it('refuses on the CREATE path too, rather than minting a second owner', async () => {
    // The sharper half. The ML leg runs, finds the id's owner, and
    // `isSameCliente` rejects it because the documents contradict. Nothing else
    // matches, so a cliente IS created — the pedido needs one — but stamping the
    // id onto it would mint the second owner outright.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-outro', {
      nome: 'Bruno Lima',
      cpf_cnpj: CPF_B,
      idMercadoLivre: ML_BUYER_A,
    });

    const res = await findOrCreateCliente(db(fake), { fields: pedidoFields(), nowMs: NOW_MS });

    expect(res).toMatchObject({
      created: true,
      idMercadoLivreConflito: { outroCliente: 'cli-outro', carimboRecusado: true },
    });
    expect(fake.storedDoc(CLIENTES, res.clienteId)).toMatchObject({
      cpf_cnpj: CPF_A,
      idMercadoLivre: null,
    });
    expect(fake.storedDoc(CLIENTES, 'cli-outro')).toEqual({
      nome: 'Bruno Lima',
      cpf_cnpj: CPF_B,
      idMercadoLivre: ML_BUYER_A,
    });
  });

  it('costs no extra query when the ML leg already ran (window B)', async () => {
    // The leg is an `==` query on the exact value about to be stamped, so its
    // page IS the owner list. Three legs run — cpf_cnpj, idMercadoLivre,
    // telefone — and the guard adds none.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-outro', { cpf_cnpj: CPF_B, idMercadoLivre: ML_BUYER_A });
    fake.seed(CLIENTES, 'cli-fixture', { nome: 'APRO APRO', telefone: TELEFONE_NORMALIZED });

    const res = await findOrCreateCliente(db(fake), {
      fields: pedidoFields({ telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });

    expect(res).toMatchObject({
      clienteId: 'cli-fixture',
      idMercadoLivreConflito: { outroCliente: 'cli-outro', carimboRecusado: true },
    });
    expect(fake.queryCount).toBe(3);
    expect(fake.storedDoc(CLIENTES, 'cli-fixture')).not.toHaveProperty('idMercadoLivre');
  });

  it('pays exactly one extra query in window A, and none when there is no id', async () => {
    // Honest costing, both directions. With an id and a higher-leg match the
    // guard has to ask (2 = the cpf leg + the probe); with no id there is
    // nothing to stamp and nothing to check (1 = the cpf leg alone).
    const comId = new FakeDb();
    comId.seed(CLIENTES, 'cli-pedido', { nome: 'Ana Maria Souza', cpf_cnpj: CPF_A });
    await findOrCreateCliente(db(comId), { fields: pedidoFields(), nowMs: NOW_MS });
    expect(comId.queryCount).toBe(2);

    const semId = new FakeDb();
    semId.seed(CLIENTES, 'cli-pedido', { nome: 'Ana Maria Souza', cpf_cnpj: CPF_A });
    await findOrCreateCliente(db(semId), { fields: fields(), nowMs: NOW_MS });
    expect(semId.queryCount).toBe(1);
  });

  it('INTENDED: a cpf_cnpj hit with a contradicting ML id forks, rather than merging two accounts', async () => {
    // Supplying the id makes it a REJECTION key on the legs ABOVE it, which is
    // a behaviour change this PR introduces and a decision rather than a side
    // effect. One CPF ordering from two ML accounts (a replacement account, a
    // household login) now yields TWO clientes carrying that same cpf_cnpj.
    //
    // Kept, and this test is what makes it a decision: see the leg's comment.
    // The short version — the fork is self-consistent (each account resolves to
    // its own row deterministically, asserted below), both rows carry the SAME
    // correct cpf_cnpj so the NF-e is right against either, and the alternative
    // would put two marketplace accounts on one cliente, which is what
    // CLIENTE_STRONG_KEYS exists to prevent.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-conta-999', {
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      idMercadoLivre: ML_BUYER_B,
    });

    const res = await findOrCreateCliente(db(fake), { fields: pedidoFields(), nowMs: NOW_MS });

    expect(res.created).toBe(true);
    expect(res.clienteId).not.toBe('cli-conta-999');
    // The split is ANNOUNCED, not silent — `applyClienteStep` logs this.
    expect(res.rejected).toEqual([
      {
        id: 'cli-conta-999',
        matchedBy: 'cpf_cnpj',
        candidateCpfCnpj: CPF_A,
        candidateIdEstrangeiro: null,
        candidateIdMercadoLivre: ML_BUYER_B,
      },
    ]);
    // Two rows, one CPF. The original is untouched.
    expect(fake.storedDoc(CLIENTES, 'cli-conta-999')).toEqual({
      nome: 'Ana Maria Souza',
      cpf_cnpj: CPF_A,
      idMercadoLivre: ML_BUYER_B,
    });
    expect(fake.storedDoc(CLIENTES, res.clienteId)).toMatchObject({
      cpf_cnpj: CPF_A,
      idMercadoLivre: ML_BUYER_A,
    });

    // ⭐ The half that makes the fork tolerable: it does NOT compound. Each
    // account now resolves to its OWN row every time — the same gate that
    // caused the split is what disambiguates the duplicated CPF afterwards, so
    // no third row appears and neither account drifts onto the other's.
    const voltaA = await findOrCreateCliente(db(fake), {
      fields: pedidoFields(),
      nowMs: NOW_MS,
    });
    expect(voltaA).toMatchObject({ clienteId: res.clienteId, matchedBy: 'cpf_cnpj' });
    const voltaB = await findOrCreateCliente(db(fake), {
      fields: pedidoFields({ idMercadoLivre: ML_BUYER_B }),
      nowMs: NOW_MS,
    });
    expect(voltaB).toMatchObject({ clienteId: 'cli-conta-999', matchedBy: 'cpf_cnpj' });
    expect(fake.docCount(CLIENTES)).toBe(2);
  });

  it('surfaces an ML id ALREADY owned by two clientes, which nothing else reports', async () => {
    // Pre-existing corruption, not something this run could cause: the cascade
    // takes the first compatible row and the second owner is mentioned nowhere,
    // so every later delivery repeats the same silent pick. Free to notice —
    // the leg's page is already in hand — and `carimboRecusado: false` says
    // plainly that no write was declined, because there was none to make.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-a', { nome: 'Ana', idMercadoLivre: ML_BUYER_A });
    fake.seed(CLIENTES, 'cli-b', { nome: 'Ana de novo', idMercadoLivre: ML_BUYER_A });

    const res = await findOrCreateCliente(db(fake), {
      fields: perguntaFields(),
      nowMs: NOW_MS,
    });

    expect(res).toMatchObject({ clienteId: 'cli-a', matchedBy: 'idMercadoLivre', created: false });
    expect(res.idMercadoLivreConflito).toEqual({
      outroCliente: 'cli-b',
      carimboRecusado: false,
    });
    // Reported, never repaired — merging moves pedidos, conversas and endereços.
    expect(fake.docCount(CLIENTES)).toBe(2);
    expect(fake.storedDoc(CLIENTES, 'cli-b')).toEqual({
      nome: 'Ana de novo',
      idMercadoLivre: ML_BUYER_A,
    });
    // And it costs no extra query: one leg ran, and its own page is the answer.
    expect(fake.queryCount).toBe(1);
  });

  it('a placeholder-phone row stops absorbing buyers once it carries an ML id', async () => {
    // #786's gate is a CONTRADICTION test, not an evidence test: a candidate
    // with no strong key at all contradicts nothing and is accepted silently.
    // This change does not close that hole — but it narrows it, and the two
    // halves have to be shown together or the claim is just a comment.
    const fake = new FakeDb();
    fake.seed(CLIENTES, 'cli-fixture', { nome: 'APRO APRO', telefone: TELEFONE_NORMALIZED });

    // Known-good: with no strong key on file the row absorbs buyer A, exactly
    // as it absorbed the live buyer on 2026-09-01.
    const primeiro = await findOrCreateCliente(db(fake), {
      fields: perguntaFields({ telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });
    expect(primeiro).toMatchObject({ clienteId: 'cli-fixture', matchedBy: 'telefone' });
    expect(fake.storedDoc(CLIENTES, 'cli-fixture')).toMatchObject({
      idMercadoLivre: ML_BUYER_A,
    });

    // The narrowing: buyer B shares the placeholder phone and nothing else. The
    // stamp buyer A left behind is now the strong key that refuses them.
    const segundo = await findOrCreateCliente(db(fake), {
      fields: perguntaFields({ idMercadoLivre: ML_BUYER_B, telefone: TELEFONE_RAW }),
      nowMs: NOW_MS,
    });
    expect(segundo.created).toBe(true);
    expect(segundo.clienteId).not.toBe('cli-fixture');
    expect(segundo.rejected).toEqual([
      {
        id: 'cli-fixture',
        matchedBy: 'telefone',
        candidateCpfCnpj: null,
        candidateIdEstrangeiro: null,
        candidateIdMercadoLivre: ML_BUYER_A,
      },
    ]);
  });
});
