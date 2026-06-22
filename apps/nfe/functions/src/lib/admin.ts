import { type App, getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';

let app: App | undefined;
let db: Firestore | undefined;

/**
 * Admin app singleton. In the Cloud Functions runtime `initializeApp()` picks up
 * Application Default Credentials + the ambient project. Initializes the
 * **default** app, so `getFunctions()` (in `lib/nfe/tasks.ts`) resolves it too.
 */
export function getAdminApp(): App {
  if (app) return app;
  app = getApps()[0] ?? initializeApp();
  return app;
}

/**
 * Firestore singleton on the named `default` database (Firestore Enterprise — the
 * database is literally named `default`, NOT `(default)`; repo-wide convention).
 * Calling `getFirestore()` without the id hits the non-existent `(default)`
 * database and fails every operation with gRPC `5 NOT_FOUND`.
 */
export function getDb(): Firestore {
  if (db) return db;
  const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
  db = getFirestore(getAdminApp(), databaseId);
  return db;
}
