/**
 * The PURE shipping-mode chooser of the label flow (#1523, step 15): one
 * package's `get_shipping_parameter` answer, plus the operator's choice when
 * there is one → the `ship_order` body, the question to ask, or a refusal.
 *
 * No clock, no I/O, no Firestore, no `process.env`. `programarPacote.ts` reads
 * the parameter, calls {@link escolherModoDeEnvio} — or, with no operator,
 * {@link escolherModoAutomatico} — and sends the body.
 *
 * ## The mode is the KEY Shopee put in `info_needed`
 *
 * Never a channel id (announcement 1327, L5): `info_needed.pickup` /
 * `.dropoff` / `.non_integrated` PRESENT means the mode is offered, and
 * ⚠️ ABSENT (`null`) ≠ EMPTY (`[]`) — `[]` is "offered, nothing to fill"
 * (`dropoff: []` ⇒ `"dropoff": {}` is SENT). The package schema keeps the two
 * apart; this module never folds them. The page's own prose also spells a
 * `non-integrated` key with a hyphen: it rides `.passthrough()` and reads as NO
 * mode, so an answer with nothing we know refuses instead of guessing.
 *
 * ## Ask only when Shopee needs a choice — and offer only what can ship
 *
 * ⚠️ **Buildability FIRST** (review 2, F2). Each side is judged on its own
 * before anything is asked: a pickup whose items we cannot fill, or with no
 * eligible address, is NOT offered (`enderecos: []`), and the dropoff is offered
 * (`permiteDropoff: true`) ONLY when the dropoff side alone would yield a body —
 * a `agencia-precisa-escolha` or `modo-nao-suportado` dropoff is not an option.
 * Before this, the question offered a side the answer then refused with a 409,
 * and the next click asked the same question again.
 *
 * Then: both sides buildable ⇒ ask (`permiteDropoff: true`, R-z); exactly ONE ⇒
 * decide it (the pickup side still asks when it has more than one eligible
 * address, or more than one slot for the one address); NONE ⇒ refuse with the
 * motivo of the side Shopee offered — the DROPOFF's when it offered both, since
 * its refusals (`agencia-precisa-escolha`) are the ones an operator can act on
 * in the Seller Centre. So a question always carries at least one option the
 * server can ship, which is what keeps the web's "no address ⇒ dropoff" rule
 * true. The legacy precedence (pickup → dropoff → non_integrated) is what
 * "pickup alone" and "dropoff alone" still do.
 *
 * - **Pickup.** Eligible addresses are those whose `address_flag` holds
 *   `pickup_address` (`SHOPEE_ADDRESS_FLAG.coleta`) — ⚠️ `default_address` ALONE
 *   is NOT a pickup address (announcement 1327; the page's own sample carries an
 *   address with neither). `principal` = also `default_address`; `recomendado` =
 *   the slot's `flags` holds `recommended`, a suggestion and never a rule. A slot
 *   is offered only when `info_needed.pickup` asks for `pickup_time_id`; zero
 *   slots is LEGAL ("sellers can arrange shipment without selecting any time
 *   slot") and sends no `pickup_time_id`. A pickup that asks for anything else
 *   (`tracking_number`, an item we do not know) is a body we cannot build ⇒
 *   `modo-nao-suportado`.
 * - **Dropoff.** `[]` ⇒ `{}`. `['branch_id']` with exactly ONE branch ⇒ that
 *   branch; more than one ⇒ `agencia-precisa-escolha` (no branch picker, R-z —
 *   the operator arranges it in the Seller Centre and the next click prints);
 *   anything else (`sender_real_name`, `tracking_no`, `slug`) ⇒
 *   `modo-nao-suportado` (not BR, guide 292). ⚠️ The branch count is the RAW
 *   list, `null` sentinels included: an unreadable branch is still a branch
 *   Shopee offered, so "one of two readable" is never "the only one".
 * - **non_integrated only** ⇒ `sem-etiqueta-shopee`: the seller's own
 *   logistics, and Shopee prints no label for it.
 *
 * ## ⚠️ A choice is matched EXACTLY against THIS read
 *
 * The browser's `enderecoId` is `String(address_id)` of an EARLIER read, and it
 * is compared as a string — `String(address_id) === enderecoId` — never through
 * `Number(enderecoId)`, which would accept `'0123'`, `' 123'` and `'1.23e2'` as
 * address 123 (S43). `horarioId` is compared to `pickup_time_id` verbatim, and
 * `null` is valid only for an address with no slot on offer. Anything that no
 * longer matches is re-asked with `escolhaInvalida: true` (S42) — never shipped,
 * and never silently replaced by the only option left. "Matches" is against
 * what THIS read OFFERS: an answer naming a side this read cannot build is no
 * longer a match either, and is re-asked the same way.
 *
 * ⚠️ The chooser does not read `escolha.pacote`: the caller hands it the choice
 * for THIS package only.
 *
 * ## No operator: {@link escolherModoAutomatico} (step 15b, R-g)
 *
 * The automatic arrange (`pedidos/arranjoAutomatico.ts`, announcement 1573)
 * has nobody to ask. It decides from THIS read alone or answers `pergunta`
 * with `escolhaInvalida: false` — a human's job, which the hook reports as
 * `precisa-escolha`. It never GUESSES. Each side is still judged alone first,
 * through the same readers and the same `principal` / `recomendado` predicates
 * the question carries:
 *
 * - **Pickup.** One eligible address ⇒ it; several ⇒ the UNIQUE `principal`
 *   (the seller's own designation, not a guess); none or two ⇒ undecided.
 *   Slots: zero ⇒ NO `pickupTimeId` key (legal, as above); one ⇒ it; several
 *   ⇒ the UNIQUE `recomendado`; none or two ⇒ undecided. ⚠️ There is no
 *   "first slot" fallback: Shopee calls `recommended` a suggestion, the
 *   earliest date is a guess, and an EMPTY slot list is the likely Turbo shape
 *   anyway (announcement 1519).
 * - **Dropoff** and **non_integrated**: the operator chooser's own rules and
 *   refusals (`agencia-precisa-escolha`, `sem-etiqueta-shopee`, …).
 * - **Both buildable and the pickup decided ⇒ the PICKUP** — the legacy
 *   precedence, and a Turbo rider collects. ⚠️ A pickup OFFERED but undecided
 *   is a `pergunta` even when a dropoff is buildable: never a silent switch to
 *   the mode that puts a physical trip on the seller. Pickup absent or
 *   unbuildable ⇒ the dropoff; nothing buildable ⇒ the operator chooser's own
 *   refusal.
 *
 * So the automatic answer REFINES the operator's unanswered one
 * (`escolherModoDeEnvio(p, null)`): where that decides or refuses, this
 * answers the same; where that asks, this either decides or asks the very same
 * question. ⚠️ The refinement is ONE-WAY: an operator who has not answered yet
 * is still ASKED where the automatic mode takes the recommended slot.
 *
 * ## ⚠️ `rotulo` is the SELLER's own address text
 *
 * The label an operator picks from is built from the address row's own fields
 * (address, town, district, city, state, zipcode) and the slot's date/text. No
 * buyer datum is on this page, and no passthrough key is ever read, so none can
 * leak into the question. The text still never reaches a log line.
 */
import {
  SHOPEE_ADDRESS_FLAG,
  SHOPEE_TIME_SLOT_FLAG,
  type ShopeePickupAddress,
  type ShopeePickupTimeSlot,
  type ShopeeShippingParameter,
} from '@delfrance/integrations-shopee';

import { FUSO_PRAZO_DESPACHO_SHOPEE } from '../pedidos/orderFreteMapping';
import { segundosShopeeUtilizaveis, textoShopeeUtilizavel } from '../pedidos/orderMapping';
import { MOTIVO_ETIQUETA_SHOPEE, type MotivoEtiquetaShopee } from './motivosEtiqueta';

/* -------------------------------- the types -------------------------------- */

/** The operator's answer to an `escolher-envio` question, for ONE package. */
export type EscolhaDeEnvio =
  | {
      readonly pacote: string;
      readonly modo: 'pickup';
      readonly enderecoId: string;
      readonly horarioId: string | null;
    }
  | { readonly pacote: string; readonly modo: 'dropoff' };

/**
 * The SENTINEL `escolha` of the automatic arrange (step 15b, R-g): "no operator
 * — decide with {@link escolherModoAutomatico}". A value, not a flag, so the
 * runner's call and its type stay untouched; `null` keeps meaning "the operator
 * has not answered yet".
 */
export const ENVIO_AUTOMATICO = 'automatico' as const;

/** One pickup address offered in a question — ids as STRINGS (int64 on the wire). */
export interface EnderecoDeColeta {
  readonly id: string;
  readonly rotulo: string;
  readonly principal: boolean;
  readonly horarios: readonly {
    readonly id: string;
    readonly rotulo: string;
    readonly recomendado: boolean;
  }[];
}

/** The mode half of a `ship_order` body (`ShipOrderParams` minus the target). */
export type CorpoDeEnvio =
  | {
      readonly modo: 'pickup';
      readonly pickup: { readonly addressId: number; readonly pickupTimeId?: string };
    }
  | { readonly modo: 'dropoff'; readonly dropoff: { readonly branchId?: number } };

export type ModoEscolhido =
  | { tipo: 'corpo'; corpo: CorpoDeEnvio }
  | {
      tipo: 'pergunta';
      enderecos: readonly EnderecoDeColeta[];
      permiteDropoff: boolean;
      escolhaInvalida: boolean;
    }
  | { tipo: 'recusa'; motivo: MotivoEtiquetaShopee };

/** One side's own answer when it is not a question: its body, or why it cannot ship. */
type Decisao = Extract<ModoEscolhido, { tipo: 'corpo' } | { tipo: 'recusa' }>;

/* ------------------------------- the wire items ----------------------------- */

/**
 * The `info_needed` items this chooser can FILL. Free strings on the wire
 * (`types.ts`), named once here; any other item makes its mode unbuildable.
 */
const ITEM_ENDERECO = 'address_id';
const ITEM_HORARIO = 'pickup_time_id';
const ITEM_AGENCIA = 'branch_id';

const ITENS_DE_COLETA: ReadonlySet<string> = new Set<string>([ITEM_ENDERECO, ITEM_HORARIO]);
const ITENS_DE_POSTAGEM: ReadonlySet<string> = new Set<string>([ITEM_AGENCIA]);

/* ------------------------------- the labels --------------------------------- */

/**
 * `dd/mm/aaaa` in the operator's zone — EXPLICIT, never the process's
 * (`no-ambient-timezone`): the same named zone the dispatch deadline is read in,
 * not a second copy of the literal.
 */
const FORMATO_DATA = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_PRAZO_DESPACHO_SHOPEE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function rotuloDoEndereco(a: ShopeePickupAddress): string {
  const partes = [a.address, a.town, a.district, a.city, a.state, a.zipcode]
    .map((p) => textoShopeeUtilizavel(p))
    .filter((p): p is string => p !== null);
  return partes.length > 0 ? partes.join(', ') : `Endereço ${String(a.address_id)}`;
}

function rotuloDoHorario(h: ShopeePickupTimeSlot): string {
  const segundos = segundosShopeeUtilizaveis(h.date);
  const partes = [
    segundos === null ? null : FORMATO_DATA.format(segundos * 1000),
    textoShopeeUtilizavel(h.time_text),
  ].filter((p): p is string => p !== null);
  return partes.length > 0 ? partes.join(' · ') : `Horário ${h.pickup_time_id}`;
}

/* ------------------------------- the pickup side ---------------------------- */

interface ColetaOferecida {
  /** Every item is one we can fill. */
  readonly construivel: boolean;
  /** The eligible addresses, in Shopee's order, each with the slots on offer. */
  readonly enderecos: readonly {
    readonly linha: ShopeePickupAddress;
    readonly horarios: readonly ShopeePickupTimeSlot[];
  }[];
}

function lerColeta(parametro: ShopeeShippingParameter, itens: readonly string[]): ColetaOferecida {
  const pedeHorario = itens.includes(ITEM_HORARIO);
  const enderecos = (parametro.pickup?.address_list ?? [])
    .filter((a): a is ShopeePickupAddress => a !== null)
    .filter((a) => (a.address_flag ?? []).includes(SHOPEE_ADDRESS_FLAG.coleta))
    .map((linha) => ({
      linha,
      horarios: pedeHorario
        ? (linha.time_slot_list ?? []).filter((h): h is ShopeePickupTimeSlot => h !== null)
        : [],
    }));
  return { construivel: itens.every((i) => ITENS_DE_COLETA.has(i)), enderecos };
}

/**
 * An eligible address the seller ALSO marked `default_address`. ONE predicate
 * for the question's `principal` and the automatic choice, so the address the
 * question highlights is the one the automatic mode ships.
 */
function ehPrincipal(a: ShopeePickupAddress): boolean {
  return (a.address_flag ?? []).includes(SHOPEE_ADDRESS_FLAG.padrao);
}

/** The slot Shopee suggests — ONE predicate for `recomendado` and the automatic choice. */
function ehRecomendado(h: ShopeePickupTimeSlot): boolean {
  return (h.flags ?? []).includes(SHOPEE_TIME_SLOT_FLAG.recomendado);
}

function enderecosDaPergunta(coleta: ColetaOferecida | null): readonly EnderecoDeColeta[] {
  if (coleta === null) return [];
  return coleta.enderecos.map(({ linha, horarios }) => ({
    id: String(linha.address_id),
    rotulo: rotuloDoEndereco(linha),
    principal: ehPrincipal(linha),
    horarios: horarios.map((h) => ({
      id: h.pickup_time_id,
      rotulo: rotuloDoHorario(h),
      recomendado: ehRecomendado(h),
    })),
  }));
}

function corpoDeColeta(
  addressId: number,
  horario: ShopeePickupTimeSlot | null,
): Extract<Decisao, { tipo: 'corpo' }> {
  return {
    tipo: 'corpo',
    corpo: {
      modo: 'pickup',
      pickup:
        horario === null ? { addressId } : { addressId, pickupTimeId: horario.pickup_time_id },
    },
  };
}

/**
 * The pickup side ALONE (F2): its body when one address and at most one slot
 * leave nothing to choose, `escolher` when the operator must pick, or the
 * refusal that makes the side unbuildable — and an unbuildable side is never
 * offered in a question.
 */
function decidirColeta(coleta: ColetaOferecida): Decisao | { tipo: 'escolher' } {
  if (!coleta.construivel) {
    return { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.modoNaoSuportado };
  }
  const [primeiro, ...outros] = coleta.enderecos;
  if (primeiro === undefined) {
    return { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.semEnderecoDeColeta };
  }
  if (outros.length > 0 || primeiro.horarios.length > 1) return { tipo: 'escolher' };
  return corpoDeColeta(primeiro.linha.address_id, primeiro.horarios[0] ?? null);
}

/**
 * The ONE element of `lista` that satisfies `marcado` — `null` when none does
 * or more than one does. Never "the first": two marked elements are a choice
 * the seller has not made, not one the ERP may make for them.
 */
function unicoMarcado<T>(lista: readonly T[], marcado: (x: T) => boolean): T | null {
  const marcados = lista.filter(marcado);
  return marcados.length === 1 ? (marcados[0] ?? null) : null;
}

/**
 * The pickup side ALONE, with nobody to ask (R-g): the same refusals as
 * {@link decidirColeta}, but several addresses resolve to the UNIQUE
 * `principal` and several slots to the UNIQUE `recomendado`; anything less is
 * `escolher`. Zero slots stay zero — the body then carries no `pickupTimeId`.
 */
function decidirColetaAutomatica(coleta: ColetaOferecida): Decisao | { tipo: 'escolher' } {
  if (!coleta.construivel) {
    return { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.modoNaoSuportado };
  }
  if (coleta.enderecos.length === 0) {
    return { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.semEnderecoDeColeta };
  }
  const endereco =
    coleta.enderecos.length === 1
      ? (coleta.enderecos[0] ?? null)
      : unicoMarcado(coleta.enderecos, (e) => ehPrincipal(e.linha));
  if (endereco === null) return { tipo: 'escolher' };
  if (endereco.horarios.length <= 1) {
    return corpoDeColeta(endereco.linha.address_id, endereco.horarios[0] ?? null);
  }
  const horario = unicoMarcado(endereco.horarios, ehRecomendado);
  return horario === null
    ? { tipo: 'escolher' }
    : corpoDeColeta(endereco.linha.address_id, horario);
}

/* ------------------------------- the dropoff side --------------------------- */

/**
 * The dropoff side ALONE: its body, or the refusal that makes it unbuildable —
 * and then `permiteDropoff` is `false` (F2): a question never offers a dropoff
 * this function would refuse.
 */
function decidirPostagem(parametro: ShopeeShippingParameter, itens: readonly string[]): Decisao {
  if (!itens.every((i) => ITENS_DE_POSTAGEM.has(i))) {
    return { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.modoNaoSuportado };
  }
  if (!itens.includes(ITEM_AGENCIA)) {
    return { tipo: 'corpo', corpo: { modo: 'dropoff', dropoff: {} } };
  }
  // The RAW list: a `null` sentinel is a branch Shopee offered that we cannot read.
  const agencias = parametro.dropoff?.branch_list ?? [];
  if (agencias.length > 1) {
    return { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.agenciaPrecisaEscolha };
  }
  const unica = agencias[0] ?? null;
  if (unica === null) return { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.modoNaoSuportado };
  return { tipo: 'corpo', corpo: { modo: 'dropoff', dropoff: { branchId: unica.branch_id } } };
}

/* ------------------------------- the choosers ------------------------------- */

/**
 * No mode the ERP can print for — neither `pickup` nor `dropoff` in
 * `info_needed`. The first rung of BOTH choosers.
 */
function recusaSemModo(parametro: ShopeeShippingParameter): Decisao {
  return {
    tipo: 'recusa',
    motivo:
      parametro.info_needed?.non_integrated != null
        ? MOTIVO_ETIQUETA_SHOPEE.semEtiquetaShopee
        : MOTIVO_ETIQUETA_SHOPEE.modoNaoSuportado,
  };
}

/**
 * Decide the mode for ONE package (see the module docblock).
 *
 * @param parametro this call's FRESH `get_shipping_parameter` answer.
 * @param escolha the operator's answer for THIS package, or `null`.
 */
export function escolherModoDeEnvio(
  parametro: ShopeeShippingParameter,
  escolha: EscolhaDeEnvio | null,
): ModoEscolhido {
  const info = parametro.info_needed;
  const itensColeta = info?.pickup ?? null;
  const itensPostagem = info?.dropoff ?? null;

  // ---- no mode the ERP can print for ----
  if (itensColeta === null && itensPostagem === null) return recusaSemModo(parametro);

  const coleta = itensColeta === null ? null : lerColeta(parametro, itensColeta);

  // ---- buildability FIRST (F2): each side alone, before anything is asked ----
  const ladoColeta = coleta === null ? null : decidirColeta(coleta);
  const ladoPostagem = itensPostagem === null ? null : decidirPostagem(parametro, itensPostagem);
  // Offered ⇔ Shopee put the key in `info_needed` AND the server can ship it.
  const coletaOferecida = ladoColeta !== null && ladoColeta.tipo !== 'recusa';
  const postagemOferecida = ladoPostagem !== null && ladoPostagem.tipo === 'corpo';

  const pergunta = (escolhaInvalida: boolean): ModoEscolhido => ({
    tipo: 'pergunta',
    enderecos: coletaOferecida ? enderecosDaPergunta(coleta) : [],
    // Reached with only the dropoff on offer solely by a stale answer, where it
    // is the option left to confirm.
    permiteDropoff: postagemOferecida,
    escolhaInvalida,
  });

  /** The decision with no answer yet — also the fallback of a stale one. */
  const semEscolha = (): ModoEscolhido => {
    if (coletaOferecida && postagemOferecida) return pergunta(false);
    // Exactly one buildable side: decided, never asked (the pickup still asks
    // which address or slot when it offers more than one).
    if (ladoColeta !== null && ladoColeta.tipo !== 'recusa') {
      return ladoColeta.tipo === 'escolher' ? pergunta(false) : ladoColeta;
    }
    if (postagemOferecida) return ladoPostagem;
    // Nothing buildable: the refusal of the side Shopee offered — the DROPOFF's
    // when it offered both. One of the two is non-null: the first rung refused
    // both-null.
    return (
      ladoPostagem ??
      ladoColeta ?? { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.modoNaoSuportado }
    );
  };

  if (escolha === null) return semEscolha();

  // ---- the operator answered: match it EXACTLY against this read ----
  // A stale answer is RE-ASKED, never replaced by the one option left — unless
  // nothing is left to ask about, and then this read's own refusal answers. An
  // answer naming a side this read does not OFFER (absent, or unbuildable) is
  // stale too.
  const invalida = (): ModoEscolhido => {
    const agora = semEscolha();
    return agora.tipo === 'recusa' ? agora : pergunta(true);
  };

  if (escolha.modo === 'dropoff') {
    return postagemOferecida ? ladoPostagem : invalida();
  }
  if (coleta === null || !coletaOferecida) return invalida();
  const endereco = coleta.enderecos.find((e) => String(e.linha.address_id) === escolha.enderecoId);
  if (endereco === undefined) return invalida();
  if (escolha.horarioId === null) {
    return endereco.horarios.length === 0
      ? corpoDeColeta(endereco.linha.address_id, null)
      : invalida();
  }
  const horario = endereco.horarios.find((h) => h.pickup_time_id === escolha.horarioId);
  return horario === undefined ? invalida() : corpoDeColeta(endereco.linha.address_id, horario);
}

/**
 * Decide the mode for ONE package with NO operator (step 15b, R-g — see the
 * module docblock): from THIS read alone, or `pergunta` with
 * `escolhaInvalida: false`. Never guesses.
 *
 * @param parametro this call's FRESH `get_shipping_parameter` answer.
 */
export function escolherModoAutomatico(parametro: ShopeeShippingParameter): ModoEscolhido {
  const info = parametro.info_needed;
  const itensColeta = info?.pickup ?? null;
  const itensPostagem = info?.dropoff ?? null;

  // ---- no mode the ERP can print for ----
  if (itensColeta === null && itensPostagem === null) return recusaSemModo(parametro);

  // ---- each side alone, with the operator chooser's readers ----
  const coleta = itensColeta === null ? null : lerColeta(parametro, itensColeta);
  const ladoColeta = coleta === null ? null : decidirColetaAutomatica(coleta);
  const ladoPostagem = itensPostagem === null ? null : decidirPostagem(parametro, itensPostagem);

  // The pickup decided ⇒ the pickup, even when a dropoff is buildable.
  if (ladoColeta?.tipo === 'corpo') return ladoColeta;
  // ⚠️ The pickup OFFERED but undecided ⇒ ask — never a silent switch to the
  // dropoff, the mode that puts a physical trip on the seller. The question is
  // the operator chooser's own (the same options, the same `principal`).
  if (ladoColeta?.tipo === 'escolher') {
    return {
      tipo: 'pergunta',
      enderecos: enderecosDaPergunta(coleta),
      permiteDropoff: ladoPostagem?.tipo === 'corpo',
      escolhaInvalida: false,
    };
  }
  if (ladoPostagem?.tipo === 'corpo') return ladoPostagem;
  // Nothing buildable: the operator chooser's refusal — the DROPOFF's when
  // Shopee offered both. One of the two is non-null: the first rung refused
  // both-null.
  return (
    ladoPostagem ??
    ladoColeta ?? { tipo: 'recusa', motivo: MOTIVO_ETIQUETA_SHOPEE.modoNaoSuportado }
  );
}
