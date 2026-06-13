import { afterAll, describe, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import rule from './default-query-needs-index.js';

// Wire RuleTester to vitest's runner (it calls describe/it at module load).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const here = dirname(fileURLToPath(import.meta.url));
const okPath = resolve(here, '__fixtures__/indexes-ok.json');
const emptyPath = resolve(here, '__fixtures__/indexes-empty.json');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('default-query-needs-index', rule, {
  valid: [
    {
      name: 'index present for a simple orderBy',
      code: `const m = { collectionPath: 'clientes', defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' }], limit: 50 } };`,
      options: [{ indexesPath: okPath }],
    },
    {
      name: 'index present for where + orderBy',
      code: `const m = { collectionPath: 'produtos', defaultQuery: { where: [{ field: 'paiId', value: null }], orderBy: [{ field: 'nome', direction: 'asc' }], limit: 50 } };`,
      options: [{ indexesPath: okPath }],
    },
    {
      name: 'no collectionPath sibling — rule does not fire (even on a non-literal)',
      code: `const BASE = {}; const m = { defaultQuery: { ...BASE, orderBy: [] } };`,
      options: [{ indexesPath: emptyPath }],
    },
  ],
  invalid: [
    {
      name: 'missing index reports with paste-able JSON',
      code: `const m = { collectionPath: 'clientes', defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' }], limit: 50 } };`,
      options: [{ indexesPath: emptyPath }],
      errors: [{ messageId: 'missingIndex' }],
    },
    {
      name: 'non-literal defaultQuery (spread) reports notStaticLiteral',
      code: `const BASE = {}; const m = { collectionPath: 'clientes', defaultQuery: { ...BASE, orderBy: [{ field: 'nome', direction: 'asc' }], limit: 50 } };`,
      options: [{ indexesPath: okPath }],
      errors: [{ messageId: 'notStaticLiteral' }],
    },
    {
      name: 'identifier value reports notStaticLiteral',
      code: `const LIMIT = 50; const m = { collectionPath: 'clientes', defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' }], limit: LIMIT } };`,
      options: [{ indexesPath: okPath }],
      errors: [{ messageId: 'notStaticLiteral' }],
    },
  ],
});
