import { type App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';

let app: App | undefined;

export function getApp(): App {
  if (app) return app;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is required.');
  if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT (JSON) is required for fixtures.');
  app = getApps()[0] ?? initializeApp({ credential: cert(JSON.parse(sa)), projectId });
  return app;
}

export function db(): Firestore {
  return getFirestore(getApp());
}

/**
 * Each Playwright run gets its own namespace prefix to avoid collisions when
 * multiple PRs run in parallel against the same staging project.
 */
export function namespace(): string {
  const runId = process.env.GITHUB_RUN_ID ?? 'local';
  return `e2e_${runId}`;
}
