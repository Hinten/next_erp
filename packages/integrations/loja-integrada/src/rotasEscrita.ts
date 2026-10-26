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
 *    is `.strict()` and holds strings only, and the core serialises its OUTPUT,
 *    never the caller's object.
 *
 * So what the status write-back may never send — a codigo outside the three
 * write-back situações, a cleared or blank tracking code — is refused for EVERY
 * `PUT` this package can make, not only for the two operations in
 * `pedidosEscrita.ts`, which build their calls from these same definitions.
 * Steps 11–13 add their own rows here.
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

/** A write body: string values only, so nothing numeric is coerced on the way out. */
export type CorpoEscritaLi = Readonly<Record<string, string>>;

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

/** Every route a `PUT` of this package can reach. */
const ROTAS_ESCRITA_LI: readonly RotaEscritaLi[] = [ROTA_OBJETO_ENVIO, ROTA_SITUACAO_PEDIDO];

/** The route `caminho` names, or `null` when it names none. */
export function rotaDeEscritaLi(caminho: string): RotaEscritaLi | null {
  return ROTAS_ESCRITA_LI.find((rota) => rota.caminho.test(caminho)) ?? null;
}
