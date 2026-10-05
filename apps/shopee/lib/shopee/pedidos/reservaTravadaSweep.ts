/**
 * The Shopee **stuck-reservation sweep** (master-plan step 8, #1516) — the
 * WEEKLY backstop behind every event-driven release of a stock reservation.
 *
 * Step 5 imports an `UNPAID`/`PENDING` order as
 * `aguardandoConfirmacaoDePagamento`, which is in `ESTADOS_PEDIDO_RESERVA`
 * (`packages/schemas/src/pedido/pureLogic/estoque.ts`): the unit is held ON
 * PURPOSE, and the release is the `CANCELLED` push travelling through step 5's
 * ladder. This module exists for the four populations where that push never
 * arrives:
 *
 *  1. a push subscription Shopee SUSPENDED — "you will not receive Push
 *     Mechanism notifications missed during the period where your subscription
 *     was disabled", so those are never resent at all;
 *  2. anything older than the lost-push queue, which is 3 days;
 *  3. the silent `UNPAID → PENDING` transition, which fires NO push
 *     (`announcement 682` §4 Q1) — the promised one has never shipped
 *     (settle-live register item 41);
 *  4. everything, while `SHOPEE_ORDER_BACKFILL_ENABLED` ships OFF — and even
 *     with it on, its `get_order_list` window is 15 days on `update_time`,
 *     which cannot reach an order whose `update_time` stopped moving.
 *
 * ## It never writes the pedido, and it runs no transaction
 *
 * Five reasons, and they are the design rather than a caution:
 *
 *  1. **`pedido.estado` has exactly ONE writer on this channel — step 5.** A
 *     second one would give a stuck reservation's release null attribution: no
 *     `historicoEstadoPedido` author, no wire delivery behind it, nothing to
 *     reconcile against. Root rule 7's "decide what happens when yours is the
 *     loser" is answered here by not entering the race.
 *  2. **The ladder is self-healing.** A candidate whose order MOVED is handed
 *     back to step 5 as a synthetic code 3, and step 5 re-reads
 *     `get_order_detail`, re-derives the estado from its own snapshot and
 *     watermarks on its own `update_time`. The release we want is the release
 *     step 5 already knows how to perform.
 *  3. **No transaction ⇒ no inventory entry, and the transaction API's
 *     identifier is never named here.** That guard greps raw TEXT over every
 *     source file, so even a comment naming the method would demand an
 *     inventory line for a module that runs none. (Said this way on purpose —
 *     `notificacoes/orderBackfill.ts` says it the same way, for the same
 *     reason.)
 *  4. **The read IS the instrument.** Whether Shopee auto-cancels an unpaid BR
 *     order — and after how long — is stated by NO page in the cached corpus
 *     (register item 37), and this tick's counters plus its three zero-call
 *     diagnostic tables are the only way anyone will find out. A sweep that
 *     acted on the premise would be asserting the very thing it exists to
 *     measure.
 *  5. **Never enqueue for an order Shopee no longer knows.** The code-3 arm
 *     PARKS an `order_not_found` as a terminal dead-letter row whose doc id
 *     carries the tick's clock, so a re-driver would write one new parked
 *     document per candidate per week, for ever, and release nothing.
 *
 * ## The residual policy
 *
 * A candidate the sweep cannot decide raises an **aviso**
 * (`TIPO_AVISO.pedidoPrecisaDecisao`, `avisos/reservaTravada.ts`) and nothing
 * else: `ainda-nao-pago`, `pendente-pago`, `inexistente` and
 * `manter-devolucao`. Everything else is a counter and a log line. The two
 * in-line resolves are `interacao-humana` and `pagamento-aprovado` — and ONLY
 * those two, because `escreverAviso` takes its REOPEN branch on a re-raise and
 * stamps a fresh `criadoEm`, so resolving on "we enqueued" (which has no
 * feedback channel) or on a rate limit (which is the ABSENCE of an
 * observation) would close a live aviso and re-alert next week about a problem
 * that never went away. ⚠️ The price of that choice, stated rather than left
 * implicit: a genuinely-fixed pedido keeps its aviso for one extra week, until
 * pass (b) OBSERVES that it left the candidate set. Observing the fix is worth
 * more than guessing it.
 *
 * ## The flags, and the paired assertion
 *
 *  - `SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED` — the master flag, strict `=== '1'`.
 *    Off ⇒ NOTHING is read, from Firestore or from Shopee.
 *  - `SHOPEE_PEDIDO_TRAVADO_DRY_RUN` — report-only.
 *  - `SHOPEE_PEDIDO_TRAVADO_MAX_IDADE_D` — the horizon, default 7.
 *
 * Both flags are read BEFORE the early return, so a disabled tick still
 * reports `dryRun` HONESTLY — the Mercado Livre sweep reads its dry-run env
 * after its early return and therefore tells an operator who set the rehearsal
 * flag and forgot the master one that the rehearsal is off.
 *
 * ⚠️ `ignorarFlagMestra` WITHOUT `dryRun` throws `ShopeeConfigError`. The
 * rehearsal exists to decide whether to turn the master flag ON, so it must be
 * runnable while that flag is off — and it must be structurally incapable of
 * writing while that flag is off. Only the CLI supplies either.
 *
 * ## The dry-run boundary — exactly two effects
 *
 * `scheduler.enqueue`, and the aviso writes/resolves. Everything else happens
 * in both modes: the candidate page, the gates, the pagamento reads, the
 * BATCHED Shopee read, every verdict, the three diagnostic tables and pass
 * (b)'s query and pedido reads. Every verdict is decided on the same side of
 * that boundary in both modes, which is what makes the dry run an instrument
 * instead of a rehearsal of the plumbing.
 *
 * ## The data-scanned bound
 *
 * {@link MAX_PAGINAS} × {@link PAGE_LIMIT} = 2 000 pedido documents scanned per
 * weekly tick, plus one whole `pagamentos` subcollection read per candidate
 * (≤ 200), plus ⌈200/50⌉ = 4 batched `get_order_detail` calls per conta — up to
 * 204 when every batch falls back — plus ≤ 200 enqueues and aviso round trips,
 * plus one avisos page of 200 and up to 200 pedido reads in pass (b). On
 * Enterprise an unindexed query does not throw; it full-scans and bills the
 * scan (root rule 1), so both queries here ride indexes that already exist and
 * the test file proves it with `deriveRequiredIndex`.
 *
 * ## ⚠️ The batch semantics of a bad `order_sn` — a DATED SANDBOX OBSERVATION
 *
 * Measured 2026-09-15 on the SG sandbox shop, three read-only calls: a list of
 * one known `order_sn` answered one row; a list of one known plus one
 * fabricated answered ONE row with the unknown one simply OMITTED, no envelope
 * `error` and `warning: null`; a list of only the fabricated one answered the
 * envelope error `error_not_found` (HTTP 200, kind `other`). So on that shop a
 * MIXED batch omits the unknown row and the error fires only when EVERY
 * `order_sn` of the call is unknown. That is an observation on one sandbox
 * shop on one day — **not** something any Shopee page documents, and the page's
 * own Error example plus `faq 192` case 3 read the other way. Both arms
 * therefore stay: the absent row is handled by reconciling on `order_sn`, and
 * a batch-level `error_not_found` falls back to per-order calls, which under
 * the measured behaviour costs N extra calls only when all N are unknown.
 *
 * ## Settle-live register items this tick instruments
 *
 * 37 (does Shopee auto-cancel an unpaid BR order — the three diagnostic tables
 * beside the live verdicts), 38 (the batch `error_not_found` arms above), 39
 * (`pay_time` `0` vs `null`, made moot by the classifier's fold and defended by
 * the test on {@link CAMPOS_OPCIONAIS_RESERVA_TRAVADA}), 42 (does a re-drive
 * LAND — partially, through {@link ReservaTravadaSweepResult.redriveAparentementeNaoAplicado}),
 * 43 (an `order_status` the ladder does not model — printed, never acted on),
 * 45 (the non-Shopee stale population — `naoMarketplace` beside `candidatos`
 * and `truncado`), 46 (`warning` on `get_order_detail` — see the note on the
 * batch loop: only the FAILURE-path warning is reachable from here).
 *
 * ## Units — µs **SITE 8**
 *
 * `deps.nowMs` is the ONLY clock, and `millisToMicros(deps.nowMs)` is the
 * single conversion of this path — item 2's pattern exactly, one clock read
 * handed DOWN as `nowUs`, from which the candidate cutoff and every
 * verdict-side age derive. It converts nothing else. On the STORED side it
 * coerces `timestamp` and `marketplace.statusEm` through `coerceToMicros`,
 * because the migrated Shopee corpus really does hold millisecond ints — which
 * is the OPPOSITE rule from a Shopee WIRE value, and the reason both are
 * numbered. **NO wire value is converted here at all**: `pay_time` is folded to
 * a BOOLEAN by `reservaTravadaMapping.ts` and discarded, and the aviso writes
 * funnel through site 1's `agoraUsDe`.
 *
 * ⚠️ `timestamp` is µs while the migrated corpus holds MILLISECONDS, and no
 * coercion can reach a server-side filter — so nothing here fixes that, and
 * nothing needs to: a ms stamp (~1.7e12) is below any µs cutoff (~1.75e15), so
 * a legacy row satisfies `timestamp < cutoffUs` BY CONSTRUCTION and always
 * sorts LAST under `DESC`. The filter over-matches in the SAFE direction, and
 * the verdict-side age is honest because `idadeEmDias` reads the stored stamp
 * through `coerceToMicros`. What a legacy row is not is EARLY in the page,
 * which is exactly why the paging loop exists.
 */
import type { Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { coerceToMicros, millisToMicros } from '@delfrance/core/datetime';
import {
  avisoCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  CANAL_AVISO,
  ESTADO_PEDIDO,
  STATUS_PAGAMENTO,
  TIPO_AVISO,
  type EstadoPedido,
} from '@delfrance/schemas';
import {
  SHOPEE_ORDER_DETAIL_MAX_ORDER_SN,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  type ShopeeClient,
  type ShopeeOrderDetail,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

import {
  MOTIVO_RESOLUCAO_RESERVA_TRAVADA,
  avisarReservaTravada,
  chaveReservaTravada,
  pedidoIdDaChaveReservaTravada,
  resolverReservaTravada,
  type EventoReservaTravada,
  type MotivoResolucaoReservaTravada,
  type VereditoQueAvisa,
} from '../avisos/reservaTravada';
import { listarContasShopeeAtivas } from '../core/contas';
import { erroContidoPorConta } from '../core/containment';
import { loadShopeeContext } from '../core/shopee';
import { dedupKeyOf } from '../notificacoes/notificacao';
import { notificacaoSinteticaDePedido } from '../notificacoes/notificacaoSintetica';
import {
  CODIGOS_PEDIDO_INEXISTENTE,
  DIA_US,
  VEREDITO_RESERVA_TRAVADA,
  VEREDITOS_QUE_AVISAM,
  VEREDITOS_RESERVA_TRAVADA,
  classificarReservaTravada,
  idadeEmDias,
  provaDeIdentidadeShopee,
  type ClassificacaoReservaTravada,
  type VereditoReservaTravada,
} from './reservaTravadaMapping';
import {
  ShopeeTasksDisabledError,
  shopeeTasksDesabilitado,
  type ShopeeTaskScheduler,
} from '../shopeeTasks';

/* -------------------------------------------------------------------------- */
/*                                  the flags                                  */
/* -------------------------------------------------------------------------- */

/** The master flag. Strict `=== '1'`: unset, blank and `true` all leave it OFF. */
export const RESERVA_TRAVADA_FLAG_ENV = 'SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED';

/** Report-only: everything is read and decided, the two effects are skipped. */
export const RESERVA_TRAVADA_DRY_RUN_ENV = 'SHOPEE_PEDIDO_TRAVADO_DRY_RUN';

/** How many days a pedido may hold the reservation before the tick examines it. */
export const RESERVA_TRAVADA_MAX_IDADE_ENV = 'SHOPEE_PEDIDO_TRAVADO_MAX_IDADE_D';

/**
 * The horizon in whole days, from the environment.
 *
 * ⚠️ The EFFECTIVE age is 7–14 days at the default: the schedule is weekly, so
 * a pedido that goes stale just after a tick waits for the next one. Nothing
 * may document "7" as a promise.
 */
export function reservaTravadaMaxIdadeDias(): number {
  const bruto = Number(process.env[RESERVA_TRAVADA_MAX_IDADE_ENV]);
  return Number.isFinite(bruto) && bruto > 0 ? bruto : 7;
}

/* -------------------------------------------------------------------------- */
/*                                   bounds                                    */
/* -------------------------------------------------------------------------- */

/** Candidate rows per PAGE of the candidate query. */
export const PAGE_LIMIT = 200;

/** Pages per tick ⇒ at most {@link PAGE_LIMIT} × this many documents SCANNED. */
export const MAX_PAGINAS = 10;

/** Shopee candidates collected per tick, across pages. */
export const MAX_CANDIDATOS = 200;

/** Rows of the open-avisos page pass (b) reconciles. One page, no cursor. */
export const RECONCILIACAO_PAGINA = 200;

/**
 * `order_sn` per `get_order_detail` call — DERIVED from the package, never
 * re-typed: `api.ts` is where the bound lives and where it is enforced BEFORE
 * the fetch.
 */
export const LOTE_ORDER_DETAIL = SHOPEE_ORDER_DETAIL_MAX_ORDER_SN;

/**
 * The MINIMAL `response_optional_fields` allow-list, and every absence in it is
 * deliberate.
 *
 * ⚠️ The caller's list **REPLACES** the package's 24-token default; it never
 * merges. An optional field that is not named comes back ABSENT — which for
 * `pay_time` would read as "unpaid" — so the test that asserts this literal is
 * the real defence, not a type.
 *
 * What is NOT here, and why:
 *  - `order_status` and `update_time` are BASE fields and arrive unasked. They
 *    are also absent from the page's available-values list, so NAMING one risks
 *    `error_param`.
 *  - `pending_terms` is gated by the `request_order_status_pending` FLAG, not by
 *    this list, so narrowing the list never drops it — and naming it is the
 *    same `error_param` risk.
 *  - `buyer_cancel_reason` is buyer-authored free text. `cancel_by` /
 *    `cancel_reason` are Shopee's own vocabulary and are the observable for
 *    register item 37; the buyer's words are not ours to carry.
 *  - no `item_list`, `recipient_address`, `buyer_cpf_id`, `buyer_username`,
 *    `buyer_user_id`, `invoice_data`, `payment_info`. **This sweep has no PII
 *    on its wire at all**, which is what makes the console-spy test a
 *    structural claim rather than a promise.
 */
export const CAMPOS_OPCIONAIS_RESERVA_TRAVADA: readonly string[] = [
  'pay_time',
  'cancel_by',
  'cancel_reason',
];

/**
 * The estados a candidate may hold — exactly ONE, and the `in` is deliberate.
 *
 * `ESTADOS_PEDIDO_RESERVA` has five members and step 5's ladder writes only
 * this one among them: that importer never writes `emAnalise`,
 * `emProcessamento`, `estornado*`, `fraude`, `finalizado` or
 * `pagamentoNaoRealizado`, and `escolhendoFormaDePagamento` has no rung at all.
 * `pago` IS in the reserve set and is deliberately excluded: it is a LIVE sale
 * awaiting dispatch, not a leak.
 *
 * ⚠️ `in` with a ONE-element array, never a bare `==`. The declared composite is
 * `pedidos (ehSaida ASC, estado ASC, timestamp DESC)`; a bare `==` is a
 * different index SHAPE, and on Enterprise the wrong shape does not throw — it
 * full-scans and bills the scan (root rule 1).
 */
export const ESTADOS_RESERVA_TRAVADA_SHOPEE: readonly EstadoPedido[] = [
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
];

/* -------------------------------------------------------------------------- */
/*                                  motivos                                    */
/* -------------------------------------------------------------------------- */

export const MOTIVO_FLAG_DESLIGADA = 'flag-desligada';
export const MOTIVO_SEM_SHOP_ID =
  'conta conectada por conta principal (sem shop_id) — nada a consultar';
export const MOTIVO_CONTA_ABORTADA =
  'limite de chamadas ou autorização morta — conta abortada sem nova tentativa';
export const MOTIVO_SEM_CANDIDATOS = 'nenhum candidato nesta conta';

/** What an unset / unreadable `marketplace.status` is called in the tables. */
export const STATUS_ARMAZENADO_AUSENTE = '(sem-status)';

/* -------------------------------------------------------------------------- */
/*                              the result shape                               */
/* -------------------------------------------------------------------------- */

/** Age buckets for the stored `marketplace.statusEm`, in whole days. */
export type BucketIdade = '7-14' | '14-30' | '30-60' | '60-90' | '90+';

/** Every bucket, in reading order — the zero-seed for the age tables. */
export const BUCKETS_IDADE: readonly BucketIdade[] = ['7-14', '14-30', '30-60', '60-90', '90+'];

export interface ReservaTravadaLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * ONE candidate, as the tick saw it at the instant its verdict became final.
 *
 * ⚠️ **The tick's own result carries counters and nothing else, on purpose** —
 * a weekly unattended function has no business accumulating a per-document
 * array it will only log. This is the seam for the ONE consumer that needs the
 * detail: `varrer:reservas`, the rehearsal CLI, whose whole job is to produce
 * the cross-tab that answers register item 37 (does Shopee auto-cancel an
 * unpaid BR order, after how long, with which `cancel_by`/`cancel_reason`).
 *
 * ⚠️ **Twelve fields, an ALLOW-LIST, and the count is pinned by a test** —
 * `varrerReservasCli.ts`'s `CAMPOS_RESUMO_RESERVA_TRAVADA`. The row is built
 * FIELD BY FIELD from the candidate, the classification and the two cancel
 * columns of the wire row; the wire row itself never leaves {@link
 * runReservaTravadaSweep}, so no buyer datum has a field to travel in — and
 * `buyer_cancel_reason` (the buyer's own words) is not even requested, see
 * {@link CAMPOS_OPCIONAIS_RESERVA_TRAVADA}.
 *
 * ⚠️ `temPayTime` is a BOOLEAN: the stamp itself never leaves the sweep, and it
 * is the only pre-payment signal Shopee documents, folded once by
 * `classificarReservaTravada`.
 */
export interface CandidatoObservado {
  readonly pedidoId: string;
  readonly integracaoId: string;
  /** `pedido.numero` — Shopee's own `order_sn`, proved by the id digest. */
  readonly orderSn: string;
  /** The FINAL verdict, including a `tasks-desabilitado` substituted for a re-drive. */
  readonly veredito: VereditoReservaTravada;
  /** Shopee's live token, verbatim. `null` when no row was read. */
  readonly orderStatus: string | null;
  readonly pendingTerms: readonly string[] | null;
  /** ⚠️ A BOOLEAN. The `pay_time` value never leaves the sweep. */
  readonly temPayTime: boolean;
  /**
   * Whole days the pedido has held the reservation.
   *
   * ⚠️ Declared nullable because the CONTRACT is nullable — a `timestamp` that
   * will not coerce has no honest age. This tick can only ever emit a number:
   * such a pedido is counted `naoMarketplace` at gate 1 and never becomes a
   * candidate at all.
   */
  readonly idadeDias: number | null;
  /** `buyer | seller | system | Ops` — a string, never an enum (E1 A9). */
  readonly cancelBy: string | null;
  /** Shopee's token. ⚠️ Observed samples sit outside every documented list — never branch on it. */
  readonly cancelReason: string | null;
  /** Would a live tick with an open queue have enqueued the code-3 re-drive? */
  readonly enfileiraria: boolean;
  /** Would a live tick have written an aviso? */
  readonly avisaria: boolean;
}

/**
 * The half of {@link CandidatoObservado} that only a READ row can supply.
 *
 * Everything else is on the candidate or is derived from the verdict, so a call
 * site that observed nothing (a gate, an unanswered read) passes {@link
 * DETALHE_NAO_LIDO} and cannot accidentally invent a status.
 */
interface DetalheObservado {
  readonly orderStatus: string | null;
  readonly pendingTerms: readonly string[] | null;
  readonly temPayTime: boolean;
  readonly cancelBy: string | null;
  readonly cancelReason: string | null;
  readonly enfileiraria: boolean;
}

/** No row was read: every wire-derived field is absent, and nothing would be enqueued. */
const DETALHE_NAO_LIDO: DetalheObservado = {
  orderStatus: null,
  pendingTerms: null,
  temPayTime: false,
  cancelBy: null,
  cancelReason: null,
  enfileiraria: false,
};

export interface ReservaTravadaSweepDeps {
  readonly scheduler: ShopeeTaskScheduler;
  /** ONE clock read for the whole tick, MILLISECONDS. Never re-read in here. */
  readonly nowMs: number;
  /** `(by) => FieldValue.increment(by)` — the aviso occurrence sentinel. */
  readonly increment: (by: number) => unknown;
  readonly logger?: ReservaTravadaLogger;
  /**
   * The client seam — ONE thing, because one thing is all the sweep needs from
   * a conta's context. Default: `loadShopeeContext(db, id).createShopClient()`.
   */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
  /** CLI scope: run only these integrações. */
  readonly apenasIntegracoes?: readonly string[];
  /** CLI: force report-only regardless of the environment. */
  readonly forcarDryRun?: boolean;
  /**
   * CLI: run with the master flag OFF. ⚠️ Paired — without `forcarDryRun` (or
   * the dry-run env) it throws, so the rehearsal can never write before the
   * flag a human has to flip.
   */
  readonly ignorarFlagMestra?: boolean;
  /**
   * CLI: observe every candidate, EXACTLY ONCE, as its verdict becomes final.
   *
   * ⚠️ Exactly-once is STRUCTURAL rather than a promise: the call sits inside
   * the one function that records a verdict, and `Σ veredictos === candidatos`
   * is asserted over every fixture that produces a candidate. A candidate that
   * grew a second verdict would break that invariant first.
   *
   * ⚠️ **A throw inside the callback is the CALLER's problem.** It is not
   * caught into `erros[]` and it is not contained per conta: this is a
   * diagnostic seam only the rehearsal supplies, so a failure in it is a bug in
   * the rehearsal, and swallowing it would make the CLI silently drop rows from
   * the very cross-tab it exists to build. The scheduled tick supplies none.
   */
  readonly onCandidato?: (c: CandidatoObservado) => void;
}

export interface ReservaTravadaContaResult {
  readonly integracaoId: string;
  readonly shopId: number | null;
  /** `null` ⇒ processed; a named reason ⇒ skipped or aborted mid-tick. */
  readonly pulada: string | null;
  readonly candidatos: number;
  readonly lotes: number;
  readonly lotesComFallback: number;
  /** `get_order_detail` calls ISSUED — batched plus fallback, failures included. */
  readonly chamadas: number;
  readonly enfileirados: number;
  readonly avisosEscritos: number;
  readonly avisosResolvidos: number;
  readonly veredictos: Record<VereditoReservaTravada, number>;
  /**
   * The RAW `error` code Shopee answered, counted per spelling. Both live in
   * `CODIGOS_PEDIDO_INEXISTENTE` and both fold to ONE `motivoInexistente`, so
   * this is the only place the two stay distinguishable — which is what makes
   * register item 38 readable from a log line rather than from a guess.
   */
  readonly codigosInexistente: Record<string, number>;
  readonly error: string | null;
}

export interface ReservaTravadaSweepResult {
  readonly enabled: boolean;
  /** Honest in BOTH branches — including the flag-off one. */
  readonly dryRun: boolean;
  /** Why the tick did not run (`null` when it did). */
  readonly motivo: string | null;
  readonly tasksDesabilitado: boolean;
  readonly maxIdadeDias: number;
  readonly cutoffUs: number;
  /** Rows the candidate query RETURNED, across pages. */
  readonly examinados: number;
  readonly paginas: number;
  /* ⚠️ The five gate-1 counters below are never summed with `candidatos`. */
  readonly naoMarketplace: number;
  readonly adotado: number;
  readonly contaInativa: number;
  readonly foraDoEscopo: number;
  /** ACTIVE contas skipped for having no `shop_id` — counted, never written. */
  readonly semShopId: number;
  readonly candidatos: number;
  readonly truncado: boolean;
  /** Per-verdict, NEVER a single total. Zero-valued arms are PRESENT. */
  readonly veredictos: Record<VereditoReservaTravada, number>;
  /** Rows the open-avisos page of pass (b) actually carried. */
  readonly avisosVarridos: number;
  /** Avisos this tick CLOSED — the transition, not the lookups. */
  readonly reconciliados: number;
  readonly reconciliacaoTruncada: boolean;
  /**
   * The stored `marketplace.status` already equalled the LIVE `order_status` on
   * a `redirecionado-*` classification: a delivery was accepted and applied
   * (that block is written on every accepted delivery, in its own group) while
   * the estado still did not move. Costs no read — the field is already in hand
   * — and it is the only in-repo evidence available about register item 42.
   */
  readonly redriveAparentementeNaoAplicado: number;
  /** `marketplace.status` verbatim → count, over the candidates. Zero calls. */
  readonly statusArmazenado: Record<string, number>;
  readonly idadeStatusDias: Record<BucketIdade, number>;
  readonly statusPorIdade: Record<string, Record<BucketIdade, number>>;
  readonly statusArmazenadoPorVeredito: Record<string, Record<VereditoReservaTravada, number>>;
  readonly contas: readonly ReservaTravadaContaResult[];
  readonly erros: readonly { pedidoId: string; message: string }[];
}

/* -------------------------------------------------------------------------- */
/*                                  helpers                                    */
/* -------------------------------------------------------------------------- */

function loggerDe(deps: ReservaTravadaSweepDeps): ReservaTravadaLogger {
  return (
    deps.logger ?? {
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        if (meta === undefined) console.warn(msg);
        else console.warn(msg, meta);
      },
    }
  );
}

/** A total counter map over the verdict union — zero-valued arms PRESENT. */
function zerarVeredictos(): Record<VereditoReservaTravada, number> {
  const saida = {} as Record<VereditoReservaTravada, number>;
  for (const v of VEREDITOS_RESERVA_TRAVADA) saida[v] = 0;
  return saida;
}

function zerarBuckets(): Record<BucketIdade, number> {
  const saida = {} as Record<BucketIdade, number>;
  for (const b of BUCKETS_IDADE) saida[b] = 0;
  return saida;
}

/**
 * The bucket one age in whole days falls in. The lowest bucket is named `7-14`
 * because the default horizon is 7 days and the schedule is weekly; a shorter
 * `MAX_IDADE_D` puts younger rows there too, which the label understates rather
 * than misreports.
 */
function bucketDaIdade(dias: number): BucketIdade {
  if (dias < 14) return '7-14';
  if (dias < 30) return '14-30';
  if (dias < 60) return '30-60';
  if (dias < 90) return '60-90';
  return '90+';
}

function bloco(raw: Record<string, unknown>, chave: string): Record<string, unknown> | null {
  const v = raw[chave];
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** `marketplace.tipo`, or `null`. The unindexed positive marker no editor writes. */
function tipoMarketplace(raw: Record<string, unknown>): string | null {
  const v = bloco(raw, 'marketplace')?.tipo;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** `marketplace.status` verbatim. An unknown token is DATA, never a throw. */
function statusArmazenadoDe(raw: Record<string, unknown>): string {
  const v = bloco(raw, 'marketplace')?.status;
  return typeof v === 'string' && v.length > 0 ? v : STATUS_ARMAZENADO_AUSENTE;
}

function estadoArmazenado(raw: Record<string, unknown>): string | null {
  const v = raw.estado;
  return typeof v === 'string' ? v : null;
}

/**
 * Is the stored estado still one the CANDIDATE QUERY would return?
 *
 * ⚠️ MEMBERSHIP of {@link ESTADOS_RESERVA_TRAVADA_SHOPEE}, never a re-spelled
 * literal. Pass (b) and the candidate query have to answer the same question,
 * and the query is built from that constant — so a second member added there
 * must reach here too. It would otherwise make pass (b) resolve
 * `estado-saiu-do-conjunto` for pedidos that are STILL candidates: an
 * unrecoverable write on a `serverOwned` collection, and exactly the
 * two-copies-drifting-toward-plausible shape the root `CLAUDE.md` calls out.
 *
 * A missing or non-string `estado` is not a member, so it reads as "left the
 * set" — the pre-existing behaviour, and the safe direction: the candidate
 * query cannot return such a pedido either.
 */
function ehEstadoDeReservaTravada(estado: string | null): boolean {
  if (estado === null) return false;
  const declarados: readonly string[] = ESTADOS_RESERVA_TRAVADA_SHOPEE;
  return declarados.includes(estado);
}

function lotesDe<T>(itens: readonly T[], tamanho: number): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) saida.push(itens.slice(i, i + tamanho));
  return saida;
}

/** One candidate: a pedido this channel PROVED it owns, past the horizon. */
interface Candidato {
  readonly pedidoId: string;
  readonly contaId: string;
  /** `pedido.numero`, which on this channel IS the `order_sn`, fill-once. */
  readonly orderSn: string;
  readonly idadeDias: number;
  readonly statusArmazenado: string;
  /** The bucket of `marketplace.statusEm`, or `null` when it will not coerce. */
  readonly bucketStatus: BucketIdade | null;
  readonly raw: Record<string, unknown>;
}

/** The per-conta accumulator the loop mutates and the result row is built from. */
interface AcumuladorDaConta {
  lotes: number;
  lotesComFallback: number;
  chamadas: number;
  enfileirados: number;
  avisosEscritos: number;
  avisosResolvidos: number;
  readonly veredictos: Record<VereditoReservaTravada, number>;
  readonly codigosInexistente: Record<string, number>;
  pulada: string | null;
  error: string | null;
}

function novoAcumulador(): AcumuladorDaConta {
  return {
    lotes: 0,
    lotesComFallback: 0,
    chamadas: 0,
    enfileirados: 0,
    avisosEscritos: 0,
    avisosResolvidos: 0,
    veredictos: zerarVeredictos(),
    codigosInexistente: {},
    pulada: null,
    error: null,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   the tick                                  */
/* -------------------------------------------------------------------------- */

/**
 * One weekly tick: the paged candidate query, the gates, one batched Shopee
 * read per ≤ 50 candidates per conta, the two effects, and the reconciliation
 * pass over the open avisos.
 *
 * Invariant this function keeps true and the test asserts on every fixture:
 * **`Σ veredictos === candidatos`**. The gate-1 rejects are tick COUNTERS
 * beside `examinados` precisely so that holds — a page of 2 000 rows can yield
 * 1 800 `naoMarketplace`, and folding those in would make every real arm
 * unreadable and destroy the one assertion worth having.
 */
export async function runReservaTravadaSweep(
  db: Firestore,
  deps: ReservaTravadaSweepDeps,
): Promise<ReservaTravadaSweepResult> {
  // Both flags BEFORE the early return, so the disabled branch reports `dryRun`
  // honestly — the one log line an operator reads while setting the pair up.
  const dryRun = process.env[RESERVA_TRAVADA_DRY_RUN_ENV] === '1' || deps.forcarDryRun === true;
  const habilitado =
    process.env[RESERVA_TRAVADA_FLAG_ENV] === '1' || deps.ignorarFlagMestra === true;

  // The paired assertion: rehearse before the master flag, never WRITE before it.
  if (deps.ignorarFlagMestra === true && !dryRun) {
    throw new ShopeeConfigError(
      `ignorarFlagMestra exige um dry run: ${RESERVA_TRAVADA_FLAG_ENV} é a única porta para uma varredura que escreve.`,
    );
  }

  if (!habilitado) {
    return {
      enabled: false,
      dryRun,
      motivo: MOTIVO_FLAG_DESLIGADA,
      tasksDesabilitado: false,
      maxIdadeDias: 0,
      cutoffUs: 0,
      examinados: 0,
      paginas: 0,
      naoMarketplace: 0,
      adotado: 0,
      contaInativa: 0,
      foraDoEscopo: 0,
      semShopId: 0,
      candidatos: 0,
      truncado: false,
      veredictos: zerarVeredictos(),
      avisosVarridos: 0,
      reconciliados: 0,
      reconciliacaoTruncada: false,
      redriveAparentementeNaoAplicado: 0,
      statusArmazenado: {},
      idadeStatusDias: zerarBuckets(),
      statusPorIdade: {},
      statusArmazenadoPorVeredito: {},
      contas: [],
      erros: [],
    };
  }

  // ⚠️ A READ, after the enabled check and before the query, reported in BOTH
  // modes. Learning the valve is shut by CATCHING the disabled error could not
  // produce a verdict: the class is inside `erroContidoPorConta`, so it would
  // come out as one contained per-conta `lastError` with every candidate of
  // that conta skipped uncounted — and a dry run never reaches the enqueue at
  // all, so it could never reach the verdict by any catch.
  const tasksDesabilitado = shopeeTasksDesabilitado();

  const logger = loggerDe(deps);
  const maxIdadeDias = reservaTravadaMaxIdadeDias();
  const nowUs = millisToMicros(deps.nowMs);
  const cutoffUs = nowUs - maxIdadeDias * DIA_US;

  const escopo = deps.apenasIntegracoes === undefined ? null : new Set(deps.apenasIntegracoes);
  const ativas = await listarContasShopeeAtivas(db);
  const shopIdPorConta = new Map(ativas.map((c) => [c.integracaoId, c.shopId]));

  /* ---- tick-level counters ------------------------------------------------ */
  let examinados = 0;
  let paginas = 0;
  let naoMarketplace = 0;
  let adotado = 0;
  let contaInativa = 0;
  let foraDoEscopo = 0;
  let semShopId = 0;
  let truncado = false;
  let redriveAparentementeNaoAplicado = 0;
  const veredictos = zerarVeredictos();
  const statusArmazenado: Record<string, number> = {};
  const idadeStatusDias = zerarBuckets();
  const statusPorIdade: Record<string, Record<BucketIdade, number>> = {};
  const statusArmazenadoPorVeredito: Record<string, Record<VereditoReservaTravada, number>> = {};
  const erros: { pedidoId: string; message: string }[] = [];
  /** Chaves this tick raised or resolved — pass (b) leaves them alone. */
  const chavesTocadas = new Set<string>();
  /** Candidates that already carry a verdict — see {@link registrar}. */
  const registrados = new Set<string>();
  /** In-tick enqueue dedup, on the work identity rather than the document id. */
  const enfileiradosVistos = new Set<string>();

  /* ---- (1) the paged candidate query -------------------------------------- */
  //
  // ⚠️ The cursor is a DOC SNAPSHOT, and both halves of that are deliberate.
  // A cursor is a start POSITION inside the index the query already uses: it
  // adds no field to the index requirement, and this repo's own model agrees —
  // `deriveRequiredIndex` derives an index from `where` + `orderBy` and from
  // nothing else. (The hedge worth carrying: `apps/functions/src/avisos/
  // sweepAvisosResolvidos.ts` warns against reasoning about Enterprise's index
  // service from first principles, but in its own words that warning is about a
  // FIELD PREFIX — a two-field composite serving a one-field query — which a
  // cursor is not.) And it is a doc snapshot rather than a VALUE because Shopee
  // `create_time` has 1-second resolution, so two orders created in the same
  // second share one µs `timestamp` and a value cursor would silently skip the
  // second.
  //
  // A pedido stored with NO `timestamp` is invisible to an inequality filter and
  // therefore never a candidate. Accepted: step 5 falls back to the wall clock
  // precisely so that cannot happen on a create, and it is fill-once.
  const candidatos: Candidato[] = [];
  let ultimo: QueryDocumentSnapshot | null = null;
  for (;;) {
    let consulta: Query = pedidoCollection
      .ref(db, {})
      .where('ehSaida', '==', true)
      .where('estado', 'in', [...ESTADOS_RESERVA_TRAVADA_SHOPEE])
      .where('timestamp', '<', cutoffUs)
      .orderBy('timestamp', 'desc')
      .limit(PAGE_LIMIT);
    if (ultimo !== null) consulta = consulta.startAfter(ultimo);

    const snap = await consulta.get();
    paginas += 1;
    examinados += snap.docs.length;

    for (const doc of snap.docs) {
      const raw = doc.data() as Record<string, unknown>;

      // 1a — the ownership proof. `makePedidoIdShopee` is recomputed from the
      // document itself, so no editor can author a pass.
      const prova = provaDeIdentidadeShopee(doc.id, raw);
      if (prova === null) {
        // A pedido CLAIMING to be Shopee's at a foreign id is a different fact
        // from a pedido that is not ours: a migration artefact or a preimage
        // bug, i.e. a bug report rather than a backlog.
        if (tipoMarketplace(raw) === 'shopee') adotado += 1;
        else naoMarketplace += 1;
        continue;
      }

      // 1b — the watermark. A digest-proven Shopee pedido without one cannot
      // exist through step 5, so one is a finding rather than a candidate.
      if (coerceToMicros(raw.lastMarketplaceUpdate) == null) {
        naoMarketplace += 1;
        logger.warn('[shopee/reserva-travada] pedido com digest Shopee e sem watermark', {
          pedidoId: doc.id,
          integracaoId: prova.contaId,
        });
        continue;
      }

      // The age. A `timestamp` that will not coerce cannot produce an honest
      // age, and the aviso's `idadeDias` is not nullable — so it is counted the
      // same way 1b is, loudly, rather than surfaced with an invented number.
      const idadeDias = idadeEmDias(raw.timestamp, nowUs);
      if (idadeDias === null) {
        naoMarketplace += 1;
        logger.warn('[shopee/reserva-travada] pedido com timestamp ilegível', {
          pedidoId: doc.id,
          integracaoId: prova.contaId,
        });
        continue;
      }

      // 1c — the conta must be ACTIVE. A deactivated conta freezing
      // reservations is its own operator fact.
      if (!shopIdPorConta.has(prova.contaId)) {
        contaInativa += 1;
        continue;
      }

      // 1d — the CLI's scope. Rows of OTHER contas, never "not a marketplace
      // pedido".
      if (escopo !== null && !escopo.has(prova.contaId)) {
        foraDoEscopo += 1;
        continue;
      }

      const statusEmUs = coerceToMicros(bloco(raw, 'marketplace')?.statusEm);
      candidatos.push({
        pedidoId: doc.id,
        contaId: prova.contaId,
        orderSn: prova.orderSn,
        idadeDias,
        statusArmazenado: statusArmazenadoDe(raw),
        bucketStatus:
          statusEmUs == null
            ? null
            : bucketDaIdade(Math.max(0, Math.floor((nowUs - statusEmUs) / DIA_US))),
        raw,
      });
      // ⚠️ The ceiling is per ROW, never per page — checked only BETWEEN pages
      // it bounds nothing. ONE gate-1 reject on a full page leaves the running
      // total at MAX_CANDIDATOS - 1, the next whole page is taken, and the tick
      // lands on MAX_CANDIDATOS - 1 + PAGE_LIMIT = 399: double the pagamento
      // reads, double the batched `get_order_detail` calls (8 instead of 4, or
      // 407 with the fallback on every batch) and double the aviso round trips
      // that this module's docblock, the plan and the 540 s sizing all state as
      // the worst case.
      if (candidatos.length >= MAX_CANDIDATOS) {
        truncado = true;
        break;
      }
    }

    ultimo = snap.docs[snap.docs.length - 1] ?? null;
    // The cap was reached INSIDE this page, so rows of this very page went
    // unexamined: the prefix is truncated even when the page came back short.
    if (truncado) break;
    const drenada = snap.docs.length < PAGE_LIMIT;
    if (drenada) break;
    if (paginas >= MAX_PAGINAS) {
      truncado = true;
      break;
    }
  }

  /* ---- (2) the three diagnostic tables — AFTER the gates, BEFORE any call -- */
  //
  // This half costs ZERO Shopee calls and is therefore present even on a tick
  // where every read answers `nao-verificavel`. It is the instrument for
  // register item 37.
  //
  // ⚠️ A candidate whose `marketplace.statusEm` will not coerce contributes to
  // `statusArmazenado` (and later to `statusArmazenadoPorVeredito`) but to
  // NEITHER age table: there is no age to report, and borrowing the pedido's own
  // `timestamp` would mix two clocks inside a table whose whole job is to date
  // the PROVIDER's last word.
  for (const cand of candidatos) {
    statusArmazenado[cand.statusArmazenado] = (statusArmazenado[cand.statusArmazenado] ?? 0) + 1;
    if (cand.bucketStatus !== null) {
      idadeStatusDias[cand.bucketStatus] += 1;
      const linha = (statusPorIdade[cand.statusArmazenado] ??= zerarBuckets());
      linha[cand.bucketStatus] += 1;
    }
  }

  /**
   * Record ONE verdict for ONE candidate, in every place it is counted.
   *
   * ⚠️ It is also the ONLY place `deps.onCandidato` is called, which is what
   * makes "exactly once per candidate" structural instead of a list of call
   * sites somebody has to keep in sync: every arm that decides a candidate —
   * both gates, the two read arms, the classified arms and the
   * `tasks-desabilitado` substitution — reaches a verdict through here, and
   * `Σ veredictos === candidatos` is the assertion that keeps it that way.
   *
   * The observed row is built FIELD BY FIELD; the wire row never comes in here.
   */
  function registrar(
    cand: Candidato,
    acc: AcumuladorDaConta,
    veredito: VereditoReservaTravada,
    detalhe: DetalheObservado = DETALHE_NAO_LIDO,
  ): void {
    // ⚠️ ONE verdict per candidate, enforced HERE rather than trusted to the
    // call sites, because both effects run AFTER their arm has registered: a
    // contained (gRPC-coded) Firestore failure out of an aviso write or an
    // in-line resolve lands on a catch that records `nao-verificavel`, which
    // would count the same pedido twice — breaking `Σ veredictos ===
    // candidatos`, double-counting one cell of the
    // `statusArmazenadoPorVeredito` cross-tab the rehearsal is read from, and
    // emitting two CONTRADICTORY `onCandidato` rows for one order. The failure
    // still reaches `erros[]`, which is exactly the shape `redirigir` already
    // uses for an enqueue that threw.
    if (registrados.has(cand.pedidoId)) return;
    registrados.add(cand.pedidoId);
    veredictos[veredito] += 1;
    acc.veredictos[veredito] += 1;
    const linha = (statusArmazenadoPorVeredito[cand.statusArmazenado] ??= zerarVeredictos());
    linha[veredito] += 1;
    // ⚠️ NOT wrapped in a try: a throw here is the rehearsal's own bug and must
    // reach it, never be laundered into `erros[]`.
    deps.onCandidato?.({
      pedidoId: cand.pedidoId,
      integracaoId: cand.contaId,
      orderSn: cand.orderSn,
      veredito,
      orderStatus: detalhe.orderStatus,
      pendingTerms: detalhe.pendingTerms,
      temPayTime: detalhe.temPayTime,
      idadeDias: cand.idadeDias,
      cancelBy: detalhe.cancelBy,
      cancelReason: detalhe.cancelReason,
      enfileiraria: detalhe.enfileiraria,
      // Derived from the FINAL verdict rather than from the classification, so
      // the two can never disagree — and the surfacing set is declared once.
      avisaria: VEREDITOS_QUE_AVISAM.has(veredito),
    });
  }

  async function resolverEmLinha(
    cand: Candidato,
    acc: AcumuladorDaConta,
    motivo: MotivoResolucaoReservaTravada,
  ): Promise<void> {
    const chave = chaveReservaTravada(cand.contaId, cand.pedidoId);
    chavesTocadas.add(chave);
    if (dryRun) return;
    if (await resolverReservaTravada(db, chave, motivo, deps)) acc.avisosResolvidos += 1;
  }

  async function surfacar(
    cand: Candidato,
    acc: AcumuladorDaConta,
    veredito: VereditoQueAvisa,
    orderStatus: string | null,
    pendingTerms: readonly string[] | null,
    motivoInexistente: EventoReservaTravada['motivoInexistente'],
  ): Promise<void> {
    // Built FIELD BY FIELD, never by spreading a wire row: a field that is not
    // listed cannot appear downstream, including one a future schema change
    // adds.
    const evento: EventoReservaTravada = {
      veredito,
      pedidoId: cand.pedidoId,
      integracaoId: cand.contaId,
      numero: cand.orderSn,
      orderStatus,
      pendingTerms,
      motivoInexistente,
      idadeDias: cand.idadeDias,
    };
    if (dryRun) {
      // The dry run counts what it WOULD write and touches the same chave, so
      // pass (b) behaves identically in both modes. `db.writes` is the proof it
      // wrote nothing.
      chavesTocadas.add(chaveReservaTravada(cand.contaId, cand.pedidoId));
      acc.avisosEscritos += 1;
      return;
    }
    const { chave } = await avisarReservaTravada(db, evento, {
      increment: deps.increment,
      nowMs: deps.nowMs,
      logger,
    });
    chavesTocadas.add(chave);
    acc.avisosEscritos += 1;
  }

  /** The synthetic code-3 re-drive. Returns the verdict the effect leaves. */
  async function redirigir(
    cand: Candidato,
    acc: AcumuladorDaConta,
    shopId: number,
    orderStatus: string,
  ): Promise<VereditoReservaTravada | null> {
    if (tasksDesabilitado) return VEREDITO_RESERVA_TRAVADA.tasksDesabilitado;
    if (dryRun) return null;

    const payload = notificacaoSinteticaDePedido({
      shopId,
      orderSn: cand.orderSn,
      nowMs: deps.nowMs,
      origem: 'reserva-travada',
      orderStatus,
    });
    // No `scheduleDelaySeconds`: a candidate is days old, so there is no fresh
    // push to lose a race with.
    const chave = dedupKeyOf(payload);
    if (chave != null && enfileiradosVistos.has(chave)) return null;
    if (chave != null) enfileiradosVistos.add(chave);
    try {
      await deps.scheduler.enqueue(payload);
      acc.enfileirados += 1;
    } catch (err) {
      // Belt and braces: the env flipped mid-tick.
      if (err instanceof ShopeeTasksDisabledError) {
        return VEREDITO_RESERVA_TRAVADA.tasksDesabilitado;
      }
      // ⚠️ Per CANDIDATE, never the per-conta containment: one order we could
      // not hand back must not cost the conta its remaining candidates, and the
      // candidate simply stays a candidate next week.
      if (!erroContidoPorConta(err)) throw err;
      erros.push({ pedidoId: cand.pedidoId, message: err.message });
    }
    return null;
  }

  /**
   * Apply one classification: the counters, then the two effects.
   *
   * ⚠️ `cancelBy` / `cancelReason` are THREADED from the wire row rather than
   * the row itself being passed down: they are the observable register item 37
   * is read from, and they would otherwise die inside `consumir`. Two columns,
   * named one at a time — never the row, which carries the buyer.
   */
  async function aplicar(
    cand: Candidato,
    acc: AcumuladorDaConta,
    shopId: number,
    cls: ClassificacaoReservaTravada,
    cancelBy: string | null,
    cancelReason: string | null,
  ): Promise<void> {
    // Computed off the CLASSIFICATION, not off the effect, so the diagnostic is
    // stable across dry-run and a disabled queue.
    if (cls.redirigir && cand.statusArmazenado === cls.orderStatus) {
      redriveAparentementeNaoAplicado += 1;
    }

    let veredito: VereditoReservaTravada = cls.veredito;
    if (cls.redirigir) {
      const substituto = await redirigir(cand, acc, shopId, cls.orderStatus);
      if (substituto !== null) veredito = substituto;
    }
    registrar(cand, acc, veredito, {
      orderStatus: cls.orderStatus,
      pendingTerms: cls.pendingTerms,
      temPayTime: cls.temPayTime,
      cancelBy,
      cancelReason,
      // The PREDICTION, off the classification and the valve — so a dry run and
      // a live run with an open queue report the same thing for the same order.
      enfileiraria: cls.redirigir && !tasksDesabilitado,
    });

    if (cls.surfacar) {
      await surfacar(
        cand,
        acc,
        cls.veredito as VereditoQueAvisa,
        cls.orderStatus,
        cls.pendingTerms,
        null,
      );
    }
  }

  /** Shopee denies the order: one verdict, one aviso, never an enqueue. */
  async function inexistente(
    cand: Candidato,
    acc: AcumuladorDaConta,
    motivo: EventoReservaTravada['motivoInexistente'],
    codigoBruto: string | null,
  ): Promise<void> {
    registrar(cand, acc, VEREDITO_RESERVA_TRAVADA.inexistente);
    if (codigoBruto != null) {
      acc.codigosInexistente[codigoBruto] = (acc.codigosInexistente[codigoBruto] ?? 0) + 1;
    }
    await surfacar(cand, acc, VEREDITO_RESERVA_TRAVADA.inexistente, null, null, motivo);
  }

  /* ---- (3) the per-conta loop --------------------------------------------- */
  const porConta = new Map<string, Candidato[]>();
  for (const cand of candidatos) {
    const lista = porConta.get(cand.contaId);
    if (lista === undefined) porConta.set(cand.contaId, [cand]);
    else lista.push(cand);
  }

  const contas: ReservaTravadaContaResult[] = [];

  for (const { integracaoId, shopId } of ativas) {
    if (escopo !== null && !escopo.has(integracaoId)) continue;

    const meus = porConta.get(integracaoId) ?? [];
    const acc = novoAcumulador();

    if (shopId == null) {
      // A main-account-only conta cannot sign a shop call. Its candidates are
      // `nao-verificavel` — we OBSERVED nothing — and raise no aviso, because an
      // absence is not a residual. Skipped BEFORE any gate or read.
      semShopId += 1;
      acc.pulada = MOTIVO_SEM_SHOP_ID;
      for (const cand of meus) registrar(cand, acc, VEREDITO_RESERVA_TRAVADA.naoVerificavel);
      contas.push(linhaDaConta(integracaoId, null, meus.length, acc));
      continue;
    }

    if (meus.length === 0) {
      // Nothing to ask about ⇒ no context load, no client, no call.
      acc.pulada = MOTIVO_SEM_CANDIDATOS;
      contas.push(linhaDaConta(integracaoId, shopId, 0, acc));
      continue;
    }

    /* -- gates 2 and 3, per candidate, before any Shopee call --------------- */
    const paraLer: Candidato[] = [];
    for (const cand of meus) {
      try {
        // 2 — a human already owns it. The latch is client-writable and step 5
        // freezes on it.
        if (cand.raw.hasUserInteraction === true) {
          registrar(cand, acc, VEREDITO_RESERVA_TRAVADA.interacaoHumana);
          await resolverEmLinha(cand, acc, MOTIVO_RESOLUCAO_RESERVA_TRAVADA.assumidoPorHumano);
          continue;
        }

        // 3 — the WHOLE `pagamentos` subcollection, never the by-id read: a
        // combined BR payment fans out to N documents and a by-id read would
        // miss a secondary. The gate is nearly vacuous on this channel by
        // construction, and it defends exactly two things — the window between
        // step 5's pedido transaction and its pagamento transaction, and a
        // human edit.
        const pags = await pagamentoCollection.ref(db, { pedidoId: cand.pedidoId }).get();
        const aprovado = pags.docs.some(
          (d) =>
            (d.data() as Record<string, unknown>).status_pagamento === STATUS_PAGAMENTO.aprovado,
        );
        if (aprovado) {
          registrar(cand, acc, VEREDITO_RESERVA_TRAVADA.pagamentoAprovado);
          await resolverEmLinha(cand, acc, MOTIVO_RESOLUCAO_RESERVA_TRAVADA.vendaViva);
          continue;
        }

        paraLer.push(cand);
      } catch (err) {
        if (!erroContidoPorConta(err)) throw err;
        erros.push({ pedidoId: cand.pedidoId, message: err.message });
        registrar(cand, acc, VEREDITO_RESERVA_TRAVADA.naoVerificavel);
      }
    }

    if (paraLer.length === 0) {
      contas.push(linhaDaConta(integracaoId, shopId, meus.length, acc));
      continue;
    }

    /* -- the batched read --------------------------------------------------- */
    const restantes = [...paraLer];
    try {
      const client =
        deps.clientFor !== undefined
          ? await deps.clientFor(db, integracaoId)
          : (await loadShopeeContext(db, integracaoId)).createShopClient();

      for (const lote of lotesDe(paraLer, LOTE_ORDER_DETAIL)) {
        if (acc.pulada === MOTIVO_CONTA_ABORTADA) break;
        acc.lotes += 1;
        await lerLote(client, lote, acc, shopId, restantes);
      }
    } catch (err) {
      // The per-conta containment boundary. `ShopeeConfigError` is OURS and
      // rethrows: a broken deploy must fail the execution that names the
      // missing binding, not become N identical `lastError` strings.
      if (!erroContidoPorConta(err)) throw err;
      acc.error = err.message;
      logger.warn('[shopee/reserva-travada] conta contida após falha', {
        integracaoId,
        erro: err.message,
      });
    }

    // Anything still unread — an abort, or a contained conta-level failure — is
    // `nao-verificavel`, counted and never surfaced.
    for (const cand of restantes) registrar(cand, acc, VEREDITO_RESERVA_TRAVADA.naoVerificavel);
    contas.push(linhaDaConta(integracaoId, shopId, meus.length, acc));
  }

  /**
   * ONE batch, with the error table.
   *
   * ⚠️ NEVER a retry inside the tick. Shopee's own guidance is "avoid frequent
   * retry operations" and the escalation is the whole app being restricted,
   * which a human ticket has to lift; `error_limit` resets at 00:00 UTC+8,
   * beyond any tick. That is also why a rate limit aborts the CONTA rather than
   * merely the batch: every remaining batch would spend another call against
   * the limit that just refused us.
   *
   * ⚠️ `warning` (register item 46): on a FAILED call it is reachable as
   * `ShopeeApiError.warning` and is logged verbatim below. On a SUCCESSFUL call
   * it is NOT reachable from here — the package routes the envelope's warning to
   * the transport's `onWarning` hook, which is supplied at client construction
   * and which `apps/shopee` wires nowhere. Logged where reachable, branched on
   * never.
   */
  async function lerLote(
    client: ShopeeClient,
    lote: readonly Candidato[],
    acc: AcumuladorDaConta,
    shopId: number,
    restantes: Candidato[],
  ): Promise<void> {
    // Declared out here (rather than handling the rows inside the `try`) so an
    // aviso or enqueue failure raised while CONSUMING a row can never be
    // mistaken for the batch read failing — which would skip the verdicts of
    // every other order in the batch and break `Σ veredictos === candidatos`.
    let resp: ShopeeOrderDetail | null = null;
    try {
      acc.chamadas += 1;
      resp = await client.getOrderDetail({
        orderSnList: lote.map((c) => c.orderSn),
        // ALWAYS — without it Shopee "falls back to old logic" and a PENDING
        // order comes back collapsed onto another status, which step 5's ladder
        // would read as `pago`. The risk is a MISREAD, not an absence.
        requestOrderStatusPending: true,
        responseOptionalFields: CAMPOS_OPCIONAIS_RESERVA_TRAVADA,
      });
    } catch (err) {
      if (err instanceof ShopeeRateLimitError || err instanceof ShopeeReauthRequiredError) {
        // Either class kills the conta: the limit is ours for the day, and a
        // dead grant is dead for every remaining batch.
        acc.pulada = MOTIVO_CONTA_ABORTADA;
        acc.error = err.message;
        logger.warn('[shopee/reserva-travada] conta abortada', {
          shopId,
          codigo: err.code,
          warning: err.warning,
        });
        return;
      }
      if (err instanceof ShopeeApiError && CODIGOS_PEDIDO_INEXISTENTE.has(err.code)) {
        logger.warn('[shopee/reserva-travada] lote recusado por completo', {
          shopId,
          codigo: err.code,
          warning: err.warning,
          pedidos: lote.length,
        });
        if (lote.length === 1) {
          await consumir(lote[0]!, acc, restantes, undefined, err.code);
          return;
        }
        acc.lotesComFallback += 1;
        for (const cand of lote) {
          // ⚠️ The same guard the batch loop carries, for the reason stated
          // above: a rate limit or a dead grant raised INSIDE the fallback
          // aborts the conta, and every remaining `order_sn` of this batch
          // would be one more call — up to 49 — against the limit that just
          // refused us, or one more call signed with a grant we have just
          // declared dead. The candidates left in `restantes` count
          // `nao-verificavel`, which is what "abort the conta" means.
          if (acc.pulada === MOTIVO_CONTA_ABORTADA) break;
          await lerUm(client, cand, acc, shopId, restantes);
        }
        return;
      }
      // Any other Shopee failure costs this BATCH its verdicts and nothing
      // more; the next batch still runs.
      if (!erroContidoPorConta(err)) throw err;
      acc.error = err.message;
      logger.warn('[shopee/reserva-travada] lote não verificável', {
        shopId,
        erro: err.message,
        // ⚠️ Conditional because this arm also catches HTTP / network / schema /
        // gRPC failures, which carry neither field — and it is the branch every
        // ORDINARY `ShopeeApiError` lands on (`error_server`, `error_param`,
        // `error_sign`, and whatever Shopee adds tomorrow), i.e. the likeliest
        // carrier of a populated `warning`. Dropping it here would leave
        // register item 46 instrumented on the two rarest paths only.
        ...(err instanceof ShopeeApiError ? { codigo: err.code, warning: err.warning } : {}),
        pedidos: lote.length,
      });
      return;
    }

    if (resp === null) return;

    // ⚠️ Reconciled by `order_sn`, NEVER by position: Shopee may answer with
    // fewer rows than were asked for, and duplicates in the request collapse.
    const porOrderSn = new Map(resp.order_list.map((r) => [r.order_sn, r]));
    for (const cand of lote) {
      await consumir(cand, acc, restantes, porOrderSn.get(cand.orderSn), null);
    }
  }

  /** The per-order fallback leg, with the same error table at `N === 1`. */
  async function lerUm(
    client: ShopeeClient,
    cand: Candidato,
    acc: AcumuladorDaConta,
    shopId: number,
    restantes: Candidato[],
  ): Promise<void> {
    try {
      acc.chamadas += 1;
      const resp = await client.getOrderDetail({
        orderSnList: [cand.orderSn],
        requestOrderStatusPending: true,
        responseOptionalFields: CAMPOS_OPCIONAIS_RESERVA_TRAVADA,
      });
      await consumir(
        cand,
        acc,
        restantes,
        resp.order_list.find((r) => r.order_sn === cand.orderSn),
        null,
      );
    } catch (err) {
      if (err instanceof ShopeeRateLimitError || err instanceof ShopeeReauthRequiredError) {
        acc.pulada = MOTIVO_CONTA_ABORTADA;
        acc.error = err.message;
        logger.warn('[shopee/reserva-travada] conta abortada', {
          shopId,
          codigo: err.code,
          warning: err.warning,
        });
        return;
      }
      if (err instanceof ShopeeApiError && CODIGOS_PEDIDO_INEXISTENTE.has(err.code)) {
        await consumir(cand, acc, restantes, undefined, err.code);
        return;
      }
      if (!erroContidoPorConta(err)) throw err;
      acc.error = err.message;
      // Same line as the batch leg's: without it a fallback failure leaves no
      // log at all and survives only as `contas[].error`, which the NEXT
      // contained failure overwrites.
      logger.warn('[shopee/reserva-travada] pedido não verificável', {
        shopId,
        erro: err.message,
        ...(err instanceof ShopeeApiError ? { codigo: err.code, warning: err.warning } : {}),
        pedidos: 1,
      });
    }
  }

  /**
   * One candidate, one live row (or its absence), one verdict.
   *
   * ⚠️ The `LeituraReservaTravada` is built FIELD BY FIELD — never by spreading
   * the row — so a field this sweep did not decide to read cannot reach the
   * classifier, the aviso or a log line, including one a future schema change
   * adds to the wire.
   *
   * ⚠️ Both spellings in `CODIGOS_PEDIDO_INEXISTENTE` fold to ONE
   * `motivoInexistente` (`order_not_found`, the semantic "Shopee denies the
   * order"), because that is the only vocabulary the aviso producer admits. The
   * RAW code survives in `codigosInexistente` and in the log line, which is
   * where register item 38 is read from.
   */
  async function consumir(
    cand: Candidato,
    acc: AcumuladorDaConta,
    restantes: Candidato[],
    linha: ShopeeOrderDetailRow | undefined,
    codigoBruto: string | null,
  ): Promise<void> {
    const i = restantes.indexOf(cand);
    if (i >= 0) restantes.splice(i, 1);

    const shopId = shopIdPorConta.get(cand.contaId) ?? null;
    try {
      if (linha === undefined) {
        await inexistente(
          cand,
          acc,
          codigoBruto == null ? 'ausente-na-resposta' : 'order_not_found',
          codigoBruto,
        );
        return;
      }
      const cls = classificarReservaTravada({
        orderStatus: linha.order_status,
        payTime: linha.pay_time,
        pendingTerms: linha.pending_terms,
      });
      // `shopId` cannot be null here: a conta without one never reaches the
      // read at all. The guard exists so the payload can never carry a
      // fabricated id.
      if (shopId == null) {
        registrar(cand, acc, VEREDITO_RESERVA_TRAVADA.naoVerificavel);
        return;
      }
      await aplicar(cand, acc, shopId, cls, linha.cancel_by, linha.cancel_reason);
    } catch (err) {
      if (!erroContidoPorConta(err)) throw err;
      erros.push({ pedidoId: cand.pedidoId, message: err.message });
      registrar(cand, acc, VEREDITO_RESERVA_TRAVADA.naoVerificavel);
    }
  }

  /* ---- (4) pass (b): the reconciliation over the OPEN avisos --------------- */
  //
  // Byte-for-byte the collection's own `defaultQuery` shape, on the declared
  // `(resolvidoEm ASC, criadoEm DESC)` composite — no new index. Everything
  // else is filtered in CODE, because no index can express it: the page carries
  // every unresolved row of every tipo and every canal. ⚠️ NO cursor here,
  // deliberately: one page, one counter, and `reconciliacaoTruncada` is the
  // signal that a discriminated index is needed (migration-window work).
  //
  // ⚠️ **`criadoEm DESC` takes the NEWEST 200, and the rows this pass exists to
  // close are the OLDEST** — an aviso raised weeks ago whose pedido has since
  // left the candidate set sits at the tail. Above 200 open avisos repo-wide
  // they are never reached. That is a KNOWN limit, registered as settle-live
  // item 44, not an oversight, and `criadoEm ASC` is deliberately NOT the fix:
  //
  //  - Real Firestore would serve it. An index is scannable backwards, so it
  //    serves a query whose orderings are the FULL reversal of its own;
  //    reversing `(resolvidoEm ASC, criadoEm DESC)` gives
  //    `(resolvidoEm DESC, criadoEm ASC)`, and `resolvidoEm` is an EQUALITY
  //    here, whose direction a single-value prefix makes irrelevant.
  //  - This repo's shared model does NOT encode that rule. `indexSatisfies`
  //    (`packages/config-eslint/rules/lib/required-index.js`, consumed by the
  //    `default-query-needs-index` ESLint ERROR and by the `@delfrance/schemas`
  //    meta-test) compares field directions as-written, and answers `false` for
  //    `(resolvidoEm ASC, criadoEm ASC)` against everything declared — i.e.
  //    under the repo's own gate, ASC is a NEW index.
  //  - A new index is a DEPLOY, which is migration-window work (root rule 8);
  //    and on Enterprise the signal for having got it wrong is the INVOICE, not
  //    an exception (root rule 1). Trading a registered, instrumented limit for
  //    a silent full scan on a rule the shared model refuses is the wrong side
  //    of that trade.
  //
  // Both halves are dissolved by the SAME migration-window change — a
  // discriminated `(canal, tipo, resolvidoEm, criadoEm)` composite, after which
  // the page holds only our rows and the direction stops mattering.
  //
  // Why it is not optional: the retention sweep deletes a RESOLVED aviso 90
  // days later, and an aviso nothing resolves stands for ever. And it is where
  // a `redirecionado-*` candidate's aviso actually closes — the OBSERVATION
  // that the re-drive landed, which no enqueue can give us.
  let avisosVarridos = 0;
  let reconciliados = 0;
  let reconciliacaoTruncada = false;
  {
    const abertos = await avisoCollection
      .ref(db, {})
      .where('resolvidoEm', '==', null)
      .orderBy('criadoEm', 'desc')
      .limit(RECONCILIACAO_PAGINA)
      .get();
    avisosVarridos = abertos.docs.length;
    reconciliacaoTruncada = abertos.docs.length >= RECONCILIACAO_PAGINA;

    for (const doc of abertos.docs) {
      const row = doc.data() as Record<string, unknown>;
      if (row.tipo !== TIPO_AVISO.pedidoPrecisaDecisao) continue;
      if (row.canal !== CANAL_AVISO.shopee) continue;
      // A chave this tick raised or resolved is not re-read and not CLOSED the
      // same tick it was raised.
      //
      // ⚠️ It is not spared the PAGE, and the comment used to claim it was:
      // the skip runs after the 200 rows have already come back, so a tick that
      // surfaces near `MAX_CANDIDATOS` can fill this page with rows it then
      // refuses to act on. They cannot be excluded server-side either —
      // `chavesTocadas` is only known after the conta loop, and no index
      // expresses "not in this set". The budget is spent either way;
      // `reconciliacaoTruncada` is what says so.
      if (chavesTocadas.has(doc.id)) continue;
      const pedidoId = pedidoIdDaChaveReservaTravada(doc.id);
      if (pedidoId === null) continue;

      try {
        const snap = await pedidoCollection.docRef(db, {}, pedidoId).get();
        const motivo = motivoDeReconciliacao(pedidoId, snap.exists, snap.data(), cutoffUs);
        if (motivo === null) continue;
        if (dryRun) {
          // Parity: the pass decides identically and reports what it WOULD close.
          reconciliados += 1;
          continue;
        }
        if (await resolverReservaTravada(db, doc.id, motivo, deps)) reconciliados += 1;
      } catch (err) {
        if (!erroContidoPorConta(err)) throw err;
        erros.push({ pedidoId, message: err.message });
      }
    }
  }

  return {
    enabled: true,
    dryRun,
    motivo: null,
    tasksDesabilitado,
    maxIdadeDias,
    cutoffUs,
    examinados,
    paginas,
    naoMarketplace,
    adotado,
    contaInativa,
    foraDoEscopo,
    semShopId,
    candidatos: candidatos.length,
    truncado,
    veredictos,
    avisosVarridos,
    reconciliados,
    reconciliacaoTruncada,
    redriveAparentementeNaoAplicado,
    statusArmazenado,
    idadeStatusDias,
    statusPorIdade,
    statusArmazenadoPorVeredito,
    contas,
    erros,
  };
}

function linhaDaConta(
  integracaoId: string,
  shopId: number | null,
  candidatos: number,
  acc: AcumuladorDaConta,
): ReservaTravadaContaResult {
  return {
    integracaoId,
    shopId,
    pulada: acc.pulada,
    candidatos,
    lotes: acc.lotes,
    lotesComFallback: acc.lotesComFallback,
    chamadas: acc.chamadas,
    enfileirados: acc.enfileirados,
    avisosEscritos: acc.avisosEscritos,
    avisosResolvidos: acc.avisosResolvidos,
    veredictos: acc.veredictos,
    codigosInexistente: acc.codigosInexistente,
    error: acc.error,
  };
}

/**
 * Has this pedido left the candidate set — and why?
 *
 * `null` ⇒ it is still a candidate and its aviso stays open. The five arms are
 * evaluated in this order because each is a stronger statement than the next:
 * the document is gone, its estado left {@link ESTADOS_RESERVA_TRAVADA_SHOPEE},
 * a human took it, it is no longer ours, it is inside the horizon again.
 *
 * ⚠️ A `timestamp` that will not coerce answers `null` — "inside the horizon"
 * is a claim about a value we could read, and closing an aviso is not undoable
 * by hand on a `serverOwned` collection.
 */
function motivoDeReconciliacao(
  pedidoId: string,
  existe: boolean,
  dados: unknown,
  cutoffUs: number,
): MotivoResolucaoReservaTravada | null {
  if (!existe) return MOTIVO_RESOLUCAO_RESERVA_TRAVADA.pedidoInexistente;
  const raw = (dados ?? {}) as Record<string, unknown>;
  if (!ehEstadoDeReservaTravada(estadoArmazenado(raw))) {
    return MOTIVO_RESOLUCAO_RESERVA_TRAVADA.estadoSaiuDoConjunto;
  }
  if (raw.hasUserInteraction === true) {
    return MOTIVO_RESOLUCAO_RESERVA_TRAVADA.assumidoPorHumano;
  }
  if (provaDeIdentidadeShopee(pedidoId, raw) === null) {
    return MOTIVO_RESOLUCAO_RESERVA_TRAVADA.foraDaPosse;
  }
  const stampUs = coerceToMicros(raw.timestamp);
  if (stampUs != null && stampUs >= cutoffUs) {
    return MOTIVO_RESOLUCAO_RESERVA_TRAVADA.dentroDoHorizonte;
  }
  return null;
}
