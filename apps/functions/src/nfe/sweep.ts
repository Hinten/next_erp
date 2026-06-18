import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { postNfe } from './call-nfe';

/**
 * Backstop sweep for the async NF-e reconciler (#77).
 *
 * Runs the apps/nfe sweep (`/api/nfe/processar-pendentes`) — the safety net for
 * the Cloud Tasks primary path. It reconciles lotes whose task was lost / never
 * enqueued / predates the queue, gated per-doc by `proximaConsultaEm` so it never
 * consults ahead of the task's schedule (the consumo-indevido guard). The
 * Cloud Scheduler job is **auto-provisioned by this function on deploy** — no
 * Terraform, no manual `gcloud scheduler jobs create`.
 */
export async function handleSweep(): Promise<void> {
  const { status, ok } = await postNfe('/api/nfe/processar-pendentes', {});
  logger.info(`nfeReconcileSweep → /api/nfe/processar-pendentes HTTP ${status}`);
  if (!ok) {
    throw new Error(`/api/nfe/processar-pendentes responded HTTP ${status}`);
  }
}

// Every 30 min, 08:00–19:00, Mon–Fri, in SEFAZ-SP business hours. Unix-cron
// minutes :00/:30 over hours 08–19 (last tick 19:30). The per-doc
// `proximaConsultaEm` due-gate keeps each run cheap regardless of cadence.
export const nfeReconcileSweep = onSchedule(
  { schedule: '0,30 8-19 * * 1-5', timeZone: 'America/Sao_Paulo' },
  () => handleSweep(),
);
