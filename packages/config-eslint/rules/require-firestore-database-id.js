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
 * WHAT IS FLAGGED. A call that does not reach its database-id argument:
 *
 *   - `getFirestore()` / `getFirestore(app)` — the id is argument **1**;
 *   - `initializeFirestore(app, settings)` — the id is argument **2**.
 *
 * ⚠️ The two arities differ, and a single `>= 2` threshold silently exempts the
 * second. That is not hypothetical: `apps/web/lib/firebase/client.ts` holds the
 * repo's most-used Firestore handle and deliberately uses `initializeFirestore`
 * rather than `getFirestore`, to enable the IndexedDB persistent cache with
 * multi-tab coordination. Its call is correct today — three arguments, the id
 * last — and its own comment says "the 3rd positional arg pins the named
 * database (`default`, not `(default)`)". But `initializeFirestore(app, settings)`
 * is the DOCUMENTED two-argument shape everywhere outside this repo, it resolves
 * `(default)`, and under one flat threshold it would have passed this rule while
 * failing every read in the browser. So the required arity is keyed off the name.
 *
 * WHAT IS DELIBERATELY NOT FLAGGED:
 *   - A call that DOES pass its id argument. Whether that id is the right string
 *     is not a syntactic question.
 *   - Either name used as a value (`vi.mock`, a re-export, an import) — only a
 *     CALL can reach the wrong database.
 *   - Comments and docs, which must stay free to explain the trap.
 */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Give getFirestore / initializeFirestore their database-id argument — without it they resolve `(default)`, which does not exist on this Enterprise project.',
    },
    schema: [],
    messages: {
      missingDatabaseId:
        "{{name}}() must name the database. This project is Firestore ENTERPRISE, where the database is named `default` — not the `(default)` sentinel a call missing that argument resolves — so every operation on this handle would fail with `5 NOT_FOUND`. Pass it explicitly — `getFirestore(app, databaseId)` or `initializeFirestore(app, settings, databaseId)`, with `process.env.FIREBASE_DATABASE_ID ?? 'default'` — or reuse the shared handle from your app's `lib/firebase/admin.ts` / `lib/firebase/client.ts`.",
    },
  },
  create(context) {
    /**
     * Zero-based index of the database-id argument, per callee. `getFirestore`
     * takes `(app?, databaseId?)`; `initializeFirestore` takes
     * `(app, settings, databaseId?)`. A shared threshold would exempt the
     * second — see the header.
     */
    const ID_ARG_INDEX = new Map([
      ['getFirestore', 1],
      ['initializeFirestore', 2],
    ]);

    return {
      CallExpression(node) {
        const callee = node.callee;
        let name = null;
        if (callee.type === 'Identifier') {
          name = callee.name;
        } else if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier'
        ) {
          name = callee.property.name;
        }
        const idIndex = name == null ? undefined : ID_ARG_INDEX.get(name);
        if (idIndex === undefined) return;
        if (node.arguments.length > idIndex) return;
        // A spread could carry the id at runtime; the rule cannot know.
        if (node.arguments.some((a) => a.type === 'SpreadElement')) return;
        context.report({ node, messageId: 'missingDatabaseId', data: { name } });
      },
    };
  },
};

export default rule;
