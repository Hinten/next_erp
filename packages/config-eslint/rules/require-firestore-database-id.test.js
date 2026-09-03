import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from './require-firestore-database-id.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('require-firestore-database-id', rule, {
  valid: [
    {
      name: 'the shape every backend admin.ts uses',
      code: `const db = getFirestore(getAdminApp(), process.env.FIREBASE_DATABASE_ID ?? 'default');`,
    },
    {
      name: 'a literal id',
      code: `getFirestore(app, 'default');`,
    },
    {
      name: 'namespaced call with an id',
      code: `admin.getFirestore(app, databaseId);`,
    },
    {
      name: 'a spread may carry the id at runtime',
      code: `getFirestore(...args);`,
    },
    {
      name: 'a reference, not a call',
      code: `vi.mock('firebase-admin/firestore', () => ({ getFirestore }));`,
    },
    {
      name: 'an unrelated function of the same arity',
      code: `getAuth(app);`,
    },
    {
      // The real apps/web call: the id is the THIRD argument, because
      // initializeFirestore takes a settings object second.
      name: 'initializeFirestore WITH the id (apps/web/lib/firebase/client.ts)',
      code: `db = initializeFirestore(getFirebaseApp(), { localCache: persistentLocalCache() }, databaseId);`,
    },
    {
      name: 'initializeFirestore with a literal id',
      code: `initializeFirestore(app, settings, 'default');`,
    },
  ],
  invalid: [
    {
      name: 'no arguments at all',
      code: `const db = getFirestore();`,
      errors: [{ messageId: 'missingDatabaseId' }],
    },
    {
      name: 'app only — still resolves the `(default)` sentinel',
      code: `const db = getFirestore(getAdminApp());`,
      errors: [{ messageId: 'missingDatabaseId' }],
    },
    {
      name: 'namespaced, app only',
      code: `const db = admin.getFirestore(app);`,
      errors: [{ messageId: 'missingDatabaseId' }],
    },
    {
      // ⚠️ The case a single `>= 2` arity threshold waved through. This is the
      // DOCUMENTED two-argument shape everywhere outside this repo, and it
      // resolves `(default)` — so it must report even though it passes two args.
      name: 'initializeFirestore(app, settings) — two args, but the id is the third',
      code: `db = initializeFirestore(app, { localCache: persistentLocalCache() });`,
      errors: [{ messageId: 'missingDatabaseId' }],
    },
    {
      name: 'initializeFirestore with the app only',
      code: `initializeFirestore(app);`,
      errors: [{ messageId: 'missingDatabaseId' }],
    },
    {
      name: 'initializeFirestore with no arguments',
      code: `initializeFirestore();`,
      errors: [{ messageId: 'missingDatabaseId' }],
    },
  ],
});
