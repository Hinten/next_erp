import './options';

import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { readCacheDelta, readCacheMark } from '@delfrance/data/admin/cache';

import {
  MELHOR_ENVIO_NOTIFICATION_QUEUE,
  reprocessNotifications,
} from '../../lib/freight/notificacao';
import { getDb } from './lib/admin';
import * as notificationHandlers from './processNotification';

if (!(MELHOR_ENVIO_NOTIFICATION_QUEUE in notificationHandlers)) {
  throw new Error(
    `[melhor-envio] function-name drift: functions/src/processNotification.ts must export a ` +
      `handler named '${MELHOR_ENVIO_NOTIFICATION_QUEUE}' (the enqueue target). ` +
      `Rename the export and the MELHOR_ENVIO_NOTIFICATION_QUEUE constant together.`,
  );
}

export { processMelhorEnvioNotification } from './processNotification';

export const reprocessMelhorEnvioNotifications = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/Sao_Paulo' },
  async () => {
    const cacheMark = readCacheMark();
    const result = await reprocessNotifications(getDb());
    logger.info('[melhor-envio] reprocess sweep', {
      processed: result.processed,
      outcomes: result.outcomes,
      errorCount: result.errors.length,
      readCache: readCacheDelta(cacheMark),
    });
    if (result.errors.length > 0) {
      logger.warn('[melhor-envio] reprocess sweep had per-doc failures', {
        errors: result.errors.slice(0, 10),
      });
    }
  },
);
