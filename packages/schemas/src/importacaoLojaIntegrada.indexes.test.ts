import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  importacaoLojaIntegradaMeta,
  importacaoLojaIntegradaSchema,
} from './importacaoLojaIntegrada';

/**
 * The Loja Integrada product import (master plan step 9) reads a conta's jobs with ONE query —
 * `importacoesLojaIntegrada where integracaoId == <conta> orderBy iniciadoEmMs desc limit 10` —
 * for the start guard (one running job per conta), the web's list of runs and the tax-review
 * carry-forward. The job collection has no `meta.defaultQuery`, so
 * `delfrance/default-query-needs-index` cannot see this query; on this Enterprise database a query
 * with no matching index does not fail, it full-scans and bills the data scanned. So the index is
 * pinned here, against the job schema's own field names, and its ORDER: an ascending
 * `iniciadoEmMs` composite does not serve the descending read.
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

describe('the Loja Integrada import job index (step 9)', () => {
  it('declares exactly one (integracaoId ASC, iniciadoEmMs DESC) collection index', () => {
    const matches = (parsed.indexes ?? []).filter(
      (index) => index.collectionGroup === importacaoLojaIntegradaMeta.collectionPath,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.queryScope).toBe('COLLECTION');
    expect(matches[0]?.fields).toEqual([
      { fieldPath: 'integracaoId', order: 'ASCENDING' },
      { fieldPath: 'iniciadoEmMs', order: 'DESCENDING' },
    ]);
  });

  it('names fields the job schema really has', () => {
    const campos = Object.keys(importacaoLojaIntegradaSchema.shape);
    expect(campos).toContain('integracaoId');
    expect(campos).toContain('iniciadoEmMs');
  });
});
