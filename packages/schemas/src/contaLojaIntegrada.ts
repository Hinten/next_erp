import { z } from 'zod';
import { dataCivilNoFuso, somarDiasCivis } from '@delfrance/core/datetime';
import { FUSO_FISCAL } from './simplesNacional/competencia';

/* -------------------------------------------------------------------------- */
/*          Loja Integrada conta: the wire contract of apps/loja-integrada    */
/* -------------------------------------------------------------------------- */

/**
 * The shared wire contract between `apps/loja-integrada` (the routes that store,
 * renew and report a conta's Personal Token) and `apps/web` (the credential
 * panel). ONE definition, imported by both sides: `apps/web` has no dependency
 * edge to any app, so anything the panel and the routes must agree on lives
 * here or is written twice.
 *
 * Pure and total: no clock, no network, no Firestore. Every function takes the
 * instant it reasons about as a parameter.
 *
 * It holds: the expiry arithmetic and the accepted date window, the error
 * `code`s, the request bodies of the two `PUT`s, and every answer shape (the
 * status projection, the write answer, the removal answer, the error envelope).
 *
 * ⚠️ A NEW file on purpose, not a block inside `integracao.ts`: that file sits on
 * the NF-e live lane's path list, so every push touching it would cost a SEFAZ
 * homologação emission. This one is on no such list.
 */

/** A day, in milliseconds. */
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * The expiry aviso is raised at or below this many whole days left, and
 * resolved above it. Loja Integrada's own painel offers "Renovar" from 30 days
 * before the expiry, so the warning starts the day the remedy exists.
 */
export const LIMIAR_AVISO_TOKEN_LI_DIAS = 30;

/**
 * The furthest expiry date a save or a renewal accepts, in whole days from
 * today (São Paulo). A Personal Token lasts three months, so anything past this
 * is a typo in the year, never a real date. Some slack over 92 days on purpose:
 * a renewal on the last day of a month must not be refused.
 */
export const VALIDADE_TOKEN_LI_MAX_DIAS = 120;

/** The civil-date window an expiry date must fall in, both ends inclusive. */
export interface JanelaDeValidadeTokenLi {
  /** Today in São Paulo, `YYYY-MM-DD` — the earliest date accepted. */
  readonly desde: string;
  /** Today + {@link VALIDADE_TOKEN_LI_MAX_DIAS}, `YYYY-MM-DD` — the latest one. */
  readonly ate: string;
}

/**
 * The expiry dates a save or a renewal accepts at instant `agoraMs`: from today
 * to today + {@link VALIDADE_TOKEN_LI_MAX_DIAS}, as São Paulo CIVIL dates.
 *
 * ONE rule for both surfaces: the routes refuse a date outside it (422), and the
 * panel's date picker offers exactly it, so the picker can never offer a date
 * the route refuses.
 *
 * ⚠️ Civil dates in {@link FUSO_FISCAL}, never UTC: at 23:30 in São Paulo it is
 * already tomorrow in UTC, and a UTC "today" would refuse the operator's today.
 *
 * Both bounds are `YYYY-MM-DD` with a four-digit year, so they compare as
 * strings in calendar order.
 */
export function janelaDeValidadeTokenLi(agoraMs: number): JanelaDeValidadeTokenLi {
  const desde = dataCivilNoFuso(agoraMs, FUSO_FISCAL);
  const ate = somarDiasCivis(desde, VALIDADE_TOKEN_LI_MAX_DIAS);
  // Unreachable for any real clock: `desde` is a well-formed date, and adding
  // 120 days leaves Temporal's range only past the year 275 760.
  if (ate === null) {
    throw new RangeError(`janelaDeValidadeTokenLi: data fora do intervalo (${desde})`);
  }
  return { desde, ate };
}

/**
 * Whole days until the token's stated expiry.
 *
 * `Math.floor`, so the last partial day reads `0` rather than `1`: an operator
 * told "1 day left" on the morning it expires would plan for tomorrow. Negative
 * past the expiry, which is a real state — the date the operator copied has
 * passed, and unless the owner renewed it in the painel the token is revoked.
 *
 * Both arguments are epoch MILLISECONDS.
 */
export function diasParaExpirarLi(expiraEmMs: number, agoraMs: number): number {
  return Math.floor((expiraEmMs - agoraMs) / DIA_MS);
}

/** How the stored expiry date reads today. */
export const situacaoValidadeTokenLiSchema = z.enum(['ok', 'expirando', 'vencido']);
export type SituacaoValidadeTokenLi = z.infer<typeof situacaoValidadeTokenLiSchema>;

export const SITUACAO_VALIDADE_TOKEN_LI = {
  ok: 'ok',
  expirando: 'expirando',
  vencido: 'vencido',
} as const satisfies Record<string, SituacaoValidadeTokenLi>;

/**
 * `ok` above {@link LIMIAR_AVISO_TOKEN_LI_DIAS}, `expirando` from that down to
 * `0` (the last day — "vence hoje"), `vencido` below `0`.
 *
 * ⚠️ The same threshold the expiry aviso uses (`<=`), so the panel's colour and
 * the inbox never disagree about one conta.
 */
export function situacaoValidadeTokenLi(dias: number): SituacaoValidadeTokenLi {
  if (dias < 0) return SITUACAO_VALIDADE_TOKEN_LI.vencido;
  if (dias <= LIMIAR_AVISO_TOKEN_LI_DIAS) return SITUACAO_VALIDADE_TOKEN_LI.expirando;
  return SITUACAO_VALIDADE_TOKEN_LI.ok;
}

/**
 * The `code` of every error envelope (`{ error, code, issues? }`) the conta
 * routes answer with. The panel keys its copy on `code`, never on the status
 * alone: a 422 can mean "refused by Loja Integrada" or "malformed, never sent",
 * and the two need opposite advice.
 */
export const CODIGO_ERRO_LI = {
  /** 400 — an empty id, or one carrying `/`, `.` or `..`. */
  idInvalido: 'LI_ID_INVALIDO',
  /** 400 — the body is not JSON, or not the expected shape (paths only). */
  corpoInvalido: 'LI_CORPO_INVALIDO',
  /** 422 — the expiry date is not a real `YYYY-MM-DD` date. */
  validadeInvalida: 'LI_VALIDADE_INVALIDA',
  /** 422 — the expiry date is before today (São Paulo). */
  validadePassada: 'LI_VALIDADE_PASSADA',
  /** 422 — the expiry date is after today + {@link VALIDADE_TOKEN_LI_MAX_DIAS}. */
  validadeDistante: 'LI_VALIDADE_DISTANTE',
  /** 404 — no conta with this id, or it is not a Loja Integrada conta. */
  contaNaoEncontrada: 'LI_CONTA_NAO_ENCONTRADA',
  /** 409 — the conta is inactive (only the flows refuse it; the routes do not). */
  contaInativa: 'LI_CONTA_INATIVA',
  /** 409 — the conta holds no token. */
  credencialAusente: 'LI_CREDENCIAL_AUSENTE',
  /** 409 — the stored credential does not parse (paths only). Remove it, then save. */
  credencialInvalida: 'LI_CREDENCIAL_INVALIDA',
  /** 409 — the credential changed after the operator's page read it. */
  credencialAlterada: 'LI_CREDENCIAL_ALTERADA',
  /** 409 — Loja Integrada refused the stored token; the conta is parked. */
  reconexaoPendente: 'LI_RECONEXAO_PENDENTE',
  /** 409 — the same token is already stored on another Loja Integrada conta. */
  tokenDeOutraConta: 'LI_TOKEN_DE_OUTRA_CONTA',
  /** 422 — Loja Integrada refused the candidate token (401/403). */
  tokenRecusado: 'LI_TOKEN_RECUSADO',
  /** 422 — the candidate token is malformed; nothing reached Loja Integrada. */
  tokenInvalido: 'LI_TOKEN_INVALIDO',
  /** 502 — the validation could not conclude anything; nothing was saved. */
  validacaoInconclusiva: 'LI_VALIDACAO_INCONCLUSIVA',
  /** 503 — the park lost its precondition three times in a row; retry. */
  estacionamentoEmConflito: 'LI_ESTACIONAMENTO_EM_CONFLITO',
} as const;
export type CodigoErroLi = (typeof CODIGO_ERRO_LI)[keyof typeof CODIGO_ERRO_LI];

/** A civil date, `YYYY-MM-DD` — never a `Date`, so no zone can shift it. */
const DATA_CIVIL = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What `GET /api/marketplace/loja-integrada/conta/[id]` answers: an explicit
 * PROJECTION of the credential document, never the document.
 *
 * ⚠️ It carries no token, no fingerprint and no `refCredencial` — the park's
 * ref is an internal guard input, not something an operator acts on.
 *
 * NON-strict on purpose: a later step may add a field, and a browser built
 * against this version must keep parsing the answer (unknown keys are
 * stripped, never refused).
 *
 * Units: `atualizadoEmMs` / `reconexaoPendente.desdeMs` are MILLISECONDS for
 * display; `versaoCredencialUs` is the MICROSECONDS of the credential
 * document's last commit — an opaque version the panel echoes back as
 * `versaoEsperada` on its next write, never a clock to render or compare.
 */
export const statusContaLojaIntegradaSchema = z.object({
  configurado: z.boolean(),
  /** The expiry as a São Paulo civil date. `null` when no token is stored. */
  expiraEm: z.string().regex(DATA_CIVIL).nullable(),
  diasParaExpirar: z.number().int().nullable(),
  situacaoValidade: situacaoValidadeTokenLiSchema.nullable(),
  /** ms — when the stored token was last validated (save or renewal). */
  atualizadoEmMs: z.number().int().nullable(),
  /** µs — the credential document's commit time; echo it, never interpret it. */
  versaoCredencialUs: z.number().int().nonnegative().nullable(),
  reconexaoPendente: z
    .object({
      /** ms, for display only. */
      desdeMs: z.number().int(),
      status: z.union([z.literal(401), z.literal(403)]),
    })
    .nullable(),
});
export type StatusContaLojaIntegrada = z.infer<typeof statusContaLojaIntegradaSchema>;

/**
 * What a successful save (`PUT …/credencial`) or renewal (`PUT …/credencial/validade`)
 * answers: the status computed from the values just written, plus whether that
 * write closed an open "token recusado" aviso.
 */
export const respostaCredencialLojaIntegradaSchema = statusContaLojaIntegradaSchema.extend({
  reconexaoResolvida: z.boolean(),
});
export type RespostaCredencialLojaIntegrada = z.infer<typeof respostaCredencialLojaIntegradaSchema>;

/* -------------------------------------------------------------------------- */
/*                               Request bodies                                */
/* -------------------------------------------------------------------------- */

/**
 * The longest Personal Token a save accepts, after trimming. The real length is
 * not documented anywhere we could read; this only bounds the body.
 */
export const MAX_TOKEN_LI = 1024;

/** The version a write carries: the `versaoCredencialUs` the panel last read. */
const versaoCredencialSchema = z.number().int().nonnegative();

/**
 * `PUT /api/marketplace/loja-integrada/conta/[id]/credencial` — validate a
 * Personal Token against Loja Integrada and store it.
 *
 * - `token` is trimmed at BOTH ends here, once (a paste often carries a trailing
 *   line break), and never anywhere else. Whitespace INSIDE it is kept: the
 *   package refuses it before any request, and the route answers that as a
 *   malformed token rather than guessing what was meant.
 * - `expiraEm` is the date the operator copied from the painel. Only its type is
 *   checked here: a bad or out-of-window date is a 422 from the route, so the
 *   panel can show it on the date field instead of as a malformed request.
 * - `versaoEsperada` is `null` when the panel saw no stored token, otherwise the
 *   `versaoCredencialUs` it last read. A mismatch is a 409, before any call.
 *
 * Strict: an unknown key is a 400.
 */
export const corpoSalvarCredencialLiSchema = z.strictObject({
  token: z.string().trim().min(1).max(MAX_TOKEN_LI),
  expiraEm: z.string(),
  versaoEsperada: versaoCredencialSchema.nullable(),
});
export type CorpoSalvarCredencialLi = z.input<typeof corpoSalvarCredencialLiSchema>;

/**
 * `PUT /api/marketplace/loja-integrada/conta/[id]/credencial/validade` — the
 * token was renewed in the painel (renewal keeps the SAME token, which is never
 * shown again), so the stored one is re-validated and only its expiry changes.
 * There is always a stored token to renew, so the version is never `null`.
 */
export const corpoRenovarValidadeLiSchema = z.strictObject({
  expiraEm: z.string(),
  versaoEsperada: versaoCredencialSchema,
});
export type CorpoRenovarValidadeLi = z.input<typeof corpoRenovarValidadeLiSchema>;

/* -------------------------------------------------------------------------- */
/*                         Other answers of the routes                         */
/* -------------------------------------------------------------------------- */

/** What `DELETE …/conta/[id]/credencial` answers. It is idempotent. */
export const respostaRemocaoCredencialLiSchema = z.object({ ok: z.literal(true) });
export type RespostaRemocaoCredencialLi = z.infer<typeof respostaRemocaoCredencialLiSchema>;

/**
 * Every non-2xx body of the conta routes: the repo's `{ error, code, issues? }`
 * envelope, plus two fields only the validation outcomes carry.
 *
 * - `issues` — field PATHS only, never a value;
 * - `status` — the HTTP status Loja Integrada answered, on a refused or
 *   inconclusive validation (`null` when there was none);
 * - `correlationId` — the validation call's id, to find it in the logs.
 *
 * `code` is a plain string rather than {@link CODIGO_ERRO_LI}'s union: a code a
 * newer backend adds must still parse in an older browser.
 *
 * ⚠️ No envelope ever carries the token, its fingerprint or a response body.
 */
export const erroContaLojaIntegradaSchema = z.object({
  error: z.string(),
  code: z.string(),
  issues: z.array(z.string()).nullable().optional(),
  status: z.number().int().nullable().optional(),
  correlationId: z.string().nullable().optional(),
});
export type ErroContaLojaIntegrada = z.infer<typeof erroContaLojaIntegradaSchema>;
