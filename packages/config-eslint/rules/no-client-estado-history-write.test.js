import { afterAll, describe, expect, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule, { OWNED_TRAILS } from './no-client-estado-history-write.js';

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
const SCHEMAS_FILE = '/repo/packages/schemas/src/pedido/collection/pedido.ts';
const DATA_FILE = '/repo/packages/data/src/admin/collections/historicoFreteInicialCollection.ts';

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

    // Same three shapes on the freteInicial trail — its Frete tab reads the
    // history exactly the same way.
    {
      name: 'ref() on the frete trail for a snapshot read',
      filename: APP_FILE,
      code: `const base = historicoFtIniCollection.ref(db, { pedidoId });`,
    },
    {
      name: 'docRef() alone on the frete trail is not a write',
      filename: APP_FILE,
      code: `const r = historicoFreteInicialCollection.docRef(db, { pedidoId }, id);`,
    },
    {
      name: 'parse() on the frete trail is validation, not a write',
      filename: APP_FILE,
      code: `const row = historicoFreteInicialCollection.parse(data);`,
    },

    // apps/functions is the legitimate writer — of BOTH trails, from the one
    // onPedidoEstadoChanged trigger.
    {
      name: 'the trigger itself may write',
      filename: FUNCTIONS_FILE,
      code: `await historicoEstadoPedidoCollection.docRef(db, { pedidoId }, id).set(entry);`,
    },
    {
      name: 'the trigger itself may write the frete trail',
      filename: FUNCTIONS_FILE,
      code: `await historicoFreteInicialCollection.docRef(db, { pedidoId }, id).set(entry);`,
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
    {
      name: 'a non-write op mentioning the frete path (e.g. a read helper)',
      filename: APP_FILE,
      code: `const p = \`pedidos/\${pedidoId}/historicoFtIni/\${docId}\`;`,
    },

    // The two object literals that legitimately pair the collection name with a
    // `path` key. Neither has a key named `type`, which is the ONLY thing keeping
    // detector 2 off them — pinned here because a laxer isWriteOp check (say,
    // "has a path that mentions the subcollection") would red the whole repo.
    {
      name: 'defineAdminCollection trips neither detector',
      filename: DATA_FILE,
      code: `
        export const historicoFreteInicialCollection = defineAdminCollection({
          path: historicoFreteInicialMeta.collectionPath,
          schema: historicoFreteInicialSchema,
        });
      `,
    },
    {
      name: 'the pedido cascade entry for the frete trail (path + onDelete, no type key)',
      filename: SCHEMAS_FILE,
      code: `const cascade = [{ path: 'pedidos/{pedidoId}/historicoFtIni', onDelete: 'cascade' }];`,
    },
  ],

  invalid: [
    {
      name: 'set() on the client handle',
      filename: APP_FILE,
      code: `await historicoEstadoCollection.set(db, { pedidoId }, id, data);`,
      // Detector 1 must name the collection it resolved through the handle map,
      // not just fire. Without this the map could point every handle at the
      // wrong trail and the suite would stay green.
      errors: [{ messageId: 'serverOwned', data: { collection: 'historicoEstadoPedido' } }],
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
      // Detector 2's counterpart pin: the reported name has to come from the
      // matched entry, which is why the lookup returns a name and not a boolean.
      errors: [{ messageId: 'serverOwned', data: { collection: 'historicoEstadoPedido' } }],
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

    // Every shape above, again on the freteInicial trail.
    {
      name: 'set() on the frete-trail handle',
      filename: APP_FILE,
      code: `await historicoFtIniCollection.set(db, { pedidoId }, id, data);`,
      errors: [{ messageId: 'serverOwned', data: { collection: 'historicoFtIni' } }],
    },
    {
      name: 'add() on the frete-trail handle',
      filename: APP_FILE,
      code: `await historicoFtIniCollection.add(db, { pedidoId }, data);`,
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'set() on the frete trail through the docRef hop',
      filename: APP_FILE,
      code: `await historicoFtIniCollection.docRef(db, { pedidoId }, id).set(row);`,
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'delete() on the frete-trail handle',
      filename: APP_FILE,
      code: `await historicoFtIniCollection.docRef(db, ctx, id).delete();`,
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'a set write op targeting the frete trail',
      filename: APP_FILE,
      code: `
        const op = {
          type: 'set',
          path: \`pedidos/\${pedidoId}/historicoFtIni/\${port.newId()}\`,
          data: { estado, data: port.now() },
        };
      `,
      errors: [{ messageId: 'serverOwned', data: { collection: 'historicoFtIni' } }],
    },
    {
      name: 'a delete write op targeting the frete trail with a plain string path',
      filename: APP_FILE,
      code: `const op = { type: 'delete', path: 'pedidos/p1/historicoFtIni/h1' };`,
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'the historicoFreteInicialCollection alias is guarded too',
      filename: APP_FILE,
      code: `await historicoFreteInicialCollection.create(db, { pedidoId }, id, entry);`,
      errors: [{ messageId: 'serverOwned' }],
    },
    {
      name: 'a type cast on the frete-trail handle is not a free pass',
      filename: APP_FILE,
      code: `await (historicoFtIniCollection as Handle).set(db, { pedidoId }, id, data);`,
      languageOptions: { parser: tsParser },
      errors: [{ messageId: 'serverOwned' }],
    },
  ],
});

// Detector 2 matches path text with `includes()` and keeps the FIRST `.find()`
// hit, so an entry that is a substring of another would still report — under the
// wrong collection name. Nothing else in the suite would notice, hence the pin.
it('has no OWNED_TRAILS subcollection that is a substring of another', () => {
  const names = OWNED_TRAILS.map(({ subcollection }) => subcollection);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = 0; j < names.length; j += 1) {
      if (i === j) continue;
      expect(names[j].includes(names[i])).toBe(false);
    }
  }
});
