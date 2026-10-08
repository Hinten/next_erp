/**
 * The credential panel's form logic, as pure functions: what each write sends,
 * whether it may be sent yet, and what the operator is told when it succeeds.
 * Kept out of the component so every boundary is pinned without rendering it.
 *
 * ## The version every write carries
 *
 * Both `PUT`s send `versaoEsperada` — the `versaoCredencialUs` of the LAST
 * status the panel holds (the status read, or the previous write's answer). The
 * route compares it with the stored credential and answers 409
 * `LI_CREDENCIAL_ALTERADA` on a mismatch, before any call to Loja Integrada:
 * two operators saving different tokens for one conta must not both see
 * "salvo" (root `CLAUDE.md` rule 7, tier 3). `null` means "I saw no token", and
 * is what a first save sends.
 *
 * ## The token
 *
 * Trimmed at both ENDS only — a paste often carries a trailing line break or a
 * space. Whitespace INSIDE is left alone: the backend refuses it as malformed
 * (`LI_TOKEN_INVALIDO`), and the backend is the authority on what a Personal
 * Token looks like. The route's schema trims the same way, so the two can never
 * disagree about where the token ends.
 */
import type {
  CorpoRenovarValidadeLi,
  CorpoSalvarCredencialLi,
  JanelaDeValidadeTokenLi,
  RespostaCredencialLojaIntegrada,
  StatusContaLojaIntegrada,
} from '@delfrance/schemas';

import { dataCivilParaExibicao } from './expiracao';

/** A `YYYY-MM-DD` civil date, the only shape the date picker hands over. */
const DATA_CIVIL = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether `expiraEm` is a civil date inside the window the route accepts
 * (`janelaDeValidadeTokenLi`, both ends inclusive). Four-digit-year `YYYY-MM-DD`
 * strings compare in calendar order, so a string comparison is exact here.
 */
export function dataNaJanela(expiraEm: string, janela: JanelaDeValidadeTokenLi): boolean {
  return DATA_CIVIL.test(expiraEm) && expiraEm >= janela.desde && expiraEm <= janela.ate;
}

/** Why a write cannot be sent yet — each one keeps its button disabled. */
export type BloqueioDoFormularioLi =
  /** The status has not loaded: there is no version to send. */
  | 'sem-status'
  /** Nothing but whitespace in the token field. */
  | 'sem-token'
  /** No expiry date picked. */
  | 'sem-data'
  /** A date outside today..today + 120 days (São Paulo). */
  | 'data-fora-da-janela'
  /** A renewal with no stored token to renew. */
  | 'sem-credencial';

export interface EntradaDoFormularioLi {
  readonly token: string;
  readonly expiraEm: string | null;
  readonly janela: JanelaDeValidadeTokenLi;
  /** The last status the panel holds; `undefined` while it loads or after it failed. */
  readonly status: StatusContaLojaIntegrada | undefined;
}

/** Why "Validar e salvar" is disabled, or `null` when it may be sent. */
export function bloqueioAoSalvar(e: EntradaDoFormularioLi): BloqueioDoFormularioLi | null {
  if (e.status === undefined) return 'sem-status';
  if (e.token.trim() === '') return 'sem-token';
  if (e.expiraEm === null) return 'sem-data';
  if (!dataNaJanela(e.expiraEm, e.janela)) return 'data-fora-da-janela';
  return null;
}

/**
 * Why "Só atualizar a validade" is disabled, or `null`. The token field plays
 * no part: a renewal re-validates the STORED token, which nobody can paste
 * again (Loja Integrada shows it once).
 */
export function bloqueioAoRenovar(
  e: Omit<EntradaDoFormularioLi, 'token'>,
): BloqueioDoFormularioLi | null {
  if (e.status === undefined) return 'sem-status';
  if (!e.status.configurado || e.status.versaoCredencialUs === null) return 'sem-credencial';
  if (e.expiraEm === null) return 'sem-data';
  if (!dataNaJanela(e.expiraEm, e.janela)) return 'data-fora-da-janela';
  return null;
}

/**
 * The save body, exactly the route's three keys: the token trimmed at both
 * ends, the picked date, and the version of the status the operator saw.
 */
export function montarCorpoSalvar(
  token: string,
  expiraEm: string,
  status: StatusContaLojaIntegrada,
): CorpoSalvarCredencialLi {
  return { token: token.trim(), expiraEm, versaoEsperada: status.versaoCredencialUs };
}

/**
 * The renewal body, or `null` when there is no stored credential to renew (its
 * version is never `null` on the wire: there is always a token to renew).
 */
export function montarCorpoRenovar(
  expiraEm: string,
  status: StatusContaLojaIntegrada,
): CorpoRenovarValidadeLi | null {
  if (!status.configurado || status.versaoCredencialUs === null) return null;
  return { expiraEm, versaoEsperada: status.versaoCredencialUs };
}

/**
 * A write's answer as the status the panel caches — `reconexaoResolvida` is
 * about the write, not the conta, so it is dropped. The next write then carries
 * THIS answer's version, which is the credential's version now.
 */
export function statusDaResposta(r: RespostaCredencialLojaIntegrada): StatusContaLojaIntegrada {
  return {
    configurado: r.configurado,
    expiraEm: r.expiraEm,
    diasParaExpirar: r.diasParaExpirar,
    situacaoValidade: r.situacaoValidade,
    atualizadoEmMs: r.atualizadoEmMs,
    versaoCredencialUs: r.versaoCredencialUs,
    reconexaoPendente: r.reconexaoPendente,
  };
}

/** `' A reconexão pendente foi resolvida.'` when the write closed the park's aviso. */
function sufixoReconexao(r: RespostaCredencialLojaIntegrada): string {
  return r.reconexaoResolvida ? ' A reconexão pendente foi resolvida.' : '';
}

/** `'até 31/12/2026'`, or nothing when the answer carries no date. */
function ateADataDe(r: RespostaCredencialLojaIntegrada): string {
  return r.expiraEm === null ? '' : ` Validade até ${dataCivilParaExibicao(r.expiraEm)}.`;
}

/** What a successful save says. */
export function mensagemSalvo(r: RespostaCredencialLojaIntegrada): string {
  return `Token validado e salvo.${ateADataDe(r)}${sufixoReconexao(r)}`;
}

/** What a successful renewal says. */
export function mensagemRenovado(r: RespostaCredencialLojaIntegrada): string {
  return `Token salvo revalidado na Loja Integrada.${ateADataDe(r)}${sufixoReconexao(r)}`;
}

/** What a successful removal says. */
export const MENSAGEM_REMOVIDO =
  'Token removido. A conta fica sem credencial até um novo Personal Token ser salvo.';
