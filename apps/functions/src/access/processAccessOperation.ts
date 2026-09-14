import { logger } from 'firebase-functions';
import { FirebaseAuthError, getAuth } from 'firebase-admin/auth';
import { getFunctions } from 'firebase-admin/functions';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { requireRegion } from '@delfrance/core/region';
import { ACCESS_PHASE, accessIdSchema } from '@delfrance/schemas';
import {
  accessOperations,
  getActiveOperationId,
  getAccessOperation,
  processAccessOperation,
  withAccessAuth,
  WORKER_TIMEOUT_SECONDS,
} from '@delfrance/data/admin/cargo-claims';
import { getAdminApp, getDb } from '../lib/admin';
import { tasksInvokerOptions } from '../tasksInvoker';

export async function enqueueAccessOperation(id: string) {
  // Named emulator lanes drive the worker seam; no Cloud Tasks emulator exists.
  if (process.env.FIRESTORE_EMULATOR_HOST) return;
  const region = requireRegion({ FUNCTIONS_REGION: process.env.FUNCTIONS_REGION });
  await getFunctions(getAdminApp())
    .taskQueue<{ id: string }>(`locations/${region}/functions/processarOperacaoAcesso`)
    .enqueue({ id }, { dispatchDeadlineSeconds: 180, scheduleDelaySeconds: 2 });
}
export const onAccessOperationCreated = onDocumentCreated(
  {
    document: `${accessOperations.resolvePath({})}/{id}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
  },
  async (event) => {
    if (event.data) await enqueueAccessOperation(event.params.id);
  },
);

export const processarOperacaoAcesso = onTaskDispatched(
  {
    ...tasksInvokerOptions(),
    timeoutSeconds: WORKER_TIMEOUT_SECONDS,
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 15, maxBackoffSeconds: 120 },
  },
  async (request) => {
    const id = accessIdSchema.parse(request.data.id);
    await processAccessOperation(
      getDb(),
      withAccessAuth(getAuth(getAdminApp()), FirebaseAuthError),
      id,
    );
    const op = await getAccessOperation(getDb(), id);
    logger.info('access-operation', {
      id,
      phase: op.phase,
      processed: op.processed,
      errorCode: op.errorCode,
    });
    if (
      op.phase === ACCESS_PHASE.validating ||
      op.phase === ACCESS_PHASE.applying ||
      op.phase === ACCESS_PHASE.provisioning
    ) {
      // Duplicate deliveries wait for the watchdog rather than enqueuing a hot loop.
      if (op.leaseUntil <= Date.now()) await enqueueAccessOperation(id);
    }
  },
);
export const recoverAccessOperations = onSchedule('every 5 minutes', async () => {
  const db = getDb();
  const id = await getActiveOperationId(db);
  if (!id) return;
  const op = await getAccessOperation(db, id);
  if (
    op.phase !== ACCESS_PHASE.failed &&
    op.leaseUntil <= Date.now() &&
    Date.now() - op.progressAt > 60_000
  ) {
    await enqueueAccessOperation(id);
  }
});
