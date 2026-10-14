import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  OccEngine,
  type OccReadable,
  type OccTransaction,
  type OccWriteKind,
} from '@delfrance/data/testing';

import {
  buscarIntFreteDaConta,
  deveReconciliar,
  ehContaMercadoLivre,
  montarCamposIntFrete,
  mudouCampoSincronizado,
  planejarIntFreteDaConta,
  reconciliarIntFreteDaConta,
  refCanonicalDaConta,
} from './intFreteSync';

type DocData = Record<string, unknown>;
interface FakeRef {
  id: string;
  path: string;
  get(): Promise<{
    exists: boolean;
    id: string;
    data: () => DocData | undefined;
    readTime: { toMillis(): number };
  }>;
}
interface FakeQuery {
  path: string;
  get(): Promise<{ docs: Array<{ id: string; data: () => DocData }>; empty: boolean }>;
}

/**
 * Document OCC only: queries deliberately have NO range protection. Two first reconciles must
 * contend on their deterministic document read, rather than rely on this fake protecting a scan.
 * Snapshots are copied, writes are buffered, and all reads must precede writes.
 */
class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: 'get' | 'query' | OccWriteKind; path: string }> = [];
  readonly txReads: string[] = [];
  readonly committedWrites: Array<{ op: OccWriteKind; path: string }> = [];
  readonly occ: OccEngine;
  transacoes = 0;
  tentativas = 0;
  readTimeMs = READ_MS;
  beforeCommit?: () => Promise<void> | void;
  private autoN = 0;

  constructor() {
    this.occ = new OccEngine({
      applyWrite: (kind, docPath, data) => {
        const [colPath, id] = docPath.split('/');
        const stored = this.col(colPath!).get(id!);
        if (kind === 'create' && stored != null) throw new Error('ALREADY_EXISTS');
        if (kind === 'update' && stored == null) throw new Error('NOT_FOUND');
        this.col(colPath!).set(
          id!,
          structuredClone(kind === 'update' ? { ...stored, ...data } : data),
        );
        this.committedWrites.push({ op: kind, path: docPath });
      },
      logWrite: (op, docPath) => this.opLog.push({ op, path: docPath }),
    });
    this.occ.beforeCommit = () => {
      const hook = this.beforeCommit;
      this.beforeCommit = undefined;
      return hook?.();
    };
  }

  private col(colPath: string): Map<string, DocData> {
    let c = this.cols.get(colPath);
    if (!c) this.cols.set(colPath, (c = new Map()));
    return c;
  }
  seed(colPath: string, id: string, data: DocData): void {
    this.col(colPath).set(id, structuredClone(data));
  }
  docs(colPath: string): Map<string, DocData> {
    return this.col(colPath);
  }
  writes() {
    return this.committedWrites.filter((write) => write.path.startsWith('int_frete/'));
  }

  async escreverConta(data: DocData): Promise<void> {
    await this.occ.runTransaction(async (tx) => {
      tx.set(this.collection('integracao').doc(CONTA_ID), data);
    });
  }

  runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    this.transacoes += 1;
    return this.occ.runTransaction(async (tx) => {
      this.tentativas += 1;
      return fn({
        ...tx,
        get: async <TSnapshot>(target: OccReadable<TSnapshot>): Promise<TSnapshot> => {
          this.txReads.push(target.path === 'unprotected-query' ? 'query' : target.path);
          return tx.get(target);
        },
      });
    });
  }

  private query(colPath: string, clauses: Array<[string, unknown]>) {
    return {
      // Never written: query reads acquire no range conflict protection.
      path: 'unprotected-query',
      where: (field: string, _op: string, value: unknown): FakeQuery =>
        this.query(colPath, [...clauses, [field, value]]),
      get: async () => {
        this.opLog.push({ op: 'query', path: colPath });
        const rows = [...this.col(colPath).entries()].filter(([, d]) =>
          clauses.every(([f, v]) => d[f] === v),
        );
        return {
          docs: rows.map(([id, d]) => ({ id, data: () => structuredClone(d), exists: true })),
          empty: rows.length === 0,
        };
      },
    };
  }

  collection(colPath: string) {
    return {
      doc: (id?: string): FakeRef => {
        const docId = id ?? 'auto-' + String((this.autoN += 1));
        const docPath = colPath + '/' + docId;
        return {
          id: docId,
          path: docPath,
          get: async () => {
            this.opLog.push({ op: 'get', path: docPath });
            const data = this.col(colPath).get(docId);
            const readTime = this.readTimeMs;
            return {
              exists: data != null,
              id: docId,
              data: () => (data == null ? undefined : structuredClone(data)),
              readTime: { toMillis: () => readTime },
            };
          },
        };
      },
      where: (field: string, op: string, value: unknown) =>
        this.query(colPath, []).where(field, op, value),
    };
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */

const CONTA_ID = 'conta-A';
const CANONICO = `documents/integracao/${CONTA_ID}`;
const FILIAL = 'documents/filiais/fil-1';
const CADASTRO = Date.parse('2026-01-05T10:00:00.000Z');
const READ_MS = Date.parse('2026-08-04T12:00:00.000Z');

function conta(over: DocData = {}): DocData {
  return {
    tipo: 1,
    nome: 'Loja ML',
    ativo: true,
    filialIntegracaoPedidoOuterRef: FILIAL,
    dataCadastro: CADASTRO,
    ...over,
  };
}

function seedIntFrete(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed('int_frete', id, {
    tipo: 'mercadoLivre',
    nome: 'Loja ML',
    ativo: true,
    filialIntegracaoFreteOuterRef: FILIAL,
    contaMercadoLivreMercadoEnviosOuterRef: CANONICO,
    dataCadastro: CADASTRO,
    ...over,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/* ---------------------------------- gates --------------------------------- */

describe('gates', () => {
  it('recognizes only the Mercado Livre tipo (the int↔string enum bridge)', () => {
    expect(ehContaMercadoLivre({ tipo: 1 })).toBe(true);
    // 6 = whatsapp, 5 = shopee; the STRING 'mercadoLivre' is int_frete's tipo, not integracao's.
    expect(ehContaMercadoLivre({ tipo: 6 })).toBe(false);
    expect(ehContaMercadoLivre({ tipo: 'mercadoLivre' })).toBe(false);
    expect(ehContaMercadoLivre(null)).toBe(false);
    expect(ehContaMercadoLivre({})).toBe(false);
  });

  it('reports a change only for a mirrored field', () => {
    const antes = conta();
    expect(mudouCampoSincronizado(antes, conta({ nome: 'Outro' }))).toBe(true);
    expect(mudouCampoSincronizado(antes, conta({ ativo: false }))).toBe(true);
    expect(mudouCampoSincronizado(antes, conta({ filialIntegracaoPedidoOuterRef: 'x/y/z' }))).toBe(
      true,
    );
    expect(mudouCampoSincronizado(antes, conta({ dataCadastro: 1 }))).toBe(true);
    // The whole point: a token refresh / user_id stamp must NOT churn the freight doc.
    expect(mudouCampoSincronizado(antes, conta({ user_id: 999 }))).toBe(false);
    expect(mudouCampoSincronizado(antes, conta())).toBe(false);
  });
});

/* -------------------------------- mapping --------------------------------- */

describe('montarCamposIntFrete', () => {
  it('mirrors the legacy fromConta set, rebasing the filial ref', () => {
    const { campos, faltando } = montarCamposIntFrete(CONTA_ID, conta());
    expect(faltando).toEqual([]);
    expect(campos).toEqual({
      tipo: 'mercadoLivre',
      nome: 'Loja ML',
      ativo: true,
      filialIntegracaoFreteOuterRef: FILIAL,
      contaMercadoLivreMercadoEnviosOuterRef: CANONICO,
      dataCadastro: CADASTRO,
    });
  });

  it('normalizes a bare filial ref to the canonical documents/ form', () => {
    const { campos } = montarCamposIntFrete(
      CONTA_ID,
      conta({ filialIntegracaoPedidoOuterRef: 'filiais/fil-1' }),
    );
    expect(campos.filialIntegracaoFreteOuterRef).toBe(FILIAL);
  });

  it('defaults a missing `ativo` to true, mirroring the schema default', () => {
    const semAtivo = conta();
    delete semAtivo.ativo;
    expect(montarCamposIntFrete(CONTA_ID, semAtivo).campos.ativo).toBe(true);
  });

  it('reports non-nullable fields it cannot resolve instead of writing null', () => {
    const { campos, faltando } = montarCamposIntFrete(CONTA_ID, {
      tipo: 1,
      nome: '',
      filialIntegracaoPedidoOuterRef: null,
      dataCadastro: null,
    });
    expect(faltando).toEqual(['nome', 'filialIntegracaoPedidoOuterRef', 'dataCadastro']);
    expect(campos).not.toHaveProperty('nome');
    expect(campos).not.toHaveProperty('filialIntegracaoFreteOuterRef');
    expect(campos).not.toHaveProperty('dataCadastro');
  });

  it('normalizes dataCadastro BEFORE it is diffed (an ISO string would churn forever)', () => {
    const iso = montarCamposIntFrete(CONTA_ID, conta({ dataCadastro: '2026-01-05T10:00:00.000Z' }));
    expect(iso.campos.dataCadastro).toBe(CADASTRO);
    // µs values normalize to the same ms number, so the diff stays stable too.
    const micros = montarCamposIntFrete(CONTA_ID, conta({ dataCadastro: CADASTRO * 1000 }));
    expect(micros.campos.dataCadastro).toBe(CADASTRO);
  });
});

/* --------------------------------- lookup --------------------------------- */

describe('buscarIntFreteDaConta', () => {
  it('finds the doc by the canonical back-ref', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-1');
    await expect(buscarIntFreteDaConta(asDb(db), CONTA_ID)).resolves.toMatchObject({ id: 'if-1' });
  });

  it('sees an INACTIVE doc by default — filtering ativo here would duplicate on re-enable', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-1', { ativo: false });
    await expect(buscarIntFreteDaConta(asDb(db), CONTA_ID)).resolves.toMatchObject({ id: 'if-1' });
    await expect(
      buscarIntFreteDaConta(asDb(db), CONTA_ID, { apenasAtivo: true }),
    ).resolves.toBeNull();
  });

  it('falls back to the tolerant scan for a bare (non-canonical) back-ref, and warns', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-legacy', {
      contaMercadoLivreMercadoEnviosOuterRef: `integracao/${CONTA_ID}`,
    });
    await expect(buscarIntFreteDaConta(asDb(db), CONTA_ID)).resolves.toMatchObject({
      id: 'if-legacy',
    });
    expect(console.warn).toHaveBeenCalled();
  });

  it('picks the newest dataCadastro regardless of result order', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-old', { dataCadastro: 1000 });
    seedIntFrete(db, 'if-new', { dataCadastro: 2000 });
    await expect(buscarIntFreteDaConta(asDb(db), CONTA_ID)).resolves.toMatchObject({
      id: 'if-new',
    });
  });

  it('ignores another account`s freight doc', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-outra', {
      contaMercadoLivreMercadoEnviosOuterRef: 'documents/integracao/conta-B',
    });
    await expect(buscarIntFreteDaConta(asDb(db), CONTA_ID)).resolves.toBeNull();
  });
});

describe('deveReconciliar', () => {
  it('includes create, delete and both type transitions with identical mirrored fields', () => {
    expect(deveReconciliar(null, conta())).toBe(true);
    expect(deveReconciliar(conta(), null)).toBe(true);
    expect(deveReconciliar(conta(), conta({ tipo: 5 }))).toBe(true);
    expect(deveReconciliar(conta({ tipo: 5 }), conta())).toBe(true);
    expect(deveReconciliar(conta(), conta({ user_id: 999 }))).toBe(false);
    expect(deveReconciliar(conta({ tipo: 5 }), conta({ tipo: 6 }))).toBe(false);
  });
});

for (const ids of [['if-a', 'if-z'], ['if-z', 'if-a']]) {
  it('chooses the lower ID on an equal date in result order ' + ids.join(', '), async () => {
    const db = new FakeDb();
    for (const id of ids) seedIntFrete(db, id);
    expect(await buscarIntFreteDaConta(asDb(db), CONTA_ID)).toMatchObject({ id: 'if-a' });
  });
}

describe('reconciliarIntFreteDaConta', () => {
  it('creates the deterministic document with mirrored fields and readTime metadata', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta());
    const result = await reconciliarIntFreteDaConta(asDb(db), CONTA_ID);
    expect(result).toMatchObject({ action: 'criado', intFreteId: 'mercadoLivre-' + CONTA_ID });
    const created = db.docs('int_frete').get(result.intFreteId!)!;
    expect(created).toMatchObject({
      tipo: 'mercadoLivre',
      nome: 'Loja ML',
      ativo: true,
      filialIntegracaoFreteOuterRef: FILIAL,
      contaMercadoLivreMercadoEnviosOuterRef: CANONICO,
      dataCadastro: CADASTRO,
      ultimaModificacao: READ_MS,
      prazoExtra: 0,
      enderecoDeOrigem: null,
    });
    expect(CADASTRO).not.toBe(READ_MS);
    expect(db.transacoes).toBe(1);
    expect(db.txReads).toEqual([
      'integracao/' + CONTA_ID,
      'query',
      'query',
      'int_frete/mercadoLivre-' + CONTA_ID,
    ]);
  });

  it('skips an incomplete account rather than creating invalid required fields', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta({ filialIntegracaoPedidoOuterRef: null }));
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toEqual({
      action: 'incompleto',
      faltando: ['filialIntegracaoPedidoOuterRef'],
    });
    expect(db.docs('int_frete').size).toBe(0);
    expect(db.writes()).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });

  it('patches only differing account-authoritative fields and preserves freight configuration', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta({ nome: 'Loja ML 2' }));
    const config = {
      enderecoDeOrigem: { cep: '01001000' },
      horarioDeCorte: [{ diaDaSemana: 1 }],
      mapa: { personalizado: true },
      faixaCep: ['01000'],
      prazoExtra: 3,
      client_id: 'operator-client',
      client_secret: 'operator-secret',
    };
    seedIntFrete(db, 'if-legacy', { ...config, ultimaModificacao: READ_MS + 3_600_000 });
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toEqual({
      action: 'atualizado',
      intFreteId: 'if-legacy',
      campos: ['nome'],
    });
    expect(db.docs('int_frete').get('if-legacy')).toMatchObject({
      ...config,
      nome: 'Loja ML 2',
      dataCadastro: CADASTRO,
      ultimaModificacao: READ_MS,
    });
    expect(db.docs('int_frete').size).toBe(1);
    expect(db.transacoes).toBe(1);
  });

  it('writes nothing when mirrored fields already match and does not advance a watermark', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta());
    seedIntFrete(db, 'if-1', { ultimaModificacao: READ_MS - 1 });
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toEqual({
      action: 'inalterado',
      intFreteId: 'if-1',
    });
    expect(db.writes()).toHaveLength(0);
    expect(db.docs('int_frete').get('if-1')!.ultimaModificacao).toBe(READ_MS - 1);
  });

  it('a no-op followed by an older replay retains the current account fields (#1888/T55)', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta({ nome: 'Current account' }));
    seedIntFrete(db, 'if-1', { nome: 'Current account', ultimaModificacao: READ_MS - 5_000 });
    await reconciliarIntFreteDaConta(asDb(db), CONTA_ID);
    // There is no event body or event time in the API: the stale delivery passes the same ID.
    db.readTimeMs = READ_MS + 5_000;
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toEqual({
      action: 'inalterado',
      intFreteId: 'if-1',
    });
    expect(db.docs('int_frete').get('if-1')).toMatchObject({
      nome: 'Current account',
      ultimaModificacao: READ_MS - 5_000,
    });
    expect(db.writes()).toHaveLength(0);
  });

  it('reactivates the existing document and preserves its historical ID', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta());
    seedIntFrete(db, 'if-historical', { ativo: false });
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toEqual({
      action: 'atualizado',
      intFreteId: 'if-historical',
      campos: ['ativo'],
    });
    expect(db.docs('int_frete').size).toBe(1);
    expect(db.docs('int_frete').has('mercadoLivre-' + CONTA_ID)).toBe(false);
  });

  it('adopts and normalizes a bare back-reference in place', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta());
    seedIntFrete(db, 'if-legacy', { contaMercadoLivreMercadoEnviosOuterRef: 'integracao/' + CONTA_ID });
    const result = await reconciliarIntFreteDaConta(asDb(db), CONTA_ID);
    expect(result).toEqual({
      action: 'atualizado',
      intFreteId: 'if-legacy',
      campos: ['contaMercadoLivreMercadoEnviosOuterRef'],
    });
    expect(db.docs('int_frete').get('if-legacy')!.contaMercadoLivreMercadoEnviosOuterRef).toBe(CANONICO);
    expect(db.docs('int_frete').size).toBe(1);
  });

  it('recovers the deterministic path when its back-reference was edited', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta());
    const id = 'mercadoLivre-' + CONTA_ID;
    seedIntFrete(db, id, { contaMercadoLivreMercadoEnviosOuterRef: 'documents/integracao/other' });
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toMatchObject({
      action: 'atualizado',
      intFreteId: id,
    });
    expect(db.docs('int_frete').get(id)!.contaMercadoLivreMercadoEnviosOuterRef).toBe(CANONICO);
    expect(db.docs('int_frete').size).toBe(1);
  });

  it('retains unresolvable existing registration data without repeat churn', async () => {
    const db = new FakeDb();
    const semData = conta();
    delete semData.dataCadastro;
    db.seed('integracao', CONTA_ID, semData);
    seedIntFrete(db, 'if-1');
    expect((await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).action).toBe('inalterado');
    db.readTimeMs += 5_000;
    expect((await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).action).toBe('inalterado');
    expect(db.writes()).toHaveLength(0);
    expect(db.docs('int_frete').get('if-1')!.dataCadastro).toBe(CADASTRO);
  });

  it('deactivates a deleted account while preserving the document and operator settings', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-1', {
      enderecoDeOrigem: { cep: '01001000' },
      ultimaModificacao: READ_MS + 1,
    });
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toEqual({
      action: 'desativado',
      intFreteId: 'if-1',
      campos: ['ativo'],
    });
    expect(db.docs('int_frete').get('if-1')).toMatchObject({
      ativo: false,
      dataCadastro: CADASTRO,
      ultimaModificacao: READ_MS,
      enderecoDeOrigem: { cep: '01001000' },
    });
    expect(db.docs('int_frete').size).toBe(1);
    expect(db.transacoes).toBe(1);
    expect((await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).action).toBe('inalterado');
    expect(db.writes()).toHaveLength(1);
  });

  it('a replayed delete reconciles a conta recreated under another type (#1888/T20)', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta({ tipo: 5 }));
    seedIntFrete(db, 'if-1');
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toMatchObject({
      action: 'desativado',
    });
    expect(db.docs('int_frete').get('if-1')!.ativo).toBe(false);
  });

  it('a replayed delete preserves the current recreated ML conta and restores its freight state', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta({ nome: 'Recreated store' }));
    seedIntFrete(db, 'if-1', { ativo: false });
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toMatchObject({
      action: 'atualizado',
    });
    expect(db.docs('int_frete').get('if-1')).toMatchObject({
      ativo: true,
      nome: 'Recreated store',
    });
    expect((await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).action).toBe('inalterado');
  });

  it('type changes away and back reconcile even with identical mirrored fields', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-1');
    db.seed('integracao', CONTA_ID, conta({ tipo: 5 }));
    expect((await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).action).toBe('desativado');
    db.seed('integracao', CONTA_ID, conta());
    expect((await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).action).toBe('atualizado');
    expect(db.docs('int_frete').get('if-1')!.ativo).toBe(true);
  });

  it('reports no freight document for an absent or unrelated account without creating one', async () => {
    const db = new FakeDb();
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toEqual({
      action: 'nao-encontrado',
    });
    db.seed('integracao', CONTA_ID, conta({ tipo: 5 }));
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toEqual({
      action: 'nao-encontrado',
    });
    expect(db.writes()).toHaveLength(0);
  });

  it('re-derives the plan on transaction retry after an intervening account edit', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta({ nome: 'Read first' }));
    seedIntFrete(db, 'if-1');
    db.beforeCommit = () => db.escreverConta(conta({ nome: 'Concurrent winner' }));
    expect(await reconciliarIntFreteDaConta(asDb(db), CONTA_ID)).toMatchObject({
      action: 'atualizado',
    });
    expect(db.tentativas).toBe(2);
    expect(db.writes()).toHaveLength(1);
    expect(db.docs('int_frete').get('if-1')!.nome).toBe('Concurrent winner');
  });

  it('two first reconciles create one document without query-range protection', async () => {
    const db = new FakeDb();
    db.seed('integracao', CONTA_ID, conta());
    const results = await Promise.all([
      reconciliarIntFreteDaConta(asDb(db), CONTA_ID),
      reconciliarIntFreteDaConta(asDb(db), CONTA_ID),
    ]);
    expect(results.map((result) => result.action).sort()).toEqual(['criado', 'inalterado']);
    expect([...db.docs('int_frete').keys()]).toEqual(['mercadoLivre-' + CONTA_ID]);
    expect(db.tentativas).toBe(3);
    expect(db.writes()).toHaveLength(1);
  });
});

describe('pure planner and canonical reference', () => {
  it('plans the same deterministic creation without Firestore', () => {
    expect(planejarIntFreteDaConta(CONTA_ID, conta(), null)).toMatchObject({
      acao: 'criar',
      id: 'mercadoLivre-' + CONTA_ID,
    });
    expect(refCanonicalDaConta(CONTA_ID)).toBe(CANONICO);
  });
});
