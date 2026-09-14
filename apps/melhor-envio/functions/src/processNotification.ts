import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { readCacheSummary } from '@delfrance/data/admin/cache';

import {
  MELHOR_ENVIO_NOTIFICATION_QUEUE,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
} from '../../lib/freight/notificacao';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

export const processMelhorEnvioNotification = onTaskDispatched(
  {
    ...tasksInvokerOptions(),
    retryConfig: {
      maxAttempts: TASK_MAX_ATTEMPTS,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 2,
    },
    rateLimits: { maxConcurrentDispatches: 3, maxDispatchesPerSecond: 5 },
  },
  async (req) => {
    const payload = req.data as {
      labelId?: unknown;
      event?: unknown;
      providerStatus?: unknown;
    } | null;
    const result = await handleNotificationTask(getDb(), req.data, req.retryCount ?? 0);
    logger.info('[melhor-envio] processed notification task', {
      queue: MELHOR_ENVIO_NOTIFICATION_QUEUE,
      outcome: result.outcome,
      kind: result.kind ?? null,
      detail: result.detail ?? null,
      labelId: typeof payload?.labelId === 'string' ? payload.labelId : null,
      event: typeof payload?.event === 'string' ? payload.event : null,
      providerStatus: typeof payload?.providerStatus === 'string' ? payload.providerStatus : null,
      pedidoId: result.pedidoId ?? null,
      estado: result.estado ?? null,
      retryCount: req.retryCount ?? 0,
      readCache: readCacheSummary(),
    });
  },
);
