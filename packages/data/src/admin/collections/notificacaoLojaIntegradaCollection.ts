import { notificacaoLojaIntegradaSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `notificacoesLojaIntegrada` failures-only
 * backlog of the Loja Integrada reads queue (master plan step 3). Only the
 * channel's shared-pipeline binding writes it
 * (`apps/loja-integrada/lib/lojaIntegrada/notificacoes/notificacao.ts`), keyed
 * by a doc id built from validated parts, and the nested functions codebase
 * re-drives it. ⚠️ This comment deliberately does not spell the pipeline
 * factory's call: guard B (`notificationGuardrails.test.ts`) scans every
 * source that names it, and a docblock here would count as the wiring.
 * Admin-only / default-deny (the schema is not in
 * `ALL_DOMAINS`), so there is no client access and no generated rules block.
 * Mirrors `notificacaoShopeeCollection`.
 *
 * Its two composites live in `firestore.indexes.json`: `(status, processedAt)`
 * for both sweep lanes, `(status, contaId)` for the token-save re-drive.
 */
export const notificacaoLojaIntegradaCollection = defineAdminCollection({
  path: 'notificacoesLojaIntegrada',
  schema: notificacaoLojaIntegradaSchema,
});
