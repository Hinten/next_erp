// Custom rule: keep Admin-SDK collection handles in one place.
//
// `defineAdminCollection()` should only be CALLED from the canonical registry
// at `packages/data/src/admin/collections/` — app code imports the ready-made
// handle (`@delfrance/data/admin/collections`) instead of re-declaring one.
//
// The canonical folder lives in `@delfrance/data`, which has no eslint config
// (its `lint` script is a no-op), so it never trips this rule — it self-exempts.
// This is a distinct rule name, so it coexists with the apps' error-level
// `no-restricted-syntax` / `no-restricted-imports` overrides (flat config does
// full-replacement per rule name, never across names).
//
// Warn, not error: it's a guard against backsliding, not a hard gate.
const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Define Admin-SDK collection handles in @delfrance/data/admin/collections, not in app code.',
    },
    schema: [],
    messages: {
      moveToCanonical:
        'Define admin collection handles in packages/data/src/admin/collections ' +
        '(@delfrance/data/admin/collections), then import the ready-made handle. ' +
        'Do not call defineAdminCollection() in app code.',
    },
  },
  create(context) {
    return {
      "CallExpression[callee.name='defineAdminCollection']"(node) {
        context.report({ node, messageId: 'moveToCanonical' });
      },
    };
  },
};

export default rule;
