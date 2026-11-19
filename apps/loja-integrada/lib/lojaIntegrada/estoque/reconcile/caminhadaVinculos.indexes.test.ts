/**
 * The daily stock reconcile's ERP LINK WALK and the key index it rides (root rule 1, #1874).
 *
 * `lerPaginaCaminhadaLi` pages EVERY `produtolojaintegrada` document of the ERP by DOCUMENT KEY —
 * `collectionGroup(...).select(...).orderBy(documentId()).startAfter('<full path>').limit(300)`,
 * no filter. Firestore Enterprise keeps no implicit key index, and nothing fails without a declared
 * one: each page would scan the whole group and sort in memory, and a walk of N links would cost
 * about N²/300 instead of N. The pairing is pinned here, offline, both ways: the walk still orders
 * by the key ALONE with no filter (the query the fake records, built from the module's constants),
 * and `firestore.indexes.json` declares the collection id it reads, COLLECTION_GROUP scope, with
 * `__name__ ASC` as its only field. The same entry is listed as PERMANENT in
 * `tools/migrations/src/keyWalks.indexes.test.ts` (this walk is its reader after the cutover), so
 * the post-cutover cleanup of the migration-only key indexes (#1896) keeps it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDb, asDb } from '../../testing/fakeDb';
import {
  CAMPOS_VINCULO_CAMINHADA_LI,
  GRUPO_CAMINHADA_LI,
  TAMANHO_PAGINA_CAMINHADA_LI,
  lerPaginaCaminhadaLi,
} from './caminhadaVinculos';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('caminhadaVinculos.indexes.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** One entry of `firestore.indexes.json`. */
interface IndiceDeclarado {
  readonly collectionGroup: string;
  readonly queryScope: string;
  readonly fields: readonly { readonly fieldPath: string; readonly order?: string }[];
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

describe('the ERP link walk rides the declared COLLECTION_GROUP key index', () => {
  it('every page is a key-range page of the group: no filter, the key ALONE, ascending, the projection and the page size', async () => {
    const db = new FakeDb();
    db.seed('produtos/p1/produtolojaintegrada/l1', { id: 1 });
    await lerPaginaCaminhadaLi(asDb(db), null);
    await lerPaginaCaminhadaLi(asDb(db), 'produtos/p1/produtolojaintegrada/l1');
    const grupo = db.consultas.filter((c) => c.grupo === true);
    expect(grupo).toEqual([
      {
        colecao: GRUPO_CAMINHADA_LI,
        grupo: true,
        filtros: [],
        ordens: [['__name__', 'asc']],
        limite: TAMANHO_PAGINA_CAMINHADA_LI,
        apos: null,
        selecao: [...CAMPOS_VINCULO_CAMINHADA_LI],
      },
      {
        colecao: GRUPO_CAMINHADA_LI,
        grupo: true,
        filtros: [],
        ordens: [['__name__', 'asc']],
        limite: TAMANHO_PAGINA_CAMINHADA_LI,
        apos: 'produtos/p1/produtolojaintegrada/l1',
        selecao: [...CAMPOS_VINCULO_CAMINHADA_LI],
      },
    ]);
    expect(TAMANHO_PAGINA_CAMINHADA_LI).toBe(300);
  });

  it('firestore.indexes.json declares exactly one `produtolojaintegrada (__name__ ASC)` COLLECTION_GROUP entry', () => {
    const chave = indicesDeclarados().filter(
      (i) =>
        i.collectionGroup === GRUPO_CAMINHADA_LI &&
        i.queryScope === 'COLLECTION_GROUP' &&
        i.fields.length === 1 &&
        i.fields[0]?.fieldPath === '__name__' &&
        i.fields[0]?.order === 'ASCENDING',
    );
    expect(chave).toHaveLength(1);
    // ÂNCORA: the file was read and holds the group's other entries too.
    expect(
      indicesDeclarados().filter((i) => i.collectionGroup === GRUPO_CAMINHADA_LI).length,
    ).toBeGreaterThan(1);
  });
});
