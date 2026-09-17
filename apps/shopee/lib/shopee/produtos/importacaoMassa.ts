/**
 * "Importar todos os anúncios" — the resumable Shopee mass product import
 * (master-plan step 9, #1517). A `running` job document
 * (`importacoesShopee`) is the single checkpoint for a Cloud Tasks-driven,
 * server-side loop that pages through the shop's catalogue
 * (`get_item_list`) and imports every listing the ERP does not already carry a
 * link for, re-enqueuing itself until the scan is exhausted and both queues
 * drain. The web UI polls the job document for progress.
 *
 * Ported from `apps/mercado-livre/lib/marketplace/mass-import/massImport.ts`,
 * which solved the same problem against a `scroll_id` cursor; every place the
 * two differ is a Shopee fact, and each one is named below.
 *
 * ## Resume model
 *
 * A dispatch scans ONE page only when BOTH queues are empty — `fila`
 * (ordinary listings) and `filaKits` (the `tag.kit` ones, drained LAST so every
 * component has already had its chance to be imported as an ordinary produto).
 * Every dispatch ends with EITHER `status` still `running` (more to scan and/or
 * drain) OR a terminal stamp, so a `running` job picked up with empty queues can
 * only mean "nothing scanned yet" or "the previous page drained" — both want the
 * same action.
 *
 * ## ⚠️ The cursor is the SERVER's
 *
 * `nextOffset` is `get_item_list`'s own `next_offset`, echoed back, and NEVER
 * `offset + page_size`: the legacy computed it locally and a catalogue mutating
 * under the walk silently skipped rows. Three refinements the wave-0 sandbox
 * probe forced (register item 66): the cursor is read only while
 * `has_next_page` is true; `has_next_page: true` with NO usable `next_offset`
 * is a TERMINAL job error rather than a silent end of the catalogue (the probe
 * measured `next_offset` ABSENT on a page with room left, so its presence is not
 * guaranteed and its absence must never read as exhaustion); and a `next_offset`
 * that does not ADVANCE past the current offset is treated as exhaustion plus
 * one log line, because a page echoing its own offset would spin the job for
 * ever. The undocumented string `next` is never read.
 *
 * ## Per-item checkpoint
 *
 * Every drained item — success OR contained failure — is merge-persisted
 * individually BEFORE the next one, so a crash mid-drain loses at most the one
 * in-flight item and a retry resumes from the persisted queue. The importer is
 * idempotent, so even a duplicate replay converges.
 *
 * ## Failures bookkeeping
 *
 * `failureCount` is an UNCAPPED running total; `failures` (the UI-facing detail
 * list) stops growing at {@link FALHAS_CAP}. `motivo` comes from
 * {@link MOTIVO_FALHA_JOB} — a PERSISTED closed vocabulary, not free text — and
 * `mensagem` is a MECHANISM sentence: never a listing name, never a URL, never a
 * body, and for a schema failure the FIELD PATHS alone (#1015).
 *
 * ## ⚠️ A rate limit is NEVER a per-item failure
 *
 * A `burst` {@link ShopeeRateLimitError} stops the drain, writes a heartbeat,
 * re-enqueues with `scheduleDelaySeconds` and answers `'continued'` — it does
 * not consume a Cloud Tasks attempt and it files no failure row. Containing it
 * would burn the remaining `fila` as "failures" during a throttle and hand the
 * operator a catalogue of broken listings that are all perfectly fine. The
 * `daily` kind is the opposite: a stamped `failed` naming the 00:00 (UTC+8)
 * reset, because there is nothing useful to retry before it.
 *
 * ## ⚠️ Clocks
 *
 * ONE clock read per dispatch, handed down to the importer as
 * `ImportarAnuncioDeps.nowMs`. {@link agoraMs} holds the **only** `Date.now()`
 * under `lib/shopee/produtos/` — every other module there takes the value as a
 * parameter, and tests inject `deps.now`. Every stamp written here is
 * MILLISECONDS; the only SECONDS in the job document are the two `…S` options,
 * which are the wire's own unit and are never compared against a stamp.
 *
 * ## ⚠️ The transaction
 *
 * {@link finalizarImportacaoShopee} is the ONE transaction of step 9 and the one
 * place in `lib/shopee/produtos/` that names the transaction API at all — the
 * `firestore-transaction-inventory` guard greps raw text, so a doc comment
 * elsewhere in this folder naming it would demand its own entry. Class **B**:
 * the decision to finalize is made outside the callback, and `status` and
 * `integracaoId` are BOTH re-derived from the `tx.get` snapshot.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_ITEM_BASE_INFO_MAX_IDS,
  SHOPEE_MAX_PAGE_SIZE,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  shopeeItemBaseInfoRowSchema,
  type ShopeeItemBaseInfo,
  type ShopeeItemListRow,
} from '@delfrance/integrations-shopee';
import {
  IMPORTACAO_SHOPEE_STATUS,
  SHOPEE_ITEM_STATUS,
  toOuterRef,
  type ImportacaoShopee,
  type ImportacaoShopeeOptions,
  type ImportacaoShopeeStatus,
  type ShopeeImportacaoFalha,
} from '@delfrance/schemas';
import {
  importacaoShopeeCollection,
  integracaoCollection,
  produtoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';

import { tryGetAdminBucket } from '../../firebase/admin';
import { criarMemoDeCategorias } from './categoriaShopee';
import { isGrpcCodedError } from '../core/containment';
import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { ShopeeContaNotConfiguredError, loadShopeeContext } from '../core/shopee';
import { ShopeeContaSemShopIdError, ShopeeSemCredencialError } from '../core/tokenStore';
import {
  MOTIVO_FALHA_JOB,
  MOTIVO_IMPORT_BLOQUEADO,
  ShopeeImportBlockedError,
  ShopeeMassImportTasksDisabledError,
  type MotivoFalhaJob,
} from './errosImportacao';
import {
  ehKitDe,
  montarItemLido,
  temModelosDe,
  type ContextoImportacaoShopee,
  type DespachoImportacaoShopee,
  type ImportacaoShopeeDeps,
  type ImportacaoShopeeTaskPayload,
  type ImportarAnuncioDeps,
  type ItemLido,
} from './itemLido';
import { criarMemoDeGrupos } from './taxonomiaShopee';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The deployed `onTaskDispatched` name — which is ALSO its auto-provisioned
 * Cloud Tasks queue name. Single source of truth, placed in this neutral core
 * module (not the scheduler) so the scheduler can import it without this module
 * ever depending on the Functions SDK — `SHOPEE_NOTIFICATION_QUEUE`'s placement
 * in `notificacoes/notificacao.ts`, and ML's in `massImport.ts`. `index.ts`
 * asserts the pair at module load.
 */
export const SHOPEE_MASS_IMPORT_QUEUE = 'processShopeeMassImport';

/** In-task retry cap — kept in sync with the function's `retryConfig.maxAttempts`. */
export const MAX_TENTATIVAS = 3;

/**
 * Items drained per dispatch WITH photos on.
 *
 * Budget arithmetic against the function's 300 s timeout, stated rather than
 * discovered: job read + context ≈ 0.3 s; the scan page (1 GET + ≤ 4 chunked
 * group queries) ≈ 2.0 s; the batched `get_item_base_info` ≈ 2.0 s; then PER
 * ITEM `get_model_list` ≤ 1.5 s, the write half (two group queries, ≤ 2 sku
 * probes, the produto, estoque, precos, the links and up to 50 children) ≤ 4.0 s,
 * the photo unit (up to 9 images × download + `putArquivoAdmin`) ≤ 14.0 s and the
 * checkpoint ≤ 0.2 s — ≈ 20 s worst case. `10 × 20 + 2.3` ≈ **205 s of 300**,
 * about 30 % headroom.
 *
 * ⚠️ The quota consequence, stated rather than discovered: a shop of N simple
 * items costs `ceil(N/10)` `get_item_base_info` calls, not `ceil(N/50)` — five
 * times the batch quota on the only call a no-variation catalogue needs. That is
 * the price of a 300 s ladder plus a per-item photo unit, and this is the ONE
 * constant to raise once a rehearsal measures a real per-item time (register
 * item 55).
 */
export const ITENS_POR_DESPACHO = 10;

/**
 * …and with `importarFotos: false`, where the photo unit disappears and the
 * per-item worst case collapses to ≈ 5.7 s: `40 × 5.7 + 2.3` ≈ **231 s**, the
 * same headroom. Both caps stay ≤ {@link SHOPEE_ITEM_BASE_INFO_MAX_IDS}, so a
 * drain is always ONE batched read.
 */
export const ITENS_POR_DESPACHO_SEM_FOTOS = 40;

/** `failures` list cap; `failureCount` is never capped (see the module doc). */
export const FALHAS_CAP = 100;

/** Firestore's own `where(field, 'in', values)` cap — chunks the skip-filter. */
export const LINK_QUERY_CHUNK = 30;

/** The re-enqueue delay for a burst rate limit that carried no `Retry-After`. */
export const PAUSA_BURST_PADRAO_S = 60;

/**
 * Loop belt: a scan that somehow never exhausts stops here (100 000 rows at
 * page_size 100). `scanned` makes it observable; in practice the documented
 * `get_item_list` offset cap terminates first.
 */
export const PAGINAS_MAX_POR_JOB = 1000;

/** The Cloud Tasks body. `.passthrough()` so a future field cannot drop a task. */
export const importacaoShopeeTaskSchema = z
  .object({ jobId: z.string().min(1), integracaoId: z.string().min(1) })
  .passthrough();

/* -------------------------------------------------------------------------- */
/*  Operator-facing sentences (asserted by tests, so they live as constants)   */
/* -------------------------------------------------------------------------- */

/** The documented `error_param` of `get_item_list`, folded (see {@link ehOffsetAcimaDoLimite}). */
const TEXTO_OFFSET_ACIMA_DO_LIMITE = 'offset over limit';

export const MSG_OFFSET_ACIMA_DO_LIMITE =
  'A Shopee recusou a varredura com error_param: o offset passou do limite desta página. ' +
  'Reinicie a importação com uma janela update_time mais estreita ' +
  '(updateTimeFromS/updateTimeToS) — é a mitigação documentada para esse teto.';

export const MSG_CURSOR_AUSENTE =
  'A Shopee respondeu has_next_page: true sem um next_offset utilizável, então não há como ' +
  'pedir a próxima página. A varredura foi encerrada em vez de ser dada por concluída — ' +
  'reinicie a importação, se possível com uma janela update_time.';

export const MSG_PAGINAS_MAX =
  `A varredura passou de ${String(PAGINAS_MAX_POR_JOB)} páginas sem se esgotar e foi encerrada ` +
  'pelo cinto de segurança. Reinicie com uma janela update_time mais estreita.';

export const MSG_LIMITE_DIARIO =
  'A Shopee recusou a chamada por limite DIÁRIO de requisições (error_limit). A cota reinicia ' +
  'às 00:00 (UTC+8); reinicie a importação depois disso — não adianta tentar de novo antes.';

export const MSG_VALVULA_FECHADA =
  'SHOPEE_TASKS_DISABLED=1 — não foi possível reenfileirar o próximo despacho e não existe ' +
  'sweep por trás deste caminho, então o job foi encerrado em vez de ser abandonado em silêncio.';

const MSG_LOTE_DESCONHECIDO =
  'A Shopee respondeu error_item_not_found para o lote inteiro de get_item_base_info.';

const MSG_ITEM_NAO_RETORNADO =
  'O item foi pedido neste lote de get_item_base_info e não veio na resposta.';

/**
 * The same verdict, plus the count of rows the payload schema could not read.
 *
 * ⚠️ ONE verdict for two causes on purpose. `shopeeItemBaseInfoPayloadSchema` is
 * tolerant per ELEMENT, so a row whose wire shape disagrees with a declared type
 * arrives as `null` and is dropped — which is indistinguishable, per id, from a
 * row the response simply omitted, because the sentinel keeps no `item_id`. The
 * COUNT is the only diagnosis a per-element `.catch` leaves, which is exactly
 * what step 7's `rastrearPedido.ts` puts in its park reason for the sibling
 * batched op.
 */
function msgItemNaoRetornado(ilegiveis: number): string {
  if (ilegiveis === 0) return MSG_ITEM_NAO_RETORNADO;
  return (
    `${MSG_ITEM_NAO_RETORNADO.slice(0, -1)} ` + `(linhas ilegíveis no lote: ${String(ilegiveis)}).`
  );
}

const MSG_KIT_SEM_DETALHE = 'get_kit_item_info respondeu sem product_info para este kit.';

/* -------------------------------------------------------------------------- */
/*  Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * {@link iniciarImportacaoShopee}'s guard: this conta already has a `running`
 * job. ONE run per conta at a time, with no staleness bound — which is exactly
 * why `cancelarImportacaoShopee` exists (a job whose task never dispatched would
 * otherwise 409 the button for ever).
 */
export class ShopeeImportacaoEmAndamentoError extends ShopeeError {
  constructor(message: string) {
    super(message);
    this.name = 'ShopeeImportacaoEmAndamentoError';
  }
}

/**
 * INTERNAL: a condition that ends the job right here, without spending the Cloud
 * Tasks ladder on a call that will fail identically three times. Never exported
 * and never thrown across a module boundary — its `message` is the operator
 * sentence stamped on `erro`.
 */
class FalhaTerminalDoJob extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FalhaTerminalDoJob';
  }
}

/* -------------------------------------------------------------------------- */
/*  Small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ The ONE `Date.now()` under `lib/shopee/produtos/`, and it is a DEFAULT: the
 * dispatch reads it once and hands the value down, tests inject `deps.now`, and
 * every other module in this folder takes the clock as a parameter.
 *
 * ⚠️ The "only one" is a real gate, not a promise: `importacaoMassa.test.ts`'s
 * «o relógio é lido em UM único módulo» reads every non-test source of
 * `lib/shopee/produtos/` off disk and fails if a second one calls the clock
 * outside a comment. Before it existed nothing enforced this sentence.
 */
function agoraMs(): number {
  return Date.now();
}

/**
 * A row the options never asked for, carrying a DELETE status.
 *
 * Filtered in the scan AND refused again per item by the importer — belt and
 * braces, because a produto minted from a deleted listing has nothing that ever
 * removes it, and a deleted listing stays readable for 90 days.
 */
function ehStatusDeletado(status: string | null): boolean {
  return status === SHOPEE_ITEM_STATUS.sellerDelete || status === SHOPEE_ITEM_STATUS.shopeeDelete;
}

/**
 * The offset-cap fold.
 *
 * `error_param` is a GENERIC Shopee code, so the terminal-vs-retry decision has
 * to read the envelope message. Equal: the documented sentence `get items offset
 * over limit, please use the next field` in any capitalisation or spacing.
 * ⛔ Distinct: an `error_param` carrying `Item status error.` — which must THROW
 * and be retried, not stamp the job `failed`. The near-miss is pinned in
 * `importacaoMassa.test.ts`.
 *
 * ⚠️ No `equivalence-fold-inventory` entry is owed: that guard keys on a
 * word-bounded list of thirteen SHARED helpers and this fold names none of them,
 * so an entry would be a stale entry and would red CI.
 */
function ehOffsetAcimaDoLimite(mensagem: string): boolean {
  return mensagem.toLowerCase().replace(/\s+/g, ' ').includes(TEXTO_OFFSET_ACIMA_DO_LIMITE);
}

/**
 * The classes a retry cannot fix. Each one stamps the job `failed` on the FIRST
 * attempt rather than spending three dispatches reaching the same verdict: a
 * dead grant cannot be re-minted by waiting, a conta of the wrong `tipo` will not
 * become Shopee, a missing `SHOPEE_PARTNER_*` is OUR misconfiguration, and a
 * closed task valve has no sweep behind it.
 *
 * ⚠️ `ShopeeReauthRequiredError` is a `ShopeeApiError` subclass, so this
 * predicate is consulted only AFTER the rate-limit arms have had their say.
 */
function ehFalhaDePrimeiraTentativa(err: unknown): boolean {
  return (
    err instanceof ShopeeReauthRequiredError ||
    err instanceof ShopeeSemCredencialError ||
    err instanceof ShopeeContaNotConfiguredError ||
    err instanceof ShopeeContaSemShopIdError ||
    err instanceof ShopeeCredencialInvalidaError ||
    err instanceof ShopeeConfigError ||
    err instanceof ShopeeMassImportTasksDisabledError
  );
}

/**
 * A schema failure's operator sentence: the FIELD PATHS, joined — never a value
 * from the body (#1015). A body that did not even parse carries no paths, which
 * is itself the message.
 */
function resumirCamposDoSchema(err: ShopeeSchemaError): string {
  return err.campos.length > 0
    ? `campos fora do schema: ${err.campos.join(', ')}`
    : 'o corpo da resposta não casou com o schema (nenhum caminho de campo informado)';
}

/** A log detail for a value that may not be an `Error` at all. Never a payload. */
function detalheDeErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * ONE listing's contained verdict, or `null` for "this is not this listing's
 * fault — rethrow it".
 *
 * ⚠️ The Shopee arm tests `kind === 'other'` and not `instanceof ShopeeApiError`
 * alone: a burst rate limit, a daily rate limit and a reauth are ALL
 * `ShopeeApiError` subclasses, and none of the three is a property of the
 * listing being drained. Containing a burst would burn the remaining `fila` as
 * "failures" during a throttle.
 */
function classificarFalhaDeItem(err: unknown): { motivo: MotivoFalhaJob; mensagem: string } | null {
  if (err instanceof ShopeeImportBlockedError) {
    return { motivo: err.motivo, mensagem: err.mensagem };
  }
  if (err instanceof ShopeeSchemaError) {
    return { motivo: MOTIVO_FALHA_JOB.erroSchema, mensagem: resumirCamposDoSchema(err) };
  }
  if (err instanceof ShopeeApiError && err.kind === SHOPEE_ERROR_KIND.other) {
    return { motivo: MOTIVO_FALHA_JOB.erroShopee, mensagem: `${err.name}: ${err.code}` };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Start / finalize / cancel                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create a fresh mass-import job for `integracaoId`.
 *
 * ⚠️ **It does not enqueue.** The route does, AFTER this resolves, so an enqueue
 * failure has a job document to stamp `failed` instead of leaving the operator
 * with a 503 and nothing to look at.
 */
export async function iniciarImportacaoShopee(
  db: Firestore,
  args: { integracaoId: string; options: ImportacaoShopeeOptions; now?: number },
): Promise<string> {
  const emAndamento = await importacaoShopeeCollection
    .ref(db, {})
    .where('integracaoId', '==', args.integracaoId)
    .where('status', '==', IMPORTACAO_SHOPEE_STATUS.running)
    .limit(1)
    .get();
  // `docs.length`, not `.empty`: the same fact, and it is the one both the Admin
  // SDK's QuerySnapshot and every in-memory double in this app expose.
  if (emAndamento.docs.length > 0) {
    throw new ShopeeImportacaoEmAndamentoError(
      `já existe uma importação em massa em andamento para a integração ${args.integracaoId}`,
    );
  }

  const nowMs = args.now ?? agoraMs();
  const jobId = importacaoShopeeCollection.newDocId(db, {});
  await importacaoShopeeCollection.set(db, {}, jobId, {
    integracaoId: args.integracaoId,
    status: IMPORTACAO_SHOPEE_STATUS.running,
    nextOffset: null,
    fila: [],
    filaKits: [],
    scanned: 0,
    imported: 0,
    created: 0,
    skipped: 0,
    kits: 0,
    failureCount: 0,
    failures: [],
    options: args.options,
    startedAt: nowMs,
    updatedAt: nowMs,
    finishedAt: null,
    erro: null,
  });
  return jobId;
}

/** What a terminal stamp actually did — see {@link finalizarImportacaoShopee}. */
export type ResultadoFinalizacaoImportacaoShopee =
  | 'stamped'
  | 'not-running'
  | 'not-found'
  | 'wrong-integracao';

/**
 * The fields a terminal stamp may write. `status` is terminal by construction.
 *
 * A type ALIAS rather than an interface, deliberately: only an alias gets the
 * implicit index signature that makes it assignable to the
 * `Record<string, unknown>` the handle's `parseMerge` takes.
 */
export type ImportacaoShopeeTerminalPatch = {
  status: Exclude<ImportacaoShopeeStatus, 'running'>;
  erro?: string | null;
  finishedAt: number;
  updatedAt: number;
};

/**
 * Stamp a terminal state on a job **only while it is still `running`**.
 *
 * There are two writers of `status` and they do not coordinate: the task handler
 * finishing a dispatch (`completed`, or `failed` for a daily rate limit, a
 * terminal scan error or a first-attempt class), and the operator's
 * `importar-todos/cancelar` route stamping `cancelled` at any moment — including
 * mid-drain. A plain `merge()` from the handler would silently bury a cancel
 * that landed while the dispatch was draining: the classic lost update of root
 * `CLAUDE.md` rule 7.
 *
 * Class **B**: the decision to finalize is made OUTSIDE the callback, so the
 * guard is named and explicit — `status` and `integracaoId` are both re-derived
 * from the `tx.get` snapshot and the write only happens on that fresh read. An
 * OCC retry re-runs both checks, so a concurrent winner turns this into a
 * `'not-running'` no-op instead of a clobber. Nothing else in the patch comes
 * from the read.
 *
 * ⚠️ The write is `tx.update`, never `tx.set(..., { merge: true })`: the document
 * was just proved to exist, `update` is the verb that says so, and it is the
 * spelling every other transaction in this app uses.
 *
 * `expectIntegracaoId` is the ownership check for the cancel route: a caller may
 * only finalize a job belonging to the conta it named.
 */
export async function finalizarImportacaoShopee(
  db: Firestore,
  jobId: string,
  patch: ImportacaoShopeeTerminalPatch,
  expectIntegracaoId?: string,
): Promise<ResultadoFinalizacaoImportacaoShopee> {
  const ref = importacaoShopeeCollection.docRef(db, {}, jobId);
  return db.runTransaction<ResultadoFinalizacaoImportacaoShopee>(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'not-found';
    const job = importacaoShopeeCollection.parseRead(
      snap.data(),
      importacaoShopeeCollection.docPath({}, jobId),
    );
    if (expectIntegracaoId != null && job.integracaoId !== expectIntegracaoId) {
      return 'wrong-integracao';
    }
    if (job.status !== IMPORTACAO_SHOPEE_STATUS.running) return 'not-running';
    tx.update(ref, importacaoShopeeCollection.parseMerge(patch));
    return 'stamped';
  });
}

/**
 * Operator-initiated cancel — the job card's close button.
 *
 * The handler needs no cooperation: it re-reads the job at the top of every
 * dispatch and answers `'noop'` the moment the status is not `running`, and it
 * re-checks once more before re-enqueuing, so it does not even pay for that one.
 * Cancelling is also the recovery for a job whose task never dispatched at all.
 */
export async function cancelarImportacaoShopee(
  db: Firestore,
  args: { jobId: string; integracaoId: string; now?: number },
): Promise<ResultadoFinalizacaoImportacaoShopee> {
  const nowMs = args.now ?? agoraMs();
  return finalizarImportacaoShopee(
    db,
    args.jobId,
    {
      status: IMPORTACAO_SHOPEE_STATUS.cancelled,
      erro: null,
      finishedAt: nowMs,
      updatedAt: nowMs,
    },
    args.integracaoId,
  );
}

/* -------------------------------------------------------------------------- */
/*  Context + the skip-filter                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Production `resolverContexto` — the same assembly the single-item route does.
 *
 * ⚠️ ONE resolution per dispatch, and `createShopClient()` hands the package a
 * token FUNCTION rather than a token string, so a shop token that lapses in the
 * middle of a catalogue walk is renewed rather than replayed dead.
 *
 * ⚠️ A missing Storage bucket NAME degrades to "skip photos" for the whole run
 * rather than failing it: all three resolution tiers being unset is a backend
 * misconfiguration, never a per-item concern, and `tryGetAdminBucket` makes it a
 * null-return (no catch at all), so genuine Storage failures still propagate.
 */
const resolverContextoPadrao = async (
  db: Firestore,
  integracaoId: string,
): Promise<ContextoImportacaoShopee> => {
  const ctx = await loadShopeeContext(db, integracaoId);
  return {
    client: ctx.createShopClient(),
    integracaoId,
    tabelaNormalOuterRef: ctx.conta.tabelaNormalOuterRef,
    // ⚠️ Carried and never written — the import prices to the NORMAL table only
    // (#803's stance, taken again here). The slot exists so the rejected arm is
    // legible rather than absent.
    tabelaPromocionalOuterRef: ctx.conta.tabelaPromocionalOuterRef,
    depositoOuterRef: ctx.conta.depositoOuterRef,
    bucket: tryGetAdminBucket() ?? undefined,
  };
};

/**
 * Which of `ids` already carry a `prodshopee` link for THIS conta — the
 * skip-filter for a plain re-scan (`atualizarCadastrados` off).
 *
 * ⚠️ BOTH clauses go to the SERVER, unlike the Mercado Livre twin, which filters
 * the conta in memory: the Shopee link document carries its own conta ref, and
 * the composite `prodshopee (item_id ASC, contaProdutoShopeeOuterRef ASC)` is
 * declared for exactly this shape (`INDICES_COMPOSTOS_SHOPEE` in
 * `pedidos/produtoResolve.ts` is the same pair, and the test pins these two
 * field names against it). The chunk size is Firestore's own `in` cap.
 *
 * ⚠️ Whether Enterprise really serves `in` + `==` from that two-field composite
 * without a full scan is register item 59 — Firestore permutes EQUALITY fields
 * freely, and "an `in` is a disjunction of equalities" is our inference, not the
 * documentation's text. If a live scan ever shows a full-scan bill, the named
 * fallback is Mercado Livre's exact shape (`in` alone, the conta filtered in
 * memory), which needs a single-field `item_id` index instead.
 *
 * ⛔ Two things this deliberately does NOT match: the same `item_id` under
 * ANOTHER conta (never skipped — the legacy dedup had no conta filter and
 * cross-bound two accounts), and an `item_id` the legacy corpus stored as the
 * STRING `"2500139861"` (a numeric `in` does not return it, so the item is
 * imported and a second link document is minted — the accepted cost; a string
 * probe per chunk would double the query bill for a shape nothing writes today).
 */
async function idsJaVinculados(
  db: Firestore,
  ids: readonly number[],
  integracaoId: string,
): Promise<Set<number>> {
  const contaRef = toOuterRef(integracaoCollection.docPath({}, integracaoId));
  const vistos = new Set<number>();
  for (let i = 0; i < ids.length; i += LINK_QUERY_CHUNK) {
    const chunk = ids.slice(i, i + LINK_QUERY_CHUNK);
    if (chunk.length === 0) continue;
    const snap = await produtoShopeeLinkCollection
      .groupQuery(db)
      .where('item_id', 'in', chunk)
      .where('contaProdutoShopeeOuterRef', '==', contaRef)
      .get();
    for (const d of snap.docs) {
      const raw = d.data() as Record<string, unknown>;
      if (typeof raw.item_id === 'number') vistos.add(raw.item_id);
    }
  }
  return vistos;
}

async function lerJob(db: Firestore, jobId: string): Promise<ImportacaoShopee | null> {
  const snap = await importacaoShopeeCollection.docRef(db, {}, jobId).get();
  if (!snap.exists) return null;
  return importacaoShopeeCollection.parseRead(
    snap.data(),
    importacaoShopeeCollection.docPath({}, jobId),
  );
}

/* -------------------------------------------------------------------------- */
/*  The dispatch                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Process one `processShopeeMassImport` dispatch: resume the job, scan at most
 * one page when both queues are empty, drain up to {@link ITENS_POR_DESPACHO}
 * items (ordinary listings first, kits last), then either re-enqueue
 * (`'continued'`) or stamp `completed` (`'done'`).
 *
 * `retryCount` is the Cloud Tasks attempt index (0-based): on the FINAL attempt
 * an otherwise-fatal error is persisted as `status: 'failed'` instead of being
 * re-thrown, mirroring `notificacoes/notificacao.ts`'s task handler — including
 * tolerating (and logging) a secondary failure while stamping it, which never
 * masks the original cause.
 *
 * ⚠️ `deps.importarAnuncio` / `deps.importarKit` are REQUIRED whenever there is
 * matching work: this module never dynamic-imports the importer, so its own
 * suite never loads that graph and the two build waves run in parallel. A
 * missing one is a programming error and THROWS, exactly like a missing
 * scheduler — it is never contained as a listing's failure.
 */
export async function processarImportacaoShopee(
  deps: ImportacaoShopeeDeps,
  payload: ImportacaoShopeeTaskPayload,
  retryCount: number,
): Promise<DespachoImportacaoShopee> {
  const { db } = deps;
  const { jobId, integracaoId } = payload;
  const nowMs = deps.now ? deps.now() : agoraMs();
  const resolverContexto = deps.resolverContexto ?? resolverContextoPadrao;

  const job = await lerJob(db, jobId);
  if (!job || job.status !== IMPORTACAO_SHOPEE_STATUS.running) return 'noop';

  let fila = [...job.fila];
  let filaKits = [...job.filaKits];
  let nextOffset = job.nextOffset;
  let scanned = job.scanned;
  let skipped = job.skipped;
  let kits = job.kits;
  let imported = job.imported;
  let created = job.created;
  let failureCount = job.failureCount;
  let failures: ShopeeImportacaoFalha[] = [...job.failures];

  const checkpoint = async (patch: Record<string, unknown>): Promise<void> => {
    await importacaoShopeeCollection.merge(db, {}, jobId, patch);
  };

  const estadoDoDreno = (): Record<string, unknown> => ({
    fila,
    filaKits,
    imported,
    created,
    kits,
    failureCount,
    failures,
    updatedAt: nowMs,
  });

  const conter = (itemId: number, motivo: MotivoFalhaJob, mensagem: string): void => {
    failureCount += 1;
    // ⚠️ `failureCount` keeps rising past the cap on purpose: the list is a UI
    // budget, the count is the truth.
    if (failures.length < FALHAS_CAP) failures = [...failures, { itemId, motivo, mensagem }];
  };

  const carimbarFalha = async (erro: string): Promise<void> => {
    try {
      await finalizarImportacaoShopee(db, jobId, {
        status: IMPORTACAO_SHOPEE_STATUS.failed,
        erro,
        finishedAt: nowMs,
        updatedAt: nowMs,
      });
    } catch (persistErr) {
      // ⚠️ Tolerated and logged, and NEVER rethrown: this runs inside the
      // dispatch's own catch, so a throw here would replace the original cause
      // with the symptom — the exact masking the final-attempt rule forbids. The
      // realistic arrivals are a Firestore/gRPC failure and a `ShopeeError` from
      // the handle's own read; anything else is still reported, as text.
      const detalhe =
        isGrpcCodedError(persistErr) || persistErr instanceof ShopeeError
          ? persistErr.message
          : detalheDeErro(persistErr);
      console.error('[shopee/importacao] falha ao carimbar a importação em massa como failed', {
        jobId,
        integracaoId,
        causa: erro,
        persistErro: detalhe,
      });
    }
  };

  try {
    const ctx = await resolverContexto(db, integracaoId);

    /** Built ONCE per dispatch and reused for every item — the seam's own rule
     *  (`nowMs` is one clock read, handed down) and the hook the per-dispatch
     *  `grupos` memo plugs into when the taxonomy half fills that slot. */
    const depsDoImportador: ImportarAnuncioDeps = {
      db,
      integracaoId: ctx.integracaoId,
      tabelaNormalOuterRef: ctx.tabelaNormalOuterRef,
      tabelaPromocionalOuterRef: ctx.tabelaPromocionalOuterRef,
      depositoOuterRef: ctx.depositoOuterRef,
      ...(ctx.bucket !== undefined ? { bucket: ctx.bucket } : {}),
      options: job.options,
      nowMs,
      // ⚠️ The two per-DISPATCH memos, built HERE because this object is built
      // once per dispatch and every item shares it. Both are LAZY and
      // single-flight: `grupos` performs one full `grupoDeVariacoes` read on the
      // first item that has models (and none at all for a catalogue of simple
      // listings), `categorias` one TTL-cached tree read on the first item whose
      // category has to be resolved. Building either per ITEM would multiply the
      // cost by the page size on a database that bills DATA SCANNED.
      grupos: criarMemoDeGrupos(db),
      categorias: criarMemoDeCategorias(ctx.client, ctx.integracaoId),
    };

    /* ---------------------------- (a) one scan page --------------------- */
    if (fila.length === 0 && filaKits.length === 0) {
      if (scanned >= PAGINAS_MAX_POR_JOB * SHOPEE_MAX_PAGE_SIZE) {
        throw new FalhaTerminalDoJob(MSG_PAGINAS_MAX);
      }
      const offset = nextOffset ?? 0;

      let pagina;
      try {
        pagina = await ctx.client.getItemList({
          offset,
          pageSize: SHOPEE_MAX_PAGE_SIZE,
          statuses: job.options.statuses,
          ...(job.options.updateTimeFromS !== null
            ? { updateTimeFromS: job.options.updateTimeFromS }
            : {}),
          ...(job.options.updateTimeToS !== null
            ? { updateTimeToS: job.options.updateTimeToS }
            : {}),
        });
      } catch (err) {
        if (
          err instanceof ShopeeApiError &&
          err.code === 'error_param' &&
          ehOffsetAcimaDoLimite(err.message)
        ) {
          throw new FalhaTerminalDoJob(MSG_OFFSET_ACIMA_DO_LIMITE);
        }
        throw err;
      }

      const linhas: readonly ShopeeItemListRow[] = pagina.item;
      // ⚠️ EVERY row of the page, including the ones filtered below: `scanned`
      // answers "how much catalogue did we walk", never "how much did we import".
      scanned += linhas.length;

      const vivas = linhas.filter((l) => !ehStatusDeletado(l.item_status));
      skipped += linhas.length - vivas.length;

      // `tag.kit` is the ONLY kit-discovery channel Shopee offers (there is no
      // kit listing endpoint), and at scan time the scan ROW is the only tag we
      // hold — the base-info read has not happened yet.
      const ehKitDaLinha = (l: ShopeeItemListRow): boolean => ehKitDe({ tag: null }, l);
      const idsKit = vivas.filter(ehKitDaLinha).map((l) => l.item_id);
      const idsSimples = vivas.filter((l) => !ehKitDaLinha(l)).map((l) => l.item_id);

      let novos = idsSimples;
      let novosKits = idsKit;
      if (!job.options.atualizarCadastrados) {
        const jaLigados = await idsJaVinculados(db, [...idsSimples, ...idsKit], integracaoId);
        skipped += jaLigados.size;
        novos = idsSimples.filter((id) => !jaLigados.has(id));
        novosKits = idsKit.filter((id) => !jaLigados.has(id));
      }

      // THE cursor rule — see the module header.
      if (!pagina.has_next_page) {
        nextOffset = null;
      } else if (pagina.next_offset == null) {
        throw new FalhaTerminalDoJob(MSG_CURSOR_AUSENTE);
      } else if (pagina.next_offset <= offset) {
        console.warn(
          '[shopee/importacao] next_offset não avançou; tratando a varredura como esgotada',
          { jobId, integracaoId, offset, nextOffset: pagina.next_offset },
        );
        nextOffset = null;
      } else {
        nextOffset = pagina.next_offset;
      }

      fila = novos;
      filaKits = novosKits;
      await checkpoint({ nextOffset, fila, filaKits, scanned, skipped, updatedAt: nowMs });
    }

    /* ------------------------------ (b) the drain ------------------------ */
    const cap = job.options.importarFotos ? ITENS_POR_DESPACHO : ITENS_POR_DESPACHO_SEM_FOTOS;
    let drenados = 0;

    if (fila.length > 0) {
      const importarAnuncio = deps.importarAnuncio;
      if (!importarAnuncio) {
        throw new Error(
          'processarImportacaoShopee: há anúncios na fila mas nenhum importarAnuncio foi injetado ' +
            'nas deps — o job nunca carrega o grafo do importador por conta própria.',
        );
      }
      // ONE batched read per dispatch; both caps are ≤ the wire's own 50.
      const lote = fila.slice(0, Math.min(cap, SHOPEE_ITEM_BASE_INFO_MAX_IDS));

      let corpos: ShopeeItemBaseInfo | null = null;
      try {
        corpos = await ctx.client.getItemBaseInfo({ itemIds: lote });
      } catch (err) {
        // A BATCH `error_item_not_found` fires only when EVERY id of the call is
        // unknown (step 8 measured the same order analogue) — so every id of the
        // batch is the verdict, and the drain moves on instead of dying.
        if (
          err instanceof ShopeeApiError &&
          err.kind === SHOPEE_ERROR_KIND.other &&
          err.code === 'error_item_not_found'
        ) {
          fila = fila.slice(lote.length);
          drenados += lote.length;
          for (const itemId of lote) {
            conter(itemId, MOTIVO_FALHA_JOB.itemNaoEncontrado, MSG_LOTE_DESCONHECIDO);
          }
          await checkpoint(estadoDoDreno());
        } else {
          throw err;
        }
      }

      if (corpos !== null) {
        // ⚠️ Reconciled BY `item_id`, never by position: the response may carry
        // FEWER rows than were asked for, and a by-position read would import one
        // listing's data onto another listing's produto — silently, and only for
        // the items after the gap.
        // ⚠️ And per ELEMENT: a row the payload schema could not read arrives as
        // `null` and is dropped HERE, so one listing's wire shape costs that
        // listing a contained failure row instead of costing the whole dispatch
        // a throw — which, on the last attempt, would end the job `failed` with
        // the other items of this batch never imported and no row naming
        // anybody. The count rides the verdict's sentence.
        const legiveis = corpos.item_list.filter((r) => r !== null);
        const ilegiveis = corpos.item_list.length - legiveis.length;
        const porId = new Map(legiveis.map((r) => [r.item_id, r]));
        for (const itemId of lote) {
          fila = fila.slice(1);
          drenados += 1;
          try {
            if (!porId.has(itemId)) {
              throw new ShopeeImportBlockedError(
                MOTIVO_IMPORT_BLOQUEADO.itemNaoRetornado,
                itemId,
                msgItemNaoRetornado(ilegiveis),
              );
            }
            const semModelos = montarItemLido({ itemId, payload: corpos });
            const modelos = temModelosDe(semModelos)
              ? await ctx.client.getModelList({ itemId })
              : null;
            const item =
              modelos !== null ? montarItemLido({ itemId, payload: corpos, modelos }) : semModelos;

            const res = await importarAnuncio(depsDoImportador, item);
            imported += 1;
            if (res.criado) created += 1;
          } catch (err) {
            const falha = classificarFalhaDeItem(err);
            if (falha === null) throw err; // infra, a rate limit, a reauth — not this listing
            conter(itemId, falha.motivo, falha.mensagem);
          }
          // Per-item checkpoint — a crash right after this write resumes from
          // exactly here.
          await checkpoint(estadoDoDreno());
        }
      }
    }

    /* --------------------- (b2) the kits, drained LAST ------------------- */
    if (fila.length === 0 && filaKits.length > 0 && drenados < cap) {
      const importarKit = deps.importarKit;
      if (!importarKit) {
        throw new Error(
          'processarImportacaoShopee: há kits na fila mas nenhum importarKit foi injetado nas ' +
            'deps — o job nunca carrega o grafo do importador por conta própria.',
        );
      }
      while (filaKits.length > 0 && drenados < cap) {
        const itemId = filaKits[0]!;
        filaKits = filaKits.slice(1);
        drenados += 1;
        try {
          // ⚠️ `get_kit_item_info`, never `get_item_base_info`: what the item
          // read answers for a `tag.kit` listing is UNVERIFIED (register item
          // 57), and routing kits through their own read makes the kit arm
          // independent of that unknown.
          const detalhe = await ctx.client.getKitItemInfo({ itemId });
          const produto = detalhe.product_info;
          if (produto === null) {
            throw new ShopeeImportBlockedError(
              MOTIVO_IMPORT_BLOQUEADO.kitSemDetalhe,
              itemId,
              MSG_KIT_SEM_DETALHE,
            );
          }
          // The kit importer reads `entrada.kit`; `base` carries the id and the
          // `tag` that says what this is, built through the package's OWN row
          // schema so the shape is never this module's invention.
          const item: ItemLido = {
            base: shopeeItemBaseInfoRowSchema.parse({ item_id: itemId, tag: { kit: true } }),
            models: null,
            taxInfo: null,
            kit: produto,
            itemId,
          };
          const res = await importarKit(depsDoImportador, item);
          imported += 1;
          if (res.criado) created += 1;
          // `kits` counts kit listings the importer COMPLETED (create or
          // update); `created` already separates the two, and `res.kit.criado`
          // is the importer's own finer-grained answer for the route body.
          kits += 1;
        } catch (err) {
          const falha = classificarFalhaDeItem(err);
          if (falha === null) throw err; // infra, a rate limit, a reauth — not this kit
          conter(itemId, falha.motivo, falha.mensagem);
        }
        await checkpoint(estadoDoDreno());
      }
    }

    /* ----------------------- (c) continue or complete -------------------- */
    if (fila.length > 0 || filaKits.length > 0 || nextOffset != null) {
      if (!deps.scheduler) {
        throw new Error(
          'processarImportacaoShopee: há trabalho pendente mas nenhum scheduler foi fornecido ' +
            'para reenfileirar o job.',
        );
      }
      // A cancel that landed while this dispatch was draining must not buy one
      // more. The next dispatch would stop at the status gate anyway — this just
      // declines to pay for it.
      const atual = await lerJob(db, jobId);
      if (!atual || atual.status !== IMPORTACAO_SHOPEE_STATUS.running) return 'noop';
      await deps.scheduler.enqueue({ jobId, integracaoId });
      return 'continued';
    }

    // Guarded, not a plain merge: a cancel may have landed mid-drain and
    // `completed` must not overwrite it (rule 7).
    const carimbo = await finalizarImportacaoShopee(db, jobId, {
      status: IMPORTACAO_SHOPEE_STATUS.completed,
      finishedAt: nowMs,
      updatedAt: nowMs,
    });
    return carimbo === 'stamped' ? 'done' : 'noop';
  } catch (err) {
    if (err instanceof FalhaTerminalDoJob) {
      await carimbarFalha(err.message);
      return 'failed';
    }

    if (err instanceof ShopeeRateLimitError) {
      if (err.kind === SHOPEE_ERROR_KIND.burst) {
        // ⚠️ NOT a per-item failure and NOT an attempt: a heartbeat, a delayed
        // re-enqueue, and `'continued'`. The last per-item checkpoint is the
        // state the next dispatch resumes from.
        await checkpoint({ updatedAt: nowMs });
        if (!deps.scheduler) {
          throw new Error(
            'processarImportacaoShopee: limite de rajada da Shopee mas nenhum scheduler foi ' +
              'fornecido para agendar a pausa.',
          );
        }
        const segundos = err.retryAfterSeconds ?? PAUSA_BURST_PADRAO_S;
        try {
          await deps.scheduler.enqueue({ jobId, integracaoId }, { scheduleDelaySeconds: segundos });
        } catch (erroDaPausa) {
          if (erroDaPausa instanceof ShopeeMassImportTasksDisabledError) {
            await carimbarFalha(MSG_VALVULA_FECHADA);
            return 'failed';
          }
          // ⚠️ The SAME final-attempt rule the generic tail below applies, and it
          // has to be spelled again here because this `throw` sits INSIDE the
          // dispatch's own `catch` and can never re-enter it. Without it a
          // transport failure on the pause's re-enqueue ends the LAST attempt
          // with neither a stamp nor a re-enqueue: nothing re-drives a job this
          // queue drops, so the document would stay `running` for ever and the
          // start guard would 409 every new import for that conta until an
          // operator cancels. The ordinary continue arm's enqueue sits in the
          // TRY body and already reaches the tail; this is the one arm that did
          // not.
          if (retryCount < MAX_TENTATIVAS - 1) throw erroDaPausa;
          if (!(erroDaPausa instanceof Error)) throw erroDaPausa;
          await carimbarFalha(erroDaPausa.message);
          return 'failed';
        }
        return 'continued';
      }
      await carimbarFalha(MSG_LIMITE_DIARIO);
      return 'failed';
    }

    if (ehFalhaDePrimeiraTentativa(err)) {
      await carimbarFalha(err instanceof Error ? err.message : String(err));
      return 'failed';
    }

    if (!(err instanceof Error)) throw err;
    if (retryCount < MAX_TENTATIVAS - 1) throw err; // let the queue retry with backoff

    await carimbarFalha(err.message);
    return 'failed';
  }
}
