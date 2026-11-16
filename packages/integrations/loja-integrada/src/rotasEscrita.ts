/**
 * The write routes: the ONLY paths a `PUT` of this package can reach, each with
 * the ONLY body it accepts. Package-local on purpose — not exported from the
 * package root.
 *
 * The request core (`client.ts`, `executarLi`) looks every `PUT` up here before
 * it reads the credential, and refuses with nothing fetched:
 *
 *  - a path that matches no route — `LiConfigError('rota-nao-permitida')`:
 *    another resource, or a route's path in another form (a trailing slash, a
 *    non-canonical id);
 *  - a body its route's schema refuses — `LiConfigError('corpo')`. Each schema
 *    is `.strict()` and holds JSON scalars only ({@link ValorEscritaLi}), and
 *    the core serialises its OUTPUT, never the caller's object, so a number
 *    goes out as a JSON number, unquoted, exactly as the schema produced it.
 *
 * So what the status write-back may never send — a codigo outside the three
 * write-back situações, a cleared or blank tracking code — and what the stock
 * sync may never send — an unmanaged product, a negative or fractional
 * quantity, a quoted number, a situação other than the two fixed ones — is
 * refused for EVERY `PUT` this package can make, not only for the operations in
 * `pedidosEscrita.ts` and `estoqueEscrita.ts`, which build their calls from
 * these same definitions. Steps 11 and 13 add their own rows here.
 *
 * ⚠️ The stock body holds the package's one REQUEST number
 * ({@link quantidadeDeEstoqueValidaLi}), strict on purpose: tolerance is the
 * wrong direction outbound, since accepting `'3'` would mean forwarding it.
 * `integration-response-numbers-tolerant.test.js` carves out that exact line;
 * keep it on its own short line, so Prettier never wraps it out of the guard's
 * line-based scan.
 */
import { z } from 'zod';

/**
 * The ONLY situações this package can write: the three of the status
 * write-back. Never `pedido_pago`, `faturado` or a cancelled situação.
 */
export const CODIGOS_SITUACAO_ESCRITA_LI = [
  'pedido_enviado',
  'pedido_entregue',
  'pronto_para_retirada',
] as const;

export type CodigoSituacaoEscritaLi = (typeof CODIGOS_SITUACAO_ESCRITA_LI)[number];

/** The longest tracking code sent. */
export const MAX_OBJETO_ENVIO_LI = 200;

/** Visible ASCII (`\x21-\x7E`), one to {@link MAX_OBJETO_ENVIO_LI} characters. */
const OBJETO_ENVIO_VALIDO = /^[\x21-\x7E]{1,200}$/;

/**
 * Whether `valor` is a tracking code this package sends: a string of one to
 * {@link MAX_OBJETO_ENVIO_LI} visible-ASCII characters. No space anywhere, so
 * neither an empty nor a blank value can clear a code, and a pasted trailing
 * space is refused rather than trimmed.
 */
export function objetoDeEnvioValidoLi(valor: unknown): valor is string {
  return typeof valor === 'string' && OBJETO_ENVIO_VALIDO.test(valor);
}

/**
 * The three FIXED leaves of every stock write (master-plan step 12): the store
 * manages the product's stock (`gerenciado: true`), with a dispatch lead time
 * of zero days while it is in stock (`situacao_em_estoque: 0`), and the product
 * is unavailable once it runs out (`situacao_sem_estoque: -1`). Only
 * `quantidade` varies.
 *
 * ⚠️ Sent on EVERY stock write, so each one overwrites whatever per-product
 * lead time the store had set, by design (the master plan's step 12). The stock
 * route's schema is built from these same values, so a caller that compares a
 * stored row against what this package sends reads them here, never from a copy.
 *
 * ⚠️ The same strictness means no write can put a row BACK exactly when it held
 * a negative quantity, an unmanaged product or another lead time: a rollback
 * can only send `max(0, prior quantidade)` under these leaves
 * (`estoqueEscrita.ts`).
 */
export const ESTOQUE_FIXO_ESCRITA_LI = {
  gerenciado: true,
  situacao_em_estoque: 0,
  situacao_sem_estoque: -1,
} as const;

/** A stock write's quantity: any non-negative safe integer (strict, see the header). */
const QUANTIDADE_ESTOQUE_ESCRITA = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * Whether `valor` is a quantity this package sends on a stock write: a JSON
 * number that is a non-negative safe integer. A negative number, a fraction,
 * `NaN`, an infinity and every string (`'3'` included) are refused. Read through
 * the stock route's own schema, so the predicate and the route never disagree.
 */
export function quantidadeDeEstoqueValidaLi(valor: unknown): valor is number {
  return QUANTIDADE_ESTOQUE_ESCRITA.safeParse(valor).success;
}

/**
 * One value of a write body: a JSON scalar. Which scalars a route accepts is
 * its schema's decision; nothing is coerced on the way out, because the core
 * serialises the schema's output as it is.
 */
export type ValorEscritaLi = string | number | boolean | null;

/** A write body: one flat object of JSON scalars ({@link ValorEscritaLi}). */
export type CorpoEscritaLi = Readonly<Record<string, ValorEscritaLi>>;

/** One write route: the path it matches, and the one body it accepts. */
export interface RotaEscritaLi {
  /** Anchored at both ends; the id is a canonical positive decimal, never a slash after it. */
  readonly caminho: RegExp;
  readonly corpo: z.ZodType<CorpoEscritaLi>;
}

/** `PUT /v1/pedido_envio/{envio id}`: exactly `{objeto}`, a sendable code. */
const ROTA_OBJETO_ENVIO: RotaEscritaLi = {
  caminho: /^\/v1\/pedido_envio\/[1-9][0-9]*$/,
  corpo: z.object({ objeto: z.string().regex(OBJETO_ENVIO_VALIDO) }).strict(),
};

/** `PUT /v1/situacao/pedido/{numero}`: exactly `{codigo}`, one of the three. */
const ROTA_SITUACAO_PEDIDO: RotaEscritaLi = {
  caminho: /^\/v1\/situacao\/pedido\/[1-9][0-9]*$/,
  corpo: z.object({ codigo: z.enum(CODIGOS_SITUACAO_ESCRITA_LI) }).strict(),
};

/**
 * `PUT /v1/produto_estoque/{produto id}`: exactly the four leaves, the three
 * fixed ones ({@link ESTOQUE_FIXO_ESCRITA_LI}) as literals and a sendable
 * quantity ({@link quantidadeDeEstoqueValidaLi}). The path id is the PRODUTO's
 * id, the public document's path key; no trailing slash.
 */
const ROTA_ESTOQUE_PRODUTO: RotaEscritaLi = {
  caminho: /^\/v1\/produto_estoque\/[1-9][0-9]*$/,
  corpo: z
    .object({
      gerenciado: z.literal(ESTOQUE_FIXO_ESCRITA_LI.gerenciado),
      quantidade: QUANTIDADE_ESTOQUE_ESCRITA,
      situacao_em_estoque: z.literal(ESTOQUE_FIXO_ESCRITA_LI.situacao_em_estoque),
      situacao_sem_estoque: z.literal(ESTOQUE_FIXO_ESCRITA_LI.situacao_sem_estoque),
    })
    .strict(),
};

/** Every route a `PUT` of this package can reach. */
const ROTAS_ESCRITA_LI: readonly RotaEscritaLi[] = [
  ROTA_OBJETO_ENVIO,
  ROTA_SITUACAO_PEDIDO,
  ROTA_ESTOQUE_PRODUTO,
];

/** The route `caminho` names, or `null` when it names none. */
export function rotaDeEscritaLi(caminho: string): RotaEscritaLi | null {
  return ROTAS_ESCRITA_LI.find((rota) => rota.caminho.test(caminho)) ?? null;
}
