/**
 * The Loja Integrada notification pipeline (master plan step 3): this channel's
 * binding of the shared failures-only core in `@delfrance/data/admin/notifications`
 * — the reads-queue task, the two sweep lanes, the token-save re-drive.
 *
 * ## What a notification is here
 *
 * `{ tipo, contaId, numero, origem, dataModificacaoLi }` — "this order of this
 * conta changed" — produced by the 5-minute poller (`origem: 'poll'`, PR 3-e)
 * and, from step 4, by the order webhook. IDS ONLY: the importer re-fetches the
 * order (D13), so nothing here maps a body. The shapes are
 * `packages/schemas/src/notificacaoLojaIntegrada.ts`.
 *
 * ## The importer seam
 *
 * The importer is a SEAM ({@link DESTINO_TIPO_LI}), filled in step 5 with the
 * order import (`pedidos/importarPedido.ts`, {@link importarPedidoLi}). The
 * `LIB` functions take it as a required dependency (`deps.importador`), and
 * only the functions codebase's composition roots read the table
 * ({@link importadorPedidoLi}) — so a test injects a fake importer, and filling
 * the table edited neither the task nor the poller. An importer that is absent
 * (a test's `null`, or a `tipo` no step has filled) answers
 * `importador-ausente`, which PARKS: nothing could ever process it, so it must
 * not spend retries.
 *
 * ⚠️ Filling the seam made nothing call Loja Integrada (D17): every run loads
 * its context FIRST, and the context refuses unless the read switch is exactly
 * `on` — so until the window a run DEFERS (`adiado/chamadas-desligadas`) before
 * any Firestore read, and the importer never starts.
 *
 * ## The order of one run ({@link processarNotificacaoLi})
 *
 *  1. Load the context (`core/contexto.ts`): the READ SWITCH first (refused
 *     before any Firestore read), then the conta and the credential. Every call
 *     it later makes is PACED (`core/ritmo.ts`, 2 000 ms before each).
 *  2. No importer ⇒ `importador-ausente`.
 *  3. Run the importer; any error goes through {@link classificarFalhaLi}.
 *
 * "Deterministic outcomes RETURN, transient failures THROW" — the shared core's
 * one contract: {@link classificarFalhaLi} returns an outcome for what is
 * deterministic and `null` for everything else, and the caller rethrows the
 * ORIGINAL error on `null` (root `CLAUDE.md` rule 6: never the `LiError` base,
 * because `LiConfigError` — our own misconfiguration — extends it directly and
 * must stay loud).
 *
 * ## Dispositions ({@link toDispositionLi}, phase-independent)
 *
 * | outcome | task | hot sweep | deferred sweep |
 * | --- | --- | --- | --- |
 * | `importado`, `sem-mudanca`, `obsoleto`, `hub`, `situacao-desconhecida` (the importer) | resolve | delete | delete |
 * | `conta-inexistente` | drop | delete | delete |
 * | `adiado/<motivo>` | defer | migrate to `deferred`, `tentativas` 0 | stays deferred; parks at 7 |
 * | `pedido-inexistente` | park | park | park |
 * | `recusa-deterministica/<classe>[/<status>]` | park | park | park |
 * | `importador-ausente` | park | park | park |
 * | thrown (429, 5xx, network, timeout, our config, gRPC, unknown) | queue backoff, then `failed` | `failed`, parks at 5 with an ERROR line | GRADUATES to the hot lane |
 * | thrown `LiPedidoPagoSemEnderecoError` (step 5: a paid order carrying no CEP at all) | the same | the same, and the park at 5 FAILS LOUDLY (its own line and an aviso) | the same |
 *
 * ## Attempts exhausted: the one loud failure
 *
 * Nothing here counts attempts. The shared pipeline parks a THROWN failure at
 * its cap and calls `onRetriesExhausted` once the park landed — its signal for
 * that one kind of park ({@link criarPipelineLi} binds it to
 * {@link sinalizarEsgotamentoLi}); a RETURNED park is the outcome's own record
 * and signals nothing. A parked row is terminal and holds an order nobody
 * imported, so every park of a failure the RUN threw (the shared `process`,
 * {@link processarNotificacaoLi}) is an ERROR line here:
 *  - the importer's paid-without-address refusal
 *    (`pedidos/pedidoPagoSemEndereco.ts`): its own ERROR line with ids only,
 *    then the open `lojaIntegradaPedidoPagoSemEndereco` aviso;
 *  - any other thrown failure (a 429, a 5xx, a timeout, gRPC…): one generic
 *    ERROR line — the conta, the numero, the origin and the error's CLASS,
 *    never its message — and no aviso; the row's `erro` stays the record.
 *    That includes a paid order whose LAST run met a transient after earlier
 *    address refusals (the residue `pedidoPagoSemEndereco.ts` names).
 *
 * ⚠️ Not every thrown park: the core signals only a throw from `process`. A
 * row that no longer REHYDRATES (the strict `fromDoc`, {@link configLi})
 * throws before any run, so it parks at the same cap with no payload to hand
 * over — no ERROR line, no aviso — and it too holds an order nobody imported.
 * A store write that failed after the run returned (the resolve's delete)
 * parks the same silent way, though that run did its work. Each shows only as
 * the row's document id in the sweep's per-doc failures WARNING
 * (`functions/src/index.ts`), logged on every failed pass, and the row's
 * `erro` is the record.
 *
 * ⚠️ A PARKED CONTA DEFERS — it never drops. Tasks enqueued before a token died
 * are already behind the poller's cursor, so dropping them would lose those
 * orders. The deferred lane re-drives daily for `MAX_TENTATIVAS_DEFERRED` (7)
 * days, and a token save pulls the conta's rows that are ALREADY `deferred`
 * back at once ({@link redrivePedidosAdiadosDaConta}, called by the credential
 * routes through {@link redriveAposSalvarTokenLi}, best effort).
 * `graduateDeferredTransientErrors` sends a row whose precondition cleared but
 * whose import then THREW back to the hot lane with a fresh budget. A conta that
 * is still parked RETURNS `adiado` and never throws, so it never graduates by
 * mistake.
 *
 * ⚠️ Accepted residue (step-3 plan Q4, option A): a run that found the conta
 * parked (or parked it), and writes the row after a token save's re-drive,
 * defeats that re-drive. Three windows, each from the park found to the write:
 *
 *  - the DEFERRED sweep's mark overwrites the re-drive: the row waits one more
 *    day, or, on its 7th pass, parks (Q4);
 *  - the TASK's deferred `create`, and the HOT sweep's migration of a `failed`
 *    row: the re-drive's query found no `deferred` row to move, so the row is
 *    written `deferred` with `tentativas` 0 — it waits up to one more day and is
 *    never parked by this.
 *
 * And the REVERSE direction: the re-drive's own write carries no precondition
 * (the shared store's `redrive`, never reordered here — plan section 4), so a
 * PARK that lands between the re-drive's query and its write of that row (the
 * deferred sweep's 7th pass, a park the import answers once the conta reads
 * clean — `pedido-inexistente`, a deterministic refusal —, or a hot-sweep park
 * of a row graduated in between) is reset to the hot lane as `failed`/0/0. It
 * costs one extra attempt, which parks again or imports.
 * The window runs from the query to that row's write round — at most
 * `ceil(LIMITE_REDRIVE_LI / CONCORRENCIA_REDRIVE_LI)` rounds, since the writes go
 * {@link CONCORRENCIA_REDRIVE_LI} at a time. If it ever matters: condition each
 * write on the query snapshot's `updateTime` and skip on FAILED_PRECONDITION.
 *
 * Never a loss: the next daily deferred pass sees the healthy conta and imports.
 * Each window is milliseconds to seconds wide; `notificacao.test.ts` pins all
 * five cases.
 *
 * ## No transaction anywhere
 *
 * Every write here is the shared store's: `create` (ALREADY_EXISTS ignored),
 * `mark` (a merge), `redrive` (`mergeIfExists`, never resurrects), `remove`.
 * This module never names the multi-document atomic-write API — not even here:
 * `estrutura.test.ts` scans every file of the app for it.
 *
 * ⚠️ The process environment is never read here (`estrutura.test.ts`):
 * `deps.ambiente` is the environment, passed in by the functions codebase's
 * composition root.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ZodError, z } from 'zod';
import type { ViaCepClient } from '@delfrance/core/cep';
import { notificacaoLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import {
  MAX_TENTATIVAS,
  MAX_TENTATIVAS_DEFERRED,
  type NotificationDisposition,
  type NotificationPipelineConfig,
  type NotificationTaskResult,
  type ReprocessOptions,
  type ReprocessResult,
  TASK_MAX_ATTEMPTS,
  defineNotificationPipeline,
} from '@delfrance/data/admin/notifications';
import {
  LiAuthError,
  LiHttpError,
  LiNotFoundError,
  LiPaginacaoError,
  LiSchemaError,
  LiThrottleError,
} from '@delfrance/integrations-loja-integrada';
import {
  NOTIFICACAO_RESILIENCIA_STATUS,
  TIPO_TAREFA_LI,
  type TipoTarefaLi,
  camposNotificacaoLi,
} from '@delfrance/schemas';

import { type ContextoLojaIntegrada, loadLojaIntegradaContext } from '../core/contexto';
import {
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
} from '../core/erros';
import { type TratarFalhaDeps, tratarFalhaDeAutenticacao } from '../core/estacionamento';
import type { OpcoesObservadorLi } from '../core/log';
import { ritmoDeLeituraLi } from '../core/ritmo';
import type { AmbienteLi } from '../core/valvulas';
import { importarPedidoLi } from '../pedidos/importarPedido';
import {
  LiPedidoPagoSemEnderecoError,
  sinalizarPedidoPagoSemEnderecoLi,
} from '../pedidos/pedidoPagoSemEndereco';

// The retry caps are the SHARED pipeline's — re-exported so this module stays
// the one import site for the channel's callers.
export { MAX_TENTATIVAS, MAX_TENTATIVAS_DEFERRED, TASK_MAX_ATTEMPTS };
export type { ReprocessOptions, ReprocessResult };

/**
 * The reads queue: the deployed `onTaskDispatched` function name, which is ALSO
 * its auto-provisioned Cloud Tasks queue name — the producer builds the
 * region-qualified queue path from it and the functions codebase's export must
 * be named exactly this (asserted there). Fixed at the first deploy (Q1). One
 * function for every read task, dispatching on `tipo` (§4.23).
 */
export const FILA_LEITURA_LI = 'filaLeituraLojaIntegrada';

/** The log prefix the shared core renders as `[loja-integrada] …`. */
export const CANAL_LOG_LI = 'loja-integrada';

/** Rows one token-save re-drive moves at most; the daily deferred sweep drains the rest. */
export const LIMITE_REDRIVE_LI = 500;

/**
 * Re-drive writes in flight at once. The credential routes await the re-drive
 * after the Loja Integrada call, inside the request ceiling, so a full page
 * must cost `ceil(LIMITE_REDRIVE_LI / CONCORRENCIA_REDRIVE_LI)` write rounds,
 * not 500 serial updates (`prazos.test.ts` budgets those rounds).
 */
export const CONCORRENCIA_REDRIVE_LI = 20;

/* -------------------------------------------------------------------------- */
/*                              The task payload                              */
/* -------------------------------------------------------------------------- */

/**
 * The reads-queue task payload: the persisted document's wire fields, shared
 * with `@delfrance/schemas` so the two cannot drift. STRIPS unknown keys.
 *
 * ⚠️ Every field added later must be optional or defaulted: tasks in flight
 * survive a deploy, and a payload that no longer parses is DROPPED.
 */
export const tarefaLeituraLiSchema = z.object(camposNotificacaoLi());
export type PayloadNotificacaoLi = z.infer<typeof tarefaLeituraLiSchema>;

/**
 * The failure document's id: `<contaId>:<numero>:<origem>:<digits | ->`, where
 * the last segment is the canonical stamp with every non-digit removed (20
 * digits), or `-` without one.
 *
 * Every part is validated by the task schema, so no doc-id guard is needed: a
 * `/`, a `.`, a reserved `__x__` or an oversized id cannot be built. The stamp
 * is IN the id on purpose — a parked row never swallows a later change of the
 * same order, because `create` ignores ALREADY_EXISTS.
 *
 * @throws {TypeError} for a payload the task schema would refuse — reachable
 *   only by a caller that built one by hand; never a doc at a nested path.
 */
export function docIdNotificacaoLi(p: PayloadNotificacaoLi): string {
  if (!tarefaLeituraLiSchema.safeParse(p).success) {
    throw new TypeError('docIdNotificacaoLi: o payload não passou pelo schema da tarefa');
  }
  const digitos = p.dataModificacaoLi === null ? '-' : p.dataModificacaoLi.replace(/[^0-9]/g, '');
  return `${p.contaId}:${p.numero}:${p.origem}:${digitos}`;
}

/** The sweep's in-run dedup key: the ORDER, whatever stamp or origin named it. */
export function dedupKeyLi(p: PayloadNotificacaoLi): string {
  return `${p.contaId}:${p.numero}`;
}

/** The wire fields written onto a failure document — named one by one, never a spread. */
function camposDoDocumentoLi(p: PayloadNotificacaoLi): Record<string, unknown> {
  return {
    tipo: p.tipo,
    contaId: p.contaId,
    numero: p.numero,
    origem: p.origem,
    dataModificacaoLi: p.dataModificacaoLi,
  };
}

/* -------------------------------------------------------------------------- */
/*                            Outcomes and the seam                           */
/* -------------------------------------------------------------------------- */

/** Why a notification waits in the deferred lane: a precondition a human (or the window) clears. */
export const MOTIVO_ADIAMENTO_LI = {
  chamadasDesligadas: 'chamadas-desligadas',
  contaInativa: 'conta-inativa',
  credencialAusente: 'credencial-ausente',
  credencialInvalida: 'credencial-invalida',
  contaParada: 'conta-parada',
} as const;
export type MotivoAdiamentoLi = (typeof MOTIVO_ADIAMENTO_LI)[keyof typeof MOTIVO_ADIAMENTO_LI];

/** The error classes a deterministic refusal names — the class and status only, never a body. */
export type ClasseRecusaLi = 'LiHttpError' | 'LiSchemaError' | 'LiPaginacaoError' | 'ZodError';

/**
 * What the importer returns (step 5, `pedidos/importarPedido.ts`) — every kind a
 * deterministic SUCCESS, so each one resolves:
 *
 *  - `importado` — a batch wrote the pedido and/or its pagamentos;
 *  - `sem-mudanca` — the order already says everything the pedido holds;
 *  - `obsoleto` — the stored watermark is strictly newer: NOTHING was written;
 *  - `hub` — a hub-marked order (D5): no pedido, no pagamento, an aviso;
 *  - `situacao-desconhecida` — a codigo the shared table does not know: the
 *    order was imported (or left unchanged) with the importer's error text and
 *    an aviso.
 *
 * A kind added later stops {@link toDispositionLi} from compiling until it is
 * mapped.
 */
export type ResultadoImportacaoLi =
  | { readonly kind: 'importado' }
  | { readonly kind: 'sem-mudanca' }
  | { readonly kind: 'obsoleto' }
  | { readonly kind: 'hub' }
  | { readonly kind: 'situacao-desconhecida' };

export type ResultadoNotificacaoLi =
  | ResultadoImportacaoLi
  | { readonly kind: 'conta-inexistente' }
  | { readonly kind: 'adiado'; readonly motivo: MotivoAdiamentoLi }
  | { readonly kind: 'pedido-inexistente' }
  | {
      readonly kind: 'recusa-deterministica';
      readonly classe: ClasseRecusaLi;
      readonly status: number | null;
    }
  | { readonly kind: 'importador-ausente' };

/** What the importer's own log lines go to: ids and counts only, never a value. */
export interface LoggerImportadorLi {
  warn(msg: string, meta?: Record<string, unknown>): void;
  info?(msg: string, meta?: Record<string, unknown>): void;
  /**
   * The ERROR line of a paid order whose retries ran out without an address
   * (`pedidos/pedidoPagoSemEndereco.ts`); without it that line goes to
   * `console.error`, which is ERROR severity too.
   */
  error?(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * What one import needs besides the db, the context and the payload — bound by
 * {@link processarNotificacaoLi} from this run's {@link DepsTarefaLi}, so the
 * queue and the sweep hand the importer the same runtime.
 */
export interface DepsImportadorLi {
  /** Now, in MILLISECONDS — read ONCE per import (the importer converts it, through `dataLi.ts`). */
  readonly agoraMs: () => number;
  /** `(...e) => FieldValue.arrayUnion(...e)`: the freight `mapa` registration. */
  readonly arrayUnion: (...elementos: unknown[]) => unknown;
  /** `(by) => FieldValue.increment(by)`: the avisos' counter. */
  readonly increment: (by: number) => unknown;
  readonly logger?: LoggerImportadorLi;
  /** The CEP recovery of an endereço whose estado is unknown. */
  readonly viaCep: ViaCepClient;
  /**
   * The Cloud Tasks attempt (0-based), or `null` in a sweep run: the situação
   * history is read STRICTLY on attempts 0 and 1 only (`modoHistoricoLi`).
   */
  readonly tentativa: number | null;
}

/** The step-5 importer: one order, re-fetched through the context's (paced) client. */
export type ImportadorPedidoLi = (
  db: Firestore,
  contexto: ContextoLojaIntegrada,
  payload: PayloadNotificacaoLi,
  deps: DepsImportadorLi,
) => Promise<ResultadoImportacaoLi>;

/**
 * The importer SEAM, keyed by task `tipo`. Step 5 filled `pedido` with the
 * order import, {@link importarPedidoLi} — a function DECLARATION, so the
 * binding is initialised before any module body runs and this table never
 * reads it uninitialised, whatever order the modules load in. The functions
 * codebase's roots pick it up through {@link importadorPedidoLi} with no edit of
 * their own.
 *
 * ⚠️ A typed TABLE, never `const X: T | null = null`: TypeScript narrows such a
 * constant at every use. The value type stays nullable, so a `tipo` a later step
 * adds may start empty, and the roots and the poller's importer gate keep
 * reading the table rather than assuming it is full.
 */
export const DESTINO_TIPO_LI: Readonly<Record<TipoTarefaLi, ImportadorPedidoLi | null>> = {
  [TIPO_TAREFA_LI.pedido]: importarPedidoLi,
};

/** The pedido importer, or `null` for an empty seam. Read ONLY by composition roots. */
export function importadorPedidoLi(): ImportadorPedidoLi | null {
  return DESTINO_TIPO_LI[TIPO_TAREFA_LI.pedido];
}

/** The motivo of a deterministic refusal: `recusa-deterministica/<classe>[/<status>]`. */
function motivoDaRecusa(classe: ClasseRecusaLi, status: number | null): string {
  return `recusa-deterministica/${classe}${status === null ? '' : `/${String(status)}`}`;
}

/**
 * The ONE outcome → disposition table. Phase-independent: every outcome answers
 * the same in the task and in both sweeps. An exhaustive `switch` with no
 * `default`, so an outcome kind added later fails to compile until it is mapped.
 */
export function toDispositionLi(r: ResultadoNotificacaoLi): NotificationDisposition {
  switch (r.kind) {
    case 'importado':
    case 'sem-mudanca':
    case 'obsoleto':
    case 'hub':
    case 'situacao-desconhecida':
      return { kind: 'resolve', label: r.kind };
    case 'conta-inexistente':
      return { kind: 'drop', reason: r.kind, label: r.kind };
    case 'adiado':
      return { kind: 'defer', reason: `adiado/${r.motivo}` };
    case 'pedido-inexistente':
      return { kind: 'park', reason: r.kind };
    case 'recusa-deterministica':
      return { kind: 'park', reason: motivoDaRecusa(r.classe, r.status) };
    case 'importador-ausente':
      return { kind: 'park', reason: r.kind };
  }
}

/* -------------------------------------------------------------------------- */
/*                               The classifier                               */
/* -------------------------------------------------------------------------- */

const adiado = (motivo: MotivoAdiamentoLi): ResultadoNotificacaoLi => ({ kind: 'adiado', motivo });

const recusa = (classe: ClasseRecusaLi, status: number | null): ResultadoNotificacaoLi => ({
  kind: 'recusa-deterministica',
  classe,
  status,
});

/** The operator-facing store name, for the reconexão aviso; the id only for a malformed row. */
function lojaNomeDe(contexto: ContextoLojaIntegrada): string {
  return contexto.conta.nome === '' ? contexto.integracaoId : contexto.conta.nome;
}

/**
 * A 401/403 from Loja Integrada: park the conta (`tratarFalhaDeAutenticacao`,
 * the step-2 park's first production caller), then answer by what the park
 * found. `null` = rethrow the original error.
 *
 * - `estacionado` / `ja-estacionado` → `adiado/conta-parada`;
 * - `sem-credencial` → `adiado/credencial-ausente`;
 * - `credencial-substituida` → `null`: the 401 was for an OLDER token, and the
 *   queue's retry runs with the new one;
 * - no usable ref (`estacionamento: null`) → `null`.
 *
 * A credential found corrupt while parking defers like the context's own
 * refusal; the park's persistent-contention error and any gRPC error propagate.
 */
async function classificarRecusaDeCredencial(
  db: Firestore,
  err: LiAuthError,
  contexto: ContextoLojaIntegrada | null,
  deps: TratarFalhaDeps,
): Promise<ResultadoNotificacaoLi | null> {
  // Unreachable: a 401 can only come from a call made through a loaded context.
  if (contexto === null) return null;
  let tratamento: Awaited<ReturnType<typeof tratarFalhaDeAutenticacao>>;
  try {
    tratamento = await tratarFalhaDeAutenticacao(
      db,
      { integracaoId: contexto.integracaoId, lojaNome: lojaNomeDe(contexto) },
      err,
      deps,
    );
  } catch (falha) {
    if (falha instanceof LiCredencialInvalidaError) {
      return adiado(MOTIVO_ADIAMENTO_LI.credencialInvalida);
    }
    throw falha;
  }
  const estacionamento = tratamento.estacionamento;
  if (estacionamento === null) return null;
  switch (estacionamento.tipo) {
    case 'estacionado':
    case 'ja-estacionado':
      return adiado(MOTIVO_ADIAMENTO_LI.contaParada);
    case 'sem-credencial':
      return adiado(MOTIVO_ADIAMENTO_LI.credencialAusente);
    case 'credencial-substituida':
      return null;
  }
}

/**
 * Error → outcome, for everything a run can throw: the context's refusals and
 * the importer's failures. Returns the DETERMINISTIC outcome, or `null` when
 * the caller must rethrow the original error (transient, our own config, gRPC,
 * unknown — the queue's backoff, then the hot lane).
 *
 * The order matters where classes nest: the `LiHttpError` SUBCLASSES
 * (`LiAuthError`, `LiNotFoundError`, `LiThrottleError`) are tested before
 * `LiHttpError` itself, or a 401 would read as a plain refusal and never park
 * the conta. The `LiError` base is NEVER tested: `LiConfigError` extends it
 * directly, and our own misconfiguration must stay loud.
 */
export async function classificarFalhaLi(
  db: Firestore,
  err: unknown,
  contexto: ContextoLojaIntegrada | null,
  deps: TratarFalhaDeps,
): Promise<ResultadoNotificacaoLi | null> {
  // The context's refusals (`core/erros.ts`) — and the getter's, mid-import.
  if (err instanceof LiChamadasDesligadasError) {
    return adiado(MOTIVO_ADIAMENTO_LI.chamadasDesligadas);
  }
  if (err instanceof LiContaNaoEncontradaError) return { kind: 'conta-inexistente' };
  if (err instanceof LiContaInativaError) return adiado(MOTIVO_ADIAMENTO_LI.contaInativa);
  if (err instanceof LiCredencialAusenteError) {
    return adiado(MOTIVO_ADIAMENTO_LI.credencialAusente);
  }
  if (err instanceof LiCredencialInvalidaError) {
    return adiado(MOTIVO_ADIAMENTO_LI.credencialInvalida);
  }
  if (err instanceof LiContaParadaError) return adiado(MOTIVO_ADIAMENTO_LI.contaParada);

  // Loja Integrada's answers: the subclasses BEFORE `LiHttpError` (docblock).
  if (err instanceof LiAuthError) return classificarRecusaDeCredencial(db, err, contexto, deps);
  if (err instanceof LiNotFoundError) return { kind: 'pedido-inexistente' };
  if (err instanceof LiThrottleError) return null;
  if (err instanceof LiHttpError) return err.transitorio ? null : recusa('LiHttpError', err.status);
  if (err instanceof LiSchemaError) return recusa('LiSchemaError', err.status);
  if (err instanceof LiPaginacaoError) return recusa('LiPaginacaoError', null);
  if (err instanceof ZodError) return recusa('ZodError', null);

  // A paid order carrying no CEP at all is RETRIED, never parked by this
  // table: the platform may fill the address, and the pipeline's own park at
  // its cap is what fails it loudly (`onRetriesExhausted`, below).
  if (err instanceof LiPedidoPagoSemEnderecoError) return null;

  // Network and timeout, `LiConfigError`, the park's contention, gRPC, anything
  // unknown: rethrown by the caller.
  return null;
}

/* -------------------------------------------------------------------------- */
/*                                  One run                                   */
/* -------------------------------------------------------------------------- */

/** What the logger adds to each call line of a run (the notification id is added per run). */
export type RegistroTarefaLi = Omit<OpcoesObservadorLi, 'conta' | 'idNotificacao'>;

export interface DepsTarefaLi extends TratarFalhaDeps {
  /** The process environment, from the entry point — read for the read switch only. */
  readonly ambiente: AmbienteLi;
  /** The importer seam: {@link importadorPedidoLi} in the roots, a fake in tests. */
  readonly importador: ImportadorPedidoLi | null;
  /** `(...e) => FieldValue.arrayUnion(...e)` in the roots, the fake's sentinel in tests. */
  readonly arrayUnion: (...elementos: unknown[]) => unknown;
  /** The importer's CEP recovery: `createViaCepClient()` in the roots, a fake in tests. */
  readonly viaCep: ViaCepClient;
  /**
   * The run's ONE logger — `TratarFalhaDeps.logger` re-declared with an
   * optional `info`, never a second sink: the park's lines and the importer's
   * (ids and counts only) both go to it.
   */
  readonly logger?: LoggerImportadorLi;
  /** The sleep the pacer uses: `setTimeout` in the roots, a recording fake in tests. */
  readonly esperar: (ms: number) => Promise<void>;
  /** The flow, the Cloud Tasks attempt and task id (`null` in a sweep), a test sink. */
  readonly registro: RegistroTarefaLi;
  /** Test seam, forwarded to the context's client. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The importer's deps for this run, from the run's own: the same clock, the
 * same sentinels, and the Cloud Tasks attempt off `registro` (`null` in a sweep,
 * whose `registro` carries none).
 */
export function depsDoImportadorLi(deps: DepsTarefaLi): DepsImportadorLi {
  return {
    agoraMs: deps.agoraMs,
    arrayUnion: deps.arrayUnion,
    increment: deps.increment,
    logger: deps.logger,
    viaCep: deps.viaCep,
    tentativa: deps.registro.tentativa ?? null,
  };
}

/**
 * One notification, start to finish (module header). Deterministic outcomes
 * RETURN; everything else rethrows the ORIGINAL error.
 */
export async function processarNotificacaoLi(
  db: Firestore,
  payload: PayloadNotificacaoLi,
  deps: DepsTarefaLi,
): Promise<ResultadoNotificacaoLi> {
  let contexto: ContextoLojaIntegrada | null = null;
  try {
    contexto = await loadLojaIntegradaContext(db, payload.contaId, {
      ambiente: deps.ambiente,
      ritmo: ritmoDeLeituraLi(deps.esperar),
      registro: { ...deps.registro, idNotificacao: docIdNotificacaoLi(payload) },
      fetch: deps.fetch,
    });
    if (deps.importador === null) return { kind: 'importador-ausente' };
    return await deps.importador(db, contexto, payload, depsDoImportadorLi(deps));
  } catch (err) {
    const desfecho = await classificarFalhaLi(db, err, contexto, deps);
    if (desfecho === null) throw err;
    return desfecho;
  }
}

/** Never called: the storage-only pipeline below only persists and re-drives. */
function processoIndisponivel(): Promise<ResultadoNotificacaoLi> {
  return Promise.reject(
    new TypeError('pipeline de armazenamento da Loja Integrada: process não é chamado aqui'),
  );
}

/**
 * The shared-core config. ⚠️ `collection` is written EXPLICITLY: guard B
 * (`notificationGuardrails.test.ts`) ignores the shorthand form on purpose, so
 * a shorthand here would read as "this channel hand-rolled its own store".
 */
function configLi(
  processar: (db: Firestore, payload: PayloadNotificacaoLi) => Promise<ResultadoNotificacaoLi>,
  aoEsgotar?: (db: Firestore, payload: PayloadNotificacaoLi, err: Error) => Promise<void>,
): NotificationPipelineConfig<PayloadNotificacaoLi, ResultadoNotificacaoLi> {
  return {
    // The pipeline's signal for a thrown failure it parked at the cap (module
    // header); absent on the storage-only pipeline, which never sweeps.
    ...(aoEsgotar === undefined ? {} : { onRetriesExhausted: aoEsgotar }),
    channel: CANAL_LOG_LI,
    collection: notificacaoLojaIntegradaCollection,
    taskSchema: tarefaLeituraLiSchema,
    docIdOf: docIdNotificacaoLi,
    dedupKeyOf: dedupKeyLi,
    toDocFields: camposDoDocumentoLi,
    // STRICT, from the raw document: a row that no longer parses throws, and
    // the sweep's per-row boundary marks it (parking it at the cap, with NO
    // exhaustion signal: only its document id in the WARNING — module header).
    fromDoc: (_parsed, raw) => tarefaLeituraLiSchema.parse(raw),
    process: processar,
    toDisposition: (resultado) => toDispositionLi(resultado),
    // A parked conta's row whose token came back and whose import then THREW
    // returns to the hot lane with a fresh budget (module header).
    graduateDeferredTransientErrors: true,
  };
}

/**
 * The pipeline, built PER CALL so this run's `registro` (attempt, task id)
 * reaches the logger: the shared `process(db, payload)` carries neither.
 */
export function criarPipelineLi(deps: DepsTarefaLi) {
  return defineNotificationPipeline(
    configLi(
      (db, p) => processarNotificacaoLi(db, p, deps),
      (db, p, err) => sinalizarEsgotamentoLi(db, p, err, deps),
    ),
  );
}

/**
 * A thrown failure the hot (or a non-graduating deferred) sweep just PARKED at
 * its cap (module header): the paid-without-address refusal's own loud signal,
 * else one generic ERROR line — ids and the error's class only, never its
 * message — so no order whose run threw parks unnoticed. (A row that fails to
 * rehydrate never reaches here: module header.) A failed aviso write rethrows;
 * the shared core contains it.
 */
export async function sinalizarEsgotamentoLi(
  db: Firestore,
  payload: PayloadNotificacaoLi,
  err: Error,
  deps: Pick<DepsTarefaLi, 'increment' | 'agoraMs' | 'logger'>,
): Promise<void> {
  const doPedido = await sinalizarPedidoPagoSemEnderecoLi(db, err, {
    increment: deps.increment,
    agoraMs: deps.agoraMs,
    logger: deps.logger,
  });
  if (doPedido) return;
  const linha = `[${CANAL_LOG_LI}] notificação estacionada: tentativas esgotadas, pedido não importado`;
  const ids = {
    integracaoId: payload.contaId,
    numero: payload.numero,
    origem: payload.origem,
    classe: err.name,
  };
  if (deps.logger?.error === undefined) console.error(linha, ids);
  else deps.logger.error(linha, ids);
}

/** Persist and re-drive only — the writes that need no `process`. */
const armazenamentoLi = defineNotificationPipeline(configLi(processoIndisponivel));

/* -------------------------------------------------------------------------- */
/*                         The task and the two sweeps                        */
/* -------------------------------------------------------------------------- */

/** What one dispatch reports, for the functions codebase's ONE log line. */
export interface ResultadoTarefaLi {
  readonly outcome: NotificationTaskResult<PayloadNotificacaoLi, ResultadoNotificacaoLi>['outcome'];
  /** The channel's outcome kind; `null` when the payload never parsed. */
  readonly kind: ResultadoNotificacaoLi['kind'] | null;
  /**
   * On `done` and `dropped` only — the arms that persist NOTHING, so the log is
   * all there is. A park, a defer or a failure writes its reason on the row.
   */
  readonly detail: string | null;
}

/** The `detail` of a dispatch: present only on the arms that leave no document. */
function detalheDaTarefa(
  r: NotificationTaskResult<PayloadNotificacaoLi, ResultadoNotificacaoLi>,
): string | null {
  if (r.outcome !== 'done' && r.outcome !== 'dropped') return null;
  // A payload that failed the task schema has no outcome at all.
  return r.result?.kind ?? 'payload-invalido';
}

/**
 * The reads-queue body for a `pedido` task: parse, run, dispose. `retryCount`
 * is the 0-based Cloud Tasks attempt; on the last one a transient failure is
 * persisted as `failed` instead of rethrown.
 */
export async function tratarTarefaLeituraLi(
  db: Firestore,
  dados: unknown,
  retryCount: number,
  deps: DepsTarefaLi,
): Promise<ResultadoTarefaLi> {
  const r = await criarPipelineLi(deps).handleTask(db, dados, retryCount);
  return { outcome: r.outcome, kind: r.result?.kind ?? null, detail: detalheDaTarefa(r) };
}

/** One raw id off a task's data, for the log: a short string, else `null` (never an object). */
function campoBruto(dados: unknown, chave: string): string | null {
  if (typeof dados !== 'object' || dados === null || !Object.hasOwn(dados, chave)) return null;
  const valor: unknown = Reflect.get(dados, chave);
  return typeof valor === 'string' && valor.length <= 128 ? valor : null;
}

/**
 * The fields of the functions codebase's ONE `logger.info` per dispatch. The
 * ids are read off the RAW task data — so they survive a payload the schema
 * dropped — one by one, as short strings or `null`: never a spread of the
 * data, which no reviewer has vetted for what it may carry.
 */
export function camposDoRegistroDaTarefaLi(
  r: ResultadoTarefaLi,
  dados: unknown,
): Readonly<Record<string, string | null>> {
  return {
    outcome: r.outcome,
    kind: r.kind,
    detail: r.detail,
    tipo: campoBruto(dados, 'tipo'),
    contaId: campoBruto(dados, 'contaId'),
    numero: campoBruto(dados, 'numero'),
    origem: campoBruto(dados, 'origem'),
  };
}

/** The `onSchedule` backstop over the HOT lane (`failed`, hourly window). */
export function reprocessarNotificacoesLi(
  db: Firestore,
  opts: ReprocessOptions,
  deps: DepsTarefaLi,
): Promise<ReprocessResult> {
  return criarPipelineLi(deps).reprocess(db, opts);
}

/** The `onSchedule` backstop over the DEFERRED lane (`deferred`, daily window). */
export function reprocessarAdiadasLi(
  db: Firestore,
  opts: ReprocessOptions,
  deps: DepsTarefaLi,
): Promise<ReprocessResult> {
  return criarPipelineLi(deps).reprocessDeferred(db, opts);
}

/**
 * Persist a notification as `failed`, for a producer whose ENQUEUE failed
 * transiently (or while the queue is switched off): the hot sweep drains it.
 * The doc id is deterministic, so a re-poll of the same change never forks.
 */
export function persistirFalhaNotificacaoLi(
  db: Firestore,
  payload: PayloadNotificacaoLi,
  erro: string,
): Promise<void> {
  return armazenamentoLi.persistFailure(db, payload, erro);
}

/* -------------------------------------------------------------------------- */
/*                         The token-save re-drive                            */
/* -------------------------------------------------------------------------- */

export interface LoggerNotificacaoLi {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const loggerPadrao: LoggerNotificacaoLi = {
  warn: (msg, meta) => {
    if (meta === undefined) console.warn(msg);
    else console.warn(msg, meta);
  },
};

/** What one re-drive did, for the caller's log line. */
export interface ResultadoRedriveLi {
  /** Deferred rows found for this conta. */
  readonly encontradas: number;
  /** Of those, the ones actually moved back into the hot lane. */
  readonly redirecionadas: number;
  /** The page cap was hit — the daily deferred sweep drains the remainder. */
  readonly truncado: boolean;
}

/**
 * Pull every notification DEFERRED on this conta back into the hot lane, so the
 * next 30-minute sweep retries it at once instead of waiting out its day — for
 * the two routes that clear a park (a token saved, a validity renewed; PR 3-b).
 * Mercado Livre's `redriveDeferredForUserId` shape.
 *
 * A LATENCY optimisation over the daily deferred sweep, never a replacement:
 * whatever it misses (past the cap, a route that failed, or a row written
 * `deferred` just after its query — the module header's residue) still drains
 * daily.
 * Each row goes through the shared store's `redrive` — `mergeIfExists`, so a
 * row deleted between the query and the write is never resurrected — and never
 * through a hand-written patch. Idempotent: a replay finds nothing left to move.
 * The writes go out {@link CONCORRENCIA_REDRIVE_LI} at a time (the credential
 * routes await this inside the request ceiling, `prazos.test.ts`), and none is
 * conditioned on the row still being `deferred` — the module header's reverse
 * window.
 *
 * ⚠️ Its query needs the `(status ASC, contaId ASC)` composite on
 * `notificacoesLojaIntegrada` (guard D in `notificationGuardrails.test.ts`).
 * Enterprise auto-creates none and silently full-scans (billing the scan).
 */
export async function redrivePedidosAdiadosDaConta(
  db: Firestore,
  contaId: string,
  limite: number = LIMITE_REDRIVE_LI,
  logger: LoggerNotificacaoLi = loggerPadrao,
): Promise<ResultadoRedriveLi> {
  const snap = await notificacaoLojaIntegradaCollection
    .ref(db, {})
    .where('status', '==', NOTIFICACAO_RESILIENCIA_STATUS.deferred)
    .where('contaId', '==', contaId)
    .limit(limite)
    .get();

  const erro = `token da conta ${contaId} salvo — reprocessando`;
  let redirecionadas = 0;
  for (let i = 0; i < snap.docs.length; i += CONCORRENCIA_REDRIVE_LI) {
    const lote = snap.docs.slice(i, i + CONCORRENCIA_REDRIVE_LI);
    const movidas = await Promise.all(lote.map((d) => armazenamentoLi.redrive(db, d.id, erro)));
    redirecionadas += movidas.filter(Boolean).length;
  }

  const truncado = snap.docs.length >= limite;
  if (truncado) {
    logger.warn(
      '[loja-integrada/notificacoes] re-drive atingiu o limite — o restante sai na varredura diária',
      { contaId, limite },
    );
  }
  return { encontradas: snap.docs.length, redirecionadas, truncado };
}

/**
 * The re-drive as the two credential routes call it: BEST EFFORT. The token is
 * already saved and validated when this runs, so a Firestore failure here must
 * never fail the request — the daily deferred sweep drains whatever this missed.
 *
 * Narrowed by CLASS (root rule 6): only a gRPC status error — the shape every
 * Admin-SDK Firestore failure takes — is logged (the code, never the message)
 * and swallowed, as `null`; anything else is a bug and is rethrown. The
 * narrowing is deliberately wider than "transient": the conta's credential is
 * saved either way, and the daily sweep is the backstop for any of them.
 */
export async function redriveAposSalvarTokenLi(
  db: Firestore,
  contaId: string,
  logger: LoggerNotificacaoLi = loggerPadrao,
): Promise<ResultadoRedriveLi | null> {
  try {
    return await redrivePedidosAdiadosDaConta(db, contaId, LIMITE_REDRIVE_LI, logger);
  } catch (err) {
    if (!isGrpcStatusError(err)) throw err;
    logger.warn(
      '[loja-integrada/notificacoes] re-drive após salvar o token falhou — a varredura diária cobre',
      { contaId, code: err.code },
    );
    return null;
  }
}
