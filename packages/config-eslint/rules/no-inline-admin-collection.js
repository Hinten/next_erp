// Custom rule: keep Admin-SDK collection handles in one place.
//
// `defineAdminCollection()` should only be CALLED from the canonical registry
// at `packages/data/src/admin/collections/` — app code imports the ready-made
// handle (`@delfrance/data/admin/collections`) instead of re-declaring one.
//
// The canonical owner is `@delfrance/data` — its `src/admin/**` holds the
// registry handles and the factory's own unit test, the one place
// `defineAdminCollection()` is *meant* to be called. That package has no
// eslint config today (its `lint` script is a no-op), but rather than rely on
// that, `create()` explicitly skips files under `packages/data/src/admin/**`
// so the rule's intent (guard rails for app code) holds even if the package is
// linted later. This is a distinct rule name, so it coexists with the apps'
// error-level `no-restricted-syntax` / `no-restricted-imports` overrides (flat
// config does full-replacement per rule name, never across names).
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
    // The canonical owner package is where the factory is *supposed* to be
    // called (registry handles + the defineAdminCollection unit test). Skip it
    // so this app-facing guard never fires on @delfrance/data itself.
    const filename = (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
    if (filename.includes('/packages/data/src/admin/')) {
      return {};
    }
    return {
      "CallExpression[callee.name='defineAdminCollection']"(node) {
        context.report({ node, messageId: 'moveToCanonical' });
      },
    };
  },
};

export default rule;
