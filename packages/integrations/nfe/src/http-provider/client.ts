/**
 * HTTP client for `apps/nfe`. Browser- and Node-callable; wraps the
 * three routes (`/api/nfe/emitir`, `/api/nfe/consultar`,
 * `/api/nfe/processar-pendentes`) with typed results and a Bearer
 * Firebase ID token from the caller's auth context.
 *
 * Replaces the throwing `createNFeProvider()` stub: production
 * `apps/web` registers an `InvoiceProvider` backed by this client.
 */
import type { EstadoNFe } from '@delfrance/schemas';

import {
  NFeAuthError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeCertificateError,
  NFeDanfeUnavailableError,
  NFeHttpError,
  NFeInutilizacaoAbortedError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
} from './errors';

/** Mirrors `apps/nfe/lib/nfe/orchestrator.ts:EmitResult`. */
export interface NFeEmitResult {
  readonly nfeId: string;
  readonly pedidoId: string;
  readonly estado: EstadoNFe;
  readonly chave: string;
  readonly nRec: string | null;
  readonly cStat: string;
  readonly xMotivo: string;
  /**
   * `true` when the server short-circuited because an existing nfev4 doc
   * was already in a `STATUS_BLOQUEADORES` cStat (the dedup branch in
   * `emitirPedido`). `false` (or absent, for backward compat with older
   * route responses) when a fresh emission round-trip ran.
   */
  readonly reused?: boolean;
}

/** Mirrors `apps/nfe/lib/nfe/orchestrator.ts:EmitError` — per-pedido failure inside a batch. */
export interface NFeEmitError {
  readonly pedidoId: string;
  readonly errorCode: string;
  readonly errorMessage: string;
}

/** Discriminate `NFeEmitResult` from `NFeEmitError` in a batch result. */
export function isNFeEmitError(r: NFeEmitResult | NFeEmitError): r is NFeEmitError {
  return (r as NFeEmitError).errorCode !== undefined;
}

/** Mirrors `apps/nfe/lib/nfe/orchestrator.ts:BatchEmitResult`. */
export interface NFeBatchEmitResult {
  readonly results: ReadonlyArray<NFeEmitResult | NFeEmitError>;
}

/** Mirrors `apps/nfe/app/api/nfe/consultar/route.ts` response. */
export interface NFeConsultaResult {
  readonly chave: string;
  readonly cStat: string;
  readonly xMotivo: string;
  readonly nProt: string | null;
  /** Raw `TRetConsSitNFe` for callers that need the full payload. */
  readonly raw: unknown;
}

/** Mirrors `apps/nfe/app/api/nfe/processar-pendentes/route.ts` response. */
export interface NFeProcessarPendentesResult {
  readonly scanned: number;
  readonly recovered: number;
  readonly stillPending: number;
  readonly errors: number;
}

/** Args for an inutilização — a contiguous número range on a filial's série. */
export interface NFeInutilizarArgs {
  readonly filialId: string;
  readonly serie: number;
  readonly nNFIni: number;
  readonly nNFFin: number;
  /** Justification — SEFAZ requires 15–255 chars. */
  readonly xJust: string;
}

/** Mirrors `apps/nfe/lib/nfe/orchestrator.ts:InutilizarNumeracaoResult`. */
export interface NFeInutilizarResult {
  readonly filialId: string;
  readonly serie: number;
  readonly nNFIni: number;
  readonly nNFFin: number;
  readonly cStat: string;
  readonly xMotivo: string;
  readonly nProt: string | null;
  /** `true` when SEFAZ homologou (cStat 102). */
  readonly aprovada: boolean;
  /** Count of NF-e docs flipped to `numeracaoInutilizada` after a 102. */
  readonly reconciled: number;
}

/** DANFE output formats the `GET /api/nfe/danfe` route serves. */
export type NFeDanfeFormat = 'simplificado' | 'retrato' | 'paisagem' | 'zpl2';

/** A downloaded DANFE artifact — the binary Blob plus its server filename. */
export interface NFeDanfeArtifact {
  readonly blob: Blob;
  /** Filename from the `Content-Disposition` header (e.g. `danfe-7.pdf`). */
  readonly filename: string;
  readonly contentType: string;
}

/** Mirrors `apps/nfe/app/api/nfe/status-servico/route.ts` response. */
export interface NFeStatusServicoResult {
  readonly target: 'normal' | 'svc';
  /** `'sefaz'` for the home SEFAZ; `'svc-an'` / `'svc-rs'` for the SVC. */
  readonly authorizer: string;
  readonly cStat: string;
  readonly xMotivo: string;
  readonly dhRecbto: string | null;
  /** Average processing time hint (seconds), when SEFAZ returns one. */
  readonly tMed: string | null;
  /** `classifyCStat` category — `'servico-em-operacao'` is the green state. */
  readonly category: string;
}

/** Mirrors `apps/nfe/app/api/nfe/carta-correcao/route.ts` response. */
export interface NFeCartaCorrecaoResult {
  readonly pedidoId: string;
  readonly nfeId: string;
  /** Event sequence number used for this CC-e (1, 2, 3, …). */
  readonly nSeqEvento: number;
  readonly cStat: string;
  readonly xMotivo: string;
  /** Event protocolo returned on cStat=135. */
  readonly nProt: string | null;
  /** `true` when SEFAZ registrou e vinculou (cStat 135). */
  readonly accepted: boolean;
  /**
   * `true` when SEFAZ registrou mas NÃO vinculou (cStat 136) — the CC-e is
   * aguardando vínculo and an async re-check was scheduled (mutually exclusive
   * with `accepted`). The route still returns 200; the re-check resolves it. #81.
   */
  readonly pending: boolean;
  /** The persisted `cartacorrecao` record id. */
  readonly cceId: string;
}

/**
 * Public A1 certificate metadata returned by the cert upload route — mirrors
 * `certificadoFilialInfoSchema`. Never carries key material.
 */
export interface NFeCertificadoMeta {
  readonly subjectCommonName: string;
  readonly cnpj: string;
  /** ms since epoch. */
  readonly notAfter: number;
  readonly filename: string;
  /** ms since epoch. */
  readonly uploadedAt: number;
}

/**
 * Caller-provided config. `baseUrl` is the origin of `apps/nfe`
 * (in dev: `http://localhost:3004`; in prod: `https://nfe-<env>.web.app`).
 * `getAuthToken` runs on every call so a Firebase ID-token refresh
 * is picked up transparently. `fetch` is injectable for tests.
 */
export interface NFeHttpClientConfig {
  readonly baseUrl: string;
  readonly getAuthToken: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface NFeHttpClient {
  emitir(pedidoId: string): Promise<NFeEmitResult>;
  emitirLote(pedidoIds: ReadonlyArray<string>): Promise<NFeBatchEmitResult>;
  consultar(chave: string): Promise<NFeConsultaResult>;
  processarPendentes(): Promise<NFeProcessarPendentesResult>;
  /** Cancel a specific authorized NF-e (RecepcaoEvento, tpEvento=110111). */
  cancelar(pedidoId: string, nfeId: string, xJust: string): Promise<NFeEmitResult>;
  /** Inutilizar an unused número range (NfeInutilizacao4). */
  inutilizar(args: NFeInutilizarArgs): Promise<NFeInutilizarResult>;
  /** Register a carta de correção (CC-e) for an authorized NF-e (RecepcaoEvento, tpEvento=110110). */
  cartaCorrecao(
    pedidoId: string,
    nfeId: string,
    xCorrecao: string,
  ): Promise<NFeCartaCorrecaoResult>;
  /**
   * Download the DANFE for an authorized NF-e as a binary artifact (PDF for
   * `simplificado`, the ZPL label text for `zpl2`). `dpi` tunes the ZPL
   * printhead density (default 203). Returns the Blob + its server filename.
   */
  danfe(
    pedidoId: string,
    nfeId: string,
    format: NFeDanfeFormat,
    dpi?: number,
  ): Promise<NFeDanfeArtifact>;
  /**
   * Download the Carta de Correção PDF for a specific registrada CC-e
   * (`cartacorrecao/{cceId}`). Returns the Blob + its server filename.
   */
  cartaCorrecaoDanfe(pedidoId: string, nfeId: string, cceId: string): Promise<NFeDanfeArtifact>;
  /**
   * Check SEFAZ availability (NfeStatusServico4) — `'normal'` asks the home
   * SEFAZ, `'svc'` asks the UF's contingency environment. `filialId` names the
   * filial whose A1 cert signs the mTLS handshake (the server doesn't require a
   * shared env cert — it signs per-filial). Decision support for the manual
   * contingency toggle.
   */
  statusServico(target: 'normal' | 'svc', filialId: string): Promise<NFeStatusServicoResult>;
  /**
   * Upload a filial's A1 certificate (.pfx/.p12, base64) + its password. The
   * server validates the PFX, encrypts the private key at rest, and returns
   * only the public metadata — the password + key never come back.
   */
  uploadCertificado(
    filialId: string,
    pfxBase64: string,
    password: string,
    filename: string,
  ): Promise<NFeCertificadoMeta>;
  /** Remove a filial's stored A1 certificate (secret doc + filial metadata). */
  deleteCertificado(filialId: string): Promise<void>;
}

/** Pull the filename out of a `Content-Disposition` header, if present. */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/** Strip a trailing slash off `baseUrl` so route concatenation is clean. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Map an HTTP error response to one of our typed errors. The route
 * layer in `apps/nfe` returns `{ error, code? }` for failures — we
 * inspect status code first, fall back to message on the body.
 */
function errorFromResponse(
  status: number,
  body: unknown,
  context: { pedidoId?: string },
): NFeHttpError {
  const message =
    body !== null && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${status}`;

  const bodyCode =
    body !== null && typeof body === 'object' && 'code' in body
      ? (body as { code: unknown }).code
      : undefined;

  // A per-filial cert pre-flight failure (no stored cert / wrong key / expired)
  // is resolved BEFORE any SEFAZ contact. The routes tag it `code: 'NFeCertError'`
  // — surface it as a dedicated cert error carrying the route's pt-BR message,
  // never as an `NFeRejectedError` ("SEFAZ rejected: …"), which the generic 422
  // mapping below would otherwise produce.
  if (bodyCode === 'NFeCertError') {
    return new NFeCertificateError(message, status, body, 'NFeCertError');
  }

  if (status === 400) return new NFeBadRequestError(message, body);
  if (status === 401 || status === 403) return new NFeAuthError(message, status, body);
  if (status === 404) {
    return new NFePedidoNotFoundError(context.pedidoId ?? '(unknown)', body);
  }
  if (status === 409) {
    // 409 is shared: the inutilização pre-check abort carries an explicit
    // marker; everything else at 409 is the bloquearEmissaoNFe emit block.
    if (bodyCode === 'INUTILIZACAO_ABORTED') {
      return new NFeInutilizacaoAbortedError(message, body);
    }
    return new NFeBlockedError(context.pedidoId ?? '(unknown)', body);
  }
  if (status === 422) {
    // The route returns the full EmitResult on 422 — extract cStat + xMotivo.
    const result = body as Partial<NFeEmitResult> | null;
    return new NFeRejectedError(result?.cStat ?? '(unknown)', result?.xMotivo ?? message, body);
  }
  if (status === 503) return new NFeRuntimeNotReadyError(message, body);
  return new NFeServerError(message, status, body);
}

/**
 * Error mapping for the cert endpoints (`/api/nfe/certificado`). The upload
 * **never contacts SEFAZ**, so its 422 is a cert-validation failure carrying a
 * pt-BR `error` message — NOT an `NFeRejectedError` ("SEFAZ rejected: …"), which
 * the generic 422 mapping would wrongly produce. Auth (401/403) still maps to
 * `NFeAuthError`; everything else becomes an `NFeCertificateError` whose message
 * is the route's pt-BR text, ready to show.
 */
function certErrorFromResponse(status: number, body: unknown): NFeHttpError {
  const message =
    body !== null && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${status}`;
  if (status === 401 || status === 403) return new NFeAuthError(message, status, body);
  const code =
    body !== null && typeof body === 'object' && 'code' in body
      ? String((body as { code: unknown }).code)
      : undefined;
  return new NFeCertificateError(message, status, body, code);
}

/**
 * Construct the HTTP client. The returned object is stateless modulo
 * the auth-token callback — safe to share across requests.
 */
export function createNFeHttpClient(config: NFeHttpClientConfig): NFeHttpClient {
  const baseUrl = normalizeBase(config.baseUrl);
  const doFetch = config.fetch ?? globalThis.fetch;

  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    init: {
      body?: unknown;
      context?: { pedidoId?: string };
      /** Override the default status→error mapping (cert endpoints use this). */
      mapError?: (status: number, body: unknown) => NFeHttpError;
    } = {},
  ): Promise<T> {
    const token = await config.getAuthToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const requestInit: RequestInit = { method, headers };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestInit.body = JSON.stringify(init.body);
    }

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, requestInit);
    } catch (err) {
      // fetch throws TypeError on network/abort failures — never on HTTP
      // status. Distinguish so callers can retry confidently.
      throw new NFeNetworkError(err instanceof Error ? err.message : 'fetch failed', err);
    }

    // Body parse — tolerate empty bodies on errors (some 503 paths
    // don't ship JSON).
    let body: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch (err) {
        if (err instanceof SyntaxError) {
          // Server returned non-JSON. Treat as a generic server error
          // with the raw text as the body — preserves diagnostics.
          body = { error: text };
        } else {
          throw err;
        }
      }
    }

    if (!res.ok) {
      const mapError =
        init.mapError ?? ((s: number, b: unknown) => errorFromResponse(s, b, init.context ?? {}));
      throw mapError(res.status, body);
    }
    return body as T;
  }

  /** Like `call`, but for a binary (non-JSON) success body. Errors are JSON. */
  async function fetchArtifact(
    path: string,
    fallbackName: string,
    context: { pedidoId?: string } = {},
  ): Promise<NFeDanfeArtifact> {
    const token = await config.getAuthToken();
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new NFeNetworkError(err instanceof Error ? err.message : 'fetch failed', err);
    }
    if (!res.ok) {
      let body: unknown = null;
      const text = await res.text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch (err) {
          if (err instanceof SyntaxError) body = { error: text };
          else throw err;
        }
      }
      // The DANFE route's 422 means "not renderable" (a presentation
      // precondition), NOT a SEFAZ rejection — `errorFromResponse` would
      // mis-map it to `NFeRejectedError`. Surface the dedicated error instead.
      if (res.status === 422) {
        const message =
          body !== null && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : 'DANFE indisponível';
        throw new NFeDanfeUnavailableError(message, body);
      }
      throw errorFromResponse(res.status, body, context);
    }
    const blob = await res.blob();
    return {
      blob,
      filename: filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  return {
    emitir: (pedidoId) =>
      call<NFeEmitResult>('POST', '/api/nfe/emitir', {
        body: { pedidoId },
        context: { pedidoId },
      }),
    emitirLote: (pedidoIds) =>
      call<NFeBatchEmitResult>('POST', '/api/nfe/emitir-lote', {
        body: { pedidoIds: [...pedidoIds] },
      }),
    consultar: (chave) =>
      call<NFeConsultaResult>('GET', `/api/nfe/consultar?chave=${encodeURIComponent(chave)}`),
    processarPendentes: () =>
      call<NFeProcessarPendentesResult>('POST', '/api/nfe/processar-pendentes', {
        body: {},
      }),
    cancelar: (pedidoId, nfeId, xJust) =>
      call<NFeEmitResult>('POST', '/api/nfe/cancelar', {
        body: { pedidoId, nfeId, xJust },
        context: { pedidoId },
      }),
    inutilizar: (args) =>
      call<NFeInutilizarResult>('POST', '/api/nfe/inutilizar', { body: { ...args } }),
    cartaCorrecao: (pedidoId, nfeId, xCorrecao) =>
      call<NFeCartaCorrecaoResult>('POST', '/api/nfe/carta-correcao', {
        body: { pedidoId, nfeId, xCorrecao },
        context: { pedidoId },
      }),
    danfe: (pedidoId, nfeId, format, dpi) => {
      const params = new URLSearchParams({ pedidoId, nfeId, format });
      if (dpi != null) params.set('dpi', String(dpi));
      const ext = format === 'zpl2' ? 'txt' : 'pdf';
      return fetchArtifact(`/api/nfe/danfe?${params.toString()}`, `danfe.${ext}`, { pedidoId });
    },
    cartaCorrecaoDanfe: (pedidoId, nfeId, cceId) => {
      const params = new URLSearchParams({ pedidoId, nfeId, cceId });
      return fetchArtifact(
        `/api/nfe/carta-correcao/danfe?${params.toString()}`,
        'carta-correcao.pdf',
        { pedidoId },
      );
    },
    statusServico: (target, filialId) =>
      call<NFeStatusServicoResult>(
        'GET',
        `/api/nfe/status-servico?target=${encodeURIComponent(target)}&filialId=${encodeURIComponent(filialId)}`,
      ),
    uploadCertificado: (filialId, pfxBase64, password, filename) =>
      call<NFeCertificadoMeta>('POST', '/api/nfe/certificado', {
        body: { filialId, pfxBase64, password, filename },
        mapError: certErrorFromResponse,
      }),
    deleteCertificado: async (filialId) => {
      await call<{ ok: boolean }>(
        'DELETE',
        `/api/nfe/certificado?filialId=${encodeURIComponent(filialId)}`,
        { mapError: certErrorFromResponse },
      );
    },
  };
}
