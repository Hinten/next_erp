/**
 * `withNFeRetry` — wraps an `NFeHttpClient` so transient failures retry with
 * jittered exponential backoff (#90), with a **per-endpoint** policy. Pure (no
 * React), so it unit-tests without an auth/Firebase context.
 *
 * Policy:
 *   - GET / idempotent (`consultar`, `statusServico`, `danfe`,
 *     `cartaCorrecaoDanfe`, `processarPendentes`) → full transient set
 *     (`isRetryableNFeHttpError`: network / 5xx / 503).
 *   - server-deduped POSTs (`emitir`, `emitirLote`, `cancelar`) → full transient
 *     set. A re-POST converges to a no-op: emit/lote via PR1's dedup (stable doc
 *     id + `isBloqueada` + in-flight-nRec skip) → `reused:true`; `cancelar`
 *     reconciles a duplicate-event 573 → `cancelada`.
 *   - cert management (`uploadCertificado`, `deleteCertificado`) → full
 *     transient set (upload overwrites the same cert; delete is idempotent).
 *   - **`cartaCorrecao` and `inutilizar` → pre-send 503 only.** Neither is
 *     idempotent on a re-send: `cartaCorrecao` increments `nSeqEvento`, and a
 *     re-sent `inutilizar` of an already-homologada range returns cStat 563,
 *     which `inutilizar.ts` surfaces as a rejection (unlike `cancelar`'s 573).
 *     So a post-send network/5xx must never auto-retry these — only
 *     `NFeRuntimeNotReadyError`, provably raised before any SEFAZ contact.
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

/** Only the pre-SEFAZ-contact 503 is safe to retry for a non-idempotent call. */
const isPreSendOnly = (err: unknown): boolean => err instanceof NFeRuntimeNotReadyError;

export function withNFeRetry(client: NFeHttpClient): NFeHttpClient {
  return {
    emitir: (pedidoId) => retryTransient(() => client.emitir(pedidoId)),
    emitirLote: (pedidoIds) => retryTransient(() => client.emitirLote(pedidoIds)),
    consultar: (chave) => retryTransient(() => client.consultar(chave)),
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
    uploadCertificado: (filialId, pfxBase64, password, filename) =>
      retryTransient(() => client.uploadCertificado(filialId, pfxBase64, password, filename)),
    deleteCertificado: (filialId) => retryTransient(() => client.deleteCertificado(filialId)),
  };
}
