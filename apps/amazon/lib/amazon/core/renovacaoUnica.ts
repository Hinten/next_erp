/**
 * The FORCED-REFRESH-ONCE rule (step-2 plan §3 decision 11): an SP-API 401/403
 * may mean only that the cached access token went stale early, which one
 * refresh fixes; or a missing role, a revoked authorization or an unrotated
 * secret, which no refresh fixes. So a flow refreshes ONCE and retries ONCE, and
 * whatever the retry answers is final.
 *
 * Shared by every SP-API reader of the intake path — step 5's importer and
 * step 4's drain — so the rule exists in one place.
 *
 * {@link executarComRenovacaoUnica}:
 *
 *  1. calls `fn()`;
 *  2. on an `AmazonAuthError` that `classificarFalhaAmazon` calls
 *     `renovar-acesso` (an SP-API 401/403) — and on nothing else — it runs
 *     `contexto.obterAcesso({ forcarRenovacao: true })`, then `fn()` ONCE more;
 *  3. the retry's error propagates UNTOUCHED: a second 401/403 reaches the
 *     intake classifier, which reads it as a role grant missing (`sem-permissao`)
 *     — never as a park;
 *  4. an LWA refusal DURING the forced refresh propagates untouched too: it is
 *     the park's question (`estacionamento.ts`), not this module's.
 *
 * Any other error — a 404, a throttle, a schema refusal, the network — propagates
 * at once, with ZERO refreshes.
 *
 * ⚠️ Never park here and never retry twice: a park on an SP-API 401 would stop a
 * conta for a fault no reconnect fixes (a role grant, L1), and a second refresh
 * spends an LWA exchange to learn nothing new.
 */
import { AmazonAuthError } from '@delfrance/integrations-amazon-sp-api';

import type { ContextoAmazon } from './contexto';
import { classificarFalhaAmazon } from './estacionamento';

/** What the rule needs of a context: the access-token getter alone. */
export type ContextoDeRenovacao = Pick<ContextoAmazon, 'obterAcesso'>;

/** Whether `err` is the SP-API refusal one forced refresh may fix. */
function pedeRenovacao(err: unknown): boolean {
  return err instanceof AmazonAuthError && classificarFalhaAmazon(err) === 'renovar-acesso';
}

/**
 * Run `fn`; on an SP-API 401/403, force ONE refresh and run it ONCE more
 * (module header). Every error but that one propagates untouched, at once.
 */
export async function executarComRenovacaoUnica<T>(
  contexto: ContextoDeRenovacao,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!pedeRenovacao(err)) throw err;
  }
  await contexto.obterAcesso({ forcarRenovacao: true });
  return fn();
}
