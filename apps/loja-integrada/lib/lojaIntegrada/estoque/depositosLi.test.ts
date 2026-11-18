/**
 * `depositosLi.ts` (master plan step 12, PR 12-f): which contas a stock-record write concerns.
 *
 * The record side is an EXACT match on the two stored forms — the send run's own `in` query — so
 * every "same depósito" decision here is pinned with an EQUAL pair and a NEAR-MISS that must stay
 * distinct (root `CLAUDE.md`, the fold rule). The map is cached per instance: the query count, the
 * TTL and the empty-map answer are pinned on a counting fake, and the one query is pinned against
 * `firestore.indexes.json` (Enterprise full-scans an undeclared one).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_CACHE_TTL, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import {
  __setRelogioDoMapaDepositosParaTestes,
  contasDoEventoLi,
  lerMapaDepositosLi,
  mapaDepositosLi,
} from './depositosLi';

const T0 = 1_790_000_000_000;
let agora = T0;

beforeEach(() => {
  __resetAllReadCaches();
  agora = T0;
  __setRelogioDoMapaDepositosParaTestes(() => agora);
  vi.stubGlobal('fetch', () => {
    throw new Error('depositosLi.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoMapaDepositosParaTestes();
  vi.unstubAllGlobals();
});

const D = 'dep-li';
const FORMA_DOCUMENTS = `documents/depositos/${D}`;
const FORMA_NUA = `depositos/${D}`;

const registro = (ref: unknown): DocData => ({ depositoOuterRef: ref, quantidade: 1 });

describe('mapaDepositosLi — both stored forms are keys, an unreadable depósito is left out', () => {
  it('a conta is listed under BOTH forms of its depósito, contas sorted by id', () => {
    const mapa = mapaDepositosLi([
      { integracaoId: 'b', depositoId: D },
      { integracaoId: 'a', depositoId: D },
      { integracaoId: 'c', depositoId: 'dep-2' },
      { integracaoId: 'sem', depositoId: null },
    ]);
    const esperado = [
      { contaId: 'a', depositoId: D },
      { contaId: 'b', depositoId: D },
    ];
    expect(mapa.get(FORMA_DOCUMENTS)).toEqual(esperado);
    expect(mapa.get(FORMA_NUA)).toEqual(esperado);
    expect(mapa.get('documents/depositos/dep-2')).toEqual([{ contaId: 'c', depositoId: 'dep-2' }]);
    expect([...mapa.keys()].sort()).toEqual(
      [FORMA_DOCUMENTS, FORMA_NUA, 'documents/depositos/dep-2', 'depositos/dep-2'].sort(),
    );
  });
});

describe('contasDoEventoLi — the EXACT two-form match', () => {
  const mapa = mapaDepositosLi([{ integracaoId: 'a', depositoId: D }]);

  it.each([FORMA_DOCUMENTS, FORMA_NUA])(
    'EQUAL: a record at %j concerns the conta (both stored forms)',
    (ref) => {
      expect(contasDoEventoLi(mapa, null, registro(ref))).toEqual([
        { contaId: 'a', depositoId: D },
      ]);
    },
  );

  it.each([
    ['a leading slash', `/documents/depositos/${D}`],
    ['a case change', 'documents/depositos/DEP-LI'],
    ['a trailing space', `documents/depositos/${D} `],
    ['a bare id', D],
    ['another depósito', `documents/depositos/${D}2`],
    ['a reference-like object', { path: `depositos/${D}`, id: D }],
    ['null', null],
    ['a number', 7],
  ])(
    '⚠️ NEAR-MISS: a record whose ref is %s concerns NO conta (the run cannot find it either)',
    (_r, ref) => {
      expect(contasDoEventoLi(mapa, registro(ref), registro(ref))).toEqual([]);
    },
  );

  it('a record with no depositoOuterRef at all, and both sides absent, concern no conta', () => {
    expect(contasDoEventoLi(mapa, { quantidade: 1 }, { quantidade: 2 })).toEqual([]);
    expect(contasDoEventoLi(mapa, null, null)).toEqual([]);
  });

  it('a depósito change concerns the conta on EITHER side (moved away, moved in)', () => {
    const outro = registro('documents/depositos/outro');
    expect(contasDoEventoLi(mapa, registro(FORMA_DOCUMENTS), outro)).toEqual([
      { contaId: 'a', depositoId: D },
    ]);
    expect(contasDoEventoLi(mapa, outro, registro(FORMA_NUA))).toEqual([
      { contaId: 'a', depositoId: D },
    ]);
    // A delete and a create concern it through the side that exists.
    expect(contasDoEventoLi(mapa, registro(FORMA_NUA), null)).toHaveLength(1);
  });

  it('a move between two contas’ depósitos concerns BOTH, sorted and deduplicated', () => {
    const dois = mapaDepositosLi([
      { integracaoId: 'z', depositoId: 'dep-z' },
      { integracaoId: 'a', depositoId: D },
    ]);
    expect(
      contasDoEventoLi(dois, registro('depositos/dep-z'), registro(FORMA_DOCUMENTS)).map(
        (c) => c.contaId,
      ),
    ).toEqual(['a', 'z']);
  });

  it('two contas on one depósito ⇒ both; before and after at one depósito (either form) ⇒ each ONCE', () => {
    const dois = mapaDepositosLi([
      { integracaoId: 'b', depositoId: D },
      { integracaoId: 'a', depositoId: D },
    ]);
    expect(
      contasDoEventoLi(dois, registro(FORMA_DOCUMENTS), registro(FORMA_NUA)).map((c) => c.contaId),
    ).toEqual(['a', 'b']);
  });

  it('an inherited depositoOuterRef is not stored data', () => {
    const herdado = Object.create({ depositoOuterRef: FORMA_DOCUMENTS }) as DocData;
    expect(contasDoEventoLi(mapa, null, herdado)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                              The cached read                                */
/* -------------------------------------------------------------------------- */

function seedConta(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed(`integracao/${id}`, {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: `Loja ${id}`,
    ativo: true,
    depositoOuterRef: `documents/depositos/${D}`,
    ...over,
  });
}

interface Indice {
  readonly collectionGroup: string;
  readonly queryScope: string;
  readonly fields: readonly { readonly fieldPath: string; readonly order?: string }[];
}

function indices(): readonly Indice[] {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) dir = dirname(dir);
  return (
    JSON.parse(readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8')) as {
      indexes: Indice[];
    }
  ).indexes;
}

describe('lerMapaDepositosLi — one enumeration per TTL per instance', () => {
  it('reads the conta enumeration ONCE, on the declared COLLECTION integracao (tipo ASC, nome ASC) index', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    seedConta(db, 'b', { depositoOuterRef: `depositos/${D}`, ativo: false });
    seedConta(db, 's', { tipo: 5 });
    seedConta(db, 'sem-deposito', { depositoOuterRef: null });

    const mapa = await lerMapaDepositosLi(asDb(db));

    // The inactive conta is KEPT (the run skips it at one cached read); the Shopee conta and the
    // conta with no depósito are not there.
    expect(mapa.get(FORMA_DOCUMENTS)?.map((c) => c.contaId)).toEqual(['a', 'b']);
    expect(db.consultas).toEqual([
      {
        colecao: 'integracao',
        filtros: [['tipo', '==', INTEGRACAO_TIPO.lojaIntegrada]],
        ordens: [['nome', 'asc']],
        limite: null,
        apos: null,
      },
    ]);
    const declarado = indices().filter(
      (i) =>
        i.collectionGroup === 'integracao' &&
        i.queryScope === 'COLLECTION' &&
        JSON.stringify(i.fields.map((f) => [f.fieldPath, f.order])) ===
          JSON.stringify([
            ['tipo', 'ASCENDING'],
            ['nome', 'ASCENDING'],
          ]),
    );
    expect(declarado).toHaveLength(1);
  });

  it('within the TTL: a second and a third event cost NO query; after it, one more', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');

    await lerMapaDepositosLi(asDb(db));
    agora = T0 + READ_CACHE_TTL.config - 1;
    await lerMapaDepositosLi(asDb(db));
    await lerMapaDepositosLi(asDb(db));
    expect(db.consultas).toHaveLength(1);

    agora = T0 + READ_CACHE_TTL.config + 1;
    await lerMapaDepositosLi(asDb(db));
    expect(db.consultas).toHaveLength(2);
    expect(READ_CACHE_TTL.config).toBe(900_000);
  });

  it('an EMPTY map is an answer and is cached (a project with no Loja Integrada conta pays one query per TTL)', async () => {
    const db = new FakeDb();
    seedConta(db, 's', { tipo: 5 });

    expect((await lerMapaDepositosLi(asDb(db))).size).toBe(0);
    agora = T0 + READ_CACHE_TTL.negative + 1;
    expect((await lerMapaDepositosLi(asDb(db))).size).toBe(0);
    expect(db.consultas).toHaveLength(1);
  });

  it('concurrent misses share ONE load; a failed load is not cached', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    await Promise.all([lerMapaDepositosLi(asDb(db)), lerMapaDepositosLi(asDb(db))]);
    expect(db.consultas).toHaveLength(1);

    __resetAllReadCaches();
    const falha = new Error('teste: consulta falhou');
    db.falharConsulta('integracao', falha);
    await expect(lerMapaDepositosLi(asDb(db))).rejects.toBe(falha);
    db.falharConsulta('integracao', null);
    expect((await lerMapaDepositosLi(asDb(db))).size).toBe(2);
  });

  it('__resetAllReadCaches resets it: the next event reads again', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    await lerMapaDepositosLi(asDb(db));
    __resetAllReadCaches();
    await lerMapaDepositosLi(asDb(db));
    expect(db.consultas).toHaveLength(2);
  });
});
