/**
 * The two write operations of the order status write-back (master-plan step
 * 7), over the write client (`escrita.ts`):
 *
 *  - {@link atualizarObjetoEnvioLi} — `PUT /v1/pedido_envio/{envio id}`
 *    `{objeto}`, the tracking code. The path id is the ENVIO's id
 *    (`envios[].id` of the order detail), never the order's. ⚠️ Loja Integrada
 *    treats this write like the painel does: storing a code also moves the
 *    order to `pedido_enviado` and e-mails the buyer;
 *  - {@link alterarSituacaoPedidoLi} — `PUT /v1/situacao/pedido/{numero}`
 *    `{codigo}`, the situação. The path id is the order NUMBER. Each situação
 *    change e-mails the buyer too.
 *
 * Each one only builds and sends: no read, no retry, no decision. Whether a
 * write is due, safe or already reflected is the app's to decide from a fresh
 * read made just before it; every error is the write client's, rethrown as-is.
 *
 * ## What the package itself refuses — so no caller can do it
 *
 *  - **Only three codigos:** {@link CODIGOS_SITUACAO_ESCRITA_LI} is a closed,
 *    package-local set (`pedido_enviado`, `pedido_entregue`,
 *    `pronto_para_retirada`). Any other codigo — `faturado`, a paid one, a
 *    cancelled one, an unknown string, the right one in another case — is
 *    `LiConfigError('codigo-nao-permitido')` before anything is built, and
 *    nothing is fetched.
 *  - **No clear:** `objeto` must be non-empty, at most
 *    {@link MAX_OBJETO_ENVIO_LI} characters of visible ASCII
 *    ({@link objetoDeEnvioValidoLi}), sent as given (no trim, no case change).
 *    So no call can blank a code, and a code with a space or a non-ASCII
 *    character is never sent. The app checks the same predicate first, to
 *    tell a person; this is the backstop (`LiConfigError('corpo')`, nothing
 *    fetched).
 *  - **Ids** go through the shared path-id reader (`idsDeCaminho.ts`).
 *
 * ## Paths: NO trailing slash, unlike the reads
 *
 * The reads use the slash form (`pedidos.ts`), as their captures were
 * requested. These two paths have none: they are the public document's own
 * path keys. The client never follows a redirect, so a wrong form fails
 * VISIBLY — a 3xx `LiHttpError`, with nothing written — and the first real
 * write after the cutover confirms the form.
 *
 * ## Echoes
 *
 * Each echo is read through a tolerant schema in `pedidoTipos.ts`
 * (`liEcoPedidoEnvioSchema`, `liEcoSituacaoPedidoSchema`), every field
 * optional: an echo is diagnostic, and a write that landed is reported, never
 * thrown (`escrita.ts`).
 */
import { z } from 'zod';

import type { LiEscritaClient, RespostaEscritaLi } from './escrita';
import { LiConfigError } from './errors';
import { idOuRecusa } from './idsDeCaminho';
import {
  type EcoPedidoEnvioLi,
  type EcoSituacaoPedidoLi,
  liEcoPedidoEnvioSchema,
  liEcoSituacaoPedidoSchema,
} from './pedidoTipos';

/**
 * The ONLY situações this package can write: the three of the status
 * write-back. Never `faturado`, a paid or a cancelled situação.
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

function codigoDeEscritaLi(valor: unknown): valor is CodigoSituacaoEscritaLi {
  return CODIGOS_SITUACAO_ESCRITA_LI.some((codigo) => codigo === valor);
}

/** The tracking-code body: exactly `{objeto}`, a sendable code. */
const corpoObjetoEnvioSchema = z.object({ objeto: z.string().regex(OBJETO_ENVIO_VALIDO) }).strict();

/** The situação body: exactly `{codigo}`, one of the three. */
const corpoSituacaoPedidoSchema = z
  .object({ codigo: z.enum(CODIGOS_SITUACAO_ESCRITA_LI) })
  .strict();

export interface OpcoesEscritaLi {
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

/**
 * `PUT /v1/pedido_envio/{envioId}` `{objeto}`: write the tracking code of ONE
 * envio. `envioId` is the envio's id from the order detail, never the order's
 * id or numero.
 */
export async function atualizarObjetoEnvioLi(
  cliente: LiEscritaClient,
  envioId: number | string,
  objeto: string,
  opts: OpcoesEscritaLi = {},
): Promise<RespostaEscritaLi<EcoPedidoEnvioLi>> {
  const operacao = 'atualizarObjetoEnvio';
  const id = idOuRecusa(envioId, operacao);
  return cliente.enviarEscritaLi({
    operacao,
    caminho: `/v1/pedido_envio/${id}`,
    corpo: { objeto },
    corpoSchema: corpoObjetoEnvioSchema,
    ecoSchema: liEcoPedidoEnvioSchema,
    sinal: opts.sinal,
  });
}

/**
 * `PUT /v1/situacao/pedido/{numero}` `{codigo}`: move ONE order to one of the
 * three write-back situações.
 */
export async function alterarSituacaoPedidoLi(
  cliente: LiEscritaClient,
  numero: number | string,
  codigo: CodigoSituacaoEscritaLi,
  opts: OpcoesEscritaLi = {},
): Promise<RespostaEscritaLi<EcoSituacaoPedidoLi>> {
  const operacao = 'alterarSituacaoPedido';
  // Checked at run time too: the type is a promise a cast or a JS caller can break.
  if (!codigoDeEscritaLi(codigo)) {
    throw new LiConfigError('codigo-nao-permitido', { operacao, refCredencial: null });
  }
  const id = idOuRecusa(numero, operacao);
  return cliente.enviarEscritaLi({
    operacao,
    caminho: `/v1/situacao/pedido/${id}`,
    corpo: { codigo },
    corpoSchema: corpoSituacaoPedidoSchema,
    ecoSchema: liEcoSituacaoPedidoSchema,
    sinal: opts.sinal,
  });
}
