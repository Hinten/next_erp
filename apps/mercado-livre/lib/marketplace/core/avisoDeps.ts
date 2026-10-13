/**
 * The seam every Mercado Livre aviso producer writes through (#847) — the ML
 * twin of `apps/shopee/lib/shopee/avisos/autorizacao.ts`'s.
 *
 * ⚠️ It is the ONE place this app converts milliseconds to microseconds for an
 * aviso. Everything a producer signs is MILLISECONDS (`nowMs`), matching the ML
 * link docs' own `ultimaModificacao`; the aviso collection is µs. A second
 * conversion site is how a `criadoEm` ends up 1000x off with nothing failing —
 * root `CLAUDE.md` rule 7 on stamps that are not interchangeable.
 */
import { millisToMicros } from '@delfrance/core/datetime';

export interface AvisoDeps {
  /**
   * `(by) => FieldValue.increment(by)` — injected because
   * `packages/data/src/admin/**` may only `import type` from firebase-admin, so
   * the sentinel has to come from a caller that can make the runtime import.
   */
  increment: (by: number) => unknown;
  /** Now, in MILLISECONDS. Converted to µs at this seam, never before. */
  nowMs: number;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** The ms → µs seam for "now". */
export function agoraUsDe(deps: { nowMs: number }): number {
  return millisToMicros(deps.nowMs);
}

/** `escreverAviso`'s deps, from ours — so the µs seam cannot drift. */
export function depsDeEscrita(deps: AvisoDeps): {
  increment: (by: number) => unknown;
  agoraUs: number;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
} {
  return { increment: deps.increment, agoraUs: agoraUsDe(deps), logger: deps.logger };
}
