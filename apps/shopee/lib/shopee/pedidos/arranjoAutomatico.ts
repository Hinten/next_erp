/**
 * Step 15b's AUTOMATIC arrange (#1744): one Entrega Turbo package the step-7
 * push arm has just reconciled → `ship_order` with no operator, or a named
 * reason why not.
 *
 * Announcement 1573 makes the seller's system call `ship_order` ON ITS OWN for
 * the channels in `CANAIS_ARRANJO_AUTOMATICO`: Shopee cancels an order there
 * that saw no dispatch attempt. This module is that call, built from the label
 * route's own parts — the eligibility ladder of `etiqueta/faseEtiqueta.ts` and
 * the arrange of `etiqueta/programarPacote.ts` under the `ENVIO_AUTOMATICO`
 * sentinel — and never a second copy of either (reconcile R-d).
 *
 * ## ONE site (R-a)
 *
 * `rastrearPedidoShopee` reaches it only through `deps.arranjar`, which only the
 * step-7 arm's lazy default supplies. `rastrear:pedido --live` passes no deps,
 * so a rehearsal never ships and its import graph never loads this module.
 *
 * ## The ladder — cheapest first, at most 4 Shopee calls
 *
 * 1. Project the FRESH `get_package_detail` row the handler reconciled
 *    (`linha`) — never the stored observation, which is as stale as push
 *    ordering.
 * 2. Off 1573's channels ⇒ `fora-do-canal`, and NOTHING else happens: no call,
 *    no aviso. An Xpress package costs this hook nothing.
 * 3. Any phase but `programar` ⇒ its desfecho, with ZERO calls (an
 *    invoice-pending package included: FAQ 727 says ship only once the invoice
 *    cleared, and the refusal is certain). ⚠️ BEFORE the valve: these answers
 *    need no call, so the result reports the package's truth even with the
 *    valve off, and `desligado` means exactly "a candidate we did not arrange".
 * 4. The valve ({@link arranjoAutomaticoDesligado}).
 * 5. ONE `get_order_detail` with `SHOPEE_ETIQUETA_DETALHE_CAMPOS`, its row
 *    matched by `order_sn` — never by position (R-f). The stored pedido has no
 *    `fulfillment_flag` and a stale status; an `IN_CANCEL` order would ship.
 * 6. `decidirArranjoAutomatico` — FBS, CANCELLED, IN_CANCEL (refused BEFORE the
 *    parameter read) and `comPacote` are step 15's own rules.
 * 7. `programarPacoteShopee(…, ENVIO_AUTOMATICO, …)`: the fresh parameter read,
 *    the ship, and its ONE documented re-send. `reescolher-envio` under the
 *    sentinel is a wait, never a second ship in-call (R-g).
 *
 * Then the aviso producer, on every desfecho but `fora-do-canal`.
 *
 * ## ⚠️ No Shopee ANSWER escapes as an error (R-b)
 *
 * Step 15 already turned every Shopee transient into a VALUE, and a throw would
 * re-run the whole delivery (pull + merge + resolvers) on top of whatever next
 * names the package — two retriers during a rate-limit burst. So every Shopee
 * answer — API, rate limit, transport, credential, schema — is a desfecho, and
 * the delivery still resolves `frete` whatever it says. The catch is narrow
 * (rule 6): the five credential classes ⇒ `credencial` (the conta aviso is
 * their ONE producer; the handler's own `get_package_detail` throws them first,
 * so here they are a seconds-wide race), `ShopeeSchemaError` ⇒
 * `resposta-ilegivel` (our drift — it must never park the delivery). What is
 * RETHROWN to the arm's `throw` is not an answer: our own config error
 * (`ShopeeConfigError` — a `ShopeeError` subclass, so "no Shopee class" would
 * be false), a gRPC failure, a coding bug. `arranjoAutomatico.test.ts` pins
 * that table against `disposicaoDaFalhaDeRastreio`, class by class and call
 * site by call site.
 *
 * ⚠️ The aviso call sits OUTSIDE that catch. Its Firestore failure propagates:
 * the redelivery re-runs the idempotent frete merge, this hook re-reads
 * `is_shipment_arranged`, and that is what re-raises the print alert after an
 * irreversible ship whose aviso write was lost. A `ZodError` from the producer
 * parks the delivery — a mapper bug, loud.
 *
 * ## Rule 7: it writes NOTHING
 *
 * No pedido field, no frete, no stamp — the only writes are the avisos, inside
 * the producer. Between the arrangers (this hook on a push, on a redelivery or
 * on a synthetic package notification; the label button; `baixar:etiqueta
 * --live`; Shopee's Auto Call Driver; a human in Seller Centre) the ONLY guard
 * is Shopee's own state: the fresh `is_shipment_arranged` read, and a duplicate
 * ship absorbed as `package_already_shipped` ⇒ `ja-programado` — step 15's
 * acceptance. Two automatic arrangers pick the same body from the same read; a
 * disagreement with a human's mode is settled by whoever ships first. ⚠️ So
 * there is no multi-document atomic write here, and the module must not even
 * NAME that API, comments included: the inventory guard greps raw text.
 *
 * ## It logs NOTHING
 *
 * The caller's one log line carries the result. ⚠️ The seller's address and
 * slot (a `pergunta` carries their `rotulo`s) never leave this module:
 * `precisa-escolha` is all a caller learns.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { EstadoFrete } from '@delfrance/schemas';
import {
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  type ShopeeClient,
  type ShopeeOrderDetail,
  type ShopeePackageDetailRow,
} from '@delfrance/integrations-shopee';

import { avisarArranjoAutomatico } from '../avisos/despachoAutomatico';
import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { ShopeeContaNotConfiguredError } from '../core/shopee';
import { ShopeeContaSemShopIdError, ShopeeSemCredencialError } from '../core/tokenStore';
import { SHOPEE_ETIQUETA_DETALHE_CAMPOS } from '../etiqueta/constantesEtiqueta';
import {
  classificarErroDeEtiqueta,
  type OperacaoEtiqueta,
  type VereditoDeErro,
} from '../etiqueta/errosEtiqueta';
import {
  decidirArranjoAutomatico,
  elegibilidadeDoArranjoAutomatico,
  fasePacote,
  observacaoDaOrdemShopee,
  observacaoDoPacoteShopee,
  type FasePacote,
  type ObservacaoPacoteEtiqueta,
} from '../etiqueta/faseEtiqueta';
import { ENVIO_AUTOMATICO } from '../etiqueta/modoDeEnvio';
import { MOTIVO_ETIQUETA_SHOPEE, type MotivoEtiquetaShopee } from '../etiqueta/motivosEtiqueta';
import { programarPacoteShopee, type ResultadoProgramacao } from '../etiqueta/programarPacote';

/* -------------------------------------------------------------------------- */
/*                                  the valve                                  */
/* -------------------------------------------------------------------------- */

/**
 * The arrange's kill switch. `'1'` and NOTHING else turns it off — `'true'`,
 * `' 1'`, `'0'`, a blank and an unset value all leave it ON — the
 * `SHOPEE_LOST_PUSH_CONFIRM_DISABLED` polarity, so a missing value can never
 * leave a Turbo order un-arranged until Shopee cancels it. Read only by the
 * nested functions codebase: its home is `functions/.env.deploy`, never
 * `apphosting.yaml`.
 *
 * With it on, a CANDIDATE answers `desligado` with zero Shopee calls (and the
 * aviso producer says the arrange is off); every other package still reports
 * its own phase.
 *
 * ⚠️ Residual (R-b): nothing in this module retries. A transient answer
 * (`aguardando`, `verificar`) is retried only by the next delivery that names
 * the package — a later push, or a synthetic package notification from a
 * producer that lists packages. With neither, nobody retries it.
 */
export const SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV = 'SHOPEE_ARRANJO_AUTOMATICO_DISABLED';

/**
 * Whether the automatic arrange is switched off — `=== '1'` and nothing else.
 *
 * ⚠️ Read PER CALL, never at module load: the default is evaluated on every
 * call, so an env change reaches the next delivery without a cold start, and a
 * test can stub it after the import.
 */
export function arranjoAutomaticoDesligado(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[SHOPEE_ARRANJO_AUTOMATICO_DISABLED_ENV] === '1';
}

/* -------------------------------------------------------------------------- */
/*                                  contract                                   */
/* -------------------------------------------------------------------------- */

export interface EntradaArranjoAutomatico {
  readonly integracaoId: string;
  readonly pedidoId: string;
  readonly orderSn: string;
  readonly packageNumber: string;
  /** The FRESH get_package_detail row the handler reconciled — never `observado`. */
  readonly linha: ShopeePackageDetailRow;
  /** The task's one clock read, ms. */
  readonly nowMs: number;
  /**
   * The frete transaction's `estadoConfirmado` for this delivery — the block
   * estado the package diary corroborates once the merge is over, or `null`.
   *
   * ⚠️ The hook itself NEVER reads it: the arrange runs on the row whatever this
   * says (mutant 35 — Shopee absorbs a duplicate ship, a lost arrange is an
   * order Shopee cancels). Only the aviso producer does, to drop an OPEN that a
   * newer delivery already contradicted: on `ignorado-obsoleto` the row is OLDER
   * than the stored diary (a lagging replica, register 208), and an open keyed
   * on it would resurrect the alert that delivery resolved (review 3a, Q2-F1).
   */
  readonly estadoFreteConfirmado: EstadoFrete | null;
}

/**
 * What one run of the hook came to. The first six cost ZERO Shopee calls; the
 * rest cost 1–4.
 *
 * - `fora-do-canal` — not one of 1573's channels (a `null` channel included).
 * - `nao-elegivel` — a phase or an order rule that rules the arrange out
 *   (not ready, past the window, cancelled, FBS, an unknown token).
 * - `retido` — Shopee holds the package (a usable `pending_terms`).
 * - `nfe-pendente` — the invoice holds it (the row's flag, or Shopee's refusal).
 * - `ja-programado` — already arranged: the row, `PICKUP_RETRY`,
 *   `REQUEST_CREATED`, or `package_already_shipped`.
 * - `desligado` — a CANDIDATE left alone because of the valve.
 * - `programado` — OUR `ship_order` succeeded.
 * - `verificar` — the ship's outcome is UNKNOWN; the next run re-reads
 *   `is_shipment_arranged`.
 * - `aguardando` — transient (a burst, a lease, a Shopee hiccup, a stale
 *   package list, a refused slot).
 * - `precisa-escolha` — the automatic rules cannot pick the address or slot.
 * - `recusado` — a deterministic refusal a human can act on (`motivo`).
 * - `credencial` — one of the five credential classes.
 * - `resposta-ilegivel` — a `ShopeeSchemaError`.
 */
export type DesfechoArranjoAutomatico =
  | 'fora-do-canal'
  | 'nao-elegivel'
  | 'retido'
  | 'nfe-pendente'
  | 'ja-programado'
  | 'desligado'
  | 'programado'
  | 'verificar'
  | 'aguardando'
  | 'precisa-escolha'
  | 'recusado'
  | 'credencial'
  | 'resposta-ilegivel';

export interface ResultadoArranjoAutomatico {
  readonly desfecho: DesfechoArranjoAutomatico;
  /** `linha.logistics_channel_id`. */
  readonly canalId: number | null;
  /** `fasePacote(observacaoDoPacoteShopee(linha))` — the PRE-arrange phase, always computed. */
  readonly fase: FasePacote;
  /** Behind `recusado` / `nao-elegivel` / `aguardando` / `retido`, when one exists. */
  readonly motivo: MotivoEtiquetaShopee | null;
  /** `recusa-desconhecida` only: Shopee's code as a safe token, when the classifier vouched for one. */
  readonly shopeeCode: string | null;
  /** `recusa-desconhecida` only: the operation Shopee refused. */
  readonly operacao: OperacaoEtiqueta | null;
  /** `programado` by a ship WITHOUT `package_number` — Shopee arranged the whole ORDER. */
  readonly semPacote: boolean;
}

export type ArranjadorDePacote = (
  db: Firestore,
  client: ShopeeClient,
  e: EntradaArranjoAutomatico,
) => Promise<ResultadoArranjoAutomatico>;

export type AvisadorDeArranjo = (
  db: Firestore,
  e: EntradaArranjoAutomatico,
  r: ResultadoArranjoAutomatico,
) => Promise<void>;

export interface DepsArranjoAutomatico {
  /** The valve's environment. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The aviso producer. Default `avisarArranjoAutomatico` (`avisos/despachoAutomatico.ts`). */
  readonly avisar?: AvisadorDeArranjo;
}

/* -------------------------------------------------------------------------- */
/*                            motivo → desfecho                                */
/* -------------------------------------------------------------------------- */

/**
 * Every label motivo → what it means for the AUTOMATIC arrange — the ONE
 * authority (the aviso producer keys on the desfecho, never on a second motivo
 * list).
 *
 * - `nao-elegivel`: the order or the package rules the arrange OUT — FBS,
 *   cancelled (`order_finalized` included), an unknown status, past the window,
 *   cancelled shipping.
 * - `retido` / `nfe-pendente`: Shopee holds it, for its own reason / for the
 *   invoice.
 * - `aguardando`: a STALE view that the next run re-derives — no package yet, a
 *   package the order no longer lists, a list that changed, not ready yet.
 * - `recusado`: everything else — a refusal a human acts on. `limite-diario` is
 *   one (until the quota resets nothing arranges, and Shopee's clock keeps
 *   running), and so are the route-only and document-only motivos, which cannot
 *   arise here.
 *
 * ⚠️ `Record<MotivoEtiquetaShopee, …>`, so a new motivo is a COMPILE error here
 * until it decides.
 */
export const DESFECHO_DO_MOTIVO: Readonly<Record<MotivoEtiquetaShopee, DesfechoArranjoAutomatico>> =
  {
    // ---- the pedido and the conta (route-only rungs) ----
    'nao-shopee': 'recusado',
    'frete-de-outra-integracao': 'recusado',
    'conta-nao-configurada': 'recusado',
    'conta-inativa': 'recusado',
    // ---- the order Shopee holds ----
    'pedido-fbs': 'nao-elegivel',
    'pedido-cancelado': 'nao-elegivel',
    'pedido-em-cancelamento': 'recusado',
    'sem-pacotes': 'aguardando',
    'pacote-inexistente': 'aguardando',
    // ---- the package phase ----
    'status-desconhecido': 'nao-elegivel',
    'nfe-pendente': 'nfe-pendente',
    'pacote-nao-pronto': 'aguardando',
    'retido-pela-shopee': 'retido',
    'janela-fechada': 'nao-elegivel',
    'pacote-inelegivel': 'nao-elegivel',
    // ---- the shipping mode ----
    'sem-endereco-de-coleta': 'recusado',
    'sem-horario-ou-agencia': 'recusado',
    'agencia-precisa-escolha': 'recusado',
    'modo-nao-suportado': 'recusado',
    'sem-etiqueta-shopee': 'recusado',
    // ---- Shopee's refusal of the ship or of the document ----
    'cadastro-do-vendedor': 'recusado',
    'pedido-de-reserva': 'recusado',
    'somente-seller-centre': 'recusado',
    'etiqueta-indisponivel': 'recusado',
    'documento-falhou': 'recusado',
    'tipo-invalido': 'recusado',
    'pacotes-mudaram': 'aguardando',
    // ---- the limits and the infrastructure ----
    'limite-diario': 'recusado',
    'ip-nao-declarado': 'recusado',
    'recusa-desconhecida': 'recusado',
  };

/* -------------------------------------------------------------------------- */
/*                                the results                                  */
/* -------------------------------------------------------------------------- */

/** What every result of one run shares: the row's channel and its pre-arrange phase. */
interface Base {
  readonly canalId: number | null;
  readonly fase: FasePacote;
}

function resultado(
  base: Base,
  desfecho: DesfechoArranjoAutomatico,
  motivo: MotivoEtiquetaShopee | null = null,
): ResultadoArranjoAutomatico {
  return { ...base, desfecho, motivo, shopeeCode: null, operacao: null, semPacote: false };
}

/**
 * A motivo → its desfecho through {@link DESFECHO_DO_MOTIVO}, carrying the
 * motivo. `shopeeCode` and `operacao` survive on `recusa-desconhecida` ONLY —
 * the one datum that tells us which code to teach the classifier.
 */
function daRecusa(
  base: Base,
  motivo: MotivoEtiquetaShopee,
  desconhecida: {
    readonly shopeeCode?: string | undefined;
    readonly operacao: OperacaoEtiqueta | null;
  },
): ResultadoArranjoAutomatico {
  const r = resultado(base, DESFECHO_DO_MOTIVO[motivo], motivo);
  return motivo === MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida
    ? { ...r, shopeeCode: desconhecida.shopeeCode ?? null, operacao: desconhecida.operacao }
    : r;
}

/** Step 3: a non-candidate phase → its desfecho, with zero calls. */
function desfechoDaFase(
  base: Base,
  fase: Exclude<FasePacote, 'programar'>,
): ResultadoArranjoAutomatico {
  switch (fase) {
    case 'nfe-pendente':
      return resultado(base, 'nfe-pendente');
    case 'retido':
      return resultado(base, 'retido', MOTIVO_ETIQUETA_SHOPEE.retidoPelaShopee);
    case 'arranjado':
      return resultado(base, 'ja-programado');
    case 'nao-pronto':
    case 'janela-fechada':
    case 'inelegivel':
    case 'desconhecido':
      return resultado(base, 'nao-elegivel');
    default: {
      const nunca: never = fase;
      return nunca;
    }
  }
}

/**
 * Step 5: the classifier's verdict on a failed ORDER read → a desfecho. Total.
 *
 * The ship-only and document-step verdicts cannot honestly come out of an
 * order read; if one ever does, it is an unknown refusal of `detalhe-pedido`
 * rather than a guess.
 */
function desfechoDoVeredito(base: Base, v: VereditoDeErro): ResultadoArranjoAutomatico {
  const operacao: OperacaoEtiqueta = 'detalhe-pedido';
  switch (v.tipo) {
    case 'aguardar':
    case 'verificar':
      return resultado(base, 'aguardando');
    case 'pacotes-mudaram':
      return daRecusa(base, MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram, { operacao });
    case 'ja-programado':
      return resultado(base, 'ja-programado');
    case 'nfe-pendente':
      return resultado(base, 'nfe-pendente');
    case 'recusa':
      return daRecusa(base, v.motivo, { shopeeCode: v.shopeeCode, operacao });
    case 'reenviar-sem-pacote':
    case 'reescolher-envio':
    case 'fase-desatualizada':
    case 'baixar-separado':
    case 'tipo-invalido':
      return daRecusa(base, MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida, { operacao });
    default: {
      const nunca: never = v;
      return nunca;
    }
  }
}

/**
 * Step 7: what arranging came to → a desfecho. Total.
 *
 * ⚠️ `pergunta` drops its addresses and slots here — `precisa-escolha` is all
 * that leaves the module.
 */
function desfechoDaProgramacao(base: Base, p: ResultadoProgramacao): ResultadoArranjoAutomatico {
  switch (p.tipo) {
    case 'programado':
      return { ...resultado(base, 'programado'), semPacote: p.semPacote };
    case 'ja-programado':
      return resultado(base, 'ja-programado');
    case 'nfe-pendente':
      return resultado(base, 'nfe-pendente');
    case 'verificar':
      return resultado(base, 'verificar');
    case 'pergunta':
      return resultado(base, 'precisa-escolha');
    case 'aguardar':
      return resultado(base, 'aguardando');
    case 'recusa':
      return daRecusa(base, p.motivo, { shopeeCode: p.shopeeCode, operacao: p.operacao ?? null });
    default: {
      const nunca: never = p;
      return nunca;
    }
  }
}

/**
 * The five classes a dead or missing CREDENTIAL raises — at the token read
 * before any of the three calls. `ShopeeRefreshEmAndamentoError` is not one:
 * the classifier already reads it as a wait.
 */
function ehFalhaDeCredencial(err: unknown): boolean {
  return (
    err instanceof ShopeeReauthRequiredError ||
    err instanceof ShopeeSemCredencialError ||
    err instanceof ShopeeCredencialInvalidaError ||
    err instanceof ShopeeContaNotConfiguredError ||
    err instanceof ShopeeContaSemShopIdError
  );
}

/** Steps 5–7, for a candidate the valve let through — ONE narrow catch around all three calls. */
async function arranjarCandidato(
  client: ShopeeClient,
  e: EntradaArranjoAutomatico,
  obs: ObservacaoPacoteEtiqueta,
  base: Base,
): Promise<ResultadoArranjoAutomatico> {
  try {
    // ---- 5. the order facts: ONE read, the row by `order_sn` ----
    let ordem: ShopeeOrderDetail;
    try {
      ordem = await client.getOrderDetail({
        orderSnList: [e.orderSn],
        responseOptionalFields: SHOPEE_ETIQUETA_DETALHE_CAMPOS,
      });
    } catch (err: unknown) {
      const v = classificarErroDeEtiqueta('detalhe-pedido', err, e.nowMs);
      if (v === null) throw err;
      return desfechoDoVeredito(base, v);
    }
    const linhaDaOrdem = ordem.order_list.find((r) => r.order_sn === e.orderSn) ?? null;

    // ---- 6. step 15's order rules over this one package ----
    const decisao = decidirArranjoAutomatico(observacaoDaOrdemShopee(linhaDaOrdem), obs);
    if (decisao.tipo === 'recusa') return daRecusa(base, decisao.motivo, { operacao: null });
    if (decisao.tipo === 'nfe-pendente') return resultado(base, 'nfe-pendente');

    // ---- 7. the arrange, with no operator ----
    const programacao = await programarPacoteShopee(
      client,
      { orderSn: e.orderSn, packageNumber: e.packageNumber, comPacote: decisao.comPacote },
      ENVIO_AUTOMATICO,
      e.nowMs,
    );
    return desfechoDaProgramacao(base, programacao);
  } catch (err: unknown) {
    if (ehFalhaDeCredencial(err)) return resultado(base, 'credencial');
    if (err instanceof ShopeeSchemaError) return resultado(base, 'resposta-ilegivel');
    // ShopeeConfigError, a gRPC failure, a coding bug: the arm's `throw`.
    throw err;
  }
}

/**
 * Arrange ONE Turbo package automatically (see the module docblock).
 *
 * @param db the Firestore the aviso producer writes to — this module writes
 *   nothing itself.
 * @param client the conta's shop client (the handler's own).
 * @param e the package, its pedido, the FRESH row and the task's clock.
 * @param deps the valve's environment and the aviso producer, both injectable.
 * @returns the desfecho — no Shopee answer escapes as an error; our own config
 *   error, gRPC errors and bugs are rethrown.
 */
export async function arranjarPacoteAutomatico(
  db: Firestore,
  client: ShopeeClient,
  e: EntradaArranjoAutomatico,
  deps: DepsArranjoAutomatico = {},
): Promise<ResultadoArranjoAutomatico> {
  // ---- 1. the fresh row, projected by the label route's own reader ----
  const obs = observacaoDoPacoteShopee(e.linha);
  const base: Base = { canalId: e.linha.logistics_channel_id, fase: fasePacote(obs) };

  // ---- 2. channel first: off 1573's list, nothing at all happens ----
  const elegibilidade = elegibilidadeDoArranjoAutomatico(obs);
  if (elegibilidade.tipo === 'fora-do-canal') return resultado(base, 'fora-do-canal');

  // ---- 3. a non-candidate phase (zero calls) · 4. the valve · 5–7. the arrange ----
  const r =
    elegibilidade.tipo === 'fase'
      ? desfechoDaFase(base, elegibilidade.fase)
      : arranjoAutomaticoDesligado(deps.env)
        ? resultado(base, 'desligado')
        : await arranjarCandidato(client, e, obs, base);

  // ---- 8. the avisos — OUTSIDE the catch: their failure is the delivery's ----
  await (deps.avisar ?? avisarArranjoAutomatico)(db, e, r);
  return r;
}
