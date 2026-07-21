// Custom rule: in the Firestore schemas, `.optional()` must always be paired
// with `.nullable()`.
//
// The Firebase JS SDK rejects `undefined` in `addDoc`/`setDoc`:
//
//   Function addDoc() called with invalid data ... Unsupported field value: undefined
//
// A field declared `.optional()` alone parses to `T | undefined`, so the moment
// a form leaves it blank the write throws at runtime. `.nullable()` makes the
// parsed type `T | null` instead — the field is always present and Firestore
// stores `null` cleanly.
//
// Flagged:
//   - `z.string().optional()`            — nothing else in the chain
//
// NOT flagged (both orders are equivalent and both are correct):
//   - `z.string().nullable().optional()` — the documented shape for
//                                          server-stamped fields the client
//                                          never writes (e.g. `timestamp`,
//                                          `ultimaModificacao`)
//   - `z.string().optional().nullable()`
//   - `z.string().nullable().default(null)` — no `.optional()` at all, the
//                                          default shape for an optional field
//
// Scope: `packages/schemas/src/**` only. Elsewhere `.optional()` is a perfectly
// ordinary Zod modifier (function-argument validation, form-only schemas,
// wire-format parsers) and this invariant does not apply — the rule self-scopes
// by path rather than relying on every consumer to configure `files`.
//
// Error (not warn): a bare `.optional()` on a persisted field is a latent
// runtime crash on the first blank input, not a style preference.

const SCOPE = '/packages/schemas/src/';

/**
 * Member name of a `MemberExpression`, normalized across dot AND bracket
 * access: `x.optional` and `x['optional']` both return `'optional'`, so the
 * rule can't be bypassed by bracket notation.
 */
function memberName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  const prop = member.property;
  if (!member.computed && prop.type === 'Identifier') return prop.name;
  if (member.computed && prop.type === 'Literal' && typeof prop.value === 'string') {
    return prop.value;
  }
  return null;
}

/**
 * Walk DOWN the receiver chain from a call node, collecting every method name.
 * `z.string().nullable().optional()` → from the `.optional()` call this yields
 * ['nullable', 'string'].
 */
function methodsBefore(callNode) {
  const names = [];
  let cur = callNode.callee?.object;
  while (cur) {
    if (cur.type === 'CallExpression') {
      const name = memberName(cur.callee);
      if (name) names.push(name);
      cur = cur.callee?.object;
    } else if (cur.type === 'MemberExpression') {
      cur = cur.object;
    } else {
      break;
    }
  }
  return names;
}

/**
 * Walk UP the chain from a call node, collecting every method applied after it.
 * `z.string().optional().nullable()` → from the `.optional()` call this yields
 * ['nullable'].
 */
function methodsAfter(callNode) {
  const names = [];
  let node = callNode;
  for (;;) {
    const parent = node.parent;
    if (!parent) break;
    // `<node>.foo` — the call is the receiver of the next member access.
    if (parent.type !== 'MemberExpression' || parent.object !== node) break;
    const grand = parent.parent;
    if (!grand || grand.type !== 'CallExpression' || grand.callee !== parent) break;
    const name = memberName(parent);
    if (name) names.push(name);
    node = grand;
  }
  return names;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'In packages/schemas, `.optional()` must be paired with `.nullable()` — ' +
        'the Firebase SDK rejects `undefined` in addDoc/setDoc.',
    },
    schema: [],
    messages: {
      bare:
        '`.optional()` without `.nullable()` lets `undefined` reach Firestore, which ' +
        'rejects it ("Unsupported field value: undefined"). Use `.nullable().default(null)` ' +
        'for a normal optional field, or `.nullable().optional()` for a server-stamped ' +
        'field the client never writes.',
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
    if (!filename.includes(SCOPE)) return {};

    return {
      CallExpression(node) {
        if (memberName(node.callee) !== 'optional') return;
        // `.optional()` takes no arguments in the shapes we care about; a call
        // with arguments is not the Zod modifier.
        if (node.arguments.length > 0) return;

        const chain = [...methodsBefore(node), ...methodsAfter(node)];
        if (chain.includes('nullable')) return;

        context.report({ node, messageId: 'bare' });
      },
    };
  },
};

export default rule;
