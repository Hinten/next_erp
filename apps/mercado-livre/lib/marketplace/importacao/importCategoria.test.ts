import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { MercadoLivreApi, MlCategory } from '@delfrance/integrations-mercado-livre';
import { MercadoLivreError } from '@delfrance/integrations-mercado-livre';

import { buildCategoriaChain, importCategoriaChain } from './importCategoria';

/* ------------------------------ fake Firestore ---------------------------- */
// Mirrors the `doc().create()` shape used by import.test.ts: ALREADY_EXISTS
// (code 6) on a pre-seeded doc id; `failNextCreate` simulates an unrelated
// infra failure (a non-code-6 error) on a specific doc id.

type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  private readonly failFor = new Set<string>();

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docData(path: string, id: string): DocData | undefined {
    return this.col(path).get(id);
  }
  /** The next `create()` on this doc id throws a non-ALREADY_EXISTS error. */
  failNextCreate(id: string): void {
    this.failFor.add(id);
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        create: async (data: DocData) => {
          if (self.failFor.has(id)) {
            self.failFor.delete(id);
            throw Object.assign(new Error('infra failure'), { code: 13 }); // gRPC INTERNAL
          }
          if (col.has(id)) throw Object.assign(new Error('already exists'), { code: 6 });
          col.set(id, { ...data });
        },
      }),
    };
  }
}
const asDb = (db: FakeDb) => db as unknown as Firestore;

function makeApi(result: MlCategory | Error): MercadoLivreApi {
  return {
    getCategory: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as MercadoLivreApi;
}

const CHAIN_DETAIL: MlCategory = {
  id: 'MLB3',
  name: 'Camisetas',
  path_from_root: [
    { id: 'MLB1', name: 'Roupas' },
    { id: 'MLB2', name: 'Roupas Masculinas' },
    { id: 'MLB3', name: 'Camisetas' },
  ],
};

/* --------------------------- buildCategoriaChain --------------------------- */

describe('buildCategoriaChain', () => {
  it('single-node chain (no path_from_root): one doc, exact leafOuterRef string', () => {
    const chain = buildCategoriaChain({ id: 'MLB1055', name: 'Botas' }, 1000);
    expect(chain.leafOuterRef).toBe('documents/categorias/MLB1055');
    expect(chain.docs).toEqual([
      {
        id: 'MLB1055',
        data: {
          nome: 'Botas',
          nomeCompleto: 'Botas',
          permiteCadastro: true,
          categoriaGoogleId: null,
          categoriaPaiOuterRef: null,
          timestamp: 1000,
        },
      },
    ]);
  });

  it('multi-level chain: ids root→leaf, parent refs, nomeCompleto breadcrumbs', () => {
    const chain = buildCategoriaChain(CHAIN_DETAIL, 500);
    expect(chain.docs.map((d) => d.id)).toEqual(['MLB1', 'MLB2', 'MLB3']);
    expect(chain.docs[0]!.data.categoriaPaiOuterRef).toBeNull();
    expect(chain.docs[1]!.data.categoriaPaiOuterRef).toBe('documents/categorias/MLB1');
    expect(chain.docs[2]!.data.categoriaPaiOuterRef).toBe('documents/categorias/MLB2');
    expect(chain.docs[0]!.data.nomeCompleto).toBe('Roupas');
    expect(chain.docs[1]!.data.nomeCompleto).toBe('Roupas > Roupas Masculinas');
    expect(chain.docs[2]!.data.nomeCompleto).toBe('Roupas > Roupas Masculinas > Camisetas');
    expect(chain.docs.every((d) => d.data.timestamp === 500)).toBe(true);
    expect(chain.leafOuterRef).toBe('documents/categorias/MLB3');
  });

  it('defensive append: path_from_root that omits the category itself', () => {
    const detail: MlCategory = {
      id: 'MLB3',
      name: 'Camisetas',
      path_from_root: [
        { id: 'MLB1', name: 'Roupas' },
        { id: 'MLB2', name: 'Roupas Masculinas' },
      ],
    };
    const chain = buildCategoriaChain(detail, 1);
    expect(chain.docs.map((d) => d.id)).toEqual(['MLB1', 'MLB2', 'MLB3']);
    expect(chain.docs[2]!.data.nome).toBe('Camisetas');
    expect(chain.docs[2]!.data.categoriaPaiOuterRef).toBe('documents/categorias/MLB2');
    expect(chain.leafOuterRef).toBe('documents/categorias/MLB3');
  });

  it('missing/empty name falls back to the node id', () => {
    const chainNullName = buildCategoriaChain({ id: 'MLB9', name: null }, 1);
    expect(chainNullName.docs[0]!.data.nome).toBe('MLB9');
    expect(chainNullName.docs[0]!.data.nomeCompleto).toBe('MLB9');

    const chainEmptyName = buildCategoriaChain({ id: 'MLB9', name: '' }, 1);
    expect(chainEmptyName.docs[0]!.data.nome).toBe('MLB9');
  });

  it('empty id → empty chain', () => {
    expect(buildCategoriaChain({ id: '' }, 1)).toEqual({ docs: [], leafOuterRef: null });
  });
});

/* --------------------------- importCategoriaChain --------------------------- */

describe('importCategoriaChain', () => {
  it('happy path: creates all docs root→leaf, returns the leaf outer-ref', async () => {
    const db = new FakeDb();
    const leafRef = await importCategoriaChain(
      { db: asDb(db), api: makeApi(CHAIN_DETAIL) },
      'MLB3',
      777,
    );
    expect(leafRef).toBe('documents/categorias/MLB3');
    expect(db.docData('categorias', 'MLB1')).toMatchObject({ nome: 'Roupas' });
    expect(db.docData('categorias', 'MLB2')).toMatchObject({ nome: 'Roupas Masculinas' });
    expect(db.docData('categorias', 'MLB3')).toMatchObject({ nome: 'Camisetas' });
  });

  it('a MercadoLivreError from getCategory is swallowed — returns null, no writes', async () => {
    const db = new FakeDb();
    const leafRef = await importCategoriaChain(
      { db: asDb(db), api: makeApi(new MercadoLivreError('boom')) },
      'MLB3',
      1,
    );
    expect(leafRef).toBeNull();
    expect(db.docData('categorias', 'MLB3')).toBeUndefined();
  });

  it('a non-MercadoLivreError from getCategory is rethrown', async () => {
    const db = new FakeDb();
    await expect(
      importCategoriaChain({ db: asDb(db), api: makeApi(new TypeError('network')) }, 'MLB3', 1),
    ).rejects.toThrow(TypeError);
  });

  it('ALREADY_EXISTS on one doc is swallowed; later docs still created; leaf ref returned', async () => {
    const db = new FakeDb();
    db.seed('categorias', 'MLB1', { nome: 'Roupas Curada' }); // pre-existing, ERP-curated
    const leafRef = await importCategoriaChain(
      { db: asDb(db), api: makeApi(CHAIN_DETAIL) },
      'MLB3',
      1,
    );
    expect(leafRef).toBe('documents/categorias/MLB3');
    // create-if-absent — the existing doc is never overwritten
    expect(db.docData('categorias', 'MLB1')).toEqual({ nome: 'Roupas Curada' });
    expect(db.docData('categorias', 'MLB2')).toMatchObject({ nome: 'Roupas Masculinas' });
    expect(db.docData('categorias', 'MLB3')).toMatchObject({ nome: 'Camisetas' });
  });

  it('a non-code-6 create failure is rethrown (Firestore infra failure fails the import)', async () => {
    const db = new FakeDb();
    db.failNextCreate('MLB2');
    await expect(
      importCategoriaChain({ db: asDb(db), api: makeApi(CHAIN_DETAIL) }, 'MLB3', 1),
    ).rejects.toThrow('infra failure');
    expect(db.docData('categorias', 'MLB1')).toBeDefined(); // root created before the failure
    expect(db.docData('categorias', 'MLB3')).toBeUndefined(); // loop stopped at MLB2
  });
});
