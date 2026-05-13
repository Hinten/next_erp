import { type FirebaseApp, getApps, initializeApp } from 'firebase/app';
import {
  type Auth,
  browserLocalPersistence,
  initializeAuth,
  indexedDBLocalPersistence,
} from 'firebase/auth';
import { type Firestore, getFirestore } from 'firebase/firestore';

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;

export function getFirebaseApp(): FirebaseApp {
  if (app) return app;
  app = getApps()[0] ?? initializeApp(config);
  return app;
}

export function getFirebaseAuth(): Auth {
  if (auth) return auth;
  // initializeAuth (vs getAuth) lets us pick persistence explicitly.
  // indexedDB survives across tabs; falls back to localStorage in private mode.
  auth = initializeAuth(getFirebaseApp(), {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  });
  return auth;
}

export function getFirebaseFirestore(): Firestore {
  if (db) return db;
  const databaseId = process.env.NEXT_PUBLIC_FIREBASE_DATABASE_ID ?? 'default';
  db = getFirestore(getFirebaseApp(), databaseId);
  return db;
}
