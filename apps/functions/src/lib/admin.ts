import { type App, getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';

let app: App | undefined;
let db: Firestore | undefined;

/**
 * Admin app singleton. In the Cloud Functions runtime `initializeApp()` picks
 * up Application Default Credentials + the ambient project; against the
 * emulators the admin SDK auto-detects `FIRESTORE_EMULATOR_HOST` /
 * `STORAGE_EMULATOR_HOST`.
 */
export function getAdminApp(): App {
  if (app) return app;
  app = getApps()[0] ?? initializeApp();
  return app;
}

/**
 * Firestore singleton. Uses the `(default)` database unless
 * `FIREBASE_DATABASE_ID` names another — `(default)` keeps the emulator path
 * simple.
 */
export function getDb(): Firestore {
  if (db) return db;
  const databaseId = process.env.FIREBASE_DATABASE_ID;
  db = databaseId
    ? getFirestore(getAdminApp(), databaseId)
    : getFirestore(getAdminApp());
  return db;
}
