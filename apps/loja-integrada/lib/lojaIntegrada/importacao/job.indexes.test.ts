/**
 * The product import's REPORT pages and the key index they ride (root rule 1, #1874).
 *
 * `lerItensDaImportacaoLi` pages a job's `itens` by DOCUMENT KEY — `orderBy(documentId())`,
 * `startAfter(<the previous page's last id>)`, `limit(500 + 1)`, no filter — for the items route
 * and for the job's own actionable count at its end (`relatorio.ts`). Firestore Enterprise keeps
 * no implicit key index, not even on `__name__`, and nothing fails without a declared one: not the
 * deploy, not the emulator (which serves key order natively), not this app. Each page is then
 * expected to walk the job's whole report and sort in memory — #1874 measured that on the root
 * `arquivos` collection on staging (313 index rows read per page of 100, and exactly the page once
 * `arquivos (__name__ ASC)` was declared); a per-parent subcollection is the same query shape, but
 * its plan has not been measured separately — so one full read of a report of N items would cost
 * about N²/500 instead of N. The pairing is pinned here, offline, both ways: the
 * pages still order by the key ALONE (the queries the fake records), and `firestore.indexes.json`
 * declares the collection id they read, COLLECTION scope, with `__name__ ASC` as its only field.
 *
 * Its own file rather than a describe in `job.test.ts`: `*.indexes.test.ts` is how every key-index
 * pin in the repo is found, and a red here asks a different repair (the index and its reader moved
 * apart) from the paging behaviour `job.test.ts` pins. The same entry is listed as permanent in
 * `tools/migrations/src/keyWalks.indexes.test.ts`, so the post-cutover cleanup of the migration-only
 * key indexes (#1896) keeps it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITE_ITENS_IMPORTACAO_LI } from '@delfrance/schemas';

import { type ConsultaFake, FakeDb, asDb } from '../testing/fakeDb';
import { caminhoJobLi, seedItemLi } from '../testing/importacaoLi';
import { lerItensDaImportacaoLi } from './job';
import { contarPendenciasAcionaveisLi } from './relatorio';

// Per file: nothing here may reach the global `fetch` (no call to the store before the cutover).
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('job.indexes.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const JOB = 'jobRelatorioIdx';

/** One entry of `firestore.indexes.json`. */
interface IndiceDeclarado {
  readonly collectionGroup: string;
  readonly queryScope: string;
  readonly fields: readonly {
    readonly fieldPath: string;
    readonly order?: string;
    readonly arrayConfig?: string;
  }[];
}

function indicesDeclarados(): IndiceDeclarado[] {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
    if (dir === dirname(dir)) throw new Error('no pnpm-workspace.yaml above this test');
    dir = dirname(dir);
  }
  return (
    JSON.parse(readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8')) as {
      indexes: IndiceDeclarado[];
    }
  ).indexes;
}

/** The collection id a recorded query reads: its path's last segment, the name an index carries. */
function idDaColecao(consulta: ConsultaFake): string {
  return consulta.colecao.split('/').at(-1) ?? consulta.colecao;
}

/** Whether `consulta` is a key-range page: no filter, ordered by the document key ALONE, ascending. */
function ehPaginaPorChave(consulta: ConsultaFake): boolean {
  return (
    consulta.filtros.length === 0 &&
    consulta.ordens.length === 1 &&
    consulta.ordens[0]?.[0] === '__name__' &&
    consulta.ordens[0]?.[1] === 'asc'
  );
}

/**
 * Whether `indice` is the key index the page `consulta` rides, in the one shape #1874 measured to
 * range-seek on a root collection (and expected to for a per-parent subcollection, not yet
 * measured): the query's own collection id, the query's own scope (a plain collection query is
 * `COLLECTION`; a group query needs `COLLECTION_GROUP`), and `__name__ ASCENDING` as the ONLY field.
 * Pure.
 */
function indiceServeAPagina(indice: IndiceDeclarado, consulta: ConsultaFake): boolean {
  const campo = indice.fields[0];
  return (
    ehPaginaPorChave(consulta) &&
    indice.collectionGroup === idDaColecao(consulta) &&
    indice.queryScope === (consulta.grupo === true ? 'COLLECTION_GROUP' : 'COLLECTION') &&
    indice.fields.length === 1 &&
    campo?.fieldPath === '__name__' &&
    campo.order === 'ASCENDING'
  );
}

/** The page as the reader sends it (the recorded shape `job.test.ts` pins). */
const PAGINA: ConsultaFake = {
  colecao: `${caminhoJobLi(JOB)}/itens`,
  filtros: [],
  ordens: [['__name__', 'asc']],
  limite: LIMITE_ITENS_IMPORTACAO_LI + 1,
  apos: null,
};

/** The entry that serves it. */
const INDICE_DA_CHAVE: IndiceDeclarado = {
  collectionGroup: 'itens',
  queryScope: 'COLLECTION',
  fields: [{ fieldPath: '__name__', order: 'ASCENDING' }],
};

/**
 * Every query both readers send over a report one item longer than a page: the route's two pages
 * (first, then after the cursor) and the actionable count's walk of the same two.
 */
async function consultasDoRelatorio(): Promise<ConsultaFake[]> {
  const db = new FakeDb();
  for (let i = 0; i <= LIMITE_ITENS_IMPORTACAO_LI; i += 1) seedItemLi(db, JOB, 300_000 + i);
  const primeira = await lerItensDaImportacaoLi(asDb(db), JOB, null);
  await lerItensDaImportacaoLi(asDb(db), JOB, primeira.proximo);
  // The count's walk is bounded: its THIRD query rejects. A cursor regression (a walk that never
  // reaches its last page) then turns red here instead of looping forever — the fake answers on
  // microtasks, so vitest's timer-based timeout could never fire.
  db.antesDaProximaConsulta(PAGINA.colecao, () => undefined);
  db.antesDaProximaConsulta(PAGINA.colecao, () => undefined);
  db.antesDaProximaConsulta(PAGINA.colecao, () => {
    throw new Error('job.indexes.test: the report walk did not stop after its last page');
  });
  await contarPendenciasAcionaveisLi(asDb(db), JOB);
  return db.consultas;
}

describe('the import report pages and their key index (#1874)', () => {
  it('both readers page the job’s own `itens` by the document key alone, with no filter', async () => {
    const consultas = await consultasDoRelatorio();
    // Anti-vacuity: two pages for the route, two for the actionable count.
    expect(consultas).toHaveLength(4);
    // If this goes red because a page was re-keyed onto a field or gained a filter, the index
    // below has lost its reader: delete its entry from `firestore.indexes.json` and its permanent
    // row in `tools/migrations/src/keyWalks.indexes.test.ts` together with this file, and declare
    // what the new query rides.
    for (const c of consultas) {
      expect(c.colecao).toBe(PAGINA.colecao);
      expect(c.grupo).toBeUndefined();
      expect(c.filtros).toEqual([]);
      expect(c.ordens).toEqual([['__name__', 'asc']]);
      expect(c.limite).toBe(LIMITE_ITENS_IMPORTACAO_LI + 1);
      expect(ehPaginaPorChave(c)).toBe(true);
    }
    // The second page of each walk resumes after the first one's last id.
    expect(consultas.map((c) => c.apos)).toEqual([
      null,
      String(300_000 + LIMITE_ITENS_IMPORTACAO_LI - 1),
      null,
      String(300_000 + LIMITE_ITENS_IMPORTACAO_LI - 1),
    ]);
  });

  it('firestore.indexes.json declares `itens` (COLLECTION) with `__name__` ASCENDING as its ONLY field, once', async () => {
    const declarados = indicesDeclarados();
    for (const c of await consultasDoRelatorio()) {
      expect(
        declarados.filter((i) => indiceServeAPagina(i, c)),
        `declare { "collectionGroup": "${idDaColecao(c)}", "queryScope": "COLLECTION", "fields": ` +
          '[{ "fieldPath": "__name__", "order": "ASCENDING" }] } in firestore.indexes.json — ' +
          'without it every report page reads the whole report (#1874)',
      ).toHaveLength(1);
    }
    // No second key-leading entry for the same collection id beside it.
    expect(
      declarados
        .filter(
          (i) =>
            i.collectionGroup === idDaColecao(PAGINA) &&
            i.queryScope === 'COLLECTION' &&
            i.fields[0]?.fieldPath === '__name__',
        )
        .map((i) => i.fields),
    ).toEqual([[{ fieldPath: '__name__', order: 'ASCENDING' }]]);
  });

  it('EQUAL: the entry as declared serves the page as sent', async () => {
    // Anchors: both literals are the shipped ones — the manifest holds this entry, and the
    // reader's first page is this page — so every near-miss below stays one step from reality.
    expect(indicesDeclarados()).toContainEqual(INDICE_DA_CHAVE);
    expect((await consultasDoRelatorio())[0]).toEqual(PAGINA);
    expect(indiceServeAPagina(INDICE_DA_CHAVE, PAGINA)).toBe(true);
  });

  // Each near-miss differs from the EQUAL pair in ONE respect, so each check of the predicate is
  // the only one that rejects it.
  it.each<[string, IndiceDeclarado]>([
    ['COLLECTION_GROUP scope', { ...INDICE_DA_CHAVE, queryScope: 'COLLECTION_GROUP' }],
    // Not the shape #1874 measured to range-seek; the pin accepts that shape only.
    [
      'DESCENDING order',
      { ...INDICE_DA_CHAVE, fields: [{ fieldPath: '__name__', order: 'DESCENDING' }] },
    ],
    ['a key-only index of another collection', { ...INDICE_DA_CHAVE, collectionGroup: 'paginas' }],
    [
      'the key and a second field',
      {
        ...INDICE_DA_CHAVE,
        fields: [
          { fieldPath: '__name__', order: 'ASCENDING' },
          { fieldPath: 'liId', order: 'ASCENDING' },
        ],
      },
    ],
    [
      'a single field that is not the key',
      { ...INDICE_DA_CHAVE, fields: [{ fieldPath: 'liId', order: 'ASCENDING' }] },
    ],
  ])('⚠️ NEAR-MISS (index): %s does not serve the page', (_, indice) => {
    expect(indiceServeAPagina(indice, PAGINA)).toBe(false);
  });

  it.each<[string, ConsultaFake]>([
    ['a page with a filter', { ...PAGINA, filtros: [['acao', '==', 'nenhuma']] }],
    ['a page ordered by a field alone', { ...PAGINA, ordens: [['liId', 'asc']] }],
    [
      'a page ordered by the key, then a field',
      {
        ...PAGINA,
        ordens: [
          ['__name__', 'asc'],
          ['liId', 'asc'],
        ],
      },
    ],
    ['a page ordered by the key descending', { ...PAGINA, ordens: [['__name__', 'desc']] }],
    ['a group query over every `itens`', { ...PAGINA, colecao: 'itens', grupo: true }],
  ])('⚠️ NEAR-MISS (query): %s is not served by the key index', (_, consulta) => {
    expect(indiceServeAPagina(INDICE_DA_CHAVE, consulta)).toBe(false);
  });

  it('⚠️ NEAR-MISS (manifest): another collection’s DECLARED key-only index does not serve the page', () => {
    const outras = indicesDeclarados().filter(
      (i) =>
        i.collectionGroup === 'arquivos' &&
        i.queryScope === 'COLLECTION' &&
        i.fields.length === 1 &&
        i.fields[0]?.fieldPath === '__name__',
    );
    // Anti-vacuity: the sibling key index exists, in the exact shape this one has.
    expect(outras.map((i) => i.fields)).toEqual([[{ fieldPath: '__name__', order: 'ASCENDING' }]]);
    for (const outra of outras) expect(indiceServeAPagina(outra, PAGINA)).toBe(false);
  });
});
