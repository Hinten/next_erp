/**
 * Shopee package fulfilment → the pedido's `freteInicial` state (#1515, step 7).
 *
 * PURE: no Firestore, no wire call, no clock, no console — and **no unit
 * conversion**. Every number that reaches this module is already MICROSECONDS
 * (the field names say so: `prazoDespachoUs`, `relogioUs`, `prazoDaOrdemUs`);
 * the one seconds → µs crossing of this path happens at the wire boundary, in
 * the caller. This file is deliberately absent from the µs SITE list in
 * `apps/shopee/CLAUDE.md`, and any of the three converters that list names
 * appearing here would be the drift the list exists to prevent — pinned by a
 * test that greps this very source for them as RAW TEXT, which is why they are
 * not spelled anywhere in this file, comments included.
 *
 * Every decision is a function of the MERGED per-package diary and the payload
 * handed in, which is what lets the transaction re-derive its verdict from its
 * own snapshot instead of from a decision taken outside the callback (root
 * `CLAUDE.md` rule 7).
 *
 * ## The three tables, and why they are three
 *
 *  1. TOKEN → `EstadoFrete` — Shopee's 11-value `PackageFulfillmentStatus`
 *     (`guide 31`, `guide 229`) plus the two legacy values the ORDER call adds
 *     (`LOGISTICS_PENDING_ARRANGE`, `LOGISTICS_COD_REJECTED`) and the two
 *     alternate spellings the docs use in different places. `guide 229` heads
 *     one list "Package Fulfillment Status / Logistics Status", which is what
 *     makes ONE table serve both sources — and therefore what makes the push
 *     path and the order-import backstop converge.
 *  2. The LADDER — `estadoFreteSchema`'s own declared lifecycle order from
 *     `iniciado` to `entregue`, with the two OUTCOMES inside that run removed.
 *     It is ENUMERATED, not sliced out of `estadoFreteSchema.options`: a value
 *     inserted into that enum tomorrow would silently become a rung.
 *  3. The FAILURE PRECEDENCE — the answer when EVERY package failed, ranked by
 *     physical consequence, never by clock. A clock-ordered answer would not be
 *     idempotent under out-of-order pushes, which is the one thing this whole
 *     step is built to survive.
 *
 * ## ⚠️ An unknown token is DATA, never an error
 *
 * The legacy's `LogisticsStatus.fromJson` was a `firstWhere` with no `orElse`
 * and raised `StateError` on any unmodelled value. Here an unknown token
 * answers `null`, is stored VERBATIM in `pacotes[].estadoMarketplace`, and is
 * reported to the caller once per delivery. `faq 207` alone introduced a
 * spelling (`LOGISTICS_REQUEST_CANCELLED`, double L) that `guide 31` does not
 * use, so "the docs enumerate the set" is not a premise this code may hold.
 *
 * ## ⚠️ The estado moves PHYSICAL STOCK
 *
 * `sincronizarEstoquePedido` observes the dot-path `freteInicial.estado` and
 * `efeitoEstoquePedido` makes membership of `ESTADOS_FRETE_REMOVE_ESTOQUE` a
 * sufficient ENTRY condition for removal. Every row of table (1) therefore
 * carries a stock column in its test, and `LOGISTICS_REQUEST_CREATED` is where
 * the goods leave — because on BR channels 90021/90025/90026 a package that
 * nobody drives with `update_tracking_status` stays there for ever
 * (`announcement 1264`), so any later rung as the trigger would leave a shipped
 * order's stock on the shelf.
 *
 * ## ⚠️ `LOGISTICS_PICKUP_FAILED` is the one row the docs refuse to settle
 *
 * "3PL due to failed pickup OR picked up but not able to proceed with delivery".
 * It maps to `suspenso`, which IS in the removal set — the only direction that
 * cannot oversell a unit that is physically gone. The order's own `CANCELLED`
 * (step 5's ladder) is what restores the stock if the parcel never left.
 * UNVERIFIED until a live BR observation (register item 35).
 *
 * ## ⚠️ `LOGISTICS_PENDING_ARRANGE` is NOT mapped
 *
 * `faq 207`: "This state is only available for Return objects", corroborated by
 * `push 32`'s own sample. Returns are step 17's (code 29). It is recorded raw
 * and never reaches the pedido's single `estado` slot.
 *
 * ## ⚠️ Channel identity is `logistics_channel_id`, never the carrier string
 *
 * `get_package_detail`'s own text: "If logistics_channel_id is 90021, 90025 or
 * 90026, service_code will be appended, e.g. Entrega Turbo - M1020."
 *
 * ## Promotion (#1428)
 *
 * The ladder and the verdict are channel-agnostic ONCE a second caller exists:
 *
 * ```ts
 * estadoFreteAplicavel(armazenado, alvo, { escada, terminais, retorno, foraDoCanal })
 * ```
 *
 * with each channel supplying its policy AS DATA — which would also replace
 * Mercado Livre's `mergeEstadoFretePreservando` and its
 * `ESTADOS_ANTES_DO_CHECKOUT`. It stays HERE until then: the repo's promotion
 * rule is "it lives in `@delfrance/schemas` because it has TWO callers that must
 * not disagree" (`seedFreteInicial`'s own docblock), and today it has one.
 */
import {
  ESTADO_FRETE,
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  type EstadoFrete,
  type PacoteFrete,
} from '@delfrance/schemas';

import type { FontePacoteShopee } from './fretePushShopee';

/* -------------------------------------------------------------------------- */
/*                        (1) the token → estado table                         */
/* -------------------------------------------------------------------------- */

/**
 * ONE Shopee package fulfilment token → ONE `EstadoFrete`, or `null`.
 *
 * `null` has TWO reasons and they are not the same fact — see
 * {@link MOTIVO_TOKEN_SHOPEE}. Nothing here throws.
 *
 * ⚠️ Attribution, because the issue body gets it wrong and would send the next
 * reader to the wrong page: `LOGISTICS_NOT_STARTED` is **not** `push 33`'s
 * sample (that page's only `LOGISTICS_*` strings are `LOGISTICS_READY` and
 * `LOGISTICS_REQUEST_CREATED`). Its sources are `faq 207` and `push 32`'s
 * return sample; `LOGISTICS_REQUEST_CANCELLED` (double L) is `faq 207`'s alone.
 *
 * ⚠️ `BACKEND_LOGISTICS_NOT_STARTED` is a `cancel_reason` on `get_order_detail`,
 * an unrelated field. It must never be fed to this table — pinned by a test.
 */
export const ESTADO_FRETE_DE_TOKEN_SHOPEE = {
  LOGISTICS_NOT_START: ESTADO_FRETE.iniciado,
  LOGISTICS_NOT_STARTED: ESTADO_FRETE.iniciado,
  LOGISTICS_READY: ESTADO_FRETE.despachoAutorizado,
  LOGISTICS_REQUEST_CREATED: ESTADO_FRETE.aguardandoPostagem,
  LOGISTICS_PICKUP_RETRY: ESTADO_FRETE.aguardandoPostagem,
  LOGISTICS_PICKUP_DONE: ESTADO_FRETE.postado,
  LOGISTICS_DELIVERY_DONE: ESTADO_FRETE.entregue,
  LOGISTICS_DELIVERY_FAILED: ESTADO_FRETE.falhaNaEntrega,
  LOGISTICS_LOST: ESTADO_FRETE.objetoExtraviado,
  LOGISTICS_INVALID: ESTADO_FRETE.cancelado,
  LOGISTICS_REQUEST_CANCELED: ESTADO_FRETE.cancelado,
  /** `faq 207`'s double-L spelling — its OWN key, never a normalisation rule. */
  LOGISTICS_REQUEST_CANCELLED: ESTADO_FRETE.cancelado,
  /** ⚠️ The ambiguous one — see the module header. */
  LOGISTICS_PICKUP_FAILED: ESTADO_FRETE.suspenso,
  LOGISTICS_COD_REJECTED: ESTADO_FRETE.despachoNegado,
} as const satisfies Record<string, EstadoFrete>;

/**
 * Tokens that are DELIBERATELY not mapped — recorded raw, never written.
 *
 * `LOGISTICS_PENDING_ARRANGE` is a RETURN-object value (`faq 207`) and returns
 * are step 17's. It is separated from "unknown" so the caller's log can say
 * which of the two facts it saw.
 */
export const TOKENS_DE_RETORNO_SHOPEE: ReadonlySet<string> = new Set<string>([
  'LOGISTICS_PENDING_ARRANGE',
]);

/** Why {@link estadoFreteDeTokenShopee} produced no `EstadoFrete`. */
export type MotivoTokenShopee =
  /** A value the docs give to reverse logistics only — step 17 owns it. */
  | 'retorno'
  /** Anything this table does not name, including a future `LOGISTICS_*`. */
  | 'desconhecido';

/** Named members of {@link MotivoTokenShopee}. */
export const MOTIVO_TOKEN_SHOPEE = {
  retorno: 'retorno',
  desconhecido: 'desconhecido',
} as const satisfies Record<string, MotivoTokenShopee>;

/** What one raw token means, or why it means nothing. */
export type LeituraTokenFreteShopee =
  | { readonly estado: EstadoFrete }
  | { readonly estado: null; readonly motivo: MotivoTokenShopee };

/**
 * Fold ONE raw Shopee token.
 *
 * ⚠️ **Exact lookup, and no normalisation of any kind** — no case fold, no
 * `trim`, no prefix rule, no de-doubling of the `LL`. Every alias is its own key
 * above. A prefix rule would silently absorb a future
 * `LOGISTICS_REQUEST_CANCELLED_BY_SYSTEM` into `cancelado`, which is the #1372
 * shape: the fold applies, and what goes wrong is its SCOPE. The near-miss is a
 * test (`LOGISTICS_REQUEST_CANCELLED_X` must stay `null`).
 *
 * `Object.hasOwn` rather than a bare index read, so `'constructor'`,
 * `'toString'` and friends answer `desconhecido` like any other unknown string.
 */
export function estadoFreteDeTokenShopee(token: string): LeituraTokenFreteShopee {
  if (Object.hasOwn(ESTADO_FRETE_DE_TOKEN_SHOPEE, token)) {
    return { estado: ESTADO_FRETE_DE_TOKEN_SHOPEE[token as TokenFreteShopee] };
  }
  if (TOKENS_DE_RETORNO_SHOPEE.has(token)) {
    return { estado: null, motivo: MOTIVO_TOKEN_SHOPEE.retorno };
  }
  return { estado: null, motivo: MOTIVO_TOKEN_SHOPEE.desconhecido };
}

type TokenFreteShopee = keyof typeof ESTADO_FRETE_DE_TOKEN_SHOPEE;

/** `null` in, `null` out — the diary's `estadoMarketplace` is nullable. */
function estadoDeTokenOuNull(token: string | null): EstadoFrete | null {
  return token == null ? null : estadoFreteDeTokenShopee(token).estado;
}

/* -------------------------------------------------------------------------- */
/*                     (2) the ladder, the sets, the verdict                   */
/* -------------------------------------------------------------------------- */

/**
 * The forward-only rungs. It IS `estadoFreteSchema`'s own declared lifecycle
 * order from `iniciado` to `entregue`, with the two OUTCOMES that sit inside
 * that run removed — `aguardandoAgendamento` and `despachoNegado` are beside the
 * chain, not on it.
 *
 * ⚠️ ENUMERATED rather than sliced out of `estadoFreteSchema.options`, because a
 * value inserted into that enum tomorrow would silently become a rung here. The
 * "it IS the enum's order" claim is machine-checked by a subsequence test
 * instead.
 *
 * The `checkFinalizado` non-downgrade is DERIVED from this ordering rather than
 * special-cased: rung 8 refuses `aguardandoPostagem` (7) and yields to `postado`
 * (9), which reproduces both arms of Mercado Livre's
 * `mergeEstadoFretePreservando` from one list.
 */
export const ESCADA_FRETE_SHOPEE = [
  ESTADO_FRETE.iniciado, //                         0  ← LOGISTICS_NOT_START(ED), step 5's seed
  ESTADO_FRETE.aguardandoAutorizacao, //            1
  ESTADO_FRETE.aguardandoNFe, //                    2
  ESTADO_FRETE.aguardandoValidacaoTransporadora, // 3
  ESTADO_FRETE.despachoAutorizado, //               4  ← LOGISTICS_READY
  ESTADO_FRETE.emSeparacao, //                      5
  ESTADO_FRETE.empacotado, //                       6
  ESTADO_FRETE.aguardandoPostagem, //               7  ← LOGISTICS_REQUEST_CREATED / PICKUP_RETRY
  ESTADO_FRETE.checkFinalizado, //                  8  ← the OPERATOR's despatch checkout
  ESTADO_FRETE.postado, //                          9  ← LOGISTICS_PICKUP_DONE
  ESTADO_FRETE.recebidoPelaTransportadora, //      10
  ESTADO_FRETE.aCaminho, //                        11
  ESTADO_FRETE.tentandoRealizarEntrega, //         12
  ESTADO_FRETE.entregue, //                        13  ← LOGISTICS_DELIVERY_DONE
] as const satisfies ReadonlyArray<EstadoFrete>;

/**
 * Outcomes that end the chain — ENUMERATED, never derived from `faq 207`.
 *
 * ⚠️ `entregue` is terminal even though `faq 207`'s "Can be end state" column
 * omits it: deriving terminality from that page mechanically classifies the
 * happy ending as non-terminal. ⚠️ `suspenso` is deliberately NOT terminal, so a
 * re-arranged pickup after `PICKUP_FAILED` can still progress.
 */
export const ESTADOS_FRETE_SHOPEE_TERMINAL: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.entregue,
  ESTADO_FRETE.cancelado,
  ESTADO_FRETE.falhaNaEntrega,
  ESTADO_FRETE.objetoExtraviado,
  ESTADO_FRETE.despachoNegado,
  ESTADO_FRETE.devolvido,
]);

/** Step 17 owns reverse logistics. Step 7 never walks one back. */
export const ESTADOS_FRETE_RETORNO: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.aCaminhoDoRemetente,
  ESTADO_FRETE.devolvido,
]);

/** A block another modality owns — a Shopee parcel cannot be in either. */
export const ESTADOS_FRETE_FORA_DO_CANAL: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.fulfillment,
  ESTADO_FRETE.aguardandoRetirada,
]);

/**
 * The failure outcomes this channel can produce, most physically consequential
 * first. Consulted only when NO package is live.
 */
export const ORDEM_FALHA_SHOPEE = [
  ESTADO_FRETE.objetoExtraviado, // the goods are gone
  ESTADO_FRETE.falhaNaEntrega, //   the goods are out, delivery failed
  ESTADO_FRETE.suspenso, //         ambiguous pickup
  ESTADO_FRETE.despachoNegado, //   denied before dispatch
  ESTADO_FRETE.cancelado, //        never handed over
] as const satisfies ReadonlyArray<EstadoFrete>;

/** Set form of {@link ORDEM_FALHA_SHOPEE}. */
export const FALHA_FRETE_SHOPEE: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>(
  ORDEM_FALHA_SHOPEE,
);

/** Why an estado was NOT written. */
export type MotivoFreteShopee =
  /** The fold produced no ERP estado (an unknown or return-only token). */
  | 'token-desconhecido'
  /** The stored estado already IS the target. */
  | 'sem-mudanca'
  /** Backwards on the ordered ladder (a late package event). */
  | 'regressivo'
  /** The stored estado belongs to reverse logistics — step 17's. */
  | 'retorno-preservado'
  /** The stored estado is step 14's NF-e stamp and the target is routine churn. */
  | 'erro-preservado'
  /** The block belongs to another modality (fulfillment / retirada na loja). */
  | 'fora-do-canal';

/** Named members of {@link MotivoFreteShopee}. */
export const MOTIVO_FRETE_SHOPEE = {
  tokenDesconhecido: 'token-desconhecido',
  semMudanca: 'sem-mudanca',
  regressivo: 'regressivo',
  retornoPreservado: 'retorno-preservado',
  erroPreservado: 'erro-preservado',
  foraDoCanal: 'fora-do-canal',
} as const satisfies Record<string, MotivoFreteShopee>;

export type VereditoFreteShopee =
  | {
      readonly escrever: true;
      readonly estado: EstadoFrete;
      /** A terminal estado was left for a non-terminal one. Logged loudly. */
      readonly ressuscitado: boolean;
    }
  | { readonly escrever: false; readonly motivo: MotivoFreteShopee };

/** The rung index, or `-1` for an estado that is not on the ladder at all. */
function indiceEscada(estado: EstadoFrete): number {
  return (ESCADA_FRETE_SHOPEE as readonly EstadoFrete[]).indexOf(estado);
}

/**
 * May the stored `freteInicial.estado` be moved to what the fold now says?
 *
 * The twin of `estadoShopeeAplicavel` (`orderStatusMaps.ts`), same shape and
 * same `ressuscitado` flag — seven gates, in this order:
 *
 *  1. `alvo == null` ⇒ `token-desconhecido` (nothing was understood).
 *  2. `alvo === armazenado` ⇒ `sem-mudanca` (the replay).
 *  3. stored ∈ {@link ESTADOS_FRETE_FORA_DO_CANAL} ⇒ `fora-do-canal`.
 *  4. stored ∈ {@link ESTADOS_FRETE_RETORNO} ⇒ `retorno-preservado`.
 *  5. stored is `error` ⇒ write ONLY when the target is a physical fact
 *     (`ESTADOS_FRETE_REMOVE_ESTOQUE`, the SHARED set — a parcel that really
 *     moved clears step 14's NF-e stamp; routine churn must not). ⚠️ The set is
 *     read from `@delfrance/schemas` rather than enumerated here: it is the
 *     same set `efeitoEstoquePedido` consults to move physical stock, and a
 *     channel-local copy of it would drift TOWARD plausible (#1369). It is
 *     WIDER than this channel's token table can produce, which changes nothing
 *     today — `alvo` always comes from {@link dobrarPacotesShopee} over rows
 *     derived from {@link ESTADO_FRETE_DE_TOKEN_SHOPEE}, whose image meets the
 *     shared set in exactly six estados (a test measures that intersection).
 *  6. both on the ladder and the target sits lower ⇒ `regressivo`.
 *  7. otherwise write.
 *
 * ⚠️ `cancelado → aguardandoPostagem` WRITES, flagged `ressuscitado`. The
 * `alvo` is derived from a fresh pull, never from a push body, so a package
 * Shopee now reports as `REQUEST_CREATED` after an `INVALID` is a real
 * re-arranged pickup; refusing it would strand a live shipment with its stock on
 * the books (`cancelado` is not a removal estado, `aguardandoPostagem` is).
 * Same doctrine as `estadoShopeeAplicavel`'s `cancelado → pago`.
 *
 * ⚠️ `ressuscitado` is `TERMINAL.has(armazenado) && !TERMINAL.has(alvo)` — the
 * expression `estadoShopeeAplicavel` uses verbatim. It is therefore FALSE when
 * one terminal is exchanged for another (`falhaNaEntrega → entregue`,
 * `cancelado → entregue`, `objetoExtraviado → entregue`): the write still
 * happens, only the loud-log flag stays down. The design report's verdict table
 * annotates those three rows "ressuscitado" in prose while stating this
 * expression as the implementation twice, and its own worked example E5
 * (`postado → objetoExtraviado`, "not ressuscitado") only agrees with the
 * expression — so the expression is what ships, and the three rows are pinned
 * with the values it produces.
 */
export function estadoFreteShopeeAplicavel(
  armazenado: EstadoFrete,
  alvo: EstadoFrete | null,
): VereditoFreteShopee {
  if (alvo == null) {
    return { escrever: false, motivo: MOTIVO_FRETE_SHOPEE.tokenDesconhecido };
  }
  if (alvo === armazenado) {
    return { escrever: false, motivo: MOTIVO_FRETE_SHOPEE.semMudanca };
  }
  if (ESTADOS_FRETE_FORA_DO_CANAL.has(armazenado)) {
    return { escrever: false, motivo: MOTIVO_FRETE_SHOPEE.foraDoCanal };
  }
  if (ESTADOS_FRETE_RETORNO.has(armazenado)) {
    return { escrever: false, motivo: MOTIVO_FRETE_SHOPEE.retornoPreservado };
  }
  if (armazenado === ESTADO_FRETE.error) {
    return ESTADOS_FRETE_REMOVE_ESTOQUE.has(alvo)
      ? { escrever: true, estado: alvo, ressuscitado: true }
      : { escrever: false, motivo: MOTIVO_FRETE_SHOPEE.erroPreservado };
  }
  const de = indiceEscada(armazenado);
  const para = indiceEscada(alvo);
  if (de >= 0 && para >= 0 && para < de) {
    return { escrever: false, motivo: MOTIVO_FRETE_SHOPEE.regressivo };
  }
  return {
    escrever: true,
    estado: alvo,
    ressuscitado:
      ESTADOS_FRETE_SHOPEE_TERMINAL.has(armazenado) && !ESTADOS_FRETE_SHOPEE_TERMINAL.has(alvo),
  };
}

/* -------------------------------------------------------------------------- */
/*                     (3) the diary — observation and merge                   */
/* -------------------------------------------------------------------------- */

/**
 * The closed set of Shopee sources for a diary row. `PacoteFrete['fonte']` is a
 * FREE string on purpose (the set is per-channel), so the closed set lives here.
 *
 * ⚠️ It `satisfies Record<string, FontePacoteShopee>` — the union the WIRE
 * READER puts on `PacoteObservadoShopee.fonte` — so the two declarations of one
 * vocabulary cannot drift apart in the direction this file controls. The other
 * direction (a member added to the union) is held by the fidelity table, which
 * a test assigns to `Record<FontePacoteShopee, number>` and which would then
 * fail to compile. Two names for one set is the shape the root `CLAUDE.md`
 * warns about; this is the compiler holding them together instead of a comment.
 */
export const FONTE_PACOTE_SHOPEE = {
  packageDetail: 'get_package_detail',
  orderDetail: 'get_order_detail',
} as const satisfies Record<string, FontePacoteShopee>;

/**
 * Provenance rank — higher wins, unknown/absent is `0`.
 *
 * `get_package_detail` carries the PACKAGE clock ("the last time that there was
 * a change in value of package"); `get_order_detail` carries only the ORDER
 * clock, standing in for a package clock it does not have. Ranking them is what
 * stops the code-3 backstop re-stamping a pull's rows on every order import —
 * one write, one audit row, per import, for ever.
 */
export const FIDELIDADE_FONTE_PACOTE_SHOPEE = {
  [FONTE_PACOTE_SHOPEE.packageDetail]: 2,
  [FONTE_PACOTE_SHOPEE.orderDetail]: 1,
} as const satisfies Record<string, number>;

/** The rank of a stored or incoming `fonte`; anything unrecognised is `0`. */
export function fidelidadeDaFonteShopee(fonte: string | null | undefined): number {
  if (fonte == null) return 0;
  return Object.hasOwn(FIDELIDADE_FONTE_PACOTE_SHOPEE, fonte)
    ? FIDELIDADE_FONTE_PACOTE_SHOPEE[fonte as keyof typeof FIDELIDADE_FONTE_PACOTE_SHOPEE]
    : 0;
}

/**
 * One package as a single delivery observed it.
 *
 * ⚠️ **Microseconds already.** `prazoDespachoUs` and `relogioUs` arrive
 * converted — Shopee's wire values are SECONDS and the crossing happens once, at
 * the wire boundary, in the caller. Nothing in this module converts anything,
 * and the 2020 floor that drops a zero-filled `ship_by_date` is applied there
 * too: here such a value simply arrives as `null` and contributes nothing.
 */
export interface ObservacaoPacoteUs {
  /** `package_number` — the ROW IDENTITY. */
  readonly numero: string;
  /** The provider's raw token, VERBATIM. `null` when the source carries none. */
  readonly estadoMarketplace: string | null;
  readonly codRastreio: string | null;
  /** `logistics_channel_id` as a string — NEVER the carrier label. */
  readonly canalId: string | null;
  /** µs. */
  readonly prazoDespachoUs: number | null;
  /** µs — the clock this source offers for this row. */
  readonly relogioUs: number | null;
  /** A member of {@link FONTE_PACOTE_SHOPEE}. */
  readonly fonte: string;
}

/** What {@link mesclarPacotesShopee} produced, plus what it had to say about it. */
export interface MesclaPacotesShopee {
  /** The whole diary, sorted ASC by `numero`. Never shorter than the stored one. */
  readonly pacotes: PacoteFrete[];
  /** Distinct `numero`s whose observation the freshness gate DROPPED. */
  readonly obsoletos: string[];
  /** Distinct raw tokens this delivery carried that the table does not map. */
  readonly tokensDesconhecidos: string[];
  /** Distinct raw tokens this delivery carried that belong to step 17. */
  readonly tokensDeRetorno: string[];
}

/** A row that does not exist yet — the neutral element of the field merge. */
function linhaEmBranco(numero: string): PacoteFrete {
  return {
    numero,
    estado: null,
    estadoMarketplace: null,
    codRastreio: null,
    canalId: null,
    prazoDespacho: null,
    atualizadoEm: null,
    fonte: null,
  };
}

/**
 * Apply one observation onto one row.
 *
 * The four WIRE fields are merged as `recebido ?? armazenado ?? null`. That one
 * expression carries two different reasons and both are load-bearing:
 *
 *  - for `codRastreio`, `canalId` and `prazoDespacho` it is FILL-OR-KEEP — an
 *    absent value is "this source has nothing to say", never "erase what an
 *    earlier tick learnt";
 *  - for `estadoMarketplace` it is TAKE-NEW-WHEN-PRESENT — the freshest word is
 *    the answer, because a state machine whose token could only be filled in
 *    once would make a `PICKUP_RETRY` after a `PICKUP_FAILED` unreachable. The
 *    freshness gate above is what makes that safe.
 *
 * `carimbar` is false on the lower-fidelity path: the fields still apply, but a
 * source carrying the ORDER clock may not re-stamp a PACKAGE clock, and may not
 * claim the row's `fonte`.
 *
 * ⚠️ `atualizadoEm` advances ONLY when one of the four wire fields actually
 * changed — never merely because we looked, and never on a change of the DERIVED
 * `estado` (a correction to the token table must not re-stamp a wire clock).
 * That single rule is what makes a replay an empty patch. When content changed
 * but the source carries no clock the stored stamp STANDS: erasing it would
 * disarm the freshness gate for ever.
 */
function aplicarNaLinha(
  armazenado: PacoteFrete,
  obs: ObservacaoPacoteUs,
  carimbar: boolean,
): PacoteFrete {
  const estadoMarketplace = obs.estadoMarketplace ?? armazenado.estadoMarketplace ?? null;
  const codRastreio = obs.codRastreio ?? armazenado.codRastreio ?? null;
  const canalId = obs.canalId ?? armazenado.canalId ?? null;
  const prazoDespacho = obs.prazoDespachoUs ?? armazenado.prazoDespacho ?? null;

  const mudouConteudo =
    estadoMarketplace !== (armazenado.estadoMarketplace ?? null) ||
    codRastreio !== (armazenado.codRastreio ?? null) ||
    canalId !== (armazenado.canalId ?? null) ||
    prazoDespacho !== (armazenado.prazoDespacho ?? null);

  const atualizadoEm =
    carimbar && mudouConteudo
      ? (obs.relogioUs ?? armazenado.atualizadoEm ?? null)
      : (armazenado.atualizadoEm ?? null);

  return {
    ...armazenado,
    estado: estadoDeTokenOuNull(estadoMarketplace),
    estadoMarketplace,
    codRastreio,
    canalId,
    prazoDespacho,
    atualizadoEm,
    fonte: carimbar ? obs.fonte : (armazenado.fonte ?? null),
  };
}

/** Re-derive a row's projected `estado`, returning the SAME object when it holds. */
function comEstadoDerivado(linha: PacoteFrete): PacoteFrete {
  const estado = estadoDeTokenOuNull(linha.estadoMarketplace ?? null);
  return estado === (linha.estado ?? null) ? linha : { ...linha, estado };
}

/** Plain code-unit order — never `localeCompare`, whose result is locale-dependent. */
function compararNumeroPacote(a: PacoteFrete, b: PacoteFrete): number {
  if (a.numero < b.numero) return -1;
  if (a.numero > b.numero) return 1;
  return 0;
}

function empurrarDistinto(destino: string[], valor: string): void {
  if (!destino.includes(valor)) destino.push(valor);
}

/**
 * Merge this delivery's observations into the stored diary.
 *
 * The gate per row, in order (a fidelity difference SHORT-CIRCUITS the clock —
 * the two sources do not share a clock, so comparing them is meaningless):
 *
 * | stored row | incoming | verdict |
 * |---|---|---|
 * | absent | any | apply (first sight) |
 * | lower fidelity | higher | apply, and stamp |
 * | higher fidelity | lower | apply the FIELDS, never `fonte`/`atualizadoEm` |
 * | same fidelity, either clock `null` | — | apply (no clock is not evidence of ORDER) |
 * | same fidelity, stored clock > incoming | — | DROP the row (`obsoletos`) |
 * | same fidelity, clocks equal | — | apply; content equality then decides |
 * | same fidelity, stored clock < incoming | — | apply |
 *
 * ⚠️ The null-clock row is the OPPOSITE of Mercado Livre's
 * `POLITICA_FRESCOR_TOPICO_SHIPMENTS`, which answers "ignore" to all three null
 * cases. Applied verbatim here it would block the whole code-3 backstop.
 *
 * ⚠️ **Nothing is ever deleted.** Rows this delivery did not name are returned
 * exactly as stored (only their projected `estado` is re-derived, which is a
 * no-op unless the token table itself changed — that is the anti-drift property
 * #1369 asks for). `consolidaPacote: 'nao'` means Shopee can SPLIT an order, so
 * a package number missing from one call's list is not evidence that the parcel
 * stopped existing.
 *
 * ⚠️ A stored diary holding two rows with the same `numero` is not repaired by
 * dropping one — both are merged and both are returned. Deleting a row is the
 * one thing this function will not do.
 *
 * Every `estado` in the result is a PROJECTION of that row's
 * `estadoMarketplace`, re-derived on every delivery.
 */
export function mesclarPacotesShopee(
  armazenados: readonly PacoteFrete[],
  observacoes: readonly ObservacaoPacoteUs[],
): MesclaPacotesShopee {
  const tokensDesconhecidos: string[] = [];
  const tokensDeRetorno: string[] = [];
  // Reported from every observation this delivery carried, BEFORE the freshness
  // gate: a token we could not read was on the wire whether or not its row was
  // fresh enough to apply, and the caller logs it once per delivery.
  for (const obs of observacoes) {
    const token = obs.estadoMarketplace;
    if (token == null) continue;
    const leitura = estadoFreteDeTokenShopee(token);
    if (leitura.estado != null) continue;
    empurrarDistinto(
      leitura.motivo === MOTIVO_TOKEN_SHOPEE.retorno ? tokensDeRetorno : tokensDesconhecidos,
      token,
    );
  }

  const porNumero = new Map<string, ObservacaoPacoteUs[]>();
  for (const obs of observacoes) {
    // An empty identity cannot name a row (and `numero` is `.min(1)` on the
    // schema, so a row built from one could never be written anyway).
    if (obs.numero === '') continue;
    const lista = porNumero.get(obs.numero);
    if (lista == null) porNumero.set(obs.numero, [obs]);
    else lista.push(obs);
  }

  const obsoletos: string[] = [];
  const pacotes: PacoteFrete[] = [];
  const vistos = new Set<string>();

  for (const armazenado of armazenados) {
    vistos.add(armazenado.numero);
    let linha = armazenado;
    for (const obs of porNumero.get(armazenado.numero) ?? []) {
      const rankArmazenado = fidelidadeDaFonteShopee(linha.fonte);
      const rankRecebido = fidelidadeDaFonteShopee(obs.fonte);
      if (rankRecebido > rankArmazenado) {
        linha = aplicarNaLinha(linha, obs, true);
        continue;
      }
      if (rankRecebido < rankArmazenado) {
        linha = aplicarNaLinha(linha, obs, false);
        continue;
      }
      const armazenadoUs = linha.atualizadoEm;
      const recebidoUs = obs.relogioUs;
      if (armazenadoUs != null && recebidoUs != null && armazenadoUs > recebidoUs) {
        empurrarDistinto(obsoletos, armazenado.numero);
        continue;
      }
      linha = aplicarNaLinha(linha, obs, true);
    }
    pacotes.push(comEstadoDerivado(linha));
  }

  for (const [numero, lista] of porNumero) {
    if (vistos.has(numero)) continue;
    let linha = linhaEmBranco(numero);
    for (const obs of lista) linha = aplicarNaLinha(linha, obs, true);
    pacotes.push(linha);
  }

  pacotes.sort(compararNumeroPacote);
  return { pacotes, obsoletos, tokensDesconhecidos, tokensDeRetorno };
}

/* -------------------------------------------------------------------------- */
/*                          (4) the N-package fold                             */
/* -------------------------------------------------------------------------- */

/** `freteDoPedidoSchema.codRastreio` is `z.string().max(200)` — a hard cap. */
export const LIMITE_COD_RASTREIO_SHOPEE = 200;

export interface DobraFreteShopee {
  readonly estado: EstadoFrete | null;
  /** `null` means "nothing to say", NEVER "erase". */
  readonly codRastreio: string | null;
  readonly prazoDespachoUs: number | null;
  readonly externalOptionId: string | null;
  /** Two or more packages claim different logistics channels. */
  readonly canaisDivergentes: boolean;
  /** Not even ONE tracking number fitted the cap — the pathological slice. */
  readonly codRastreioTruncado: boolean;
}

/** The joined tracking numbers, and whether a single number had to be cut. */
function juntarCodRastreio(numeros: readonly string[]): {
  codRastreio: string | null;
  codRastreioTruncado: boolean;
} {
  const primeiro = numeros[0];
  if (primeiro === undefined) return { codRastreio: null, codRastreioTruncado: false };
  const inteiro = numeros.join(', ');
  if (inteiro.length <= LIMITE_COD_RASTREIO_SHOPEE) {
    return { codRastreio: inteiro, codRastreioTruncado: false };
  }
  // Greedy: the MOST whole entries that still fit beside a ` +N` remainder.
  for (let mantidos = numeros.length - 1; mantidos >= 1; mantidos -= 1) {
    const texto = `${numeros.slice(0, mantidos).join(', ')} +${numeros.length - mantidos}`;
    if (texto.length <= LIMITE_COD_RASTREIO_SHOPEE) {
      return { codRastreio: texto, codRastreioTruncado: false };
    }
  }
  return {
    codRastreio: primeiro.slice(0, LIMITE_COD_RASTREIO_SHOPEE),
    codRastreioTruncado: true,
  };
}

/**
 * Fold the whole diary into the pedido's SINGLE freight slots.
 *
 * ⚠️ It runs over the MERGED diary — never over one delivery's observations —
 * so a push about one package of a two-package order cannot regress the pedido,
 * and it reads each row's `estado`, which {@link mesclarPacotesShopee} keeps a
 * projection of `estadoMarketplace`.
 *
 * **`estado`: the LEAST-ADVANCED live package.** Live = mapped, on the ladder,
 * and not a failure. When none is live the answer is the first member of
 * {@link ORDEM_FALHA_SHOPEE} present — a DECLARED precedence, never "the latest
 * by clock", because a clock-ordered answer is not idempotent under out-of-order
 * pushes. This reproduces `faq 510` (Shopee's own order status follows "the
 * package that is fulfilled the earliest", ignores failed packages, and reaches
 * `COMPLETED` only when all are delivered) in one expression, and it is the only
 * stock-safe direction: a pedido's stock leaves as a WHOLE, so folding to the
 * most-advanced package would empty the shelf while a parcel is still on it.
 *
 * **`codRastreio`**: the distinct numbers of the packages sorted ASC by `numero`
 * and joined by `', '`, capped at {@link LIMITE_COD_RASTREIO_SHOPEE} (a naive
 * join throws inside the merge parse at ~10 packages). An empty fold is
 * `null` = fill-or-keep; a non-null fold REPLACES, because the marketplace is
 * the authority on a marketplace-owned block and a migrated `codRastreio` may
 * hold a legacy PACKAGE number rather than a carrier code.
 *
 * **`prazoDespachoUs`**: the EARLIEST package deadline — `min` over the diary,
 * never `min(stored, incoming)`. `push 44`'s two samples disagree on the
 * DIRECTION of a `ship_by_date` move, so a monotone floor against the stored
 * value would make a pushed-out deadline unreachable for ever. `prazoDaOrdemUs`
 * is the ORDER-level fallback and applies ONLY when no package carries one.
 *
 * **`externalOptionId`**: the channel when every package that carries one
 * agrees. Two packages on the SAME channel is an equally unambiguous claim, so
 * this subsumes step 5's "exactly one package" rule; disagreement answers `null`
 * and raises `canaisDivergentes`. `shipping_carrier` is NEVER read — Shopee
 * appends a `service_code` to it on BR channels 90021/90025/90026.
 */
export function dobrarPacotesShopee(
  pacotes: readonly PacoteFrete[],
  prazoDaOrdemUs: number | null,
): DobraFreteShopee {
  let vivo: { estado: EstadoFrete; indice: number } | null = null;
  const falhos = new Set<EstadoFrete>();
  for (const pacote of pacotes) {
    const estado = pacote.estado;
    if (estado == null) continue;
    if (FALHA_FRETE_SHOPEE.has(estado)) {
      falhos.add(estado);
      continue;
    }
    const indice = indiceEscada(estado);
    // An off-ladder non-failure estado is unreachable from the token table; it
    // is skipped exactly like a null one rather than compared against Infinity.
    if (indice < 0) continue;
    if (vivo == null || indice < vivo.indice) vivo = { estado, indice };
  }
  const estado =
    vivo != null ? vivo.estado : (ORDEM_FALHA_SHOPEE.find((e) => falhos.has(e)) ?? null);

  const ordenados = [...pacotes].sort(compararNumeroPacote);

  const numeros: string[] = [];
  for (const pacote of ordenados) {
    const codRastreio = pacote.codRastreio;
    // `''` is not a tracking number; joining one would emit a stray separator.
    if (codRastreio == null || codRastreio === '') continue;
    empurrarDistinto(numeros, codRastreio);
  }
  const { codRastreio, codRastreioTruncado } = juntarCodRastreio(numeros);

  let prazoDespachoUs: number | null = null;
  for (const pacote of ordenados) {
    const prazo = pacote.prazoDespacho;
    if (prazo == null) continue;
    if (prazoDespachoUs == null || prazo < prazoDespachoUs) prazoDespachoUs = prazo;
  }
  if (prazoDespachoUs == null) prazoDespachoUs = prazoDaOrdemUs;

  const canais: string[] = [];
  for (const pacote of ordenados) {
    const canalId = pacote.canalId;
    if (canalId == null || canalId === '') continue;
    empurrarDistinto(canais, canalId);
  }

  return {
    estado,
    codRastreio,
    prazoDespachoUs,
    externalOptionId: canais.length === 1 ? (canais[0] ?? null) : null,
    canaisDivergentes: canais.length > 1,
    codRastreioTruncado,
  };
}
