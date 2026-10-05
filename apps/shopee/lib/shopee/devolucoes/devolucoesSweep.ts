/**
 * Step 17's RETURNS RECONCILIATION (#1525, R-7) — the six-hourly re-read of
 * every return Shopee changed in the last fifteen days, and the hand-off of
 * each one the stored incidente does not reflect to the code-29 importer.
 *
 * Push 32 (code 29) announces FOUR fields — the return status, the solution,
 * the seller proof and the reverse logistics (`pushDevolucao.ts`); never a
 * negotiation, a compensation or a due date. Whether those also move `update_time`, and
 * whether a lost push is ever redelivered, is UNVERIFIED (registers 233/244).
 * So this sweep exists for what code 29 may never announce: it lists the
 * returns, compares each row with the stored incidente through
 * `motivoDeReimportacao` (the ONE predicate, `devolucaoMapping.ts`) and
 * re-imports a row that is absent, newer, divergent or breaking an importer
 * invariant. ⚠️ NOT a pure backstop: for what push 32 never reports
 * (negotiation, due dates, compensation) it IS the primary signal (register 233).
 *
 * ## It imports NOTHING and writes NOTHING
 *
 * Every candidate becomes ONE synthetic code 29 (`origem: 'reconciliacao'`, the
 * shared `notificacaoSinteticaDeDevolucao`) on the existing
 * `processShopeeNotification` queue, so the importer — `importarDevolucao.ts`,
 * which re-reads `get_return_detail` and decides under its own watermark — stays
 * the SINGLE writer of the incidente and its aviso (rule 7 tier 0 here: nothing
 * to race). The only Firestore operations in this module are READS: the conta
 * enumeration, ONE `getAll` of the derived incidente ids per page, one read of
 * today's failure row per candidate and — only when that row is `deferred` —
 * one read of the return's pedido. There is no write, no cursor document
 * and no multi-document atomic block anywhere in this module. ⚠️ That last API
 * is deliberately not NAMED in this file, comments included — the
 * transaction-inventory guard greps raw text. ⚠️ "Writes nothing" is this
 * module's own code: a conta whose access token is due for renewal pays the
 * token store's lease inside its first Shopee call (`core/tokenStore.ts`), as
 * every shop-signed caller does.
 *
 * ## The tick
 *
 * 1. Three gates, in order, each answering a `motivo` having read NOTHING — not
 *    Firestore, not Shopee: this sweep's own valve
 *    ({@link SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV}); the dispatch table, which
 *    must route code 29 to the devolução arm (`destinoDoCodigo(29)` — READ, never
 *    a literal: while 29 parked, every synthetic would have left a TERMINAL
 *    dead-letter row per return per tick, the order backfill's step-3
 *    reasoning); and the queue's valve (`shopeeTasksDesabilitado`, read BEFORE
 *    deciding — `ShopeeTasksDisabledError` is inside `erroContidoPorConta`, so
 *    learning it by a catch would read as N contained conta failures).
 * 2. `listarContasShopeeAtivas`. A conta without `shop_id` is counted in
 *    `semShopId` and costs nothing.
 * 3. Per conta, `get_return_list` on a TRAILING update-time window
 *    `[⌊nowMs/1000⌋ − JANELA, ⌊nowMs/1000⌋]` — no create window, no status
 *    filter — `page_no` 0, then +1 while `more` (≤
 *    {@link MAX_PAGINAS_DEVOLUCOES_POR_CONTA} pages of 100). ⚠️ Whether
 *    `page_no` is a page index or an entry offset, and its base, is UNVERIFIED
 *    (register 235): a page that repeats ANY return_sn already seen this tick
 *    STOPS the conta and warns `paginacao-ambigua` — that one test catches both
 *    the offset reading (page 1 = entries 1…100) and a 0 ≡ 1 base (page 1 =
 *    page 0). ⚠️ Whether an update-only window is accepted at all is register
 *    234: a refusal is a contained conta failure, every tick, in the log.
 * 4. Per row, a free triage: an unreadable row (the schema's `null`), or one
 *    whose synthetic the code-29 arm would REFUSE — checked through the arm's
 *    own parser (`alvoDoPushDeDevolucao`), never a second copy of its rules (a
 *    non-alphanumeric return_sn, a padded or `-` order_sn) — is
 *    `linhasIlegiveis`: enqueuing it would only park a row a day.
 * 5. ONE `getAll` of the page's derived incidente refs
 *    (`pedidos/<makePedidoIdShopee>/incidentes/<idIncidenteDevolucaoShopee>`),
 *    reconciled BY PATH; `motivoDeReimportacao` per row. `null` ⇒
 *    `jaAtualizadas`.
 * 6. Per candidate, the code 29 is stamped with the START of the UTC day
 *    (`carimboDoDiaUtcMs`), never `nowMs`, so its doc id
 *    `29:<shop>:<return_sn>:<day>` is stable for the day — and before enqueuing
 *    it the sweep reads that ONE `notificacoesShopee` document. Present means
 *    today's import of that return did not settle (the store DELETES a row once
 *    it resolves) — but a row is only a SKIP (`comFalhaHoje`) while it still
 *    HOLDS the return ({@link falhaDeHojeAindaSegura}): `parked`, or
 *    `deferred` while the return's pedido is STILL absent. Anything else —
 *    `failed`, or a `deferred` whose pedido has since appeared (the code 3 the
 *    defer enqueued typically creates it a minute later) — is re-enqueued, so
 *    a cleared precondition waits for the next tick, never for the rest of the
 *    UTC day.
 *    ⚠️ The "≤ 1 failure row per return per UTC day" bound does NOT rest on
 *    the skip: the pipeline's create on an existing doc id is an ALREADY_EXISTS
 *    no-op (`store.ts`), so it holds by doc-id construction alone (the
 *    `3685867cc` shape). The skip bounds ATTEMPTS: a deterministically failing
 *    import parks, and a park costs one attempt per return per UTC day; a
 *    re-tried precondition costs at most one per tick. Flooring is safe: the
 *    code-29 arm never reads the envelope stamp as a clock — its watermark is
 *    the detail's `update_time`.
 *    At most {@link MAX_ENFILEIRADOS_DEVOLUCOES_POR_CONTA} enqueues per conta;
 *    a candidate past it is `alemDoLimite`, and no further page is read.
 *
 * ## Containment (per conta), with the rate limit FIRST
 *
 * The step-15b sweep's boundary, verbatim in behaviour.
 * `ShopeeRateLimitError` extends `ShopeeApiError`, so the shared boundary would
 * swallow it: it is tested FIRST and ABORTS THE WHOLE TICK (the quota is per
 * APP; the next tick is the retry). Everything `erroContidoPorConta` names is
 * recorded on the conta and the walk moves on; anything else —
 * `ShopeeConfigError` above all, our own misconfiguration — rethrows and fails
 * the tick loudly.
 *
 * ⚠️ A Cloud Tasks enqueue failure is NOT a gRPC-coded error: `TaskQueue`
 * throws `FirebaseFunctionsError` / `FirebaseAppError` with STRING codes. This
 * module does not classify them — it calls `scheduler.enqueue` directly, and
 * the real scheduler (`../shopeeTasks.ts`, `enfileirarNomeandoFalhaTransitoria`,
 * #1759) names a transient one `ShopeeTasksTransientError`, which the shared
 * boundary contains per conta like any outage. A permission, a missing queue
 * or a bad argument reaches the boundary as the raw SDK class — a broken
 * deploy — and rethrows (#778).
 *
 * ## Logs: ids and counts ONLY
 *
 * No `order_sn`, no `return_sn`, no buyer datum reaches a log argument or the
 * result — a test serialises every one of them. A contained `ShopeeApiError` is
 * described by its class and Shopee `error` code only — the code through
 * `codigoSeguro` (`nfe/redacaoNfe.ts`, the ONE gate for a Shopee code reaching
 * a log), never raw: its message carries Shopee's own text verbatim, and a code
 * that is not a short token is not a code. A transient enqueue failure is
 * described by the shared class's own message — class, code and HTTP status,
 * never the SDK's message, which may quote the response body. `erroEnvelope`
 * is the first page's `error` VALUE (`''`, `' '` or `'-'` on a success) —
 * register 231's instrument, at zero cost, and deliberately NOT through
 * `codigoSeguro`, which would fold all three of those to `null`.
 */
import type { DocumentReference, DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import {
  incidenteCollection,
  notificacaoShopeeCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  SHOPEE_RETURN_LIST_MAX_PAGE_SIZE,
  ShopeeApiError,
  ShopeeRateLimitError,
  type GetReturnListParams,
  type ShopeeClient,
  type ShopeeReturnListRow,
} from '@delfrance/integrations-shopee';
import { NOTIFICACAO_RESILIENCIA_STATUS } from '@delfrance/schemas';

import type { SweepLogger } from '../conta/expiracaoSweep';
import { erroContidoPorConta } from '../core/containment';
import { listarContasShopeeAtivas } from '../core/contas';
import { loadShopeeContext } from '../core/shopee';
import { codigoSeguro } from '../nfe/redacaoNfe';
import {
  destinoDoCodigo,
  docIdOf,
  type ShopeeNotificationPayload,
} from '../notificacoes/notificacao';
import {
  carimboDoDiaUtcMs,
  notificacaoSinteticaDeDevolucao,
} from '../notificacoes/notificacaoSintetica';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import { shopeeTasksDesabilitado, type ShopeeTaskScheduler } from '../shopeeTasks';
import { motivoDeReimportacao, type MotivoReimportacao } from './devolucaoMapping';
import { idIncidenteDevolucaoShopee } from './idsDevolucao';
import { alvoDoPushDeDevolucao } from './pushDevolucao';

/* -------------------------------------------------------------------------- */
/*                                  the valve                                  */
/* -------------------------------------------------------------------------- */

/**
 * This sweep's kill switch. `'1'` and NOTHING else turns it off — `'true'`,
 * `' 1'`, `'01'`, `'0'`, a blank and an unset value all leave it ON — the
 * polarity of every `*_DISABLED` valve in this app, so a missing value can never
 * leave a return the push missed un-reconciled. Read only by the nested
 * functions codebase: its home is `functions/.env.deploy`, never
 * `apphosting.yaml`.
 *
 * ⚠️ It SHIPS ON, and at the cutover that means the first tick imports every
 * return updated in the 15 days before it and starts blocking `finalizar` on
 * those pedidos (`functions/DEPLOY.md`; rule 8).
 */
export const SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV = 'SHOPEE_DEVOLUCAO_SWEEP_DISABLED';

/**
 * Whether this sweep is switched off — the literal `'1'` only.
 *
 * `env` is the variable's VALUE; omitted (or `undefined`), the process
 * environment is read. ⚠️ So a caller holding an injected environment must
 * pass `?? ''` for an unset variable, never `undefined` — the default would
 * otherwise read the REAL process env behind its back
 * ({@link runShopeeDevolucoesSweep} does).
 */
export function sweepDevolucoesDesligado(
  env: string | undefined = process.env[SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV],
): boolean {
  return env === '1';
}

/* -------------------------------------------------------------------------- */
/*                                  the bounds                                 */
/* -------------------------------------------------------------------------- */

/**
 * The trailing update-time window, SECONDS: fifteen days minus five minutes.
 * Shopee refuses a window ONE second past fifteen days
 * (`SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS`), and the margin keeps a clock skew
 * between this instance and Shopee's from ever reaching that edge. A six-hourly
 * tick re-reads each window ~60 times — the overlap is what makes a missed tick
 * free.
 */
export const JANELA_DEVOLUCOES_SEGUNDOS = 15 * 86_400 - 300;

/**
 * Pages per conta per tick: × 100 rows = 1 000 returns updated in fifteen
 * days. More on a BR shop is implausible, so a truncation is the anomaly the
 * result names (`truncada`).
 */
export const MAX_PAGINAS_DEVOLUCOES_POR_CONTA = 10;

/**
 * Enqueues per conta per tick. Each costs the importer ONE `get_return_detail`;
 * once reached, a further candidate is counted `alemDoLimite` and waits six
 * hours, and no further page is read.
 */
export const MAX_ENFILEIRADOS_DEVOLUCOES_POR_CONTA = 200;

/** Why a tick read nothing. */
export const MOTIVO_SWEEP_DEVOLUCOES = {
  /** {@link SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV} is `'1'`. */
  desligado: 'sweep-desligado',
  /** `destinoDoCodigo(29)` is not the devolução arm: every synthetic would park. */
  handlerAusente: 'handler-ausente',
  /** `SHOPEE_TASKS_DISABLED` is `'1'`: no task would land. */
  tasksDesabilitado: 'tasks-desabilitado',
} as const;
export type MotivoSweepDevolucoes =
  (typeof MOTIVO_SWEEP_DEVOLUCOES)[keyof typeof MOTIVO_SWEEP_DEVOLUCOES];

/* -------------------------------------------------------------------------- */
/*                                  contract                                   */
/* -------------------------------------------------------------------------- */

export interface ShopeeDevolucoesSweepDeps {
  readonly scheduler: ShopeeTaskScheduler;
  /**
   * ONE clock read for the whole tick, MILLISECONDS — the window's end
   * (`⌊nowMs/1000⌋`) and the synthetic's day stamp. Never converted to µs here.
   */
  readonly nowMs: number;
  /** Default: `loadShopeeContext(db, id).createShopClient()`. */
  readonly clientFor?: (
    db: Firestore,
    integracaoId: string,
  ) => Promise<Pick<ShopeeClient, 'getReturnList'>>;
  /** The environment the VALVE is read from. Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Default: `console.warn`. */
  readonly logger?: SweepLogger;
}

/**
 * One conta's tick. ⚠️ The counters PARTITION the rows, and a test pins it:
 *
 *     listadas = linhasIlegiveis + repetidas + jaAtualizadas
 *              + Σ enfileiradas + comFalhaHoje + alemDoLimite
 */
export interface ResultadoContaSweepDevolucoes {
  readonly integracaoId: string;
  readonly paginas: number;
  /** Rows the pages answered, unreadable ones included. */
  readonly listadas: number;
  /** The schema's `null`, or a row whose synthetic the code-29 arm would refuse. */
  readonly linhasIlegiveis: number;
  /** A return_sn already seen this tick — the `paginacaoAmbigua` evidence. */
  readonly repetidas: number;
  /** `motivoDeReimportacao` answered `null`: the stored incidente already reflects the row. */
  readonly jaAtualizadas: number;
  /** Enqueued, per reason — every key PRESENT, zeros included. */
  readonly enfileiradas: Readonly<Record<MotivoReimportacao, number>>;
  /**
   * Candidates NOT re-enqueued: today's code-29 failure row stands AND still
   * holds the return — `parked`, or `deferred` while its pedido is absent. A
   * row that no longer holds it is re-enqueued and counted under
   * {@link enfileiradas}, never here.
   */
  readonly comFalhaHoje: number;
  /** Candidates past {@link MAX_ENFILEIRADOS_DEVOLUCOES_POR_CONTA}, left for the next tick. */
  readonly alemDoLimite: number;
  /** The page cap or the enqueue cap cut the walk while there was more to read. */
  readonly truncada: boolean;
  /** A page repeated a return_sn already seen: the walk STOPPED (register 235). */
  readonly paginacaoAmbigua: boolean;
  /** The first page's `error` VALUE, verbatim — register 231. `null` before any page. */
  readonly erroEnvelope: string | null;
  /** `<class>: <detail>` of a contained failure (never Shopee's own text). */
  readonly error: string | null;
}

export interface ResultadoSweepDevolucoes {
  /** Why the tick read nothing (`null` when it ran). */
  readonly motivo: MotivoSweepDevolucoes | null;
  /** One entry per conta WALKED (a shop id, whatever the outcome), in order. */
  readonly contas: readonly ResultadoContaSweepDevolucoes[];
  /** Active contas with no `shop_id` — counted, never called, NOT in `contas`. */
  readonly semShopId: number;
  /** A rate limit aborted the tick; the contas after it were not walked. */
  readonly interrompidoPorLimite: 'burst' | 'daily' | null;
}

/* -------------------------------------------------------------------------- */
/*                                  internals                                  */
/* -------------------------------------------------------------------------- */

/** Zero for EVERY reason — an absent key would read as an arm that never existed. */
const ENFILEIRADAS_ZERADAS = {
  ausente: 0,
  relogio: 0,
  divergente: 0,
  invariante: 0,
} as const satisfies Record<MotivoReimportacao, number>;

/** The mutable accumulator — so a failure mid-conta still reports what ran. */
interface Contagem {
  paginas: number;
  listadas: number;
  linhasIlegiveis: number;
  repetidas: number;
  jaAtualizadas: number;
  enfileiradas: Record<MotivoReimportacao, number>;
  comFalhaHoje: number;
  alemDoLimite: number;
  truncada: boolean;
  paginacaoAmbigua: boolean;
  erroEnvelope: string | null;
}

function contagemVazia(): Contagem {
  return {
    paginas: 0,
    listadas: 0,
    linhasIlegiveis: 0,
    repetidas: 0,
    jaAtualizadas: 0,
    enfileiradas: { ...ENFILEIRADAS_ZERADAS },
    comFalhaHoje: 0,
    alemDoLimite: 0,
    truncada: false,
    paginacaoAmbigua: false,
    erroEnvelope: null,
  };
}

function resultadoDaConta(
  integracaoId: string,
  c: Contagem,
  error: string | null,
): ResultadoContaSweepDevolucoes {
  return {
    integracaoId,
    paginas: c.paginas,
    listadas: c.listadas,
    linhasIlegiveis: c.linhasIlegiveis,
    repetidas: c.repetidas,
    jaAtualizadas: c.jaAtualizadas,
    enfileiradas: { ...c.enfileiradas },
    comFalhaHoje: c.comFalhaHoje,
    alemDoLimite: c.alemDoLimite,
    truncada: c.truncada,
    paginacaoAmbigua: c.paginacaoAmbigua,
    erroEnvelope: c.erroEnvelope,
    error,
  };
}

function totalEnfileiradas(c: Contagem): number {
  return Object.values(c.enfileiradas).reduce((t, n) => t + n, 0);
}

/** What a Shopee `error` that `codigoSeguro` refuses prints as — the CLIs' wording. */
const NAO_E_CODIGO = '(não é um código)';

/**
 * A contained failure as text — ⚠️ never Shopee's own `message`: a
 * `ShopeeApiError`'s message carries it verbatim, and a refusal may quote the
 * return or order it refused. Its `error` code is the classification and is
 * enough — through `codigoSeguro`, never raw: the code is Shopee's text too,
 * and only a short token with fewer than seven digits is a code (anything else
 * could be an identifier or a sentence, and prints {@link NAO_E_CODIGO}).
 * Every other contained class builds its message from our own text — for a
 * transient enqueue, `ShopeeTasksTransientError`, a class, a code and an HTTP
 * status.
 */
function descreverErro(err: Error): string {
  if (err instanceof ShopeeApiError) {
    return `${err.name}: ${codigoSeguro(err.code) ?? NAO_E_CODIGO}`;
  }
  return `${err.name}: ${err.message}`;
}

/**
 * Whether today's code-29 failure row still HOLDS the return — step 6's skip.
 * One read of the row; a second, of the pedido, ONLY for a `deferred` one.
 *
 * - absent ⇒ `false`: nothing failed today (the store deletes a settled row).
 * - `parked` ⇒ `true`: terminal for the day. A re-drive would repeat a verdict
 *   nothing has changed, and this is what keeps a deterministically failing
 *   import at one attempt per return per UTC day.
 * - `deferred` ⇒ `true` while the return's pedido is STILL absent — the arm's
 *   own `devolucao-adiada` precondition, unchanged — and `false` once the
 *   pedido exists: the code 3 the defer enqueued usually creates it within the
 *   minute, and skipping on the row alone held the return un-imported (no
 *   incidente, no aviso, no `finalizar` block) for the rest of the UTC day
 *   while the seller's deadline ran. A row deferred for ANOTHER precondition
 *   (a dead grant, a credential, the daily quota) on a present pedido is
 *   re-tried too — at most once per tick, the price of not reading the reason
 *   string back.
 * - `failed`, or any status this module does not know ⇒ `false`: the transient
 *   lane; one more attempt is idempotent under the importer's watermark.
 *
 * A re-enqueued synthetic carries the SAME doc id as the row it ignored, so a
 * second failure is an ALREADY_EXISTS no-op (`store.ts`) and a success leaves
 * the stale row for its own lane, whose next pass resolves and removes it.
 */
async function falhaDeHojeAindaSegura(
  db: Firestore,
  docId: string,
  pedido: DocumentReference,
): Promise<boolean> {
  const falha = await notificacaoShopeeCollection.docRef(db, {}, docId).get();
  if (!falha.exists) return false;
  const status: unknown = (falha.data() as Record<string, unknown> | undefined)?.status;
  if (status === NOTIFICACAO_RESILIENCIA_STATUS.parked) return true;
  if (status !== NOTIFICACAO_RESILIENCIA_STATUS.deferred) return false;
  return !(await pedido.get()).exists;
}

function loggerDe(deps: ShopeeDevolucoesSweepDeps): SweepLogger {
  return (
    deps.logger ?? {
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        if (meta === undefined) console.warn(msg);
        else console.warn(msg, meta);
      },
    }
  );
}

async function clienteDaConta(
  db: Firestore,
  deps: ShopeeDevolucoesSweepDeps,
  integracaoId: string,
): Promise<Pick<ShopeeClient, 'getReturnList'>> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  const ctx = await loadShopeeContext(db, integracaoId);
  return ctx.createShopClient();
}

/** One readable row of a page, with what the hand-off needs. */
interface LinhaTriada {
  readonly linha: ShopeeReturnListRow;
  /** The code 29 this row would become — already through the arm's own parser. */
  readonly sintetica: ShopeeNotificationPayload;
  readonly ref: DocumentReference;
  /** The return's pedido — read only when today's failure row is `deferred`. */
  readonly pedido: DocumentReference;
}

/**
 * One conta's walk: the pages, the triage, the batched read, the enqueue.
 * Counts into `c` as it goes, so a contained failure mid-walk still reports
 * what ran.
 */
async function varrerConta(
  db: Firestore,
  deps: ShopeeDevolucoesSweepDeps,
  logger: SweepLogger,
  client: Pick<ShopeeClient, 'getReturnList'>,
  integracaoId: string,
  shopId: number,
  c: Contagem,
): Promise<void> {
  // ⚠️ ONE derivation of each clock for the whole conta: the window's end in
  // wire SECONDS, and the synthetic's day stamp in MILLISECONDS.
  const agoraS = Math.floor(deps.nowMs / 1000);
  const carimboDoDia = carimboDoDiaUtcMs(deps.nowMs);
  /** Every return_sn read this tick, across pages — the ambiguity detector. */
  const vistos = new Set<string>();

  for (let pagina = 0; ; pagina += 1) {
    // ⚠️ Update-time ONLY (register 234), the window computed once per tick and
    // sent verbatim on every page so the pages page ONE result set.
    const params: GetReturnListParams = {
      pageNo: pagina,
      pageSize: SHOPEE_RETURN_LIST_MAX_PAGE_SIZE,
      updateTimeFromS: agoraS - JANELA_DEVOLUCOES_SEGUNDOS,
      updateTimeToS: agoraS,
    };
    const envelope = await client.getReturnList(params);
    c.paginas += 1;
    if (c.paginas === 1) c.erroEnvelope = envelope.error;
    const linhas = envelope.response.return;
    c.listadas += linhas.length;

    // (4) The free triage — no read, no call.
    const triadas: LinhaTriada[] = [];
    let repetiu = false;
    for (const linha of linhas) {
      if (linha === null) {
        c.linhasIlegiveis += 1;
        continue;
      }
      const sintetica = notificacaoSinteticaDeDevolucao({
        shopId,
        orderSn: linha.order_sn,
        returnSn: linha.return_sn,
        // ⚠️ The DAY's stamp, never `nowMs` (step 6 of the header).
        nowMs: carimboDoDia,
        origem: 'reconciliacao',
      });
      // ⚠️ THE ARM'S OWN PARSER decides what it would refuse — never a second
      // copy of its rules here (#1369). A refused synthetic would only park.
      const alvo = alvoDoPushDeDevolucao(sintetica.data ?? {});
      if (!alvo.ok) {
        c.linhasIlegiveis += 1;
        continue;
      }
      if (vistos.has(alvo.returnSn)) {
        c.repetidas += 1;
        repetiu = true;
        continue;
      }
      vistos.add(alvo.returnSn);
      const pedidoId = makePedidoIdShopee(integracaoId, alvo.orderSn);
      triadas.push({
        linha,
        sintetica,
        ref: incidenteCollection.docRef(
          db,
          { pedidoId },
          idIncidenteDevolucaoShopee(alvo.returnSn),
        ),
        pedido: pedidoCollection.docRef(db, {}, pedidoId),
      });
    }

    // (5) ONE batched read per page — and none for a page with nothing to read
    // (the SDK refuses a `getAll` of zero refs).
    if (triadas.length > 0) {
      const snaps: DocumentSnapshot[] = await db.getAll(...triadas.map((t) => t.ref));
      // BY PATH, never by position.
      const porCaminho = new Map(snaps.map((s) => [s.ref.path, s]));
      for (const { linha, sintetica, ref, pedido } of triadas) {
        const snap = porCaminho.get(ref.path);
        const armazenado =
          snap?.exists === true ? (snap.data() as Record<string, unknown> | undefined) : undefined;
        const motivo = motivoDeReimportacao(linha, armazenado);
        if (motivo === null) {
          c.jaAtualizadas += 1;
          continue;
        }
        if (totalEnfileiradas(c) >= MAX_ENFILEIRADOS_DEVOLUCOES_POR_CONTA) {
          // Nothing more can be enqueued this tick; the rest of the page is
          // still CLASSIFIED (its read is already paid), never enqueued.
          c.alemDoLimite += 1;
          c.truncada = true;
          continue;
        }
        // (6) Today's failure row — a skip only while it still HOLDS the return
        // (`parked`, or `deferred` on a pedido still absent). The one-row-per-day
        // bound is the doc id's, not this read's.
        const docId = docIdOf(sintetica);
        if (docId !== null && (await falhaDeHojeAindaSegura(db, docId, pedido))) {
          c.comFalhaHoje += 1;
          continue;
        }
        await deps.scheduler.enqueue(sintetica);
        c.enfileiradas[motivo] += 1;
      }
    }

    if (repetiu) {
      // ⚠️ STOP: the page reading is not the one this loop assumes (register
      // 235), so the next page would be a guess. The rows of THIS page that were
      // new were still evaluated — each is a real return Shopee answered.
      c.paginacaoAmbigua = true;
      logger.warn(
        '[shopee/devolucoes] paginacao-ambigua — página repetiu devoluções; conta parada',
        {
          integracaoId,
          paginas: c.paginas,
          repetidas: c.repetidas,
        },
      );
      break;
    }
    // The enqueue cap: a further page would buy only counts.
    if (c.truncada) break;
    // ⚠️ `more` is the ONLY terminator — never a row count.
    if (!envelope.response.more) break;
    if (c.paginas >= MAX_PAGINAS_DEVOLUCOES_POR_CONTA) {
      c.truncada = true;
      break;
    }
  }

  if (c.linhasIlegiveis > 0) {
    // ⚠️ A schema drift must not turn the backstop into a silent no-op: one type
    // drift in a declared field nulls a whole row. Counts only — never which
    // return.
    logger.warn('[shopee/devolucoes] linhas ilegíveis — devoluções não avaliadas', {
      integracaoId,
      linhasIlegiveis: c.linhasIlegiveis,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                                  the tick                                   */
/* -------------------------------------------------------------------------- */

/**
 * One tick: the three gates, then every ACTIVE Shopee conta, contained per
 * conta — except a rate limit, which ends the tick.
 */
export async function runShopeeDevolucoesSweep(
  db: Firestore,
  deps: ShopeeDevolucoesSweepDeps,
): Promise<ResultadoSweepDevolucoes> {
  // The gates, FIRST, in this order — off ⇒ nothing is read at all. ⚠️ `?? ''`:
  // an injected env without the variable means ON, never "go read process.env".
  const valvula = (deps.env ?? process.env)[SHOPEE_DEVOLUCAO_SWEEP_DISABLED_ENV] ?? '';
  const motivo = sweepDevolucoesDesligado(valvula)
    ? MOTIVO_SWEEP_DEVOLUCOES.desligado
    : destinoDoCodigo(29) !== 'devolucao'
      ? MOTIVO_SWEEP_DEVOLUCOES.handlerAusente
      : shopeeTasksDesabilitado()
        ? MOTIVO_SWEEP_DEVOLUCOES.tasksDesabilitado
        : null;
  if (motivo !== null) {
    return { motivo, contas: [], semShopId: 0, interrompidoPorLimite: null };
  }

  const logger = loggerDe(deps);
  // The ONE `(tipo, ativo)` enumeration (`core/contas.ts` — its index exists).
  const ativas = await listarContasShopeeAtivas(db);

  const contas: ResultadoContaSweepDevolucoes[] = [];
  let semShopId = 0;
  let interrompidoPorLimite: 'burst' | 'daily' | null = null;

  for (const [indice, { integracaoId, shopId }] of ativas.entries()) {
    if (shopId === null) {
      // Main-account consent: nothing shop-signed can run. A documented state,
      // not a failure — counted, never called.
      semShopId += 1;
      continue;
    }

    const c = contagemVazia();
    try {
      const client = await clienteDaConta(db, deps, integracaoId);
      await varrerConta(db, deps, logger, client, integracaoId, shopId, c);
      contas.push(resultadoDaConta(integracaoId, c, null));
    } catch (err) {
      // ⚠️ FIRST: it extends `ShopeeApiError`, so the shared boundary below
      // would contain it and walk on into the same per-APP quota.
      if (err instanceof ShopeeRateLimitError) {
        contas.push(resultadoDaConta(integracaoId, c, descreverErro(err)));
        interrompidoPorLimite = err.kind;
        logger.warn('[shopee/devolucoes] limite da Shopee — tick interrompido', {
          integracaoId,
          limite: err.kind,
          contasNaoVarridas: ativas.length - indice - 1,
        });
        break;
      }
      // `ShopeeConfigError` is NOT in the boundary: ours, so the tick fails. A
      // transient enqueue failure is, as the real scheduler's
      // `ShopeeTasksTransientError`; the raw SDK classes are not.
      if (!erroContidoPorConta(err)) throw err;
      const descricao = descreverErro(err);
      logger.warn('[shopee/devolucoes] conta contida após falha', {
        integracaoId,
        erro: descricao,
      });
      contas.push(resultadoDaConta(integracaoId, c, descricao));
    }
  }

  return { motivo: null, contas, semShopId, interrompidoPorLimite };
}
