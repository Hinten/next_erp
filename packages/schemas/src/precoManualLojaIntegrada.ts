import { z } from 'zod';
import { contaIdLiSchema } from './notificacaoLojaIntegrada';
import { idDocumentoEstoqueLiSchema, idExecucaoEstoqueLiSchema } from './sincEstoqueLojaIntegrada';

/* -------------------------------------------------------------------------- */
/*   Loja Integrada price: the wire contract of the two operator price routes   */
/* -------------------------------------------------------------------------- */

/**
 * The shared wire contract of the two operator routes of the Loja Integrada price sync (master
 * plan step 13, PR 13-a), and of their callers in `apps/web` — the twin of
 * `estoqueManualLojaIntegrada.ts`. ONE definition, imported by both sides: `apps/web` has no
 * dependency edge to any app, so a shape written twice would drift.
 *
 *  - `POST /api/marketplace/loja-integrada/enviar-precos` — the produtos table's manual price
 *    push. It ENQUEUES one price send task per linked child and sends nothing itself: each row it
 *    answers says `enfileirado`, never "sent" — the send run, minutes later, reads the ERP and the
 *    store and decides on its own whether anything is written. A manual push MAY lower a price
 *    only when the operator asks (`baixarPreco`).
 *  - `POST /api/marketplace/loja-integrada/conta/[id]/preco/atualizar` — "Atualizar preços": ONE
 *    full reconcile run enqueued at once (stock included; the run covers every active conta), in
 *    which THIS conta's price sends bypass the nightly mass gate and may lower a price only when
 *    the operator asks (`permitirBaixar`).
 *
 * Their error envelope is `erroContaLojaIntegradaSchema`, with the `CODIGO_ERRO_LI` codes.
 *
 * ⚠️ The REQUESTS are strict (an unknown key is a 400), and an absent lowering flag is `false`:
 * lowering a price is never implied. The ANSWERS are deliberately not strict — at every level —
 * and their `motivo` and `modo` fields are plain strings, for the stock twin's reason: the backend
 * deploys BEFORE the web, so an older browser must still read a newer backend's answer. Only the
 * per-row `resultado` is a closed enum, because the web decides on it.
 */

/** The most produto ids one push request may name (the request body's cap). */
export const MAX_PRODUTOS_ENVIO_PRECO_LI = 200;

/**
 * The push request: the Loja Integrada conta, the produtos the operator selected — parents
 * (expanded to their children by the route) or children / simple produtos, in any mix — and
 * whether the push may LOWER a price (absent ⇒ `false`).
 *
 * Strict: an unknown key — a price, a custo, a `reenviarComErro` — is a 400. No price rides in the
 * request: each send run derives its own.
 */
export const corpoEnvioPrecoLiSchema = z.strictObject({
  contaId: contaIdLiSchema,
  produtoIds: z.array(idDocumentoEstoqueLiSchema).min(1).max(MAX_PRODUTOS_ENVIO_PRECO_LI),
  baixarPreco: z.boolean().default(false),
});
export type CorpoEnvioPrecoLi = z.infer<typeof corpoEnvioPrecoLiSchema>;

/**
 * "Atualizar preços"'s request: may this conta's sends LOWER a price (absent ⇒ `false`)? The conta
 * is the route's path segment. Strict: an unknown key is a 400.
 */
export const corpoAtualizacaoPrecoLiSchema = z.strictObject({
  permitirBaixar: z.boolean().default(false),
});
export type CorpoAtualizacaoPrecoLi = z.infer<typeof corpoAtualizacaoPrecoLiSchema>;

/**
 * What became of one child:
 *
 *  - `enfileirado`: its price send task is on the price queue (or was already, this minute) — the
 *    send run decides later; NOTHING was sent by the route;
 *  - `pulado`: a link-shaped skip the send run would make too (see {@link MOTIVO_ENVIO_PRECO_LI});
 *  - `falha`: the queue did not confirm the enqueue.
 */
export const resultadoEnvioPrecoLiSchema = z.enum(['enfileirado', 'pulado', 'falha']);
export type ResultadoEnvioPrecoLi = z.infer<typeof resultadoEnvioPrecoLiSchema>;

/** Named members of {@link resultadoEnvioPrecoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const RESULTADO_ENVIO_PRECO_LI = {
  enfileirado: 'enfileirado',
  pulado: 'pulado',
  falha: 'falha',
} as const satisfies Record<string, ResultadoEnvioPrecoLi>;

/**
 * Why a row was skipped or failed, as the backend PRODUCES it. The answer carries it as a plain
 * string (module header), so this enum is the producer's vocabulary, never the reader's gate.
 *
 *  - `sem-vinculo`: no counting link of the conta;
 *  - `pai`: only parent links — a parent's price is never sent;
 *  - `nao-suportado`: a root link with no grades (a simple store product);
 *  - `vinculo-ambiguo`: two store products of the conta linked to one ERP produto;
 *  - `produto-ausente`: no ERP produto with that id;
 *  - `fila-indisponivel`: the queue did not confirm the enqueue (it may still have landed).
 *
 * A child with no ERP price is NOT skipped here: it is enqueued, and its send run holds it (the
 * route reads no price).
 */
export const motivoEnvioPrecoLiSchema = z.enum([
  'sem-vinculo',
  'pai',
  'nao-suportado',
  'vinculo-ambiguo',
  'produto-ausente',
  'fila-indisponivel',
]);
export type MotivoEnvioPrecoLi = z.infer<typeof motivoEnvioPrecoLiSchema>;

/** Named members of {@link motivoEnvioPrecoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_ENVIO_PRECO_LI = {
  semVinculo: 'sem-vinculo',
  pai: 'pai',
  naoSuportado: 'nao-suportado',
  vinculoAmbiguo: 'vinculo-ambiguo',
  produtoAusente: 'produto-ausente',
  filaIndisponivel: 'fila-indisponivel',
} as const satisfies Record<string, MotivoEnvioPrecoLi>;

/**
 * The price valve the route read, as the backend PRODUCES it: `dry-run` or `on` — never `off`,
 * with the valve off the routes refuse and enqueue nothing. It is the valve of the BACKEND that
 * answered: what a send run writes is decided by the functions codebase's own copy. A plain string
 * in the answers (module header), so this enum is the producer's vocabulary, never the reader's
 * gate.
 */
export const modoPrecoLiSchema = z.enum(['dry-run', 'on']);
export type ModoPrecoLi = z.infer<typeof modoPrecoLiSchema>;

/** Named members of {@link modoPrecoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const MODO_PRECO_LI = {
  dryRun: 'dry-run',
  on: 'on',
} as const satisfies Record<string, ModoPrecoLi>;

/**
 * One child the push looked at: `produtoId` is the CHILD (each Loja Integrada child is its own
 * listing), `solicitadoId` the selected id it came from (the child itself, or its parent),
 * `produtoNome` the child's own name when read, `idLi` the store product when a link named one.
 */
export const linhaEnvioPrecoLiSchema = z.object({
  produtoId: z.string(),
  solicitadoId: z.string(),
  produtoNome: z.string().nullable(),
  idLi: z.string().nullable(),
  resultado: resultadoEnvioPrecoLiSchema,
  motivo: z.string().nullable(),
  mensagem: z.string(),
});
export type LinhaEnvioPrecoLi = z.infer<typeof linhaEnvioPrecoLiSchema>;

/** A selected id none of whose children made a row: ONE entry for the whole selection item. */
export const produtoSemEnvioPrecoLiSchema = z.object({
  produtoId: z.string(),
  produtoNome: z.string().nullable(),
  motivo: z.string(),
  mensagem: z.string(),
});
export type ProdutoSemEnvioPrecoLi = z.infer<typeof produtoSemEnvioPrecoLiSchema>;

/**
 * The push's 200 answer. `solicitados` counts the DISTINCT selected ids; `baixarPreco` is the
 * lowering choice every enqueued send carries.
 */
export const respostaEnvioPrecoLiSchema = z.object({
  contaId: z.string(),
  modo: z.string(),
  baixarPreco: z.boolean(),
  solicitados: z.number().int().nonnegative(),
  listings: z.array(linhaEnvioPrecoLiSchema),
  produtosSemEnvio: z.array(produtoSemEnvioPrecoLiSchema),
});
export type RespostaEnvioPrecoLi = z.infer<typeof respostaEnvioPrecoLiSchema>;

/**
 * "Atualizar preços"'s 202 answer: the run it enqueued (or that this minute already enqueued), the
 * valve it read, the lowering choice the run carries, and whether THIS backend's read switch is on
 * (informational: the route does not gate on it, and the run's store phases read the functions
 * codebase's own copy).
 */
export const respostaAtualizacaoPrecoLiSchema = z.object({
  execucaoId: idExecucaoEstoqueLiSchema,
  modo: z.string(),
  permitirBaixar: z.boolean(),
  chamadas: z.boolean(),
  mensagem: z.string(),
});
export type RespostaAtualizacaoPrecoLi = z.infer<typeof respostaAtualizacaoPrecoLiSchema>;
