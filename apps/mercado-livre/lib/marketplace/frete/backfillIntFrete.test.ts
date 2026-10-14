import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { INTEGRACAO_TIPO, INTEGRACAO_FRETE } from '@delfrance/schemas';

import { backfillIntFrete, preverIntFreteDaConta, type ContaEnumerada } from './backfillIntFrete';

type DocData = Record<string, unknown>;
interface FakeRef {
  id: string;
  path: string;
  get(): Promise<FakeSnapshot>;
}
interface FakeSnapshot {
  id: string;
  exists: boolean;
  data(): DocData | undefined;
  readTime: { toMillis(): number };
}
interface FakeQuery {
  where(field: string, op: string, value: unknown): FakeQuery;
  orderBy(field: string): FakeQuery;
  limit(n: number): FakeQuery;
  startAfter(doc: FakeSnapshot): FakeQuery;
  get(): Promise<{ docs: FakeSnapshot[]; empty: boolean; size: number }>;
}

/** Sequential Firestore adapter: preview cannot write, and apply uses the real shared reconciler. */
class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly writes: string[] = [];
  readonly queries: Array<{ clauses: Array<[string, unknown]>; order?: string }> = [];
  readonly readTimeMs = 1_780_000_000_000;

  private col(path: string): Map<string, DocData> {
    let col = this.cols.get(path);
    if (col == null) this.cols.set(path, (col = new Map()));
    return col;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, { ...data });
  }
  stored(path: string, id: string): DocData | undefined {
    return this.col(path).get(id);
  }
  remove(path: string, id: string): void {
    this.col(path).delete(id);
  }
  private snapshot(path: string, id: string): FakeSnapshot {
    const data = this.col(path).get(id);
    return {
      id,
      exists: data != null,
      data: () => (data == null ? undefined : { ...data }),
      readTime: { toMillis: () => this.readTimeMs },
    };
  }
  private query(
    path: string,
    clauses: Array<[string, unknown]> = [],
    order?: string,
    limit = Infinity,
    cursor?: FakeSnapshot,
  ): FakeQuery {
    return {
      where: (field: string, _op: string, value: unknown) =>
        this.query(path, [...clauses, [field, value]], order, limit, cursor),
      orderBy: (field: string) => this.query(path, clauses, field, limit, cursor),
      limit: (n: number) => this.query(path, clauses, order, n, cursor),
      startAfter: (doc: FakeSnapshot) => this.query(path, clauses, order, limit, doc),
      get: async () => {
        this.queries.push({ clauses, order });
        let rows = [...this.col(path).entries()].filter(([, data]) =>
          clauses.every(([field, value]) => data[field] === value),
        );
        if (order != null) {
          rows.sort(([idA, a], [idB, b]) => {
            const valueA = String(a[order]);
            const valueB = String(b[order]);
            return valueA < valueB ? -1 : valueA > valueB ? 1 : idA.localeCompare(idB);
          });
        }
        if (cursor != null) rows = rows.slice(rows.findIndex(([id]) => id === cursor.id) + 1);
        const docs = rows.slice(0, limit).map(([id]) => this.snapshot(path, id));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    };
  }
  collection(path: string) {
    return {
      ...this.query(path),
      doc: (id: string): FakeRef => ({
        id,
        path: path + '/' + id,
        get: async () => this.snapshot(path, id),
      }),
    };
  }
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const write = (ref: FakeRef, data: DocData, create: boolean) => {
      const [path, id] = ref.path.split('/');
      const stored = this.stored(path!, id!);
      if (create && stored != null) throw new Error('ALREADY_EXISTS');
      if (!create && stored == null) throw new Error('NOT_FOUND');
      this.seed(path!, id!, create ? data : { ...stored, ...data });
      this.writes.push(ref.path);
    };
    return fn({
      get: (ref: FakeRef | FakeQuery) => ref.get(),
      create: (ref: FakeRef, data: DocData) => write(ref, data, true),
      update: (ref: FakeRef, data: DocData) => write(ref, data, false),
    });
  }
}

const CONTA_ID = 'conta-A';
const CANONICO = 'documents/integracao/' + CONTA_ID;
const FILIAL = 'documents/filiais/fil-1';
const CADASTRO = 1_760_000_000_000;
const asDb = (db: FakeDb) => db as unknown as Firestore;

function conta(over: DocData = {}): DocData {
  return {
    tipo: INTEGRACAO_TIPO.mercadoLivre,
    nome: 'Current account',
    ativo: true,
    filialIntegracaoPedidoOuterRef: FILIAL,
    dataCadastro: CADASTRO,
    ...over,
  };
}
function frete(over: DocData = {}): DocData {
  return {
    tipo: INTEGRACAO_FRETE.mercadoLivre,
    nome: 'Current account',
    ativo: true,
    filialIntegracaoFreteOuterRef: FILIAL,
    contaMercadoLivreMercadoEnviosOuterRef: CANONICO,
    dataCadastro: CADASTRO,
    ultimaModificacao: 1_790_000_000_000,
    horarioDeCorte: 15,
    prazoExtra: 4,
    mapa: { manual: true },
    ...over,
  };
}
async function* pages(...docs: Array<readonly ContaEnumerada[]>) {
  for (const page of docs) yield page;
}

describe('Mercado Livre freight backfill — current account state (#1888)', () => {
  it('preview and apply agree on stable data; a second apply writes nothing', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta());
    db.seed('int_frete', 'legacy-id', frete({ nome: 'Old account' }));
    const result = await backfillIntFrete(asDb(db), { apply: false }, pages([{ id: CONTA_ID }]));
    expect(result).toEqual({ contas: 1, totals: { atualizado: 1 } });
    expect(db.writes).toEqual([]);

    const applied = await backfillIntFrete(asDb(db), { apply: true }, pages([{ id: CONTA_ID }]));
    expect(applied).toEqual(result);
    expect(db.stored('int_frete', 'legacy-id')).toMatchObject({
      nome: 'Current account',
      horarioDeCorte: 15,
      prazoExtra: 4,
      mapa: { manual: true },
      ultimaModificacao: db.readTimeMs,
    });
    const unchanged = await backfillIntFrete(asDb(db), { apply: true }, pages([{ id: CONTA_ID }]));
    expect(unchanged).toEqual({ contas: 1, totals: { inalterado: 1 } });
    expect(db.writes).toEqual(['int_frete/legacy-id']);
  });

  it('deduplicates IDs across pages and never uses captured account fields', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta());
    const stale = { id: CONTA_ID, nome: 'Stale page account', ativo: false };
    const onConta: string[] = [];
    const result = await backfillIntFrete(
      asDb(db),
      { apply: true, onConta: (id) => onConta.push(id) },
      pages([stale], [stale]),
    );
    expect(result).toEqual({ contas: 1, totals: { criado: 1 } });
    expect(onConta).toEqual([CONTA_ID]);
    expect(db.writes).toEqual(['int_frete/mercadoLivre-' + CONTA_ID]);
    expect(db.stored('int_frete', 'mercadoLivre-' + CONTA_ID)).toMatchObject({
      nome: 'Current account',
      ativo: true,
      ultimaModificacao: db.readTimeMs,
    });
  });

  it('preview checks the deterministic path on a lookup miss and apply repairs that same record', async () => {
    const db = new FakeDb();
    const id = 'mercadoLivre-' + CONTA_ID;
    db.seed('integracao', CONTA_ID, conta());
    db.seed('int_frete', id, frete({ contaMercadoLivreMercadoEnviosOuterRef: null }));
    const preview = await preverIntFreteDaConta(asDb(db), CONTA_ID);
    expect(preview).toEqual({
      action: 'atualizado',
      intFreteId: id,
      campos: ['contaMercadoLivreMercadoEnviosOuterRef'],
    });
    expect(db.writes).toEqual([]);
    expect(await backfillIntFrete(asDb(db), { apply: true }, pages([{ id: CONTA_ID }]))).toEqual({
      contas: 1,
      totals: { atualizado: 1 },
    });
    expect(db.writes).toEqual(['int_frete/' + id]);
    expect(db.stored('int_frete', id)).toMatchObject({
      contaMercadoLivreMercadoEnviosOuterRef: CANONICO,
      prazoExtra: 4,
    });
  });

  it('preview adopts a bare-reference inactive legacy record before considering a new ID', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta());
    db.seed(
      'int_frete',
      'legacy-id',
      frete({
        ativo: false,
        contaMercadoLivreMercadoEnviosOuterRef: 'integracao/' + CONTA_ID,
      }),
    );
    expect(await preverIntFreteDaConta(asDb(db), CONTA_ID)).toEqual({
      action: 'atualizado',
      intFreteId: 'legacy-id',
      campos: ['ativo', 'contaMercadoLivreMercadoEnviosOuterRef'],
    });
    expect(db.writes).toEqual([]);
  });

  it.each(['deleted', 'retyped'] as const)(
    'uses fresh state when an enumerated account is %s before reconciliation',
    async (change) => {
      const db = new FakeDb();
      db.seed('integracao', CONTA_ID, conta());
      db.seed('int_frete', 'legacy-id', frete());
      async function* changedPages() {
        if (change === 'deleted') db.remove('integracao', CONTA_ID);
        else db.seed('integracao', CONTA_ID, conta({ tipo: INTEGRACAO_TIPO.shopee }));
        yield [{ id: CONTA_ID }];
      }
      expect(await backfillIntFrete(asDb(db), { apply: false }, changedPages())).toEqual({
        contas: 1,
        totals: { desativado: 1 },
      });
      expect(db.writes).toEqual([]);
      expect(await backfillIntFrete(asDb(db), { apply: true }, changedPages())).toEqual({
        contas: 1,
        totals: { desativado: 1 },
      });
      expect(db.stored('int_frete', 'legacy-id')).toMatchObject({
        ativo: false,
        prazoExtra: 4,
        mapa: { manual: true },
      });
    },
  );

  it('reports missing data without creating a record in preview or apply', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta({ filialIntegracaoPedidoOuterRef: null }));
    expect(await preverIntFreteDaConta(asDb(db), CONTA_ID)).toEqual({
      action: 'incompleto',
      faltando: ['filialIntegracaoPedidoOuterRef'],
    });
    expect(await backfillIntFrete(asDb(db), { apply: true }, pages([{ id: CONTA_ID }]))).toEqual({
      contas: 1,
      totals: { incompleto: 1 },
    });
    expect(db.writes).toEqual([]);
  });

  it('keeps the indexed tipo + nome pagination over multiple pages', async () => {
    const db = new FakeDb();
    for (let i = 0; i < 201; i += 1) {
      db.seed('integracao', 'account-' + i, conta({ nome: String(i).padStart(3, '0') }));
    }
    db.seed('integracao', 'other-channel', conta({ tipo: INTEGRACAO_TIPO.shopee }));
    expect(await backfillIntFrete(asDb(db), { apply: true })).toEqual({
      contas: 201,
      totals: { criado: 201 },
    });
    const enumerations = db.queries.filter((q) => q.order != null);
    expect(enumerations).toEqual([
      { clauses: [['tipo', INTEGRACAO_TIPO.mercadoLivre]], order: 'nome' },
      { clauses: [['tipo', INTEGRACAO_TIPO.mercadoLivre]], order: 'nome' },
    ]);
    expect(db.writes).toHaveLength(201);
    expect(db.stored('int_frete', 'mercadoLivre-other-channel')).toBeUndefined();
  });
});
