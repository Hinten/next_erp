import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { MlItemAttribute } from '@delfrance/integrations-mercado-livre';

import { resolveTaxonomia } from './importTaxonomia';

/* ------------------------------ fake Firestore ---------------------------- */
// Single top-level collection (`grupoDeVariacoes`) with doc get/create/set, a
// single-field `where(...).get()`, and a `runTransaction` that just invokes the
// callback against a `tx` whose get/create/set delegate straight to the same
// doc — sufficient for `importTaxonomia.ts`'s per-grupo transactions (no real
// isolation needed for these tests; each test exercises one resolveTaxonomia
// call end-to-end).

type DocData = Record<string, unknown>;

interface FakeDocRef {
  id: string;
  get(): Promise<{ exists: boolean; id: string; data: () => DocData | undefined }>;
  create(data: DocData): Promise<void>;
  set(data: DocData): Promise<void>;
}

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
  docData(path: string, id: string): DocData | undefined {
    return this.col(path).get(id);
  }

  collection(path: string) {
    const col = this.col(path);
    return {
      doc: (id: string): FakeDocRef => ({
        id,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        create: async (data: DocData) => {
          if (col.has(id)) throw Object.assign(new Error('already exists'), { code: 6 });
          col.set(id, { ...data });
        },
        set: async (data: DocData) => {
          col.set(id, { ...data });
        },
      }),
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: [...col.entries()]
            .filter(([, d]) => d[field] === value)
            .map(([id, d]) => ({ id, data: () => d })),
        }),
      }),
    };
  }

  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    return fn({
      get: (ref) => ref.get(),
      create: (ref, data) => ref.create(data),
      set: (ref, data) => ref.set(data),
    });
  }
}

interface FakeTx {
  get(ref: FakeDocRef): Promise<{ exists: boolean; id: string; data: () => DocData | undefined }>;
  create(ref: FakeDocRef, data: DocData): Promise<void>;
  set(ref: FakeDocRef, data: DocData): Promise<void>;
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

const NOW = 1_700_000_000_000;
const INTEGRACAO_ID = 'i1';

function combo(over: Partial<MlItemAttribute>): MlItemAttribute {
  return { id: null, name: null, value_id: null, value_name: null, ...over };
}

/* --------------------------------- creates -------------------------------- */

describe('resolveTaxonomia — create path', () => {
  it('creates a brand-new SIZE grupo, schema-parsed with defaults', async () => {
    const db = new FakeDb();
    const resolutions = await resolveTaxonomia(
      { db: asDb(db) },
      {
        combos: [combo({ id: 'SIZE', name: 'Talle', value_id: '170', value_name: 'M' })],
        integracaoId: INTEGRACAO_ID,
        now: NOW,
      },
    );

    expect(resolutions).toEqual([
      {
        attrKey: 'SIZE|170',
        grupoId: 'SIZE',
        varianteId: '170',
        grupoUid: 'SIZE',
        varianteFake: 'documents/grupoDeVariacoes/SIZE/variacoes/170',
      },
    ]);

    const doc = db.docData('grupoDeVariacoes', 'SIZE')!;
    expect(doc).toMatchObject({
      nome: 'Talle',
      codigo: null,
      ordem: 1,
      tipo: 1,
      permiteFotos: false,
      variacoesIds: ['170'],
      timestamp: NOW,
    });
    expect(doc.variacoes).toEqual([
      expect.objectContaining({
        id: '170',
        nome: 'M',
        externalVariacaoLinks: [
          {
            tipo: 1,
            integracaoId: INTEGRACAO_ID,
            externalId: '170',
            externalName: 'M',
            timestamp: NOW,
          },
        ],
      }),
    ]);
  });

  it('creates a COLOR grupo with permiteFotos true / tipo 2', async () => {
    const db = new FakeDb();
    await resolveTaxonomia(
      { db: asDb(db) },
      {
        combos: [combo({ id: 'COLOR', name: 'Cor', value_id: '1', value_name: 'Azul' })],
        integracaoId: INTEGRACAO_ID,
        now: NOW,
      },
    );
    const doc = db.docData('grupoDeVariacoes', 'COLOR')!;
    expect(doc).toMatchObject({ tipo: 2, permiteFotos: true });
  });

  it('two combos across two different grupos each get their own doc via separate transactions', async () => {
    const db = new FakeDb();
    const resolutions = await resolveTaxonomia(
      { db: asDb(db) },
      {
        combos: [
          combo({ id: 'SIZE', value_id: '170', value_name: 'M' }),
          combo({ id: 'COLOR', value_id: '1', value_name: 'Azul' }),
        ],
        integracaoId: INTEGRACAO_ID,
        now: NOW,
      },
    );
    expect(resolutions).toHaveLength(2);
    expect(db.docData('grupoDeVariacoes', 'SIZE')).toBeDefined();
    expect(db.docData('grupoDeVariacoes', 'COLOR')).toBeDefined();
  });

  it('skips a combo missing both attribute id/name or both value id/name — no writes', async () => {
    const db = new FakeDb();
    const resolutions = await resolveTaxonomia(
      { db: asDb(db) },
      {
        combos: [combo({ value_id: '1', value_name: 'X' }), combo({ id: 'SIZE', name: 'Talle' })],
        integracaoId: INTEGRACAO_ID,
        now: NOW,
      },
    );
    expect(resolutions).toHaveLength(0);
    // The second combo's bare attribute id still triggers a CANDIDATE lookup
    // (loadCandidateGrupos doesn't know yet it'll be skipped for lacking a
    // value) — but nothing gets written since planTaxonomia skips it too.
    expect(db.docData('grupoDeVariacoes', 'SIZE')).toBeUndefined();
  });
});

/* --------------------------------- updates -------------------------------- */

describe('resolveTaxonomia — update path (existing grupo)', () => {
  it('appends a new variante via tx.set, preserving unrelated/unknown raw keys (legacy parity)', async () => {
    const db = new FakeDb();
    db.seed('grupoDeVariacoes', 'SIZE', {
      nome: 'Tamanho',
      codigo: null,
      ordem: 1,
      tipo: 1,
      permiteFotos: false,
      ultimaModificacao: 500,
      timestamp: 1,
      variacoesIds: ['170'],
      variacoes: [{ id: '170', nome: 'M', timestamp: 1 }],
      // Flutter-authored field our Zod schema doesn't know about — must survive.
      legacyField: 'keep-me',
    });

    const resolutions = await resolveTaxonomia(
      { db: asDb(db) },
      {
        combos: [combo({ id: 'SIZE', value_id: '190', value_name: 'G' })],
        integracaoId: INTEGRACAO_ID,
        now: NOW,
      },
    );

    expect(resolutions).toEqual([
      {
        attrKey: 'SIZE|190',
        grupoId: 'SIZE',
        varianteId: '190',
        grupoUid: 'SIZE',
        varianteFake: 'documents/grupoDeVariacoes/SIZE/variacoes/190',
      },
    ]);

    const doc = db.docData('grupoDeVariacoes', 'SIZE')!;
    expect(doc.legacyField).toBe('keep-me'); // unknown key survives the spread-existing write
    expect(doc.variacoesIds).toEqual(['170', '190']);
    expect(doc.variacoes).toHaveLength(2);
    expect((doc.variacoes as DocData[])[1]).toMatchObject({ id: '190', nome: 'G' });
    expect(doc.ultimaModificacao).toBe(NOW);
  });

  it('stamps externalVariacaoLinks on a matched existing variante missing it', async () => {
    const db = new FakeDb();
    db.seed('grupoDeVariacoes', 'SIZE', {
      nome: 'Tamanho',
      tipo: 1,
      variacoesIds: ['170'],
      variacoes: [{ id: '170', nome: 'M', timestamp: 1 }], // no externalVariacaoLinks yet
    });

    await resolveTaxonomia(
      { db: asDb(db) },
      {
        combos: [combo({ id: 'SIZE', value_id: '170', value_name: 'M' })],
        integracaoId: INTEGRACAO_ID,
        now: NOW,
      },
    );

    const doc = db.docData('grupoDeVariacoes', 'SIZE')!;
    expect(doc.variacoes).toEqual([
      {
        id: '170',
        nome: 'M',
        timestamp: 1,
        externalVariacaoLinks: [
          {
            tipo: 1,
            integracaoId: INTEGRACAO_ID,
            externalId: '170',
            externalName: 'M',
            timestamp: NOW,
          },
        ],
      },
    ]);
  });

  it('is a no-op when the variante already carries the stamp for this integracaoId+externalId', async () => {
    const db = new FakeDb();
    const seeded = {
      nome: 'Tamanho',
      tipo: 1,
      variacoesIds: ['170'],
      variacoes: [
        {
          id: '170',
          nome: 'M',
          timestamp: 1,
          externalVariacaoLinks: [
            {
              tipo: 1,
              integracaoId: INTEGRACAO_ID,
              externalId: '170',
              externalName: 'M',
              timestamp: 1,
            },
          ],
        },
      ],
    };
    db.seed('grupoDeVariacoes', 'SIZE', seeded);

    const resolutions = await resolveTaxonomia(
      { db: asDb(db) },
      {
        combos: [combo({ id: 'SIZE', value_id: '170', value_name: 'M' })],
        integracaoId: INTEGRACAO_ID,
        now: NOW,
      },
    );

    expect(resolutions[0]).toMatchObject({ grupoId: 'SIZE', varianteId: '170' });
    // Untouched — no tx.set ran (nothing to append/stamp).
    expect(db.docData('grupoDeVariacoes', 'SIZE')).toEqual(seeded);
  });
});

/* ------------------------------ candidate loading -------------------------- */

describe('resolveTaxonomia — candidate loading fallbacks', () => {
  it('matches an existing grupo by nome when its doc id differs from the attribute id', async () => {
    const db = new FakeDb();
    db.seed('grupoDeVariacoes', 'xyz-random-id', {
      nome: 'Talle',
      tipo: 1,
      variacoesIds: [],
      variacoes: [],
    });

    const resolutions = await resolveTaxonomia(
      { db: asDb(db) },
      {
        combos: [combo({ id: 'SIZE', name: 'Talle', value_id: '170', value_name: 'M' })],
        integracaoId: INTEGRACAO_ID,
        now: NOW,
      },
    );

    expect(resolutions[0]!.grupoId).toBe('xyz-random-id');
    expect(db.docData('grupoDeVariacoes', 'SIZE')).toBeUndefined(); // no duplicate created
  });

  it('matches an existing grupo by tipo fallback when doc id and nome both miss (COLOR)', async () => {
    const db = new FakeDb();
    db.seed('grupoDeVariacoes', 'meu-cor', {
      nome: 'Cores da loja',
      tipo: 2,
      variacoesIds: [],
      variacoes: [],
    });

    const resolutions = await resolveTaxonomia(
      { db: asDb(db) },
      {
        combos: [combo({ id: 'COLOR', name: 'Cor', value_id: '1', value_name: 'Azul' })],
        integracaoId: INTEGRACAO_ID,
        now: NOW,
      },
    );

    expect(resolutions[0]!.grupoId).toBe('meu-cor');
    expect(db.docData('grupoDeVariacoes', 'COLOR')).toBeUndefined();
  });
});
