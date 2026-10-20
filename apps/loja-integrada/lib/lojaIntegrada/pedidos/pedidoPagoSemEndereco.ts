/**
 * A PAID Loja Integrada order that carries NO CEP at all (owner decisions,
 * 2026-10-19 and 2026-10-20): REFUSED with a retryable error, retried by the
 * queue's backoff and the 30-minute reprocess sweep (the platform may still
 * fill the address), and — once those attempts RAN OUT — failed LOUDLY: an
 * ERROR log line and an open `lojaIntegradaPedidoPagoSemEndereco` aviso, with
 * the notification parked for investigation.
 *
 * ## Who is refused ({@link pedidoPagoSemEnderecoLi}, PURE)
 *
 * All five hold:
 *  - **paid**: the order's codigo is one the label step's paid re-check accepts
 *    (`CODIGOS_LI_PAGO`, exact). A dispute, a cancellation request, an awaiting
 *    payment or a reversal is not: those import as before (the freight amount,
 *    no carrier route — `freteMapeamento.ts`). A dispute's estado is `pago`, but
 *    its codigo is contested, which the label step refuses on its own; refusing
 *    its import as well would hold back the contestado aviso the dispute raises;
 *  - **a shipment**: the order carries one (`envios[0]`). Without one there is
 *    no freight block, so nothing a label could be bought for;
 *  - **no CEP at all** ({@link entregaSemCepLi}): no delivery block, or its
 *    `cep` absent, `null`, the empty text `''` (what the repo reads as nothing)
 *    or whitespace only (decided here: it carries nothing either). Nothing else
 *    is asked of the block — not a street, a número or a bairro.
 *    ⚠️ A PRESENT but INVALID CEP (owner decision, 2026-10-20) is NOT refused,
 *    although the endereço builder reads none from it (`sem-cep`, so step 7
 *    stores no endereço): the store lets the customer type one, and waiting
 *    never fixes it, so retrying would only hold a paid sale back for hours to
 *    raise the same aviso. Such an order imports as any order without an
 *    endereço does — the freight amount and the modalidade, no carrier route
 *    (`freteMapeamento.ts`, "No endereço, no route"), no endereço stored. The
 *    scope is the CEP's ABSENCE, never its quality, and that keeps the rule
 *    order-independent: whichever of an order's observations arrives first,
 *    one with no CEP is refused once paid, one with an invalid CEP imports
 *    without an endereço, and one with a valid CEP — a street or not — passes
 *    here and gets the builder's endereço wherever step 7 stores one;
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
 * An order that HAS a CEP but whose buyer has no document (so no cliente, and
 * no endereço is stored) is not this rule's either: it imports without a
 * route, plus its incidente, as before.
 *
 * ## When the import refuses (`importarPedido.ts`, step 6b, and again per batch attempt)
 *
 * After the freight routing — the pickup verdict needs the target read — and
 * BEFORE the cliente and the endereço (step 7), the batch and the order's
 * avisos. So a refused attempt leaves only what step 6 writes about the
 * conta's configuration: the `mapa` registration of the shipping method
 * (idempotent, and the very row an operator maps to a pickup) and the freight
 * aviso its routing decided — never a cliente, an endereço, a pedido, a
 * pagamento, an incidente or an order aviso. ⚠️ Root rule 7: the last clause
 * reads the pedido snapshot, so the batch re-asks it of EVERY attempt's
 * snapshot (`mapearPedido`): another writer clearing the stored endereço
 * between the read and the batch makes the retry refuse, never land the paid
 * update without an address.
 *
 * ## The error, and the attempts
 *
 * {@link LiPedidoPagoSemEnderecoError} is a plain `Error` — about this import,
 * never about a conta — so the step-3 classifier answers `null` for it and the
 * run RETHROWS: the queue's attempts 0 and 1 back off, the last one persists
 * the row `failed`, and the hot sweep re-drives it hourly. NO second counter is
 * kept: the shared pipeline's own park of a thrown failure at `MAX_TENTATIVAS`
 * is the "attempts exhausted" moment, and it calls `onRetriesExhausted`
 * (`@delfrance/data/admin/notifications`), which this channel binds
 * (`notificacoes/notificacao.ts`, `sinalizarEsgotamentoLi`) to
 * {@link sinalizarPedidoPagoSemEnderecoLi}. A deferred row graduates back to
 * the hot lane with a fresh budget on a throw
 * (`graduateDeferredTransientErrors`), so it reaches the same park.
 *
 * ⚠️ The runtime logs every rethrow (`onTaskDispatched`'s "Unhandled error",
 * which inspects the error's enumerable fields), so the error's PUBLIC fields
 * are ids and the clock only; the store name the aviso needs sits in a private
 * field behind a getter, which no inspection prints.
 *
 * ## The loud signal ({@link sinalizarPedidoPagoSemEnderecoLi})
 *
 * The line FIRST — ERROR severity, ids only (conta, numero, pedido id; never
 * the store name, a buyer's datum or a value) — because it cannot fail, and
 * the row is terminal by then: nothing retries a signal whose aviso write
 * failed. Then the aviso, clocked by the order's stamp as the exhausted run
 * read it, so the import that later finds the address (a newer stamp) resolves
 * it and a late older exhaustion cannot reopen a row a newer import resolved.
 *
 * Residue, accepted: the signal narrows on the error of the run that PARKED.
 * Address refusals followed by a transient failure on that last run (a 429, a
 * 5xx, a Firestore deadline) park the row with that transient's error: the
 * channel's generic ERROR line for a parked notification names the order, but
 * no aviso is raised — nothing records that the earlier runs were refusals.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { CODIGOS_LI_PAGO } from '@delfrance/schemas';

import { avisarPedidoPagoSemEnderecoLi, type PedidoDoAvisoLi } from './avisosPedidoLi';
import type { EnderecoEntregaLi } from './clienteMapeamento';
import { vazioArmazenadoLi } from './vazioArmazenado';

const ROTULO_LOG = '[loja-integrada/importacao]';

/* -------------------------------------------------------------------------- */
/*                                  the rule                                   */
/* -------------------------------------------------------------------------- */

/**
 * The delivery block carries NO CEP at all: no block, or a `cep` absent,
 * `null`, `''` or whitespace only (module header). Any other text is a CEP —
 * valid or not, which is the endereço builder's question, never this one's.
 * Pinned by `pedidoPagoSemEndereco.test.ts`: EQUAL `null`/`''`/`'   '` (no
 * CEP), and the NEAR-MISS `'00000'`/`'abc'`, which the builder reads no
 * endereço from and which still are CEPs here.
 */
export function entregaSemCepLi(endereco: EnderecoEntregaLi | null | undefined): boolean {
  const cep = endereco?.cep;
  return cep === null || cep === undefined || cep.trim() === '';
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
  /** The order carries a shipment (`envios[0]`). */
  readonly temEnvio: boolean;
  /** The routing went to an active pickup target (`RoteamentoFreteLi.dispensaEndereco`). */
  readonly dispensaEndereco: boolean;
  /** The pedido snapshot the decision reads, raw; `null` when there is none. */
  readonly armazenado: PedidoArmazenadoEnderecoLi | null;
}

/** The import must refuse, and retry, this order (module header). */
export function pedidoPagoSemEnderecoLi(entrada: EntradaPedidoPagoSemEnderecoLi): boolean {
  return (
    CODIGOS_LI_PAGO.has(entrada.codigo) &&
    entrada.temEnvio &&
    !entrada.dispensaEndereco &&
    entregaSemCepLi(entrada.enderecoEntrega) &&
    !armazenaEnderecoLi(entrada.armazenado)
  );
}

/* -------------------------------------------------------------------------- */
/*                                  the error                                  */
/* -------------------------------------------------------------------------- */

/**
 * A paid order carrying no CEP at all (module header): the task
 * rethrows it — the step-3 classifier answers `null` — and the queue and the
 * sweep retry. Its public fields and its MESSAGE (the parked row's `erro`) name
 * ids only; the order as its avisos name it — the store name included — is
 * {@link pedido}, a getter over a private field, so the runtime's log of a
 * rethrow never prints it (module header).
 */
export class LiPedidoPagoSemEnderecoError extends Error {
  readonly integracaoId: string;
  readonly pedidoId: string;
  readonly numero: string;
  readonly #pedido: PedidoDoAvisoLi;

  constructor(pedido: PedidoDoAvisoLi) {
    super(
      `O pedido ${pedido.numero} da conta ${pedido.integracaoId} da Loja Integrada está pago e ` +
        'sem CEP no endereço de entrega; a tarefa tenta de novo.',
    );
    this.name = 'LiPedidoPagoSemEnderecoError';
    this.integracaoId = pedido.integracaoId;
    this.pedidoId = pedido.pedidoId;
    this.numero = pedido.numero;
    this.#pedido = pedido;
  }

  /** The order as its avisos name it: what the exhaustion signal needs, with no read. */
  get pedido(): PedidoDoAvisoLi {
    return this.#pedido;
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
