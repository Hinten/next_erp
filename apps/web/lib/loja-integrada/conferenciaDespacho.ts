import type { LojaIntegradaClient } from './client';
import {
  conferenciaLiReaproveitavel,
  conferirPagamentoLi,
  decidirConferenciaPagamentoLi,
  ehPedidoImportadoDaLojaIntegrada,
  mensagemBloqueioConferenciaLi,
  mensagemConfirmacaoConferenciaLi,
  type ConferenciaLiCarregada,
  type GateConferenciaLi,
  type IdentidadePedidoLi,
} from './conferenciaPagamento';

/**
 * The HARD gates of the Loja Integrada paid re-check (master plan step 15):
 * the two points that spend something that does not come back.
 *
 * - **the checkout save** — the transaction writes `checkFinalizado`, which
 *   removes stock, and the NF-e follows in the post-save;
 * - **the Melhor Envio buy** — the Comprar click, right before the label is paid.
 *
 * Both run the SAME steps, which this module is the one copy of; every piece
 * it composes — the identity, the call, the hard decision table and the copy —
 * lives in `conferenciaPagamento.ts`, beside the soft gates that share them:
 *
 *  1. not an imported Loja Integrada order (the identity hash) ⇒ proceed, with
 *     NO call: a Mercado Livre or Shopee order, a duplicate or a manual pedido
 *     never wakes the scale-to-zero backend;
 *  2. a `pago` carried along this chain, received under 120 s ago by the
 *     client's own clock ⇒ proceed, with no call;
 *  3. otherwise ONE call, decided by `decidirConferenciaPagamentoLi`:
 *     - `prosseguir` — carrying the answer when it is a `pago` the next gate of
 *       the chain may reuse, and nothing otherwise;
 *     - `bloquear` — a verdict that does not authorise dispatch (or an answer
 *       about another order), with the gate's own "what did not happen";
 *     - `confirmar` — it could not be verified (the read switch is off, the
 *       backend is older than the route, Loja Integrada is down…): the caller
 *       asks the cause-specific "continuar?" and proceeds only on a yes. Never a
 *       silent block, never a silent pass.
 *
 * ⚠️ A confirm carries NO verdict: after "não verificável" there is nothing to
 * reuse, and the chain's next gate asks again.
 *
 * ⚠️ This is a check-then-act across a network call, and it cannot be
 * re-derived inside the checkout transaction (a transaction must not hold a
 * network read). The residual — a reversal in the seconds between this answer
 * and the commit — is named on `salvarCheckoutTransacao`; the screen runs this
 * after its last confirm dialog to keep that window as short as it can be.
 * The buy has the same residual, from the click (or the carried answer) to
 * Melhor Envio's checkout.
 */

/** What a hard gate decided — the caller shows it, asks it, or goes on. */
export type DecisaoAntesDeDespacharLi =
  | {
      readonly acao: 'prosseguir';
      /** A `pago` the chain's next gate may reuse; `null` when there is none. */
      readonly conferenciaLi: ConferenciaLiCarregada | null;
    }
  /** Refused: `mensagem` says why, then what did not happen at this gate. */
  | { readonly acao: 'bloquear'; readonly mensagem: string }
  /** Not verifiable: `mensagem` is the "Deseja continuar mesmo assim?" question. */
  | { readonly acao: 'confirmar'; readonly mensagem: string };

/**
 * Run a hard gate for one pedido. `gate` picks the block's last sentence: the
 * checkout (`checkout`), the buy from `/pedidos` (`comprar`) or the buy inside
 * the checkout chain, after the checkout and the NF-e were saved (`cadeia`).
 *
 * Anything that is not one of the client's own errors is rethrown (rule 6) —
 * including the abort of `sinal`, which comes back as `sinal.reason` itself.
 */
export async function conferirAntesDeDespacharLi(args: {
  readonly client: LojaIntegradaClient | null;
  readonly pedidoId: string;
  readonly pedido: IdentidadePedidoLi;
  readonly gate: GateConferenciaLi;
  /** A verdict carried from earlier in the same chain (the checkout's gate). */
  readonly conferenciaLi?: ConferenciaLiCarregada | null;
  /** The monotonic clock the verdict is stamped and judged by. */
  readonly agora?: () => number;
  /**
   * Aborts the call when the caller gives up (the buy modal closed mid-check).
   * The caller must still drop a decision that arrives after it gave up: a
   * call already answered is not undone by the abort.
   */
  readonly sinal?: AbortSignal;
}): Promise<DecisaoAntesDeDespacharLi> {
  const agora = args.agora ?? (() => performance.now());
  if (!(await ehPedidoImportadoDaLojaIntegrada(args.pedidoId, args.pedido))) {
    return { acao: 'prosseguir', conferenciaLi: null };
  }
  const carregada = args.conferenciaLi ?? null;
  if (conferenciaLiReaproveitavel(carregada, args.pedidoId, agora())) {
    return { acao: 'prosseguir', conferenciaLi: carregada };
  }

  const desfecho = await conferirPagamentoLi(args.client, args.pedidoId, {
    agora,
    ...(args.sinal === undefined ? {} : { sinal: args.sinal }),
  });
  const decisao = decidirConferenciaPagamentoLi(desfecho);
  switch (decisao.acao) {
    case 'prosseguir':
      // Carried exactly when the chain's next gate would reuse it: a `pago`
      // about this pedido, just received. An `aplicavel: false` proceeds here
      // but spares nothing later.
      return {
        acao: 'prosseguir',
        conferenciaLi:
          desfecho.tipo === 'resposta' &&
          conferenciaLiReaproveitavel(desfecho, args.pedidoId, desfecho.recebidoEm)
            ? desfecho
            : null,
      };
    case 'bloquear':
      return {
        acao: 'bloquear',
        mensagem: mensagemBloqueioConferenciaLi(decisao.linha, args.gate),
      };
    case 'confirmar':
      return { acao: 'confirmar', mensagem: mensagemConfirmacaoConferenciaLi(decisao) };
  }
}
