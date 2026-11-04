import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { produtoLojaIntegradaLinkSchema } from './produto/collection/lojaIntegradaLink';

/**
 * The Loja Integrada order import (master plan step 5) resolves an order line
 * to its ERP produto through the link docs, by FIELDS — never by a computed doc
 * id, because the migrated link docs have mixed ids: a collection-group query
 * `produtolojaintegrada where contaLojaIntegrada in [<the conta's ref forms>]
 * and id == <LI produto id>`.
 *
 * On this Enterprise database a query with no matching index does not fail: it
 * full-scans every link doc of every produto and bills the data scanned. So the
 * index is pinned here, against the link schema's own field names, until the
 * query that uses it lands with its own pin (PR 5-c).
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

describe('the Loja Integrada link-doc index (step 5)', () => {
  it('declares exactly one collection-group (contaLojaIntegrada ASC, id ASC) index', () => {
    const matches = (parsed.indexes ?? []).filter(
      (index) =>
        index.collectionGroup === 'produtolojaintegrada' && index.queryScope === 'COLLECTION_GROUP',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.fields).toEqual([
      { fieldPath: 'contaLojaIntegrada', order: 'ASCENDING' },
      { fieldPath: 'id', order: 'ASCENDING' },
    ]);
  });

  it('names fields the link schema really has', () => {
    const campos = Object.keys(produtoLojaIntegradaLinkSchema.shape);
    expect(campos).toContain('contaLojaIntegrada');
    expect(campos).toContain('id');
  });
});
