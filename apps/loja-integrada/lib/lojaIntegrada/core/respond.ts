/**
 * Every HTTP answer the conta routes build, in the repo's error envelope
 * `{ error, code, issues? }` (`erroContaLojaIntegradaSchema` in
 * `@delfrance/schemas`, which the panel parses):
 *
 *  - this app's own errors (`erros.ts`): in a route's catch, narrow with
 *    {@link isLiAppError} (it only tests the error) and pass the match to
 *    {@link respostaDeErroLi}; the route rethrows anything else, so an
 *    unrelated failure surfaces as a 500 instead of being swallowed (root
 *    `CLAUDE.md` rule 6);
 *  - the request-level refusals the three routes share: a malformed id, a
 *    malformed body ({@link lerCorpoLi}), a refused expiry date, a validation
 *    verdict other than `aceito`, a token already stored on another conta, and
 *    a caller that went away (499).
 *
 * ⚠️ The ONE module under `lib/lojaIntegrada/` that imports `next/server`, and
 * therefore the one module step 3's functions bundle must never reach. Nothing
 * else in this folder imports it.
 *
 * ⚠️ `issues` carries field PATHS only. No envelope built here carries a token,
 * a fingerprint, a ref or a body: every sentence is a literal here, comes from
 * `erros.ts` (built from the conta id and paths) or `conta/validade.ts` (an
 * already-validated civil date at most), or is a validation verdict's `motivo`,
 * which the package builds without the token or any body text.
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { camposInvalidos, resumirCampos } from '@delfrance/core/wire';
import type { ValidacaoTokenLi } from '@delfrance/integrations-loja-integrada';
import { CODIGO_ERRO_LI, type CodigoErroLi } from '@delfrance/schemas';

import type { ValidadeRecusada } from '../conta/validade';

import {
  LiAppError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAlteradaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiEstacionamentoEmConflitoError,
} from './erros';

/** Every app error has a mapping; a new subclass must be added below. */
export function isLiAppError(err: unknown): err is LiAppError {
  return err instanceof LiAppError;
}

interface Mapeamento {
  readonly status: number;
  readonly code: CodigoErroLi;
  readonly issues?: readonly string[];
}

function mapear(err: LiAppError): Mapeamento {
  if (err instanceof LiContaNaoEncontradaError) {
    return { status: 404, code: CODIGO_ERRO_LI.contaNaoEncontrada };
  }
  if (err instanceof LiContaInativaError) {
    return { status: 409, code: CODIGO_ERRO_LI.contaInativa };
  }
  if (err instanceof LiCredencialAusenteError) {
    return { status: 409, code: CODIGO_ERRO_LI.credencialAusente };
  }
  if (err instanceof LiCredencialInvalidaError) {
    return { status: 409, code: CODIGO_ERRO_LI.credencialInvalida, issues: err.campos };
  }
  if (err instanceof LiCredencialAlteradaError) {
    return { status: 409, code: CODIGO_ERRO_LI.credencialAlterada };
  }
  if (err instanceof LiContaParadaError) {
    return { status: 409, code: CODIGO_ERRO_LI.reconexaoPendente };
  }
  if (err instanceof LiEstacionamentoEmConflitoError) {
    // Transient by definition: three writers in a row won the same document.
    return { status: 503, code: CODIGO_ERRO_LI.estacionamentoEmConflito };
  }
  // A subclass nobody mapped is a bug in THIS file, not a client error.
  throw new TypeError(`respond.ts: ${err.name} não tem mapeamento HTTP`);
}

export function respostaDeErroLi(err: LiAppError): NextResponse {
  const m = mapear(err);
  return NextResponse.json(
    {
      error: err.message,
      code: m.code,
      ...(m.issues === undefined ? {} : { issues: [...m.issues] }),
    },
    { status: m.status },
  );
}

/* -------------------------------------------------------------------------- */
/*                 The request-level answers the routes share                  */
/* -------------------------------------------------------------------------- */

/** The optional fields of the envelope, beyond `error` and `code`. */
export interface ExtrasDoEnvelopeLi {
  /** Field PATHS only. */
  readonly issues?: readonly string[];
  /** The HTTP status Loja Integrada answered a validation with, if any. */
  readonly status?: number | null;
  /** The validation call's correlation id. */
  readonly correlationId?: string;
}

/** One envelope. Every refusal below goes through here. */
export function respostaLi(
  httpStatus: number,
  code: CodigoErroLi,
  error: string,
  extras: ExtrasDoEnvelopeLi = {},
): NextResponse {
  return NextResponse.json(
    {
      error,
      code,
      ...(extras.issues === undefined ? {} : { issues: [...extras.issues] }),
      ...(extras.status === undefined ? {} : { status: extras.status }),
      ...(extras.correlationId === undefined ? {} : { correlationId: extras.correlationId }),
    },
    { status: httpStatus },
  );
}

/** 400 — the `[id]` segment cannot be a conta id (`naoEhIdDeConta`). */
export function respostaIdInvalido(): NextResponse {
  return respostaLi(400, CODIGO_ERRO_LI.idInvalido, 'Id de conta inválido.');
}

/** A body read: the parsed value, or the 400 to answer with. */
export type CorpoLidoLi<T> =
  | { readonly ok: true; readonly dados: T }
  | { readonly ok: false; readonly resposta: NextResponse };

/** The fixed sentence of a body that is not JSON at all. */
export const MENSAGEM_CORPO_NAO_JSON = 'O corpo da requisição não é um JSON válido.';

/**
 * Read the JSON body and parse it with `schema`.
 *
 * ⚠️ **A malformed body answers a FIXED sentence, and `err` is never logged nor
 * returned.** V8's `SyntaxError` message QUOTES a slice of the text it could
 * not parse, and on the save route that text is the Personal Token. So the
 * catch narrows on `SyntaxError` (rule 6) and throws its message away; anything
 * else — a body already consumed, a stream that failed — is rethrown.
 *
 * A body of the wrong shape is a 400 with the offending field PATHS
 * (`camposInvalidos`), never a value and never Zod's message.
 */
export async function lerCorpoLi<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<CorpoLidoLi<z.output<S>>> {
  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return {
      ok: false,
      resposta: respostaLi(400, CODIGO_ERRO_LI.corpoInvalido, MENSAGEM_CORPO_NAO_JSON),
    };
  }
  const r = schema.safeParse(bruto);
  if (!r.success) {
    const campos = camposInvalidos(r.error.issues);
    return {
      ok: false,
      resposta: respostaLi(
        400,
        CODIGO_ERRO_LI.corpoInvalido,
        `Corpo da requisição inválido (campos: ${resumirCampos(campos)}).`,
        { issues: campos },
      ),
    };
  }
  return { ok: true, dados: r.data };
}

/** 422 — the expiry date is malformed, past or too far; `issues` points at the field. */
export function respostaValidadeRecusada(v: ValidadeRecusada): NextResponse {
  return respostaLi(422, v.code, v.motivo, { issues: ['expiraEm'] });
}

/**
 * The answer to a validation verdict other than `aceito`. Nothing was stored.
 *
 * | verdict | HTTP | code |
 * | --- | --- | --- |
 * | `recusado` (401/403) | 422 | `LI_TOKEN_RECUSADO` |
 * | `invalido` (never sent) | 422 | `LI_TOKEN_INVALIDO` |
 * | `inconclusivo` | 502 | `LI_VALIDACAO_INCONCLUSIVA` |
 *
 * `error` is the verdict's `motivo`, which the package builds without the token
 * or any body text; `status` and `correlationId` ride along for support.
 */
export function respostaDeVeredito(v: ValidacaoTokenLi): NextResponse {
  const extras = { status: v.status, correlationId: v.correlationId };
  switch (v.veredito) {
    case 'recusado':
      return respostaLi(422, CODIGO_ERRO_LI.tokenRecusado, v.motivo, extras);
    case 'invalido':
      return respostaLi(422, CODIGO_ERRO_LI.tokenInvalido, v.motivo, extras);
    case 'inconclusivo':
      return respostaLi(502, CODIGO_ERRO_LI.validacaoInconclusiva, v.motivo, extras);
    case 'aceito':
      // An accepted token is stored, never answered as a refusal.
      throw new TypeError('respostaDeVeredito: o veredito aceito não é uma recusa');
  }
}

/**
 * 422 `LI_TOKEN_INVALIDO` — the token is short enough to appear inside its own
 * versioned ref, which the package would refuse on EVERY request made with it
 * (`LiConfigError('ref')`). Checked before any call, so nothing was sent.
 */
export function respostaTokenNaRef(): NextResponse {
  return respostaLi(
    422,
    CODIGO_ERRO_LI.tokenInvalido,
    'O token é curto demais para ser um Personal Token. Nada foi enviado à Loja Integrada.',
  );
}

/** 409 — the same token is already stored on another Loja Integrada conta. */
export function respostaTokenDeOutraConta(): NextResponse {
  return respostaLi(
    409,
    CODIGO_ERRO_LI.tokenDeOutraConta,
    'Este token já está salvo em outra conta da Loja Integrada (ativa ou inativa). ' +
      'Cada conta usa o token da sua própria loja.',
  );
}

/**
 * The caller went away while its token was being validated: 499 with an EMPTY
 * body (nobody is listening). Nothing was stored — the abort can only land
 * inside the validation call, before any write.
 */
export function respostaCancelada(): NextResponse {
  return new NextResponse(null, { status: 499 });
}
