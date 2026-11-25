import { z } from 'zod';
import { contaIdLiSchema } from './notificacaoLojaIntegrada';
import { idDocumentoEstoqueLiSchema } from './sincEstoqueLojaIntegrada';

/**
 * The Cloud Tasks payload of the Loja Integrada price sync (master plan step 13, PR 13-a): one
 * send run for one linked child produto of one conta, on the price queue
 * (`filaPrecoLojaIntegrada`, its own single-file queue — never the writes queue, whose status
 * write-back a whole-catalogue reprice would delay for a day, nor the stock queue, whose sends it
 * would hold back).
 *
 * ## IDS ONLY — a price in a payload is REFUSED
 *
 * What a price PUT sends is derived when the task RUNS: the target from the ERP at that moment
 * (`precoAlvoLi`, `precoErpLojaIntegrada.ts`) and the merge base from a fresh deciding read of
 * the store just before the PUT. A price computed when the task was enqueued would be sent minutes
 * — or, behind a whole-catalogue reprice, hours — later over every edit in between, so no payload
 * carries one. The object is STRICT: an extra key — `cheio`, `promocional`, `custo`, `preco`,
 * `valor`, or anything else — fails the parse, and a task that does not parse is dropped by its
 * queue with one log line. `tarefaPrecoLojaIntegrada.test.ts` pins it.
 *
 * ⚠️ Strict cuts both ways: a field a later step adds must ship to the CONSUMER (the functions
 * codebase) before any producer sends it, or the tasks in between are dropped. The consumer PR
 * merges before every producer PR.
 *
 * ## Windows
 *
 * `janela` = ⌊now / 60 s⌋, the clock read IMMEDIATELY before the enqueue (never the event's time).
 * The task NAME carries it (with the origin, the `baixar` bit, the conta and the produto), so a
 * burst of edits inside one window enqueues ONE task, the next window's enqueue never collides
 * with a task that already dispatched, and a task that may not lower a price never swallows one
 * that may. A bulk send is named by its RUN's window instead.
 *
 * Deliberately NOT a member of the persisted notification `tipo` (`notificacaoLojaIntegrada.ts`),
 * like the stock tasks: it is never persisted, re-driven by the sweep or parked.
 */

/** The price queue's one task `tipo`. */
export const TIPO_TAREFA_PRECO_LI = 'preco' as const;

/**
 * Who asked for a send run:
 *
 *  - `evento`: the trigger on an ERP produto write that moved a price the conta reads;
 *  - `manual`: the operator's push from the produtos table;
 *  - `publicacao`: a publish (step 11), which re-prices a child it already priced;
 *  - `deriva`: the ONE follow-up a read-back enqueues when the store did not keep what was sent
 *    (generation 1, never re-enqueued);
 *  - `reconcile`: the daily reconcile's diff;
 *  - `atualizacao`: the operator's account-wide "Atualizar preços" run.
 *
 * `evento`, `manual`, `publicacao` and `deriva` are read back after the PUT; `reconcile` and
 * `atualizacao` are BULK origins, read back by the next night's by-id read of the store's prices.
 */
export const origemTarefaPrecoLiSchema = z.enum([
  'evento',
  'manual',
  'publicacao',
  'deriva',
  'reconcile',
  'atualizacao',
]);
export type OrigemTarefaPrecoLi = z.infer<typeof origemTarefaPrecoLiSchema>;

/** Named members of {@link origemTarefaPrecoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const ORIGEM_TAREFA_PRECO_LI = {
  evento: 'evento',
  manual: 'manual',
  publicacao: 'publicacao',
  deriva: 'deriva',
  reconcile: 'reconcile',
  atualizacao: 'atualizacao',
} as const satisfies Record<string, OrigemTarefaPrecoLi>;

/** The bulk origins: the ones a reconcile run enqueues, which carry the run's tabela ids. */
const ORIGENS_EM_LOTE_PRECO_LI: ReadonlySet<OrigemTarefaPrecoLi> = new Set<OrigemTarefaPrecoLi>([
  ORIGEM_TAREFA_PRECO_LI.reconcile,
  ORIGEM_TAREFA_PRECO_LI.atualizacao,
]);

/** Is `origem` a bulk origin (`reconcile`, `atualizacao`)? */
export function origemEmLotePrecoLi(origem: OrigemTarefaPrecoLi): boolean {
  return ORIGENS_EM_LOTE_PRECO_LI.has(origem);
}

/** ⌊now / 60 s⌋: a non-negative safe integer. */
const janelaSchema = z.number().int().nonnegative();

/**
 * One send run for one linked child (or simple root) produto of one conta:
 *
 *  - `geracao`: 1 exactly for a `deriva` follow-up, which never enqueues another — the loop cap;
 *  - `baixar`: may this run LOWER what the buyer pays (`decidirBaixaPrecoLi`)? An event sets it
 *    when an ERP price decision moved the target (a tabela entry, the parent's propagation flag)
 *    and clears it for a structural move (`paiId`); the operator's push and "Atualizar preços"
 *    carry the operator's choice; a follow-up inherits it. A PUBLISH always may (`true`), the
 *    daily reconcile never may (`false`);
 *  - `tabelaNormalId` / `tabelaPromocionalId`: EXACTLY a bulk send carries them — the tabela ids
 *    (bare `listaDePrecos` document ids, never refs or prices) its run diffed the conta at;
 *    `tabelaNormalId` is set, and `tabelaPromocionalId` is present, `null` meaning the run priced
 *    with no promo tabela. The send run drops a send whose conta now names other tabelas: a bulk
 *    send waits up to its slot's horizon, and a re-point in between must never push prices
 *    computed from another tabela. Every other origin leaves both absent (or `null`): they read
 *    the conta's tabelas when they run — the `depositoId` rule of the stock task
 *    (`tarefaEstoqueLojaIntegrada.ts`).
 */
export const tarefaPrecoLiSchema = z
  .strictObject({
    tipo: z.literal(TIPO_TAREFA_PRECO_LI),
    contaId: contaIdLiSchema,
    produtoId: idDocumentoEstoqueLiSchema,
    origem: origemTarefaPrecoLiSchema,
    janela: janelaSchema,
    geracao: z.union([z.literal(0), z.literal(1)]),
    baixar: z.boolean(),
    tabelaNormalId: idDocumentoEstoqueLiSchema.nullable().optional(),
    tabelaPromocionalId: idDocumentoEstoqueLiSchema.nullable().optional(),
  })
  .refine((t) => (t.geracao === 1) === (t.origem === ORIGEM_TAREFA_PRECO_LI.deriva), {
    path: ['geracao'],
    message: 'geracao 1 é exatamente a da deriva',
  })
  .refine((t) => (t.tabelaNormalId != null) === origemEmLotePrecoLi(t.origem), {
    path: ['tabelaNormalId'],
    message: 'tabelaNormalId é exatamente o de um envio em lote',
  })
  .refine(
    (t) =>
      origemEmLotePrecoLi(t.origem)
        ? t.tabelaPromocionalId !== undefined
        : t.tabelaPromocionalId == null,
    {
      path: ['tabelaPromocionalId'],
      message: 'tabelaPromocionalId vem (talvez nula) exatamente num envio em lote',
    },
  )
  .refine((t) => t.origem !== ORIGEM_TAREFA_PRECO_LI.publicacao || t.baixar, {
    path: ['baixar'],
    message: 'uma publicação pode baixar o preço',
  })
  .refine((t) => t.origem !== ORIGEM_TAREFA_PRECO_LI.reconcile || !t.baixar, {
    path: ['baixar'],
    message: 'a conferência diária nunca baixa o preço',
  });
export type TarefaPrecoLi = z.infer<typeof tarefaPrecoLiSchema>;
