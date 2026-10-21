/**
 * The PARK: Login with Amazon refused the conta's CURRENT refresh token, so the
 * conta's flows stop until an operator reconnects it, and the operator is told.
 * Plus the one table that decides which refusals park at all.
 *
 * ## What parks (step-2 plan §3 decision 11) — {@link classificarFalhaAmazon}
 *
 * | destino | operacao | codigoLwa / status | → |
 * | --- | --- | --- | --- |
 * | `lwa` | `trocarRefreshToken` | `invalid_grant` | `estacionar` |
 * | `lwa` | `trocarRefreshToken` | `null` and 401/403 | `estacionar` |
 * | `lwa` | any | `invalid_client`, `unauthorized_client` | `segredo-recusado` (never parks) |
 * | `lwa` | `trocarCodigoAutorizacao` | anything else | `nenhuma` (the callback maps it to a slug) |
 * | `sp-api` | any | 401/403 | `renovar-acesso` (step 3 retries once with `forcarRenovacao`; never parks) |
 * | anything else | | | `nenhuma` |
 *
 * ⚠️ A guess until the window: what a REVOKED refresh token answers is
 * undocumented, so this table is pinned row by row and amended at W5 as a
 * one-row change. An app-secret refusal never parks: it would stop every conta
 * for a fault no reconnect fixes; it raises `amazonSegredoLwaRecusado` instead.
 *
 * ## A tier-1 precondition write — {@link estacionarConta}
 *
 * One document, one decision (root rule 7): read the credential, decide, then
 * `update({ reconexaoPendente }, { lastUpdateTime })`.
 *
 *  - `FAILED_PRECONDITION` (9): something wrote the credential after our read —
 *    a consent, an access-token persist, another park — OR removed it (the SDK
 *    sends only the update-time precondition, so a missing document fails the
 *    stamp). RE-READ and RE-DECIDE; the losing patch is never re-applied. After
 *    a removal the next attempt sees no document and writes nothing — an
 *    `update` never resurrects one.
 *  - `NOT_FOUND` (5): handled the same, so the outcome does not hinge on which
 *    code the server picks.
 *  - At most {@link MAX_TENTATIVAS_ESTACIONAMENTO} attempts, then
 *    `EstacionamentoAmazonEmConflitoError`. Hourly access-token persists can
 *    cost an attempt; the bound absorbs that.
 *
 * ## The guard is an IDENTITY, never a clock
 *
 * The park writes only when the refused request's ref equals the ref
 * re-derived from THIS attempt's read (`refDaCredencial`: the stored
 * `refresh_token` + `autorizadoEmMs`). A refusal of a grant a consent has since
 * replaced carries an older ref and parks nothing. `REF_CONSENTIMENTO` can never
 * equal a versioned ref.
 *
 * ⚠️ This module must never name the multi-document atomic-write API of the
 * Admin SDK — not even in a comment: `firestore-transaction-inventory.test.js`
 * greps for that word.
 *
 * ## Callers
 *
 * The routes never import this module (`estrutura.test.ts` pins it). The first
 * caller is step 3's intake classifier, through {@link tratarFalhaDeAutenticacao}.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import type { ResultadoAviso } from '@delfrance/data/admin/avisos';
import type { AmazonAuthError } from '@delfrance/integrations-amazon-sp-api';
import { type CredenciaisAmazon, reconexaoPendenteAmazonSchema } from '@delfrance/schemas';

import {
  avisarReconexaoPendente,
  avisarSegredoLwaRecusado,
  relogioDoDocumentoUs,
} from '../avisos/avisos';
import { docCredencial, lerCredencial } from './credentialStore';
import { EstacionamentoAmazonEmConflitoError } from './erros';
import { refDaCredencial } from './refCredencial';

/** Read-decide-write attempts before giving up. */
export const MAX_TENTATIVAS_ESTACIONAMENTO = 3;

/** The package's operation names (`lwa.ts`). Pinned against the package by a test. */
export const OPERACAO_TROCA_REFRESH = 'trocarRefreshToken';
export const OPERACAO_TROCA_CODIGO = 'trocarCodigoAutorizacao';

/** What {@link classificarFalhaAmazon} decides. */
export type ClasseDeFalhaAmazon = 'estacionar' | 'segredo-recusado' | 'renovar-acesso' | 'nenhuma';

/** The LWA codes that refuse the APP, not the seller. */
const CODIGOS_DO_APLICATIVO: ReadonlySet<string> = new Set([
  'invalid_client',
  'unauthorized_client',
]);

/** Pure: the module header's table, row by row. */
export function classificarFalhaAmazon(err: AmazonAuthError): ClasseDeFalhaAmazon {
  if (err.destino === 'lwa') {
    if (err.codigoLwa !== null && CODIGOS_DO_APLICATIVO.has(err.codigoLwa)) {
      return 'segredo-recusado';
    }
    if (err.operacao === OPERACAO_TROCA_REFRESH) {
      if (err.codigoLwa === 'invalid_grant') return 'estacionar';
      if (err.codigoLwa === null && (err.status === 401 || err.status === 403)) {
        return 'estacionar';
      }
    }
    return 'nenhuma';
  }
  if (err.status === 401 || err.status === 403) return 'renovar-acesso';
  return 'nenhuma';
}

/** The refusal to park on: which credential was refused, and how. */
export interface FalhaDeAutenticacaoAmazon {
  /** The ref the refused request carried (`AmazonAuthError.refCredencial`). */
  readonly refCredencial: string;
  readonly status: number;
  readonly codigoLwa: string | null;
}

/** The park block a decision writes. */
export type ReconexaoPendenteAmazon = NonNullable<CredenciaisAmazon['reconexaoPendente']>;

export type DecisaoEstacionamento =
  /** No credential is stored: nothing to park. */
  | { readonly tipo: 'sem-credencial' }
  /** The refused grant is no longer the stored one. */
  | { readonly tipo: 'credencial-substituida' }
  /** Already parked: write nothing, keep its `desdeMs`. */
  | { readonly tipo: 'ja-estacionado'; readonly reconexaoPendente: ReconexaoPendenteAmazon }
  /** Park it with exactly this block. */
  | { readonly tipo: 'estacionar'; readonly reconexaoPendente: ReconexaoPendenteAmazon };

/**
 * Pure: what to do about a refusal, given the credential as stored NOW.
 * `agoraMs` becomes `desdeMs` — milliseconds, for display only, never compared.
 */
export function decidirEstacionamento(
  armazenada: CredenciaisAmazon | null,
  falha: FalhaDeAutenticacaoAmazon,
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
      codigoLwa: falha.codigoLwa,
      refCredencial: falha.refCredencial,
    },
  };
}

export type ResultadoEstacionamento =
  | { readonly tipo: 'sem-credencial' }
  | { readonly tipo: 'credencial-substituida' }
  /** Parked already; `relogioUs` is the document's current commit, the repeat raise's clock. */
  | {
      readonly tipo: 'ja-estacionado';
      readonly desdeMs: number;
      /** The STORED park's status and code — the first refusal's. */
      readonly status: number;
      readonly codigoLwa: string | null;
      readonly relogioUs: number;
    }
  /** Parked by THIS call; `relogioUs` is the µs of the park's own commit. */
  | {
      readonly tipo: 'estacionado';
      readonly desdeMs: number;
      readonly status: number;
      readonly codigoLwa: string | null;
      readonly relogioUs: number;
    };

export interface EstacionamentoDeps {
  /** Now, in MILLISECONDS — called once per attempt. */
  readonly agoraMs: () => number;
}

/**
 * Park the conta for this refusal, if it still applies (module header).
 *
 * @throws {CredencialAmazonInvalidaError} when the stored credential is corrupt.
 * @throws {EstacionamentoAmazonEmConflitoError} after
 *   {@link MAX_TENTATIVAS_ESTACIONAMENTO} lost preconditions.
 */
export async function estacionarConta(
  db: Firestore,
  integracaoId: string,
  falha: FalhaDeAutenticacaoAmazon,
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
        codigoLwa: decisao.reconexaoPendente.codigoLwa,
        relogioUs: lida.versaoUs,
      };
    }

    const reconexaoPendente = reconexaoPendenteAmazonSchema.parse(decisao.reconexaoPendente);
    try {
      // `update` replaces the whole `reconexaoPendente` map — intended: it is
      // null whenever we get here.
      const wr = await docCredencial(db, integracaoId).update(
        { reconexaoPendente },
        { lastUpdateTime: lida.updateTime },
      );
      return {
        tipo: 'estacionado',
        desdeMs: reconexaoPendente.desdeMs,
        status: reconexaoPendente.status,
        codigoLwa: reconexaoPendente.codigoLwa,
        relogioUs: relogioDoDocumentoUs(wr.writeTime),
      };
    } catch (err) {
      // Lost the race, or the document was removed (9, or 5 — header): loop,
      // re-read, re-decide. Never re-apply this patch.
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
  }
  throw new EstacionamentoAmazonEmConflitoError(integracaoId, MAX_TENTATIVAS_ESTACIONAMENTO);
}

export interface TratarFalhaDeps extends EstacionamentoDeps {
  /** `(by) => FieldValue.increment(by)`, for the avisos. */
  readonly increment: (by: number) => unknown;
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export interface ResultadoTratamento {
  readonly classe: ClasseDeFalhaAmazon;
  /** `null` when nothing was attempted (not a park, or no usable ref). */
  readonly estacionamento: ResultadoEstacionamento | null;
  /** The aviso raised, or `null` when none was. */
  readonly aviso: ResultadoAviso | null;
}

/**
 * What a flow does with an `AmazonAuthError`, by {@link classificarFalhaAmazon}:
 *
 *  - `estacionar` → park, then raise the reconexão aviso clocked by the
 *    credential document's commit time (the park's `writeTime`, or the stored
 *    document's for `ja-estacionado`, whose repeat is dropped unless the first
 *    raise never landed). `sem-credencial` / `credencial-substituida` raise
 *    nothing: the refused grant is gone.
 *  - `segredo-recusado` → raise `amazonSegredoLwaRecusado`; park nothing.
 *  - anything else → nothing.
 *
 * A `null` ref parks nothing (unreachable from the package, which builds every
 * `AmazonAuthError` from a request context; the type allows it). ⚠️ Its warning
 * names the conta, the status and the class only — never the ref, which carries
 * the refresh token's fingerprint.
 */
export async function tratarFalhaDeAutenticacao(
  db: Firestore,
  alvo: { readonly integracaoId: string; readonly contaNome: string },
  err: AmazonAuthError,
  deps: TratarFalhaDeps,
): Promise<ResultadoTratamento> {
  const classe = classificarFalhaAmazon(err);
  const avisoDeps = { increment: deps.increment, nowMs: deps.agoraMs(), logger: deps.logger };

  if (classe === 'segredo-recusado') {
    const { resultado } = await avisarSegredoLwaRecusado(
      db,
      { codigoLwa: err.codigoLwa ?? 'invalid_client' },
      avisoDeps,
    );
    return { classe, estacionamento: null, aviso: resultado };
  }
  if (classe !== 'estacionar') return { classe, estacionamento: null, aviso: null };

  if (err.refCredencial === null) {
    deps.logger?.warn('[amazon/estacionamento] recusa sem ref utilizável; nada estacionado', {
      integracaoId: alvo.integracaoId,
      status: err.status,
      classe,
    });
    return { classe, estacionamento: null, aviso: null };
  }

  const r = await estacionarConta(
    db,
    alvo.integracaoId,
    { refCredencial: err.refCredencial, status: err.status, codigoLwa: err.codigoLwa },
    deps,
  );
  if (r.tipo !== 'estacionado' && r.tipo !== 'ja-estacionado') {
    return { classe, estacionamento: r, aviso: null };
  }
  const { resultado } = await avisarReconexaoPendente(
    db,
    {
      integracaoId: alvo.integracaoId,
      lojaNome: alvo.contaNome,
      status: r.status,
      codigoLwa: r.codigoLwa,
      relogioUs: r.relogioUs,
    },
    avisoDeps,
  );
  return { classe, estacionamento: r, aviso: resultado };
}
