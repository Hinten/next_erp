// Placeholder dispatcher. In Phase 5, this becomes a real Pub/Sub publisher
// or HTTP call to Cloud Functions. Webhook handlers should respond fast and
// hand off heavy work via this layer.
import { rootLog } from '@/lib/log';

const log = rootLog.child({ mod: 'queue/dispatch' });

export interface DispatchInput {
  topic: string;
  payload: unknown;
  // Optional dedup key for idempotent processing.
  idempotencyKey?: string;
}

export async function dispatch(input: DispatchInput): Promise<void> {
  // TODO(phase-5): publish to Pub/Sub or POST to a Cloud Function HTTP endpoint.
  // For now, log so that the wiring is visible end-to-end during dev. The
  // logger is silent under NODE_ENV=test, so no per-call guard is needed.
  log.info({ topic: input.topic, idempotencyKey: input.idempotencyKey ?? null }, 'dispatch (stub)');
}
