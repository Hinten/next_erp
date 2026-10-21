/**
 * `tratarCallbackAmazon` — the body of the public
 * `GET /api/oauth/amazon/callback?state=…&selling_partner_id=…&spapi_oauth_code=…`,
 * the redirect target registered on the app. The route stays thin: it hands the
 * query and the dependencies over, and turns the answer into a redirect.
 *
 * **No Bearer token** — it is a browser redirect from Seller Central — so the
 * signed `state` plus its single-use record are the ONLY trust anchors. There
 * is no PKCE in this flow.
 *
 * ## The fifteen steps, and why each sits where it does
 *
 *  1. **Config** (state secret, LWA pair, application id, redirect URI,
 *     `WEB_APP_URL`; the pair's values through the package's own
 *     `credencialLwaValida`) → LIST, `config` (names logged, never values),
 *     nothing consumed. Without `WEB_APP_URL` there is nowhere to redirect: a
 *     plain 500 instead.
 *  2. **`state` present** → LIST, `bad_state`. Fail closed.
 *  3. **`verifyState`** → LIST, `bad_state` on an `OauthStateError`. From here
 *     the id is trustworthy — and it must also pass `idDeContaValido`.
 *  4. **Read switch** off → CONTA, `integracao_desligada`: NO consume, zero
 *     fetches. The attempt stays redeemable once the switch is on.
 *  5. **`spapi_oauth_code` present and usable** → CONTA, `missing_params`, NO
 *     consume: a cancelled consent must not burn the attempt, and neither may a
 *     code the exchange would refuse unsent (outside visible ASCII —
 *     `credencialLwaValida`, the package's own rule).
 *  6. **`selling_partner_id` valid** (`sellingPartnerIdValido`, exact) →
 *     CONTA, `vendedor_invalido`, NO consume.
 *  7. **Pre-guard** (uncached conta + the seller query → `decidirVinculoVendedor`):
 *     `conta` / `vendedor_diferente` / `vendedor_em_outra_conta`, NO consume —
 *     no code is spent on a refusal. One WARNING line names the conta id and the
 *     decision, never either seller id.
 *  8. **`consume`** — single-use, BEFORE the exchange: a replay finds the
 *     attempt consumed and lands as LIST `bad_state`, with zero fetches.
 *  9. **Exactly ONE `trocarCodigoAutorizacao`**, never retried (the code is
 *     single-use; a cut exchange may have spent it), with the IDENTICAL
 *     `redirect_uri` string the consent URL carried. Failures map most-derived
 *     first (see {@link motivoDaFalhaDeTroca}).
 * 10. **`gravarVendedor`** — the guard's COMMIT point, before the credential
 *     write, so a refusal leaves nothing to undo (tier 1; `conflito` after three
 *     lost preconditions). `mesmo-vendedor` skips the write.
 * 11. **`salvarConsentimento`** — a FULL `set` of the new grant (tier 0).
 * 12. **Re-read the conta** (uncached): deleted, or no longer an Amazon conta →
 *     `removerCredencial` and CONTA, `conta`. The delete cascade walks
 *     subcollections ONCE, so a credential landing after it would stay forever.
 * 13. **Avisos**, best effort: resolve the reconexão (clocked by step 11's
 *     `writeTime`), the reauthorization (365 days out again) and the secret
 *     refusal (the secret just worked). A TRANSIENT gRPC failure is logged and
 *     the redirect stays `connected`; anything else rethrows.
 * 14. **`invalidarContaEmCache`** on this instance (others wait out the TTL, and
 *     `isFresh` already refuses a copy without a seller id).
 * 15. **`connected`**.
 *
 * ⚠️ **Never logged, answered or put in a URL**: the code, any token, the client
 * secret, the state, either seller id, the ref, any LWA body, or the raw query.
 * The redirect carries exactly `{amazon}` or `{amazon, reason}`.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { isTransientGrpcError } from '@delfrance/data/admin/grpcErrors';
import {
  OauthStateError,
  type OauthStateStore,
  verifyState,
} from '@delfrance/data/admin/oauth-state';
import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonSchemaError,
  AmazonThrottleError,
  AmazonTimeoutError,
  type TokensAutorizacaoLwa,
  credencialLwaValida,
  trocarCodigoAutorizacao,
} from '@delfrance/integrations-amazon-sp-api';
import {
  MOTIVO_RETORNO_OAUTH_AMAZON,
  type MotivoRetornoOAuthAmazon,
  ROTAS_AVISO,
  sellingPartnerIdValido,
} from '@delfrance/schemas';

import {
  MOTIVO_AVISO_AMAZON,
  avisarSegredoLwaRecusado,
  resolverReautorizacao,
  resolverReconexaoPendente,
  resolverSegredoLwaRecusado,
} from '../avisos/avisos';
import { AGENTE_USUARIO_AMAZON } from '../core/agente';
import { invalidarContaEmCache } from '../core/contaCache';
import { idDeContaValido, lerContaAmazon } from '../core/contas';
import { removerCredencial, salvarConsentimento } from '../core/credentialStore';
import { REF_CONSENTIMENTO, fingerprintDoRefreshToken, montarRef } from '../core/refCredencial';
import {
  CHAMADAS_ENV_AMAZON,
  type LoggerAmazon,
  lerChaveDeChamadasAmazon,
  registrarChamadaBloqueadaAmazon,
} from '../core/valvulas';
import {
  type AmbienteAmazon,
  type ConfigAmazon,
  chavesLwaRecusadas,
  lerConfigAmazon,
  lerWebAppUrl,
} from '../env';
import {
  type DecisaoVinculoVendedor,
  type ResultadoVinculo,
  gravarVendedor,
  lerVinculo,
} from './vinculoVendedor';

/** The operation name the read switch's refusal line carries. */
export const ROTA_CALLBACK_OAUTH = 'oauth-callback';

/**
 * The complete set of query parameters a callback redirect may carry. A CLOSED
 * shape, never `Record<string, string>`: a widened type would let provider text
 * or a seller id reach an address bar. `respond.ts` writes the two keys one by
 * one, and the route test pins the key set of every redirect family.
 */
export type RetornoOAuthAmazon =
  | { readonly amazon: 'connected' }
  | { readonly amazon: 'error'; readonly reason: MotivoRetornoOAuthAmazon };

/** What the route does with the callback. */
export type RetornoCallback =
  /** `WEB_APP_URL` is unset: there is nowhere to redirect, so a plain 500. */
  | { readonly tipo: 'sem-web' }
  | {
      readonly tipo: 'redirecionar';
      readonly webBase: string;
      /** `/canais/amazon` (the list) or `/canais/amazon/<id>` (the conta). */
      readonly caminho: string;
      readonly retorno: RetornoOAuthAmazon;
    };

export interface CallbackDeps {
  readonly db: Firestore;
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS — read per step, never captured. */
  readonly agora: () => number;
  /** The attempt store — production: `amazonOauthState`; tests: an in-memory fake. */
  readonly estado: OauthStateStore;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)`, for the secret-refusal aviso. */
  readonly increment: (by: number) => unknown;
  /** Test seams, forwarded to the package as-is. */
  readonly fetch?: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

function erro(reason: MotivoRetornoOAuthAmazon): RetornoOAuthAmazon {
  return { amazon: 'error', reason };
}

/**
 * Map a failed code exchange to a DISTINCT slug — MOST-DERIVED FIRST:
 * `AmazonTimeoutError` before `AmazonNetworkError` (it extends it), the HTTP
 * subclasses before `AmazonHttpError`, and the base `AmazonError` last, or every
 * diagnosis would collapse into `exchange`. Anything that is not an
 * `AmazonError` returns `null`: the caller rethrows it (rule 6).
 */
export function motivoDaFalhaDeTroca(err: unknown): MotivoRetornoOAuthAmazon | null {
  if (err instanceof AmazonAuthError) {
    return err.codigoLwa === 'invalid_client' || err.codigoLwa === 'unauthorized_client'
      ? MOTIVO_RETORNO_OAUTH_AMAZON.serverConfig
      : // `invalid_grant` included: the code expired or was already used.
        MOTIVO_RETORNO_OAUTH_AMAZON.codigoInvalido;
  }
  if (err instanceof AmazonConfigError) return MOTIVO_RETORNO_OAUTH_AMAZON.serverConfig;
  if (err instanceof AmazonThrottleError) return MOTIVO_RETORNO_OAUTH_AMAZON.amazonIndisponivel;
  if (err instanceof AmazonHttpError) {
    return err.transitorio
      ? MOTIVO_RETORNO_OAUTH_AMAZON.amazonIndisponivel
      : MOTIVO_RETORNO_OAUTH_AMAZON.exchange;
  }
  if (err instanceof AmazonTimeoutError) return MOTIVO_RETORNO_OAUTH_AMAZON.tempoEsgotado;
  if (err instanceof AmazonNetworkError) return MOTIVO_RETORNO_OAUTH_AMAZON.rede;
  if (err instanceof AmazonSchemaError) return MOTIVO_RETORNO_OAUTH_AMAZON.respostaInvalida;
  if (err instanceof AmazonError) return MOTIVO_RETORNO_OAUTH_AMAZON.exchange;
  return null;
}

/**
 * What a failed exchange's log line may carry: the class, the HTTP status, the
 * LWA CODE, and the two correlation ids. Never a message (it names the path
 * only, but a field list is safer than prose), never a body, never a ref.
 */
function detalheDaFalha(err: AmazonError): Record<string, unknown> {
  return {
    erro: err.name,
    ...(err instanceof AmazonHttpError
      ? {
          status: err.status,
          correlationId: err.correlationId,
          requestIdAmazon: err.requestIdAmazon,
        }
      : {}),
    ...(err instanceof AmazonAuthError ? { codigoLwa: err.codigoLwa } : {}),
    ...(err instanceof AmazonConfigError ? { motivo: err.motivo } : {}),
    ...(err instanceof AmazonSchemaError ? { campos: err.campos } : {}),
  };
}

/**
 * Run an aviso step that follows a write that already landed: a TRANSIENT gRPC
 * failure must not turn a connected conta into an error page (the operator
 * would reconnect for nothing, spending another code). Only `isTransientGrpcError`
 * is contained (4, 8, 10, 13, 14); anything else — the aviso writer's own
 * contention error, a bug — throws, loudly.
 */
async function semDerrubar(
  logger: LoggerAmazon,
  integracaoId: string,
  passo: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!isTransientGrpcError(err)) throw err;
    logger.warn('[amazon/oauth-callback] falha transitória num aviso; a conexão segue válida', {
      integracaoId,
      passo,
      code: (err as { code: number }).code,
    });
  }
}

export async function tratarCallbackAmazon(
  params: URLSearchParams,
  deps: CallbackDeps,
): Promise<RetornoCallback> {
  const { db, logger } = deps;

  // 1. Config. WEB_APP_URL first: without it there is no redirect at all.
  const webBase = lerWebAppUrl(deps.ambiente);
  if (webBase === null) {
    logger.error('[amazon/oauth-callback] configuração ausente', { faltando: ['WEB_APP_URL'] });
    return { tipo: 'sem-web' };
  }
  const lista = (retorno: RetornoOAuthAmazon): RetornoCallback => ({
    tipo: 'redirecionar',
    webBase,
    caminho: ROTAS_AVISO.canalAmazonLista.build(),
    retorno,
  });
  const naConta = (id: string, retorno: RetornoOAuthAmazon): RetornoCallback => ({
    tipo: 'redirecionar',
    webBase,
    caminho: ROTAS_AVISO.canalAmazon.build(id),
    retorno,
  });

  const lido = lerConfigAmazon(deps.ambiente);
  if (!lido.completa) {
    logger.error('[amazon/oauth-callback] configuração ausente', { faltando: lido.faltando });
    return lista(erro(MOTIVO_RETORNO_OAUTH_AMAZON.config));
  }
  const config: ConfigAmazon = lido;
  // The start refuses an unusable pair too; this catches one that changed since
  // (a redeploy inside the attempt's ten minutes) — before anything is consumed.
  const lwaRecusadas = chavesLwaRecusadas(config.aplicacao);
  if (lwaRecusadas.length > 0) {
    logger.error('[amazon/oauth-callback] configuração inválida', { invalidas: lwaRecusadas });
    return lista(erro(MOTIVO_RETORNO_OAUTH_AMAZON.config));
  }

  // 2. Fail closed on a missing state.
  const state = params.get('state');
  if (state === null || state === '') return lista(erro(MOTIVO_RETORNO_OAUTH_AMAZON.badState));

  // 3. Proves we minted it and it is fresh — NOT that it is unused.
  let integracaoId: string;
  let nonce: string;
  try {
    const verificado = verifyState(state, config.segredoDoState, deps.agora());
    integracaoId = verificado.id;
    nonce = verificado.nonce;
  } catch (err) {
    if (err instanceof OauthStateError) return lista(erro(MOTIVO_RETORNO_OAUTH_AMAZON.badState));
    throw err;
  }
  if (!idDeContaValido(integracaoId)) return lista(erro(MOTIVO_RETORNO_OAUTH_AMAZON.badState));

  // 4. The read switch: nothing consumed, nothing fetched.
  if (!lerChaveDeChamadasAmazon(deps.ambiente)) {
    registrarChamadaBloqueadaAmazon(logger, {
      rota: ROTA_CALLBACK_OAUTH,
      valor: deps.ambiente[CHAMADAS_ENV_AMAZON],
    });
    return naConta(integracaoId, erro(MOTIVO_RETORNO_OAUTH_AMAZON.integracaoDesligada));
  }

  // 5. A cancelled consent carries no code: nothing to exchange, nothing burned.
  // A code the exchange would refuse unsent (outside visible ASCII — the
  // package's own predicate) is refused HERE too, so it never burns the attempt.
  const codigo = params.get('spapi_oauth_code');
  if (!credencialLwaValida(codigo)) {
    return naConta(integracaoId, erro(MOTIVO_RETORNO_OAUTH_AMAZON.missingParams));
  }

  // 6. The seller id, exactly as Amazon sent it — never trimmed or folded.
  const sellingPartnerId = params.get('selling_partner_id');
  if (!sellingPartnerIdValido(sellingPartnerId)) {
    return naConta(integracaoId, erro(MOTIVO_RETORNO_OAUTH_AMAZON.vendedorInvalido));
  }

  // 7. The pre-guard: refuse a wrong seller BEFORE any code is spent.
  const pre = await lerVinculo(db, integracaoId, sellingPartnerId);
  const recusaDoVinculo = motivoDoVinculo(pre.decisao);
  if (recusaDoVinculo !== null) {
    logger.warn('[amazon/oauth-callback] vínculo de vendedor recusado antes da troca', {
      integracaoId,
      decisao: pre.decisao,
    });
    return naConta(integracaoId, erro(recusaDoVinculo));
  }

  // 8. Single-use: a replay lands here, before anything is fetched or written.
  try {
    await deps.estado.consume(db, integracaoId, nonce, deps.agora());
  } catch (err) {
    if (err instanceof OauthStateError) return lista(erro(MOTIVO_RETORNO_OAUTH_AMAZON.badState));
    throw err;
  }

  // 9. The ONE exchange. Never retried.
  let tokens: TokensAutorizacaoLwa;
  try {
    tokens = await trocarCodigoAutorizacao({
      aplicacao: config.aplicacao,
      codigo,
      redirectUri: config.redirectUri,
      ref: REF_CONSENTIMENTO,
      userAgent: AGENTE_USUARIO_AMAZON,
      fetch: deps.fetch,
      gerarCorrelationId: deps.gerarCorrelationId,
      agora: deps.agora,
    });
  } catch (err) {
    const motivo = motivoDaFalhaDeTroca(err);
    if (motivo === null || !(err instanceof AmazonError)) throw err;
    logger.error('[amazon/oauth-callback] falha ao trocar o código de autorização', {
      integracaoId,
      motivo,
      ...detalheDaFalha(err),
    });
    if (
      err instanceof AmazonAuthError &&
      (err.codigoLwa === 'invalid_client' || err.codigoLwa === 'unauthorized_client')
    ) {
      const codigoLwa = err.codigoLwa;
      await semDerrubar(logger, integracaoId, 'segredo-recusado', () =>
        avisarSegredoLwaRecusado(
          db,
          { codigoLwa },
          { increment: deps.increment, nowMs: deps.agora(), logger },
        ),
      );
    }
    return naConta(integracaoId, erro(motivo));
  }

  // 10. The guard's commit point — before the credential write.
  const vinculo = await gravarVendedor(db, integracaoId, sellingPartnerId);
  if (vinculo !== 'gravado' && vinculo !== 'mesmo-vendedor') {
    logger.warn('[amazon/oauth-callback] vínculo de vendedor recusado na gravação', {
      integracaoId,
      decisao: vinculo,
    });
    return naConta(
      integracaoId,
      erro(motivoDoVinculo(vinculo) ?? MOTIVO_RETORNO_OAUTH_AMAZON.conflito),
    );
  }

  // 11. The new grant: a full set.
  const autorizadoEmMs = tokens.obtidoEmMs;
  const gravada = await salvarConsentimento(db, integracaoId, {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expirationDate: tokens.obtidoEmMs + tokens.expiraEmS * 1000,
    autorizadoEmMs,
    acessoRef: montarRef(fingerprintDoRefreshToken(tokens.refreshToken), autorizadoEmMs),
  });

  // 12. Undo when the conta vanished while the consent landed.
  const depois = await lerContaAmazon(db, integracaoId);
  if (depois === null) {
    await removerCredencial(db, integracaoId);
    logger.warn('[amazon/oauth-callback] conta removida durante a conexão; credencial desfeita', {
      integracaoId,
    });
    return naConta(integracaoId, erro(MOTIVO_RETORNO_OAUTH_AMAZON.conta));
  }

  // 13. Avisos, best effort.
  const nowMs = deps.agora();
  await semDerrubar(logger, integracaoId, 'reconexao', () =>
    resolverReconexaoPendente(
      db,
      integracaoId,
      MOTIVO_AVISO_AMAZON.consentimento,
      { nowMs },
      { relogioUs: gravada.versaoUs, lojaNome: depois.conta.nome },
    ),
  );
  await semDerrubar(logger, integracaoId, 'reautorizacao', () =>
    resolverReautorizacao(db, integracaoId, MOTIVO_AVISO_AMAZON.consentimento, { nowMs }),
  );
  await semDerrubar(logger, integracaoId, 'segredo-recusado', () =>
    resolverSegredoLwaRecusado(db, { nowMs }),
  );

  // 14. This instance's cached copy predates the seller id.
  invalidarContaEmCache(integracaoId);

  // 15.
  return naConta(integracaoId, { amazon: 'connected' });
}

/** The slug of a refusing guard decision, or `null` when the guard allows the write. */
function motivoDoVinculo(
  decisao: DecisaoVinculoVendedor | ResultadoVinculo,
): MotivoRetornoOAuthAmazon | null {
  switch (decisao) {
    case 'conta-ausente':
      return MOTIVO_RETORNO_OAUTH_AMAZON.conta;
    case 'vendedor-diferente':
      return MOTIVO_RETORNO_OAUTH_AMAZON.vendedorDiferente;
    case 'vendedor-em-outra-conta':
      return MOTIVO_RETORNO_OAUTH_AMAZON.vendedorEmOutraConta;
    case 'conflito':
      return MOTIVO_RETORNO_OAUTH_AMAZON.conflito;
    case 'gravar':
    case 'gravado':
    case 'mesmo-vendedor':
      return null;
  }
}
