import { type App, getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { Bucket } from '@delfrance/storage/admin';

let app: App | undefined;
let db: Firestore | undefined;

/**
 * Admin app singleton. In the Cloud Functions runtime `initializeApp()` picks up
 * Application Default Credentials + the ambient project.
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

/**
 * The DEFAULT bucket's name for the product import's photos (master plan step 9, "complete"), or
 * `null` when nothing names one. Pure: the two inputs are handed in, so the ladder is pinned
 * offline (`admin.test.ts`). Two tiers, the Shopee and Mercado Livre backends' resolver
 * (`apps/shopee/lib/firebase/admin.ts`) without the two this codebase must not have:
 *
 *  1. `FIREBASE_CONFIG.storageBucket` — the runtime's OWN answer: the Cloud Functions runtime (and
 *     the functions emulator) injects `FIREBASE_CONFIG`, and it carries the project's real default
 *     bucket. An unparseable value, a value that is not an object, or a blank or non-text
 *     `storageBucket` reads as absent;
 *  2. the admin app's own `storageBucket` option — the same value when the app was built with no
 *     arguments (`getAdminApp`: firebase-admin then loads `FIREBASE_CONFIG` itself), and the
 *     answer when something initialised the app with explicit options first.
 *
 * What is deliberately NOT a tier:
 *
 *  - an operator override variable: no new env var in this codebase (the step's plan);
 *  - the classic `<projectId>.appspot.com` DERIVED from the project id. A project created after
 *    late 2024 — the new project the migration window moves the data to included — defaults to
 *    `<projectId>.firebasestorage.app`, so the derived name names a bucket that does not exist:
 *    every upload would fail as a Storage error the task retries until the job is stamped
 *    `tentativas-esgotadas`, where `null` skips the photos and stamps the job
 *    `fotosIndisponiveis`, which the card shows. A wrong guess is worse than none.
 */
export function nomeDoBucketPadraoLi(
  firebaseConfig: string | undefined,
  opcaoDoApp: unknown,
): string | null {
  const doConfig = storageBucketDoConfig(firebaseConfig);
  if (doConfig !== null) return doConfig;
  return typeof opcaoDoApp === 'string' && opcaoDoApp.trim() !== '' ? opcaoDoApp : null;
}

function storageBucketDoConfig(firebaseConfig: string | undefined): string | null {
  if (firebaseConfig === undefined || firebaseConfig.trim() === '') return null;
  let lido: unknown;
  try {
    lido = JSON.parse(firebaseConfig);
  } catch (err) {
    // A malformed FIREBASE_CONFIG reads as absent; the next tier answers.
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  if (typeof lido !== 'object' || lido === null || Array.isArray(lido)) return null;
  const valor: unknown = Reflect.get(lido, 'storageBucket');
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

/**
 * The default bucket the product import stores photos in, or `null` when its name cannot be
 * resolved ({@link nomeDoBucketPadraoLi}): the import then skips photos for the run and stamps the
 * job `fotosIndisponiveis` — a misconfiguration shown on the card, never a failed job. Building the
 * handle calls nothing; a Storage failure surfaces on the upload itself, and propagates there.
 */
export function getBucket(): Bucket | null {
  const adminApp = getAdminApp();
  const nome = nomeDoBucketPadraoLi(process.env.FIREBASE_CONFIG, adminApp.options.storageBucket);
  return nome === null ? null : getStorage(adminApp).bucket(nome);
}
