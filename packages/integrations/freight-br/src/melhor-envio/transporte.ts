/**
 * Internal: the one place a server-side Melhor Envio transport rejection is
 * classified (#1679). Shared by `api.ts` and `oauth.ts`; deliberately NOT in
 * the `./index` barrel — it is plumbing, not API.
 */
import type { PrazoDeTransporte } from '@delfrance/core/wire';

import { MelhorEnvioNetworkError, MelhorEnvioTimeoutError } from './errors';
import { mensagemDeTempoEsgotadoMe, type OperacaoMelhorEnvio } from './prazos';

/**
 * Map a rejection from the transport — the `fetch` itself OR the body read — to
 * this module's taxonomy.
 *
 * ⚠️ Classified by asking the deadline (`esgotado()`), never by
 * `err instanceof DOMException`: `fetch` rejects with the signal's reason as-is.
 *
 * A non-timeout failure becomes `MelhorEnvioNetworkError`, never the bare
 * `MelhorEnvioError` base — the base is also what an unmapped failure looks
 * like, so a caller could not tell a dead network from an unknown error.
 */
export function erroDeTransporteMe(
  err: unknown,
  prazo: PrazoDeTransporte,
  operacao: OperacaoMelhorEnvio | 'token',
  timeoutMs: number,
  rota: string,
): MelhorEnvioNetworkError {
  if (prazo.esgotado()) {
    return new MelhorEnvioTimeoutError(
      mensagemDeTempoEsgotadoMe(operacao, timeoutMs),
      { operacao, timeoutMs },
      err,
    );
  }
  return new MelhorEnvioNetworkError(
    `Falha de rede ao chamar Melhor Envio ${rota}: ${err instanceof Error ? err.message : 'fetch failed'}`,
    err,
  );
}
