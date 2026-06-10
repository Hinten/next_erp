import { type FirebaseApp, getApps, initializeApp } from 'firebase/app';
import {
  type Auth,
  browserLocalPersistence,
  initializeAuth,
  indexedDBLocalPersistence,
} from 'firebase/auth';
import { type Firestore, getFirestore } from 'firebase/firestore';
import { type FirebaseStorage, getStorage } from 'firebase/storage';

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
let storage: FirebaseStorage | undefined;

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

export function getFirebaseStorage(): FirebaseStorage {
  if (storage) return storage;
  storage = getStorage(getFirebaseApp());
  // Bound the SDK's internal retry window so a blocked/failed upload (e.g. a
  // bucket CORS misconfiguration) surfaces a real FirebaseError in ~30s instead
  // of retrying silently for the ~120s default — which looks like a hung UI.
  storage.maxUploadRetryTime = 30_000;
  return storage;
}
