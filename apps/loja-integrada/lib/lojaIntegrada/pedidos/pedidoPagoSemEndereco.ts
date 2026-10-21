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
 *    `cep` absent, `null`, the empty text `''`, whitespace only (decided
 *    here: it carries nothing either), or the `'-'` placeholder for "nothing
 *    was sent", bare or padded (owner decision, 2026-10-20) — exactly the
 *    shared absence reader's `ausente` verdict (`motivoDaRecusa`,
 *    `@delfrance/schemas`). Nothing else is asked of the block — not a
 *    street, a número or a bairro. ⚠️ Only that verdict: the same reader
 *    also folds a MASKED value (an `*` anywhere) into "unusable"
 *    (`valorUtilizavel` answers `null` for both), but a redaction is text in
 *    the field — a present, INVALID CEP (below), pinned as such by the tests.
 *    Reading a mask as absent would refuse and retry that order like one
 *    with no CEP.
 *    ⚠️ A PRESENT but INVALID CEP (owner decision, 2026-10-20) is NOT refused,
 *    although the endereço builder reads none from it (`sem-cep`, so step 7
 *    stores no endereço): the store lets the customer type one, and waiting
 *    never fixes it, so retrying would only hold a paid sale back for hours to
 *    raise the same aviso. Such an order imports as any order without an
 *    endereço does — the freight amount and the modalidade, no carrier route
 *    (`freteMapeamento.ts`, "No endereço, no route"), no endereço stored —
 *    and it leaves an open aviso of that order OPEN (below, "When an import
 *    closes the aviso"). The scope is the CEP's ABSENCE, never its quality,
 *    and that keeps the rule order-independent: whichever of an order's
 *    observations arrives first, one with no CEP is refused once paid, one
 *    with an invalid CEP imports without an endereço, and one with a valid
 *    CEP — a street or not — passes here and gets the builder's endereço
 *    wherever step 7 stores one;
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
 * no endereço is stored) is not refused either: it imports without a route,
 * plus its incidente, as before — and, storing no endereço, it leaves an open
 * aviso of that order OPEN (below): a readable CEP closes the aviso only
 * through the endereço step 7 stores, and that needs a cliente to store it
 * under.
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
 *
 * ## When an import closes the aviso ({@link pedidoPagoSegueSemEnderecoLi}, PURE)
 *
 * Owner decision, 2026-10-20: only once the pedido, as the WINNING attempt
 * leaves it, has a delivery endereço (one it already stores, never
 * overwritten: the ref is fill-once; or one this import stored under the
 * pedido's cliente), or a pickup route, or the order is no longer paid. Then
 * step 11 resolves the row (`avisosPedidoLi.ts`, clocked by the order's
 * stamp). Nothing else closes it: otherwise the resolve is SKIPPED and an open
 * row stays open — above all for a paid order that comes back with a present
 * but INVALID CEP onto a pedido that stores none: it imports with no endereço
 * and no route, and the operator still has an address to fix. The same holds
 * for a readable CEP whose buyer has no valid document (no cliente to store
 * the endereço under, so none is stored), and for an observation that carries
 * NO shipment: the shipment is not on the owner's list, and such an import
 * leaves a freight block an earlier one stored as it was, still with no
 * address to ship it to. A skip seeds no row either: the pedido still waits,
 * so a raise of that state stays correct. The verdict is the refusal minus its
 * shipment and CEP clauses (the two share `pagoAguardandoEnderecoLi`, so they
 * cannot drift), asked of the snapshot the WINNING attempt decided from (root
 * rule 7): an endereço another writer stored or cleared between the read and
 * the batch is judged as it stands.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { CODIGOS_LI_PAGO, MOTIVO_RECUSA, TIPO_DE_VALOR, motivoDaRecusa } from '@delfrance/schemas';

import { avisarPedidoPagoSemEnderecoLi, type PedidoDoAvisoLi } from './avisosPedidoLi';
import type { EnderecoEntregaLi } from './clienteMapeamento';
import { vazioArmazenadoLi } from './vazioArmazenado';

const ROTULO_LOG = '[loja-integrada/importacao]';

/* -------------------------------------------------------------------------- */
/*                                  the rule                                   */
/* -------------------------------------------------------------------------- */

/**
 * The delivery block carries NO CEP at all: no block, or a `cep` the shared
 * reader calls ABSENT — absent, `null`, `''`, whitespace only, or the `'-'`
 * placeholder, bare or padded (module header). Any other text is a CEP —
 * valid or not, which is the endereço builder's question, never this one's.
 * Pinned by `pedidoPagoSemEndereco.test.ts`: EQUAL `null`/`''`/`'   '`/`'-'`/
 * `' - '` (no CEP), and the NEAR-MISS `'00000'`/`'abc'`/`'--'`/`'*****-***'`,
 * which the builder reads no endereço from and which still are CEPs here.
 * ⚠️ The `ausente` verdict only, never `valorUtilizavel`'s `null`: that one
 * also covers a masked value, which this rule reads as a present CEP.
 */
export function entregaSemCepLi(endereco: EnderecoEntregaLi | null | undefined): boolean {
  return motivoDaRecusa(endereco?.cep, TIPO_DE_VALOR.texto) === MOTIVO_RECUSA.ausente;
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

/**
 * What both verdicts read of the order and the pedido — everything but the
 * shipment and the CEP, which only the refusal asks.
 */
export interface PedidoPagoAguardandoEnderecoLi {
  /** The detail's `situacao.codigo`, verbatim. */
  readonly codigo: string;
  /** The routing went to an active pickup target (`RoteamentoFreteLi.dispensaEndereco`). */
  readonly dispensaEndereco: boolean;
  /** The pedido snapshot the decision reads, raw; `null` when there is none. */
  readonly armazenado: PedidoArmazenadoEnderecoLi | null;
}

/**
 * Paid, not a pickup, on a pedido that stores no endereço: the clauses the
 * refusal and the aviso's "still open" verdict SHARE, in one place so the two
 * never drift (module header).
 */
function pagoAguardandoEnderecoLi(e: PedidoPagoAguardandoEnderecoLi): boolean {
  return CODIGOS_LI_PAGO.has(e.codigo) && !e.dispensaEndereco && !armazenaEnderecoLi(e.armazenado);
}

export interface EntradaPedidoPagoSemEnderecoLi extends PedidoPagoAguardandoEnderecoLi {
  /** The order carries a shipment (`envios[0]`): the refusal's own clause. */
  readonly temEnvio: boolean;
  /** The detail's `endereco_entrega`. */
  readonly enderecoEntrega: EnderecoEntregaLi | null | undefined;
}

/** The import must refuse, and retry, this order (module header). */
export function pedidoPagoSemEnderecoLi(entrada: EntradaPedidoPagoSemEnderecoLi): boolean {
  return (
    entrada.temEnvio &&
    pagoAguardandoEnderecoLi(entrada) &&
    entregaSemCepLi(entrada.enderecoEntrega)
  );
}

export interface EntradaPedidoPagoSegueSemEnderecoLi extends PedidoPagoAguardandoEnderecoLi {
  /**
   * The endereço ref the WINNING write fills (the fill-once
   * `enderecoFiscalOuterRef` it carries), or `null`: it writes none.
   */
  readonly enderecoGravado: string | null;
}

/**
 * After the winning write, the pedido is STILL paid, with no endereço and no
 * pickup route: an import leaves an open `lojaIntegradaPedidoPagoSemEndereco`
 * row as it stands (module header, "When an import closes the aviso").
 * `armazenado` is the snapshot the WINNING attempt decided from, never `S`.
 * The CEP is not asked — an invalid one is how such an import gets here at
 * all — and neither is the shipment: it is not on the owner's list.
 */
export function pedidoPagoSegueSemEnderecoLi(
  entrada: EntradaPedidoPagoSegueSemEnderecoLi,
): boolean {
  return pagoAguardandoEnderecoLi(entrada) && vazioArmazenadoLi(entrada.enderecoGravado);
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
