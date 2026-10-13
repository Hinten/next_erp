/**
 * `loadLojaIntegradaContext` — what every Loja Integrada FLOW (step 3's poller
 * and task, and every later step) starts from: the conta, plus a read-only
 * client bound to its stored Personal Token.
 *
 * It REFUSES, in this order, each with its own class (`erros.ts`):
 *
 *  1. no such conta, or not a Loja Integrada conta → `LiContaNaoEncontradaError`;
 *  2. `ativo === false` → `LiContaInativaError`;
 *  3. one UNCACHED credential read, to fail fast — none stored →
 *     `LiCredencialAusenteError`, corrupt → `LiCredencialInvalidaError` (paths
 *     only), parked → `LiContaParadaError`.
 *
 * ⚠️ The ORDER is part of the contract: an inactive conta is refused as
 * inactive even when its credential is also missing, corrupt or parked, so a
 * deactivated conta never reads as "fix the token".
 *
 * The routes do NOT come through here: they must be able to fix a parked or
 * inactive conta, so they read it uncached and require only `tipo === 3`.
 *
 * ## The credential is re-read on EVERY request
 *
 * The client's `obterCredencial` re-reads `credenciaisLojaIntegrada/current`
 * each time the package asks (it asks once per request, and keeps nothing):
 *
 *  - a batch stops at its next request once another task parks the conta —
 *    the getter throws `LiContaParadaError` and no request is sent;
 *  - a token saved mid-batch is picked up by the next request;
 *  - the cost is one document read per Loja Integrada call, negligible at this
 *    channel's volume.
 *
 * The getter hands the package `{ token, ref: refDaCredencial(doc) }`, so every
 * `LiAuthError` names the exact credential version it refused — the park's
 * guard input.
 *
 * There is no local expiry refusal: `tokenExpiraEmMs` is advisory (a renewal in
 * the painel keeps the token alive past it), and Loja Integrada's 401 is the
 * verdict.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type ChamadaLi,
  type CredencialLi,
  type LiLeituraClient,
  criarClienteLeituraLi,
} from '@delfrance/integrations-loja-integrada';
import { INTEGRACAO_TIPO, type Integracao } from '@delfrance/schemas';

import { lerContaEmCache } from './contaCache';
import { refDaCredencial } from './credencial';
import { type CredencialLida, lerCredencial } from './credentialStore';
import {
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
} from './erros';

/**
 * Send `x-correlation-id` on the context client's requests. **`false` until the
 * master plan's §1.2 item 23 is settled**: the public document lists that header
 * only for the Enviali paths, and if `/v1` answered it with a 403 an enabled
 * header would PARK every conta on its first call. The id is still generated and
 * reaches `onChamada`, so the app's logs correlate either way.
 */
export const ENVIAR_CORRELATION_ID_LI = false;

export interface ContextoLojaIntegrada {
  readonly integracaoId: string;
  readonly conta: Integracao;
  readonly cliente: LiLeituraClient;
}

export interface ContextoDeps {
  /** The observer, forwarded to the package. Its events never carry the token. */
  readonly onChamada?: (e: ChamadaLi) => void;
  /** Test seams, forwarded as-is. */
  readonly fetch?: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

/**
 * A credential usable for a request right now: present, parseable, not parked.
 *
 * @throws {LiCredencialAusenteError | LiCredencialInvalidaError | LiContaParadaError}
 */
async function credencialUtilizavel(db: Firestore, integracaoId: string): Promise<CredencialLida> {
  const lida = await lerCredencial(db, integracaoId);
  if (lida === null) throw new LiCredencialAusenteError(integracaoId);
  const parada = lida.credencial.reconexaoPendente;
  if (parada !== null) throw new LiContaParadaError(integracaoId, parada.status, parada.desdeMs);
  return lida;
}

export async function loadLojaIntegradaContext(
  db: Firestore,
  integracaoId: string,
  deps: ContextoDeps = {},
): Promise<ContextoLojaIntegrada> {
  const conta = await lerContaEmCache(db, integracaoId);
  if (conta === null || conta.tipo !== INTEGRACAO_TIPO.lojaIntegrada) {
    throw new LiContaNaoEncontradaError(integracaoId);
  }
  if (conta.ativo === false) throw new LiContaInativaError(integracaoId);

  // Fail fast: a flow that cannot make a single request should not start.
  await credencialUtilizavel(db, integracaoId);

  const cliente = criarClienteLeituraLi({
    obterCredencial: async (): Promise<CredencialLi> => {
      // Re-read every time — never the copy read above (module header).
      const { credencial } = await credencialUtilizavel(db, integracaoId);
      return { token: credencial.personalToken, ref: refDaCredencial(credencial) };
    },
    enviarCorrelationId: ENVIAR_CORRELATION_ID_LI,
    onChamada: deps.onChamada,
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  });

  return { integracaoId, conta, cliente };
}
