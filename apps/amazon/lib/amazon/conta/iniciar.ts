/**
 * `iniciarConexaoAmazon` — the body of `POST …/conta/[id]/oauth/start`: mint a
 * signed single-use state, record it, and hand back the Seller Central consent
 * URL the browser navigates to.
 *
 * The route has already verified the caller (`PERM.integracao.write`) and the
 * id's shape. From there, in this order:
 *
 *  1. the READ SWITCH → `ChamadasAmazonDesligadasError` (503), after one
 *     blocked-call line — with NO Firestore read (and, as everywhere here, no
 *     fetch: starting a consent never calls Amazon);
 *  2. the WHOLE connect configuration (`lerConfigAmazon`: the six keys the
 *     callback needs too), and the LWA pair's VALUES checked by the package's
 *     own `credencialLwaValida` (`chavesLwaRecusadas`) →
 *     `ConfigAmazonAusenteError` (500, names only), so a consent can never
 *     start that the callback cannot finish;
 *  3. the conta, read UNCACHED, `tipo` only → `ContaAmazonNaoEncontradaError`
 *     (404). A parked, inactive or unconnected conta CAN start: this is how it
 *     gets fixed;
 *  4. `signState(id, AMAZON_OAUTH_STATE_SECRET)`;
 *  5. the consent URL (`montarUrlConsentimento`) — built BEFORE the record is
 *     written, so a value the package refuses (`AMAZON_APPLICATION_ID`,
 *     `AMAZON_OAUTH_REDIRECT_URI`) answers 500 naming the variable having
 *     written nothing;
 *  6. `amazonOauthState.put(…, { nonce, codeVerifier: null })` — persisted
 *     BEFORE the answer (#821): a consent completed against a record that was
 *     never written fails closed. No PKCE (`pkce: 'nao'`), so no verifier.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { type OauthStateStore, signState } from '@delfrance/data/admin/oauth-state';
import { AmazonConfigError, montarUrlConsentimento } from '@delfrance/integrations-amazon-sp-api';

import { lerContaAmazon } from '../core/contas';
import {
  ChamadasAmazonDesligadasError,
  ConfigAmazonAusenteError,
  ContaAmazonNaoEncontradaError,
} from '../core/erros';
import type { LoggerAmazon } from '../core/log';
import {
  CHAMADAS_ENV_AMAZON,
  lerChaveDeChamadasAmazon,
  registrarChamadaBloqueadaAmazon,
} from '../core/valvulas';
import {
  APPLICATION_ID_ENV,
  type AmbienteAmazon,
  REDIRECT_URI_ENV,
  chavesLwaRecusadas,
  lerConfigAmazon,
} from '../env';

/** The operation name the read switch's refusal line carries. */
export const ROTA_INICIO_OAUTH = 'oauth-start';

export interface IniciarDeps {
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS: the state's `iat` and the record's `criadoEm`. */
  readonly agoraMs: number;
  /** The attempt store — production: `amazonOauthState`; tests: an in-memory fake. */
  readonly estado: OauthStateStore;
  readonly logger: LoggerAmazon;
}

/**
 * @throws {ChamadasAmazonDesligadasError | ConfigAmazonAusenteError | ContaAmazonNaoEncontradaError}
 */
export async function iniciarConexaoAmazon(
  db: Firestore,
  integracaoId: string,
  deps: IniciarDeps,
): Promise<{ readonly authorizeUrl: string }> {
  if (!lerChaveDeChamadasAmazon(deps.ambiente)) {
    registrarChamadaBloqueadaAmazon(deps.logger, {
      rota: ROTA_INICIO_OAUTH,
      valor: deps.ambiente[CHAMADAS_ENV_AMAZON],
    });
    throw new ChamadasAmazonDesligadasError(integracaoId);
  }

  const config = lerConfigAmazon(deps.ambiente);
  if (!config.completa) throw new ConfigAmazonAusenteError(config.faltando, integracaoId);
  // Present is not enough: a pair the exchange would refuse (a trailing newline
  // from a paste) must stop HERE, not after the seller consented and the
  // callback burned the attempt on it.
  const lwaRecusadas = chavesLwaRecusadas(config.aplicacao);
  if (lwaRecusadas.length > 0) throw new ConfigAmazonAusenteError(lwaRecusadas, integracaoId);

  const lida = await lerContaAmazon(db, integracaoId);
  if (lida === null) throw new ContaAmazonNaoEncontradaError(integracaoId);

  const { state, nonce } = signState(integracaoId, config.segredoDoState, deps.agoraMs);

  let authorizeUrl: string;
  try {
    authorizeUrl = montarUrlConsentimento({
      applicationId: config.applicationId,
      state,
      redirectUri: config.redirectUri,
    });
  } catch (err) {
    if (err instanceof AmazonConfigError && err.motivo === 'application-id') {
      throw new ConfigAmazonAusenteError([APPLICATION_ID_ENV], integracaoId);
    }
    if (err instanceof AmazonConfigError && err.motivo === 'redirect-uri') {
      throw new ConfigAmazonAusenteError([REDIRECT_URI_ENV], integracaoId);
    }
    // A refused `state` is OUR signing bug, not configuration: a loud 500.
    throw err;
  }

  await deps.estado.put(db, integracaoId, { nonce, codeVerifier: null }, deps.agoraMs);
  return { authorizeUrl };
}
