import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import {
  buscarIntFreteDaConta,
  contaRealmenteExcluida,
  desativarIntFreteDaConta,
  ehContaMercadoLivre,
  montarCamposIntFrete,
  mudouCampoSincronizado,
  refCanonicalDaConta,
  sincronizarIntFreteDaConta,
} from './intFreteSync';

/* ------------------------------ fake Firestore ---------------------------- */
// Own copy (the sibling order tests keep theirs — not shared). Scoped to what
// `intFreteSync.ts` touches: `int_frete` (chained `where` equality + `add` +
// merge-`set`) and `integracao` (a single doc `get` for the delete guard).
// `opLog` is real so the zero-write assertions below mean something.

type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: 'get' | 'query' | 'add' | 'set'; path: string }> = [];
  private autoN = 0;

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
  writes(): Array<{ op: string; path: string }> {
    return this.opLog.filter((o) => o.op === 'add' || o.op === 'set');
  }

  private query(path: string, clauses: Array<[string, unknown]>) {
    const self = this;
    const q = {
      where(field: string, _op: string, value: unknown) {
        return self.query(path, [...clauses, [field, value]]);
      },
      async get() {
        self.opLog.push({ op: 'query', path });
        const rows = [...self.col(path).entries()].filter(([, d]) =>
          clauses.every(([f, v]) => d[f] === v),
        );
        return {
          docs: rows.map(([id, d]) => ({ id, data: () => d, exists: true })),
          empty: rows.length === 0,
        };
      },
    };
    return q;
  }

  collection(path: string) {
    const self = this;
    return {
      doc: (id?: string) => {
        const docId = id ?? `auto-${(self.autoN += 1)}`;
        return {
          id: docId,
          get: async () => {
            self.opLog.push({ op: 'get', path: `${path}/${docId}` });
            const col = self.col(path);
            return { exists: col.has(docId), id: docId, data: () => col.get(docId) };
          },
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            self.opLog.push({ op: 'set', path: `${path}/${docId}` });
            const col = self.col(path);
            col.set(docId, opts?.merge ? { ...(col.get(docId) ?? {}), ...data } : data);
          },
        };
      },
      add: async (data: DocData) => {
        const docId = `auto-${(self.autoN += 1)}`;
        self.opLog.push({ op: 'add', path: `${path}/${docId}` });
        self.col(path).set(docId, data);
        return { id: docId };
      },
      where: (field: string, op: string, value: unknown) =>
        self.query(path, []).where(field, op, value),
    };
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */

const CONTA_ID = 'conta-A';
const CANONICO = `documents/integracao/${CONTA_ID}`;
const FILIAL = 'documents/filiais/fil-1';
const CADASTRO = Date.parse('2026-01-05T10:00:00.000Z');
const EVENT_MS = Date.parse('2026-08-04T12:00:00.000Z');

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

  it('picks the newest dataCadastro (the legacy orderBy desc + first tie-break)', async () => {
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

/* ---------------------------------- sync ---------------------------------- */

describe('sincronizarIntFreteDaConta', () => {
  it('creates the doc with the mirrored fields when none exists', async () => {
    const db = new FakeDb();
    const disposicao = await sincronizarIntFreteDaConta(asDb(db), CONTA_ID, conta(), EVENT_MS);
    expect(disposicao.action).toBe('criado');
    const criado = db.docs('int_frete').get(disposicao.intFreteId!)!;
    expect(criado).toMatchObject({
      tipo: 'mercadoLivre',
      nome: 'Loja ML',
      ativo: true,
      filialIntegracaoFreteOuterRef: FILIAL,
      contaMercadoLivreMercadoEnviosOuterRef: CANONICO,
      dataCadastro: CADASTRO,
      ultimaModificacao: EVENT_MS,
    });
    // Schema defaults fill the rest — the doc must be readable by the Flutter app.
    expect(criado.prazoExtra).toBe(0);
    expect(criado.enderecoDeOrigem).toBeNull();
  });

  it('mirrors dataCadastro from the conta, NOT the event time', async () => {
    const db = new FakeDb();
    const disposicao = await sincronizarIntFreteDaConta(asDb(db), CONTA_ID, conta(), EVENT_MS);
    expect(db.docs('int_frete').get(disposicao.intFreteId!)!.dataCadastro).toBe(CADASTRO);
    expect(CADASTRO).not.toBe(EVENT_MS);
  });

  it('skips creation when a non-nullable field is unresolvable, and warns', async () => {
    const db = new FakeDb();
    const disposicao = await sincronizarIntFreteDaConta(
      asDb(db),
      CONTA_ID,
      conta({ filialIntegracaoPedidoOuterRef: null }),
      EVENT_MS,
    );
    expect(disposicao).toEqual({
      action: 'incompleto',
      faltando: ['filialIntegracaoPedidoOuterRef'],
    });
    expect(db.docs('int_frete').size).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });

  it('patches ONLY the fields that differ, and stamps ultimaModificacao', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-1', {
      enderecoDeOrigem: { cep: '01001000' },
      horarioDeCorte: [{ diaDaSemana: 1 }],
    });
    const disposicao = await sincronizarIntFreteDaConta(
      asDb(db),
      CONTA_ID,
      conta({ nome: 'Loja ML 2' }),
      EVENT_MS,
    );
    expect(disposicao).toEqual({ action: 'atualizado', intFreteId: 'if-1', campos: ['nome'] });
    const doc = db.docs('int_frete').get('if-1')!;
    expect(doc.nome).toBe('Loja ML 2');
    expect(doc.ultimaModificacao).toBe(EVENT_MS);
    // Legacy null-preserving `update()` parity: operator-authored config survives.
    expect(doc.enderecoDeOrigem).toEqual({ cep: '01001000' });
    expect(doc.horarioDeCorte).toEqual([{ diaDaSemana: 1 }]);
    // dataCadastro is a creation date — an unrelated edit must not move it.
    expect(doc.dataCadastro).toBe(CADASTRO);
  });

  it('writes NOTHING when everything already matches (replay-safe)', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-1');
    const disposicao = await sincronizarIntFreteDaConta(asDb(db), CONTA_ID, conta(), EVENT_MS);
    expect(disposicao).toEqual({ action: 'inalterado', intFreteId: 'if-1' });
    expect(db.writes()).toHaveLength(0);
  });

  it('re-activates the existing doc instead of creating a duplicate', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-1', { ativo: false });
    const disposicao = await sincronizarIntFreteDaConta(asDb(db), CONTA_ID, conta(), EVENT_MS);
    expect(disposicao).toEqual({ action: 'atualizado', intFreteId: 'if-1', campos: ['ativo'] });
    expect(db.docs('int_frete').size).toBe(1);
    expect(db.docs('int_frete').get('if-1')!.ativo).toBe(true);
  });

  it('normalizes a bare back-ref in place on the next pass', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-legacy', {
      contaMercadoLivreMercadoEnviosOuterRef: `integracao/${CONTA_ID}`,
    });
    const disposicao = await sincronizarIntFreteDaConta(asDb(db), CONTA_ID, conta(), EVENT_MS);
    expect(disposicao.campos).toEqual(['contaMercadoLivreMercadoEnviosOuterRef']);
    expect(db.docs('int_frete').get('if-legacy')!.contaMercadoLivreMercadoEnviosOuterRef).toBe(
      CANONICO,
    );
  });

  it('never writes dataCadastro for a conta that has none (no churn on repeat runs)', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-1');
    const semData = conta();
    delete semData.dataCadastro;
    const primeira = await sincronizarIntFreteDaConta(asDb(db), CONTA_ID, semData, EVENT_MS);
    const segunda = await sincronizarIntFreteDaConta(asDb(db), CONTA_ID, semData, EVENT_MS + 5000);
    expect(primeira.action).toBe('inalterado');
    expect(segunda.action).toBe('inalterado');
    expect(db.writes()).toHaveLength(0);
    expect(db.docs('int_frete').get('if-1')!.dataCadastro).toBe(CADASTRO);
  });
});

/* ------------------------------- deactivate ------------------------------- */

describe('desativarIntFreteDaConta', () => {
  it('flips ativo false without touching dataCadastro, and never deletes', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-1');
    const disposicao = await desativarIntFreteDaConta(asDb(db), CONTA_ID, EVENT_MS);
    expect(disposicao).toEqual({ action: 'desativado', intFreteId: 'if-1', campos: ['ativo'] });
    const doc = db.docs('int_frete').get('if-1')!;
    expect(doc.ativo).toBe(false);
    expect(doc.dataCadastro).toBe(CADASTRO);
    expect(doc.ultimaModificacao).toBe(EVENT_MS);
    // Pedidos hold integracaoFreteOuterRef pointing here — the doc must survive.
    expect(db.docs('int_frete').size).toBe(1);
  });

  it('is idempotent on an already-inactive doc', async () => {
    const db = new FakeDb();
    seedIntFrete(db, 'if-1', { ativo: false });
    const disposicao = await desativarIntFreteDaConta(asDb(db), CONTA_ID, EVENT_MS);
    expect(disposicao).toEqual({ action: 'inalterado', intFreteId: 'if-1' });
    expect(db.writes()).toHaveLength(0);
  });

  it('reports nao-encontrado when the account has no freight doc', async () => {
    const db = new FakeDb();
    const disposicao = await desativarIntFreteDaConta(asDb(db), CONTA_ID, EVENT_MS);
    expect(disposicao).toEqual({ action: 'nao-encontrado' });
    expect(db.writes()).toHaveLength(0);
  });
});

/* ------------------------------- delete guard ----------------------------- */

describe('contaRealmenteExcluida', () => {
  it('is true only when the conta is confirmed absent right now', async () => {
    const db = new FakeDb();
    await expect(contaRealmenteExcluida(asDb(db), CONTA_ID)).resolves.toBe(true);
    db.seed('integracao', CONTA_ID, conta());
    await expect(contaRealmenteExcluida(asDb(db), CONTA_ID)).resolves.toBe(false);
  });
});

describe('refCanonicalDaConta', () => {
  it('is the Flutter ODM `documents/` form the importer matches on', () => {
    expect(refCanonicalDaConta(CONTA_ID)).toBe(CANONICO);
  });
});
