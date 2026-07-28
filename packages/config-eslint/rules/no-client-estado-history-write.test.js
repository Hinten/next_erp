import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './no-client-estado-history-write.js';

// The TS-syntax cases below need the TS parser; the rest run on the default one.
const tsParser = tseslint.parser;

// Wire RuleTester to vitest's runner (it calls describe/it at module load).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const APP_FILE = '/repo/apps/web/lib/pedidos/clientPort.ts';
const FUNCTIONS_FILE = '/repo/apps/functions/src/pedidos/registrarEstadoPedido.ts';

ruleTester.run('no-client-estado-history-write', rule, {
  valid: [
    // READS on the same handle must stay clean — the Estado/Histórico tab.
    {
      name: 'ref() for a snapshot read',
      filename: APP_FILE,
      code: `const base = historicoEstadoCollection.ref(db, { pedidoId });`,
    },
    {
      name: 'docRef() alone is not a write',
      filename: APP_FILE,
      code: `const r = historicoEstadoCollection.docRef(db, { pedidoId }, id);`,
    },
    {
      name: 'parse() is validation, not a write',
      filename: APP_FILE,
      code: `const row = historicoEstadoPedidoCollection.parse(data);`,
    },

    // apps/functions is the legitimate writer.
    {
      name: 'the trigger itself may write',
      filename: FUNCTIONS_FILE,
      code: `await historicoEstadoPedidoCollection.docRef(db, { pedidoId }, id).set(entry);`,
    },

    // Other collections are untouched by this rule.
    {
      name: 'a different collection handle',
      filename: APP_FILE,
      code: `await incidenteCollection.set(db, { pedidoId }, id, data);`,
    },
    {
      name: 'a write op for another subcollection',
      filename: APP_FILE,
      code: `const op = { type: 'set', path: \`pedidos/\${pedidoId}/incidentes/\${docId}\` };`,
    },
    {
      name: 'a non-write op mentioning the path (e.g. a read helper)',
      filename: APP_FILE,
      code: `const p = \`pedidos/\${pedidoId}/historicoEstadoPedido/\${docId}\`;`,
    },
  ],

  invalid: [
    {
      name: 'set() on the client handle',
      filename: APP_FILE,
      code: `await historicoEstadoCollection.set(db, { pedidoId }, id, data);`,
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'add() on the client handle',
      filename: APP_FILE,
      code: `await historicoEstadoCollection.add(db, { pedidoId }, data);`,
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'set() through the docRef hop',
      filename: APP_FILE,
      code: `await historicoEstadoPedidoCollection.docRef(db, { pedidoId }, id).set(row);`,
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'delete() on the admin handle',
      filename: APP_FILE,
      code: `await historicoEstadoPedidoCollection.docRef(db, ctx, id).delete();`,
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'the retired buildEstadoHistoryOp shape',
      filename: APP_FILE,
      code: `
        const op = {
          type: 'set',
          path: \`pedidos/\${pedidoId}/historicoEstadoPedido/\${port.newId()}\`,
          data: { estado, data: port.now() },
        };
      `,
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'a delete write op targeting the subcollection',
      filename: APP_FILE,
      code: `const op = { type: 'delete', path: 'pedidos/p1/historicoEstadoPedido/h1' };`,
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'a non-null assertion is not a free pass',
      filename: APP_FILE,
      code: `await historicoEstadoCollection!.set(db, { pedidoId }, id, data);`,
      languageOptions: { parser: tsParser },
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'a type cast is not a free pass',
      filename: APP_FILE,
      code: `await (historicoEstadoCollection as Handle).set(db, { pedidoId }, id, data);`,
      languageOptions: { parser: tsParser },
      errors: [{ messageId: 'serverOwned' }],
    },
  ],
});
