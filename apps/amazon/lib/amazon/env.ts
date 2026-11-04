/**
 * The one place `lib/amazon` turns the environment into Amazon configuration.
 *
 * ⚠️ **The environment is a PARAMETER.** Nothing under `lib/amazon` reads the
 * process environment (`estrutura.test.ts`): the entry point — a route, or step 3's
 * functions — passes it in, so a test hands over a plain object and the nested
 * functions bundle reads its own.
 *
 * ## Every read is BLANK-GUARDED, never `??`
 *
 * `??` guards only `undefined`/`null`, so a variable declared and left empty
 * (`AMAZON_OAUTH_REDIRECT_URI=`, exactly how the root template ships it) would
 * read as a present empty string and fail far from here — at Amazon, after the
 * consent. Blank (empty, or whitespace only) counts as UNSET. A present value is
 * returned RAW, never trimmed: three of these are secrets or a URI that Amazon
 * compares byte for byte, and a value that needs cleaning is the package's to
 * refuse (`AmazonConfigError`), not this module's to repair.
 *
 * ⚠️ **Names, never values.** An incomplete configuration reports the missing
 * KEY NAMES only: two of them are secrets, and a refusal travels into a 500
 * body and a log line.
 */
import { somarDiasCivis } from '@delfrance/core/datetime';
import { applicationIdValido, credencialLwaValida } from '@delfrance/integrations-amazon-sp-api';

/** The process environment, as the entry point passes it in. */
export type AmbienteAmazon = Readonly<Record<string, string | undefined>>;

/** The app's Login with Amazon client id (public half of the pair). */
export const LWA_CLIENT_ID_ENV = 'AMAZON_LWA_CLIENT_ID';
/** The app's Login with Amazon client secret (Secret Manager). */
export const LWA_CLIENT_SECRET_ENV = 'AMAZON_LWA_CLIENT_SECRET';
/** The consent URL's `application_id` (Solution Provider Portal). */
export const APPLICATION_ID_ENV = 'AMAZON_APPLICATION_ID';
/** The OAuth redirect URI, sent on the consent URL and repeated in the exchange. */
export const REDIRECT_URI_ENV = 'AMAZON_OAUTH_REDIRECT_URI';
/** The HMAC key of the signed OAuth `state` (Secret Manager). */
export const STATE_SECRET_ENV = 'AMAZON_OAUTH_STATE_SECRET';
/** The `apps/web` origin the callback redirects the browser back to. */
export const WEB_APP_URL_ENV = 'WEB_APP_URL';
/** The current LWA client secret's recorded expiry, `YYYY-MM-DD` (São Paulo). */
export const SEGREDO_EXPIRA_EM_ENV = 'AMAZON_LWA_SEGREDO_EXPIRA_EM';
/**
 * The push receiver's relay secret (Secret Manager): what the AWS relay's
 * `API_KEY` Connection sends in `CABECALHO_CHAVE_RELAY_AMAZON`. The SAME value
 * lives in AWS Secrets Manager (W1).
 */
export const RELAY_SECRET_ENV = 'AMAZON_RELAY_SECRET';
/**
 * The PREVIOUS relay secret, set only during a rotation (Secret Manager): both
 * are accepted until the Connection is known to send the new one
 * (`infra/amazon-relay/README.md`, Operations).
 */
export const RELAY_PREVIOUS_SECRET_ENV = 'AMAZON_RELAY_PREVIOUS_SECRET';
/**
 * The region of the reads queue (`filaLeituraAmazon`). Read by the App Hosting
 * composition root (`lib/firebase/filaLeitura.ts`) as a static member read of the
 * process environment, never through this module; named here so a refusal can
 * report it.
 */
export const TASKS_REGION_ENV = 'AMAZON_TASKS_REGION';

/** The shortest relay secret the receiver accepts (step-3 plan §3 decision 36). */
export const MIN_SEGREDO_RELAY = 32;
/** The longest one: a bound on the input, far above `openssl rand -hex 32`'s 64 characters. */
export const MAX_SEGREDO_RELAY = 512;

/**
 * What the OAuth start and the callback need, all of it: the start route checks
 * the WHOLE set, so a consent can never begin that the callback cannot finish.
 */
export const CHAVES_CONFIG_AMAZON = [
  LWA_CLIENT_ID_ENV,
  LWA_CLIENT_SECRET_ENV,
  APPLICATION_ID_ENV,
  REDIRECT_URI_ENV,
  STATE_SECRET_ENV,
  WEB_APP_URL_ENV,
] as const;
export type ChaveConfigAmazon = (typeof CHAVES_CONFIG_AMAZON)[number];

/** The app's LWA pair, as `trocarRefreshToken` / `trocarCodigoAutorizacao` take it. */
export interface AplicacaoLwaAmazon {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The complete connect-flow configuration. */
export interface ConfigAmazon {
  readonly completa: true;
  readonly aplicacao: AplicacaoLwaAmazon;
  readonly applicationId: string;
  /** Raw, exactly as set: the consent URL and the exchange send this very string. */
  readonly redirectUri: string;
  readonly segredoDoState: string;
  readonly webAppUrl: string;
}

/** An incomplete configuration: the missing key NAMES, in declaration order. */
export interface ConfigAmazonIncompleta {
  readonly completa: false;
  readonly faltando: readonly string[];
}

/** The raw value, or `null` when unset or blank. Never trimmed. */
function valor(ambiente: AmbienteAmazon, chave: string): string | null {
  const bruto = ambiente[chave];
  if (bruto === undefined || bruto.trim() === '') return null;
  return bruto;
}

/** The value of a key the caller has just confirmed present. */
function presente(ambiente: AmbienteAmazon, chave: string): string {
  const v = valor(ambiente, chave);
  if (v === null) throw new TypeError(`env.ts: ${chave} deveria estar presente`);
  return v;
}

function faltandoEm(ambiente: AmbienteAmazon, chaves: readonly string[]): string[] {
  return chaves.filter((c) => valor(ambiente, c) === null);
}

/**
 * Is `raw` a usable `WEB_APP_URL` — an absolute `http:`/`https:` URL that
 * `redirecionarParaWeb` can build a redirect on?
 *
 * ⚠️ Checked BEFORE any irreversible work, not at redirect time. The callback
 * consumes the single-use state and spends the 5-minute code before it
 * redirects, so a value that only failed inside `new URL(...)` there (a bare
 * host such as `erp.example.com`) would leave the operator on a 500 with the
 * one-shot authorization already burnt. Raw, never trimmed (like every key).
 */
export function webAppUrlValida(raw: string): boolean {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.host !== '';
}

/**
 * The connect-flow configuration (start and callback), or the key names that
 * are missing — or, for `WEB_APP_URL`, present but unusable (`webAppUrlValida`).
 */
export function lerConfigAmazon(ambiente: AmbienteAmazon): ConfigAmazon | ConfigAmazonIncompleta {
  const faltando = faltandoEm(ambiente, CHAVES_CONFIG_AMAZON);
  const web = valor(ambiente, WEB_APP_URL_ENV);
  if (web !== null && !webAppUrlValida(web)) faltando.push(WEB_APP_URL_ENV);
  if (faltando.length > 0) return { completa: false, faltando };
  return {
    completa: true,
    aplicacao: {
      clientId: presente(ambiente, LWA_CLIENT_ID_ENV),
      clientSecret: presente(ambiente, LWA_CLIENT_SECRET_ENV),
    },
    applicationId: presente(ambiente, APPLICATION_ID_ENV),
    redirectUri: presente(ambiente, REDIRECT_URI_ENV),
    segredoDoState: presente(ambiente, STATE_SECRET_ENV),
    webAppUrl: presente(ambiente, WEB_APP_URL_ENV),
  };
}

/**
 * Only the LWA pair — what the context loader's access-token refresh needs. A
 * flow (step 3's functions) never builds a consent URL nor redirects a browser,
 * so it must not be refused for lacking the connect-only keys.
 */
export function lerAplicacaoLwaAmazon(
  ambiente: AmbienteAmazon,
): { readonly completa: true; readonly aplicacao: AplicacaoLwaAmazon } | ConfigAmazonIncompleta {
  const faltando = faltandoEm(ambiente, [LWA_CLIENT_ID_ENV, LWA_CLIENT_SECRET_ENV]);
  if (faltando.length > 0) return { completa: false, faltando };
  return {
    completa: true,
    aplicacao: {
      clientId: presente(ambiente, LWA_CLIENT_ID_ENV),
      clientSecret: presente(ambiente, LWA_CLIENT_SECRET_ENV),
    },
  };
}

/**
 * The LWA keys that are PRESENT but hold a value the package's exchange would
 * refuse (`AmazonConfigError('credencial-lwa')`: outside visible ASCII — a
 * trailing newline or space from a Secret Manager paste, an interior space).
 * Key NAMES only, in declaration order; empty when the pair is usable.
 *
 * The check is the package's own predicate (`credencialLwaValida`), never a copy:
 * the OAuth start must refuse exactly what the callback's exchange would, or a
 * consent could begin that the callback can only finish by burning the attempt.
 */
export function chavesLwaRecusadas(aplicacao: AplicacaoLwaAmazon): readonly string[] {
  const recusadas: string[] = [];
  if (!credencialLwaValida(aplicacao.clientId)) recusadas.push(LWA_CLIENT_ID_ENV);
  if (!credencialLwaValida(aplicacao.clientSecret)) recusadas.push(LWA_CLIENT_SECRET_ENV);
  return recusadas;
}

/**
 * `WEB_APP_URL` alone, or `null` when it is unset, blank or not a usable
 * absolute http(s) URL (`webAppUrlValida`) — the callback's one answer that
 * cannot be a redirect, given at its step 1, before the state is verified or
 * consumed and before the code is exchanged.
 */
export function lerWebAppUrl(ambiente: AmbienteAmazon): string | null {
  const web = valor(ambiente, WEB_APP_URL_ENV);
  return web !== null && webAppUrlValida(web) ? web : null;
}

/** A civil date, exactly: four digits, two, two. */
const DATA_CIVIL = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The recorded secret expiry, as read for the sweep:
 *
 *  - `ausente` — unset or blank;
 *  - `invalida` — present but not an exact `YYYY-MM-DD` real calendar date
 *    (`2026-13-01`, `2026-02-30`, ` 2026-01-01`, `2026-1-1`): nothing is
 *    trimmed, so a stray space is a refusal, not a repair;
 *  - `valida` — the date, as written.
 *
 * The sweep treats `ausente` and `invalida` alike (the aviso is raised without a
 * date); they are told apart for the log line.
 */
export function lerSegredoExpiraEm(
  ambiente: AmbienteAmazon,
):
  | { readonly tipo: 'ausente' }
  | { readonly tipo: 'invalida' }
  | { readonly tipo: 'valida'; readonly dataCivil: string } {
  const bruto = valor(ambiente, SEGREDO_EXPIRA_EM_ENV);
  if (bruto === null) return { tipo: 'ausente' };
  // `somarDiasCivis(…, 0)` is the repo's real-date check: it refuses
  // `2026-02-30` and `2026-13-01`, not just a malformed string.
  if (!DATA_CIVIL.test(bruto) || somarDiasCivis(bruto, 0) === null) return { tipo: 'invalida' };
  return { tipo: 'valida', dataCivil: bruto };
}

/* -------------------------------------------------------------------------- */
/*                     The push receiver (step 3, PR 3-c)                     */
/* -------------------------------------------------------------------------- */

const SEGREDO_RELAY = new RegExp(
  `^[\\x21-\\x7E]{${String(MIN_SEGREDO_RELAY)},${String(MAX_SEGREDO_RELAY)}}$`,
);

/**
 * Is `valor` a relay secret the receiver can use: {@link MIN_SEGREDO_RELAY} to
 * {@link MAX_SEGREDO_RELAY} characters of VISIBLE ASCII, never trimmed?
 *
 * ⚠️ A trailing newline or space from a Secret Manager paste can never equal
 * what the Connection sends (its `ApiKeyValue` takes no control character), so
 * accepting it as "configured" would turn every delivery into a 401 — the
 * answer that may auto-disable the pipe. And the 401 path is public and
 * unthrottled, so a short secret is a guessable one (§3 decision 36).
 */
export function segredoRelayUtilizavel(valor: unknown): valor is string {
  return typeof valor === 'string' && SEGREDO_RELAY.test(valor);
}

/**
 * The receiver's configuration keys that are missing or unusable, by NAME only,
 * in a fixed order — empty when the receiver can run:
 *
 *  - {@link RELAY_SECRET_ENV}: unset, blank, or not {@link segredoRelayUtilizavel};
 *  - {@link RELAY_PREVIOUS_SECRET_ENV}: set (non-blank) but not usable — unset
 *    or blank is simply "no rotation in progress";
 *  - {@link APPLICATION_ID_ENV}: unset, blank, or refused by the package's own
 *    `applicationIdValido` (the predicate the OAuth start refuses with).
 *
 * The region is the composition root's (it reads the environment statically) and
 * is checked by the receiver itself.
 */
export function chavesDoReceptorRecusadas(ambiente: AmbienteAmazon): readonly string[] {
  const recusadas: string[] = [];
  if (!segredoRelayUtilizavel(ambiente[RELAY_SECRET_ENV])) recusadas.push(RELAY_SECRET_ENV);
  const anterior = valor(ambiente, RELAY_PREVIOUS_SECRET_ENV);
  if (anterior !== null && !segredoRelayUtilizavel(anterior)) {
    recusadas.push(RELAY_PREVIOUS_SECRET_ENV);
  }
  const applicationId = valor(ambiente, APPLICATION_ID_ENV);
  if (applicationId === null || !applicationIdValido(applicationId)) {
    recusadas.push(APPLICATION_ID_ENV);
  }
  return recusadas;
}

/** The receiver's configuration, once {@link chavesDoReceptorRecusadas} found nothing to refuse. */
export interface ConfigReceptorAmazon {
  readonly completa: true;
  /** The current relay secret, raw. */
  readonly segredoAtual: string;
  /** The previous one during a rotation, raw; `null` when unset or blank. */
  readonly segredoAnterior: string | null;
  /** Our `AMAZON_APPLICATION_ID`, raw: a notification's `ApplicationId` must equal it exactly. */
  readonly applicationId: string;
}

/** The receiver's configuration, or the refused key NAMES ({@link chavesDoReceptorRecusadas}). */
export function lerConfigDoReceptorAmazon(
  ambiente: AmbienteAmazon,
): ConfigReceptorAmazon | ConfigAmazonIncompleta {
  const recusadas = chavesDoReceptorRecusadas(ambiente);
  if (recusadas.length > 0) return { completa: false, faltando: recusadas };
  return {
    completa: true,
    segredoAtual: presente(ambiente, RELAY_SECRET_ENV),
    segredoAnterior: valor(ambiente, RELAY_PREVIOUS_SECRET_ENV),
    applicationId: presente(ambiente, APPLICATION_ID_ENV),
  };
}
