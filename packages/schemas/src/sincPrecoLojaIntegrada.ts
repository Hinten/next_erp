import { z } from 'zod';
import { MAX_AMOSTRA_AVISO_PRECO_LI, motivoPrecoParadoLiSchema } from './aviso';
import {
  ASSINATURA_ENVIO_PRECO_LI_REGEX,
  motivoRetencaoPrecoLiSchema,
} from './precoErpLojaIntegrada';
import { millisSinceEpoch } from './shared/datetime';
import {
  contadoresEstoqueLiSchema,
  idDocumentoEstoqueLiSchema,
  idExecucaoEstoqueLiSchema,
  idProdutoLiTextoSchema,
} from './sincEstoqueLojaIntegrada';

/**
 * `sincPrecoLojaIntegrada/{integracaoId}` (TOP-LEVEL) and its `snapshot` subcollection — the
 * per-conta state of the Loja Integrada price sync's daily reconcile (master plan step 13, PR
 * 13-a), the SIBLING of `sincEstoqueLojaIntegrada/{integracaoId}`: the price list's cursor and
 * last-run stats, one run's own state, the non-convergence memory, and the ERP-side snapshot the
 * reconcile diffs the store's price list against. ONE root document per conta, doc id =
 * `integracaoId`.
 *
 * The price reconcile is FOLDED into the stock one: one schedule, one lease and run document
 * (`reconcileEstoqueLojaIntegrada/atual`, whose price phases are `fasePreco`), one ERP key walk.
 * Its per-conta state lives HERE, apart from the stock's, so the stock documents' shapes and byte
 * budgets stay unchanged.
 *
 * ## Nothing here is ever SENT
 *
 * Every price a PUT carries is derived at send time from the ERP (`precoAlvoLi`,
 * `precoErpLojaIntegrada.ts`) and merged over a fresh read of the store's product. The snapshot is
 * a PRE-FILTER: it decides which children are worth a send run, never what that run sends, so a
 * stale entry can only waste one store read or miss a change until the next daily reconcile —
 * never write a wrong price. No custo is kept: the ERP custo is never sent, and the store's own is
 * no reconcile input (the owner's answer to the master plan's §7 q1).
 *
 * ## The documents
 *
 *  - the root: {@link sincPrecoLojaIntegradaSchema} — the cursor into the store's price list
 *    (`reconcilePreco`), the last finished run (`ultimoReconcilePreco`), the running run's own
 *    state with its candidates (`execucaoPreco`), and the non-convergence memory (`enviadosPreco`);
 *  - `snapshot/{'00'..'31'}`: {@link snapshotPrecoLiSchema} — one entry per store product id the
 *    ERP side knows, bucketed by the STOCK snapshot's own function, `baldeSnapshotEstoqueLi`
 *    (the id modulo 32; one bucketing rule for both flows);
 *  - `snapshot/paisErp`: {@link paisErpSnapshotPrecoLiSchema} — the parents unit's working state:
 *    the ERP parents of the snapshot's children, each read ONCE per run after the key walk.
 *
 * ## The life of an entry in one run
 *
 *  1. the shared key walk (`erp`) writes `p`, `f` and, for a valid child, its parent (`pai`) and
 *     its OWN two readings (`n`, `pr`) — the produto's own `precos` read through
 *     `leituraTabelaPrecoLi` at the run's tabelas, in centavos;
 *  2. the parents unit (`pais-preco`) reads every distinct `pai` once into `paisErp`, then
 *     computes each valid entry's target `a` by replaying the readings through `precoAlvoLi`
 *     (`precosDasLeiturasLi` rebuilds a map that reads back exactly as the stored readings), never
 *     through a second copy of the rule;
 *  3. the store's list walk (`li-preco`) diffs each row against `a`;
 *  4. the queue phase (`fila-preco`) defers a row in transit (`t`), skips a non-converging one,
 *     and enqueues the rest.
 *
 * A bucket of another run is replaced at first touch, carrying forward its `x` entries (a store row
 * no link of the conta names) as the stock snapshot does, and — for every entry that is again
 * valid — the previous target as `ap` and the previous deferral as `tp`: what makes the in-transit
 * rule ("the ERP target moved since the previous run") and its "never two nights in a row" cost
 * zero reads.
 *
 * ## Units
 *
 * Every stamp is MILLISECONDS and says so in its name (`…Ms`); every price is integer CENTAVOS.
 *
 * ## Writers (root `CLAUDE.md` rule 7)
 *
 * Only the reconcile run holding the lease in `reconcileEstoqueLojaIntegrada/atual` writes here,
 * and every document a run writes carries that run's `execucaoId`: a value of another run is read
 * as none. Every write rides the slice's ONE batch, which also updates the run document under its
 * own read's `lastUpdateTime` (tier 1); beside it, each document here is `create`d when absent and
 * otherwise `update`d under the slice's own read of it (whole fields, advance-only). The send
 * runs and the trigger only READ. No transaction.
 *
 * ## Admin-only / default-deny
 *
 * NOT registered in `ALL_DOMAINS` and no Meta, so the rules generator emits no match block and no
 * client can read any of it. Bare schemas, never a `{ schema, meta }` export (`registry.test.ts`).
 * Unknown keys are STRIPPED.
 */

/** The root collection's path. */
export const COLECAO_SINC_PRECO_LI = 'sincPrecoLojaIntegrada';

/** The one subcollection under a conta's root document. */
export const SUBCOLECOES_SINC_PRECO_LI = {
  snapshot: 'snapshot',
} as const;

/** The parents unit's document id, beside the 32 buckets. */
export const ID_PAIS_ERP_SNAPSHOT_PRECO_LI = 'paisErp';

/* -------------------------------------------------------------------------- */
/*                                  The root                                   */
/* -------------------------------------------------------------------------- */

/**
 * The largest page the store's price list is asked for. PROVISIONAL: the owner's read-only price
 * capture measures the list's own bound (it asks `limit` 20, 50, 100 and 200 and reads `meta.limit`
 * back); until then this is the bound MEASURED on the produto and stock lists of the same store,
 * which honour 100 and refuse 200. ⚠️ The ONE bound: the cursor below holds its `limite` to it and
 * the wire's page reader will refuse anything above it, so a capture that shows a lower bound
 * lowers it HERE, never in a copy.
 */
export const MAX_LIMITE_PAGINA_PRECO_LI = 100;

/**
 * Where the reconcile stands in the store's price list for this conta: read whole, one page per
 * call, `limite` rows at a time from `offset`, the stock cursor's shape. `null` = no run is
 * reading this conta's price list.
 */
export const reconcileContaPrecoLiSchema = z.object({
  /** The next row to read, 0-based. */
  offset: z.number().int().nonnegative(),
  /** The page size the run started with; a run never changes it mid-list. */
  limite: z.number().int().min(1).max(MAX_LIMITE_PAGINA_PRECO_LI),
  /** MS. When this conta's list read began. */
  iniciadoEmMs: millisSinceEpoch(),
});
export type ReconcileContaPrecoLi = z.infer<typeof reconcileContaPrecoLiSchema>;

/**
 * The tabelas a run priced this conta with, as BARE `listaDePrecos` document ids (the conta's
 * refs, folded once when the run took the lease): `normal` always, `promocional` `null` when the
 * conta names none or names its normal tabela again ("no promo list").
 */
export const tabelasPrecoLiSchema = z.object({
  normal: idDocumentoEstoqueLiSchema,
  promocional: idDocumentoEstoqueLiSchema.nullable(),
});
export type TabelasPrecoLi = z.infer<typeof tabelasPrecoLiSchema>;

/**
 * What the last FINISHED run counted for this conta, and the tabelas it priced with — the next
 * run's in-transit rule applies only when they are the same (a re-point is no transit).
 */
export const ultimoReconcilePrecoLiSchema = z.object({
  execucaoId: idExecucaoEstoqueLiSchema,
  /** MS. */
  iniciadoEmMs: millisSinceEpoch(),
  /** MS. */
  concluidoEmMs: millisSinceEpoch(),
  /** `null` for a run that priced nothing for the conta (no normal tabela). */
  tabelas: tabelasPrecoLiSchema.nullable().default(null),
  /** Rows read, entries, candidates, holds, refusals, … — named by the run. */
  contadores: contadoresEstoqueLiSchema.default({}),
});
export type UltimoReconcilePrecoLi = z.infer<typeof ultimoReconcilePrecoLiSchema>;

/**
 * The reasons a run keeps a SAMPLE of ERP produto ids for: `retido` (the "sem preço no ERP" aviso:
 * held children, unreadable ones included), `nao-baixado` (the refused lowerings) and every
 * `lojaIntegradaPrecoParado` motivo.
 */
export const motivoAmostraPrecoLiSchema = z.enum([
  'retido',
  'nao-baixado',
  ...motivoPrecoParadoLiSchema.options,
]);
export type MotivoAmostraPrecoLi = z.infer<typeof motivoAmostraPrecoLiSchema>;

/** Named members of {@link motivoAmostraPrecoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_AMOSTRA_PRECO_LI = {
  retido: 'retido',
  naoBaixado: 'nao-baixado',
  divergenciaEmMassa: 'divergencia-em-massa',
  naoConverge: 'nao-converge',
} as const satisfies Record<string, MotivoAmostraPrecoLi>;

/**
 * One row to send, kept short (about 30 bytes): `i`, the store product id; `p`, the ERP produto;
 * `d`, the target's buyer price minus the store's, in centavos — positive is UNDER-priced in the
 * store, which goes first. The send run re-derives everything; `d` only orders.
 */
export const candidatoPrecoLiSchema = z.object({
  i: idProdutoLiTextoSchema,
  p: idDocumentoEstoqueLiSchema,
  d: z.number().int(),
});
export type CandidatoPrecoLi = z.infer<typeof candidatoPrecoLiSchema>;

/**
 * What ONE run keeps for this conta across its slices. Written by the lease holder only; a value
 * of another `execucaoId` is another run's and is read as none — its candidates included, so a
 * run abandoned mid-queue never hands its rows to the next one.
 *
 *  - `tabelas`: the tabelas the run fixed when it took the lease (a run never prices one conta
 *    from two tabelas; a re-point mid-run is the release's re-run);
 *  - `vistos`: the store ids the price list walk of THIS run has seen or settled;
 *  - `amostras`: per reason, the first {@link MAX_AMOSTRA_AVISO_PRECO_LI} ERP produto ids (the
 *    counts are `contadores`);
 *  - `contadores`: the conta's price counters of this run;
 *  - `candidatos`: the rows left to enqueue (the price candidates live here, never in the run
 *    document, whose byte budget is the stock's).
 */
export const execucaoContaPrecoLiSchema = z.object({
  execucaoId: idExecucaoEstoqueLiSchema,
  tabelas: tabelasPrecoLiSchema,
  vistos: z.array(idProdutoLiTextoSchema).default([]),
  amostras: z
    .partialRecord(
      motivoAmostraPrecoLiSchema,
      z.array(idDocumentoEstoqueLiSchema).max(MAX_AMOSTRA_AVISO_PRECO_LI),
    )
    .default({}),
  contadores: contadoresEstoqueLiSchema.default({}),
  candidatos: z.array(candidatoPrecoLiSchema).default([]),
});
export type ExecucaoContaPrecoLi = z.infer<typeof execucaoContaPrecoLiSchema>;

/**
 * One row of the non-convergence memory: `i`, the store product id; `h`, the key of the send the
 * run enqueued (`assinaturaEnvioPrecoLi`: the target and the store value it was diffed against, in
 * centavos); `n`, on how many consecutive runs that SAME key was enqueued. A row whose key repeats
 * on the run after `n` reached 2 is `nao-converge`: kept, never enqueued, until the target or the
 * store value changes — which changes the key.
 */
export const enviadoPrecoLiSchema = z.object({
  i: idProdutoLiTextoSchema,
  h: z.string().regex(ASSINATURA_ENVIO_PRECO_LI_REGEX),
  n: z.number().int().positive(),
});
export type EnviadoPrecoLi = z.infer<typeof enviadoPrecoLiSchema>;

export const sincPrecoLojaIntegradaSchema = z.object({
  reconcilePreco: reconcileContaPrecoLiSchema.nullable().default(null),
  ultimoReconcilePreco: ultimoReconcilePrecoLiSchema.nullable().default(null),
  execucaoPreco: execucaoContaPrecoLiSchema.nullable().default(null),
  /** The non-convergence memory: survives runs, replaced whole by each run that reaches its queue phase. */
  enviadosPreco: z.array(enviadoPrecoLiSchema).default([]),
});
export type SincPrecoLojaIntegrada = z.infer<typeof sincPrecoLojaIntegradaSchema>;

/* -------------------------------------------------------------------------- */
/*                                The snapshot                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the reconcile's ERP side decided about one store product id — the entry's `f` (the stock
 * snapshot's flags, minus the stock-only `r` and `par`, plus `pai`):
 *
 *  - `v` (valid): a counting child link of this conta on one produto — its target is computed;
 *  - `pai`: a parent link — its price row is never sent, and it is known so the list walk never
 *    looks it up;
 *  - `amb` (ambiguous): two store ids of this conta on the produto;
 *  - `dup` (duplicate): the same store id is linked from two ERP produtos; neither is sent;
 *  - `ns` (not supported): a shape the step does not send (a simple store product);
 *  - `x` (no link): a row of the store's list that no link of this conta names — cached so the
 *    lookup is not repeated every day.
 *
 * Only `v` is ever a send candidate, and only when its target says `enviar`.
 */
export const flagEntradaPrecoLiSchema = z.enum(['v', 'pai', 'amb', 'dup', 'ns', 'x']);
export type FlagEntradaPrecoLi = z.infer<typeof flagEntradaPrecoLiSchema>;

/** Named members of {@link flagEntradaPrecoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const FLAG_ENTRADA_PRECO_LI = {
  valido: 'v',
  pai: 'pai',
  ambiguo: 'amb',
  duplicado: 'dup',
  naoSuportado: 'ns',
  semVinculo: 'x',
} as const satisfies Record<string, FlagEntradaPrecoLi>;

/**
 * One tabela entry as the snapshot keeps it — a `leituraTabelaPrecoLi` answer in short form: the
 * price in integer centavos (> 0) or `'il'` for `ilegivel`; every field holding one is nullable,
 * and `null` (or absent) is `ausente`.
 */
export const leituraSnapshotPrecoLiSchema = z.union([z.number().int().positive(), z.literal('il')]);
export type LeituraSnapshotPrecoLi = z.infer<typeof leituraSnapshotPrecoLiSchema>;

/**
 * A valid entry's target, as `precoAlvoLi` computed it, in short form: `{ c, q }` — the full price
 * and the promotion in centavos, `q` `null` for the clear — or `{ r }`, held, with its motivo.
 */
export const alvoSnapshotPrecoLiSchema = z.union([
  z.object({
    c: z.number().int().positive(),
    q: z.number().int().positive().nullable(),
  }),
  z.object({ r: motivoRetencaoPrecoLiSchema }),
]);
export type AlvoSnapshotPrecoLi = z.infer<typeof alvoSnapshotPrecoLiSchema>;

/**
 * One snapshot entry, kept short on purpose (keys of one to three letters: about 90 bytes):
 *
 *  - `p`: the ERP produto the link sits under; `null` exactly when `f` is `x`;
 *  - `f`: {@link flagEntradaPrecoLiSchema};
 *
 * and, on a `v` entry only (absent otherwise, to keep the entry short):
 *
 *  - `pai`: the parent `paiDoProdutoErp` names, `null`/absent for a root;
 *  - `n`, `pr`: the produto's OWN normal and promo readings ({@link leituraSnapshotPrecoLiSchema})
 *    at the run's tabelas — read even under propagation, because whether the parent propagates is
 *    known only once the parents unit has read it;
 *  - `a`: the target ({@link alvoSnapshotPrecoLiSchema}), written by the parents unit;
 *  - `ap`: the previous run's `a`, carried at first touch — `a` ≠ `ap` is "the ERP target moved
 *    since the previous run";
 *  - `t`: `true` when THIS run deferred the row as in transit; `tp`: the previous run did (a row
 *    is never deferred two nights in a row). `true` or absent, never `false`.
 */
export const entradaSnapshotPrecoLiSchema = z
  .object({
    p: idDocumentoEstoqueLiSchema.nullable(),
    f: flagEntradaPrecoLiSchema,
    pai: idDocumentoEstoqueLiSchema.nullable().optional(),
    n: leituraSnapshotPrecoLiSchema.nullable().optional(),
    pr: leituraSnapshotPrecoLiSchema.nullable().optional(),
    a: alvoSnapshotPrecoLiSchema.nullable().optional(),
    ap: alvoSnapshotPrecoLiSchema.nullable().optional(),
    t: z.literal(true).nullable().optional(),
    tp: z.literal(true).nullable().optional(),
  })
  .superRefine((entrada, ctx) => {
    if ((entrada.f === FLAG_ENTRADA_PRECO_LI.semVinculo) !== (entrada.p === null)) {
      ctx.addIssue({ code: 'custom', path: ['p'], message: 'p é nulo exatamente quando f = x' });
    }
    if (entrada.f === FLAG_ENTRADA_PRECO_LI.valido) return;
    for (const chave of ['pai', 'n', 'pr', 'a', 'ap', 't', 'tp'] as const) {
      if (entrada[chave] != null) {
        ctx.addIssue({ code: 'custom', path: [chave], message: 'só uma entrada válida tem preço' });
      }
    }
  });
export type EntradaSnapshotPrecoLi = z.infer<typeof entradaSnapshotPrecoLiSchema>;

/** `snapshot/{'00'..'31'}`: the entries of one bucket, keyed by store product id. */
export const snapshotPrecoLiSchema = z.object({
  /** The run that wrote this bucket. */
  execucaoId: idExecucaoEstoqueLiSchema,
  e: z.record(idProdutoLiTextoSchema, entradaSnapshotPrecoLiSchema).default({}),
});
export type SnapshotPrecoLi = z.infer<typeof snapshotPrecoLiSchema>;

/**
 * What the parents unit read of one ERP parent: `pp`, its `propagatePriceToChildren` folded by
 * `propagaPrecoAosFilhos` (only a stored literal `false` is `false`); `n`, `pr`, its own normal and
 * promo readings at the run's tabelas. `null` = the parent document does not exist (its children
 * are held `pai-ausente`).
 */
export const paiErpPrecoLiSchema = z
  .object({
    pp: z.boolean(),
    n: leituraSnapshotPrecoLiSchema.nullable().default(null),
    pr: leituraSnapshotPrecoLiSchema.nullable().default(null),
  })
  .nullable();
export type PaiErpPrecoLi = z.infer<typeof paiErpPrecoLiSchema>;

/**
 * `snapshot/paisErp`: the parents unit's working state — every distinct parent the snapshot's
 * valid children name, as it was read (`pais`, by ERP produto id). A parent absent from the map is
 * not read yet; the unit reads them in masked batches, ONCE per run, and computes the targets when
 * none is left.
 */
export const paisErpSnapshotPrecoLiSchema = z.object({
  execucaoId: idExecucaoEstoqueLiSchema,
  pais: z.record(idDocumentoEstoqueLiSchema, paiErpPrecoLiSchema).default({}),
});
export type PaisErpSnapshotPrecoLi = z.infer<typeof paisErpSnapshotPrecoLiSchema>;
