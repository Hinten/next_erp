/**
 * A PAID Loja Integrada order with no usable delivery address (owner decision,
 * 2026-10-19): REFUSED with a retryable error, retried by the queue's backoff
 * and the 30-minute reprocess sweep (the platform may still fill the address),
 * and — once those attempts RAN OUT — failed LOUDLY: an ERROR log line and an
 * open `lojaIntegradaPedidoPagoSemEndereco` aviso, with the notification
 * parked for investigation.
 *
 * ## Who is refused ({@link pedidoPagoSemEnderecoLi}, PURE)
 *
 * All four hold:
 *  - **paid**: the order's codigo is one the label step's paid re-check accepts
 *    (`CODIGOS_LI_PAGO`, exact). A dispute, a cancellation request, an awaiting
 *    payment or a reversal is not: those import as before (the freight amount,
 *    no carrier route — `freteMapeamento.ts`);
 *  - **no usable address** ({@link enderecoEntregaUtilizavelLi}): the delivery
 *    block, read by the SAME endereço builder the import stores an endereço
 *    with (`enderecoDoPedidoLi` → `buildEnderecoForcado`), yields a CEP and a
 *    street. Absent, empty, no CEP the builder can read (`sem-cep`), or a
 *    street it had to fill with its own placeholder
 *    (`ENDERECO_FALLBACKS.logradouro`) is no address: a label to a CEP with no
 *    street is a label to an unknown address. Nothing else is asked of it —
 *    no número, bairro or cidade stops a label;
 *  - **not a pickup**: the routing did not send the order to an active
 *    `retiradaNaLoja` target (`RoteamentoFreteLi.dispensaEndereco`, read from
 *    the target DOCUMENT's tipo) — a pickup ships nothing, imports normally and
 *    keeps its route;
 *  - **the pedido stores no endereço**: neither a fiscal endereço nor the
 *    freight block's delivery one (any non-empty value, `vazioArmazenadoLi`). A
 *    pedido that already has one — an operator's, or an earlier import's — is
 *    no pedido without an address, and refusing its update would hold back the
 *    paid estado for nothing; whether that endereço pairs with the cliente is
 *    step 7's question (`importarPedido.ts`), unchanged.
 *
 * An order that HAS a usable address but whose buyer has no document (so no
 * cliente, and no endereço is stored) is not this rule's: it imports without a
 * route, plus its incidente, as before.
 *
 * ## When the import refuses (`importarPedido.ts`, step 6b)
 *
 * After the freight routing — the pickup verdict needs the target read — and
 * BEFORE the cliente and the endereço (step 7), the batch and the avisos. So
 * the only write a refused attempt leaves is step 20's `mapa` registration of
 * the shipping method (idempotent, about the conta's configuration, and the
 * very row an operator maps to a pickup), never a cliente, an endereço, a
 * pedido, a pagamento, an incidente or an aviso.
 *
 * ## The error, and the attempts
 *
 * {@link LiPedidoPagoSemEnderecoError} is a plain `Error` — about this import,
 * never about a conta — so the step-3 classifier answers `null` for it and the
 * run RETHROWS: the queue's attempts 0 and 1 back off, the last one persists
 * the row `failed`, and the hot sweep re-drives it hourly. NO second counter is
 * kept: the shared pipeline's own park at `MAX_TENTATIVAS` is the "attempts
 * exhausted" moment, and it calls `onRetriesExhausted`
 * (`@delfrance/data/admin/notifications`), which this channel binds to
 * {@link sinalizarPedidoPagoSemEnderecoLi} (`notificacoes/notificacao.ts`). A
 * deferred row graduates back to the hot lane with a fresh budget on a throw
 * (`graduateDeferredTransientErrors`), so it reaches the same park.
 *
 * ## The loud signal ({@link sinalizarPedidoPagoSemEnderecoLi})
 *
 * The line FIRST — ERROR severity, ids only (conta, numero, pedido id; never
 * the store name, a buyer's datum or a value) — because it cannot fail, and
 * the row is terminal by then: nothing retries a signal whose aviso write
 * failed. Then the aviso, clocked by the order's stamp as the exhausted run
 * read it, so the import that later finds the address (a newer stamp) resolves
 * it and a late older exhaustion cannot reopen a row a newer import resolved.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { CODIGOS_LI_PAGO, ENDERECO_FALLBACKS } from '@delfrance/schemas';

import { avisarPedidoPagoSemEnderecoLi, type PedidoDoAvisoLi } from './avisosPedidoLi';
import { enderecoDoPedidoLi, type EnderecoEntregaLi } from './clienteMapeamento';
import { vazioArmazenadoLi } from './vazioArmazenado';

const ROTULO_LOG = '[loja-integrada/importacao]';

/* -------------------------------------------------------------------------- */
/*                                  the rule                                   */
/* -------------------------------------------------------------------------- */

/**
 * A delivery block a label can ship to: a CEP and a street, as the endereço
 * builder reads them (module header).
 */
export function enderecoEntregaUtilizavelLi(
  endereco: EnderecoEntregaLi | null | undefined,
): boolean {
  const outcome = enderecoDoPedidoLi(endereco);
  if (outcome.kind === 'sem-cep') return false;
  return outcome.fields.logradouro !== ENDERECO_FALLBACKS.logradouro;
}

/** The stored pedido fields the rule reads — raw, as the snapshot holds them. */
export type PedidoArmazenadoEnderecoLi = Readonly<Record<string, unknown>>;

/** The pedido already stores an endereço: a fiscal one, or the freight block's delivery one. */
function armazenaEnderecoLi(armazenado: PedidoArmazenadoEnderecoLi | null): boolean {
  if (armazenado === null) return false;
  if (!vazioArmazenadoLi(armazenado.enderecoFiscalOuterRef)) return true;
  const frete = armazenado.freteInicial;
  return (
    typeof frete === 'object' &&
    frete !== null &&
    !Array.isArray(frete) &&
    !vazioArmazenadoLi((frete as Readonly<Record<string, unknown>>).enderecoFreteOuterReference)
  );
}

export interface EntradaPedidoPagoSemEnderecoLi {
  /** The detail's `situacao.codigo`, verbatim. */
  readonly codigo: string;
  /** The detail's `endereco_entrega`. */
  readonly enderecoEntrega: EnderecoEntregaLi | null | undefined;
  /** The routing went to an active pickup target (`RoteamentoFreteLi.dispensaEndereco`). */
  readonly dispensaEndereco: boolean;
  /** The pedido snapshot the import read (step 3), raw; `null` when there is none. */
  readonly armazenado: PedidoArmazenadoEnderecoLi | null;
}

/** The import must refuse, and retry, this order (module header). */
export function pedidoPagoSemEnderecoLi(entrada: EntradaPedidoPagoSemEnderecoLi): boolean {
  return (
    CODIGOS_LI_PAGO.has(entrada.codigo) &&
    !entrada.dispensaEndereco &&
    !enderecoEntregaUtilizavelLi(entrada.enderecoEntrega) &&
    !armazenaEnderecoLi(entrada.armazenado)
  );
}

/* -------------------------------------------------------------------------- */
/*                                  the error                                  */
/* -------------------------------------------------------------------------- */

/**
 * A paid order without a usable delivery address (module header): the task
 * rethrows it — the step-3 classifier answers `null` — and the queue and the
 * sweep retry. It carries the order as its avisos name it, so the exhaustion
 * signal needs no read; its MESSAGE names ids only (it is the parked row's
 * `erro`), never the store name.
 */
export class LiPedidoPagoSemEnderecoError extends Error {
  readonly pedido: PedidoDoAvisoLi;

  constructor(pedido: PedidoDoAvisoLi) {
    super(
      `O pedido ${pedido.numero} da conta ${pedido.integracaoId} da Loja Integrada está pago e ` +
        'sem endereço de entrega utilizável; a tarefa tenta de novo.',
    );
    this.name = 'LiPedidoPagoSemEnderecoError';
    this.pedido = pedido;
  }
}

/* -------------------------------------------------------------------------- */
/*                              the loud signal                                */
/* -------------------------------------------------------------------------- */

/** What the signal needs: the aviso's counter, the clock, and the run's logger. */
export interface DepsSinalPedidoPagoSemEnderecoLi {
  /** `(by) => FieldValue.increment(by)`: the aviso's counter. */
  readonly increment: (by: number) => unknown;
  /** Now, in MILLISECONDS (the aviso seam converts it). */
  readonly agoraMs: () => number;
  readonly logger?: {
    warn(msg: string, meta?: Record<string, unknown>): void;
    error?(msg: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * The notification pipeline's exhaustion signal, for THIS channel's refusal:
 * `false` (and nothing done) for any other error parked at the cap; for ours,
 * the ERROR line, then the open aviso (module header). A failed aviso write
 * rethrows — the shared core contains it and reports it — after the line.
 */
export async function sinalizarPedidoPagoSemEnderecoLi(
  db: Firestore,
  err: Error,
  deps: DepsSinalPedidoPagoSemEnderecoLi,
): Promise<boolean> {
  if (!(err instanceof LiPedidoPagoSemEnderecoError)) return false;
  const { pedido } = err;
  const ids = {
    integracaoId: pedido.integracaoId,
    numero: pedido.numero,
    pedidoId: pedido.pedidoId,
  };
  const linha = `${ROTULO_LOG} pedido PAGO sem endereço de entrega: tentativas esgotadas, notificação estacionada`;
  // ERROR severity whatever logger the run was handed: the console's is one too.
  if (deps.logger?.error === undefined) console.error(linha, ids);
  else deps.logger.error(linha, ids);
  await avisarPedidoPagoSemEnderecoLi(db, pedido, {
    increment: deps.increment,
    nowMs: deps.agoraMs(),
    logger: deps.logger,
  });
  return true;
}
