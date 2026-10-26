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
 * ## What the package refuses, for every write it can send
 *
 * The request core checks EVERY `PUT` against the write routes
 * (`rotasEscrita.ts`) before it reads the credential, so these hold for any
 * holder of a write client, not only for the two functions below:
 *
 *  - **Only three codigos:** {@link CODIGOS_SITUACAO_ESCRITA_LI}
 *    (`pedido_enviado`, `pedido_entregue`, `pronto_para_retirada`). Any other
 *    codigo — `pedido_pago`, `faturado`, a cancelled one, an unknown string,
 *    the right one in another case — is refused and nothing is fetched.
 *    {@link alterarSituacaoPedidoLi} refuses it first, by name
 *    (`LiConfigError('codigo-nao-permitido')`); a direct write is refused by
 *    the route (`LiConfigError('corpo')`).
 *  - **No clear:** `objeto` must be non-empty, at most
 *    {@link MAX_OBJETO_ENVIO_LI} characters of visible ASCII
 *    ({@link objetoDeEnvioValidoLi}), sent as given (no trim, no case change).
 *    So no write can blank a code, and a code with a space or a non-ASCII
 *    character is never sent (`LiConfigError('corpo')`, nothing fetched). The
 *    app's write-back flow is to check the same predicate first, to tell a
 *    person (master-plan step 7, PR 7-d); this is the backstop.
 *  - **No other path:** a path that is not one of the two routes, in exactly
 *    the form below, is `LiConfigError('rota-nao-permitida')`.
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
import type { LiEscritaClient, RespostaEscritaLi } from './escrita';
import { LiConfigError } from './errors';
import { idOuRecusa } from './idsDeCaminho';
import {
  type EcoPedidoEnvioLi,
  type EcoSituacaoPedidoLi,
  liEcoPedidoEnvioSchema,
  liEcoSituacaoPedidoSchema,
} from './pedidoTipos';
import { CODIGOS_SITUACAO_ESCRITA_LI, type CodigoSituacaoEscritaLi } from './rotasEscrita';

export {
  CODIGOS_SITUACAO_ESCRITA_LI,
  type CodigoSituacaoEscritaLi,
  MAX_OBJETO_ENVIO_LI,
  objetoDeEnvioValidoLi,
} from './rotasEscrita';

function codigoDeEscritaLi(valor: unknown): valor is CodigoSituacaoEscritaLi {
  return CODIGOS_SITUACAO_ESCRITA_LI.some((codigo) => codigo === valor);
}

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
    ecoSchema: liEcoSituacaoPedidoSchema,
    sinal: opts.sinal,
  });
}
