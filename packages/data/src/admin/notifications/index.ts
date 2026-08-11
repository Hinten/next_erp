/**
 * The standardized inbound-webhook notification pipeline.
 *
 * See `.claude/skills/webhook-notifications/SKILL.md` for the full recipe and
 * the traps. In short: a channel supplies its collection, its payload shape and
 * its `process` function; everything about resilience — retry disposition,
 * dead-lettering, the durable-cursor sweep, the enqueue seam — is shared.
 */
export {
  defineNotificationPipeline,
  type NotificationPipeline,
  type NotificationPipelineConfig,
  type NotificationTaskResult,
} from './pipeline';

export {
  createNotificationStore,
  type NotificationStore,
  type NotificationStoreConfig,
} from './store';

export {
  DEFAULT_REPROCESS_LIMIT,
  MAX_TENTATIVAS,
  MAX_TENTATIVAS_DEFERRED,
  ONE_DAY_MS,
  ONE_HOUR_MS,
  TASK_MAX_ATTEMPTS,
  type NotificationDisposition,
  type NotificationPhase,
  type NotificationStatus,
  type ReprocessOptions,
  type ReprocessResult,
  type TaskResult,
} from './types';

export { asMillis } from './coerce';
