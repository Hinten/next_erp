import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAMPOS_INDICE_VINCULO_AMAZON } from './produto/collection/amazonLink';

/**
 * The Amazon order import (Amazon step 5) resolves an order line to its ERP
 * produto through the link docs, by FIELDS: a collection-group query
 * `prodAmazon where contaAmazonOuterRef in [<the conta's ref forms>] and
 * sku == <the line's seller SKU>`.
 *
 * On this Enterprise database a query with no matching index does not fail: it
 * full-scans every link doc of every produto and bills the data scanned. So the
 * index is pinned here against the ONE spelling of the query's fields,
 * `CAMPOS_INDICE_VINCULO_AMAZON` (imported from the schema module: this package
 * cannot import `@delfrance/data`, which depends on it). The query's own pin,
 * next to the query, lands with the query.
 *
 * ⚠️ No trailing `__name__`: Enterprise omits the implicit one, and an index
 * copied with it from Standard-edition docs is a different index.
 */

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not find pnpm-workspace.yaml above ' + startDir);
}

const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const parsed = JSON.parse(readFileSync(resolve(repoRoot, 'firestore.indexes.json'), 'utf8')) as {
  indexes?: Array<{
    collectionGroup?: string;
    queryScope?: string;
    fields?: Array<{ fieldPath?: string; order?: string }>;
  }>;
};

const doProdAmazon = (parsed.indexes ?? []).filter((i) => i.collectionGroup === 'prodAmazon');

describe('the Amazon link-doc index (Amazon step 5)', () => {
  it('declares exactly one prodAmazon index, and it is COLLECTION_GROUP scope', () => {
    expect(doProdAmazon).toHaveLength(1);
    expect(doProdAmazon[0]?.queryScope).toBe('COLLECTION_GROUP');
  });

  it('★ its fields are CAMPOS_INDICE_VINCULO_AMAZON, in that order, both ASCENDING, no __name__', () => {
    expect(doProdAmazon[0]?.fields).toEqual(
      CAMPOS_INDICE_VINCULO_AMAZON.map((fieldPath) => ({ fieldPath, order: 'ASCENDING' })),
    );
    expect(doProdAmazon[0]?.fields?.map((f) => f.fieldPath)).toEqual([
      'contaAmazonOuterRef',
      'sku',
    ]);
  });
});
