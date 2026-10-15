/** Firebase task scheduler for Melhor Envio inbound notifications (#681). */
import { MissingRegionError, requireRegion } from '@delfrance/core/region';
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError, getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../firebase/admin';
import {
  MELHOR_ENVIO_NOTIFICATION_QUEUE,
  type MelhorEnvioNotificationPayload,
} from './notificacao';

function melhorEnvioTasksRegion(): string {
  return requireRegion({
    MELHOR_ENVIO_TASKS_REGION: process.env.MELHOR_ENVIO_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

export interface MelhorEnvioTaskScheduler {
  enqueue(payload: MelhorEnvioNotificationPayload): Promise<void>;
}

export class MelhorEnvioTasksDisabledError extends Error {
  constructor() {
    super('MELHOR_ENVIO_TASKS_DISABLED=1 — enqueue disabled; persisting for the sweep');
    this.name = 'MelhorEnvioTasksDisabledError';
  }
}

export function isMelhorEnvioEnqueueError(err: unknown): err is Error {
  return (
    err instanceof MelhorEnvioTasksDisabledError ||
    err instanceof MissingRegionError ||
    err instanceof FirebaseFunctionsError ||
    err instanceof FirebaseAppError
  );
}

class FirebaseMelhorEnvioTaskScheduler implements MelhorEnvioTaskScheduler {
  private queue() {
    return getFunctions(getAdminApp()).taskQueue<MelhorEnvioNotificationPayload>(
      `locations/${melhorEnvioTasksRegion()}/functions/${MELHOR_ENVIO_NOTIFICATION_QUEUE}`,
    );
  }

  async enqueue(payload: MelhorEnvioNotificationPayload): Promise<void> {
    await this.queue().enqueue(payload);
  }
}

export function createMelhorEnvioTaskScheduler(): MelhorEnvioTaskScheduler {
  if (process.env.MELHOR_ENVIO_TASKS_DISABLED === '1') {
    return {
      async enqueue() {
        throw new MelhorEnvioTasksDisabledError();
      },
    };
  }
  return new FirebaseMelhorEnvioTaskScheduler();
}
