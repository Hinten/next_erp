import { z } from 'zod';

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
