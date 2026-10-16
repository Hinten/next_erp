import { z } from 'zod';
import { dataCivilNoFuso, somarDiasCivis } from '@delfrance/core/datetime';
import { INTEGRACAO_TIPO } from './integracao';
import { FUSO_FISCAL } from './simplesNacional/competencia';

/* -------------------------------------------------------------------------- */
/*               Amazon conta: the wire contract of apps/amazon               */
/* -------------------------------------------------------------------------- */

/**
 * The shared wire contract between `apps/amazon` (the conta status route, the
 * OAuth start route and the public OAuth callback) and `apps/web` (the conta
 * screen's connect panel). ONE definition, imported by both sides: `apps/web`
 * has no dependency edge to any app, so anything the panel and the routes must
 * agree on lives here or is written twice.
 *
 * Pure and total: no clock, no network, no Firestore. Every function takes the
 * instant it reasons about as a parameter.
 *
 * It holds: the reauthorization arithmetic (São Paulo civil days), the seller-id
 * predicate and the read-free routing predicate step 3 reuses, the error `code`s
 * and envelope, the status projection, the start answer, and the closed set of
 * OAuth-return reasons the callback redirects with.
 *
 * ⚠️ A NEW file on purpose, not a block inside `integracao.ts`: that file sits
 * on the NF-e live lane's path list, so every push touching it would cost a
 * SEFAZ homologação emission. Importing from it does not touch it.
 */

/* -------------------------------------------------------------------------- */
/*                      Reauthorization (civil days, SP)                       */
/* -------------------------------------------------------------------------- */

/**
 * The reauthorization aviso is raised at or below this many civil days left,
 * and resolved above it — 29 and 30 warn, 31 is silent. Amazon e-mails the
 * seller 30 days ahead too; this is the in-app backstop. The same threshold
 * serves the app-secret rotation aviso.
 */
export const LIMIAR_AVISO_AMAZON_DIAS = 30;

/**
 * How long a seller's authorization of the app lasts, in civil days. The
 * documentation disagrees on the lifetime, so this keys on the STRICTEST rule.
 * The clock is OUR callback's code-exchange start (`autorizadoEmMs` on the
 * credential), never the conta's creation date or anything in the migrated
 * corpus.
 */
export const VALIDADE_AUTORIZACAO_AMAZON_DIAS = 365;

/** A civil date, `YYYY-MM-DD` — never a `Date`, so no zone can shift it. */
const DATA_CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A day, in milliseconds. */
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * The UTC epoch ms of midnight on a civil date's own calendar day — a day
 * NUMBER, not an instant anyone lived. Two civil dates are compared by
 * subtracting these: the UTC calendar has no daylight-saving day, so the
 * difference is an exact multiple of {@link DIA_MS}, and no zone (São Paulo's,
 * UTC's or the runner's) can move it.
 *
 * ⚠️ `setUTCFullYear`, never `Date.UTC`: `Date.UTC` maps the years 0–99 to
 * 1900–1999.
 *
 * @throws RangeError when `dataCivil` is not a real `YYYY-MM-DD` date
 *   (`somarDiasCivis(…, 0)` is the repo's validity check: it refuses
 *   `2026-02-30` and `2026-13-01`, not just a malformed string).
 */
function diaDoCalendario(dataCivil: string, quem: string): number {
  const partes = DATA_CIVIL.exec(dataCivil);
  if (partes === null || somarDiasCivis(dataCivil, 0) === null) {
    throw new RangeError(`${quem}: data civil inválida (${dataCivil})`);
  }
  const [, ano = '', mes = '', dia = ''] = partes;
  const instante = new Date(0);
  instante.setUTCFullYear(Number(ano), Number(mes) - 1, Number(dia));
  return instante.getTime();
}

/**
 * The São Paulo civil date (`YYYY-MM-DD`) by which the conta must be
 * reauthorized: the civil day of `autorizadoEmMs` in {@link FUSO_FISCAL} plus
 * {@link VALIDADE_AUTORIZACAO_AMAZON_DIAS} calendar days.
 *
 * ⚠️ Civil days in `FUSO_FISCAL`, never UTC and never the ambient zone: an
 * authorization at 23:30 in São Paulo is already the next day in UTC, and a
 * UTC date would promise the operator one day more than they have. And 365
 * DAYS, never "the same date next year": across a 29 February the two differ.
 *
 * @throws RangeError when `autorizadoEmMs` is not an integer in Temporal's
 *   range (the credential schema guarantees an integer).
 */
export function reautorizarAteAmazon(autorizadoEmMs: number): string {
  const autorizadoEm = dataCivilNoFuso(autorizadoEmMs, FUSO_FISCAL);
  const ate = somarDiasCivis(autorizadoEm, VALIDADE_AUTORIZACAO_AMAZON_DIAS);
  // Unreachable for any real clock: `autorizadoEm` is a well-formed date, and
  // adding 365 days leaves Temporal's range only past the year 275 760.
  if (ate === null) {
    throw new RangeError(`reautorizarAteAmazon: data fora do intervalo (${autorizadoEm})`);
  }
  return ate;
}

/**
 * Whole civil days from today in São Paulo (the civil day of `agoraMs` in
 * {@link FUSO_FISCAL}) to `dataCivil`: `0` ON that date, negative after it.
 *
 * Calendar days, not elapsed time divided by 24 h: the count changes at São
 * Paulo midnight and nowhere else, so the panel and the daily sweep agree all
 * day long, whatever the runner's zone.
 *
 * @throws RangeError when `dataCivil` is not a real `YYYY-MM-DD` date (callers
 *   holding an operator-typed value validate it first), or when `agoraMs` is
 *   not an integer in Temporal's range.
 */
export function diasAteDataCivilAmazon(dataCivil: string, agoraMs: number): number {
  const quem = 'diasAteDataCivilAmazon';
  const alvo = diaDoCalendario(dataCivil, quem);
  const hoje = diaDoCalendario(dataCivilNoFuso(agoraMs, FUSO_FISCAL), quem);
  return (alvo - hoje) / DIA_MS;
}

/**
 * Whole São Paulo civil days left until {@link reautorizarAteAmazon}: `0` on the
 * reauthorization date itself, negative once it has passed. Both arguments are
 * epoch MILLISECONDS.
 */
export function diasParaReautorizarAmazon(autorizadoEmMs: number, agoraMs: number): number {
  return diasAteDataCivilAmazon(reautorizarAteAmazon(autorizadoEmMs), agoraMs);
}

/* -------------------------------------------------------------------------- */
/*                         Seller id and routability                          */
/* -------------------------------------------------------------------------- */

/** The longest `selling_partner_id` accepted. A bound on the input, not a format. */
export const MAX_SELLING_PARTNER_ID = 64;

/** Visible ASCII only (`!` to `~`): no space, no control character, no accent. */
const ASCII_VISIVEL = /^[\x21-\x7E]+$/;

/**
 * Is `raw` a seller id this ERP will store and compare? 1 to
 * {@link MAX_SELLING_PARTNER_ID} characters of visible ASCII.
 *
 * ⚠️ **Never a format pattern.** Amazon does not document the id's shape, so a
 * pattern would be a guess that refuses a real seller one day.
 *
 * ⚠️ **Never trimmed, never case-folded.** The id is compared EXACTLY (the
 * wrong-seller guard, step 3's routing query), so a value that needs cleaning
 * is refused rather than repaired: a trimmed or lower-cased copy would match a
 * different seller's routing key or none at all.
 */
export function sellingPartnerIdValido(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    raw.length >= 1 &&
    raw.length <= MAX_SELLING_PARTNER_ID &&
    ASCII_VISIVEL.test(raw)
  );
}

/**
 * Would step 3's routing query find this raw conta document? `tipo` is Amazon,
 * `ativo === true` (strict) and `selling_partner_id` is a valid seller id —
 * exactly the predicate of `where(tipo == amazon) . where(selling_partner_id ==
 * X) . where(ativo == true)`, evaluated on a payload with no read.
 *
 * The read-free twin of Shopee's `shopIdResolvivel`: a trigger gates on it
 * BEFORE any read (and re-applies it to a fresh read before acting), and the
 * deferred lane uses it to decide whether a conta can take its notifications.
 *
 * ⚠️ An ABSENT `ativo` is NOT routable — the query's `ativo == true` excludes it.
 * Do not "fix" that toward the int_frete mirror, which reads absent as true.
 */
export function contaAmazonRoteavel(rawConta: unknown): boolean {
  if (typeof rawConta !== 'object' || rawConta === null || Array.isArray(rawConta)) return false;
  const conta = rawConta as Record<string, unknown>;
  return (
    conta.tipo === INTEGRACAO_TIPO.amazon &&
    conta.ativo === true &&
    sellingPartnerIdValido(conta.selling_partner_id)
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Errors                                   */
/* -------------------------------------------------------------------------- */

/**
 * The `code` of every error envelope (`{ error, code, … }`) the conta routes
 * answer with. The panel keys its copy on `code`, never on the status alone: two
 * 503s with opposite advice, or a 404 from the route versus one from a proxy,
 * need different sentences.
 */
export const CODIGO_ERRO_AMAZON = {
  /** 400 — the conta id is empty, too long, or carries a character a path would misread. */
  ID_INVALIDO: 'AMAZON_ID_INVALIDO',
  /** 404 — no conta with this id, or it is not an Amazon conta. */
  CONTA_NAO_ENCONTRADA: 'AMAZON_CONTA_NAO_ENCONTRADA',
  /**
   * 503 — the backend's read switch (`AMAZON_CHAMADAS`) is not exactly `on`, so
   * it calls Amazon for nothing: nothing was sent and nothing was saved. The
   * state of every environment until the cutover, and after it the answer to a
   * mis-set value (`ON`, ` on`, `true`); retrying does not help.
   */
  CHAMADAS_DESLIGADAS: 'AMAZON_CHAMADAS_DESLIGADAS',
  /**
   * 500 — the backend lacks configuration the whole connect flow needs. The
   * message names the missing variable NAMES, never a value.
   */
  CONFIG_AUSENTE: 'AMAZON_CONFIG_AUSENTE',
} as const;
export type CodigoErroAmazon = (typeof CODIGO_ERRO_AMAZON)[keyof typeof CODIGO_ERRO_AMAZON];

/**
 * Every non-2xx JSON body of the conta routes: the repo's `{ error, code, … }`
 * envelope, the same shape as `erroContaLojaIntegradaSchema`.
 *
 * - `code` is a plain string rather than {@link CODIGO_ERRO_AMAZON}'s union, so
 *   a code a newer backend adds still parses in an older browser — and so do
 *   the coded answers of the backend's `verifyCaller`: a 401 carrying the
 *   Firebase Auth code (`auth/id-token-expired`) and a 500 carrying the Admin
 *   init code (`app/…`).
 * - ⚠️ `code` stays REQUIRED. `verifyCaller`'s codeless answers (a 401 for a
 *   missing Bearer token, the 403 for a missing permission) and any proxy body
 *   do NOT parse as this envelope; the panel maps those by HTTP status, as the
 *   Loja Integrada panel does. A required `code` is what tells a conta-route
 *   answer from a body that never reached one.
 * - `issues` — field PATHS only, never a value.
 * - `status` / `correlationId` — kept for parity with the Loja Integrada
 *   envelope; no step-2 route sets them.
 *
 * ⚠️ No envelope ever carries a token, a code, a state, a seller id or a ref.
 */
export const erroContaAmazonSchema = z.object({
  error: z.string(),
  code: z.string(),
  issues: z.array(z.string()).nullable().optional(),
  status: z.number().int().nullable().optional(),
  correlationId: z.string().nullable().optional(),
});
export type ErroContaAmazon = z.infer<typeof erroContaAmazonSchema>;

/* -------------------------------------------------------------------------- */
/*                                  Answers                                   */
/* -------------------------------------------------------------------------- */

/** A civil date on the wire — `YYYY-MM-DD`, shown by splitting the string. */
const dataCivilWireSchema = z.string().regex(DATA_CIVIL);

/**
 * What `GET /api/marketplace/amazon/conta/[id]` answers: an explicit PROJECTION
 * of the conta and its credential, never the document.
 *
 * - `connected` — the conta holds a credential that parses. A PARKED credential
 *   is still connected: `reconexaoPendente` is what says it was refused.
 * - `credencialInvalida` — a credential document exists but does not parse
 *   (strict schema); `connected` is then `false`. Reconnecting overwrites it.
 * - `autorizadoEm` / `reautorizarAte` — São Paulo civil dates; `null` when not
 *   connected. `diasParaReautorizar` — {@link diasParaReautorizarAmazon}.
 * - `reconexaoPendente` — the park, as a civil date and the refusing HTTP
 *   status; `null` when not parked.
 * - `chamadasLigadas` — the read switch is exactly `on`. While it is not, the
 *   start route answers 503 {@link CODIGO_ERRO_AMAZON}`.CHAMADAS_DESLIGADAS`.
 *
 * ⚠️ It carries no token, no ref, no fingerprint, no LWA code and no seller id.
 *
 * NON-strict on purpose (`z.object`): a later step may add a field, and a
 * browser built against this version must keep parsing the answer (unknown keys
 * are stripped, never refused).
 */
export const statusContaAmazonSchema = z.object({
  connected: z.boolean(),
  credencialInvalida: z.boolean(),
  autorizadoEm: dataCivilWireSchema.nullable(),
  reautorizarAte: dataCivilWireSchema.nullable(),
  diasParaReautorizar: z.number().int().nullable(),
  reconexaoPendente: z
    .object({
      desde: dataCivilWireSchema,
      status: z.number().int(),
    })
    .nullable(),
  chamadasLigadas: z.boolean(),
});
export type StatusContaAmazon = z.infer<typeof statusContaAmazonSchema>;

/**
 * What `POST /api/marketplace/amazon/conta/[id]/oauth/start` answers: the
 * Seller Central consent URL the browser navigates to. Tolerant like the
 * status, for the same reason.
 */
export const respostaInicioOAuthAmazonSchema = z.object({
  authorizeUrl: z.string().url(),
});
export type RespostaInicioOAuthAmazon = z.infer<typeof respostaInicioOAuthAmazonSchema>;

/* -------------------------------------------------------------------------- */
/*                            OAuth callback return                           */
/* -------------------------------------------------------------------------- */

/**
 * The query key the public OAuth callback redirects back to `apps/web` with:
 * `?amazon=connected`, or `?amazon=error&reason=<motivo>` — the shape the web's
 * shared callback toast reads. Nothing else ever rides on that URL.
 */
export const CHAVE_RETORNO_OAUTH_AMAZON = 'amazon';

/**
 * Why a connect attempt failed — the `reason` of `?amazon=error&reason=…`. A
 * CLOSED set: the callback only ever writes one of these, and the panel's copy
 * is total over it (`Record<MotivoRetornoOAuthAmazon, string>`), so an added
 * reason fails typecheck in `apps/web` until it has a sentence.
 *
 * `config` and `bad_state` redirect to the conta LIST (`/canais/amazon`): there
 * is no trustworthy conta id yet when the backend's configuration is missing or
 * the state did not verify. Every other reason redirects to the conta page.
 *
 *  - `config` — the backend lacks configuration (names logged, never values).
 *  - `bad_state` — the state was missing, did not verify, or was already used,
 *    superseded or expired.
 *  - `integracao_desligada` — the read switch is not `on`; nothing consumed.
 *  - `missing_params` — no authorization code (a cancelled consent); nothing consumed.
 *  - `vendedor_invalido` — the returned seller id is not a valid id; nothing consumed.
 *  - `conta` — the conta is gone or is not an Amazon conta.
 *  - `vendedor_diferente` — the conta is already bound to a DIFFERENT seller.
 *  - `vendedor_em_outra_conta` — another ACTIVE Amazon conta holds this seller.
 *  - `codigo_invalido` — Amazon refused the authorization code (expired or used).
 *  - `server_config` — Amazon refused OUR application credentials, or the
 *    package refused our configuration.
 *  - `amazon_indisponivel` — throttled, or a transient Amazon failure.
 *  - `tempo_esgotado` — the exchange timed out; the code may be spent, restart.
 *  - `rede` — the network failed before an answer.
 *  - `resposta_invalida` — Amazon answered outside the documented shape.
 *  - `conflito` — the seller id write lost its precondition three times.
 *  - `exchange` — any other failure of the code exchange.
 */
export const motivoRetornoOAuthAmazonSchema = z.enum([
  'config',
  'bad_state',
  'integracao_desligada',
  'missing_params',
  'vendedor_invalido',
  'conta',
  'vendedor_diferente',
  'vendedor_em_outra_conta',
  'codigo_invalido',
  'server_config',
  'amazon_indisponivel',
  'tempo_esgotado',
  'rede',
  'resposta_invalida',
  'conflito',
  'exchange',
]);
export type MotivoRetornoOAuthAmazon = z.infer<typeof motivoRetornoOAuthAmazonSchema>;

/** Named members of {@link motivoRetornoOAuthAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const MOTIVO_RETORNO_OAUTH_AMAZON = {
  config: 'config',
  badState: 'bad_state',
  integracaoDesligada: 'integracao_desligada',
  missingParams: 'missing_params',
  vendedorInvalido: 'vendedor_invalido',
  conta: 'conta',
  vendedorDiferente: 'vendedor_diferente',
  vendedorEmOutraConta: 'vendedor_em_outra_conta',
  codigoInvalido: 'codigo_invalido',
  serverConfig: 'server_config',
  amazonIndisponivel: 'amazon_indisponivel',
  tempoEsgotado: 'tempo_esgotado',
  rede: 'rede',
  respostaInvalida: 'resposta_invalida',
  conflito: 'conflito',
  exchange: 'exchange',
} as const satisfies Record<string, MotivoRetornoOAuthAmazon>;
