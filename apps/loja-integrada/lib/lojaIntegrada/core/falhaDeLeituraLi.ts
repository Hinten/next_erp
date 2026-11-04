/**
 * The ONE read-failure mapper of the Loja Integrada read routes: what a failure of the context
 * loader (`core/contexto.ts`) or of a package read becomes in the route's answer, and the 401/403
 * park behind it.
 *
 * Every route that reads Loja Integrada through the context shares the class table below. Three
 * things differ between them — what a 404 MEANS, whether a 403 PARKS, and what a paging stop
 * means (only a read that pages can see one) — so each caller passes them in
 * ({@link PoliticaDeFalhaLi}) instead of keeping a copy of the mapper. The paid re-check
 * (`pedidos/conferenciaPagamento.ts`, step 15) is the first caller: for it a 404 is an order the
 * store no longer has (pointing at the credential), a 403 parks like a 401, and its one read
 * never pages, so it names no paging answer.
 *
 * ## The classes (root rule 6)
 *
 * Each class is narrowed to its own code, and anything else answers `null` — not this mapper's
 * to answer, so the caller rethrows it (a 500). `LiTimeoutError` BEFORE `LiNetworkError`, its
 * parent; the `LiHttpError` subclasses before `LiHttpError`; never the `LiError` base, so our own
 * misconfiguration (`LiConfigError`) stays loud.
 *
 * | What failed | Answer | Class |
 * | --- | --- | --- |
 * | the switch, the conta, its credential, a park (`core/erros.ts`) | the app error itself, for the shared envelope mapper (`respond.ts`) | configuration |
 * | the park losing its precondition | `LiEstacionamentoEmConflitoError` | transient |
 * | 429 | 503 `limiteDeChamadas` (no retry here) | transient |
 * | the deadline | 504 `tempoEsgotadoLoja` | transient |
 * | the network, a 5xx, a body off the schema | 502 `lojaIndisponivel` | transient |
 * | 404 | the caller's answer, or `null` when a 404 is not the caller's to answer | the caller's |
 * | 401 | `null` from the pure mapper: the park answers it ({@link tratarFalhaDeLeituraLi}) | — |
 * | 403 | the same as a 401 when the caller parks on it; otherwise the caller's answer, and nothing is parked | the caller's |
 * | a paging stop (`LiPaginacaoError`) | the caller's answer for that motivo; `null` when the caller names none (a read that never pages) | the caller's |
 * | anything else: a 3xx, a 400, `LiConfigError`, a Firestore failure | `null` (rethrown by the caller) | — |
 *
 * Every message here is a fixed pt-BR sentence: never a path, an id, a correlation id or a body.
 *
 * ## The park
 *
 * {@link tratarFalhaDeLeituraLi} is the whole decision: a refusal the caller parks on goes through
 * `tratarFalhaDeAutenticacao` (`core/estacionamento.ts`, the step-2 park: a tier-1 precondition
 * write on the credential, with the reconexão aviso) and is answered as the park found it;
 * everything else goes through the pure {@link mapearFalhaDeLeituraLi}. A 401 always parks: it
 * says the token itself is refused. A 403 parks only when the caller says the path it read is
 * one the token itself must reach.
 *
 * It sees the conta's id and record ({@link ContaDaFalhaLi}), never the context's client:
 * answering a failure never reads Loja Integrada again. A "confirming" read here would be a
 * second paced read behind every caller's back (`prazos.test.ts` counts this file's reads at 0).
 *
 * ⚠️ This module must never name the Admin SDK's multi-document read-and-write call — not even in
 * a comment (`firestore-transaction-inventory.test.js`). No process environment, no clock of its
 * own: the caller's deps carry them.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  LiAuthError,
  LiHttpError,
  LiNetworkError,
  LiNotFoundError,
  LiPaginacaoError,
  LiSchemaError,
  LiThrottleError,
  LiTimeoutError,
  type MotivoPaginacaoLi,
} from '@delfrance/integrations-loja-integrada';
import { CODIGO_ERRO_LI, type CodigoErroLi } from '@delfrance/schemas';

import type { ContextoLojaIntegrada } from './contexto';
import {
  LiAppError,
  LiContaParadaError,
  LiCredencialAlteradaError,
  LiCredencialAusenteError,
  LiEstacionamentoEmConflitoError,
} from './erros';
import { type TratarFalhaDeps, tratarFalhaDeAutenticacao } from './estacionamento';

/** How a failure weighs on the caller: the paid re-check reads its mirror on all but one. */
export type ClasseFalhaDeLeituraLi =
  /** The read could not run, and retrying will not change that: the conta, its credential. */
  | 'configuracao'
  /** The read could not run this time: a throttle, a timeout, an outage, contention. */
  | 'transitorio'
  /** The read ran and points at a problem with what was asked for: a refusal, never a retry. */
  | 'nao-autorizado';

/** An app error (`core/erros.ts`), answered by the shared envelope mapper (`respond.ts`). */
export interface FalhaDaContaLi {
  readonly tipo: 'conta';
  readonly classe: ClasseFalhaDeLeituraLi;
  readonly erro: LiAppError;
}

/** A failure of Loja Integrada's read, answered with the route's own code. */
export interface FalhaDaLojaLi {
  readonly tipo: 'loja';
  readonly classe: ClasseFalhaDeLeituraLi;
  readonly status: number;
  readonly code: CodigoErroLi;
  /** A fixed pt-BR sentence: never a path, an id, a numero or a body. */
  readonly mensagem: string;
}

/** Why a read gave no answer. */
export type FalhaDeLeituraLi = FalhaDaContaLi | FalhaDaLojaLi;

/** A route-coded failure. */
export function falhaDaLojaLi(
  classe: ClasseFalhaDeLeituraLi,
  status: number,
  code: CodigoErroLi,
  mensagem: string,
): FalhaDaLojaLi {
  return { tipo: 'loja', classe, status, code, mensagem };
}

/** The choices that are the caller's (module header). */
export interface PoliticaDeFalhaLi {
  /**
   * What a 404 means for this read: the caller's answer, or `null` when a 404 is not this
   * read's to answer — a refusal of OUR request, rethrown (a 500) so it stays loud.
   */
  readonly ausente: FalhaDaLojaLi | null;
  /**
   * A 403: `'estacionar'` parks the conta exactly as a 401 does (a path the token itself must
   * reach); otherwise this answer, and NOTHING is parked — a resource the token may not read
   * says nothing about the token.
   */
  readonly proibido: 'estacionar' | FalhaDaLojaLi;
  /**
   * A paging stop (`LiPaginacaoError`, the package's refusal to truncate), per motivo: the
   * caller's answer, or `null` for a motivo that is not its to answer (rethrown, a 500). Left out
   * by a caller whose read never pages: a paging stop is then not its to answer either.
   */
  readonly paginacao?: Readonly<Record<MotivoPaginacaoLi, FalhaDaLojaLi | null>>;
}

/**
 * What the park reads of a context: the conta's id and record, never its client (module header,
 * "The park"). Callers pass their whole context; this type is what keeps the client out of reach.
 */
export type ContaDaFalhaLi = Pick<ContextoLojaIntegrada, 'integracaoId' | 'conta'>;

function daConta(erro: LiAppError): FalhaDaContaLi {
  const classe = erro instanceof LiEstacionamentoEmConflitoError ? 'transitorio' : 'configuracao';
  return { tipo: 'conta', classe, erro };
}

/**
 * A failure of the context or of the read, as the caller answers it — or `null` for anything it
 * does not own, which the caller rethrows (module header). Pure: the park is decided before this
 * runs ({@link tratarFalhaDeLeituraLi}), so a refusal that parks answers `null` here.
 */
export function mapearFalhaDeLeituraLi(
  err: unknown,
  politica: PoliticaDeFalhaLi,
): FalhaDeLeituraLi | null {
  if (err instanceof LiAppError) return daConta(err);
  // The `LiHttpError` subclasses BEFORE `LiHttpError` itself.
  if (err instanceof LiAuthError) {
    return err.status === 403 && politica.proibido !== 'estacionar' ? politica.proibido : null;
  }
  if (err instanceof LiNotFoundError) return politica.ausente;
  if (err instanceof LiThrottleError) {
    return falhaDaLojaLi(
      'transitorio',
      503,
      CODIGO_ERRO_LI.limiteDeChamadas,
      'A Loja Integrada limitou as chamadas desta conta. Tente de novo em instantes.',
    );
  }
  if (err instanceof LiHttpError) {
    // A 5xx (Loja Integrada's 52x included) is an outage; any other status is a refusal of OUR
    // request, which must stay loud.
    return err.transitorio
      ? falhaDaLojaLi(
          'transitorio',
          502,
          CODIGO_ERRO_LI.lojaIndisponivel,
          'A Loja Integrada está indisponível. Tente de novo em instantes.',
        )
      : null;
  }
  // The deadline BEFORE the network: a `LiTimeoutError` is a `LiNetworkError` too.
  if (err instanceof LiTimeoutError) {
    return falhaDaLojaLi(
      'transitorio',
      504,
      CODIGO_ERRO_LI.tempoEsgotadoLoja,
      'A Loja Integrada não respondeu a tempo. Tente de novo em instantes.',
    );
  }
  if (err instanceof LiNetworkError) {
    return falhaDaLojaLi(
      'transitorio',
      502,
      CODIGO_ERRO_LI.lojaIndisponivel,
      'Não foi possível falar com a Loja Integrada. Tente de novo em instantes.',
    );
  }
  if (err instanceof LiSchemaError) {
    return falhaDaLojaLi(
      'transitorio',
      502,
      CODIGO_ERRO_LI.lojaIndisponivel,
      'A Loja Integrada respondeu fora do formato esperado. Tente de novo em instantes.',
    );
  }
  // A paging stop is the caller's, motivo by motivo; a caller that names none never pages.
  if (err instanceof LiPaginacaoError) return politica.paginacao?.[err.motivo] ?? null;
  return null;
}

/**
 * Why the read gave no answer: the mapper's own failure, or an error it does not own — which the
 * caller rethrows UNCHANGED (the same object).
 */
export type SemRespostaLi =
  | { readonly tipo: 'propria'; readonly falha: FalhaDeLeituraLi }
  | { readonly tipo: 'alheia'; readonly erro: unknown };

/** What the park needs: the credential's Firestore, its clock, the aviso's increment and logger. */
export interface TratarFalhaDeLeituraDeps extends TratarFalhaDeps {
  readonly db: Firestore;
}

function propria(falha: FalhaDeLeituraLi): SemRespostaLi {
  return { tipo: 'propria', falha };
}

/** Does this refusal park the conta, for this caller? A 401 always; a 403 when the caller says. */
function estacionaNaRecusa(err: LiAuthError, politica: PoliticaDeFalhaLi): boolean {
  return err.status !== 403 || politica.proibido === 'estacionar';
}

/**
 * A refusal that parks: park the conta (or find it parked), then answer as the park found it —
 * the conta's own app errors, so the shared envelope mapper answers them.
 *
 * - parked now, or already ⇒ `LiContaParadaError` (409 `reconexaoPendente`);
 * - the refused token is no longer the stored one (saved meanwhile) ⇒ `LiCredencialAlteradaError`
 *   (409 `credencialAlterada`: a retry runs with the new one), and nothing is parked;
 * - no credential any more ⇒ `LiCredencialAusenteError`;
 * - a corrupt credential, or the park's own contention, ⇒ that app error;
 * - the park failing on its own (a Firestore error) ⇒ that error, the caller's to rethrow;
 * - an error carrying no usable ref (unreachable: the package builds it from a request) ⇒ the
 *   refusal itself, the caller's to rethrow.
 */
async function semRespostaDaRecusa(
  deps: TratarFalhaDeLeituraDeps,
  err: LiAuthError,
  contexto: ContaDaFalhaLi,
): Promise<SemRespostaLi> {
  const { integracaoId, conta } = contexto;
  let tratamento: Awaited<ReturnType<typeof tratarFalhaDeAutenticacao>>;
  try {
    tratamento = await tratarFalhaDeAutenticacao(
      deps.db,
      { integracaoId, lojaNome: conta.nome === '' ? integracaoId : conta.nome },
      err,
      deps,
    );
  } catch (falha) {
    if (falha instanceof LiAppError) return propria(daConta(falha));
    // Anything else is the caller's to rethrow.
    return { tipo: 'alheia', erro: falha };
  }
  const r = tratamento.estacionamento;
  if (r === null) return { tipo: 'alheia', erro: err };
  switch (r.tipo) {
    case 'estacionado':
    case 'ja-estacionado':
      return propria(daConta(new LiContaParadaError(integracaoId, r.status, r.desdeMs)));
    case 'credencial-substituida':
      return propria(daConta(new LiCredencialAlteradaError(integracaoId)));
    case 'sem-credencial':
      return propria(daConta(new LiCredencialAusenteError(integracaoId)));
  }
}

/**
 * The whole decision for a failed context load or read (module header): a refusal this caller
 * parks on is parked first and answered as the park found it; anything else is
 * {@link mapearFalhaDeLeituraLi}'s, with an error it does not own handed back unchanged.
 *
 * `contexto` is `null` when the failure came before a context existed: nothing can be parked
 * without one, so the pure mapper answers. Of a context it sees the conta only
 * ({@link ContaDaFalhaLi}), never the client.
 */
export async function tratarFalhaDeLeituraLi(
  deps: TratarFalhaDeLeituraDeps,
  err: unknown,
  contexto: ContaDaFalhaLi | null,
  politica: PoliticaDeFalhaLi,
): Promise<SemRespostaLi> {
  if (err instanceof LiAuthError && contexto !== null && estacionaNaRecusa(err, politica)) {
    return semRespostaDaRecusa(deps, err, contexto);
  }
  const falha = mapearFalhaDeLeituraLi(err, politica);
  return falha === null ? { tipo: 'alheia', erro: err } : propria(falha);
}
