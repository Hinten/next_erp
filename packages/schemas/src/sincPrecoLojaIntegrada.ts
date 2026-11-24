import { z } from 'zod';
import { MAX_AMOSTRA_AVISO_PRECO_LI, motivoPrecoParadoLiSchema } from './aviso';
import {
  ASSINATURA_ENVIO_PRECO_LI_REGEX,
  motivoRetencaoPrecoLiSchema,
} from './precoErpLojaIntegrada';
import { millisSinceEpoch } from './shared/datetime';
import {
  BALDES_SNAPSHOT_ESTOQUE_LI,
  baldeSnapshotEstoqueLi,
  contadoresEstoqueLiSchema,
  idDocumentoEstoqueLiSchema,
  idExecucaoEstoqueLiSchema,
  idProdutoLiTextoSchema,
} from './sincEstoqueLojaIntegrada';

/**
 * `sincPrecoLojaIntegrada/{integracaoId}` (TOP-LEVEL) and its `snapshot` subcollection — the
 * per-conta state of the Loja Integrada price sync's daily reconcile (master plan step 13, PR
 * 13-a), the SIBLING of `sincEstoqueLojaIntegrada/{integracaoId}`: the cursor of the store read BY
 * ID and last-run stats, one run's own state, the non-convergence memory, and the ERP-side
 * snapshot whose sendable children the reconcile asks the store for, by id, and diffs. ONE root
 * document per conta, doc id = `integracaoId`.
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
 * ## The store is read BY ID, never through its price list
 *
 * The store's price list (`GET /v1/produto_preco?limit&offset`) is NOT a whole read. The owner's
 * read-only price capture (2026-11-24, both stores) walked it to the end with every envelope check
 * clean (the rows read equal `total_count`), yet some rows came back on two pages and as many
 * products never came back, among them about one linked child in five on the larger store and one
 * in seventeen on the smaller; on the larger store a middle page re-read about a minute later came
 * back with almost every position changed. The list behaves as if ordered by a non-unique key, so a
 * slower or repeated walk does not fix it. So the reconcile asks the store for exactly the children
 * it may send, at most {@link MAX_IDS_SET_PRECO_LI} ids a call
 * (`GET /v1/produto_preco/set/{id;id;…}`, no trailing slash), which the same capture found complete
 * and exact at 10, 20, 50 and 100 ids: every id asked came back, in the order asked. Nothing here
 * reads, or keeps a cursor into, the price list.
 *
 * ## The documents
 *
 *  - the root: {@link sincPrecoLojaIntegradaSchema} — the cursor of the by-id store read
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
 *     `leituraTabelaPrecoLi` at the run's tabelas, in centavos. A child whose `paiId` names a
 *     parent that is NOT an ERP document id (`paiDoProdutoErp` returns it, the entry's `pai`
 *     refuses it) is no root: the walk stores it already held, `a: { r: 'pai-ausente' }`, with no
 *     `pai`, `n` or `pr` — what `precoAlvoLi` answers for it, with no parent to read;
 *  2. the parents unit (`pais-preco`) reads every distinct `pai` once into `paisErp`, then
 *     computes the target `a` of each valid entry the walk left without one, by replaying the
 *     readings through `precoAlvoLi` (`precosDasLeiturasLi` rebuilds a map that reads back exactly
 *     as the stored readings), never through a second copy of the rule;
 *  3. the store read (`li-preco`) goes through the conta's buckets in order, `'00'` to `'31'`, and
 *     inside each through its ids by numeric value, asking the store — at most
 *     {@link MAX_IDS_SET_PRECO_LI} ids a call, one call spanning buckets — for every `v` entry
 *     whose `a` is a target `{ c, q }`; a held entry and every other flag are never asked. Each
 *     row of the answer is matched to an asked id by the produto it names, never by its position,
 *     and diffed against that entry's `a`. No-lower is decided HERE, the only phase holding the
 *     store row (a refused lowering is counted and sampled, never a candidate), and so is each
 *     candidate's send key `h`. An asked id the answer lists as not found was not returned to this
 *     conta: counted, nothing to diff, never a candidate. One the answer neither returns nor lists
 *     is counted as unanswered, and is never read as "no row". The store read writes no bucket: one
 *     still of another run here is a broken ERP phase, counted with ONE ERROR, its entries never
 *     asked;
 *  4. the queue phase (`fila-preco`) defers a row in transit (`t`), holds back a non-converging
 *     one (its key `h` enqueued on each of the last two runs), enqueues the rest, and writes the
 *     memory.
 *
 * A bucket of another run is replaced at first touch, so by the end of the key walk every bucket
 * carries this run's id (as in the stock snapshot), carrying forward, for every entry that is
 * again valid, the previous target as `ap` and the previous deferral as `tp`: what makes the
 * in-transit rule ("the ERP target moved since the previous run") and its "never two nights in a
 * row" cost zero reads. Nothing else carries over: every entry is one the walk wrote this run.
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
 * The most store product ids one by-id price read names (`GET /v1/produto_preco/set/{id;…}`).
 * MEASURED by the owner's read-only price capture (2026-11-24, both stores): sets of 10, 20, 50
 * and 100 ids each answered every id asked, in the order asked, with no `meta`; above 100 was not
 * asked. ⚠️ The ONE bound: the cursor's `lote` is held to it, the store read never builds a larger
 * set, and the wire's by-id reader refuses one before any request, so a lower bound found later
 * lowers it HERE, never in a copy. (The price list honours 100 too, and 200 answers the gateway's
 * 400, but nothing reads that list.)
 */
export const MAX_IDS_SET_PRECO_LI = 100;

/**
 * Where THIS run's store read stands for this conta (the life of an entry, 3). Every askable entry
 * before (`balde`, `apos`) has been asked and its answer settled: the earlier buckets whole, and in
 * bucket `balde` the ids up to `apos` by numeric value. `apos` `null` = nothing of bucket `balde`
 * yet; `balde` {@link BALDES_SNAPSHOT_ESTOQUE_LI} = the read is done (no id belongs to that
 * bucket, so `apos` is then `null`). It is a position in OUR snapshot, never a store offset: the
 * snapshot is fixed once the parents unit has computed the targets, so a resumed slice asks exactly
 * the ids the cut one had not settled. A cursor of another `execucaoId` is another run's, and the
 * read starts over. `null` = no run is reading this conta's prices.
 *
 * `lote` is how many ids the NEXT call names. The same ids make the same batch every night, so one
 * id the store cannot answer must not stop the rest of the conta every night: a call that fails
 * for its batch halves `lote`, and the next call asks the first half of the same ids; an answered
 * call doubles it back, up to {@link MAX_IDS_SET_PRECO_LI}; an id that still fails alone is
 * skipped for this run (counted) and `lote` starts again at the bound. Which failures halve it is
 * the store read's rule (master plan step 13).
 */
export const reconcileContaPrecoLiSchema = z
  .object({
    /** The run reading. */
    execucaoId: idExecucaoEstoqueLiSchema,
    /** The bucket being read, 0-based; {@link BALDES_SNAPSHOT_ESTOQUE_LI} = done. */
    balde: z.number().int().min(0).max(BALDES_SNAPSHOT_ESTOQUE_LI),
    /** The last id of `balde` already asked and settled; `null` = none yet. */
    apos: idProdutoLiTextoSchema.nullable(),
    /** How many ids the next call names (above). */
    lote: z.number().int().min(1).max(MAX_IDS_SET_PRECO_LI),
    /** MS. When this conta's store read began. */
    iniciadoEmMs: millisSinceEpoch(),
  })
  .refine(
    (c) => c.apos === null || baldeSnapshotEstoqueLi(c.apos) === String(c.balde).padStart(2, '0'),
    { path: ['apos'], message: 'apos fora do balde do cursor' },
  );
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
  /** Ids asked, not found, unanswered, evaluated, candidates, holds, … — named by the run. */
  contadores: contadoresEstoqueLiSchema.default({}),
});
export type UltimoReconcilePrecoLi = z.infer<typeof ultimoReconcilePrecoLiSchema>;

/**
 * The reasons a run keeps a SAMPLE of ERP produto ids for: `retido` (the "sem preço no ERP" aviso:
 * held children — no price, an unreadable entry, a parent that is not there), `nao-baixado` (the
 * refused lowerings) and every `lojaIntegradaPrecoParado` motivo.
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
 * One row to send, kept short (one-letter keys): `i`, the store product id; `p`, the ERP produto;
 * `d`, the target's buyer price minus the store's, in centavos — positive is UNDER-priced in the
 * store, which goes first; `h`, the send's non-convergence key (`assinaturaEnvioPrecoLi` of the
 * target and the store row it was diffed against). The store read sets `h`, being the only phase
 * that holds the store row, so the queue phase can hold back a non-converging row and write the
 * memory with no store value of its own. The send run re-derives everything; `d` only orders.
 */
export const candidatoPrecoLiSchema = z.object({
  i: idProdutoLiTextoSchema,
  p: idDocumentoEstoqueLiSchema,
  d: z.number().int(),
  h: z.string().regex(ASSINATURA_ENVIO_PRECO_LI_REGEX),
});
export type CandidatoPrecoLi = z.infer<typeof candidatoPrecoLiSchema>;

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

/**
 * What ONE run keeps for this conta across its slices. Written by the lease holder only; a value
 * of another `execucaoId` is another run's and is read as none — its candidates included, so a
 * run abandoned mid-queue never hands its rows to the next one.
 *
 *  - `tabelas`: the tabelas the run fixed when it took the lease (a run never prices one conta
 *    from two tabelas; a re-point mid-run is the release's re-run);
 *  - `amostras`: per reason, the first {@link MAX_AMOSTRA_AVISO_PRECO_LI} ERP produto ids (the
 *    counts are `contadores`);
 *  - `contadores`: the conta's price counters of this run;
 *  - `candidatos`: the rows left to enqueue (the price candidates live here, never in the run
 *    document, whose byte budget is the stock's);
 *  - `mantidos`: the memory rows (`enviadosPreco`) of the ids the store read asked for and could
 *    not evaluate (not found, unanswered, unreadable, answered twice, skipped alone), copied as
 *    they were so the queue phase keeps them unchanged: never larger than the memory, and never
 *    an id of `candidatos`.
 *
 * There is no seen-set: the by-id read never repeats an asked id, names the ones it does not get
 * back itself, and the cursor says what is done.
 */
export const execucaoContaPrecoLiSchema = z.object({
  execucaoId: idExecucaoEstoqueLiSchema,
  tabelas: tabelasPrecoLiSchema,
  amostras: z
    .partialRecord(
      motivoAmostraPrecoLiSchema,
      z.array(idDocumentoEstoqueLiSchema).max(MAX_AMOSTRA_AVISO_PRECO_LI),
    )
    .default({}),
  contadores: contadoresEstoqueLiSchema.default({}),
  candidatos: z.array(candidatoPrecoLiSchema).default([]),
  mantidos: z.array(enviadoPrecoLiSchema).default([]),
});
export type ExecucaoContaPrecoLi = z.infer<typeof execucaoContaPrecoLiSchema>;

export const sincPrecoLojaIntegradaSchema = z.object({
  reconcilePreco: reconcileContaPrecoLiSchema.nullable().default(null),
  ultimoReconcilePreco: ultimoReconcilePrecoLiSchema.nullable().default(null),
  execucaoPreco: execucaoContaPrecoLiSchema.nullable().default(null),
  /**
   * The non-convergence memory: survives runs, replaced whole by each run that reaches its queue
   * phase, with the rows of the candidates it enqueued or held back as non-converging, plus
   * `execucaoPreco.mantidos` and, when the conta's store read did not finish, every row of an id
   * past the cursor: an id the run did not evaluate keeps its row as it was.
   */
  enviadosPreco: z.array(enviadoPrecoLiSchema).default([]),
});
export type SincPrecoLojaIntegrada = z.infer<typeof sincPrecoLojaIntegradaSchema>;

/* -------------------------------------------------------------------------- */
/*                                The snapshot                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the reconcile's ERP side decided about one store product id — the entry's `f` (the stock
 * snapshot's flags, minus the stock-only `r` and `par` and its "no link" `x`, plus `pai`):
 *
 *  - `v` (valid): a counting child link of this conta on one produto — its target is computed,
 *    and it is the only entry the store read ever asks for, and only with a target `{ c, q }`;
 *  - `pai`: a parent link — never asked, never sent, counted;
 *  - `amb` (ambiguous): two store ids of this conta on the produto;
 *  - `dup` (duplicate): the same store id is linked from two ERP produtos; neither is sent;
 *  - `ns` (not supported): a shape the step does not send (a simple store product).
 *
 * Only `v` is ever asked or a send candidate, and only when its target says `enviar`. There is no
 * "no link" flag like the stock snapshot's `x`: the store read asks only for ids the ERP named, so
 * no store row ever needs one.
 */
export const flagEntradaPrecoLiSchema = z.enum(['v', 'pai', 'amb', 'dup', 'ns']);
export type FlagEntradaPrecoLi = z.infer<typeof flagEntradaPrecoLiSchema>;

/** Named members of {@link flagEntradaPrecoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const FLAG_ENTRADA_PRECO_LI = {
  valido: 'v',
  pai: 'pai',
  ambiguo: 'amb',
  duplicado: 'dup',
  naoSuportado: 'ns',
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
 *  - `p`: the ERP produto the link sits under (always set);
 *  - `f`: {@link flagEntradaPrecoLiSchema};
 *
 * and, on a `v` entry only (absent otherwise, to keep the entry short):
 *
 *  - `pai`: the parent `paiDoProdutoErp` names, `null`/absent for a root — or for a child the
 *    walk stored already held, whose `a` then says `pai-ausente` (the life of an entry, 1);
 *  - `n`, `pr`: the produto's OWN normal and promo readings ({@link leituraSnapshotPrecoLiSchema})
 *    at the run's tabelas — read even under propagation, because whether the parent propagates is
 *    known only once the parents unit has read it;
 *  - `a`: the target ({@link alvoSnapshotPrecoLiSchema}), written by the parents unit — or by
 *    the walk, for that one hold;
 *  - `ap`: the previous run's `a`, carried at first touch — `a` ≠ `ap` is "the ERP target moved
 *    since the previous run";
 *  - `t`: `true` when THIS run deferred the row as in transit; `tp`: the previous run did (a row
 *    is never deferred two nights in a row). `true` or absent, never `false`.
 */
export const entradaSnapshotPrecoLiSchema = z
  .object({
    p: idDocumentoEstoqueLiSchema,
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
