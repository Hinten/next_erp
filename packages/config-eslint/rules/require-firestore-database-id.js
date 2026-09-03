/**
 * `getFirestore()` must name the database. A bare call is forbidden.
 *
 * WHY. This project's Firestore is **Enterprise edition**, where the database is
 * literally named `default` — not `(default)`, the sentinel the SDKs fall back
 * to when no id is passed. So `getFirestore(app)` resolves a database that does
 * not exist and **every operation** on the handle fails with `5 NOT_FOUND`.
 *
 * The failure is total but it is not local: the throw happens at the first
 * read/write, arbitrarily far from the handle that caused it, and it looks like
 * a permissions or connectivity problem rather than a missing argument. The
 * correct call is one line away and reads almost identically, which is exactly
 * what makes the mistake easy to copy.
 *
 * Today there are **zero** bare call sites — the id is threaded through
 * `process.env.FIREBASE_DATABASE_ID ?? 'default'` in each backend's
 * `lib/firebase/admin.ts` and its nested `functions/src/lib/admin.ts`. That is
 * the whole reason this is `error` rather than a ratchet (the condition this
 * repo states for `error`; see `no-unvalidated-response`). But it is a
 * convention agreed by SEVEN copies of the same file across five codebases,
 * held together by a comment in each — and three of those comments say the same
 * sentence about `(default)` in three slightly different ways. A convention
 * maintained by copy-paste across codebases is one nobody is enforcing.
 *
 * ⚠️ This is a distinct rule NAME rather than another `no-restricted-syntax`
 * selector, and that is load-bearing. Flat config does full replacement per rule
 * name, and six workspaces already rebuild the base's `no-restricted-syntax`
 * array by hand (`baseRestrictedSyntax`) while `packages/integrations/nfe` turns
 * it off entirely — so a selector added there would be silently absent from the
 * backends that own every one of these call sites. Same reasoning as
 * `no-error-as-sole-instanceof`.
 *
 * WHAT IS FLAGGED. `getFirestore()` with no arguments, and `getFirestore(app)`
 * with exactly one — both resolve `(default)`.
 *
 * WHAT IS DELIBERATELY NOT FLAGGED:
 *   - Any call passing two or more arguments; the second IS the database id, and
 *     whether that id is correct is not a syntactic question.
 *   - `getFirestore` used as a value (`vi.mock`, a re-export, an import) — only a
 *     CALL can reach the wrong database.
 *   - Comments and docs, which must stay free to explain the trap.
 */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Call getFirestore(app, databaseId) — a bare getFirestore() resolves `(default)`, which does not exist on this Enterprise project.',
    },
    schema: [],
    messages: {
      missingDatabaseId:
        "getFirestore() must name the database. This project is Firestore ENTERPRISE, where the database is named `default` — not the `(default)` sentinel a 0- or 1-argument call resolves — so every operation on this handle would fail with `5 NOT_FOUND`. Pass it explicitly: `getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default')`, or reuse the shared handle from your app's `lib/firebase/admin.ts`.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        const isBare = callee.type === 'Identifier' && callee.name === 'getFirestore';
        const isMember =
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'getFirestore';
        if (!isBare && !isMember) return;
        if (node.arguments.length >= 2) return;
        // A spread could carry the id at runtime; the rule cannot know.
        if (node.arguments.some((a) => a.type === 'SpreadElement')) return;
        context.report({ node, messageId: 'missingDatabaseId' });
      },
    };
  },
};

export default rule;
