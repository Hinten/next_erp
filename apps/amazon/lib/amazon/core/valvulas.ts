/**
 * The Amazon channel's READ SWITCH (step-2 plan §3 decision 2).
 *
 * `AMAZON_CHAMADAS`: only the EXACT string `on` lets this code call Amazon at
 * all (D11, mock only until the cutover). `ON`, ` on`, `on `, `true`, `1`, a
 * typo, blank and unset are all OFF — nothing is trimmed and nothing is
 * case-folded, so a value that merely looks right never reaches a live seller.
 *
 * It ships with the first code able to reach Amazon, and gates:
 *
 *  - the OAuth start route — a 503 `AMAZON_CHAMADAS_DESLIGADAS`, with no
 *    Firestore read and no fetch;
 *  - the OAuth callback — a redirect with `integracao_desligada`, consuming
 *    nothing and fetching nothing;
 *  - the context loader (`contexto.ts`) — refused before any Firestore read;
 *  - the expiry sweep's app-secret pass (c).
 *
 * It does NOT gate the status route (no Amazon call) nor sweep passes (a)/(b)
 * (the reauthorization clock runs whatever the switch says).
 *
 * The environment is a PARAMETER, like everywhere under `lib/amazon`.
 *
 * ⚠️ Step 2b-c adds the write valves and the canary lists to THIS file, beside
 * the switch. The logger is `log.ts`; this file only writes the switch's
 * blocked-call line through it.
 */
import type { AmbienteAmazon } from '../env';
import { type LoggerAmazon, registrarEventoAmazon } from './log';

/** The read switch's variable. */
export const CHAMADAS_ENV_AMAZON = 'AMAZON_CHAMADAS';

/** The one value that switches calls on. Exactly this, nothing trimmed. */
export const CHAMADAS_LIGADAS = 'on';

/** Whether this code may call Amazon at all: only the exact `on`. Pure. */
export function lerChaveDeChamadasAmazon(ambiente: AmbienteAmazon): boolean {
  return ambiente[CHAMADAS_ENV_AMAZON] === CHAMADAS_LIGADAS;
}

/**
 * The switch's value as a log line may carry it — a CLOSED classification,
 * never the raw text (an operator may paste anything into a variable):
 *
 *  - `ausente` — unset or the empty string, the expected state before W5;
 *  - `off` — exactly `off`;
 *  - `outro` — anything else (`ON`, ` on`, `true`, whitespace, `on` itself).
 */
export type ClasseDoValorDeChamadas = 'ausente' | 'off' | 'outro';

export function classificarValorDeChamadas(valor: string | undefined): ClasseDoValorDeChamadas {
  if (valor === undefined || valor === '') return 'ausente';
  if (valor === 'off') return 'off';
  return 'outro';
}

/**
 * The ONE line a refused call writes (`evento: 'chamada-bloqueada'`): INFO while
 * the switch is simply off (`ausente` / `off`), WARNING when it holds anything
 * else — a misconfiguration to fix (`ON`, a stray space). The value itself is
 * never logged, only its {@link ClasseDoValorDeChamadas}.
 */
export function registrarChamadaBloqueadaAmazon(
  logger: LoggerAmazon,
  entrada: { readonly rota: string; readonly valor: string | undefined },
): void {
  const classe = classificarValorDeChamadas(entrada.valor);
  registrarEventoAmazon(
    logger,
    'chamada-bloqueada',
    classe === 'outro' ? 'WARNING' : 'INFO',
    '[amazon] chamada-bloqueada: AMAZON_CHAMADAS não é exatamente "on"',
    { rota: entrada.rota, chave: CHAMADAS_ENV_AMAZON, valor: classe },
  );
}
