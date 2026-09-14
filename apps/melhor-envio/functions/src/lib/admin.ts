import { type App, getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';

let app: App | undefined;
let db: Firestore | undefined;

export function getAdminApp(): App {
  if (app) return app;
  app = getApps()[0] ?? initializeApp();
  return app;
}

/** Firestore Enterprise uses the literal database id `default`. */
export function getDb(): Firestore {
  if (db) return db;
  const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
  db = getFirestore(getAdminApp(), databaseId);
  return db;
}
