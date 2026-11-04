import { notificacaoAmazonSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `notificacoesAmazon` failures-only backlog of
 * the Amazon reads queue (master plan step 3, PR 3-b). Only the channel's
 * shared-pipeline binding writes it
 * (`apps/amazon/lib/amazon/notificacoes/notificacao.ts`), keyed by a doc id built
 * from schema-validated parts (`push:<NotificationId>` /
 * `poll:<contaId>:<orderId>:<µs>`), and the nested functions codebase re-drives
 * it. ⚠️ This comment deliberately does not spell the pipeline factory's call:
 * guard B (`notificationGuardrails.test.ts`) scans every source that names it,
 * and a docblock here would count as the wiring. Admin-only / default-deny (the
 * schema is not in `ALL_DOMAINS`), so there is no client access and no generated
 * rules block. Mirrors `notificacaoLojaIntegradaCollection`.
 *
 * Its one composite lives in `firestore.indexes.json`: `(status, processedAt)`
 * for both sweep lanes. There is no connect re-drive query (step-3 plan §3
 * decision 9), so no second composite.
 */
export const notificacaoAmazonCollection = defineAdminCollection({
  path: 'notificacoesAmazon',
  schema: notificacaoAmazonSchema,
});
