/**
 * The Loja Integrada operations this package ships today: the validating GET,
 * `validarPersonalToken`, which the app's connect route calls before it stores a
 * candidate token.
 *
 * `URL_BASE_LI` is re-exported from here; it is DEFINED in `client.ts`, the
 * module that hard-wires it, so the two never import each other in a cycle.
 */
import { z } from 'zod';

import { criarClienteLeituraLi } from './client';
import { LiAuthError, LiConfigError, LiHttpError, LiNetworkError, LiSchemaError } from './errors';
import { liEnvelopeSchema } from './types';

export { URL_BASE_LI } from './client';

/**
 * The path of the validating GET.
 *
 * ⚠️ The SLASH form, deliberately: the public document's own curl example and
 * the legacy app's live calls both use `/v1/categoria/`. The client never
 * follows a redirect, so if the form were ever wrong the call fails visibly with
 * a 3xx — it cannot silently double the calls or carry the token elsewhere.
 */
export const CAMINHO_VALIDACAO = '/v1/categoria/';

/**
 * The fixed credential label of a candidate token: there is no fingerprint yet,
 * because nothing is stored until the verdict is `aceito`.
 */
const REF_CANDIDATO = 'candidato';

export type VereditoTokenLi = 'aceito' | 'recusado' | 'invalido' | 'inconclusivo';

export interface ValidacaoTokenLi {
  /**
   * - `aceito` — a 2xx with a valid paging envelope.
   * - `recusado` — 401 or 403: Loja Integrada refused the token.
   * - `invalido` — the token is malformed (empty, whitespace, a line break, a
   *   control or non-ASCII character, or so short it fits inside the fixed
   *   label or URL of this call) and was NEVER sent.
   * - `inconclusivo` — anything else (another status, a malformed body, a
   *   network failure, a timeout): nothing can be concluded about the token, and
   *   the operator retries.
   */
  readonly veredito: VereditoTokenLi;
  /** The HTTP status, or `null` when there was none. */
  readonly status: number | null;
  /** A pt-BR sentence for the operator. Never contains the token or any body text. */
  readonly motivo: string;
  readonly correlationId: string;
}

export interface OpcoesValidacaoLi {
  /** The candidate Personal Token, exactly as typed — never trimmed here. */
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sinal?: AbortSignal;
  readonly gerarCorrelationId?: () => string;
}

/**
 * `GET /v1/categoria/?limit=1` with a candidate token, read as one of four
 * verdicts.
 *
 * Mapped by CLASS (repo rule 6), most specific first:
 *
 * | outcome | verdict |
 * | --- | --- |
 * | 2xx with a valid envelope (any rows, none included) | `aceito` |
 * | `LiAuthError` (401, 403) | `recusado` |
 * | `LiConfigError` `'token'`, `'ref'` or `'token-na-url'` (see the catch) | `invalido`; no request was made |
 * | any other `LiHttpError`, `LiSchemaError`, `LiNetworkError` (timeout included) | `inconclusivo` |
 * | a caller abort, any other `LiConfigError`, or any other error | rethrown as-is |
 *
 * ⚠️ **400 is never `recusado`.** How Loja Integrada answers a bad token beyond
 * 401/403 is not yet observed, so any other status reads as "could not tell",
 * never as a verdict on the token.
 *
 * ⚠️ **No `x-correlation-id` on this call.** The public document lists that
 * header only for the Enviali paths; until a probe shows `/v1` accepts it, a
 * gateway that refused an unknown header with a 403 would make a valid new
 * token read as `recusado`. The id is still generated and returned, so the
 * app's logs correlate.
 */
export async function validarPersonalToken(opts: OpcoesValidacaoLi): Promise<ValidacaoTokenLi> {
  const correlationId = (opts.gerarCorrelationId ?? (() => globalThis.crypto.randomUUID()))();
  const cliente = criarClienteLeituraLi({
    obterCredencial: () => ({ token: opts.token, ref: REF_CANDIDATO }),
    fetch: opts.fetch,
    gerarCorrelationId: () => correlationId,
    enviarCorrelationId: false,
  });

  try {
    const r = await cliente.get({
      operacao: 'validarPersonalToken',
      caminho: CAMINHO_VALIDACAO,
      query: { limit: 1 },
      // The rows do not matter: an empty store answers `objects: []`, and any
      // valid envelope proves the token was accepted.
      schema: liEnvelopeSchema(z.unknown()),
      sinal: opts.sinal,
    });
    return {
      veredito: 'aceito',
      status: r.status,
      motivo: 'A Loja Integrada aceitou o token.',
      correlationId,
    };
  } catch (err) {
    if (err instanceof LiAuthError) {
      return {
        veredito: 'recusado',
        status: err.status,
        motivo: `A Loja Integrada recusou o token (HTTP ${String(err.status)}).`,
        correlationId,
      };
    }
    if (err instanceof LiConfigError && err.motivo === 'token') {
      return {
        veredito: 'invalido',
        status: null,
        motivo:
          'O token está vazio ou tem caractere inválido (espaço, quebra de linha, caractere de controle ou acento). Nada foi enviado à Loja Integrada.',
        correlationId,
      };
    }
    // ⚠️ `'ref'` and `'token-na-url'` are ALSO the token's fault here, never a
    // programming error: the label (`REF_CANDIDATO`) and the URL
    // (`CAMINHO_VALIDACAO`, `limit=1`) are fixed, so the client refuses them only
    // when the candidate is short enough to fit INSIDE one of them. Any other
    // `LiConfigError` falls through and is rethrown.
    if (err instanceof LiConfigError && (err.motivo === 'ref' || err.motivo === 'token-na-url')) {
      return {
        veredito: 'invalido',
        status: null,
        motivo:
          'O token não parece um Personal Token: coincide com um trecho fixo da requisição de validação. Nada foi enviado à Loja Integrada.',
        correlationId,
      };
    }
    if (err instanceof LiHttpError) {
      return {
        veredito: 'inconclusivo',
        status: err.status,
        motivo: `A Loja Integrada respondeu HTTP ${String(err.status)}; não foi possível validar o token agora.`,
        correlationId,
      };
    }
    if (err instanceof LiSchemaError) {
      return {
        veredito: 'inconclusivo',
        status: err.status,
        motivo:
          'A Loja Integrada respondeu em um formato inesperado; não foi possível validar o token agora.',
        correlationId,
      };
    }
    if (err instanceof LiNetworkError) {
      return {
        veredito: 'inconclusivo',
        status: null,
        motivo:
          'Falha de rede ou tempo esgotado ao chamar a Loja Integrada; não foi possível validar o token agora.',
        correlationId,
      };
    }
    throw err;
  }
}
