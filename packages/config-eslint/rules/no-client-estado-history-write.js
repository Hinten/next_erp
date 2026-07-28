// Custom rule: the pedido estado audit trail has exactly ONE writer.
//
// `pedidos/{pedidoId}/historicoEstadoPedido` is written exclusively by the
// `onPedidoEstadoChanged` Cloud Function (`apps/functions/src/pedidos/`), which
// observes every pedido write and appends one row per `estado` transition. The
// schema marks the collection `meta.serverOwned`, so the generated Firestore
// rules deny every client create/update/delete with no `su` bypass.
//
// The rules are the real gate; this rule is the fast feedback loop. Before the
// trigger existed the row was appended by hand at three call sites, which is
// exactly the shape someone would reintroduce out of habit — and at runtime it
// now fails with `permission-denied` (silently, in the two places that used to
// swallow FirebaseError into a toast). Catching it at lint time turns a
// head-scratching missing-row bug into an inline error.
//
// Two detectors, both narrow on purpose — READS must stay clean, since the
// Estado/Histórico tab legitimately calls `.ref()` / `.docRef()` on the same
// handle:
//
//  1. a write method (`set` / `add` / `merge` / `update` / `delete` / `create`)
//     invoked on one of the known collection handles, directly or through a
//     ref-returning hop (`historicoEstadoPedidoCollection.docRef(…).set(…)`);
//  2. a `PedidoWriteOp` object literal (`{ type: 'set', path: … }`) whose path
//     mentions the subcollection — the exact shape of the retired
//     `buildEstadoHistoryOp`.
//
// Variable indirection (`const ref = …docRef(…); tx.set(ref, …)`) is NOT caught;
// no lint rule can close that, which is why `serverOwned` exists.
const HANDLE_NAMES = new Set(['historicoEstadoCollection', 'historicoEstadoPedidoCollection']);
const WRITE_METHODS = new Set(['set', 'add', 'merge', 'update', 'delete', 'create']);
const WRITE_OP_TYPES = new Set(['set', 'update', 'merge', 'delete']);
const SUBCOLLECTION = 'historicoEstadoPedido';

/**
 * Walk `a.b(…).c(…).d` down to the identifier it started from, seeing through
 * TS casts and non-null assertions so `(handle as X).set(…)` and `handle!.set(…)`
 * are not free passes.
 */
function rootIdentifierName(node) {
  let current = node;
  for (;;) {
    switch (current.type) {
      case 'Identifier':
        return current.name;
      case 'MemberExpression':
        current = current.object;
        break;
      case 'CallExpression':
        current = current.callee;
        break;
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'ChainExpression':
        current = current.expression;
        break;
      default:
        return null;
    }
  }
}

/** Does this expression's source mention the subcollection segment? */
function mentionsSubcollection(node, sourceCode) {
  if (!node) return false;
  return sourceCode.getText(node).includes(SUBCOLLECTION);
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Never write pedidos/{id}/historicoEstadoPedido from application code — the onPedidoEstadoChanged Cloud Function owns it.',
    },
    schema: [],
    messages: {
      serverOwned:
        'Do not write `historicoEstadoPedido` from application code. The ' +
        '`onPedidoEstadoChanged` Cloud Function (apps/functions/src/pedidos/) is its ' +
        'sole writer — it observes every pedido write and records each `estado` ' +
        'transition, so changing `estado` is all you need to do. The collection is ' +
        '`meta.serverOwned`: this write would fail with `permission-denied` at runtime.',
    },
  },
  create(context) {
    // apps/functions is the legitimate writer. Skipped by path so the rule holds
    // even though that package lints with the same shared base config.
    const filename = (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
    if (filename.includes('/apps/functions/')) return {};

    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      // (1) historicoEstadoCollection.set(…) / …docRef(…).set(…)
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier') return;
        if (!WRITE_METHODS.has(callee.property.name)) return;
        const root = rootIdentifierName(callee.object);
        if (root === null || !HANDLE_NAMES.has(root)) return;
        context.report({ node, messageId: 'serverOwned' });
      },

      // (2) { type: 'set', path: `pedidos/${id}/historicoEstadoPedido/${docId}` }
      ObjectExpression(node) {
        let isWriteOp = false;
        let pathValue = null;
        for (const prop of node.properties) {
          if (prop.type !== 'Property' || prop.computed || prop.key.type !== 'Identifier') continue;
          if (
            prop.key.name === 'type' &&
            prop.value.type === 'Literal' &&
            WRITE_OP_TYPES.has(prop.value.value)
          ) {
            isWriteOp = true;
          }
          if (prop.key.name === 'path') pathValue = prop.value;
        }
        if (!isWriteOp || pathValue === null) return;
        if (!mentionsSubcollection(pathValue, sourceCode)) return;
        context.report({ node, messageId: 'serverOwned' });
      },
    };
  },
};

export default rule;
