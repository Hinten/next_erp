/**
 * Mercado Livre NF-e invoice upload (Step 12, issue #739) — port of the legacy
 * `signalEnviarNFeMercadoLivre`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:2778-2847`):
 * when a NF-e reaches `estado 'a'` (aprovada) with a produção
 * (`<tpAmb>1</tpAmb>`) `xml_nfe_proc`, POST the raw signed nfeProc XML to
 * `POST /shipments/{shipmentId}/invoice_data?siteId=MLB` so the shipment
 * leaves `invoice_pending` and ML generates the label.
 *
 * `MarketplaceChannel.uploadInvoice` (packages/core/src/plugins/index.ts)
 * deliberately stays uncalled — Steps 9-12 call the API client directly.
 *
 * Three cooperating pieces, all in this module so the queue function
 * (`mlNfeUploadTasks.ts` / `functions/`) stays transport-only:
 *
 *  - `decideNfeUploadDispatch` — PURE dispatch for the `nfev4` Firestore
 *    trigger: gates on estado/XML/tpAmb, breaks the recursion our own marker
 *    writes would cause, and reads the `mlEnvio` marker to decide
 *    enqueue-vs-skip (a marker in `erro` re-enqueues on any real poke —
 *    poke-as-retry, owner-accepted).
 *  - `enqueueNfeUpload` — enqueue FIRST, then stamp the `pendente` marker.
 *    Enqueue-ok/stamp-fail leaves a duplicate-tolerant task (the handler
 *    re-gates everything); stamp-first could strand the NF-e as a fresh
 *    `pendente` with no task behind it until the TTL expires.
 *  - `processNfeUploadTask` — the task handler core: FRESH reads, re-gates
 *    every precondition, resolves the conta, gates on the live shipment
 *    status, POSTs the XML and stamps the `mlEnvio` marker (FULL object every
 *    write). Deterministic outcomes RETURN (success to the queue); transient
 *    conditions THROW so the queue retries with backoff — the NF-e-before-
 *    shipment race (order importer runs every 15 min) self-heals inside the
 *    backoff window. On the FINAL attempt the failure is persisted instead of
 *    thrown (massImport.ts disposition precedent); when the exhausted error is
 *    a raw ML transient (the upload itself failed) the pedido's
 *    `freteInicial.estado` is also stamped `error` so the despacho screens
 *    surface it; the error DETAIL stays on the NF-e marker only.
 *
 * Marker discipline: `mlEnvio.atualizadoEm` is MILLIS (matches the NF-e doc's
 * other timestamps); the pedido's `lastMarketplaceUpdate` is MICROS. This
 * module NEVER bumps `ultima_modificacao` — the dispatch's recursion guard
 * (`marker-write`) depends on exactly that signature.
 */
import { z } from 'zod';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { millisToMicros } from '@delfrance/core/datetime';
import {
  ESTADO_FRETE,
  ESTADO_NFE,
  INTEGRACAO_FRETE,
  ML_ENVIO_ESTADO,
  idFromRef,
  type MlEnvioEstado,
} from '@delfrance/schemas';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  createMercadoLivreApi,
  type MercadoLivreApi,
  type MlShipment,
} from '@delfrance/integrations-mercado-livre';
import { nfev4Collection, pedidoCollection } from '@delfrance/data/admin/collections';

import { MercadoLivreContaNotConfiguredError, loadMercadoLivreContext } from './mercadoLivre';

/* ------------------------------- queue contract ----------------------------- */

/** The Cloud Tasks queue / function name (`onTaskDispatched` in `functions/`). */
export const MERCADO_LIVRE_NFE_UPLOAD_QUEUE = 'processMercadoLivreNfeUpload';

/** Queue attempts before the failure is persisted instead of rethrown. */
export const NFE_UPLOAD_MAX_ATTEMPTS = 6;

/**
 * How long a `pendente` marker blocks re-dispatch. A task normally resolves
 * (or moves the marker to a terminal estado) well within this; past it the
 * marker is presumed orphaned (e.g. enqueue landed but the queue lost the
 * task) and a poke re-enqueues.
 */
export const NFE_UPLOAD_PENDENTE_TTL_MS = 60 * 60 * 1000;

/** Task payload — re-validated on dispatch (Cloud Tasks payloads are wire data). */
export const nfeUploadTaskSchema = z.object({
  pedidoId: z.string().min(1),
  nfeId: z.string().min(1),
});
export type NfeUploadTaskPayload = z.infer<typeof nfeUploadTaskSchema>;

/**
 * The enqueue seam. The dispatch and the task handler depend on this
 * interface, not the transport; the real implementation is
 * `createMlNfeUploadScheduler()` in `./mlNfeUploadTasks`.
 */
export interface MlNfeUploadScheduler {
  enqueue(payload: NfeUploadTaskPayload): Promise<void>;
}

/* --------------------------------- tpAmb ------------------------------------ */

// First <tpAmb> wins: infNFe/ide precedes protNFe in a nfeProc document, so
// the emitter's declared ambiente is read, never the protocol echo.
const TPAMB_REGEX = /<tpAmb>\s*([12])\s*<\/tpAmb>/;

/** The first `<tpAmb>` in the XML — `'1'` produção, `'2'` homologação, else null. */
export function extractTpAmb(xml: string): '1' | '2' | null {
  const m = TPAMB_REGEX.exec(xml);
  return m == null ? null : (m[1] as '1' | '2');
}

/* -------------------------------- dispatch ---------------------------------- */

export type NfeUploadDispatch =
  | { action: 'enqueue' }
  | {
      action: 'skip';
      reason:
        | 'apagada'
        | 'nao-aprovada'
        | 'xml-ausente'
        | 'tpamb-homologacao'
        | 'marker-write'
        | 'ja-resolvida'
        | 'em-andamento';
    };

/**
 * PURE enqueue-vs-skip decision for the `nfev4` onDocumentWritten trigger.
 * `before`/`after` are the RAW snapshot data (undefined on create/delete).
 * Order matters — see the numbered steps.
 */
export function decideNfeUploadDispatch(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  nowMs: number,
): NfeUploadDispatch {
  // (1) Deleted doc — nothing to upload.
  if (after == null) return { action: 'skip', reason: 'apagada' };

  // (2) Only an aprovada NF-e has an authorized nfeProc worth sending.
  if (after.estado !== ESTADO_NFE.aprovada) return { action: 'skip', reason: 'nao-aprovada' };

  // (3) Aprovada with no proc XML happens (legacy docs, partial writes).
  const xml = after.xml_nfe_proc;
  if (xml == null || typeof xml !== 'string') return { action: 'skip', reason: 'xml-ausente' };

  // (4) Homologação (or unparseable) XML never reaches ML from the dispatch;
  // the task re-checks and distinguishes '2' from unparseable.
  if (extractTpAmb(xml) !== '1') return { action: 'skip', reason: 'tpamb-homologacao' };

  // (5) RECURSION GUARD: only our own marker stamps change `mlEnvio` while
  // leaving estado + xml_nfe_proc + ultima_modificacao ALL untouched (this
  // module never bumps ultima_modificacao; a Flutter poke always does).
  if (
    before != null &&
    JSON.stringify(before.mlEnvio ?? null) !== JSON.stringify(after.mlEnvio ?? null) &&
    before.estado === after.estado &&
    before.xml_nfe_proc === after.xml_nfe_proc &&
    before.ultima_modificacao === after.ultima_modificacao
  ) {
    return { action: 'skip', reason: 'marker-write' };
  }

  // (6) Marker-driven dispatch. Malformed/absent markers enqueue (the task is
  // idempotent and re-gates); an `erro` marker also enqueues — a real poke on
  // an errored NF-e is the owner-accepted manual retry channel.
  const marker = asPlainRecord(after.mlEnvio);
  if (marker == null) return { action: 'enqueue' };
  const estado = marker.estado;
  if (estado === ML_ENVIO_ESTADO.enviado || estado === ML_ENVIO_ESTADO.descartado) {
    return { action: 'skip', reason: 'ja-resolvida' };
  }
  if (estado === ML_ENVIO_ESTADO.pendente) {
    const atualizadoEm = marker.atualizadoEm;
    const fresh =
      typeof atualizadoEm === 'number' &&
      Number.isFinite(atualizadoEm) &&
      atualizadoEm >= nowMs - NFE_UPLOAD_PENDENTE_TTL_MS;
    return fresh ? { action: 'skip', reason: 'em-andamento' } : { action: 'enqueue' };
  }
  return { action: 'enqueue' };
}

/* -------------------------------- enqueue ----------------------------------- */

/**
 * Enqueue the upload task, then stamp the `pendente` marker (enqueue FIRST —
 * see the module doc for why this order). The stamp is a FULL `mlEnvio`
 * object with `tentativas: 0`; the task overwrites it on every attempt.
 */
export async function enqueueNfeUpload(
  db: Firestore,
  scheduler: MlNfeUploadScheduler,
  payload: NfeUploadTaskPayload,
  nowMs: number,
): Promise<void> {
  await scheduler.enqueue(payload);
  // Late-stamp race, accepted: if the task finishes before this pendente merge
  // lands, pendente overwrites the terminal marker. Self-heals via the 1h
  // pendente TTL — the next poke re-enqueues and the task resolves
  // ja-processado. Accepted tradeoff vs a no-clobber transaction.
  await nfev4Collection.merge(db, { pedidoId: payload.pedidoId }, payload.nfeId, {
    mlEnvio: {
      estado: ML_ENVIO_ESTADO.pendente,
      tentativas: 0,
      shipmentId: null,
      motivo: null,
      ultimoErro: null,
      ultimoErroCodigo: null,
      atualizadoEm: nowMs,
    },
  });
}

/* ----------------------------- error taxonomy ------------------------------- */

/** The conta doc exists and is ML-tipo but is flagged inactive (`ativo === false`). */
export class MercadoLivreContaInativaError extends Error {
  constructor(integracaoId: string) {
    super(`Integração ${integracaoId} está inativa.`);
    this.name = 'MercadoLivreContaInativaError';
  }
}

/**
 * A transient condition this handler DELIBERATELY throws to ride the queue's
 * backoff (NF-e-before-shipment race, pre-eligible shipment window). `tag`
 * becomes the marker `motivo` when the final attempt exhausts.
 */
export class NfeUploadTransientError extends Error {
  constructor(
    readonly tag: string,
    message: string,
  ) {
    super(message);
    this.name = 'NfeUploadTransientError';
  }
}

/** How a failed `sendShipmentInvoiceData` call must be handled. */
export type InvoiceErrorClassification =
  | { kind: 'ja-enviado' } // success-equivalent: ML already has this invoice
  | { kind: 'transient' } // rethrow — the queue retries with backoff
  | { kind: 'reauth' } // dead credential — record, never retry
  | { kind: 'deterministic'; code: string | null }; // ML rejected the XML — record + stamp the frete

/** ML error codes that are transient despite arriving as a 4xx. */
const TRANSIENT_INVOICE_CODES: ReadonlySet<string> = new Set([
  'shipment_already_being_processed',
  'internal_error',
]);

/**
 * Classify an invoice-POST failure. Exported so tests pin the table:
 *  - `shipment_invoice_already_saved` → ja-enviado (idempotent success);
 *  - 429 (plain rethrow — the queue's min backoff covers it, no pause doc),
 *    any 5xx, `shipment_already_being_processed`/`internal_error`, network →
 *    transient;
 *  - 401 / MercadoLivreReauthRequiredError → reauth;
 *  - every other 4xx (duplicated_fiscal_key, invalid_nfe_cstat,
 *    wrong_invoice_date, wrong_receiver_*, nfe_order_value_divergence,
 *    invalid_shipment, unknown 400/403/409) → deterministic.
 */
export function classifyInvoiceError(
  err: MercadoLivreHttpError | MercadoLivreNetworkError | MercadoLivreReauthRequiredError,
): InvoiceErrorClassification {
  if (err instanceof MercadoLivreReauthRequiredError) return { kind: 'reauth' };
  if (err instanceof MercadoLivreNetworkError) return { kind: 'transient' };
  const code = extractMlErrorCode(err.body);
  if (code === 'shipment_invoice_already_saved') return { kind: 'ja-enviado' };
  if (err.status === 429 || err.status >= 500) return { kind: 'transient' };
  if (code != null && TRANSIENT_INVOICE_CODES.has(code)) return { kind: 'transient' };
  // Production-unreachable: toHttpError maps every 401 to
  // MercadoLivreReauthRequiredError first — kept as belt-and-suspenders.
  if (err.status === 401) return { kind: 'reauth' };
  return { kind: 'deterministic', code };
}

// A machine code token, not free prose ("Invoice already saved" has spaces →
// rejected; 'wrong_receiver_cpf' matches).
const CODE_TOKEN_REGEX = /^[a-z][a-z0-9_.-]*$/i;

function codeCandidate(v: unknown): string | null {
  return typeof v === 'string' && CODE_TOKEN_REGEX.test(v) ? v : null;
}

/**
 * Scan an ML error body for its machine code — the `code`/`error`/`message`
 * top-level shapes plus the `cause[]`/`causes[]` nested variants ML mixes
 * across endpoints.
 */
function extractMlErrorCode(body: unknown): string | null {
  const rec = asPlainRecord(body);
  if (rec == null) return null;
  const direct = codeCandidate(rec.code) ?? codeCandidate(rec.error) ?? codeCandidate(rec.message);
  if (direct != null) return direct;
  for (const key of ['cause', 'causes']) {
    const arr = rec[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item === 'string') {
        const c = codeCandidate(item);
        if (c != null) return c;
        continue;
      }
      const it = asPlainRecord(item);
      if (it == null) continue;
      const c = codeCandidate(it.code) ?? codeCandidate(it.error) ?? codeCandidate(it.message);
      if (c != null) return c;
    }
  }
  return null;
}

/* ------------------------------ task handler -------------------------------- */

export interface NfeUploadDeps {
  db: Firestore;
  /** ONE clock read for the whole task (`Date.now()` in prod). */
  nowMs: number;
  /** Test seam; defaults to loadMercadoLivreContext → resolveChannelContext → createMercadoLivreApi. */
  resolveApi?: (db: Firestore, integracaoId: string) => Promise<MercadoLivreApi>;
}

export interface NfeUploadResult {
  outcome:
    | 'enviado'
    | 'ja-enviado'
    | 'ja-processado'
    | 'descartado'
    | 'erro-deterministico'
    | 'erro-final'
    | 'nfe-nao-encontrada';
  motivo: string | null;
}

/** Shipment statuses past which an invoice upload is moot. */
const SHIPMENT_STATUS_ENCERRADO: ReadonlySet<string> = new Set([
  'shipped',
  'delivered',
  'not_delivered',
  'cancelled',
]);

async function defaultResolveApi(db: Firestore, integracaoId: string): Promise<MercadoLivreApi> {
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  if (ctx.conta.ativo === false) throw new MercadoLivreContaInativaError(integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  return createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
}

/**
 * Process one NF-e upload task. Fresh reads, re-gates everything; THROWS only
 * for transient conditions (the queue retries with backoff); on the FINAL
 * attempt persists the failure and returns `erro-final` instead of throwing.
 * See the module doc for the full decision tree.
 */
export async function processNfeUploadTask(
  deps: NfeUploadDeps,
  payload: NfeUploadTaskPayload,
  retryCount: number,
): Promise<NfeUploadResult> {
  const { db, nowMs } = deps;
  const nowUs = millisToMicros(nowMs);
  const { pedidoId, nfeId } = payload;

  // Filled once the pedido is read; the final-attempt wrapper below consumes
  // it to decide whether (and with which id) to stamp the frete.
  const freteCtx: { hasFrete: boolean; shipmentId: string | null } = {
    hasFrete: false,
    shipmentId: null,
  };

  // FULL mlEnvio object on every write — no stale sibling fields, and the
  // dispatch's recursion guard relies on the write touching ONLY `mlEnvio`.
  const stampMarker = async (m: {
    estado: MlEnvioEstado;
    motivo?: string | null;
    ultimoErro?: string | null;
    ultimoErroCodigo?: string | null;
  }): Promise<void> => {
    await nfev4Collection.merge(db, { pedidoId }, nfeId, {
      mlEnvio: {
        estado: m.estado,
        tentativas: retryCount + 1,
        shipmentId: freteCtx.shipmentId,
        motivo: m.motivo ?? null,
        ultimoErro: m.ultimoErro ?? null,
        ultimoErroCodigo: m.ultimoErroCodigo ?? null,
        atualizadoEm: nowMs,
      },
    });
  };

  const descartar = async (motivo: string): Promise<NfeUploadResult> => {
    await stampMarker({ estado: ML_ENVIO_ESTADO.descartado, motivo });
    return { outcome: 'descartado', motivo };
  };

  try {
    // (1) Fresh NF-e read — RAW (legacy docs may not match the strict schema;
    // only estado + xml_nfe_proc are consumed).
    const nfeSnap = await nfev4Collection.docRef(db, { pedidoId }, nfeId).get();
    if (!nfeSnap.exists) {
      console.warn('[mercado-livre] nfe-upload: NF-e não encontrada — nada a enviar', {
        pedidoId,
        nfeId,
      });
      return { outcome: 'nfe-nao-encontrada', motivo: null };
    }
    const nfe = (nfeSnap.data() ?? {}) as Record<string, unknown>;

    // (2) Estado regressed since dispatch (cancelamento etc.) → CLEAR the
    // marker (the step-3 re-arm precedent), never a `descartado` tombstone:
    // estado bounce is real (a cStat-100 consulta can regress a doc back to
    // aprovada; a rejeitada→re-verify→aprovada cycle exists), and a tombstone
    // would permanently block both the trigger and the route. While
    // non-aprovada the dispatch skips at its step 2 anyway, so the null marker
    // costs nothing.
    if (nfe.estado !== ESTADO_NFE.aprovada) {
      await nfev4Collection.merge(db, { pedidoId }, nfeId, { mlEnvio: null });
      return { outcome: 'descartado', motivo: 'nao-aprovada' };
    }

    // (3) XML vanished → CLEAR the marker (re-arm): a future re-approval must
    // dispatch as a virgin doc, not read this stale disposition.
    const xml = nfe.xml_nfe_proc;
    if (xml == null || typeof xml !== 'string') {
      await nfev4Collection.merge(db, { pedidoId }, nfeId, { mlEnvio: null });
      return { outcome: 'descartado', motivo: 'xml-ausente' };
    }

    // (4) Ambiente gate — homologação is a clean discard; an unparseable
    // tpAmb is a malformed XML, a deterministic error (NO pedido stamp: the
    // shipment was never touched).
    const tpAmb = extractTpAmb(xml);
    if (tpAmb === '2') return descartar('tpamb-homologacao');
    if (tpAmb == null) {
      await stampMarker({ estado: ML_ENVIO_ESTADO.erro, motivo: 'xml-invalido' });
      return { outcome: 'erro-deterministico', motivo: 'xml-invalido' };
    }

    // (5) Pedido read.
    const pedidoSnap = await pedidoCollection.docRef(db, {}, pedidoId).get();
    if (!pedidoSnap.exists) return descartar('pedido-nao-encontrado');
    const pedido = pedidoCollection.parseRead(
      pedidoSnap.data() ?? {},
      pedidoCollection.docPath({}, pedidoId),
    );

    const frete = pedido.freteInicial;
    freteCtx.hasFrete = frete != null;
    freteCtx.shipmentId = frete?.externalId != null ? String(frete.externalId) : null;

    // (6) Another integradora owns this frete — never upload for it.
    if (frete != null && frete.externalOptionIntegracao !== INTEGRACAO_FRETE.mercadoLivre) {
      return descartar('nao-mercado-livre');
    }

    // (7) A local pedido (no integração) has no ML shipment to feed.
    if (pedido.integracaoPedidoOuterRef == null) return descartar('sem-integracao');

    // (8) NF-e-before-shipment race: the order importer runs every 15 min, so
    // the queue backoff window self-heals both gaps — TRANSIENT, not discard.
    if (frete == null) {
      throw new NfeUploadTransientError(
        'sem-frete',
        `Pedido ${pedidoId} ainda não tem freteInicial — aguardando o import do shipment.`,
      );
    }
    if (frete.externalId == null) {
      throw new NfeUploadTransientError(
        'sem-shipment-id',
        `freteInicial do pedido ${pedidoId} ainda não tem externalId — aguardando o import do shipment.`,
      );
    }
    const shipmentId = String(frete.externalId);

    // (9) Conta → live ML API. A dead credential never heals by backoff
    // (estoqueSend precedent) — record and succeed to the queue.
    const integracaoId = idFromRef(pedido.integracaoPedidoOuterRef);
    let api: MercadoLivreApi;
    try {
      api = await (deps.resolveApi ?? defaultResolveApi)(db, integracaoId);
    } catch (err) {
      // conta-nao-configurada / conta-inativa are OPERATOR-FIXABLE, the same
      // class as 'reauth' → marker `erro`, never `descartado`: descartado is a
      // terminal tombstone (the dispatch treats it ja-resolvida), and
      // reactivating/configuring the conta must let a poke/route re-drive the
      // upload. NO pedido stamp — the shipment was never touched.
      if (err instanceof MercadoLivreContaNotConfiguredError) {
        await stampMarker({ estado: ML_ENVIO_ESTADO.erro, motivo: 'conta-nao-configurada' });
        return { outcome: 'erro-deterministico', motivo: 'conta-nao-configurada' };
      }
      if (err instanceof MercadoLivreContaInativaError) {
        await stampMarker({ estado: ML_ENVIO_ESTADO.erro, motivo: 'conta-inativa' });
        return { outcome: 'erro-deterministico', motivo: 'conta-inativa' };
      }
      if (err instanceof MercadoLivreReauthRequiredError) {
        console.error('[mercado-livre] nfe-upload: credencial morta — reconecte a conta', {
          pedidoId,
          nfeId,
          integracaoId,
          error: err.message,
        });
        await stampMarker({
          estado: ML_ENVIO_ESTADO.erro,
          motivo: 'reauth',
          ultimoErro: err.message,
        });
        return { outcome: 'erro-deterministico', motivo: 'reauth' };
      }
      throw err;
    }

    // (10) Live shipment state. 404 = shipment permanently gone; other 4xx =
    // deterministic BUT the shipment state is unknown, so NO pedido stamp (do
    // not error a frete we could not even read); 5xx/network = transient.
    let shipment: MlShipment;
    try {
      shipment = await api.getShipment(shipmentId);
    } catch (err) {
      // The client's toHttpError maps EVERY 401 to MercadoLivreReauthRequiredError
      // (it never surfaces as MercadoLivreHttpError(401)) — mirror the
      // resolve-time reauth branch above: record, never retry, NO pedido stamp.
      if (err instanceof MercadoLivreReauthRequiredError) {
        console.error('[mercado-livre] nfe-upload: credencial morta na consulta do shipment', {
          pedidoId,
          nfeId,
          shipmentId,
          error: err.message,
        });
        await stampMarker({
          estado: ML_ENVIO_ESTADO.erro,
          motivo: 'reauth',
          ultimoErro: err.message,
        });
        return { outcome: 'erro-deterministico', motivo: 'reauth' };
      }
      if (err instanceof MercadoLivreHttpError) {
        if (err.status === 404) return descartar('shipment-404');
        // 429 is TRANSIENT (mirrors classifyInvoiceError's POST-path rule; the
        // queue's min backoff covers retry-after) — never the terminal 4xx path.
        if (err.status === 429) throw err;
        if (err.status >= 400 && err.status < 500) {
          const motivo = `get-shipment-${err.status}`;
          await stampMarker({ estado: ML_ENVIO_ESTADO.erro, motivo, ultimoErro: err.message });
          return { outcome: 'erro-deterministico', motivo };
        }
      }
      throw err;
    }

    // (11) Eligibility gate on status/substatus.
    const status = shipment.status ?? null;
    const substatus = shipment.substatus ?? null;
    if (
      substatus === 'invoice_pending' &&
      (status === 'ready_to_ship' || status === 'invoice_pending')
    ) {
      // Eligible — fall through to the POST.
    } else if (status === 'ready_to_ship') {
      // Past invoice_pending (ready_to_print etc.) — the invoice already
      // reached ML by some path; success-equivalent.
      await stampMarker({ estado: ML_ENVIO_ESTADO.enviado, motivo: 'ja-processado' });
      return { outcome: 'ja-processado', motivo: 'ja-processado' };
    } else if (status === 'pending' || status === 'handling') {
      // Pre-eligible consistency window — ML has not opened invoice_pending yet.
      throw new NfeUploadTransientError(
        'shipment-pendente',
        `Shipment ${shipmentId} ainda em '${status}' — aguardando invoice_pending.`,
      );
    } else if (status != null && SHIPMENT_STATUS_ENCERRADO.has(status)) {
      return descartar('shipment-encerrado');
    } else {
      // Unknown/missing status — conservative transient.
      throw new NfeUploadTransientError(
        'shipment-status-desconhecido',
        `Shipment ${shipmentId} com status desconhecido (${String(status)}).`,
      );
    }

    // (12) The ONE POST this task exists for — the signed nfeProc VERBATIM.
    try {
      await api.sendShipmentInvoiceData(shipmentId, xml);
    } catch (err) {
      if (
        err instanceof MercadoLivreHttpError ||
        err instanceof MercadoLivreNetworkError ||
        err instanceof MercadoLivreReauthRequiredError
      ) {
        const cls = classifyInvoiceError(err);
        if (cls.kind === 'transient') throw err;
        if (cls.kind === 'reauth') {
          console.error(
            '[mercado-livre] nfe-upload: credencial morta no envio — reconecte a conta',
            {
              pedidoId,
              nfeId,
              error: err.message,
            },
          );
          await stampMarker({
            estado: ML_ENVIO_ESTADO.erro,
            motivo: 'reauth',
            ultimoErro: err.message,
          });
          return { outcome: 'erro-deterministico', motivo: 'reauth' };
        }
        if (cls.kind === 'ja-enviado') {
          await stampMarker({ estado: ML_ENVIO_ESTADO.enviado, motivo: 'ja-enviado' });
          return { outcome: 'ja-enviado', motivo: 'ja-enviado' };
        }
        // Deterministic rejection: full detail on the marker, then the pedido
        // stamp so the despacho screens surface the failure (detail stays on
        // the marker only).
        console.error('[mercado-livre] nfe-upload: rejeição determinística do ML — sem retry', {
          pedidoId,
          nfeId,
          shipmentId,
          code: cls.code,
          error: err.message,
        });
        await stampMarker({
          estado: ML_ENVIO_ESTADO.erro,
          motivo: 'envio-rejeitado',
          ultimoErro: err.message,
          ultimoErroCodigo: cls.code,
        });
        await stampFreteErro(db, pedidoId, shipmentId, nowUs);
        return { outcome: 'erro-deterministico', motivo: 'envio-rejeitado' };
      }
      throw err;
    }

    await stampMarker({ estado: ML_ENVIO_ESTADO.enviado });
    console.info('[mercado-livre] nfe-upload: NF-e enviada ao Mercado Livre', {
      pedidoId,
      nfeId,
      shipmentId,
    });
    return { outcome: 'enviado', motivo: null };
  } catch (err) {
    // Transient-throw wrapper. Only the classes this handler DELIBERATELY
    // lets ride the queue backoff are finalized here; anything else (Firestore
    // failure, coding bug) propagates untouched on every attempt.
    if (
      !(err instanceof NfeUploadTransientError) &&
      !(err instanceof MercadoLivreHttpError) &&
      !(err instanceof MercadoLivreNetworkError)
    ) {
      throw err;
    }
    if (retryCount < NFE_UPLOAD_MAX_ATTEMPTS - 1) throw err;

    // FINAL attempt: persist the failure instead of throwing (massImport.ts
    // disposition precedent) — tagged transients keep their tag as motivo
    // (sem-frete / sem-shipment-id / shipment-pendente /
    // shipment-status-desconhecido), ML-client transients collapse to
    // 'tentativas-esgotadas'.
    const tagged = err instanceof NfeUploadTransientError;
    const motivo = tagged ? err.tag : 'tentativas-esgotadas';
    try {
      await stampMarker({ estado: ML_ENVIO_ESTADO.erro, motivo, ultimoErro: err.message });
    } catch (persistErr) {
      if (!(persistErr instanceof Error)) throw persistErr;
      console.error('[mercado-livre] nfe-upload: falha ao persistir o marker na tentativa final', {
        pedidoId,
        nfeId,
        cause: err.message,
        persistError: persistErr.message,
      });
    }
    // Stamp the frete ONLY for raw ML transients (5xx/429/being-processed,
    // network): freteInicial 'error' means the upload itself failed. A tagged
    // transient means the shipment never became ELIGIBLE — that is not a frete
    // failure; legacy silently skipped those states, and false-stamping would
    // flag healthy pedidos in the despacho screens. A secondary stamp failure
    // is logged loudly, never thrown — it must not mask the primary
    // disposition.
    if (!tagged && freteCtx.hasFrete) {
      try {
        await stampFreteErro(db, pedidoId, freteCtx.shipmentId, nowUs);
      } catch (persistErr) {
        if (!(persistErr instanceof Error)) throw persistErr;
        console.error('[mercado-livre] nfe-upload: falha ao stampar o frete na tentativa final', {
          pedidoId,
          nfeId,
          cause: err.message,
          persistError: persistErr.message,
        });
      }
    }
    return { outcome: 'erro-final', motivo };
  }
}

/* ------------------------------ frete stamp --------------------------------- */

/**
 * Stamp `freteInicial.estado = 'error'` (+ `lastMarketplaceUpdate`) on the
 * pedido — single-read transaction (orderShipmentImport.ts shape). Guards
 * re-check the TX-FRESH pedido (it may have changed since the task's read):
 * pedido gone → warn + skip; frete gone → silent skip; frete owned by another
 * integradora → warn + skip (never stamp a frete we don't own); externalId
 * divergence → warn but stamp anyway. Error DETAIL stays on the NF-e marker.
 */
async function stampFreteErro(
  db: Firestore,
  pedidoId: string,
  shipmentId: string | null,
  nowUs: number,
): Promise<void> {
  await db.runTransaction(async (tx: Transaction) => {
    const ref = pedidoCollection.docRef(db, {}, pedidoId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      console.warn('[mercado-livre] nfe-upload: pedido sumiu antes do stamp de erro no frete', {
        pedidoId,
      });
      return;
    }
    const pedido = pedidoCollection.parseRead(
      snap.data() ?? {},
      pedidoCollection.docPath({}, pedidoId),
    );
    const frete = pedido.freteInicial;
    if (frete == null) return;
    if (frete.externalOptionIntegracao !== INTEGRACAO_FRETE.mercadoLivre) {
      console.warn(
        '[mercado-livre] nfe-upload: frete pertence a outra integradora — stamp de erro ignorado',
        { pedidoId, externalOptionIntegracao: frete.externalOptionIntegracao },
      );
      return;
    }
    if (shipmentId != null && String(frete.externalId) !== String(shipmentId)) {
      console.warn(
        '[mercado-livre] nfe-upload: externalId divergente do freteInicial armazenado — stampando mesmo assim',
        { pedidoId, shipmentId, storedExternalId: frete.externalId },
      );
    }
    tx.update(
      ref,
      pedidoCollection.parseMerge({
        freteInicial: { ...frete, estado: ESTADO_FRETE.error },
        lastMarketplaceUpdate: nowUs,
      }),
    );
  });
}

/* --------------------------------- helpers ---------------------------------- */

function asPlainRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
