import { z } from 'zod';
import { contaIdLiSchema } from './notificacaoLojaIntegrada';
import { millisSinceEpoch } from './shared/datetime';
import {
  contadoresEstoqueLiSchema,
  idDocumentoEstoqueLiSchema,
  idExecucaoEstoqueLiSchema,
  idProdutoLiTextoSchema,
} from './sincEstoqueLojaIntegrada';

/**
 * `reconcileEstoqueLojaIntegrada/atual` (TOP-LEVEL, ONE document) — the lease and the chain of
 * the Loja Integrada daily FULL stock reconcile (master plan step 12, PR 12-a). One run covers
 * every conta, one after another, in time-boxed slices on the reads queue (`estoque-reconcile`
 * tasks, `tarefaEstoqueLojaIntegrada.ts`); this document is where a run's progress survives
 * between slices.
 *
 * ## The phases
 *
 *  - `erp`: one key walk of every store link (`walk` is its cursor), the produtos, their stock
 *    records and kit components; it writes each conta's snapshot and kits map;
 *  - `li`: per conta in `contas` order (`idxConta`), the store's stock list read whole and
 *    diffed against the snapshot; the rows to send become `candidatos`;
 *  - `fila`: the candidates enqueued on the stock queue, over-advertising first, each at the next
 *    free instant of the ONE global stagger slot (`proximoSlotMs`); what was enqueued leaves the
 *    list. A dry-run enqueues nothing;
 *  - `fim`: the avisos raised or resolved once, the counters copied to each conta's
 *    `ultimoReconcile`.
 *
 * There is no light mode: every run is FULL.
 *
 * ## The lease (root `CLAUDE.md` rule 7, tier 1)
 *
 * `execucaoId` + `emExecucaoAteMs` are the lease, `seq` the dispatch a slice must carry: a slice
 * whose `execucaoId` or `seq` differs from the stored one is refused. Every write is
 * `update(patch, { lastUpdateTime })` on the slice's own read, advance-only; a lost precondition
 * re-reads. A running chain wins over a new one; a chain older than 48 h is abandoned with a
 * WARNING. No transaction.
 *
 * ## Units
 *
 * Every stamp is MILLISECONDS and says so in its name.
 *
 * ## Admin-only / default-deny
 *
 * NOT registered in `ALL_DOMAINS` and no Meta: no rules block, no client access. A bare schema
 * (`registry.test.ts`). Unknown keys are STRIPPED.
 */

/** The root collection's path. */
export const COLECAO_RECONCILE_ESTOQUE_LI = 'reconcileEstoqueLojaIntegrada';

/** The one document's id. */
export const ID_RECONCILE_ESTOQUE_LI = 'atual';

/** A run's phase (module header). */
export const faseReconcileEstoqueLiSchema = z.enum(['erp', 'li', 'fila', 'fim']);
export type FaseReconcileEstoqueLi = z.infer<typeof faseReconcileEstoqueLiSchema>;

/** Named members of {@link faseReconcileEstoqueLiSchema} — see `delfrance/prefer-schema-enum`. */
export const FASE_RECONCILE_ESTOQUE_LI = {
  erp: 'erp',
  li: 'li',
  fila: 'fila',
  fim: 'fim',
} as const satisfies Record<string, FaseReconcileEstoqueLi>;

/**
 * The ERP walk's cursor: the full path of the last store link document it read. The walk is
 * ordered by document KEY over the whole collection group, so a path — never a field value — is
 * what it resumes after, and two links of one store id on either side of a page boundary are
 * both seen.
 */
export const walkReconcileEstoqueLiSchema = z.object({
  ultimoDocPath: z.string().regex(/^(?:[^/]+\/[^/]+\/)*produtolojaintegrada\/[^/]+$/),
});
export type WalkReconcileEstoqueLi = z.infer<typeof walkReconcileEstoqueLiSchema>;

/**
 * One row to send, kept short (about 30 bytes): `c`, the conta's index in `contas`; `i`, the
 * store product id; `p`, the ERP produto; `d`, the store's effective quantity minus S — positive
 * is over-advertising, which goes first. The send run re-derives everything; `d` only orders.
 */
export const candidatoReconcileEstoqueLiSchema = z.object({
  c: z.number().int().nonnegative(),
  i: idProdutoLiTextoSchema,
  p: idDocumentoEstoqueLiSchema,
  d: z.number().int(),
});
export type CandidatoReconcileEstoqueLi = z.infer<typeof candidatoReconcileEstoqueLiSchema>;

export const reconcileEstoqueLojaIntegradaSchema = z
  .object({
    /** The run holding the lease; null = none ever ran. */
    execucaoId: idExecucaoEstoqueLiSchema.nullable().default(null),
    /** MS. When the run began: the avisos' clock. */
    iniciadoEmMs: millisSinceEpoch().nullable().default(null),
    /** MS. The lease's expiry; 0 = free. */
    emExecucaoAteMs: millisSinceEpoch().default(0),
    /** The dispatch the next slice must carry. */
    seq: z.number().int().nonnegative().default(0),
    fase: faseReconcileEstoqueLiSchema.nullable().default(null),
    /** The contas of the run, in processing order. */
    contas: z.array(contaIdLiSchema).default([]),
    /** The conta the `li` phase is on. */
    idxConta: z.number().int().nonnegative().default(0),
    walk: walkReconcileEstoqueLiSchema.nullable().default(null),
    candidatos: z.array(candidatoReconcileEstoqueLiSchema).default([]),
    /** MS. The next free instant of the global stagger slot for bulk enqueues. */
    proximoSlotMs: millisSinceEpoch().nullable().default(null),
    contadores: contadoresEstoqueLiSchema.default({}),
  })
  .superRefine((run, ctx) => {
    if (run.idxConta > run.contas.length) {
      ctx.addIssue({ code: 'custom', path: ['idxConta'], message: 'idxConta além das contas' });
    }
    run.candidatos.forEach((candidato, n) => {
      if (candidato.c >= run.contas.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['candidatos', n, 'c'],
          message: 'candidato de uma conta fora da lista',
        });
      }
    });
  });
export type ReconcileEstoqueLojaIntegrada = z.infer<typeof reconcileEstoqueLojaIntegradaSchema>;
