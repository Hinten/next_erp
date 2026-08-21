/**
 * When a Mercado Livre **404 may be acked**, and when it has to be retried.
 *
 * ⚠️ A 404 looks deterministic and mostly is not. ML's own post-sale reference
 * spells it out for `GET /messages/{id}`:
 *
 * > 404 — *The message with id: a could not be retrieved from storage.*
 * > **Mensagem não encontrada no servidor. Tente novamente em alguns segundos.**
 *
 * The same read-your-writes lag is why the receiver already delays `questions`
 * and `messages` by 10s. That delay narrows the race; it does not close it.
 *
 * Acking a raced 404 is **silent permanent loss** — a real customer message
 * never reaches the inbox, and nothing records that it existed: no failure doc,
 * no parked doc, no warn line. That is the exact shape #813 was filed about.
 * Retrying a genuinely deleted resource instead costs a handful of calls and
 * then a parked document, which is visible and cheap. The asymmetry is what
 * decides the policy, not which outcome is more likely.
 *
 * So the notification's OWN `sent` clock is the discriminator: inside the
 * window a 404 is the race and throws; outside it, the resource is gone.
 */

/**
 * How long after ML SENT a notification its 404 is still treated as the race.
 *
 * Sized against the two retry lanes it sits between: comfortably longer than
 * the Cloud Tasks retry envelope (so a fresh resource gets every attempt) and
 * far shorter than the HOURLY sweep (so a genuinely deleted one settles on the
 * first sweep pass instead of retrying forever).
 */
export const JANELA_404_TRANSIENTE_MS = 10 * 60 * 1000;

/**
 * Whether a 404 on this delivery can be trusted to mean "gone".
 *
 * ⚠️ A missing `enviadaMs` returns TRUE. A payload carrying no freshness claim
 * — a `missed_feeds` replay, a synthesised body — cannot be defended by a
 * window, and looping on it forever would be worse than acking it.
 */
export function ack404EhSeguro(args: {
  enviadaMs: number | null | undefined;
  nowMs: number;
}): boolean {
  const { enviadaMs, nowMs } = args;
  if (enviadaMs == null || !Number.isFinite(enviadaMs)) return true;
  return nowMs - enviadaMs > JANELA_404_TRANSIENTE_MS;
}
