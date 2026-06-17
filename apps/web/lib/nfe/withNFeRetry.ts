/**
 * `withNFeRetry` — wraps an `NFeHttpClient` so transient failures retry with
 * jittered exponential backoff (#90), with a **per-endpoint** policy. Pure (no
 * React), so it unit-tests without an auth/Firebase context.
 *
 * Policy:
 *   - GET / idempotent (`consultar`, `statusServico`, `danfe`,
 *     `cartaCorrecaoDanfe`, `processarPendentes`) → full transient set
 *     (`isRetryableNFeHttpError`: network / 5xx / 503).
 *   - server-deduped POSTs (`emitir`, `emitirLote`, `cancelar`, `inutilizar`)
 *     → full transient set. Server dedup (stable doc id + `isBloqueada` + the
 *     in-flight-nRec skip from PR1) makes a re-POST converge to `reused:true`
 *     instead of a duplicate emission.
 *   - cert management (`uploadCertificado`, `deleteCertificado`) → full
 *     transient set (upload overwrites the same cert; delete is idempotent).
 *   - **`cartaCorrecao` → pre-send 503 only.** It is NOT idempotent (each send
 *     increments `nSeqEvento`), so a post-send network/5xx must never auto-retry
 *     — only `NFeRuntimeNotReadyError`, which is provably raised before any
 *     SEFAZ contact.
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
    inutilizar: (args) => retryTransient(() => client.inutilizar(args)),
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
