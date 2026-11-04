/**
 * `loadAmazonContext` — what every Amazon FLOW (step 3's intake task and every
 * later step) starts from: the conta, a read-only SP-API client bound to its
 * stored credential, and the access-token getter itself.
 *
 * It REFUSES, in this contract-fixed order, each with its own class
 * (`erros.ts`):
 *
 *  1. the READ SWITCH (`AMAZON_CHAMADAS`) is not exactly `on` →
 *     `ChamadasAmazonDesligadasError`, after ONE blocked-call line — before ANY
 *     Firestore read and before a client exists (D11);
 *  2. the LWA pair is not configured → `ConfigAmazonAusenteError` (names only);
 *  3. the CACHED conta is absent or not an Amazon conta →
 *     `ContaAmazonNaoEncontradaError`;
 *  4. `ativo === false` → `ContaAmazonInativaError`;
 *  5. no `selling_partner_id` → `ContaAmazonNaoConectadaError`;
 *  6. one UNCACHED credential read, to fail fast — none stored →
 *     `CredencialAmazonAusenteError`, corrupt → `CredencialAmazonInvalidaError`
 *     (paths only), parked → `ContaAmazonParadaError`.
 *
 * ⚠️ The ORDER is part of the contract: the switch first, because it is what
 * keeps an agent's process from ever reaching Amazon; an inactive conta is
 * refused as inactive even when it is also unconnected or parked, so a
 * deactivated conta never reads as "reconnect it".
 *
 * The routes and the callback do NOT come through here: they must be able to
 * connect a parked, inactive or unconnected conta.
 *
 * ## The credential is re-read on EVERY request — {@link obterCredencialAmazon}
 *
 * The client's `obterCredencial` re-reads `credenciais/current` each time the
 * package asks (once per request; it keeps nothing):
 *
 *  - a batch stops at its next request once another task parks the conta — the
 *    getter throws `ContaAmazonParadaError` with ZERO fetches;
 *  - a consent saved mid-batch is picked up by the next request (a new ref);
 *  - the stored access token is used only when its `acessoRef` equals the ref
 *    re-derived NOW and it has more than {@link MARGEM_RENOVACAO_ACESSO_MS} left;
 *    otherwise exactly ONE `trocarRefreshToken`, and its result is persisted as
 *    a 3-key field patch (`persistirAcesso`).
 *
 * The ref is the package's `refCredencial` on every request and every error, so
 * an `AmazonAuthError` names the exact grant it refused — the park's guard
 * input. An `AmazonAuthError` is rethrown as-is: the flow's caller classifies it
 * (`estacionamento.ts`).
 *
 * ## The call log (step 2b)
 *
 * Both package calls made here — the LWA refresh and every SP-API request —
 * get the logger's observer (`log.ts`), built from `deps.registro` (step 3's
 * flow, attempt and ids) with `deps.logger` and THIS loader's conta id written
 * LAST, so a `registro` can never relabel a line. One SP-API `get` can emit two
 * lines: the refresh, then the request. A caller cannot hand the package an
 * observer of its own: there is no such dep (`estrutura.test.ts`).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { isTransientGrpcError } from '@delfrance/data/admin/grpcErrors';
import {
  type CredencialSpApi,
  type SpApiLeituraClient,
  criarClienteSpApi,
  trocarRefreshToken,
} from '@delfrance/integrations-amazon-sp-api';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';

import { resolverSegredoLwaRecusado } from '../avisos/avisos';
import { type AmbienteAmazon, type AplicacaoLwaAmazon, lerAplicacaoLwaAmazon } from '../env';
import { AGENTE_USUARIO_AMAZON } from './agente';
import { lerContaEmCache } from './contaCache';
import { type CredencialLida, lerCredencial, persistirAcesso } from './credentialStore';
import {
  ChamadasAmazonDesligadasError,
  ConfigAmazonAusenteError,
  ContaAmazonInativaError,
  ContaAmazonNaoConectadaError,
  ContaAmazonNaoEncontradaError,
  ContaAmazonParadaError,
  CredencialAmazonAusenteError,
} from './erros';
import { type LoggerAmazon, type RegistroDeChamadaAmazon, criarObservadorAmazon } from './log';
import { refDaCredencial } from './refCredencial';
import {
  CHAMADAS_ENV_AMAZON,
  lerChaveDeChamadasAmazon,
  registrarChamadaBloqueadaAmazon,
} from './valvulas';

/** A stored access token with this little left is refreshed instead of used. */
export const MARGEM_RENOVACAO_ACESSO_MS = 60_000;

/** The operation name the read switch's refusal line carries. */
export const OPERACAO_CONTEXTO_AMAZON = 'contexto';

export interface ContextoAmazonDeps {
  /**
   * The process environment, as the entry point passes it in — the read switch
   * and the LWA pair. REQUIRED: a context built without it would have to guess,
   * and the only safe guess is "off".
   */
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS. Read per decision, never captured. */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /**
   * What the call lines say about the run (step 3: flow, attempt, task and
   * notification ids). The conta is always this loader's id.
   */
  readonly registro?: RegistroDeChamadaAmazon;
  /** Test seams, forwarded to the package as-is. */
  readonly fetch?: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

/** What {@link obterCredencialAmazon} needs: the deps, with the LWA pair resolved. */
export interface CredencialDeps extends ContextoAmazonDeps {
  readonly aplicacao: AplicacaoLwaAmazon;
}

export interface OpcoesDeAcesso {
  /** Refresh even when the stored token looks valid (step 3: after an SP-API 401/403). */
  readonly forcarRenovacao?: boolean;
}

export interface ContextoAmazon {
  readonly integracaoId: string;
  readonly conta: Integracao;
  readonly cliente: SpApiLeituraClient;
  /** The getter the client uses, exposed for step 3's forced renewal. */
  readonly obterAcesso: (opts?: OpcoesDeAcesso) => Promise<CredencialSpApi>;
}

/**
 * A credential usable for a request right now: present, parseable, not parked.
 *
 * @throws {CredencialAmazonAusenteError | CredencialAmazonInvalidaError | ContaAmazonParadaError}
 */
async function credencialUtilizavel(db: Firestore, integracaoId: string): Promise<CredencialLida> {
  const lida = await lerCredencial(db, integracaoId);
  if (lida === null) throw new CredencialAmazonAusenteError(integracaoId);
  const parada = lida.credencial.reconexaoPendente;
  if (parada !== null) {
    throw new ContaAmazonParadaError(integracaoId, parada.status, parada.desdeMs);
  }
  return lida;
}

/**
 * The access credential for ONE request, re-read UNCACHED (module header).
 *
 * @throws {ContaAmazonParadaError} with zero fetches when the conta is parked.
 * @throws {CredencialAmazonAusenteError} when no credential is stored, or it was
 *   removed while the refreshed token was being persisted.
 * @throws {AmazonAuthError} (and every other package error) as-is.
 */
export async function obterCredencialAmazon(
  db: Firestore,
  integracaoId: string,
  deps: CredencialDeps,
  opts: OpcoesDeAcesso = {},
): Promise<CredencialSpApi> {
  const { credencial } = await credencialUtilizavel(db, integracaoId);
  const ref = refDaCredencial(credencial);

  if (
    opts.forcarRenovacao !== true &&
    credencial.acessoRef === ref &&
    credencial.expirationDate - deps.agora() > MARGEM_RENOVACAO_ACESSO_MS
  ) {
    return { accessToken: credencial.access_token, ref };
  }

  const token = await trocarRefreshToken({
    aplicacao: deps.aplicacao,
    ref,
    refreshToken: credencial.refresh_token,
    userAgent: AGENTE_USUARIO_AMAZON,
    fetch: deps.fetch,
    onChamada: criarObservadorAmazon({
      ...deps.registro,
      logger: deps.logger,
      conta: integracaoId,
    }),
    gerarCorrelationId: deps.gerarCorrelationId,
    agora: deps.agora,
  });
  await persistirAcesso(db, integracaoId, {
    access_token: token.accessToken,
    expirationDate: token.obtidoEmMs + token.expiraEmS * 1000,
    acessoRef: ref,
  });
  await resolverSegredoSemDerrubar(db, integracaoId, deps);
  return { accessToken: token.accessToken, ref };
}

/**
 * The app's credentials just worked, so a standing `amazonSegredoLwaRecusado`
 * is resolved — best effort: the token is already persisted, and a TRANSIENT
 * Firestore failure here must not fail the request it was minted for. Anything
 * else rethrows.
 */
async function resolverSegredoSemDerrubar(
  db: Firestore,
  integracaoId: string,
  deps: CredencialDeps,
): Promise<void> {
  try {
    await resolverSegredoLwaRecusado(db, { nowMs: deps.agora() });
  } catch (err) {
    if (!isTransientGrpcError(err)) throw err;
    deps.logger.warn('[amazon/contexto] falha transitória ao resolver o aviso do segredo', {
      integracaoId,
      code: (err as { code: number }).code,
    });
  }
}

export async function loadAmazonContext(
  db: Firestore,
  integracaoId: string,
  deps: ContextoAmazonDeps,
): Promise<ContextoAmazon> {
  // 1. FIRST: no Firestore read, no client, nothing at all while the switch is off.
  if (!lerChaveDeChamadasAmazon(deps.ambiente)) {
    registrarChamadaBloqueadaAmazon(deps.logger, {
      rota: OPERACAO_CONTEXTO_AMAZON,
      valor: deps.ambiente[CHAMADAS_ENV_AMAZON],
    });
    throw new ChamadasAmazonDesligadasError(integracaoId);
  }

  // 2. The LWA pair — the only configuration a flow needs.
  const lwa = lerAplicacaoLwaAmazon(deps.ambiente);
  if (!lwa.completa) throw new ConfigAmazonAusenteError(lwa.faltando, integracaoId);

  // 3–5. The cached conta.
  const conta = await lerContaEmCache(db, integracaoId);
  if (conta === null || conta.tipo !== INTEGRACAO_TIPO.amazon) {
    throw new ContaAmazonNaoEncontradaError(integracaoId);
  }
  if (conta.ativo === false) throw new ContaAmazonInativaError(integracaoId);
  if (conta.selling_partner_id == null) throw new ContaAmazonNaoConectadaError(integracaoId);

  // 6. Fail fast: a flow that cannot make a single request should not start.
  await credencialUtilizavel(db, integracaoId);

  const credencialDeps: CredencialDeps = { ...deps, aplicacao: lwa.aplicacao };
  const obterAcesso = (opts?: OpcoesDeAcesso): Promise<CredencialSpApi> =>
    obterCredencialAmazon(db, integracaoId, credencialDeps, opts);

  const cliente = criarClienteSpApi({
    // Re-read every time — never the copy read above (module header).
    obterCredencial: () => obterAcesso(),
    userAgent: AGENTE_USUARIO_AMAZON,
    fetch: deps.fetch,
    onChamada: criarObservadorAmazon({
      ...deps.registro,
      logger: deps.logger,
      conta: integracaoId,
    }),
    gerarCorrelationId: deps.gerarCorrelationId,
    agora: deps.agora,
  });

  return { integracaoId, conta, cliente, obterAcesso };
}
