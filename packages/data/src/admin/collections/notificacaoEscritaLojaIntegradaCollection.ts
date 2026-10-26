import { notificacaoEscritaLojaIntegradaSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `notificacoesEscritaLojaIntegrada` failures-only
 * backlog of the Loja Integrada WRITES queue (master plan step 7: the status
 * write-back). Only the channel's shared-pipeline binding writes it
 * (`apps/loja-integrada/lib/lojaIntegrada/rastreio/notificacaoEscrita.ts`), keyed
 * by the event's digest id, and every write to its rows but the producer's
 * create runs on the single-dispatch writes queue. ⚠️ This comment deliberately
 * does not spell the pipeline factory's call: guard B
 * (`notificationGuardrails.test.ts`) scans every source that names it, and a
 * docblock here would count as the wiring. Admin-only / default-deny (the schema
 * is not in `ALL_DOMAINS`), so there is no client access and no generated rules
 * block. Mirrors `notificacaoLojaIntegradaCollection`.
 *
 * Its one composite lives in `firestore.indexes.json`: `(status, processedAt)`
 * for both sweep lanes. There is no token-save re-drive of write rows, so no
 * `(status, contaId)`.
 */
export const notificacaoEscritaLojaIntegradaCollection = defineAdminCollection({
  path: 'notificacoesEscritaLojaIntegrada',
  schema: notificacaoEscritaLojaIntegradaSchema,
});
