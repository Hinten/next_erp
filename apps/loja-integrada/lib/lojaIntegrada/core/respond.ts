/**
 * Map this app's own errors (`erros.ts`) to HTTP answers, in the repo's error
 * envelope `{ error, code, issues? }`. In a route's catch, narrow with
 * {@link isLiAppError} (it only tests the error) and pass the match here; the
 * route rethrows anything else, so an unrelated failure surfaces as a 500
 * instead of being swallowed (root `CLAUDE.md` rule 6).
 *
 * ⚠️ The ONE module under `lib/lojaIntegrada/` that imports `next/server`, and
 * therefore the one module step 3's functions bundle must never reach. Nothing
 * else in this folder imports it.
 *
 * ⚠️ `issues` carries field PATHS only. No envelope built here carries a token,
 * a fingerprint, a ref or a body: every message comes from `erros.ts`, which
 * builds them from the conta id and paths.
 */
import { NextResponse } from 'next/server';
import { CODIGO_ERRO_LI, type CodigoErroLi } from '@delfrance/schemas';

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
