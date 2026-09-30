/**
 * ARRANGE the shipment of ONE package (#1523, step 15): the fresh
 * `get_shipping_parameter` read → {@link escolherModoDeEnvio} → `ship_order`.
 *
 * The runner (`executarEtiqueta.ts`) calls it once per package it decided to
 * arrange; step 15b's Turbo auto-arrange will call it from the step-7 push arm.
 * So it is Next-free and Firestore-free — the client and the clock come in as
 * parameters, and every outcome is a VALUE ({@link ResultadoProgramacao}).
 *
 * ## ⚠️ `ship_order` is irreversible and NOT idempotent
 *
 * It goes out at most once per invocation, plus exactly ONE documented re-send
 * (R-l): Shopee refused the `package_number` it was given
 * (`ship_order_not_need_pacakge_number`), which means nothing was arranged, so
 * the same body WITHOUT the number is sent once. Nothing else re-sends.
 *
 * A network drop, an HTTP error without an envelope, Shopee's locks and its own
 * transient codes after the ship are an UNKNOWN outcome: the classifier answers
 * `verificar` and so does this module. The next call re-reads
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
 */
import type {
  ShipOrderParams,
  ShopeeClient,
  ShopeeShippingParameter,
} from '@delfrance/integrations-shopee';

import { TENTAR_EM_SHOPEE_MS } from './constantesEtiqueta';
import {
  MOTIVO_ETIQUETA_SHOPEE,
  classificarErroDeEtiqueta,
  type MotivoEtiquetaShopee,
  type VereditoDeErro,
} from './errosEtiqueta';
import type { FaseEtiqueta } from './faseEtiqueta';
import {
  escolherModoDeEnvio,
  type CorpoDeEnvio,
  type EnderecoDeColeta,
  type EscolhaDeEnvio,
} from './modoDeEnvio';

/** What arranging one package came to (reconcile §2.3). */
export type ResultadoProgramacao =
  | { tipo: 'programado' }
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
  | { tipo: 'recusa'; motivo: MotivoEtiquetaShopee; tentarApos?: number };

/** The package to arrange, and whether its number rides the ship (R-l). */
export interface AlvoDaProgramacao {
  readonly orderSn: string;
  readonly packageNumber: string;
  readonly comPacote: boolean;
}

function recusa(motivo: MotivoEtiquetaShopee, tentarApos?: number): ResultadoProgramacao {
  return tentarApos === undefined
    ? { tipo: 'recusa', motivo }
    : { tipo: 'recusa', motivo, tentarApos };
}

/**
 * A classifier verdict → this module's answer, for every verdict that needs no
 * second Shopee call. The two ship-only verdicts that DO (`reenviar-sem-pacote`,
 * `reescolher-envio`) are handled by the caller before this.
 *
 * `pacotes-mudaram` is a refusal HERE ("clique de novo" — the next call
 * re-derives the package list), never an in-call re-ship. The document-step
 * verdicts cannot come out of these two operations; if one ever does, it is an
 * unknown refusal rather than a guess.
 */
function resultadoDoVeredito(v: VereditoDeErro): ResultadoProgramacao {
  switch (v.tipo) {
    case 'ja-programado':
    case 'nfe-pendente':
    case 'verificar':
      return { tipo: v.tipo };
    case 'aguardar':
      return { tipo: 'aguardar', fase: v.fase, tentarEmMs: v.tentarEmMs };
    case 'recusa':
      return recusa(v.motivo, v.tentarApos);
    case 'pacotes-mudaram':
      return recusa(MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram);
    case 'tipo-invalido':
      return recusa(MOTIVO_ETIQUETA_SHOPEE.tipoInvalido);
    case 'reenviar-sem-pacote':
    case 'reescolher-envio':
    case 'fase-desatualizada':
    case 'baixar-separado':
      return recusa(MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida);
  }
}

type Envio =
  | ResultadoProgramacao
  | { readonly tipo: 'reenviar-sem-pacote' }
  | { readonly tipo: 'reescolher-envio' };

/** ONE `ship_order`, and its failure classified. Never retried here. */
async function enviarUmaVez(
  client: ShopeeClient,
  params: ShipOrderParams,
  nowMs: number,
): Promise<Envio> {
  try {
    await client.shipOrder(params);
    return { tipo: 'programado' };
  } catch (err: unknown) {
    const v = classificarErroDeEtiqueta('programar', err, nowMs);
    if (v === null) throw err;
    if (v.tipo === 'reenviar-sem-pacote' || v.tipo === 'reescolher-envio') return v;
    return resultadoDoVeredito(v);
  }
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
  return { tipo: 'aguardar', fase: 'programando', tentarEmMs: TENTAR_EM_SHOPEE_MS };
}

/**
 * Arrange ONE package (see the module docblock).
 *
 * @param client the conta's shop client.
 * @param alvo the order, the package, and whether the ship names the package.
 * @param escolha the operator's answer — honoured only for THIS package.
 * @param nowMs the caller's clock, for the daily quota's reset only.
 */
export async function programarPacoteShopee(
  client: ShopeeClient,
  alvo: AlvoDaProgramacao,
  escolha: EscolhaDeEnvio | null,
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
    return resultadoDoVeredito(v);
  }

  // ---- 2. the mode — a choice made for another package is no choice here ----
  const escolhaDoPacote =
    escolha !== null && escolha.pacote === alvo.packageNumber ? escolha : null;
  const modo = escolherModoDeEnvio(parametro, escolhaDoPacote);
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
  const primeiro: ShipOrderParams = alvo.comPacote
    ? { ...semPacote, packageNumber: alvo.packageNumber }
    : semPacote;

  let envio = await enviarUmaVez(client, primeiro, nowMs);
  if (envio.tipo === 'reenviar-sem-pacote') {
    // R-l: ONE re-send without the number — and only when the first carried
    // it. Refused again (or refused without one to drop) ⇒ the package list
    // is not what this call read: the operator clicks again, and the next
    // call re-derives it.
    envio = alvo.comPacote
      ? await enviarUmaVez(client, semPacote, nowMs)
      : recusa(MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram);
    if (envio.tipo === 'reenviar-sem-pacote') envio = recusa(MOTIVO_ETIQUETA_SHOPEE.pacotesMudaram);
  }
  if (envio.tipo === 'reescolher-envio') return perguntarDeNovo(parametro);
  return envio;
}
