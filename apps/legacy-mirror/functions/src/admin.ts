import { type App, getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { defineString } from 'firebase-functions/params';

import { SOURCE_DATABASE_ID, TARGET_DATABASE_ID } from './mirror';

export { SOURCE_DATABASE_ID, TARGET_DATABASE_ID };

/**
 * The project the mirror writes INTO. A runtime param rather than a build define,
 * because a build-time env must never name a deploy target. Supplied through
 * `functions/.env.deploy.<legacy-project-id>`, which prepare-deploy.mjs copies into
 * the artifact; firebase-tools refuses the deploy while it is unresolved.
 */
export const TARGET_PROJECT_ID = defineString('LEGACY_MIRROR_TARGET_PROJECT_ID', {
  description: 'Project id of the NEW Enterprise project the legacy mirror writes into.',
});

const TARGET_APP_NAME = 'legacy-mirror-target';

/** Thrown when the mirror would write into the project it reads from. */
export class MirrorConfigError extends Error {
  constructor(message: string) {
    super(`legacy-mirror: ${message}`);
    this.name = 'MirrorConfigError';
  }
}

/**
 * Refuse to mirror a project into itself. An unknown source id is refused too:
 * without it the check would pass by checking nothing, and a mirror writing into
 * its own database would overwrite every document with itself and fill it with
 * watermarks.
 */
export function assertDistinctProjects(
  sourceProjectId: string | undefined,
  targetProjectId: string,
) {
  if (!sourceProjectId) {
    throw new MirrorConfigError(
      'cannot tell which project this function runs in (no projectId in FIREBASE_CONFIG).',
    );
  }
  if (sourceProjectId === targetProjectId) {
    throw new MirrorConfigError(
      `the target project '${targetProjectId}' is the project this function runs in. ` +
        'The mirror is deployed into the LEGACY project and writes into the NEW one.',
    );
  }
}

let source: Firestore | undefined;
let target: Firestore | undefined;

/**
 * The function's own app. The no-argument `initializeApp()` is deliberate: it is
 * the one path on which firebase-admin loads `FIREBASE_CONFIG`, which Firebase
 * injects into every deployed function, so `options.projectId` is the legacy
 * project's id. (`GOOGLE_CLOUD_PROJECT` is not set on Cloud Run.)
 */
function sourceApp(): App {
  return getApps().find((a) => a.name === '[DEFAULT]') ?? initializeApp();
}

/** The legacy database, through the function's own project. */
export function sourceDb(): Firestore {
  if (source) return source;
  source = getFirestore(sourceApp(), SOURCE_DATABASE_ID);
  return source;
}

/**
 * The new project's database, through a NAMED app pinned to its project id. The
 * credentials are the function's own runtime service account, which needs
 * `roles/datastore.user` on the NEW project (functions/DEPLOY.md).
 */
export function targetDb(): Firestore {
  if (target) return target;
  const projectId = TARGET_PROJECT_ID.value().trim();
  if (!projectId) throw new MirrorConfigError('LEGACY_MIRROR_TARGET_PROJECT_ID is empty.');
  assertDistinctProjects(sourceApp().options.projectId, projectId);
  const app =
    getApps().find((a) => a.name === TARGET_APP_NAME) ??
    initializeApp({ projectId }, TARGET_APP_NAME);
  target = getFirestore(app, TARGET_DATABASE_ID);
  return target;
}
