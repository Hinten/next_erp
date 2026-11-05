/**
 * The product import's START core (master plan step 9): what `POST …/conta/[id]/importacoes`
 * does once the caller, the conta id and the body are checked. It creates the job document
 * `pendente` and nothing else: the first dispatch is enqueued by the job-creation trigger in the
 * functions codebase, so this backend never touches Cloud Tasks for the import.
 *
 * ## The order — the read switch FIRST; nothing is read before it
 *
 *  1. the context loader (`core/contexto.ts`), whose first act is the read switch: while
 *     `LOJA_INTEGRADA_CHAMADAS` is not exactly `on` (everywhere until the migration window, D17) it
 *     refuses with ZERO Firestore reads and ZERO calls, so not even a job is created — an import
 *     cannot run, not even as a simulation, before the window. Then the conta (refused when gone,
 *     not Loja Integrada or inactive) and ONE credential read (refused when absent, corrupt or
 *     parked). The context's client is never used: this core makes NO Loja Integrada call;
 *  2. the guard: the conta's newest jobs through the one declared index (`job.ts`); a job still
 *     `pendente` or `executando` ⇒ `em-andamento` with its id, and nothing is written;
 *  3. the create, at an AUTO id (root rule 7, tier 0: no two creates can collide), parsed whole
 *     through the job schema — every cursor, map and counter at its default, `seq: 0`, `fase:
 *     catalogo`, `status: pendente`.
 *
 * The context loader's refusals (`LiAppError` subclasses) propagate untouched: the route answers
 * them with the conta routes' shared mapper. Anything else — Firestore, a coding bug — propagates
 * too (root rule 6).
 *
 * ⚠️ Two starts in the same instant can both pass the guard: there is no lock. Every write of the
 * job is idempotent, so the second run redoes work and changes nothing; the web disables its button
 * while a start is in flight. The accepted residual of `job.ts`'s table.
 *
 * ⚠️ This module must never name the Admin SDK's multi-document read-and-write call — not even in a
 * comment (`estrutura.test.ts`). Next-free, `db` a parameter, no process environment: the route
 * passes it in (`deps.ambiente`). `prazos.test.ts` counts its context loads (ONE) and its package
 * reads (none).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { importacaoLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import {
  FASE_IMPORTACAO_LI,
  type OpcoesImportacaoLi,
  STATUS_IMPORTACAO_LI,
} from '@delfrance/schemas';

import { loadLojaIntegradaContext } from '../core/contexto';
import type { EscritorLogLi } from '../core/log';
import type { RitmoLi } from '../core/ritmo';
import type { AmbienteLi } from '../core/valvulas';
import { FLUXO_IMPORTACAO_LI, jobEmCursoDaContaLi } from './job';

export interface InicioImportacaoDeps {
  readonly db: Firestore;
  /** The process environment, from the route — read by the context loader for the switch only. */
  readonly ambiente: AmbienteLi;
  /** The pacer the context requires. Never spent: this core makes no Loja Integrada call. */
  readonly ritmo: RitmoLi;
  /** The job's start stamp, in ms. */
  readonly agoraMs: () => number;
  /** Test seam, forwarded to the context (and never reached: nothing is called). */
  readonly fetch?: typeof globalThis.fetch;
  /** Test sink for the switch's refusal line; production writes it to stdout. */
  readonly escrever?: EscritorLogLi;
}

/** Who started it. */
export interface QuemIniciaImportacaoLi {
  /** The caller's uid, stored as `iniciadoPor`. */
  readonly uid: string;
}

/** How a start ended (the context's refusals are thrown, not returned). */
export type ResultadoInicioImportacaoLi =
  /** The job was created `pendente`; the trigger enqueues its first dispatch. */
  | { readonly tipo: 'criado'; readonly jobId: string }
  /** The conta already has a running job (this one): nothing was written. */
  | { readonly tipo: 'em-andamento'; readonly jobId: string };

/**
 * Start a product import of `contaId` with `opcoes` (the strict start body, already parsed): the
 * switch and the conta first, then the guard, then the create (module header).
 *
 * @throws the context loader's `LiAppError` refusals (the switch, the conta, its credential).
 */
export async function iniciarImportacaoLi(
  deps: InicioImportacaoDeps,
  contaId: string,
  opcoes: OpcoesImportacaoLi,
  quem: QuemIniciaImportacaoLi,
): Promise<ResultadoInicioImportacaoLi> {
  const { db } = deps;
  // FIRST: the read switch, then the conta and its credential. Its client is never used.
  await loadLojaIntegradaContext(db, contaId, {
    ambiente: deps.ambiente,
    ritmo: deps.ritmo,
    registro: { fluxo: FLUXO_IMPORTACAO_LI, escrever: deps.escrever },
    fetch: deps.fetch,
  });

  const emCurso = await jobEmCursoDaContaLi(db, contaId);
  if (emCurso !== null) return { tipo: 'em-andamento', jobId: emCurso };

  const agora = deps.agoraMs();
  const jobId = importacaoLojaIntegradaCollection.newDocId(db, {});
  await importacaoLojaIntegradaCollection.docRef(db, {}, jobId).create(
    importacaoLojaIntegradaCollection.parse({
      integracaoId: contaId,
      iniciadoPor: quem.uid,
      iniciadoEmMs: agora,
      atualizadoEmMs: agora,
      concluidoEmMs: null,
      modo: opcoes.modo,
      alvo: opcoes.alvo,
      acao: opcoes.acao,
      categorias: opcoes.categorias,
      fotos: opcoes.fotos,
      selecionados: opcoes.selecionados,
      simulacaoId: opcoes.simulacaoId,
      status: STATUS_IMPORTACAO_LI.pendente,
      fase: FASE_IMPORTACAO_LI.catalogo,
      motivo: null,
      seq: 0,
    }),
  );
  return { tipo: 'criado', jobId };
}
