/**
 * The producer of the two avisos of the automatic arrange (step 15b, #1744),
 * and every machine resolver those tipos owe (`packages/schemas/src/aviso.ts`,
 * the tipo docblock: every member names its resolver before it ships).
 *
 * ## The two tipos
 *
 * - **`despachoAutomaticoPendente`** — a package on an auto-arrange channel
 *   (`CANAIS_ARRANJO_AUTOMATICO`, announcement 1573) reached the hook
 *   (`pedidos/arranjoAutomatico.ts`) and was NOT arranged for a reason a person
 *   must act on. Without a dispatch attempt Shopee cancels the order. ONE row
 *   per PACKAGE per CLASS: `nfe` (the invoice is not validated yet — `atencao`,
 *   the routine state of a fresh BR order) or `manual` (the automation cannot
 *   arrange it by itself — `critico`, the `shopeePushSuspenso` reason: orders
 *   are lost unless a human acts).
 * - **`etiquetaComPrazo`** — announcement 1573 item 2: on 90011/90012 ONLY
 *   (`CANAIS_ETIQUETA_COM_PRAZO`), an arranged shipment's label must be issued
 *   and printed within 1 hour of the order. ONE row per PEDIDO, `atencao`.
 *
 * ## ⚠️ The class is the `janela`, and that is what makes it re-alert
 *
 * `escreverAviso` keeps `criadoEm` on a repeat, so one row cannot re-light the
 * bell when its situation changes. The dangerous transition — the operator
 * emitted the NF-e, read the `nfe` row, Shopee validated it, and then OUR
 * arrange was refused — must reach the operator as a NEW, unread row, which is
 * what a second class buys. The class is a finite pair the resolvers recompute
 * (both are tried), so the "a windowed key is a key the resolver cannot
 * recompute" trap of `avisos/autorizacao.ts` does not apply.
 *
 * ## ⚠️ `params` are exactly `pedido` (+ `situacao` on the dispatch row)
 *
 * `apps/web/lib/avisos/mensagens.ts` renders these tipos from those params and
 * nothing else. `pedido` is the `order_sn` (the display number on this
 * channel); `situacao` is {@link fraseDoDespachoPendente}'s fragment — lowercase,
 * remedy first, no trailing period. NO deadline rides anywhere, neither as a
 * param nor as the aviso's deadline field: a repeat REPLACES `params`
 * wholesale, so a deadline known only to the run that read the order would be
 * erased by the next repeat that did not (R-j). No event clock either — the
 * hook starts from a fresh read, never from a provider clock, and supplying one
 * would freeze `ocorrencias` (the `nfe/avisoNfe.ts` reasoning). No external
 * link: a Seller Centre deep link would be invented, not provider-supplied.
 *
 * ## The opens are keyed on the hook's DESFECHO
 *
 * {@link acoesDeAvisoDoDespacho} is the whole decision, PURE and table-shaped:
 * the hook's total `DESFECHO_DO_MOTIVO` is the one authority over which Shopee
 * motivo becomes which desfecho, so this module keeps no second closed set of
 * "motivos that alert" (the two-copies smell). An empty list makes the executor
 * read nothing at all.
 *
 * ⚠️ …and every OPEN is then checked against the frete transaction's CONFIRMED
 * estado (`EntradaArranjoAutomatico.estadoFreteConfirmado`). The hook runs on
 * `ignorado-obsoleto` too — a row OLDER than the stored diary, a lagging
 * replica — and the resolvers run BEFORE it, so an open keyed on that row would
 * land last and resurrect the alert the newer fact resolved (review 3a, Q2-F1).
 * The guard drops exactly the opens a FRESH read of the confirmed estado could
 * never produce, through the resolvers' own closing predicates; resolves are
 * never dropped.
 *
 * ## The resolvers
 *
 * - The HOOK's own, through the same table: our arrange happened, or Shopee
 *   says it already did (`arranjado`); the invoice gate passed on a pre-arrange
 *   phase (`nfe-validada`, class `nfe` only — "rule N"); the order read showed a
 *   cancelled order (`pedido-cancelado`).
 * - {@link resolverAvisosDeDespachoSeEncerrado} — the CROSS-STEP one, called by
 *   BOTH callers of the step-7 frete write (the package push and the order
 *   import), after it returns, on every outcome — the
 *   `resolverAvisoNfeSeEncerrado` twin. It resolves; it never opens, so it is
 *   correct on every path, `rastrear:pedido --live` included.
 *
 * ## Rule 7
 *
 * The only writes are `escreverAviso` (tier 0 create on the deterministic id,
 * tier 1 precondition on a repeat) and `resolverAviso` (read + tier 1, a
 * TRANSITION). This module runs no multi-document atomic write and NAMES none —
 * the inventory greps raw text. The aviso is not a guard between arrangers:
 * Shopee's `is_shipment_arranged` / `package_already_shipped` is.
 *
 * ⚠️ Residual: there is no event-clock tier here (R-j, the `params` section),
 * so the confirmed-estado guard catches a stale row only when the NEWER
 * delivery's transaction committed before the stale one's. Two deliveries truly in flight
 * together — X reads before a transition, Y after it, and Y's resolve lands
 * inside X's window — can still reopen a row for seconds; the next fresh
 * delivery closes it again (review 3a, Q2-F2).
 *
 * ## Units
 *
 * This module converts nothing and reads no clock: every signature takes
 * MILLISECONDS, and "now" crosses into the aviso's microseconds through the
 * seam in `avisos/autorizacao.ts` ({@link agoraUsDe} / {@link depsDeEscrita}).
 *
 * ⚠️ The hook module is imported for its TYPES only. The hook value-imports this
 * module (its default `avisar`), and `pedidos/rastrearPedido.ts` imports it for
 * the cross-step resolver — so a value import back would put the arrange in the
 * import graph of `rastrear:pedido`, which must never load it (R-a).
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { type ResultadoAviso, escreverAviso, resolverAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  ESTADO_FRETE,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
  type ChaveAvisoInput,
  type EstadoFrete,
  type SeveridadeAviso,
} from '@delfrance/schemas';

import {
  ehCanalDeArranjoAutomatico,
  ehCanalDeEtiquetaComPrazo,
  faseDoTokenShopee,
  faseTemPortaoDeNfe,
} from '../etiqueta/faseEtiqueta';
import {
  MOTIVO_ETIQUETA_SHOPEE,
  fraseDoMotivoEtiqueta,
  type MotivoEtiquetaShopee,
} from '../etiqueta/motivosEtiqueta';
import type {
  AvisadorDeArranjo,
  EntradaArranjoAutomatico,
  ResultadoArranjoAutomatico,
} from '../pedidos/arranjoAutomatico';
import { ESCADA_FRETE_SHOPEE, ESTADO_FRETE_DE_TOKEN_SHOPEE } from '../pedidos/freteShopeeMapping';
import type { PacoteObservadoShopee } from '../pedidos/fretePushShopee';
import { SHOPEE_ORDER_STATUS } from '../pedidos/orderStatusMaps';
import { type AvisoDeps, agoraUsDe, depsDeEscrita } from './autorizacao';

/* -------------------------------------------------------------------------- */
/*                                the vocabulary                               */
/* -------------------------------------------------------------------------- */

/**
 * The class of a dispatch row — its `janela` (module docblock). `nfe`: the
 * invoice blocks the arrange; `manual`: a person must arrange it.
 */
export const CLASSE_DESPACHO_PENDENTE = { nfe: 'nfe', manual: 'manual' } as const;

/** One of {@link CLASSE_DESPACHO_PENDENTE}'s values. */
export type ClasseDespachoPendente =
  (typeof CLASSE_DESPACHO_PENDENTE)[keyof typeof CLASSE_DESPACHO_PENDENTE];

/** Both classes, in the order the resolvers try them. */
const CLASSES: readonly ClasseDespachoPendente[] = [
  CLASSE_DESPACHO_PENDENTE.nfe,
  CLASSE_DESPACHO_PENDENTE.manual,
];

/**
 * The hook's OWN reasons — the three desfechos that carry no Shopee motivo.
 * Stored in `aviso.motivo` beside the label flow's motivos, so none of them may
 * spell a member of `MOTIVO_ETIQUETA_SHOPEE` (the suite pins the disjointness).
 */
export const MOTIVO_DESPACHO_PROPRIO = {
  precisaEscolha: 'precisa-escolha',
  arranjoDesligado: 'arranjo-automatico-desligado',
  respostaIlegivel: 'resposta-ilegivel',
} as const;

/** What a dispatch row's `motivo` can hold. */
export type MotivoDespachoPendente =
  | MotivoEtiquetaShopee
  | (typeof MOTIVO_DESPACHO_PROPRIO)[keyof typeof MOTIVO_DESPACHO_PROPRIO];

/**
 * Which fact closed a row. Persisted in `resolucaoMotivo`, so a closed aviso
 * still says WHY — and therefore not free to rename.
 */
export const RESOLUCAO_AVISO_DESPACHO = {
  arranjado: 'arranjado',
  nfeValidada: 'nfe-validada',
  coletado: 'coletado',
  pedidoCancelado: 'pedido-cancelado',
  envioEncerrado: 'envio-encerrado',
} as const;

/** One of {@link RESOLUCAO_AVISO_DESPACHO}'s values. */
export type ResolucaoAvisoDespacho =
  (typeof RESOLUCAO_AVISO_DESPACHO)[keyof typeof RESOLUCAO_AVISO_DESPACHO];

/** Severity is per CLASS (module docblock); the print row is always `atencao`. */
const SEVERIDADE_DA_CLASSE = {
  nfe: SEVERIDADE_AVISO.atencao,
  manual: SEVERIDADE_AVISO.critico,
} as const satisfies Record<ClasseDespachoPendente, SeveridadeAviso>;

/* -------------------------------------------------------------------------- */
/*                              the frete estados                              */
/* -------------------------------------------------------------------------- */

/**
 * The estados that prove the goods LEFT — what closes the print row
 * (`coletado`): step 7's own ladder from `postado` (rung 9) up, plus the two
 * outcomes that also need a collected parcel.
 *
 * ⚠️ DERIVED from `ESCADA_FRETE_SHOPEE`, so a ladder edit carries. And
 * deliberately NOT `aguardandoPostagem` (rung 7 — what our OWN arrange
 * produces), NOT `checkFinalizado` (rung 8, the operator's despatch checkout,
 * whose label step may still have failed) and NOT `suspenso` (a failed pickup is
 * re-arranged and still needs the label). The suite holds a near-miss for each.
 */
export const ESTADOS_FRETE_POS_COLETA_SHOPEE: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ...ESCADA_FRETE_SHOPEE.slice(ESCADA_FRETE_SHOPEE.indexOf(ESTADO_FRETE.postado)),
  ESTADO_FRETE.falhaNaEntrega,
  ESTADO_FRETE.objetoExtraviado,
]);

/**
 * The estados that end the print obligation without a collection — step 7's
 * `LOGISTICS_INVALID` / `LOGISTICS_REQUEST_CANCEL(L)ED` and
 * `LOGISTICS_COD_REJECTED`.
 */
export const ESTADOS_FRETE_CANCELADO_SHOPEE: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.cancelado,
  ESTADO_FRETE.despachoNegado,
]);

/**
 * The confirmed estados that END a dispatch row — what makes the stale-row
 * guard drop an `abrir-despacho` (module docblock).
 *
 * ⚠️ DERIVED, never listed: an estado is in iff EVERY step-7 token that maps to
 * it is one the cross-step resolver closes a dispatch row on
 * ({@link resolucaoDoPacote} — arranged, past the window, or the shipment
 * cancelled / failed). So the guard drops exactly the opens a FRESH read of
 * that estado's token could never produce, and it is the resolver's own
 * closing fact rather than a third list. Today:
 * `aguardandoPostagem` (rung 7, REQUEST_CREATED / PICKUP_RETRY), the
 * collected estados, `cancelado`, `despachoNegado` and `suspenso`
 * (PICKUP_FAILED — the label flow refuses it, and the resolver closes on it).
 * Not `despachoAutorizado` (READY: arranged or not, the token cannot say) nor
 * `iniciado`. The ladder rungs no token produces (`checkFinalizado`,
 * `recebidoPelaTransportadora`, …) are absent and unreachable: a confirmed
 * estado is the diary's fold, and every diary estado is a token's projection.
 * An estado that a closing and a non-closing token SHARE is left out, so its
 * opens stand — the safe direction, since a lost open is an order Shopee
 * cancels.
 */
export const ESTADOS_FRETE_DESPACHO_ENCERRADO_SHOPEE: ReadonlySet<EstadoFrete> = estadosDeTodoToken(
  (token) => resolucaoDoPacote(token, false) !== null,
);

/**
 * The estados every one of whose step-7 tokens satisfies `encerra` — see
 * {@link ESTADOS_FRETE_DESPACHO_ENCERRADO_SHOPEE}.
 */
function estadosDeTodoToken(encerra: (token: string) => boolean): ReadonlySet<EstadoFrete> {
  const sim = new Set<EstadoFrete>();
  const nao = new Set<EstadoFrete>();
  for (const [token, estado] of Object.entries(ESTADO_FRETE_DE_TOKEN_SHOPEE)) {
    (encerra(token) ? sim : nao).add(estado);
  }
  return new Set<EstadoFrete>([...sim].filter((estado) => !nao.has(estado)));
}

/* -------------------------------------------------------------------------- */
/*                                  the chaves                                 */
/* -------------------------------------------------------------------------- */

/**
 * The ONE identity of a dispatch row; {@link chaveAvisoDespachoPendente} and the
 * opener's plano both spread it, so the key the opener writes is the key every
 * resolver recomputes by construction rather than by comparison.
 *
 * `entidade` is `<pedidoId>:<packageNumber>` — `chaveDeAviso` folds the inner
 * `:` to `_`, and a `pedidoId` is a fixed-length digest, so the fold cannot
 * collide.
 */
function identidadeDespacho(
  integracaoId: string,
  pedidoId: string,
  packageNumber: string,
  classe: ClasseDespachoPendente,
): ChaveAvisoInput & { tipo: typeof TIPO_AVISO.despachoAutomaticoPendente } {
  return {
    tipo: TIPO_AVISO.despachoAutomaticoPendente,
    conta: integracaoId,
    entidade: `${pedidoId}:${packageNumber}`,
    janela: classe,
  };
}

/** The ONE identity of a print row: per pedido, no `janela`. */
function identidadeEtiqueta(
  integracaoId: string,
  pedidoId: string,
): ChaveAvisoInput & { tipo: typeof TIPO_AVISO.etiquetaComPrazo } {
  return { tipo: TIPO_AVISO.etiquetaComPrazo, conta: integracaoId, entidade: pedidoId };
}

/**
 * The dedup identity — and the Firestore document id — of a dispatch row: ONE
 * per PACKAGE per CLASS (module docblock).
 *
 * ⚠️ Exported so every resolver derives the SAME key; a resolver that computes
 * its own is how a row ends up standing forever.
 */
export function chaveAvisoDespachoPendente(
  integracaoId: string,
  pedidoId: string,
  packageNumber: string,
  classe: ClasseDespachoPendente,
): string {
  return chaveDeAviso(identidadeDespacho(integracaoId, pedidoId, packageNumber, classe));
}

/**
 * The dedup identity of the print row: ONE per PEDIDO — one checkout prints
 * every package of it.
 */
export function chaveAvisoEtiquetaComPrazo(integracaoId: string, pedidoId: string): string {
  return chaveDeAviso(identidadeEtiqueta(integracaoId, pedidoId));
}

/* -------------------------------------------------------------------------- */
/*                                the fragments                                */
/* -------------------------------------------------------------------------- */

/** The motivos whose fragment is this module's own, not the label flow's. */
type MotivoComFrasePropria =
  | typeof MOTIVO_ETIQUETA_SHOPEE.nfePendente
  | typeof MOTIVO_ETIQUETA_SHOPEE.semEnderecoDeColeta
  | typeof MOTIVO_ETIQUETA_SHOPEE.agenciaPrecisaEscolha
  | typeof MOTIVO_ETIQUETA_SHOPEE.modoNaoSuportado
  | typeof MOTIVO_ETIQUETA_SHOPEE.etiquetaIndisponivel
  | typeof MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida
  | (typeof MOTIVO_DESPACHO_PROPRIO)[keyof typeof MOTIVO_DESPACHO_PROPRIO];

/**
 * The fragments that are this module's own — a different promise from the
 * label flow's click-context wording, never a copy of it. Lowercase, remedy
 * first, no trailing period.
 *
 * - The NF-e class: the label flow's `nfe-pendente` says "antes de imprimir a
 *   etiqueta"; here the arrange happens by itself once the note validates.
 * - The hook's three own reasons.
 * - ⚠️ Every `manual` motivo whose label wording is WRONG in the bell (review
 *   3a, Q3-4): the label flow says "… e clique de novo" (`sem-endereco-de-coleta`,
 *   `agencia-precisa-escolha`, `modo-nao-suportado`) — the bell has no button —
 *   or blames the LABEL for what, on the hook's three calls (order read,
 *   parameter read, ship), was Shopee refusing the SHIPMENT
 *   (`recusa-desconhecida`, `etiqueta-indisponivel`). Where the checkout would
 *   refuse the same way (the operator chooser also cannot pick an agency or
 *   fill the unsupported data), the remedy names the Seller Centre alone.
 *
 * ⚠️ `satisfies Record<…>`: a new own motivo without a fragment is a COMPILE
 * error, never a fall-through to the label flow's table.
 */
const FRASE_PROPRIA_DO_DESPACHO = {
  [MOTIVO_ETIQUETA_SHOPEE.nfePendente]:
    'emita a NF-e do pedido — a Shopee só libera o envio com a nota validada, e o despacho automático é feito assim que ela validar',
  [MOTIVO_ETIQUETA_SHOPEE.semEnderecoDeColeta]:
    'marque um endereço de coleta na Central do Vendedor e organize o envio por lá ou pelo checkout — a loja não tem endereço de coleta para este envio',
  [MOTIVO_ETIQUETA_SHOPEE.agenciaPrecisaEscolha]:
    'escolha a agência e organize o envio pela Central do Vendedor — a Shopee oferece mais de uma agência de postagem para este envio, e o ERP não escolhe a agência',
  [MOTIVO_ETIQUETA_SHOPEE.modoNaoSuportado]:
    'organize o envio pela Central do Vendedor — a Shopee pede dados de envio que o ERP não preenche',
  [MOTIVO_ETIQUETA_SHOPEE.etiquetaIndisponivel]:
    'organize o envio pela Central do Vendedor, ou pelo checkout mais tarde — a Shopee ainda não libera o envio na situação atual do pedido',
  [MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida]:
    'organize o envio pelo checkout ou pela Central do Vendedor — a Shopee recusou o despacho automático por um motivo que o ERP não reconhece',
  [MOTIVO_DESPACHO_PROPRIO.precisaEscolha]:
    'organize o envio pelo checkout ou pela Central do Vendedor — a Shopee pede uma escolha de endereço, horário ou modalidade que o despacho automático não faz sozinho',
  [MOTIVO_DESPACHO_PROPRIO.arranjoDesligado]:
    'organize o envio pelo checkout ou pela Central do Vendedor — o despacho automático está desligado neste ambiente',
  [MOTIVO_DESPACHO_PROPRIO.respostaIlegivel]:
    'organize o envio pelo checkout ou pela Central do Vendedor — o despacho automático não conseguiu ler a resposta da Shopee',
} as const satisfies Record<MotivoComFrasePropria, string>;

function temFrasePropria(motivo: MotivoDespachoPendente): motivo is MotivoComFrasePropria {
  // `Object.hasOwn`, so `'constructor'` and friends are never an own fragment.
  return Object.hasOwn(FRASE_PROPRIA_DO_DESPACHO, motivo);
}

/**
 * The `situacao` fragment of a dispatch row: this module's own sentence for the
 * motivos above, and the label flow's ONE table (`fraseDoMotivoEtiqueta`) for
 * every other — the second reader of that table, not a copy of it.
 */
export function fraseDoDespachoPendente(motivo: MotivoDespachoPendente): string {
  return temFrasePropria(motivo)
    ? FRASE_PROPRIA_DO_DESPACHO[motivo]
    : fraseDoMotivoEtiqueta(motivo);
}

/* -------------------------------------------------------------------------- */
/*                                  the table                                  */
/* -------------------------------------------------------------------------- */

/** One aviso effect of one hook run. */
export type AcaoDeAvisoDespacho =
  | {
      readonly tipo: 'abrir-despacho';
      readonly classe: ClasseDespachoPendente;
      readonly motivo: MotivoDespachoPendente;
    }
  | {
      readonly tipo: 'resolver-despacho';
      readonly classe: ClasseDespachoPendente;
      readonly resolucao: ResolucaoAvisoDespacho;
    }
  | { readonly tipo: 'abrir-etiqueta' }
  | { readonly tipo: 'resolver-etiqueta'; readonly resolucao: ResolucaoAvisoDespacho };

/**
 * Rule N: resolve the `nfe` row with `nfe-validada` iff the invoice gate passed
 * on the way to this phase AND the run did not end on the invoice itself.
 *
 * ⚠️ The phase half is the GATE's own predicate (`faseTemPortaoDeNfe`,
 * `etiqueta/faseEtiqueta.ts`) — never a phase list kept here (review 3a, Q4-3):
 * an edit to the gate moves rule N with it. A phase that predicate answers
 * `true` for would have been `nfe-pendente` had the invoice been pending, so a
 * package answered on it passed the gate; it keeps an arranged, collected or
 * cancelled package from claiming an invoice fact it never checked.
 * `despachoAutomatico.test.ts` pins rule N against the REAL `fasePacote`, phase
 * by phase. The desfecho half covers the ship that answered `nfe-pendente` on a
 * `programar` phase — Shopee refused for the invoice our read thought clear.
 *
 * ⚠️ TWO deliberate exceptions to the gate: `desconhecido` and `nao-pronto`.
 * The gate reads the invoice on both (a pending invoice there still refuses the
 * ship), but announcement 1521 reports a pending invoice ONLY in a
 * shipment-ready status — so "not pending" on a token this repo cannot place,
 * or on a package that is not ready yet, is weak evidence that the NF-e
 * cleared. And the hook runs on a STALE row by design (`ignorado-obsoleto`): a
 * lagging `LOGISTICS_NOT_START` row arriving after a READY + pending row opened
 * the `nfe` alert would otherwise close it as `nfe-validada`, and nothing
 * re-observes a package held at READY by its invoice until the next push or
 * sweep tick (PR #1754's review). Only `programar` / `retido` — phases on a
 * READY package, where Shopee does report the flag — may close it; a package
 * leaving NOT_START is re-observed at READY, where the arrange closes the row
 * as `arranjado` anyway. A wrong close loses the urgent "emit the NF-e" alert;
 * a late close only keeps it a little longer.
 */
function regraN(r: ResultadoArranjoAutomatico): readonly AcaoDeAvisoDespacho[] {
  return faseTemPortaoDeNfe(r.fase) &&
    r.fase !== 'desconhecido' &&
    r.fase !== 'nao-pronto' &&
    r.desfecho !== 'nfe-pendente'
    ? [resolverDespacho(CLASSE_DESPACHO_PENDENTE.nfe, RESOLUCAO_AVISO_DESPACHO.nfeValidada)]
    : [];
}

function abrirManual(motivo: MotivoDespachoPendente): AcaoDeAvisoDespacho {
  return { tipo: 'abrir-despacho', classe: CLASSE_DESPACHO_PENDENTE.manual, motivo };
}

function resolverDespacho(
  classe: ClasseDespachoPendente,
  resolucao: ResolucaoAvisoDespacho,
): AcaoDeAvisoDespacho {
  return { tipo: 'resolver-despacho', classe, resolucao };
}

/**
 * The hook table: one hook result → the aviso effects, in a fixed order (the
 * `nfe` row, the `manual` row, the print row). PURE.
 *
 * | desfecho | `nfe` | `manual` | print (90011/90012) |
 * |---|---|---|---|
 * | `nfe-pendente` | OPEN | — | — |
 * | `programado`, `ja-programado` | resolve `arranjado` | resolve `arranjado` | OPEN |
 * | `recusado` | rule N | OPEN (the motivo) | — |
 * | `precisa-escolha` / `desligado` / `resposta-ilegivel` | rule N | OPEN (own motivo) | — |
 * | `nao-elegivel` on `pedido-cancelado` | resolve | resolve | resolve |
 * | every other (`retido`, `aguardando`, `verificar`, `credencial`, other `nao-elegivel`) | rule N | — | — |
 *
 * - The print row opens on EVERY arranged observation, `ja-programado`
 *   included: Auto Call Driver and the redelivery after a lost write both
 *   reach the hook as `ja-programado`, never as `programado`, and an
 *   irreversible ship must not lose its print alert.
 * - `retido` (Shopee's temporary hold) and `credencial` (the conta aviso is
 *   that problem's one producer) open NOTHING; neither do the transients
 *   `aguardando` / `verificar`, which the next delivery re-runs.
 * - `fora-do-canal` answers `[]`: the hook never calls `avisar` for it, and the
 *   table stays total anyway.
 * - A `recusado` without a motivo cannot come from the hook (its result names
 *   one on every refusal); it opens on `recusa-desconhecida` rather than
 *   staying silent, because the order is still at risk.
 *
 * Then {@link semAberturaContradita} drops the OPENS the entrada's confirmed
 * frete estado contradicts — the stale-row guard (module docblock). No row of
 * the table reads the entrada; only that guard does.
 */
export function acoesDeAvisoDoDespacho(
  e: EntradaArranjoAutomatico,
  r: ResultadoArranjoAutomatico,
): readonly AcaoDeAvisoDespacho[] {
  return semAberturaContradita(e.estadoFreteConfirmado, r, acoesDoDesfecho(r));
}

/**
 * The stale-row guard: drop each OPEN that a fresh read of the confirmed
 * (newer) estado could never produce, and nothing else.
 *
 * - `abrir-despacho` (both classes) when the estado ENDS a dispatch row
 *   ({@link ESTADOS_FRETE_DESPACHO_ENCERRADO_SHOPEE} — arranged, collected,
 *   cancelled).
 * - `abrir-etiqueta` when the estado alone CLOSES the print row — the
 *   resolver's own predicate ({@link resolucaoDaEtiqueta}): collected or the
 *   shipment cancelled. ⚠️ Never on `aguardandoPostagem`: that is the arranged
 *   package the print alert exists for. ⚠️ And never on `programado`: OUR
 *   `ship_order` succeeded in THIS run, after the transaction — the one fact
 *   newer than the confirmed estado (a package re-arranged after a cancel is
 *   step 7's resurrection), and an irreversible ship must not lose its print
 *   alert.
 *
 * ⚠️ `null` drops nothing — no corroborated estado, no contradiction. And the
 * resolves always stand: closing a row the newer fact ended is never wrong.
 */
function semAberturaContradita(
  estado: EstadoFrete | null,
  r: ResultadoArranjoAutomatico,
  acoes: readonly AcaoDeAvisoDespacho[],
): readonly AcaoDeAvisoDespacho[] {
  if (estado === null) return acoes;
  const despachoEncerrado = ESTADOS_FRETE_DESPACHO_ENCERRADO_SHOPEE.has(estado);
  const etiquetaEncerrada =
    r.desfecho !== 'programado' && resolucaoDaEtiqueta(estado, false) !== null;
  return acoes.filter(
    (a) =>
      !(a.tipo === 'abrir-despacho' && despachoEncerrado) &&
      !(a.tipo === 'abrir-etiqueta' && etiquetaEncerrada),
  );
}

/** The table's rows: one hook result → its effects, before the stale-row guard. */
function acoesDoDesfecho(r: ResultadoArranjoAutomatico): readonly AcaoDeAvisoDespacho[] {
  const comPrazo = ehCanalDeEtiquetaComPrazo(r.canalId);
  switch (r.desfecho) {
    case 'fora-do-canal':
      return [];
    case 'nfe-pendente':
      return [
        {
          tipo: 'abrir-despacho',
          classe: CLASSE_DESPACHO_PENDENTE.nfe,
          motivo: MOTIVO_ETIQUETA_SHOPEE.nfePendente,
        },
      ];
    case 'programado':
    case 'ja-programado':
      return [
        resolverDespacho(CLASSE_DESPACHO_PENDENTE.nfe, RESOLUCAO_AVISO_DESPACHO.arranjado),
        resolverDespacho(CLASSE_DESPACHO_PENDENTE.manual, RESOLUCAO_AVISO_DESPACHO.arranjado),
        ...(comPrazo ? [{ tipo: 'abrir-etiqueta' } as const] : []),
      ];
    case 'recusado':
      return [...regraN(r), abrirManual(r.motivo ?? MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida)];
    case 'precisa-escolha':
      return [...regraN(r), abrirManual(MOTIVO_DESPACHO_PROPRIO.precisaEscolha)];
    case 'desligado':
      return [...regraN(r), abrirManual(MOTIVO_DESPACHO_PROPRIO.arranjoDesligado)];
    case 'resposta-ilegivel':
      return [...regraN(r), abrirManual(MOTIVO_DESPACHO_PROPRIO.respostaIlegivel)];
    case 'nao-elegivel':
      if (r.motivo === MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado) {
        return [
          resolverDespacho(CLASSE_DESPACHO_PENDENTE.nfe, RESOLUCAO_AVISO_DESPACHO.pedidoCancelado),
          resolverDespacho(
            CLASSE_DESPACHO_PENDENTE.manual,
            RESOLUCAO_AVISO_DESPACHO.pedidoCancelado,
          ),
          ...(comPrazo
            ? [
                {
                  tipo: 'resolver-etiqueta',
                  resolucao: RESOLUCAO_AVISO_DESPACHO.pedidoCancelado,
                } as const,
              ]
            : []),
        ];
      }
      return regraN(r);
    case 'retido':
    case 'aguardando':
    case 'verificar':
    case 'credencial':
      return regraN(r);
    default: {
      // A new desfecho stops compiling here until it decides its row.
      const nunca: never = r.desfecho;
      return nunca;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                the executor                                 */
/* -------------------------------------------------------------------------- */

/**
 * A dispatch row's plano: `params` EXACTLY `{ pedido, situacao }`, the class
 * severity, the checkout route — and nothing else (module docblock).
 */
function planoDespachoPendente(
  e: EntradaArranjoAutomatico,
  classe: ClasseDespachoPendente,
  motivo: MotivoDespachoPendente,
) {
  return {
    ...identidadeDespacho(e.integracaoId, e.pedidoId, e.packageNumber, classe),
    severidade: SEVERIDADE_DA_CLASSE[classe],
    canal: CANAL_AVISO.shopee,
    // Structured params, never a rendered sentence: the pt-BR wording around
    // them lives in `apps/web/lib/avisos/mensagens.ts`.
    params: { pedido: e.orderSn, situacao: fraseDoDespachoPendente(motivo) },
    motivo,
    // ⚠️ The CHECKOUT, not the pedido form: its save emits the NF-e, prints the
    // DANFE and fetches the label — the whole remedy (R-l).
    urlInterna: { rota: ROTAS_AVISO.despachoCheckout.build(e.pedidoId), campo: null },
  };
}

/** The print row's plano: `params` EXACTLY `{ pedido }`, no motivo. */
function planoEtiquetaComPrazo(e: EntradaArranjoAutomatico) {
  return {
    ...identidadeEtiqueta(e.integracaoId, e.pedidoId),
    severidade: SEVERIDADE_AVISO.atencao,
    canal: CANAL_AVISO.shopee,
    params: { pedido: e.orderSn },
    urlInterna: { rota: ROTAS_AVISO.despachoCheckout.build(e.pedidoId), campo: null },
  };
}

/** Whether a write left a row open that was not open before. */
function abriu(resultado: ResultadoAviso): boolean {
  return resultado === 'criado' || resultado === 'reaberto';
}

/**
 * Run the table's effects, in order, one awaited write at a time.
 *
 * Both counters count TRANSITIONS: `abertos` the rows this call created or
 * reopened (a repeat bumps `ocorrencias` and is not one), `resolvidos` the rows
 * this call closed (`resolverAviso`'s contract). An empty list makes ZERO reads
 * and ZERO writes.
 *
 * A Firestore failure PROPAGATES (no catch): the hook calls this OUTSIDE its
 * own catch, so a gRPC failure becomes the delivery's throw and the queue
 * redelivers — which is what re-raises the print alert after an irreversible
 * ship (R-b, R-j).
 */
export async function executarAcoesDeAvisoDoDespacho(
  db: Firestore,
  e: EntradaArranjoAutomatico,
  acoes: readonly AcaoDeAvisoDespacho[],
  deps: AvisoDeps,
): Promise<{ abertos: number; resolvidos: number }> {
  let abertos = 0;
  let resolvidos = 0;
  for (const acao of acoes) {
    switch (acao.tipo) {
      case 'abrir-despacho': {
        const { resultado } = await escreverAviso(
          db,
          planoDespachoPendente(e, acao.classe, acao.motivo),
          depsDeEscrita(deps),
        );
        if (abriu(resultado)) abertos += 1;
        break;
      }
      case 'resolver-despacho': {
        const chave = chaveAvisoDespachoPendente(
          e.integracaoId,
          e.pedidoId,
          e.packageNumber,
          acao.classe,
        );
        if (await resolverAviso(db, chave, acao.resolucao, { agoraUs: agoraUsDe(deps) })) {
          resolvidos += 1;
        }
        break;
      }
      case 'abrir-etiqueta': {
        const { resultado } = await escreverAviso(
          db,
          planoEtiquetaComPrazo(e),
          depsDeEscrita(deps),
        );
        if (abriu(resultado)) abertos += 1;
        break;
      }
      case 'resolver-etiqueta': {
        const chave = chaveAvisoEtiquetaComPrazo(e.integracaoId, e.pedidoId);
        if (await resolverAviso(db, chave, acao.resolucao, { agoraUs: agoraUsDe(deps) })) {
          resolvidos += 1;
        }
        break;
      }
      default: {
        const nunca: never = acao;
        return nunca;
      }
    }
  }
  return { abertos, resolvidos };
}

/**
 * The hook's default `avisar`: the table, then the executor, with the
 * occurrence sentinel this runtime import exists for and the task's own clock
 * read (`e.nowMs`) — never a second one.
 */
export const avisarArranjoAutomatico: AvisadorDeArranjo = async (db, e, r) => {
  await executarAcoesDeAvisoDoDespacho(db, e, acoesDeAvisoDoDespacho(e, r), {
    increment: (by) => FieldValue.increment(by),
    nowMs: e.nowMs,
  });
};

/* -------------------------------------------------------------------------- */
/*                            the cross-step resolver                          */
/* -------------------------------------------------------------------------- */

/** What a caller of the step-7 frete write observed, after it returned. */
export interface EncerramentoDespachoShopee {
  readonly integracaoId: string;
  readonly pedidoId: string;
  /**
   * `freteTx`'s `estadoConfirmado` — the block estado the channel's own package
   * diary corroborates, handed over on a replay too (the `nfe/avisoNfe.ts`
   * reasoning: a delivery whose resolve failed must retry it).
   */
  readonly estadoConfirmado: EstadoFrete | null;
  /** `order_status` verbatim, or `null` on the push path (no order row). */
  readonly orderStatus: string | null;
  /** The packages THIS delivery observed. */
  readonly pacotes: readonly Pick<
    PacoteObservadoShopee,
    'packageNumber' | 'fulfillmentStatus' | 'logisticsChannelId'
  >[];
}

/**
 * A dispatch row's closing fact, from ONE package's own wire token (never the
 * diary fold: a per-package row has per-package truth): moved past the
 * arrange ⇒ `arranjado`; cancelled / failed before the goods left ⇒
 * `envio-encerrado`; else an order Shopee reports CANCELLED ⇒
 * `pedido-cancelado`. `IN_CANCEL` is deliberately not it: a cancellation
 * request can still be refused, and the order then ships.
 */
function resolucaoDoPacote(
  token: string | null,
  pedidoCancelado: boolean,
): ResolucaoAvisoDespacho | null {
  const fase = faseDoTokenShopee(token);
  if (fase === 'arranjado' || fase === 'janela-fechada') return RESOLUCAO_AVISO_DESPACHO.arranjado;
  if (fase === 'inelegivel') return RESOLUCAO_AVISO_DESPACHO.envioEncerrado;
  return pedidoCancelado ? RESOLUCAO_AVISO_DESPACHO.pedidoCancelado : null;
}

/** The print row's closing fact: the goods collected, or the shipment cancelled. */
function resolucaoDaEtiqueta(
  estado: EstadoFrete | null,
  pedidoCancelado: boolean,
): ResolucaoAvisoDespacho | null {
  if (estado !== null && ESTADOS_FRETE_POS_COLETA_SHOPEE.has(estado)) {
    return RESOLUCAO_AVISO_DESPACHO.coletado;
  }
  if ((estado !== null && ESTADOS_FRETE_CANCELADO_SHOPEE.has(estado)) || pedidoCancelado) {
    return RESOLUCAO_AVISO_DESPACHO.pedidoCancelado;
  }
  return null;
}

/**
 * The cross-step resolver: does what steps 5 and 7 just observed end a
 * dispatch or print row of this pedido? If so, close it.
 *
 * - **The channel gate comes FIRST.** Only packages on an auto-arrange channel
 *   are considered for the dispatch rows, and the print row only when some
 *   observed package is on a print-deadline channel. Every other pedido — every
 *   Shopee Xpress order, which is every Delfrance order today — costs ZERO
 *   reads.
 * - Per auto-arrange package, {@link resolucaoDoPacote} closes BOTH classes
 *   (two reads); the print row closes on {@link ESTADOS_FRETE_POS_COLETA_SHOPEE}
 *   (`coletado`) or a cancelled shipment or order (`pedido-cancelado`).
 * - A package with nothing to close costs nothing: a pre-arrange delivery reads
 *   no aviso.
 *
 * It only RESOLVES — opening lives in the hook alone — so it is a correct
 * observation on every path, `rastrear:pedido --live` included.
 *
 * Called OUTSIDE the frete write, after it committed. A Firestore failure here
 * PROPAGATES (no catch): both deliveries that call it are idempotent, so the
 * queue redelivers, the frete comes back `ignorado-sem-mudanca` with the
 * confirmed estado still handed over, and the retry tries the resolve again.
 */
export async function resolverAvisosDeDespachoSeEncerrado(
  db: Firestore,
  obs: EncerramentoDespachoShopee,
  deps: Pick<AvisoDeps, 'nowMs'>,
): Promise<{ readonly despachoResolvidos: number; readonly etiquetaResolvida: boolean }> {
  const doArranjo = obs.pacotes.filter((p) => ehCanalDeArranjoAutomatico(p.logisticsChannelId));
  const comPrazo = obs.pacotes.some((p) => ehCanalDeEtiquetaComPrazo(p.logisticsChannelId));
  const pedidoCancelado = obs.orderStatus === SHOPEE_ORDER_STATUS.cancelled;
  const agora = { agoraUs: agoraUsDe(deps) };

  let despachoResolvidos = 0;
  for (const pacote of doArranjo) {
    const resolucao = resolucaoDoPacote(pacote.fulfillmentStatus, pedidoCancelado);
    if (resolucao === null) continue;
    for (const classe of CLASSES) {
      const chave = chaveAvisoDespachoPendente(
        obs.integracaoId,
        obs.pedidoId,
        pacote.packageNumber,
        classe,
      );
      if (await resolverAviso(db, chave, resolucao, agora)) despachoResolvidos += 1;
    }
  }

  const resolucaoEtiqueta = comPrazo
    ? resolucaoDaEtiqueta(obs.estadoConfirmado, pedidoCancelado)
    : null;
  const etiquetaResolvida =
    resolucaoEtiqueta !== null &&
    (await resolverAviso(
      db,
      chaveAvisoEtiquetaComPrazo(obs.integracaoId, obs.pedidoId),
      resolucaoEtiqueta,
      agora,
    ));

  return { despachoResolvidos, etiquetaResolvida };
}
