/**
 * The two Login with Amazon (LWA) token exchanges SP-API needs:
 *
 * - {@link trocarRefreshToken} — `grant_type=refresh_token`: the seller's
 *   long-lived refresh token for a one-hour access token.
 * - {@link trocarCodigoAutorizacao} — `grant_type=authorization_code`: the
 *   `spapi_oauth_code` the consent redirect delivered (single-use, valid five
 *   minutes) for the seller's refresh token and a first access token.
 *
 * Both are one `POST https://api.amazon.com/auth/o2/token`, form-encoded, with
 * the app's client id and secret in the BODY [D:connecting-to-the-selling-partner-api,
 * D:website-authorization-workflow]. There is no PKCE in this flow (`pkce:
 * 'nao'`). There is no `client_credentials` (grantless) grant: no pre-cutover
 * step calls a grantless operation from code (`createDestination` /
 * `createSubscription` are a manual action, master plan §4.26), and the first
 * planned consumer is P2's secret rotation, which adds it. Nothing here
 * precludes it.
 *
 * ## The secrets
 *
 * ⚠️ The client secret, the refresh token and the authorization code travel in
 * the form body of the POST and NOWHERE else: never a URL, an error, a message,
 * a `cause` or an observer event. Each must be visible ASCII, checked before
 * anything is sent, and none is ever trimmed.
 *
 * ⚠️ **No LWA body reaches anything but the parser.** A 200 IS the token pair; an
 * error carries an `error_description`. The observer event always has
 * `corpo: null`, and an error carries only the `error` CODE (`codigoLwa`), read
 * through a closed set.
 *
 * ## Classification — by the body's `error`, then the status
 *
 * LWA documents only that "for some errors" it may answer 401; RFC 6749 §5.2
 * defaults token errors to 400. So the code decides, not the status:
 *
 * | response | error |
 * | --- | --- |
 * | 2xx with a valid token | the result |
 * | 2xx otherwise (HTML, empty, no `access_token`, a token outside visible ASCII, `expires_in` ≤ 0, a code exchange without `refresh_token`) | `AmazonSchemaError` |
 * | 5xx | `AmazonHttpError`, transient (whatever the body says) |
 * | 429 | `AmazonThrottleError` |
 * | 401 or 403, or a 4xx whose `error` is `invalid_grant`, `invalid_client` or `unauthorized_client` | `AmazonAuthError` with `destino: 'lwa'` and `codigoLwa` |
 * | 404 | `AmazonNotFoundError` |
 * | any other non-2xx (a 3xx, an `invalid_request` 400) | `AmazonHttpError`, not transient |
 *
 * ⚠️ What a REVOKED refresh token answers is undocumented (`gap-seller-auth.md`
 * §3); `invalid_grant` is RFC 6749's reading and is confirmed only in the
 * migration window (D11). And `invalid_client` refuses OUR app's secret, not
 * the seller — `AmazonAuthError` says which, and the app decides what to park.
 *
 * No retry here. A cut code exchange may have spent the code (`prazos.ts`).
 */
import { lerRespostaJson } from '@delfrance/core/wire';

import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonHttpError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  type CodigoErroLwa,
  type ContextoRequisicaoAmazon,
  lerCodigoErroLwa,
} from './errors';
import { PRAZO_AMAZON_MS } from './prazos';
import {
  type ChamadaAmazon,
  contemSegredo,
  criarEmissor,
  ehAsciiVisivel,
  enviar,
  redirectUriValido,
  refValida,
  resolverFetch,
  userAgentValido,
} from './transporte';
import { lwaErroSchema, lwaTokenRespostaSchema } from './types';

/** The LWA token endpoint SP-API uses for every region. */
export const URL_TOKEN_LWA = 'https://api.amazon.com/auth/o2/token';

/** The path named in messages and events. */
const CAMINHO_TOKEN_LWA = '/auth/o2/token';

/** As the docs give it. */
const CONTENT_TYPE_FORM = 'application/x-www-form-urlencoded;charset=UTF-8';

/** The `error` codes that refuse a credential rather than a request. */
const CODIGOS_DE_CREDENCIAL: ReadonlySet<CodigoErroLwa> = new Set<CodigoErroLwa>([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
]);

/** The app's LWA credentials, from its registration. */
export interface CredenciaisAplicacaoLwa {
  readonly clientId: string;
  readonly clientSecret: string;
}

interface OpcoesTrocaLwa {
  readonly aplicacao: CredenciaisAplicacaoLwa;
  /**
   * An opaque, non-secret label for the credential being exchanged, echoed on
   * the result, every error and every event. 1–64 characters, containing none
   * of the secrets.
   */
  readonly ref: string;
  /** REQUIRED, with no default — see `OpcoesClienteSpApi.userAgent`. */
  readonly userAgent: string;
  /** Defaults to `globalThis.fetch`, resolved at call time. */
  readonly fetch?: typeof globalThis.fetch;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
  /** Defaults to `crypto.randomUUID()`. */
  readonly gerarCorrelationId?: () => string;
  /** Milliseconds, for `obtidoEmMs` and `latenciaMs`. Defaults to `Date.now`. */
  readonly agora?: () => number;
  /**
   * Called once if the POST was sent, with `corpo: null` always. Not called when
   * nothing was sent. ⚠️ An observer that throws propagates in place of the
   * outcome — which, after a code exchange, LOSES the refresh token. A logger
   * must never throw.
   */
  readonly onChamada?: (e: ChamadaAmazon) => void;
}

export interface OpcoesTrocaRefreshToken extends OpcoesTrocaLwa {
  /** The seller's LWA refresh token, raw. */
  readonly refreshToken: string;
}

export interface OpcoesTrocaCodigo extends OpcoesTrocaLwa {
  /** The `spapi_oauth_code` from the consent redirect, raw. */
  readonly codigo: string;
  /** The redirect URI the code was delivered to, exactly as used at consent. */
  readonly redirectUri: string;
}

export interface TokenAcessoLwa {
  /** For `x-amz-access-token`. Visible ASCII, checked. */
  readonly accessToken: string;
  /** `token_type` as Amazon sent it (`'bearer'`). */
  readonly tipoToken: string;
  /** `expires_in`, seconds, as Amazon sent it (typically 3600). */
  readonly expiraEmS: number;
  /**
   * `agora()` when the request STARTED, in ms — so `obtidoEmMs + expiraEmS *
   * 1000` errs early, never late.
   */
  readonly obtidoEmMs: number;
  readonly correlationId: string;
  readonly requestIdAmazon: string | null;
  readonly refCredencial: string;
}

export interface TokensAutorizacaoLwa extends TokenAcessoLwa {
  /** The seller's refresh token. Store it securely; it does not rotate. */
  readonly refreshToken: string;
}

/**
 * Exchange a refresh token for an access token.
 *
 * The SP-API refresh token does not rotate, so whatever `refresh_token` the
 * answer may echo is ignored, and concurrent exchanges are harmless.
 */
export async function trocarRefreshToken(opts: OpcoesTrocaRefreshToken): Promise<TokenAcessoLwa> {
  const operacao = 'trocarRefreshToken';
  validarComum(opts, operacao, [opts.refreshToken]);
  const segredos = [opts.aplicacao.clientSecret, opts.refreshToken];
  validarRefEAgente(opts, operacao, segredos);

  const t = await trocar(
    opts,
    operacao,
    segredos,
    new URLSearchParams([
      ['grant_type', 'refresh_token'],
      ['refresh_token', opts.refreshToken],
      ['client_id', opts.aplicacao.clientId],
      ['client_secret', opts.aplicacao.clientSecret],
    ]),
    false,
  );
  return t.token;
}

/**
 * Exchange an authorization code for the seller's refresh token and a first
 * access token. ⚠️ Never retry it: the code is single-use (`prazos.ts`).
 */
export async function trocarCodigoAutorizacao(
  opts: OpcoesTrocaCodigo,
): Promise<TokensAutorizacaoLwa> {
  const operacao = 'trocarCodigoAutorizacao';
  validarComum(opts, operacao, [opts.codigo]);
  const segredos = [opts.aplicacao.clientSecret, opts.codigo];
  validarRefEAgente(opts, operacao, segredos);
  if (!redirectUriValido(opts.redirectUri)) {
    throw new AmazonConfigError('redirect-uri', { operacao, refCredencial: opts.ref });
  }

  const t = await trocar(
    opts,
    operacao,
    segredos,
    new URLSearchParams([
      ['grant_type', 'authorization_code'],
      ['code', opts.codigo],
      ['redirect_uri', opts.redirectUri],
      ['client_id', opts.aplicacao.clientId],
      ['client_secret', opts.aplicacao.clientSecret],
    ]),
    true,
  );
  return { ...t.token, refreshToken: t.refreshToken };
}

/**
 * The rule behind `AmazonConfigError('credencial-lwa')`, as a predicate: a
 * client id, client secret, refresh token or authorization code is usable only
 * when it is visible ASCII — at least one character, with no space, tab, line
 * break, control character or non-ASCII anywhere, and never trimmed.
 *
 * Both exchanges apply exactly this to every such value before anything is
 * sent. It is exported so a caller can refuse a value BEFORE spending something
 * irreversible on it: `apps/amazon`'s OAuth start checks the app's pair before a
 * consent begins (a trailing newline from a Secret Manager paste would otherwise
 * surface only after the seller consented), and its callback checks the code
 * before consuming the single-use state. One predicate, so the early check and
 * the exchange can never disagree.
 */
export function credencialLwaValida(valor: unknown): valor is string {
  return ehAsciiVisivel(valor);
}

/* -------------------------------------------------------------------------- */
/*                                  Internals                                 */
/* -------------------------------------------------------------------------- */

/**
 * The user-agent first (it is the caller's constant), then every credential —
 * each refused with `refCredencial: null`, before the `ref` is trusted.
 */
function validarComum(
  opts: OpcoesTrocaLwa,
  operacao: string,
  credenciaisDaConcessao: readonly string[],
): void {
  if (!userAgentValido(opts.userAgent)) {
    throw new AmazonConfigError('user-agent', { operacao, refCredencial: null });
  }
  const { clientId, clientSecret } = opts.aplicacao;
  if (![clientId, clientSecret, ...credenciaisDaConcessao].every(credencialLwaValida)) {
    throw new AmazonConfigError('credencial-lwa', { operacao, refCredencial: null });
  }
}

function validarRefEAgente(opts: OpcoesTrocaLwa, operacao: string, segredos: string[]): void {
  if (!refValida(opts.ref, segredos)) {
    throw new AmazonConfigError('ref', { operacao, refCredencial: null });
  }
  if (contemSegredo(opts.userAgent, segredos)) {
    throw new AmazonConfigError('user-agent', { operacao, refCredencial: opts.ref });
  }
}

/**
 * One exchange: send, classify, emit once, return or throw. With
 * `exigeRefreshToken`, a 2xx without a usable `refresh_token` is an
 * `AmazonSchemaError` (`lerToken`), which is what the first overload states.
 */
async function trocar(
  opts: OpcoesTrocaLwa,
  operacao: string,
  segredos: readonly string[],
  formulario: URLSearchParams,
  exigeRefreshToken: true,
): Promise<{ readonly token: TokenAcessoLwa; readonly refreshToken: string }>;
async function trocar(
  opts: OpcoesTrocaLwa,
  operacao: string,
  segredos: readonly string[],
  formulario: URLSearchParams,
  exigeRefreshToken: false,
): Promise<{ readonly token: TokenAcessoLwa; readonly refreshToken: null }>;
async function trocar(
  opts: OpcoesTrocaLwa,
  operacao: string,
  segredos: readonly string[],
  formulario: URLSearchParams,
  exigeRefreshToken: boolean,
): Promise<{ readonly token: TokenAcessoLwa; readonly refreshToken: string | null }> {
  const fetchImpl = resolverFetch(opts.fetch);
  const agora = opts.agora ?? (() => Date.now());
  const correlationId = (opts.gerarCorrelationId ?? (() => globalThis.crypto.randomUUID()))();
  const ref = opts.ref;

  const emitir = criarEmissor(
    {
      destino: 'lwa',
      operacao,
      metodo: 'POST',
      caminho: CAMINHO_TOKEN_LWA,
      query: [],
      correlationId,
      refCredencial: ref,
    },
    false,
    opts.onChamada,
  );

  const obtidoEmMs = agora();
  const r = await enviar({
    fetchImpl,
    agora,
    url: URL_TOKEN_LWA,
    metodo: 'POST',
    headers: {
      'content-type': CONTENT_TYPE_FORM,
      accept: 'application/json',
      'user-agent': opts.userAgent,
    },
    corpo: formulario.toString(),
    prazoMs: PRAZO_AMAZON_MS.lwa,
    sinal: opts.sinal,
    ctx: {
      destino: 'lwa',
      operacao,
      metodo: 'POST',
      caminho: CAMINHO_TOKEN_LWA,
      correlationId,
      refCredencial: ref,
    },
    segredos,
    emitir,
  });

  const { status, texto, ctx } = r;
  // `corpo` is forced to `null` by the emitter (`levaCorpo: false`); it is
  // spelled out here too, so no reader wonders.
  const base = {
    status,
    latenciaMs: r.latenciaMs,
    requestIdAmazon: r.requestIdAmazon,
    limiteTaxa: r.limiteTaxa,
    corpo: null,
  };

  if (r.ok) {
    const lido = lerToken(texto, status, ctx, exigeRefreshToken);
    if (lido instanceof AmazonSchemaError) {
      emitir({ ...base, resultado: 'schema' });
      throw lido;
    }
    emitir({ ...base, resultado: 'ok' });
    return {
      token: {
        accessToken: lido.accessToken,
        tipoToken: lido.tipoToken,
        expiraEmS: lido.expiraEmS,
        obtidoEmMs,
        correlationId,
        requestIdAmazon: r.requestIdAmazon,
        refCredencial: ref,
      },
      refreshToken: lido.refreshToken,
    };
  }

  const erro = lerRespostaJson(texto, lwaErroSchema);
  const codigoLwa = erro.ok ? lerCodigoErroLwa(erro.data.error) : null;
  const evento = { ...base, codigoLwa };

  if (status === 429) {
    emitir({ ...evento, resultado: 'limite' });
    throw new AmazonThrottleError({ ...ctx, status, limiteTaxa: r.limiteTaxa });
  }
  // ⚠️ The credential codes count on a 4xx ONLY: a 5xx is the server's failure
  // whatever its body says, and falls through to a transient `AmazonHttpError`.
  const ehCredencial = codigoLwa !== null && CODIGOS_DE_CREDENCIAL.has(codigoLwa);
  if (status === 401 || status === 403 || (status >= 400 && status <= 499 && ehCredencial)) {
    emitir({ ...evento, resultado: 'auth' });
    throw new AmazonAuthError({ ...ctx, status, codigoLwa });
  }
  if (status === 404) {
    emitir({ ...evento, resultado: 'nao-encontrado' });
    throw new AmazonNotFoundError({ ...ctx, status });
  }
  emitir({ ...evento, resultado: 'http' });
  throw new AmazonHttpError({ ...ctx, status });
}

/** The token response, checked beyond its schema. Returns the error to throw. */
function lerToken(
  texto: string,
  status: number,
  ctx: ContextoRequisicaoAmazon,
  exigeRefreshToken: boolean,
):
  | {
      readonly accessToken: string;
      readonly tipoToken: string;
      readonly expiraEmS: number;
      readonly refreshToken: string | null;
    }
  | AmazonSchemaError {
  const leitura = lerRespostaJson(texto, lwaTokenRespostaSchema);
  if (!leitura.ok) {
    // `'nao-json'` hands back the raw text; it is dropped here, never carried.
    const campos = leitura.motivo === 'formato' ? leitura.campos : [];
    return new AmazonSchemaError({ ...ctx, status, motivo: leitura.motivo, campos });
  }
  const d = leitura.data;
  const invalidos: string[] = [];
  // It becomes a header: a control character would make Node's `fetch` throw a
  // `TypeError` quoting it on the next SP-API call.
  if (!ehAsciiVisivel(d.access_token)) invalidos.push('access_token');
  if (d.expires_in <= 0) invalidos.push('expires_in');
  const refreshToken = d.refresh_token ?? null;
  if (exigeRefreshToken && (refreshToken === null || !ehAsciiVisivel(refreshToken))) {
    invalidos.push('refresh_token');
  }
  if (invalidos.length > 0) {
    return new AmazonSchemaError({ ...ctx, status, motivo: 'formato', campos: invalidos });
  }
  return {
    accessToken: d.access_token,
    tipoToken: d.token_type,
    expiraEmS: d.expires_in,
    refreshToken: exigeRefreshToken ? refreshToken : null,
  };
}
