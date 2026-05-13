// Placeholder dispatcher. In Phase 5, this becomes a real Pub/Sub publisher
// or HTTP call to Cloud Functions. Webhook handlers should respond fast and
// hand off heavy work via this layer.

export interface DispatchInput {
  topic: string;
  payload: unknown;
  // Optional dedup key for idempotent processing.
  idempotencyKey?: string;
}

export async function dispatch(_input: DispatchInput): Promise<void> {
  // TODO(phase-5): publish to Pub/Sub or POST to a Cloud Function HTTP endpoint.
  // For now, log so that the wiring is visible end-to-end during dev.
  if (process.env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.log('[dispatch:stub]', _input.topic, _input.idempotencyKey ?? '(no key)');
  }
}
