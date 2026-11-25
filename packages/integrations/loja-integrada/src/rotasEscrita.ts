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
 * write-back situações, a cleared or blank tracking code — what the stock
 * sync may never send — an unmanaged product, a negative or fractional
 * quantity, a quoted number, a situação other than the two fixed ones — and
 * what the price sync may never send — a full price of 0, a third decimal
 * place, a quoted price, a `null` custo, a missing `sob_consulta`, a stray key
 * — is refused for EVERY `PUT` this package can make, not only for the
 * operations in `pedidosEscrita.ts`, `estoqueEscrita.ts` and `precoEscrita.ts`,
 * which build their calls from these same definitions. Step 11 adds its own
 * rows here.
 *
 * ⚠️ The stock and price bodies hold the package's REQUEST numbers — the stock
 * quantity ({@link quantidadeDeEstoqueValidaLi}), the price
 * ({@link precoDeEscritaValidoLi}) and the echoed custo
 * ({@link custoEcoavelLi}) — strict on purpose: tolerance is the wrong
 * direction outbound, since accepting `'3'` would mean forwarding it.
 * `integration-response-numbers-tolerant.test.js` carves out each exact line
 * that spells a Zod number; keep each on its own short line, so Prettier never
 * wraps it out of the guard's line-based scan.
 */
import { centavosDeReais, roundReais } from '@delfrance/core/money';
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

/** A price we send, in reais: above 0 (the line the guard carves out; refined below). */
const REAIS_PRECO_ESCRITA = z.number().positive();

/**
 * A price this package SENDS (`cheio`, and a positive `promocional`): a JSON
 * number above 0 with at most two decimal places, judged as the money module
 * judges them (`roundReais(v) === v`, so `274.425` and `0.1 + 0.2` are
 * refused, never rounded here), whose centavos are a safe integer: so it
 * serialises with at most two decimals, and no larger amount than the price
 * fold reads can be sent. The body builder makes it as `centavos / 100` and
 * checks the exact round trip itself (`precoEscrita.ts`).
 */
const PRECO_ESCRITA = REAIS_PRECO_ESCRITA.refine(
  (v) => roundReais(v) === v && Number.isSafeInteger(centavosDeReais(v)),
  'no máximo 2 casas decimais',
);

/**
 * The store's OWN custo, echoed back on a price write (never the ERP's): a
 * JSON number, not negative. The two-decimal rule does NOT bind it: it is the
 * store's value, sent back as the store's produto detail carries it.
 */
const CUSTO_ECO_ESCRITA = z.number().min(0);

/**
 * A price write's `promocional`: a positive price ({@link PRECO_ESCRITA}), or
 * one of the clear's spellings, `0` and `null`. (The third spelling, the full
 * price itself, is a positive price.) Which clear is SENT is the body
 * builder's call, from the configured shape (`precoEscrita.ts`): the request
 * core looks a route up by its path alone, so the route accepts the union.
 */
const PROMOCIONAL_ESCRITA = z.union([PRECO_ESCRITA, z.literal(0), z.null()]);

/**
 * Whether `valor` is a price this package sends: a JSON number above 0 with at
 * most two decimal places and safe-integer centavos. `0`, a negative, a third
 * decimal place, `NaN`, an infinity and every string (`'274.42'` included) are
 * refused. Read through the price route's own schema.
 */
export function precoDeEscritaValidoLi(valor: unknown): valor is number {
  return PRECO_ESCRITA.safeParse(valor).success;
}

/**
 * Whether `valor` is a custo a price write can echo: a JSON number, not
 * negative (`0` included, any number of decimals). `null`, a string
 * (`'10.50'`, `'0.0000'`), a negative and `NaN` are refused: such a custo is
 * OMITTED from the body, never sent (`precoEscrita.ts`). Read through the price
 * route's own schema.
 */
export function custoEcoavelLi(valor: unknown): valor is number {
  return CUSTO_ECO_ESCRITA.safeParse(valor).success;
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
 * id, the public document's path key; no trailing slash. A GET at this exact
 * path form was captured answering 200 (the owner's read-only stock captures);
 * the PUT itself stays unproven until the first canary write.
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

/**
 * A price write that echoes the store's custo: exactly the four leaves, in the
 * order the public document's example writes them (the order sent).
 */
const CORPO_PRECO_COM_CUSTO = z
  .object({
    cheio: PRECO_ESCRITA,
    custo: CUSTO_ECO_ESCRITA,
    promocional: PROMOCIONAL_ESCRITA,
    sob_consulta: z.boolean(),
  })
  .strict();

/** A price write whose custo the store holds as `null` (or unreadable): the key is OMITTED. */
const CORPO_PRECO_SEM_CUSTO = z
  .object({
    cheio: PRECO_ESCRITA,
    promocional: PROMOCIONAL_ESCRITA,
    sob_consulta: z.boolean(),
  })
  .strict();

/**
 * Two strict objects, never one with an optional `custo`: the key is either a
 * sendable number or absent, never `null`, and `sob_consulta` is always there
 * (every price write is a FULL one).
 */
const CORPO_PRECO_PRODUTO = z.union([CORPO_PRECO_COM_CUSTO, CORPO_PRECO_SEM_CUSTO]);

/** A price write's body, as the price route accepts and serialises it. */
export type CorpoPrecoProdutoLi = z.infer<typeof CORPO_PRECO_PRODUTO>;

/**
 * Whether `valor` is a body the price route sends: one of the two strict shapes
 * above. Read through the route's own schema, so a caller's diff and the route
 * never disagree.
 */
export function corpoPrecoProdutoValidoLi(valor: unknown): valor is CorpoPrecoProdutoLi {
  return CORPO_PRECO_PRODUTO.safeParse(valor).success;
}

/**
 * `PUT /v1/produto_preco/{produto id}`: a FULL price body (`cheio`,
 * `promocional`, `sob_consulta`, and `custo` when the store holds one), each
 * leaf strict. The path id is the PRODUTO's id, the public document's path key;
 * no trailing slash. Unproven until the first canary write: the path form,
 * whether the store reads the body as full or partial, whether it keeps cents
 * on `promocional` (the document types that leaf as an integer), and which
 * clear it accepts (`precoEscrita.ts`).
 */
const ROTA_PRECO_PRODUTO: RotaEscritaLi = {
  caminho: /^\/v1\/produto_preco\/[1-9][0-9]*$/,
  corpo: CORPO_PRECO_PRODUTO,
};

/** Every route a `PUT` of this package can reach. */
const ROTAS_ESCRITA_LI: readonly RotaEscritaLi[] = [
  ROTA_OBJETO_ENVIO,
  ROTA_SITUACAO_PEDIDO,
  ROTA_ESTOQUE_PRODUTO,
  ROTA_PRECO_PRODUTO,
];

/** The route `caminho` names, or `null` when it names none. */
export function rotaDeEscritaLi(caminho: string): RotaEscritaLi | null {
  return ROTAS_ESCRITA_LI.find((rota) => rota.caminho.test(caminho)) ?? null;
}
