/**
 * The 401/403 PARK: Loja Integrada refused the stored token, so the conta's
 * flows stop until a valid token is saved, and the operator is told.
 *
 * ## A tier-1 precondition write, not a multi-document atomic one
 *
 * One document, one decision (root `CLAUDE.md` rule 7, the cheapest tier that
 * holds): read the credential, decide, then `update(patch, { lastUpdateTime })`.
 *
 *  - `FAILED_PRECONDITION` (9): something wrote the credential after our read —
 *    a save, a renewal, another park. RE-READ and RE-DECIDE; the patch that
 *    lost is never re-applied, because every value in the next patch is
 *    derived from the next read.
 *  - `NOT_FOUND` (5): the credential was removed after our read. Re-read too:
 *    the next attempt sees no document and answers `sem-credencial` with no
 *    write — an `update` can never resurrect the document.
 *  - At most {@link MAX_TENTATIVAS_ESTACIONAMENTO} attempts, then
 *    {@link LiEstacionamentoEmConflitoError}: persistent contention on one
 *    document is a problem to surface, and the step-3 task retries.
 *
 * ⚠️ This module must never name the multi-document atomic-write API of the
 * Admin SDK — not even in a comment. `firestore-transaction-inventory.test.js`
 * greps every non-test source file for that word and would demand an inventory
 * class for a site that does not exist.
 *
 * ## The guard is an IDENTITY, never a clock
 *
 * The park writes only when the refused request's ref equals the ref
 * re-derived from THIS attempt's read — `refDaCredencial(stored)`, built from the
 * stored `personalToken` and `tokenAtualizadoEmMs`, never the stored
 * fingerprint field. A 401 that belonged to a token since replaced, or to the
 * same token since re-saved, carries an older ref and parks nothing. No clock
 * is compared, so the cross-unit trap of rule 7 cannot apply. The validator's
 * fixed `'candidato'` label can never equal a stored ref (16 hex characters, a
 * dot, digits).
 *
 * ## Callers
 *
 * None in step 2's production code: the routes never import this module (a
 * route test pins it). The first callers are step 3's poller and task, through
 * {@link tratarFalhaDeAutenticacao}.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { credenciaisLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import type { ResultadoAviso } from '@delfrance/data/admin/avisos';
import type { LiAuthError } from '@delfrance/integrations-loja-integrada';
import type { CredenciaisLojaIntegrada } from '@delfrance/schemas';

import { avisarReconexaoPendente, relogioDoDocumentoUs } from '../avisos/avisos';
import { refDaCredencial } from './credencial';
import { docCredencial, lerCredencial } from './credentialStore';
import { LiEstacionamentoEmConflitoError } from './erros';

/** Read-decide-write attempts before giving up. */
export const MAX_TENTATIVAS_ESTACIONAMENTO = 3;

/** The refusal to park on: which credential was refused, and how. */
export interface FalhaDeAutenticacaoLi {
  /** The ref the refused request carried (`LiAuthError.refCredencial`). */
  readonly refCredencial: string;
  readonly status: 401 | 403;
}

/** The park block a decision writes. */
export type ReconexaoPendenteLi = NonNullable<CredenciaisLojaIntegrada['reconexaoPendente']>;

export type DecisaoEstacionamento =
  /** No credential is stored: nothing to park. */
  | { readonly tipo: 'sem-credencial' }
  /** The refused credential is no longer the stored one (replaced or re-saved). */
  | { readonly tipo: 'credencial-substituida' }
  /** The stored credential is already parked: write nothing, keep its `desdeMs`. */
  | { readonly tipo: 'ja-estacionado'; readonly reconexaoPendente: ReconexaoPendenteLi }
  /** Park it with exactly this block. */
  | { readonly tipo: 'estacionar'; readonly reconexaoPendente: ReconexaoPendenteLi };

/**
 * Pure: what to do about a refusal, given the credential as stored NOW.
 *
 * `agoraMs` becomes `desdeMs` — milliseconds, for display only, never compared.
 */
export function decidirEstacionamento(
  armazenada: CredenciaisLojaIntegrada | null,
  falha: FalhaDeAutenticacaoLi,
  agoraMs: number,
): DecisaoEstacionamento {
  if (armazenada === null) return { tipo: 'sem-credencial' };
  if (refDaCredencial(armazenada) !== falha.refCredencial) {
    return { tipo: 'credencial-substituida' };
  }
  if (armazenada.reconexaoPendente !== null) {
    return { tipo: 'ja-estacionado', reconexaoPendente: armazenada.reconexaoPendente };
  }
  return {
    tipo: 'estacionar',
    reconexaoPendente: {
      desdeMs: agoraMs,
      status: falha.status,
      refCredencial: falha.refCredencial,
    },
  };
}

export type ResultadoEstacionamento =
  | { readonly tipo: 'sem-credencial' }
  | { readonly tipo: 'credencial-substituida' }
  /**
   * Parked already. `relogioUs` is the µs of the document's current commit —
   * the clock a repeat aviso raise carries, so a repeat of an aviso that did
   * land is dropped, and one whose first raise was lost is created.
   */
  | {
      readonly tipo: 'ja-estacionado';
      readonly desdeMs: number;
      /** The STORED park's status — the first refusal's, not this one's. */
      readonly status: 401 | 403;
      readonly relogioUs: number;
    }
  /** Parked by THIS call; `relogioUs` is the µs of the park's own commit. */
  | {
      readonly tipo: 'estacionado';
      readonly desdeMs: number;
      readonly status: 401 | 403;
      readonly relogioUs: number;
    };

export interface EstacionamentoDeps {
  /** Now, in MILLISECONDS — called once per attempt. */
  readonly agoraMs: () => number;
}

/**
 * Park the conta for this refusal, if it still applies (module header).
 *
 * @throws {LiCredencialInvalidaError} when the stored credential is corrupt.
 * @throws {LiEstacionamentoEmConflitoError} after
 *   {@link MAX_TENTATIVAS_ESTACIONAMENTO} lost preconditions.
 */
export async function estacionarConta(
  db: Firestore,
  integracaoId: string,
  falha: FalhaDeAutenticacaoLi,
  deps: EstacionamentoDeps,
): Promise<ResultadoEstacionamento> {
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_ESTACIONAMENTO; tentativa += 1) {
    // Every decision below is derived from THIS attempt's read.
    const lida = await lerCredencial(db, integracaoId);
    const decisao = decidirEstacionamento(lida?.credencial ?? null, falha, deps.agoraMs());

    if (lida === null || decisao.tipo === 'sem-credencial') return { tipo: 'sem-credencial' };
    if (decisao.tipo === 'credencial-substituida') return { tipo: 'credencial-substituida' };
    if (decisao.tipo === 'ja-estacionado') {
      return {
        tipo: 'ja-estacionado',
        desdeMs: decisao.reconexaoPendente.desdeMs,
        status: decisao.reconexaoPendente.status,
        relogioUs: lida.versaoUs,
      };
    }

    const patch = credenciaisLojaIntegradaCollection.parseMerge({
      reconexaoPendente: decisao.reconexaoPendente,
    });
    try {
      // `update` replaces the whole `reconexaoPendente` map — intended: it is
      // null whenever we get here.
      const wr = await docCredencial(db, integracaoId).update(patch, {
        lastUpdateTime: lida.updateTime,
      });
      return {
        tipo: 'estacionado',
        desdeMs: decisao.reconexaoPendente.desdeMs,
        status: decisao.reconexaoPendente.status,
        relogioUs: relogioDoDocumentoUs(wr.writeTime),
      };
    } catch (err) {
      // Lost the race (9) or the document was removed (5): loop, re-read,
      // re-decide. Never re-apply this patch.
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
  }
  throw new LiEstacionamentoEmConflitoError(integracaoId, MAX_TENTATIVAS_ESTACIONAMENTO);
}

export interface TratarFalhaDeps extends EstacionamentoDeps {
  /** `(by) => FieldValue.increment(by)`, for the aviso. */
  readonly increment: (by: number) => unknown;
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export interface ResultadoTratamento {
  /** `null` when the error carried no ref and nothing was attempted. */
  readonly estacionamento: ResultadoEstacionamento | null;
  /** The reconexão aviso's outcome, or `null` when none was raised. */
  readonly aviso: ResultadoAviso | null;
}

function statusDeAutenticacao(status: number): 401 | 403 | null {
  if (status === 401) return 401;
  if (status === 403) return 403;
  return null;
}

/**
 * What a flow does with a `LiAuthError`: park the conta, then raise the
 * reconexão aviso clocked by the credential document's commit time.
 *
 * - A `null` ref (unreachable at runtime: the package builds `LiAuthError` from
 *   a request context whose ref is a string — the branch exists because the
 *   inherited type allows it) warns and parks nothing.
 * - `estacionado` and `ja-estacionado` raise the aviso; the second one's
 *   repeat is dropped by the clock unless the first raise never landed.
 * - `sem-credencial` / `credencial-substituida` raise nothing: the refused token
 *   is gone, and a newer save already resolved the aviso.
 *
 * ⚠️ The warning names the conta and the status only — never the ref, which
 * carries the token's fingerprint.
 */
export async function tratarFalhaDeAutenticacao(
  db: Firestore,
  alvo: { readonly integracaoId: string; readonly lojaNome: string },
  err: LiAuthError,
  deps: TratarFalhaDeps,
): Promise<ResultadoTratamento> {
  const status = statusDeAutenticacao(err.status);
  if (err.refCredencial === null || status === null) {
    deps.logger?.warn(
      '[loja-integrada/estacionamento] recusa sem ref utilizável; nada estacionado',
      {
        integracaoId: alvo.integracaoId,
        status: err.status,
      },
    );
    return { estacionamento: null, aviso: null };
  }

  const r = await estacionarConta(
    db,
    alvo.integracaoId,
    { refCredencial: err.refCredencial, status },
    deps,
  );
  if (r.tipo !== 'estacionado' && r.tipo !== 'ja-estacionado') {
    return { estacionamento: r, aviso: null };
  }
  const { resultado } = await avisarReconexaoPendente(
    db,
    {
      integracaoId: alvo.integracaoId,
      lojaNome: alvo.lojaNome,
      status: r.status,
      relogioUs: r.relogioUs,
    },
    { increment: deps.increment, nowMs: deps.agoraMs(), logger: deps.logger },
  );
  return { estacionamento: r, aviso: resultado };
}
