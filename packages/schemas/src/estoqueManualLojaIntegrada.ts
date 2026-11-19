import { z } from 'zod';
import { contaIdLiSchema } from './notificacaoLojaIntegrada';
import { idDocumentoEstoqueLiSchema, idExecucaoEstoqueLiSchema } from './sincEstoqueLojaIntegrada';

/* -------------------------------------------------------------------------- */
/*   Loja Integrada stock: the wire contract of the two operator stock routes   */
/* -------------------------------------------------------------------------- */

/**
 * The shared wire contract of the two operator routes of the Loja Integrada stock sync (master plan
 * step 12, PR 12-h), and of their callers in `apps/web`. ONE definition, imported by both sides:
 * `apps/web` has no dependency edge to any app, so a shape written twice would drift.
 *
 *  - `POST /api/marketplace/loja-integrada/enviar-estoque` — the produtos table's manual push. It
 *    ENQUEUES one stock send task per linked child and sends nothing itself: each row it answers
 *    says `enfileirado`, never "sent" — the send run, minutes later, reads the ERP and the store
 *    and decides on its own whether anything is written.
 *  - `POST /api/marketplace/loja-integrada/conta/[id]/estoque/reconciliar` — the operator's
 *    "reconcile now": ONE full stock reconcile run enqueued at once (the run covers every active
 *    conta with a depósito, not just the one in the path).
 *
 * Their error envelope is `erroContaLojaIntegradaSchema`, with the `CODIGO_ERRO_LI` codes.
 *
 * ⚠️ The ANSWERS are deliberately not strict — at every level: the answer, each row, each
 * `produtosSemEnvio` entry — and their `motivo` and `modo` fields are plain strings: the backend
 * deploys BEFORE the web, so an older browser must still read a newer backend's answer — a motivo
 * or a valve mode a later step adds, or a field it adds to a row, must not turn rows that WERE
 * enqueued into a parse failure. Only the per-row `resultado` is a closed enum, because the web
 * decides on it.
 */

/** The most produto ids one push request may name (the request body's cap). */
export const MAX_PRODUTOS_ENVIO_ESTOQUE_LI = 200;

/**
 * The push request: the Loja Integrada conta and the produtos the operator selected — parents
 * (expanded to their children by the route) or children / simple produtos, in any mix.
 *
 * Strict: an unknown key is a 400. There is deliberately no `reenviarComErro`: this channel keeps
 * no refusal latch for a manual push to bypass.
 */
export const corpoEnvioEstoqueLiSchema = z.strictObject({
  contaId: contaIdLiSchema,
  produtoIds: z.array(idDocumentoEstoqueLiSchema).min(1).max(MAX_PRODUTOS_ENVIO_ESTOQUE_LI),
});
export type CorpoEnvioEstoqueLi = z.infer<typeof corpoEnvioEstoqueLiSchema>;

/**
 * What became of one child:
 *
 *  - `enfileirado`: its stock send task is on the stock queue (or was already, this minute) — the
 *    send run decides later; NOTHING was sent by the route;
 *  - `pulado`: a link-shaped skip the send run would make too (see {@link MOTIVO_ENVIO_ESTOQUE_LI});
 *  - `falha`: the queue did not confirm the enqueue.
 */
export const resultadoEnvioEstoqueLiSchema = z.enum(['enfileirado', 'pulado', 'falha']);
export type ResultadoEnvioEstoqueLi = z.infer<typeof resultadoEnvioEstoqueLiSchema>;

/** Named members of {@link resultadoEnvioEstoqueLiSchema} — see `delfrance/prefer-schema-enum`. */
export const RESULTADO_ENVIO_ESTOQUE_LI = {
  enfileirado: 'enfileirado',
  pulado: 'pulado',
  falha: 'falha',
} as const satisfies Record<string, ResultadoEnvioEstoqueLi>;

/**
 * Why a row was skipped or failed, as the backend PRODUCES it. The answer carries it as a plain
 * string (module header), so this enum is the producer's vocabulary, never the reader's gate.
 *
 *  - `sem-vinculo`: no counting link of the conta (the produto-side conta list does not name it,
 *    or its links do not count);
 *  - `pai`: only parent links — a parent's row is never sent;
 *  - `nao-suportado`: a root link with no grades (a simple store product);
 *  - `vinculo-ambiguo`: two store products of the conta linked to one ERP produto;
 *  - `paridade`: the operator switched stock sending off for this listing;
 *  - `produto-ausente`: no ERP produto with that id;
 *  - `fila-indisponivel`: the queue did not confirm the enqueue (it may still have landed).
 */
export const motivoEnvioEstoqueLiSchema = z.enum([
  'sem-vinculo',
  'pai',
  'nao-suportado',
  'vinculo-ambiguo',
  'paridade',
  'produto-ausente',
  'fila-indisponivel',
]);
export type MotivoEnvioEstoqueLi = z.infer<typeof motivoEnvioEstoqueLiSchema>;

/** Named members of {@link motivoEnvioEstoqueLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_ENVIO_ESTOQUE_LI = {
  semVinculo: 'sem-vinculo',
  pai: 'pai',
  naoSuportado: 'nao-suportado',
  vinculoAmbiguo: 'vinculo-ambiguo',
  paridade: 'paridade',
  produtoAusente: 'produto-ausente',
  filaIndisponivel: 'fila-indisponivel',
} as const satisfies Record<string, MotivoEnvioEstoqueLi>;

/**
 * The stock valve the route read, as the backend PRODUCES it: `dry-run` or `on` — never `off`,
 * with the valve off the routes refuse and enqueue nothing. It is the valve of the BACKEND that
 * answered: what a send run writes is decided by the functions codebase's own copy. The answers
 * carry it as a plain string (module header), so this enum is the producer's vocabulary, never
 * the reader's gate.
 */
export const modoEstoqueLiSchema = z.enum(['dry-run', 'on']);
export type ModoEstoqueLi = z.infer<typeof modoEstoqueLiSchema>;

/** Named members of {@link modoEstoqueLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MODO_ESTOQUE_LI = {
  dryRun: 'dry-run',
  on: 'on',
} as const satisfies Record<string, ModoEstoqueLi>;

/**
 * One child the push looked at: `produtoId` is the CHILD (each Loja Integrada child is its own
 * listing), `solicitadoId` the selected id it came from (the child itself, or its parent),
 * `produtoNome` the child's own name when read, `idLi` the store product when a link named one.
 */
export const linhaEnvioEstoqueLiSchema = z.object({
  produtoId: z.string(),
  solicitadoId: z.string(),
  produtoNome: z.string().nullable(),
  idLi: z.string().nullable(),
  resultado: resultadoEnvioEstoqueLiSchema,
  motivo: z.string().nullable(),
  mensagem: z.string(),
});
export type LinhaEnvioEstoqueLi = z.infer<typeof linhaEnvioEstoqueLiSchema>;

/** A selected id none of whose children made a row: ONE entry for the whole selection item. */
export const produtoSemEnvioEstoqueLiSchema = z.object({
  produtoId: z.string(),
  produtoNome: z.string().nullable(),
  motivo: z.string(),
  mensagem: z.string(),
});
export type ProdutoSemEnvioEstoqueLi = z.infer<typeof produtoSemEnvioEstoqueLiSchema>;

/** The push's 200 answer. `solicitados` counts the DISTINCT selected ids. */
export const respostaEnvioEstoqueLiSchema = z.object({
  contaId: z.string(),
  modo: z.string(),
  solicitados: z.number().int().nonnegative(),
  listings: z.array(linhaEnvioEstoqueLiSchema),
  produtosSemEnvio: z.array(produtoSemEnvioEstoqueLiSchema),
});
export type RespostaEnvioEstoqueLi = z.infer<typeof respostaEnvioEstoqueLiSchema>;

/**
 * The reconcile route's 202 answer: the run it enqueued (or that this minute already enqueued),
 * the valve it read, and whether THIS backend's read switch is on (informational: the route does
 * not gate on it, and the run's store phase reads the functions codebase's own copy).
 */
export const respostaReconcileEstoqueLiSchema = z.object({
  execucaoId: idExecucaoEstoqueLiSchema,
  modo: z.string(),
  chamadas: z.boolean(),
  mensagem: z.string(),
});
export type RespostaReconcileEstoqueLi = z.infer<typeof respostaReconcileEstoqueLiSchema>;
