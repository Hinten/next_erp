import { z } from 'zod';

/**
 * Payload for the `finalizarBalanco` callable — the server-owned "apply this
 * count to stock" command.
 *
 * ⚠️ Note what is NOT here: no quantities, no produto list, no `motivo`, no
 * depósito. Every number that lands on `estoques` is derived server-side from
 * the balanço's own `movimentos`, and the audit trail's `motivo` / `tipo` /
 * `usuarioOuterRef` are stamped from the balanço doc and the caller's auth
 * token. That is the whole point of moving this off the client: the legacy
 * Flutter finalize sent the counted values (and the audit text) straight from
 * the browser, so anyone with estoque-write could set arbitrary stock and
 * label it as a balanço.
 *
 * Shared by the web client (typed input) and the Cloud Function (validation of
 * untrusted input), so both sides agree on the contract — same arrangement as
 * `estoqueComandoSchema`.
 */
export const finalizarBalancoSchema = z.object({
  balancoId: z.string().min(1),
  /**
   * When true, produtos that hold stock in this depósito but were never
   * counted are set to 0. When false, only counted produtos change.
   */
  zerarNaoContados: z.boolean(),
});

export type FinalizarBalancoComando = z.infer<typeof finalizarBalancoSchema>;

/** What the callable answers once the job is queued. */
export interface FinalizarBalancoResult {
  balancoId: string;
  /** True when this call re-queued a job parked in `erro` rather than starting one. */
  retomado: boolean;
}

/** Payload of one `processarBalanco` task dispatch. */
export const balancoTaskSchema = z.object({ balancoId: z.string().min(1) });
export type BalancoTaskPayload = z.infer<typeof balancoTaskSchema>;
