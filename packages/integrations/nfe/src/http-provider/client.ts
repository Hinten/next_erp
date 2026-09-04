/**
 * HTTP client for `apps/nfe`. Browser- and Node-callable; wraps the
 * three routes (`/api/nfe/emitir`, `/api/nfe/consultar`,
 * `/api/nfe/processar-pendentes`) with typed results and a Bearer
 * Firebase ID token from the caller's auth context.
 *
 * Replaces the throwing `createNFeProvider()` stub: production
 * `apps/web` registers an `InvoiceProvider` backed by this client.
 */
import { z } from 'zod';

import { lerRespostaJson, resumirCampos } from '@delfrance/core/wire';
import { estadoNFeSchema } from '@delfrance/schemas';

import {
  NFeAuthError,
  NFeBadRequestError,
  NFeBlockedError,
  NFeCertificateError,
  NFeDanfeUnavailableError,
  type NFeHttpError,
  NFeInutilizacaoAbortedError,
  NFeNetworkError,
  NFePedidoNotFoundError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeSchemaError,
  NFeServerError,
} from './errors';

/**
 * ⚠️ Schemas rather than interfaces, with the types inferred from them.
 *
 * This is the highest-consequence of the six clients that ended in
 * `return parsed as T`: an EMPTY 200 on `/api/nfe/emitir` produced
 * `null as NFeEmitResult`, i.e. "the note was authorized" asserted with no
 * `chave`, no `nRec` and no `cStat`. The fiscal state machine then read
 * `undefined` off it.
 *
 * Numbers here are all `z.number()` rather than the tolerant `wireNumber()`
 * used on the marketplace clients, and that is deliberate: SEFAZ sends its own
 * values as STRINGS (`cStat`, `nProt`, `xMotivo` are all typed `string` below),
 * so every number in these shapes is one apps/nfe computed — a count, a stamp,
 * or an echoed request field. A string there is our own serialisation bug and
 * should be loud.
 *
 * Unknown keys pass; nothing is `.strict()`.
 */

/** Mirrors `apps/nfe/lib/nfe/orchestrator.ts:EmitResult`. */
export const nfeEmitResultSchema = z.object({
  nfeId: z.string(),
  pedidoId: z.string(),
  estado: estadoNFeSchema,
  chave: z.string(),
  nRec: z.string().nullable(),
  cStat: z.string(),
  xMotivo: z.string(),
  /**
   * `true` when the server short-circuited because an existing nfev4 doc was
   * already in a `STATUS_BLOQUEADORES` cStat.
   *
   * ⚠️ `.optional()` because the doc block says so in as many words —
   * "absent, for backward compat with older route responses". That is a
   * statement about the wire, so it belongs in the schema.
   */
  reused: z.boolean().optional(),
});
export type NFeEmitResult = z.infer<typeof nfeEmitResultSchema>;

/** Mirrors `apps/nfe/lib/nfe/orchestrator.ts:EmitError` — per-pedido failure inside a batch. */
export const nfeEmitErrorSchema = z.object({
  pedidoId: z.string(),
  errorCode: z.string(),
  errorMessage: z.string(),
});
export type NFeEmitError = z.infer<typeof nfeEmitErrorSchema>;

/** Discriminate `NFeEmitResult` from `NFeEmitError` in a batch result. */
export function isNFeEmitError(r: NFeEmitResult | NFeEmitError): r is NFeEmitError {
  return (r as NFeEmitError).errorCode !== undefined;
}

/**
 * Mirrors `apps/nfe/lib/nfe/orchestrator.ts:BatchEmitResult`.
 *
 * ⚠️ A UNION per element, not a merged object: `isNFeEmitError` discriminates on
 * `errorCode`, and a schema that merged the two would make every field optional
 * and hand that predicate nothing to work with.
 */
export const nfeBatchEmitResultSchema = z.object({
  results: z.array(z.union([nfeEmitResultSchema, nfeEmitErrorSchema])),
});
export type NFeBatchEmitResult = z.infer<typeof nfeBatchEmitResultSchema>;

/** Mirrors `apps/nfe/app/api/nfe/consultar/route.ts` response. */
export const nfeConsultaResultSchema = z.object({
  chave: z.string(),
  cStat: z.string(),
  xMotivo: z.string(),
  nProt: z.string().nullable(),
  /**
   * Raw `TRetConsSitNFe` for callers that need the full payload.
   *
   * ⚠️ Left `z.unknown()`: it is the SEFAZ envelope, nobody here reads it by
   * name, and modelling it would only invent a way to reject a response the
   * caller handles. The KEY is still required — in Zod 4 `z.unknown()` accepts
   * any value but does not make its key optional.
   */
  raw: z.unknown(),
});
export type NFeConsultaResult = z.infer<typeof nfeConsultaResultSchema>;

/** Mirrors `apps/nfe/lib/nfe/orchestrator/verificar.ts:VerificarChaveStatus`. */
export const nfeVerificarChaveStatusSchema = z.enum([
  'skipped-final',
  'atualizada',
  'sem-mudanca',
  'erro',
]);
export type NFeVerificarChaveStatus = z.infer<typeof nfeVerificarChaveStatusSchema>;

/** Mirrors `apps/nfe/lib/nfe/orchestrator/verificar.ts:VerificarChaveResult`. */
export const nfeVerificarChaveResultSchema = z.object({
  chave: z.string(),
  status: nfeVerificarChaveStatusSchema,
  estadoAnterior: estadoNFeSchema.nullable(),
  estadoNovo: estadoNFeSchema.nullable(),
  cStat: z.string().nullable(),
  xMotivo: z.string().nullable(),
  /** `name: message` of a per-chave failure — never the raw SEFAZ body. */
  error: z.string().nullable(),
});
export type NFeVerificarChaveResult = z.infer<typeof nfeVerificarChaveResultSchema>;

/** Mirrors `apps/nfe/app/api/nfe/verificar/route.ts` response. */
export const nfeVerificarResultSchema = z.object({
  filialId: z.string(),
  // ⚠️ No `.default([])` on either array. `verificarEnviNfeMsgs` always returns
  // both (`orchestrator/verificar.ts` returns `{ filialId, results,
  // msgsNaoEncontradas }` unconditionally) and no consumer reads them as
  // `?? []`, so a default could only ever rescue a FUTURE revision that dropped
  // the key — turning it into "zero chaves updated" instead of failing. That is
  // the same silent-empty-success this PR exists to remove. A `.default()` here
  // is earned by evidence about the wire, and there is none.
  results: z.array(nfeVerificarChaveResultSchema),
  /** Requested enviNfe msg ids that had no doc under the filial. */
  msgsNaoEncontradas: z.array(z.string()),
});
export type NFeVerificarResult = z.infer<typeof nfeVerificarResultSchema>;

/** One pendente the sweep could not resolve. */
export const nfeProcessarPendentesErroSchema = z.object({
  chave: z.string().nullable(),
  error: z.string(),
});

/**
 * Mirrors `apps/nfe/app/api/nfe/processar-pendentes/route.ts` response, which
 * is `runProcessarPendentes`'s `ProcessarPendentesResult` serialised verbatim.
 *
 * ⚠️ `errors` is a LIST, not a count. The interface this schema replaced
 * declared `errors: number` and had done since it was written — a lie the cast
 * made harmless and validation would have made fatal, because `z.number()`
 * rejects an array INCLUDING the clean-run `[]`. That would have been a 100%
 * outage of the ops poller, and the three fixtures in `client.test.ts` all
 * encoded the same wrong shape, so nothing in the suite could have caught it.
 * Exactly the `estado: 'aprovada'` failure this PR already documents, one field
 * over. Read the ROUTE, never the interface.
 */
export const nfeProcessarPendentesResultSchema = z.object({
  scanned: z.number(),
  recovered: z.number(),
  stillPending: z.number(),
  errors: z.array(nfeProcessarPendentesErroSchema),
});
export type NFeProcessarPendentesResult = z.infer<typeof nfeProcessarPendentesResultSchema>;

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
export const nfeInutilizarResultSchema = z.object({
  filialId: z.string(),
  serie: z.number(),
  nNFIni: z.number(),
  nNFFin: z.number(),
  cStat: z.string(),
  xMotivo: z.string(),
  nProt: z.string().nullable(),
  /** `true` when SEFAZ homologou (cStat 102). */
  aprovada: z.boolean(),
  /** Count of NF-e docs flipped to `numeracaoInutilizada` after a 102. */
  reconciled: z.number(),
});
export type NFeInutilizarResult = z.infer<typeof nfeInutilizarResultSchema>;

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
export const nfeStatusServicoResultSchema = z.object({
  target: z.enum(['normal', 'svc']),
  /** `'sefaz'` for the home SEFAZ; `'svc-an'` / `'svc-rs'` for the SVC. */
  authorizer: z.string(),
  cStat: z.string(),
  xMotivo: z.string(),
  dhRecbto: z.string().nullable(),
  /** Average processing time hint (seconds), when SEFAZ returns one. */
  tMed: z.string().nullable(),
  /** `classifyCStat` category — `'servico-em-operacao'` is the green state. */
  category: z.string(),
});
export type NFeStatusServicoResult = z.infer<typeof nfeStatusServicoResultSchema>;

/**
 * One taxpayer's registry entry from a Consulta Cadastro lookup — browser-safe,
 * friendly field names (the `apps/nfe` route maps the raw SEFAZ casing
 * xNome/cSit/xLgr/… onto these so the browser never sees the wire shape).
 */
export const nfeConsultaCadastroInfCadSchema = z.object({
  ie: z.string(),
  cnpj: z.string().nullable(),
  cpf: z.string().nullable(),
  uf: z.string(),
  /** cSit: '0' não habilitado, '1' habilitado. */
  situacao: z.string(),
  razaoSocial: z.string().nullable(),
  ender: z
    .object({
      logradouro: z.string().nullable(),
      numero: z.string().nullable(),
      complemento: z.string().nullable(),
      bairro: z.string().nullable(),
      /** cMun (IBGE). */
      codigoMunicipio: z.string().nullable(),
      /** xMun. */
      municipio: z.string().nullable(),
      cep: z.string().nullable(),
    })
    .nullable(),
});
export type NFeConsultaCadastroInfCad = z.infer<typeof nfeConsultaCadastroInfCadSchema>;

/** Mirrors `apps/nfe/app/api/nfe/consulta-cadastro/route.ts` response. */
export const nfeConsultaCadastroResultSchema = z.object({
  /** `false` → UF doesn't offer consulta cadastro / cross-UF not vendored. */
  supported: z.boolean(),
  uf: z.string(),
  /** `null` when degraded/unsupported. */
  cStat: z.string().nullable(),
  xMotivo: z.string().nullable(),
  /** `true` on a transport failure where the request was otherwise valid. */
  degraded: z.boolean().optional(),
  // No `.default([])`: all four branches of `consulta-cadastro/route.ts` send
  // `infCad`, including both `supported:false` ones and the degraded one.
  infCad: z.array(nfeConsultaCadastroInfCadSchema),
});
export type NFeConsultaCadastroResult = z.infer<typeof nfeConsultaCadastroResultSchema>;

/** Mirrors `apps/nfe/app/api/nfe/carta-correcao/route.ts` response. */
export const nfeCartaCorrecaoResultSchema = z.object({
  pedidoId: z.string(),
  nfeId: z.string(),
  /** Event sequence number used for this CC-e (1, 2, 3, …). */
  nSeqEvento: z.number(),
  cStat: z.string(),
  xMotivo: z.string(),
  /** Event protocolo returned on cStat=135. */
  nProt: z.string().nullable(),
  /** `true` when SEFAZ registrou e vinculou (cStat 135). */
  accepted: z.boolean(),
  /**
   * `true` when SEFAZ registrou mas NÃO vinculou (cStat 136) — the CC-e is
   * aguardando vínculo and an async re-check was scheduled (mutually exclusive
   * with `accepted`). The route still returns 200; the re-check resolves it. #81.
   */
  pending: z.boolean(),
  /** The persisted `cartacorrecao` record id. */
  cceId: z.string(),
});
export type NFeCartaCorrecaoResult = z.infer<typeof nfeCartaCorrecaoResultSchema>;

/**
 * Public A1 certificate metadata returned by the cert upload route — mirrors
 * `certificadoFilialInfoSchema`. Never carries key material.
 */
export const nfeCertificadoMetaSchema = z.object({
  subjectCommonName: z.string(),
  cnpj: z.string(),
  /** ms since epoch. */
  notAfter: z.number(),
  filename: z.string(),
  /** ms since epoch. */
  uploadedAt: z.number(),
});
export type NFeCertificadoMeta = z.infer<typeof nfeCertificadoMetaSchema>;

/** `DELETE /api/nfe/certificado` — the body nobody reads, validated anyway. */
export const nfeOkSchema = z.object({ ok: z.boolean() });

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
  /**
   * Re-verify the NF-es referenced by up to 10 `enviNfe` audit msgs against
   * SEFAZ (the "Verificar novamente" action). Always resolves with per-chave
   * statuses for an authorized request — per-chave failures live in
   * `results[]`, never as a thrown error.
   */
  verificar(filialId: string, enviNfeMsgIds: ReadonlyArray<string>): Promise<NFeVerificarResult>;
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
   * Query SEFAZ Consulta Cadastro (NFeConsultaCadastro4) for a CNPJ in a UF.
   * Best-effort — resolves (never throws) on an unsupported UF or SEFAZ
   * downtime; the route returns `supported:false` / `degraded` instead.
   */
  consultaCadastro(cnpj: string, uf: string, filialId: string): Promise<NFeConsultaCadastroResult>;
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

  async function call<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: S,
    init: {
      body?: unknown;
      context?: { pedidoId?: string };
      /** Override the default status→error mapping (cert endpoints use this). */
      mapError?: (status: number, body: unknown) => NFeHttpError;
    } = {},
  ): Promise<z.infer<S>> {
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

    const text = await res.text();

    if (!res.ok) {
      // Tolerate empty bodies on errors (some 503 paths don't ship JSON).
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch (err) {
          if (err instanceof SyntaxError) {
            // Server returned non-JSON. Keep the raw text as the body —
            // preserves diagnostics on the ERROR path, where the mapper decides
            // what reaches the caller.
            body = { error: text };
          } else {
            throw err;
          }
        }
      }
      const mapError =
        init.mapError ?? ((s: number, b: unknown) => errorFromResponse(s, b, init.context ?? {}));
      throw mapError(res.status, body);
    }

    const leitura = lerRespostaJson(text, schema);
    if (leitura.ok) return leitura.data;

    // ⚠️ The success path deliberately does NOT reuse the error path's
    // `{ error: text }` fallback. On an error a raw body is diagnostics; on a
    // 2xx it is a body claiming to be a fiscal result, and handing it on is how
    // an empty 200 on `/api/nfe/emitir` used to assert "authorized" with no
    // chave, no nRec and no cStat.
    // ⚠️ EMPTY and NON-JSON share the first arm: neither is version skew — in
    // both the request failed to reach a route that answers JSON. An empty 200
    // on `/api/nfe/emitir` is the sharpest case in the repo, so it must not be
    // reported as a field problem.
    throw new NFeSchemaError(
      leitura.motivo !== 'formato'
        ? `A integração fiscal respondeu HTTP ${String(res.status)} sem um corpo JSON — o ` +
            'pedido não chegou à rota esperada.'
        : 'A integração fiscal respondeu num formato que este aplicativo não reconhece. ' +
            `Campos inválidos: ${resumirCampos(leitura.campos)}.`,
      res.status,
      leitura.motivo !== 'formato' ? [] : leitura.campos,
    );
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
      call('POST', '/api/nfe/emitir', nfeEmitResultSchema, {
        body: { pedidoId },
        context: { pedidoId },
      }),
    emitirLote: (pedidoIds) =>
      call('POST', '/api/nfe/emitir-lote', nfeBatchEmitResultSchema, {
        body: { pedidoIds: [...pedidoIds] },
      }),
    consultar: (chave) =>
      call('GET', `/api/nfe/consultar?chave=${encodeURIComponent(chave)}`, nfeConsultaResultSchema),
    verificar: (filialId, enviNfeMsgIds) =>
      call('POST', '/api/nfe/verificar', nfeVerificarResultSchema, {
        body: { filialId, enviNfeMsgIds: [...enviNfeMsgIds] },
      }),
    processarPendentes: () =>
      call('POST', '/api/nfe/processar-pendentes', nfeProcessarPendentesResultSchema, {
        body: {},
      }),
    cancelar: (pedidoId, nfeId, xJust) =>
      call('POST', '/api/nfe/cancelar', nfeEmitResultSchema, {
        body: { pedidoId, nfeId, xJust },
        context: { pedidoId },
      }),
    inutilizar: (args) =>
      call('POST', '/api/nfe/inutilizar', nfeInutilizarResultSchema, { body: { ...args } }),
    cartaCorrecao: (pedidoId, nfeId, xCorrecao) =>
      call('POST', '/api/nfe/carta-correcao', nfeCartaCorrecaoResultSchema, {
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
      call(
        'GET',
        `/api/nfe/status-servico?target=${encodeURIComponent(target)}&filialId=${encodeURIComponent(filialId)}`,
        nfeStatusServicoResultSchema,
      ),
    consultaCadastro: (cnpj, uf, filialId) =>
      // POST (not GET) so the queried CNPJ travels in the body, never in a URL
      // that would land in access logs / proxies / browser history.
      call('POST', '/api/nfe/consulta-cadastro', nfeConsultaCadastroResultSchema, {
        body: { cnpj, uf, filialId },
      }),
    uploadCertificado: (filialId, pfxBase64, password, filename) =>
      call('POST', '/api/nfe/certificado', nfeCertificadoMetaSchema, {
        body: { filialId, pfxBase64, password, filename },
        mapError: certErrorFromResponse,
      }),
    deleteCertificado: async (filialId) => {
      await call(
        'DELETE',
        `/api/nfe/certificado?filialId=${encodeURIComponent(filialId)}`,
        nfeOkSchema,
        { mapError: certErrorFromResponse },
      );
    },
  };
}
