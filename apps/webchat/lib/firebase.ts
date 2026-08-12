'use client';

import { type FirebaseApp, getApps, initializeApp } from 'firebase/app';
import {
  type Auth,
  browserLocalPersistence,
  getAdditionalUserInfo,
  indexedDBLocalPersistence,
  initializeAuth,
  signInAnonymously,
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

/**
 * Anonymous sign-in. The Conversa doc's customWriteRules in the Flutter
 * app expect `request.auth.token.firebase.sign_in_provider == 'anonymous'`.
 *
 * `isNewUser` is true only when a brand-new anonymous account was minted —
 * i.e. this browser has never chatted, so `chat/<uid>` cannot exist yet. The
 * boot effect keys create-vs-resume on it because the visitor has no read
 * access to `chat/<uid>` (#153), so a getDoc existence probe is not an
 * option. A persisted account hydrating after the sync `currentUser` check
 * is safe too: signInAnonymously awaits persistence hydration and reuses the
 * existing user, and `getAdditionalUserInfo` special-cases that credential
 * to `{ isNewUser: false }`.
 */
export async function ensureAnonAuth(): Promise<{ uid: string; isNewUser: boolean }> {
  const a = getFirebaseAuth();
  if (a.currentUser) return { uid: a.currentUser.uid, isNewUser: false };
  const cred = await signInAnonymously(a);
  return { uid: cred.user.uid, isNewUser: getAdditionalUserInfo(cred)?.isNewUser ?? false };
}
