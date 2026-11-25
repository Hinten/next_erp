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
 * whose `execucaoId` or `seq` differs from the stored one is refused. A running chain wins over a
 * new one; a chain older than 48 h is abandoned with a WARNING. No transaction.
 *
 * One exception, the import's (`importacaoLojaIntegrada.ts`): a slice of the stored run whose
 * `seq` is ONE behind the stored one, while the lease is held, already wrote its end-of-slice
 * checkpoint and its hand-off may have failed — it only re-enqueues the stored `seq`'s named task
 * and stops (the `continuacao` repair). The release of the lease (`emExecucaoAteMs: 0`) bumps
 * `seq` too, so a late duplicate of a run's last slice is never run again: it only asks once more
 * for the depósito re-run the stored counters name (`revisao`, PR 12-g — the repair of a release
 * that landed behind an error; the re-run's name makes a repeat collide), and any other slice of
 * a released run is refused.
 *
 * Two writers, both tier 1 (a lost precondition re-reads and re-derives):
 *
 *  - the slice holding the lease writes everything, each write `update(patch, { lastUpdateTime })`
 *    on the slice's own read, advance-only (a chain that finds no document starts with a
 *    `create`); its writes of the per-conta documents ride the same batch
 *    (`sincEstoqueLojaIntegrada.ts`, "Writers");
 *  - the `estoque-kits` fan-out holds NO lease and writes ONLY `proximoSlotMs`, the one global
 *    stagger slot every bulk producer takes: `create({ proximoSlotMs })` when the document is
 *    absent (every other field reads its default, so no run is implied; `ALREADY_EXISTS` re-reads),
 *    otherwise `update({ proximoSlotMs }, { lastUpdateTime })` on its own read, advance-only. Its
 *    write moves the update time, so a slice's next precondition fails and re-reads: the slot is
 *    never lost, and neither is the slice's state.
 *
 * Patches are validated through the handle's `parseMerge`, which needs an UNREFINED object
 * ({@link reconcileEstoqueLojaIntegradaBaseSchema}); a full write and every slice's read parse with
 * {@link reconcileEstoqueLojaIntegradaSchema}, which adds the cross-field invariants.
 *
 * ## The price arm (step 13, PR 13-a amendment)
 *
 * The daily price reconcile is FOLDED into this run: one schedule, one lease, one key walk. Three
 * price phases run between the stock `fila` and `fim`, in this order:
 *
 *  - `pais-preco`: the ERP parents of the price snapshot's children, read once, then every
 *    child's target;
 *  - `li-preco`: per conta, the store's prices of the snapshot's sendable children, read BY ID
 *    (`GET /v1/produto_preco/set/{id;…}`, at most 100 ids a call, never the price list), and
 *    diffed against the targets;
 *  - `fila-preco`: the price candidates enqueued on the price queue at the price slot's instants.
 *
 * They are stored in their OWN field, {@link faseReconcilePrecoLiSchema} `fasePreco`, never as
 * new members of `fase`: while the run is in its price arm, `fase` stays `fila` (the stock queue
 * phase, its candidates gone) and `fasePreco` names the price phase; it is absent or `null`
 * otherwise. {@link faseDoRunReconcileLi} reads the two as one ordered phase. A run of an older
 * build never reaches the price arm, so a stored `fila` with no `fasePreco` is the stock queue
 * phase exactly as before; a run whose valve of either flow is `off` skips that flow's phases.
 *
 * `precoSolicitado` is the operator's "Atualizar preços" request the run carries (the conta it
 * names, and whether that conta's sends may lower a price): that conta's price phases bypass the
 * mass-divergence gate and the in-transit deferral. Its first slice's task brings it
 * (`tarefaReconcileEstoqueLiSchema`), and the first slice — the lease take — stores it here,
 * stamped with the run's `execucaoId`; {@link precoSolicitadoDoRunLi} is its one reader.
 *
 * Both fields are ADDITIVE and absent on every document an older build wrote: `.nullable()`
 * `.optional()`, never a default, so a document written before them reads exactly as it did. The
 * price per-conta state lives in `sincPrecoLojaIntegrada/{conta}` (`sincPrecoLojaIntegrada.ts`),
 * never here: this document's candidates and byte budget are the stock's.
 *
 * ## The lease take (⚠️ both fields belong to ONE run)
 *
 * The take validates its patch against an EMPTY expected document and `update`s only the fields
 * the patch names, so it never sees what a dead run left stored. Left out of the patch, a dead
 * run's `fasePreco` would stand beside the new run's `fase: 'erp'` — which the invariant below
 * refuses, so the shared run document would stop parsing and the stock reconcile with it — and a
 * dead run's `precoSolicitado` would hand the operator's "permitir baixar preços" to a nightly
 * nobody asked to lower. So the take ALWAYS writes both, through
 * {@link camposPrecoDaTomadaReconcileLi} (`fasePreco: null`; the task's request stamped with its
 * run, or `null`), and the request is read only through {@link precoSolicitadoDoRunLi}, which
 * ignores one of another `execucaoId` — a second guard for a write that skipped the first. A
 * build that predates the price arm never writes either field: a document it took over while a
 * price build's dead run held a price phase fails the invariant, reads as out of format, and the
 * next take (which resets both) recovers it.
 *
 * ## The price slot (`slot-preco`)
 *
 * The price queue's bulk sends take their instants from a SECOND document of this collection,
 * `reconcileEstoqueLojaIntegrada/{@link ID_SLOT_PRECO_RECONCILE_LI}`, through the same writer as
 * the stock slot: it parses with this schema and holds only `proximoSlotMs`, every other field
 * reading its default (no run is implied). A slot in the future means a bulk price drain is under
 * way. Kept apart from `atual` so a price drain never moves the stock slot, and the reverse.
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

/** The price slot's document id, beside the run document (module header). */
export const ID_SLOT_PRECO_RECONCILE_LI = 'slot-preco';

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

/** The price arm's phases (module header), in order. */
export const faseReconcilePrecoLiSchema = z.enum(['pais-preco', 'li-preco', 'fila-preco']);
export type FaseReconcilePrecoLi = z.infer<typeof faseReconcilePrecoLiSchema>;

/** Named members of {@link faseReconcilePrecoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const FASE_RECONCILE_PRECO_LI = {
  paisPreco: 'pais-preco',
  liPreco: 'li-preco',
  filaPreco: 'fila-preco',
} as const satisfies Record<string, FaseReconcilePrecoLi>;

/** One phase of the whole run, stock and price, as {@link faseDoRunReconcileLi} reads it. */
export type FaseDoRunReconcileLi = FaseReconcileEstoqueLi | FaseReconcilePrecoLi;

/** Every phase of the run, in the order a run goes through them. */
export const ORDEM_FASES_RECONCILE_LI: readonly FaseDoRunReconcileLi[] = [
  FASE_RECONCILE_ESTOQUE_LI.erp,
  FASE_RECONCILE_ESTOQUE_LI.li,
  FASE_RECONCILE_ESTOQUE_LI.fila,
  FASE_RECONCILE_PRECO_LI.paisPreco,
  FASE_RECONCILE_PRECO_LI.liPreco,
  FASE_RECONCILE_PRECO_LI.filaPreco,
  FASE_RECONCILE_ESTOQUE_LI.fim,
];

/**
 * The run's phase as ONE value: `fasePreco` while the run is in its price arm (`fase` is then
 * `fila`), else `fase` (`null` = no phase stored). Pure and total over the two stored fields.
 */
export function faseDoRunReconcileLi(run: {
  readonly fase: FaseReconcileEstoqueLi | null;
  readonly fasePreco?: FaseReconcilePrecoLi | null;
}): FaseDoRunReconcileLi | null {
  return run.fase === FASE_RECONCILE_ESTOQUE_LI.fila && run.fasePreco != null
    ? run.fasePreco
    : run.fase;
}

/** The fields of the "Atualizar preços" request, shared by the task's copy and the run's. */
const CAMPOS_PRECO_SOLICITADO_LI = {
  contaId: contaIdLiSchema,
  /** May that conta's sends lower a price ("permitir baixar preços"; off by default)? */
  permitirBaixar: z.boolean(),
};

/**
 * The operator's "Atualizar preços" request inside the reconcile slice's STRICT task payload
 * (module header): one conta, and whether its sends may lower a price. An id and a flag — never a
 * price; an extra key is refused, never stripped. The task names its run itself.
 */
export const precoSolicitadoTarefaReconcileLiSchema = z.strictObject(CAMPOS_PRECO_SOLICITADO_LI);
export type PrecoSolicitadoTarefaReconcileLi = z.infer<
  typeof precoSolicitadoTarefaReconcileLiSchema
>;

/**
 * The same request as the run document stores it: the request, plus the `execucaoId` of the run
 * that stored it. It belongs to THAT run only — {@link precoSolicitadoDoRunLi} reads a request of
 * another `execucaoId` as none, so a request a dead run left behind never reaches the next one
 * (module header, "The lease take").
 */
export const precoSolicitadoReconcileLiSchema = z.object({
  execucaoId: idExecucaoEstoqueLiSchema,
  ...CAMPOS_PRECO_SOLICITADO_LI,
});
export type PrecoSolicitadoReconcileLi = z.infer<typeof precoSolicitadoReconcileLiSchema>;

/**
 * The "Atualizar preços" request THIS run carries: the stored one when it was stored by the run
 * the document names, else `null` — another run's request, none stored, or no run. The ONE reader:
 * a slice never reads `precoSolicitado` raw.
 *
 * Equal (⇒ the request): `precoSolicitado.execucaoId === run.execucaoId`. Distinct (⇒ `null`):
 * another run's id, however close (`…-20271115` vs `…-20271116`), `null`/absent, and a run
 * document with no run (`execucaoId: null`, the price slot's document).
 */
export function precoSolicitadoDoRunLi(run: {
  readonly execucaoId: string | null;
  readonly precoSolicitado?: PrecoSolicitadoReconcileLi | null;
}): PrecoSolicitadoTarefaReconcileLi | null {
  const pedido = run.precoSolicitado;
  if (pedido == null || run.execucaoId === null || pedido.execucaoId !== run.execucaoId) {
    return null;
  }
  return { contaId: pedido.contaId, permitirBaixar: pedido.permitirBaixar };
}

/** What {@link camposPrecoDaTomadaReconcileLi} returns: the price arm's fields of a new run. */
export interface CamposPrecoDaTomadaReconcileLi {
  readonly fasePreco: null;
  readonly precoSolicitado: PrecoSolicitadoReconcileLi | null;
}

/**
 * The price arm's fields the lease TAKE writes for a new run (module header, "The lease take"):
 * `fasePreco: null` (a new run starts in the stock `erp` phase) and the request the run's first
 * task carries, stamped with that task's run — or `null`, which ERASES a request of a dead run.
 * The take spreads this into its patch beside the stock fields, always: a take that left either
 * field out would hand the dead run's value to the new one.
 */
export function camposPrecoDaTomadaReconcileLi(tarefa: {
  readonly execucaoId: string;
  readonly precoSolicitado?: PrecoSolicitadoTarefaReconcileLi | null;
}): CamposPrecoDaTomadaReconcileLi {
  const pedido = tarefa.precoSolicitado ?? null;
  return {
    fasePreco: null,
    precoSolicitado:
      pedido === null
        ? null
        : {
            execucaoId: tarefa.execucaoId,
            contaId: pedido.contaId,
            permitirBaixar: pedido.permitirBaixar,
          },
  };
}

/**
 * The ERP walk's cursor: the full path of the last store link document it read. The walk is
 * ordered by document KEY over the whole collection group, so a path — never a field value — is
 * what it resumes after, and two links of one store id on either side of a page boundary are
 * both seen.
 *
 * `concluida` (PR 12-g amendment): the walk read its last page — the kits map writer runs next.
 * `ultimoDocPath` is `null` only for a walk that found no link at all.
 */
export const walkReconcileEstoqueLiSchema = z.object({
  ultimoDocPath: z
    .string()
    .regex(/^(?:[^/]+\/[^/]+\/)*produtolojaintegrada\/[^/]+$/)
    .nullable(),
  concluida: z.boolean().default(false),
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

/**
 * The run document's SHAPE alone — the schema the admin handle validates writes with, so a patch
 * can be checked (`.partial()` is refused on a refined object). The invariants are
 * {@link reconcileEstoqueLojaIntegradaSchema}'s.
 */
export const reconcileEstoqueLojaIntegradaBaseSchema = z.object({
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
  /** Step 13 (module header): the price arm's phase; absent/null outside it. */
  fasePreco: faseReconcilePrecoLiSchema.nullable().optional(),
  /** Step 13 (module header): the "Atualizar preços" request the run carries; absent/null = none. */
  precoSolicitado: precoSolicitadoReconcileLiSchema.nullable().optional(),
});

/**
 * {@link reconcileEstoqueLojaIntegradaBaseSchema} with its invariants: the conta index sits at most
 * one past the list (the `li` phase is done with every conta), every candidate names a conta of
 * the list, and a price phase is stored only while `fase` is `fila` (step 13).
 */
export const reconcileEstoqueLojaIntegradaSchema =
  reconcileEstoqueLojaIntegradaBaseSchema.superRefine((run, ctx) => {
    if (run.idxConta > run.contas.length) {
      ctx.addIssue({ code: 'custom', path: ['idxConta'], message: 'idxConta além das contas' });
    }
    if (run.fasePreco != null && run.fase !== FASE_RECONCILE_ESTOQUE_LI.fila) {
      ctx.addIssue({
        code: 'custom',
        path: ['fasePreco'],
        message: 'uma fase de preço só com fase = fila',
      });
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
