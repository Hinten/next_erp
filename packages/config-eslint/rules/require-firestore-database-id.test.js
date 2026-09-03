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
  ],
});
