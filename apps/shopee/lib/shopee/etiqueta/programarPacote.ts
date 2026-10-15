/**
 * ARRANGE the shipment of ONE package (#1523, step 15): the fresh
 * `get_shipping_parameter` read → {@link escolherModoDeEnvio} → `ship_order`.
 *
 * The runner (`executarEtiqueta.ts`) calls it once per package it decided to
 * arrange, and step 15b's automatic arrange (`pedidos/arranjoAutomatico.ts`,
 * reached from the step-7 push arm) calls it with {@link ENVIO_AUTOMATICO}.
 * So it is Next-free and Firestore-free — the client and the clock come in as
 * parameters, and every outcome is a VALUE ({@link ResultadoProgramacao}).
 *
 * ## ⚠️ `ship_order` is irreversible and NOT idempotent
 *
 * It goes out at most once per invocation, plus exactly ONE documented re-send
 * when Shopee refused the `package_number` question the first ship answered —
 * a refusal proves nothing was arranged, so the corrected body goes out once:
 *
 * - R-l: `ship_order_not_need_pacakge_number` on a ship that CARRIED the
 *   number ⇒ the same body WITHOUT it.
 * - Its mirror (review 1, R4-3): `ship_order_need_pacakge_number` on a ship
 *   that did NOT carry it ⇒ the same body WITH this package's number. Without
 *   it, an order Shopee deems split while its `package_list` shows one package
 *   refused every click for ever.
 *
 * A second refusal of either kind ⇒ `pacotes-mudaram` (the operator clicks
 * again and the next call re-derives the list); there is never a third send.
 * ⚠️ Only those two CODES re-send. The other `pacotes-mudaram` refusals — a
 * package number that no longer exists, `error_param: … has been splitted` —
 * say the call's package list is stale, and a stale list is re-derived by the
 * next call, never patched in-call.
 *
 * ⚠️ **A ship WITHOUT the number arranges the whole ORDER.** Once one has
 * succeeded in a call, the caller says so ({@link AlvoDaProgramacao}'s
 * `ordemProgramadaSemPacote`), and a later `not_need` for a sibling package —
 * a stale split read — is answered `ja-programado` WITHOUT sending: a second
 * order-level ship in one call would rest on Shopee absorbing the duplicate
 * (review 1, R2-2).
 *
 * A network drop, an HTTP error without an envelope, Shopee's locks and its own
 * transient codes after the ship are an UNKNOWN outcome: the classifier answers
 * `verificar` and so does this module. So does an UNREADABLE 2xx (a
 * `ShopeeSchemaError` with a 2xx status — an empty or broken success body):
 * Shopee answered success-shaped, so the ship may well have happened, and a 502
 * would tell the operator it failed (review 1, R2-3). That rule lives HERE, on
 * the ship alone — the classifier stays op-agnostic and answers `null` for a
 * schema error on every operation. The next call re-reads
 * `is_shipment_arranged`, and a duplicate ship is absorbed there as
 * `package_already_shipped` ⇒ `ja-programado` (S30/S31).
 *
 * ## `package_number` on the ship only when the order is split
 *
 * `alvo.comPacote` is the caller's decision (`decidirProximaAcao`: more than
 * one package, or `SHOPEE_SHIP_ORDER_PACOTE === 'sempre'`). ⚠️ When it is false
 * the key is ABSENT from the ship — never `""` (S29). Every OTHER operation,
 * the parameter read included, always names the package.
 *
 * ## The operator's choice
 *
 * `escolha` is honoured only when its `pacote` IS this package: the chooser
 * does not read `escolha.pacote` (W2), so a choice made for a sibling package
 * must never arrange this one. Any other choice is `null`, and this package's
 * own question is asked.
 *
 * ## No operator: {@link ENVIO_AUTOMATICO} (step 15b, R-g)
 *
 * The sentinel swaps the operator chooser for {@link escolherModoAutomatico},
 * which decides from this read alone or asks. It names no package, so the
 * filter above never applies to it. ⚠️ When Shopee refuses the slot or the
 * address it chose (`reescolher-envio`), the answer is `aguardar` — never the
 * re-asked question (nobody is there to answer it) and never a second ship
 * in-call: the next run re-reads the parameter and takes Shopee's NEW
 * recommended slot. The operator path is untouched.
 *
 * ## An unknown refusal is observable
 *
 * `recusa-desconhecida` carries the operation and, when the classifier could
 * vouch for it, Shopee's code as a safe token (`shopeeCode`, review 1, R3-F1):
 * the one datum the rehearsal exists to capture — which code to teach the table.
 */
import {
  ShopeeApiError,
  ShopeeSchemaError,
  type ShipOrderParams,
  type ShopeeClient,
  type ShopeeShippingParameter,
} from '@delfrance/integrations-shopee';

import { codigoCanonicoShopee } from '../core/recusaShopee';
import { TENTAR_EM_SHOPEE_MS } from './constantesEtiqueta';
import {
  classificarErroDeEtiqueta,
  type OperacaoEtiqueta,
  type VereditoDeErro,
} from './errosEtiqueta';
import type { FaseEtiqueta } from './faseEtiqueta';
import {
  ENVIO_AUTOMATICO,
  escolherModoAutomatico,
  escolherModoDeEnvio,
  type CorpoDeEnvio,
  type EnderecoDeColeta,
  type EscolhaDeEnvio,
} from './modoDeEnvio';
import { MOTIVO_ETIQUETA_SHOPEE, type MotivoEtiquetaShopee } from './motivosEtiqueta';

/** What arranging one package came to (reconcile §2.3). */
export type ResultadoProgramacao =
  | {
      tipo: 'programado';
      /**
       * The ship that arranged it named NO package — Shopee arranged the whole
       * ORDER. The caller remembers it for the rest of the call (R2-2).
       */
      semPacote: boolean;
    }
  | { tipo: 'ja-programado' }
  | { tipo: 'nfe-pendente' }
  | { tipo: 'verificar' }
  | {
      tipo: 'pergunta';
      enderecos: readonly EnderecoDeColeta[];
      permiteDropoff: boolean;
      escolhaInvalida: boolean;
    }
  | { tipo: 'aguardar'; fase: FaseEtiqueta; tentarEmMs: number }
  | {
      tipo: 'recusa';
      motivo: MotivoEtiquetaShopee;
      tentarApos?: number;
      /** `recusa-desconhecida` only: Shopee's code as a SAFE token, when there is one. */
      shopeeCode?: string;
      /** `recusa-desconhecida` only: the operation Shopee refused. */
      operacao?: OperacaoEtiqueta;
    };

/** The package to arrange, and whether its number rides the ship (R-l). */
export interface AlvoDaProgramacao {
  readonly orderSn: string;
  readonly packageNumber: string;
  readonly comPacote: boolean;
  /**
   * A ship WITHOUT `package_number` already succeeded for this ORDER in this
   * call (the caller's memory, from a `programado` with `semPacote`): a later
   * `not_need` is answered `ja-programado` and never re-sent. Absent ⇒ `false`.
   */
  readonly ordemProgramadaSemPacote?: boolean;
}

/**
 * `ship_order_need_pacakge_number` (Shopee's spelling), canonical — the ONE
 * code the mirror re-send answers. The classifier reads it as `pacotes-mudaram`
 * like its siblings; this module tells it apart AFTER that verdict, so a
 * classifier that stops answering `pacotes-mudaram` for it also stops the
 * re-send (pinned by `programarPacote.test.ts`).
 */
const CODIGO_PRECISA_DO_PACOTE = 'ship_order_need_pacakge_number';

function recusa(motivo: MotivoEtiquetaShopee, tentarApos?: number): ResultadoProgramacao {
  return tentarApos === undefined
    ? { tipo: 'recusa', motivo }
    : { tipo: 'recusa', motivo, tentarApos };
}

/** A refusal nobody taught us — with the operation, and the code when the classifier vouched for one. */
function recusaDesconhecida(operacao: OperacaoEtiqueta, shopeeCode?: string): ResultadoProgramacao {
  const motivo = MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida;
  return shopeeCode === undefined
    ? { tipo: 'recusa', motivo, operacao }
    : { tipo: 'recusa', motivo, shopeeCode, operacao };
}

/**
 * A classifier verdict → this module's answer, for every verdict that needs no
 * second Shopee call. The ship-only verdicts that DO (`reenviar-sem-pacote`,
 * `reescolher-envio`, and the `need` mirror) are handled by the caller before
 * this.
 *
 * `pacotes-mudaram` is a refusal HERE ("clique de novo" — the next call
 * re-derives the package list), never an in-call re-ship. The document-step
 * verdicts cannot come out of these two operations; if one ever does, it is an
 * unknown refusal rather than a guess.
 */
function resultadoDoVeredito(v: VereditoDeErro, op: OperacaoEtiqueta): ResultadoProgramacao {
  switch (v.tipo) {
    case 'ja-programado':
    case 'nfe-pendente':
    case 'verificar':
      return { tipo: v.tipo };
    case 'aguardar':
      return { tipo: 'aguardar', fase: v.fase, tentarEmMs: v.tentarEmMs };
    case 'recusa':
      return v.motivo === MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida
        ? recusaDesconhecida(op, v.shopeeCode)
        : recusa(v.motivo, v.tentarApos);
    case 'pacotes-mudaram':
      return recusa(MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram);
    case 'tipo-invalido':
      return recusa(MOTIVO_ETIQUETA_SHOPEE.tipoInvalido);
    case 'reenviar-sem-pacote':
    case 'reescolher-envio':
    case 'fase-desatualizada':
    case 'baixar-separado':
      return recusaDesconhecida(op);
  }
}

type Envio =
  | ResultadoProgramacao
  | { readonly tipo: 'reenviar-sem-pacote' }
  | { readonly tipo: 'reenviar-com-pacote' }
  | { readonly tipo: 'reescolher-envio' };

/** ONE `ship_order`, and its failure classified. Never retried here. */
async function enviarUmaVez(
  client: ShopeeClient,
  params: ShipOrderParams,
  nowMs: number,
): Promise<Envio> {
  const semNumero = params.packageNumber === undefined;
  try {
    await client.shipOrder(params);
    return { tipo: 'programado', semPacote: semNumero };
  } catch (err: unknown) {
    const v = classificarErroDeEtiqueta('programar', err, nowMs);
    if (v === null) {
      // R2-3: a success-shaped answer we could not read — the ship may have
      // happened. Any other status (and anything else) stays rethrown.
      if (err instanceof ShopeeSchemaError && err.httpStatus >= 200 && err.httpStatus < 300) {
        return { tipo: 'verificar' };
      }
      throw err;
    }
    if (v.tipo === 'reenviar-sem-pacote' || v.tipo === 'reescolher-envio') return { tipo: v.tipo };
    if (
      v.tipo === 'pacotes-mudaram' &&
      semNumero &&
      err instanceof ShopeeApiError &&
      codigoCanonicoShopee(err.code) === CODIGO_PRECISA_DO_PACOTE
    ) {
      return { tipo: 'reenviar-com-pacote' };
    }
    return resultadoDoVeredito(v, 'programar');
  }
}

/**
 * Wait for the NEXT read: Shopee refused what this read offered, and
 * re-shipping it in-call is exactly what this module never does.
 */
function aguardarNovaLeitura(): ResultadoProgramacao {
  return { tipo: 'aguardar', fase: 'programando', tentarEmMs: TENTAR_EM_SHOPEE_MS };
}

/**
 * Shopee refused the chosen slot or address AFTER this read offered it: ask
 * again, marked stale. When this read leaves nothing to ask about — its one
 * option is the one just refused — the call waits instead: the next read may
 * offer a new slot, and re-shipping the refused one in-call is exactly what
 * this module never does.
 */
function perguntarDeNovo(parametro: ShopeeShippingParameter): ResultadoProgramacao {
  const agora = escolherModoDeEnvio(parametro, null);
  if (agora.tipo === 'pergunta') {
    return {
      tipo: 'pergunta',
      enderecos: agora.enderecos,
      permiteDropoff: agora.permiteDropoff,
      escolhaInvalida: true,
    };
  }
  if (agora.tipo === 'recusa') return recusa(agora.motivo);
  return aguardarNovaLeitura();
}

/**
 * Arrange ONE package (see the module docblock).
 *
 * @param client the conta's shop client.
 * @param alvo the order, the package, whether the ship names the package, and
 *   whether this call already arranged the order without one.
 * @param escolha the operator's answer — honoured only for THIS package — or
 *   {@link ENVIO_AUTOMATICO} when there is no operator at all.
 * @param nowMs the caller's clock, for the daily quota's reset only.
 */
export async function programarPacoteShopee(
  client: ShopeeClient,
  alvo: AlvoDaProgramacao,
  escolha: EscolhaDeEnvio | typeof ENVIO_AUTOMATICO | null,
  nowMs: number,
): Promise<ResultadoProgramacao> {
  // ---- 1. this call's FRESH parameter read (the package is always named) ----
  let parametro: ShopeeShippingParameter;
  try {
    parametro = await client.getShippingParameter({
      orderSn: alvo.orderSn,
      packageNumber: alvo.packageNumber,
    });
  } catch (err: unknown) {
    const v = classificarErroDeEtiqueta('parametro-envio', err, nowMs);
    if (v === null) throw err;
    return resultadoDoVeredito(v, 'parametro-envio');
  }

  // ---- 2. the mode — a choice made for another package is no choice here ----
  // The sentinel names no package: it skips that filter and decides alone.
  const automatico = escolha === ENVIO_AUTOMATICO;
  const escolhaDoPacote =
    escolha !== null && escolha !== ENVIO_AUTOMATICO && escolha.pacote === alvo.packageNumber
      ? escolha
      : null;
  const modo = automatico
    ? escolherModoAutomatico(parametro)
    : escolherModoDeEnvio(parametro, escolhaDoPacote);
  if (modo.tipo === 'recusa') return recusa(modo.motivo);
  if (modo.tipo === 'pergunta') {
    return {
      tipo: 'pergunta',
      enderecos: modo.enderecos,
      permiteDropoff: modo.permiteDropoff,
      escolhaInvalida: modo.escolhaInvalida,
    };
  }

  // ---- 3. the ship: `package_number` only on a split order (S29) ----
  const corpo: CorpoDeEnvio = modo.corpo;
  const semPacote: ShipOrderParams = { orderSn: alvo.orderSn, ...corpo };
  const comPacote: ShipOrderParams = { ...semPacote, packageNumber: alvo.packageNumber };

  let envio = await enviarUmaVez(client, alvo.comPacote ? comPacote : semPacote, nowMs);
  if (envio.tipo === 'reenviar-sem-pacote') {
    // R-l: ONE re-send without the number — only when the first carried it,
    // and never once this call already arranged the ORDER without one (R2-2).
    envio = !alvo.comPacote
      ? recusa(MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram)
      : alvo.ordemProgramadaSemPacote === true
        ? { tipo: 'ja-programado' }
        : await enviarUmaVez(client, semPacote, nowMs);
  } else if (envio.tipo === 'reenviar-com-pacote') {
    // R4-3, the mirror: ONE re-send WITH this package's number.
    envio = await enviarUmaVez(client, comPacote, nowMs);
  }
  // Refused again, in either direction ⇒ the package list is not what this
  // call read: the operator clicks again, and the next call re-derives it.
  if (envio.tipo === 'reenviar-sem-pacote' || envio.tipo === 'reenviar-com-pacote') {
    return recusa(MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram);
  }
  if (envio.tipo === 'reescolher-envio') {
    // ⚠️ No operator to re-ask: wait for the next read and Shopee's new
    // suggestion — never a second ship in this call.
    return automatico ? aguardarNovaLeitura() : perguntarDeNovo(parametro);
  }
  return envio;
}
