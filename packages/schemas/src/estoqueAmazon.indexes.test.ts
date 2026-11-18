import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON,
  CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON,
} from './estoqueAmazon';

/**
 * The Amazon stock sync's movement window (step 12, PR 12-e2) reads the
 * estoque rows that moved at ONE depósito: a collection-group query
 * `estoques where depositoOuterRef == <one ref form> and ultimaModificacao >
 * <desde> and ultimaModificacao <= <ate> order by ultimaModificacao, __name__`,
 * paged by a document cursor. Its fields are `CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON`,
 * the one spelling of them (the query builds from the same tuple).
 *
 * On this Enterprise database a query with no matching index does not fail: it
 * scans every estoque row of every produto and bills the data scanned, on every
 * five-minute tick. So the index is pinned here, and it is NOT the
 * `(depositoOuterRef, ultimaModificacao)` entry already in the file: that one is
 * COLLECTION scope (one produto's partition), and a collection-group query
 * cannot use it.
 *
 * ⚠️ The trailing `__name__` IS declared: the query orders by the document key
 * (the page tie-break for rows sharing a stamp), and Enterprise adds no implicit
 * `__name__`, so an index without it is another index. DEPLOYING it is
 * migration-window work; agents never run it.
 */

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not find pnpm-workspace.yaml above ' + startDir);
}

interface IndiceDeclarado {
  collectionGroup?: string;
  queryScope?: string;
  fields?: Array<{ fieldPath?: string; order?: string }>;
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const parsed = JSON.parse(readFileSync(resolve(repoRoot, 'firestore.indexes.json'), 'utf8')) as {
  indexes?: IndiceDeclarado[];
};
const indices = parsed.indexes ?? [];

/** The window's fields, in index order: the tuple, then the document key, all ascending. */
const CAMPOS_DA_JANELA = [...CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON, '__name__'].map((fieldPath) => ({
  fieldPath,
  order: 'ASCENDING',
}));

/** Whether a declared index serves the window: the group, its scope and its exact fields. */
function serveAJanela(indice: IndiceDeclarado): boolean {
  return (
    indice.collectionGroup === 'estoques' &&
    indice.queryScope === 'COLLECTION_GROUP' &&
    JSON.stringify(indice.fields) === JSON.stringify(CAMPOS_DA_JANELA)
  );
}

describe('the Amazon stock movement window’s index (step 12, PR 12-e2)', () => {
  it('★ exactly ONE declared index serves it: estoques, COLLECTION_GROUP, the tuple then __name__, all ASCENDING', () => {
    const servem = indices.filter(serveAJanela);
    expect(servem).toHaveLength(1);
    expect(servem[0]?.fields?.map((f) => f.fieldPath)).toEqual([
      'depositoOuterRef',
      'ultimaModificacao',
      '__name__',
    ]);
  });

  it('★ NEAR-MISS: the COLLECTION-scoped (depositoOuterRef, ultimaModificacao) entry in the file does NOT satisfy the pin', () => {
    const colecao = indices.filter(
      (i) =>
        i.collectionGroup === 'estoques' &&
        i.queryScope === 'COLLECTION' &&
        JSON.stringify(i.fields?.map((f) => f.fieldPath)) ===
          JSON.stringify(CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON),
    );
    // Positive first: that entry is really there to be refused.
    expect(colecao).toHaveLength(1);
    expect(colecao.filter(serveAJanela)).toEqual([]);
  });

  it('★ NEAR-MISS: the window’s fields without the trailing __name__, a DESCENDING field, or another group do not satisfy it either', () => {
    const exato: IndiceDeclarado = {
      collectionGroup: 'estoques',
      queryScope: 'COLLECTION_GROUP',
      fields: CAMPOS_DA_JANELA,
    };
    expect(serveAJanela(exato)).toBe(true);
    expect(serveAJanela({ ...exato, fields: CAMPOS_DA_JANELA.slice(0, -1) })).toBe(false);
    expect(
      serveAJanela({
        ...exato,
        fields: CAMPOS_DA_JANELA.map((f, i) => (i === 1 ? { ...f, order: 'DESCENDING' } : f)),
      }),
    ).toBe(false);
    expect(serveAJanela({ ...exato, collectionGroup: 'historicoEstoque' })).toBe(false);
    // Neither do the group's other declared composites (another leading field, or no stamp).
    const outros = indices.filter(
      (i) =>
        i.collectionGroup === 'estoques' &&
        i.queryScope === 'COLLECTION_GROUP' &&
        (i.fields?.length ?? 0) > 1 &&
        !serveAJanela(i),
    );
    expect(outros.length).toBeGreaterThan(0);
    for (const i of outros) {
      expect(i.fields?.map((f) => f.fieldPath).slice(0, 2)).not.toEqual([
        ...CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON,
      ]);
    }
  });
});

/**
 * The daily reconcile's WALK (step 12, PR 12-f) reads every link doc of one
 * conta: a collection-group query `prodAmazon where contaAmazonOuterRef == <one
 * ref form> order by __name__`, paged by a document cursor and projected. Its
 * field is `CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON`. The existing
 * `(contaAmazonOuterRef, sku)` entry orders the conta's rows by SKU, never by
 * key, so it is another index; and Enterprise adds no implicit `__name__`, so
 * the walk's own entry declares it. DEPLOYING it is migration-window work.
 */
const CAMPOS_DA_VARREDURA = [...CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON, '__name__'].map(
  (fieldPath) => ({ fieldPath, order: 'ASCENDING' }),
);

function serveAVarredura(indice: IndiceDeclarado): boolean {
  return (
    indice.collectionGroup === 'prodAmazon' &&
    indice.queryScope === 'COLLECTION_GROUP' &&
    JSON.stringify(indice.fields) === JSON.stringify(CAMPOS_DA_VARREDURA)
  );
}

describe('the Amazon stock reconcile walk’s index (step 12, PR 12-f)', () => {
  it('★ exactly ONE declared index serves it: prodAmazon, COLLECTION_GROUP, the conta ref then __name__, all ASCENDING', () => {
    const servem = indices.filter(serveAVarredura);
    expect(servem).toHaveLength(1);
    expect(servem[0]?.fields?.map((f) => f.fieldPath)).toEqual(['contaAmazonOuterRef', '__name__']);
  });

  it('★ NEAR-MISS: the order import’s (contaAmazonOuterRef, sku) entry does NOT satisfy the pin, nor the fields without __name__, a DESCENDING key or another scope', () => {
    const doPedido = indices.filter(
      (i) =>
        i.collectionGroup === 'prodAmazon' &&
        JSON.stringify(i.fields?.map((f) => f.fieldPath)) ===
          JSON.stringify(['contaAmazonOuterRef', 'sku']),
    );
    // Positive first: that entry is really there to be refused.
    expect(doPedido).toHaveLength(1);
    expect(doPedido.filter(serveAVarredura)).toEqual([]);
    const exato: IndiceDeclarado = {
      collectionGroup: 'prodAmazon',
      queryScope: 'COLLECTION_GROUP',
      fields: CAMPOS_DA_VARREDURA,
    };
    expect(serveAVarredura(exato)).toBe(true);
    expect(serveAVarredura({ ...exato, fields: CAMPOS_DA_VARREDURA.slice(0, -1) })).toBe(false);
    expect(
      serveAVarredura({
        ...exato,
        fields: CAMPOS_DA_VARREDURA.map((f, i) => (i === 1 ? { ...f, order: 'DESCENDING' } : f)),
      }),
    ).toBe(false);
    expect(serveAVarredura({ ...exato, queryScope: 'COLLECTION' })).toBe(false);
  });
});
