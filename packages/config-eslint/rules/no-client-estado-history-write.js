// Custom rule: the server-owned pedido audit trails have exactly ONE writer.
//
// `pedidos/{pedidoId}/historicoEstadoPedido` (the pedido `estado` trail) and
// `pedidos/{pedidoId}/historicoFtIni` (the `freteInicial.estado` trail) are both
// written exclusively by the `onPedidoEstadoChanged` Cloud Function
// (`apps/functions/src/pedidos/`): it observes every pedido write and appends one
// row to whichever of the two estados moved. One trigger, two trails — which is
// why this stayed ONE rule instead of forking per collection, and why the rule
// name still says `estado`: `freteInicial.estado` is an estado too. Both schemas
// mark the collection `meta.serverOwned`, so the generated Firestore rules deny
// every client create/update/delete with no `su` bypass.
//
// The rules are the real gate; this rule is the fast feedback loop. Before the
// trigger existed the estado row was appended by hand at three call sites, which
// is exactly the shape someone would reintroduce out of habit — and at runtime it
// now fails with `permission-denied` (silently, in the two places that used to
// swallow FirebaseError into a toast). Catching it at lint time turns a
// head-scratching missing-row bug into an inline error. `historicoFtIni` has
// never had a client writer IN THIS REPO — the legacy Flutter `Pedido.save()`
// does append to it, which is exactly why `serverOwned` denies that write and
// why guarding the new app from day one is what keeps the trigger sole owner.
//
// Two detectors, both narrow on purpose — READS must stay clean, since the
// Estado/Histórico tabs legitimately call `.ref()` / `.docRef()` on the same
// handles:
//
//  1. a write method (`set` / `add` / `merge` / `update` / `delete` / `create`)
//     invoked on one of the known collection handles, directly or through a
//     ref-returning hop (`historicoEstadoPedidoCollection.docRef(…).set(…)`);
//  2. a `PedidoWriteOp` object literal (`{ type: 'set', path: … }`) whose path
//     mentions one of the subcollections — the exact shape of the retired
//     `buildEstadoHistoryOp`.
//
// Variable indirection (`const ref = …docRef(…); tx.set(ref, …)`) is NOT caught;
// no lint rule can close that, which is why `serverOwned` exists.
//
// The handle→collection pairing lives in ONE table below so the two halves cannot
// drift: adding a trail is adding a row, and both detectors plus the message text
// pick it up. It is also what lets detector 1 name the collection it hit — it
// used to know only that *some* guarded handle was written.

/**
 * INVARIANT: no `subcollection` here may be a substring of another. Detector 2
 * matches path text with `String.prototype.includes` and takes the FIRST hit via
 * `.find()`, so an overlapping pair (say `historicoFtIni` / `historicoFtIniAux`)
 * would still fire but name the wrong collection — a silent wrong-message bug.
 * Pinned by a test in `no-client-estado-history-write.test.js` — which is why the
 * table is exported: the pin has to read the real thing, not a copy that drifts.
 */
export const OWNED_TRAILS = [
  {
    subcollection: 'historicoEstadoPedido',
    handles: ['historicoEstadoCollection', 'historicoEstadoPedidoCollection'],
  },
  {
    subcollection: 'historicoFtIni',
    handles: ['historicoFtIniCollection', 'historicoFreteInicialCollection'],
  },
];

const HANDLE_TO_SUBCOLLECTION = new Map(
  OWNED_TRAILS.flatMap(({ subcollection, handles }) =>
    handles.map((handle) => [handle, subcollection]),
  ),
);
const SUBCOLLECTIONS = OWNED_TRAILS.map(({ subcollection }) => subcollection);

const WRITE_METHODS = new Set(['set', 'add', 'merge', 'update', 'delete', 'create']);
const WRITE_OP_TYPES = new Set(['set', 'update', 'merge', 'delete']);

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

/**
 * Which guarded subcollection does this expression's source mention, if any?
 * Returns the NAME (not a boolean) so the report can name its hit.
 */
function matchedSubcollection(node, sourceCode) {
  if (!node) return null;
  const text = sourceCode.getText(node);
  return SUBCOLLECTIONS.find((subcollection) => text.includes(subcollection)) ?? null;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Never write the server-owned pedido audit trails ' +
        '(pedidos/{id}/historicoEstadoPedido, pedidos/{id}/historicoFtIni) from ' +
        'application code — the onPedidoEstadoChanged Cloud Function owns both.',
    },
    schema: [],
    messages: {
      serverOwned:
        'Do not write `{{collection}}` from application code. The ' +
        '`onPedidoEstadoChanged` Cloud Function (apps/functions/src/pedidos/) is the ' +
        'sole writer of both pedido audit trails — it observes every pedido write and ' +
        'records each estado transition (`estado` → historicoEstadoPedido, ' +
        '`freteInicial.estado` → historicoFtIni), so changing the field on the pedido ' +
        'is all you need to do. The collection is `meta.serverOwned`: this write would ' +
        'fail with `permission-denied` at runtime.',
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
        if (root === null) return;
        const collection = HANDLE_TO_SUBCOLLECTION.get(root);
        if (collection === undefined) return;
        context.report({ node, messageId: 'serverOwned', data: { collection } });
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
        const collection = matchedSubcollection(pathValue, sourceCode);
        if (collection === null) return;
        context.report({ node, messageId: 'serverOwned', data: { collection } });
      },
    };
  },
};

export default rule;
