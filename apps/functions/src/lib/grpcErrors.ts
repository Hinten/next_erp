/**
 * Generic gRPC-shaped error discriminator for the Admin-SDK Firestore/Storage
 * calls in this codebase's scheduled sweeps. Generalizes
 * `apps/mercado-livre/lib/marketplace/grpcErrors.ts`'s per-code checks: the
 * sweeps here isolate any gRPC-shaped failure per item (a transient
 * UNAVAILABLE, a stale ref that raced to NOT_FOUND, …), not one specific code.
 */

/** True for an Admin-SDK error carrying a numeric gRPC status `code` (e.g. Firestore/Storage). */
export function isGrpcLikeError(err: unknown): boolean {
  return err instanceof Error && typeof (err as { code?: unknown }).code === 'number';
}
