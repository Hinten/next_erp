/**
 * `withNFeRetry` — wraps an `NFeHttpClient` so transient failures retry with
 * jittered exponential backoff (#90), with a **per-endpoint** policy. Pure (no
 * React), so it unit-tests without an auth/Firebase context.
 *
 * Policy:
 *   - Read-only / idempotent (`consultar`, `statusServico`, `danfe`,
 *     `cartaCorrecaoDanfe`, `processarPendentes`, and `consultaCadastro` — a
 *     read-only POST, body-carried so the CNPJ stays out of the URL) → full
 *     transient set (`isRetryableNFeHttpError`: network / 5xx / 503). An XSD
 *     failure is NOT in that set although it arrives as a 5xx
 *     (`NFeXsdValidationFailedError`): it is deterministic, and a retried
 *     `consultaCadastro` would re-POST to SEFAZ (#1602).
 *   - the server-deduped POST (`cancelar`) → full transient set. A re-POST
 *     converges to a no-op: `cancelar` reconciles a duplicate-event 573 →
 *     `cancelada`.
 *   - cert management (`uploadCertificado`, `deleteCertificado`) → full
 *     transient set (upload overwrites the same cert; delete is idempotent).
 *   - **`emitir`, `emitirLote`, `cartaCorrecao` and `inutilizar` → pre-send 503
 *     only.** None is safe to re-send: `cartaCorrecao` increments
 *     `nSeqEvento`; a re-sent `inutilizar` of an already-homologada range
 *     returns cStat 563, which `inutilizar.ts` surfaces as a rejection (unlike
 *     `cancelar`'s 573); and an emit re-POST is a no-op only for a pedido
 *     that is bloqueada or in flight on a receipt (`nRec`) — a #396 anchor is
 *     retransmitted with its stored bytes, and a `rejeitada`/`error` one is
 *     REGENERATED and RE-SENT (`runAllocateGenerateSignTx`,
 *     `runChunkAllocateTx` in apps/nfe), so a re-POST after a lost response
 *     re-sends whatever the first request had just seen refused (#1654 §3).
 *     `emitir-lote` also answers 500 for a failure of an unknown class (a bug)
 *     by design. So a post-send network/5xx must never auto-retry these — only
 *     the 503 apps/nfe answers before any SEFAZ contact, recognised by its
 *     body (`isRuntimeNotReadyBeforeSend`), never by `NFeRuntimeNotReadyError`
 *     alone: the client maps Cloud Run's own mid-request 503 to that class too.
 *     The operator re-clicks.
 *   - **`verificar` → NO retry at all** (direct passthrough). The server runs
 *     the batch **sequentially** against SEFAZ precisely to avoid a
 *     consumo-indevido (cStat 656) burst; a client re-POST on a network/5xx
 *     failure could start a second run while the first is still consulting
 *     SEFAZ — the exact concurrency the server design exists to prevent. The
 *     operator can simply re-click once the first run settles.
 */
import { retryAsync } from '@delfrance/data/hooks';
import {
  isRetryableNFeHttpError,
  NFeRuntimeNotReadyError,
  type NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';

/** Retry the full transient set with `retryAsync`'s defaults (3 attempts, 400ms→4s). */
const retryTransient = <T>(fn: () => Promise<T>): Promise<T> =>
  retryAsync(fn, { isRetryable: isRetryableNFeHttpError });

/**
 * The `error` apps/nfe's `emitir`, `emitir-lote`, `inutilizar` and
 * `carta-correcao` routes answer a `getNFeRuntime()` failure with — a 503
 * raised before any SEFAZ contact (the two emit routes' tests pin the
 * literal). Should it drift, the pre-send 503 merely stops being retried.
 */
const RUNTIME_NOT_READY = 'NF-e runtime not ready';

/**
 * apps/nfe's own pre-send 503 — `NFeRuntimeNotReadyError` carrying the route's
 * marker. The class alone does not prove it: the client maps EVERY 503 to it,
 * whatever the body, and Cloud Run answers its own 503 (an HTML page, or
 * nothing) when the instance serving the request fails mid-request — after the
 * lote may already have gone to SEFAZ.
 */
export function isRuntimeNotReadyBeforeSend(err: unknown): boolean {
  if (!(err instanceof NFeRuntimeNotReadyError)) return false;
  const body: unknown = err.body;
  return (
    body !== null &&
    typeof body === 'object' &&
    (body as { error?: unknown }).error === RUNTIME_NOT_READY
  );
}

/** Only the pre-SEFAZ-contact 503 is safe to retry for a non-idempotent call. */
const isPreSendOnly = isRuntimeNotReadyBeforeSend;

export function withNFeRetry(client: NFeHttpClient): NFeHttpClient {
  return {
    // Not deduped for a rejeitada/error member (regenerated and re-sent on every
    // POST, #1654 §3) — retry only the pre-send 503.
    emitir: (pedidoId) => retryAsync(() => client.emitir(pedidoId), { isRetryable: isPreSendOnly }),
    emitirLote: (pedidoIds) =>
      retryAsync(() => client.emitirLote(pedidoIds), { isRetryable: isPreSendOnly }),
    consultar: (chave) => retryTransient(() => client.consultar(chave)),
    // NO retry: a re-POST on a post-send network/5xx may overlap the first
    // server run (still consulting SEFAZ sequentially) and provoke the
    // consumo-indevido 656 burst it guards against. The operator re-clicks.
    verificar: (filialId, enviNfeMsgIds) => client.verificar(filialId, enviNfeMsgIds),
    processarPendentes: () => retryTransient(() => client.processarPendentes()),
    cancelar: (pedidoId, nfeId, xJust) =>
      retryTransient(() => client.cancelar(pedidoId, nfeId, xJust)),
    // Not idempotent on a re-send (563 duplicidade) — retry only the pre-send 503.
    inutilizar: (args) => retryAsync(() => client.inutilizar(args), { isRetryable: isPreSendOnly }),
    cartaCorrecao: (pedidoId, nfeId, xCorrecao) =>
      retryAsync(() => client.cartaCorrecao(pedidoId, nfeId, xCorrecao), {
        isRetryable: isPreSendOnly,
      }),
    danfe: (pedidoId, nfeId, format, dpi) =>
      retryTransient(() => client.danfe(pedidoId, nfeId, format, dpi)),
    cartaCorrecaoDanfe: (pedidoId, nfeId, cceId) =>
      retryTransient(() => client.cartaCorrecaoDanfe(pedidoId, nfeId, cceId)),
    statusServico: (target, filialId) =>
      retryTransient(() => client.statusServico(target, filialId)),
    consultaCadastro: (cnpj, uf, filialId) =>
      retryTransient(() => client.consultaCadastro(cnpj, uf, filialId)),
    uploadCertificado: (filialId, pfxBase64, password, filename) =>
      retryTransient(() => client.uploadCertificado(filialId, pfxBase64, password, filename)),
    deleteCertificado: (filialId) => retryTransient(() => client.deleteCertificado(filialId)),
  };
}
