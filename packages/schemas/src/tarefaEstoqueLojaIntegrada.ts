import { z } from 'zod';
import { contaIdLiSchema } from './notificacaoLojaIntegrada';
import { precoSolicitadoTarefaReconcileLiSchema } from './reconcileEstoqueLojaIntegrada';
import {
  ID_EXECUCAO_ESTOQUE_LI_REGEX,
  idDocumentoEstoqueLiSchema,
  idExecucaoEstoqueLiSchema,
} from './sincEstoqueLojaIntegrada';

/**
 * The Cloud Tasks payloads of the Loja Integrada stock sync (master plan step 12, PR 12-a).
 *
 * ## IDS ONLY — a quantity in a payload is REFUSED
 *
 * What a stock PUT sends is derived when the task RUNS: S from the ERP at that moment, the
 * store's reservation from a fresh read just before the PUT (model A). A quantity computed when
 * the task was enqueued would be sent minutes later over every movement in between, so no
 * payload carries one. Every object here is STRICT: an extra key — `quantidade`, `S`, `Q`, or
 * anything else — fails the parse, and a task that does not parse is dropped by its queue with
 * one log line. `tarefaEstoqueLojaIntegrada.test.ts` pins it.
 *
 * ⚠️ Strict cuts both ways: a field a later step adds must ship to the CONSUMER (the functions
 * codebase) before any producer sends it, or the tasks in between are dropped.
 *
 * ## The three tasks
 *
 *  - `estoque` ({@link tarefaEstoqueLiSchema}) — on the stock queue: one send run for one child
 *    produto of one conta;
 *  - `estoque-kits` ({@link tarefaEstoqueKitsLiSchema}) — on the stock queue: the fan-out of ONE
 *    component with more store kits than the eager ceiling, which enqueues an `estoque` task
 *    per kit that component now holds at 0 (a superset of the kits that went from positive
 *    to 0);
 *  - `estoque-reconcile` ({@link tarefaReconcileEstoqueLiSchema}) — on the READS queue: one
 *    time-boxed slice of the daily reconcile. Deliberately NOT a member of the persisted
 *    notification `tipo` (`notificacaoLojaIntegrada.ts`), like the import's task: it is never
 *    persisted, re-driven by the sweep or parked.
 *
 * ## Windows
 *
 * `janela` = ⌊now / 60 s⌋, the clock read IMMEDIATELY before the enqueue (never the event's
 * time). The task NAME carries it (with the conta, the produto, the origin and the delete
 * flag), so a burst of movements inside one window enqueues ONE task, and the next window's
 * enqueue never collides with a task that already dispatched.
 */

/** The stock queue's task `tipo`s. */
export const tipoTarefaEstoqueLiSchema = z.enum(['estoque', 'estoque-kits']);
export type TipoTarefaEstoqueLi = z.infer<typeof tipoTarefaEstoqueLiSchema>;

/** Named members of {@link tipoTarefaEstoqueLiSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_TAREFA_ESTOQUE_LI = {
  estoque: 'estoque',
  estoqueKits: 'estoque-kits',
} as const satisfies Record<string, TipoTarefaEstoqueLi>;

/**
 * Who asked for a send run:
 *
 *  - `evento`: the trigger on an ERP stock record write;
 *  - `kit`: the trigger's eager fan-out to a kit containing the moved component, or the
 *    `estoque-kits` fan-out;
 *  - `reconcile`: the daily reconcile's diff;
 *  - `manual`: the operator's push from the ERP;
 *  - `publicacao`: a publish (step 11), which computes no stock itself;
 *  - `deriva`: the ONE follow-up a read-back enqueues when the store's reservation or quantity
 *    moved under the PUT (generation 1, never re-enqueued).
 *
 * `evento`, `manual`, `publicacao` and `deriva` are read back after the PUT; `kit` and
 * `reconcile` are bulk origins, read back by the next day's list walk.
 */
export const origemTarefaEstoqueLiSchema = z.enum([
  'evento',
  'kit',
  'reconcile',
  'manual',
  'publicacao',
  'deriva',
]);
export type OrigemTarefaEstoqueLi = z.infer<typeof origemTarefaEstoqueLiSchema>;

/** Named members of {@link origemTarefaEstoqueLiSchema} — see `delfrance/prefer-schema-enum`. */
export const ORIGEM_TAREFA_ESTOQUE_LI = {
  evento: 'evento',
  kit: 'kit',
  reconcile: 'reconcile',
  manual: 'manual',
  publicacao: 'publicacao',
  deriva: 'deriva',
} as const satisfies Record<string, OrigemTarefaEstoqueLi>;

/** ⌊now / 60 s⌋: a non-negative safe integer. */
const janelaSchema = z.number().int().nonnegative();

/**
 * One send run for one CHILD produto of one conta:
 *
 *  - `estoqueId`: the stock record that moved (a hint: the run checks it is still at the conta's
 *    depósito, else queries), or `null`;
 *  - `apagado`: the event was that record's DELETE — proof a record existed, so the run pushes 0
 *    rather than holding the produto as one that never had stock;
 *  - `estoqueIds`: for a kit, each component → its stock record id at the depósito (or `null`),
 *    so the run point-reads them; `null` otherwise;
 *  - `geracao`: 1 exactly for a `deriva` follow-up, which never enqueues another — the loop cap;
 *  - `depositoId` (PR 12-g amendment): EXACTLY a `reconcile` send carries it — the bare id of the
 *    depósito its run diffed the conta at (an id, never a quantity). The send run drops a send whose
 *    conta now names another depósito (`processarEstoque.ts`, step 4): a reconcile send waits up to
 *    the slot's horizon, and a re-point in between must never push numbers computed elsewhere.
 *    Every other origin leaves it absent (or `null`): they read the conta's depósito when they run.
 *    The producer and the consumer are ONE functions codebase, deployed together, and no reconcile
 *    send existed before this field — so the strict rule above loses no task in flight.
 */
export const tarefaEstoqueLiSchema = z
  .strictObject({
    tipo: z.literal(TIPO_TAREFA_ESTOQUE_LI.estoque),
    contaId: contaIdLiSchema,
    produtoId: idDocumentoEstoqueLiSchema,
    origem: origemTarefaEstoqueLiSchema,
    janela: janelaSchema,
    estoqueId: idDocumentoEstoqueLiSchema.nullable(),
    apagado: z.boolean(),
    estoqueIds: z
      .record(idDocumentoEstoqueLiSchema, idDocumentoEstoqueLiSchema.nullable())
      .nullable(),
    geracao: z.union([z.literal(0), z.literal(1)]),
    depositoId: idDocumentoEstoqueLiSchema.nullable().optional(),
  })
  .refine((t) => (t.geracao === 1) === (t.origem === ORIGEM_TAREFA_ESTOQUE_LI.deriva), {
    path: ['geracao'],
    message: 'geracao 1 é exatamente a da deriva',
  })
  .refine((t) => (t.depositoId != null) === (t.origem === ORIGEM_TAREFA_ESTOQUE_LI.reconcile), {
    path: ['depositoId'],
    message: 'depositoId é exatamente o do reconcile',
  });
export type TarefaEstoqueLi = z.infer<typeof tarefaEstoqueLiSchema>;

/**
 * The fan-out of ONE component `componenteId` of conta `contaId` whose store kits exceed the
 * eager ceiling. The condition is per KIT, never the component's own quantity: it is enqueued
 * when the moved component's available quantity falls below its quantity in some store kit, so
 * that ⌊available / qty in the kit⌋ goes from positive to 0 for that kit — a component going
 * 3 → 1 empties a kit that needs 2 of it while the component itself still shows 1. The header's
 * `qMax` bounds the check (the new available is below `qMax` and it fell). The task reads the
 * kits map and the component's available quantity when it RUNS, and enqueues an `estoque` task
 * (`origem: 'kit'`) for every kit whose bound by this component, ⌊available / qty⌋, is 0 then —
 * a superset of the kits that went to 0 (one already at 0 costs one store read), with no
 * sibling read. Its kit tasks are named by THIS task's `janela`, so a retry re-meets them.
 * Every other kit change of such a component waits for the nightly reconcile.
 */
export const tarefaEstoqueKitsLiSchema = z.strictObject({
  tipo: z.literal(TIPO_TAREFA_ESTOQUE_LI.estoqueKits),
  contaId: contaIdLiSchema,
  componenteId: idDocumentoEstoqueLiSchema,
  janela: janelaSchema,
});
export type TarefaEstoqueKitsLi = z.infer<typeof tarefaEstoqueKitsLiSchema>;

/** Every task of the stock queue, by `tipo`. */
export const tarefaFilaEstoqueLiSchema = z.discriminatedUnion('tipo', [
  tarefaEstoqueLiSchema,
  tarefaEstoqueKitsLiSchema,
]);
export type TarefaFilaEstoqueLi = z.infer<typeof tarefaFilaEstoqueLiSchema>;

/** The reads-queue task `tipo` of one reconcile slice (module header). */
export const TIPO_TAREFA_RECONCILE_ESTOQUE_LI = 'estoque-reconcile' as const;

/**
 * One slice of reconcile run `execucaoId`: dispatch `seq` of its chain.
 *
 * `precoSolicitado` (step 13, PR 13-a amendment): the operator's "Atualizar preços" request — the
 * conta and whether its sends may lower a price, an id and a flag, never a price. Only the run's
 * FIRST slice reads it, and stores it in the run document (`reconcileEstoqueLojaIntegrada.ts`);
 * every later slice reads it there. Absent (or `null`) on every other task, so every payload
 * enqueued before it still parses — and, strict like the rest, an unknown key inside it is
 * refused.
 */
export const tarefaReconcileEstoqueLiSchema = z.strictObject({
  tipo: z.literal(TIPO_TAREFA_RECONCILE_ESTOQUE_LI),
  execucaoId: idExecucaoEstoqueLiSchema,
  seq: z.number().int().nonnegative(),
  precoSolicitado: precoSolicitadoTarefaReconcileLiSchema.nullable().optional(),
});
export type TarefaReconcileEstoqueLi = z.infer<typeof tarefaReconcileEstoqueLiSchema>;

/**
 * The Cloud Tasks id of dispatch `seq` of reconcile run `execucaoId` on the reads queue:
 * `li-<execucaoId>-<seq>` — the import's shape (`idTarefaImportacaoLi`), and never one of its ids,
 * since every run id starts `estoque-reconcile`. A retried hand-off, the continuation check's
 * repair and a scheduler retry of the same tick all name the SAME task, so only one runs.
 *
 * Throws `RangeError` on a run id outside its grammar or a `seq` that is not a non-negative safe
 * integer (every caller holds a parsed payload, so that is a bug).
 */
export function idTarefaReconcileEstoqueLi(execucaoId: string, seq: number): string {
  if (!ID_EXECUCAO_ESTOQUE_LI_REGEX.test(execucaoId) || !Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError('idTarefaReconcileEstoqueLi: execucaoId ou seq inválido');
  }
  return `li-${execucaoId}-${String(seq)}`;
}
