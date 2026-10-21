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
 * ⚠️ Step 2b adds the write valves and the canary lists to THIS file, beside the
 * switch; step 2 ships the switch alone.
 */
import type { AmbienteAmazon } from '../env';

/** The read switch's variable. */
export const CHAMADAS_ENV_AMAZON = 'AMAZON_CHAMADAS';

/** The one value that switches calls on. Exactly this, nothing trimmed. */
export const CHAMADAS_LIGADAS = 'on';

/**
 * A minimal logger: what this step's modules write through. Step 2b brings the
 * structured logger; until then a route hands in {@link LOGGER_STDOUT_AMAZON}
 * and a test hands in a spy.
 */
export interface LoggerAmazon {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * One JSON line per call on stdout — the shape Cloud Logging reads `severity`
 * and `message` from — behind {@link LoggerAmazon}. `meta` is spread FIRST, so
 * it can never overwrite the two fields. Callers pass ids, names, codes and
 * classifications only (every module here documents what its lines carry).
 */
function linha(severity: 'INFO' | 'WARNING' | 'ERROR') {
  return (msg: string, meta?: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify({ ...meta, severity, message: msg })}\n`);
  };
}

/** The production sink the routes hand in until step 2b's logger arrives. */
export const LOGGER_STDOUT_AMAZON: LoggerAmazon = {
  info: linha('INFO'),
  warn: linha('WARNING'),
  error: linha('ERROR'),
};

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
  const meta = {
    evento: 'chamada-bloqueada',
    rota: entrada.rota,
    chave: CHAMADAS_ENV_AMAZON,
    valor: classe,
  };
  const mensagem = '[amazon] chamada-bloqueada: AMAZON_CHAMADAS não é exatamente "on"';
  if (classe === 'outro') logger.warn(mensagem, meta);
  else logger.info(mensagem, meta);
}
