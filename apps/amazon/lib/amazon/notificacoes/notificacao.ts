/**
 * The Amazon notification pipeline (master plan step 3, PR 3-b): this channel's
 * binding of the shared failures-only core in `@delfrance/data/admin/notifications`
 * — the reads-queue task and the two sweep lanes.
 *
 * ## What a notification is here
 *
 * `tarefaAmazonSchema` (`packages/schemas/src/notificacaoAmazon.ts`): "this order
 * of this seller changed", IDS ONLY, from two producers — the receiver (`push`,
 * PR 3-c) and the backstop poll (`poll`, step 4). The importer re-fetches the
 * order (`getOrder`, step 5), so nothing here maps a body (D5).
 *
 * ⚠️ A DECLARED departure from the `webhook-notifications` skill (step-3 plan §3
 * decision 29): the task and document schemas STRIP unknown keys instead of
 * `.passthrough()`, and the producers build the payload field by field instead of
 * normalize-then-`safeParse`. The push body carries buyer PII and D5 forbids
 * mapping it; the routing ids re-derive the order, so the dead-letter row loses
 * nothing it needs. Do not "fix" it toward the skill.
 *
 * ## The task makes NO Amazon call in step 3
 *
 * The importer is a SEAM ({@link DESTINO_TIPO_AMAZON}), empty until step 5 fills
 * it. `lib` takes it as a required dependency (`deps.importador`) and only the
 * functions codebase's composition root reads the table
 * ({@link importadorPedidoAmazon}). With the seam empty the outcome is
 * `adiado/importador-ausente`, which DEFERS (step-3 plan §3 decision 12; Loja
 * Integrada parks): the blockage is cleared by a deploy, a precondition outside
 * the task, and a deferred row survives a window-order mistake (a subscription
 * before step 5's deploy) for seven daily re-drives instead of being lost.
 *
 * ## The order of one run ({@link processarNotificacaoAmazon})
 *
 *  1. The READ SWITCH, before any Firestore read: not exactly `on` ⇒ one blocked
 *     line and `adiado/chamadas-desligadas`. The context loader re-checks it.
 *  2. ROUTE. A push names a seller, not a conta: `contasPorSellingPartnerId`
 *     (uncached, the declared `(tipo, selling_partner_id, ativo)` composite,
 *     `limit(2)`; §3 decision 11) — none ⇒ `adiado/sem-conta`, two ⇒
 *     `adiado/vendedor-duplicado` plus ONE ERROR line naming both conta ids and
 *     never the seller. A poll names its conta; once the context loads, a conta
 *     whose seller is no longer the payload's ⇒ `vendedor-mudou` (dropped: the
 *     order belongs to a seller this conta no longer holds). The context's conta
 *     is the CACHED copy, so a mismatch evicts it and reloads the context before
 *     deciding: a stale copy must never drop a current poll.
 *  3. The CONTEXT (`core/contexto.ts`): switch, LWA pair, conta, credential.
 *  4. The IMPORTER seam: empty ⇒ `adiado/importador-ausente`.
 *  5. Every throw goes through {@link classificarFalhaDaTarefaAmazon}; `null`
 *     rethrows through the SANITIZING BOUNDARY (below).
 *
 * "Deterministic outcomes RETURN, transient failures THROW" — the shared core's
 * one contract.
 *
 * ## The sanitizing boundary (step-3 plan §3 decision 31)
 *
 * The firebase-functions task wrapper logs an unhandled throw whole, and
 * `util.format` prints an Error's OWN fields: a package error carries
 * `refCredencial` (the credential fingerprint), `caminho` (a path that can name
 * the seller in step 9) and `cause`. The shared core also writes `err.message`
 * onto the failure document, hands it to `mark`/`redrive`, and prints it in its
 * correlated-outage line. So no package error ever leaves
 * {@link processarNotificacaoAmazon}: {@link sanitizarFalhaDaTarefaAmazon} turns
 * each NAMED package class into a {@link FalhaTarefaAmazonError} (class plus
 * status or motivo; no cause, no ref, no path), and rethrows anything else —
 * this app's own errors, gRPC, a bug — untouched (rule 6).
 *
 * ## Dispositions ({@link toDispositionAmazon}, phase-independent)
 *
 * | outcome | task | hot sweep | deferred sweep |
 * | --- | --- | --- | --- |
 * | `importado`, `sem-mudanca`, `obsoleto`, `cancelado-nao-importado`, `reversao-nao-importada` (step 5) | resolve | delete | delete |
 * | `conta-inexistente`, `vendedor-mudou`, `marketplace-estrangeiro` (step 5) | drop | delete | delete |
 * | `adiado/<motivo>` | defer | migrate to `deferred`, `tentativas` 0 | stays deferred; parks at 7 |
 * | `pedido-inexistente` | park | park | park |
 * | `recusa-deterministica/<classe>[/<status>]` | park | park | park |
 * | thrown (429, 5xx, network, timeout, our config, gRPC, unknown) | queue backoff, then `failed` | `failed`, parks at 5 | GRADUATES to the hot lane |
 *
 * `graduateDeferredTransientErrors`: a deferred row whose precondition cleared
 * and whose import then THREW returns to the hot lane with a fresh budget. A
 * still-blocked precondition RETURNS `adiado`, so it never graduates by mistake.
 *
 * ## Rule 7 — no write of this module's own
 *
 * A successful task writes nothing. The final-attempt persist is the core's
 * `create` on a deterministic id (tier 0: a duplicate hits ALREADY_EXISTS); the
 * sweeps' state moves are the core's own `mark` / `redrive` / `remove`; the park
 * is step 2's tier-1 precondition write. This module never names the Admin SDK's
 * multi-document atomic-write API — not even here: `estrutura.test.ts` scans
 * every file of the app for it.
 *
 * ⚠️ The process environment is never read here (`estrutura.test.ts`):
 * `deps.ambiente` is the environment, passed in by the composition root.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ZodError } from 'zod';
import { notificacaoAmazonCollection } from '@delfrance/data/admin/collections';
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
  AmazonAuthError,
  AmazonConfigError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  AmazonTimeoutError,
} from '@delfrance/integrations-amazon-sp-api';
import {
  CONTA_ID_AMAZON_REGEX,
  NOTIFICATION_ID_AMAZON_REGEX,
  ORIGEM_NOTIFICACAO_AMAZON,
  PEDIDO_AMAZON_REGEX,
  TIPO_TAREFA_AMAZON,
  type TarefaAmazon,
  type TipoTarefaAmazon,
  origemNotificacaoAmazonSchema,
  type recoverEnderecoFromCep,
  tarefaAmazonSchema,
  tipoTarefaAmazonSchema,
} from '@delfrance/schemas';

import type { AmbienteAmazon } from '../env';
import type { AcaoItensAmazon } from '../pedidos/itensAmazon';
import { invalidarContaEmCache } from '../core/contaCache';
import { contasPorSellingPartnerId } from '../core/contas';
import { type ContextoAmazon, type ContextoAmazonDeps, loadAmazonContext } from '../core/contexto';
import {
  ChamadasAmazonDesligadasError,
  ConfigAmazonAusenteError,
  ContaAmazonInativaError,
  ContaAmazonNaoConectadaError,
  ContaAmazonNaoEncontradaError,
  ContaAmazonParadaError,
  CredencialAmazonAusenteError,
  CredencialAmazonInvalidaError,
} from '../core/erros';
import { classificarFalhaAmazon, tratarFalhaDeAutenticacao } from '../core/estacionamento';
import { type LoggerAmazon, registrarEventoAmazon } from '../core/log';
import {
  CHAMADAS_ENV_AMAZON,
  lerChaveDeChamadasAmazon,
  registrarChamadaBloqueadaAmazon,
} from '../core/valvulas';

// The retry caps are the SHARED pipeline's — re-exported so this module stays
// the one import site for the channel's callers.
export { MAX_TENTATIVAS, MAX_TENTATIVAS_DEFERRED, TASK_MAX_ATTEMPTS };
export type { ReprocessOptions, ReprocessResult };

/**
 * The reads queue: the deployed `onTaskDispatched` function name, which is ALSO
 * its auto-provisioned Cloud Tasks queue name — the producer builds the
 * region-qualified path from it (`agendador.ts`) and the functions codebase's
 * export must be named exactly this (asserted there). ONE queue for every read
 * task, dispatching on `tipo` (§4.23; step-3 plan §3 decision 19).
 */
export const FILA_LEITURA_AMAZON = 'filaLeituraAmazon';

/** The log prefix the shared core renders as `[amazon] …`. */
export const CANAL_LOG_AMAZON = 'amazon';

/** The operation name the read switch's refusal line carries for this flow. */
export const ROTA_INTAKE_AMAZON = 'intake';

/** The flows a run's call lines carry (`jsonPayload.fluxo`): the task, or a sweep re-drive. */
export const FLUXO_LEITURA_AMAZON = {
  intake: 'intake',
  reprocesso: 'reprocesso',
} as const;
export type FluxoLeituraAmazon = (typeof FLUXO_LEITURA_AMAZON)[keyof typeof FLUXO_LEITURA_AMAZON];

/* -------------------------------------------------------------------------- */
/*                              The task payload                              */
/* -------------------------------------------------------------------------- */

/** The reads-queue payload (module header): `tarefaAmazonSchema`, one variant per producer. */
export type PayloadNotificacaoAmazon = TarefaAmazon;

/**
 * The failure document's id (step-3 plan §3 decision 34):
 *
 *  - push ⇒ `push:<NotificationId>` — the grammar excludes `/`, and the prefix
 *    keeps the id from ever being `.`, `..` or `__x__` and from ever equalling a
 *    `poll:` id (at most 5 + 128 bytes), so no separate doc-id guard is needed;
 *  - poll ⇒ `poll:<contaId>:<amazonOrderId>:<lastUpdatedUs>` — every part
 *    schema-validated, the µs stamp IN the id: a later change of the same order
 *    is a NEW row, so a parked row never swallows it (`create` ignores
 *    ALREADY_EXISTS).
 *
 * Deterministic across deliveries and ticks: a redelivery of the same event
 * collides instead of forking.
 *
 * @throws {TypeError} for a payload the task schema would refuse — reachable
 *   only by a caller that built one by hand; never a doc at a nested path.
 */
export function docIdNotificacaoAmazon(p: PayloadNotificacaoAmazon): string {
  if (!tarefaAmazonSchema.safeParse(p).success) {
    throw new TypeError('docIdNotificacaoAmazon: o payload não passou pelo schema da tarefa');
  }
  return p.origem === ORIGEM_NOTIFICACAO_AMAZON.push
    ? `push:${p.notificationId}`
    : `poll:${p.contaId}:${p.amazonOrderId}:${String(p.lastUpdatedUs)}`;
}

/**
 * The sweep's in-run dedup key: the ORDER, `<sellerId>:<amazonOrderId>`, for
 * BOTH origins (step-3 plan §3 decision 10) — the push payload carries no conta,
 * and a key both can compute is what lets one sweep collapse a push row and a
 * poll row of the same order. Injective even for a seller id holding `:`,
 * because the order id is a FIXED-length 3-7-7 suffix.
 */
export function dedupKeyAmazon(p: PayloadNotificacaoAmazon): string {
  return `${p.sellerId}:${p.amazonOrderId}`;
}

/**
 * The wire fields written onto a failure document — named one by one, NEVER a
 * spread: a key the payload object happens to carry beyond its variant's never
 * reaches Firestore.
 */
export function camposDoDocumentoAmazon(p: PayloadNotificacaoAmazon): Record<string, unknown> {
  if (p.origem === ORIGEM_NOTIFICACAO_AMAZON.push) {
    return {
      tipo: p.tipo,
      origem: p.origem,
      sellerId: p.sellerId,
      amazonOrderId: p.amazonOrderId,
      notificationId: p.notificationId,
      publishTimeMs: p.publishTimeMs,
    };
  }
  return {
    tipo: p.tipo,
    origem: p.origem,
    sellerId: p.sellerId,
    amazonOrderId: p.amazonOrderId,
    contaId: p.contaId,
    lastUpdatedUs: p.lastUpdatedUs,
  };
}

/* -------------------------------------------------------------------------- */
/*                            Outcomes and the seam                           */
/* -------------------------------------------------------------------------- */

/** Why a notification waits in the deferred lane: a precondition a human (a deploy, the window) clears. */
export const MOTIVO_ADIAMENTO_AMAZON = {
  chamadasDesligadas: 'chamadas-desligadas',
  semConta: 'sem-conta',
  vendedorDuplicado: 'vendedor-duplicado',
  importadorAusente: 'importador-ausente',
  contaInativa: 'conta-inativa',
  contaNaoConectada: 'conta-nao-conectada',
  credencialAusente: 'credencial-ausente',
  credencialInvalida: 'credencial-invalida',
  contaParada: 'conta-parada',
  segredoLwaRecusado: 'segredo-lwa-recusado',
  semPermissao: 'sem-permissao',
} as const;
export type MotivoAdiamentoAmazon =
  (typeof MOTIVO_ADIAMENTO_AMAZON)[keyof typeof MOTIVO_ADIAMENTO_AMAZON];

/** The error classes a deterministic refusal names — the class and status only, never a body. */
export type ClasseRecusaAmazon = 'AmazonHttpError' | 'AmazonSchemaError' | 'ZodError';

/**
 * What the step-5 importer reports beside its kind, for the task's ONE log line
 * (PR 5-e adds the campos): numbers and closed codes only.
 */
export interface DetalheImportacaoAmazon {
  /** `criado` / `atualizado` on `importado`; `null` on `sem-mudanca`. */
  readonly acao: 'criado' | 'atualizado' | null;
  /** What the import did with the lines (the D17 `acao`; the master plan's `detail` values verbatim). */
  readonly itens: AcaoItensAmazon;
  /** Stored lines left untouched by a freeze or a reversal. */
  readonly linhasPreservadas: number;
  /** Lines involved in a block. */
  readonly linhasDivergentes: number;
  /** Final lines no produto owns (`'NONE'`). */
  readonly linhasSemProduto: number;
}

/**
 * What the importer returns (step 5, PR 5-d; the seam stays empty until 5-e).
 * {@link toDispositionAmazon} maps each kind, and stops compiling until a new
 * one is mapped:
 *
 *  - `importado` — a batch committed (a divergence included: the error, where
 *    applicable, is persisted and the aviso is the signal);
 *  - `sem-mudanca` — nothing to write (an equal redelivery);
 *  - `obsoleto` — a newer write already landed on the pedido;
 *  - `cancelado-nao-importado` — a first-seen CANCELLED order, past the
 *    recent-cancel window (zero writes);
 *  - `reversao-nao-importada` — a first-seen order with any other reversal
 *    signal, past the same window (zero writes; plan §3 decision 44);
 *  - `marketplace-estrangeiro` — not the BR marketplace (dropped).
 *
 * `detalhe` is ALWAYS set by the step-5 importer (`importarPedido.test.ts`
 * pins it); a step-3 fake importer legitimately returns the bare kind.
 */
export type ResultadoImportacaoAmazon =
  | { readonly kind: 'importado'; readonly detalhe?: DetalheImportacaoAmazon }
  | { readonly kind: 'sem-mudanca'; readonly detalhe?: DetalheImportacaoAmazon }
  | { readonly kind: 'obsoleto' }
  | { readonly kind: 'cancelado-nao-importado' }
  | { readonly kind: 'reversao-nao-importada' }
  | { readonly kind: 'marketplace-estrangeiro' };

export type ResultadoNotificacaoAmazon =
  | ResultadoImportacaoAmazon
  | { readonly kind: 'conta-inexistente' }
  | { readonly kind: 'vendedor-mudou' }
  | { readonly kind: 'adiado'; readonly motivo: MotivoAdiamentoAmazon }
  | { readonly kind: 'pedido-inexistente' }
  | {
      readonly kind: 'recusa-deterministica';
      readonly classe: ClasseRecusaAmazon;
      readonly status: number | null;
    };

/** The step-5 importer: one order, re-fetched through the context's client. */
export type ImportadorPedidoAmazon = (
  db: Firestore,
  contexto: ContextoAmazon,
  payload: PayloadNotificacaoAmazon,
) => Promise<ResultadoImportacaoAmazon>;

/**
 * The importer SEAM, keyed by task `tipo`. Empty in step 3: step 5 fills
 * `pedido`, and the functions codebase's root picks it up through
 * {@link importadorPedidoAmazon} with no edit of its own.
 *
 * ⚠️ A typed TABLE, never `const X: T | null = null`: TypeScript narrows such a
 * constant to `null` at every use, which would make step 5's non-null branch
 * `never` and fail to compile the day it is filled.
 */
export const DESTINO_TIPO_AMAZON: Readonly<
  Record<TipoTarefaAmazon, ImportadorPedidoAmazon | null>
> = {
  [TIPO_TAREFA_AMAZON.pedido]: null,
};

/** The pedido importer, or `null` while the seam is empty. Read ONLY by composition roots. */
export function importadorPedidoAmazon(): ImportadorPedidoAmazon | null {
  return DESTINO_TIPO_AMAZON[TIPO_TAREFA_AMAZON.pedido];
}

/** The motivo of a deterministic refusal: `recusa-deterministica/<classe>[/<status>]`. */
function motivoDaRecusa(classe: ClasseRecusaAmazon, status: number | null): string {
  return `recusa-deterministica/${classe}${status === null ? '' : `/${String(status)}`}`;
}

/**
 * The ONE outcome → disposition table. Phase-independent: every outcome answers
 * the same in the task and in both sweeps. An exhaustive `switch` with no
 * `default`, so an outcome kind added later fails to compile until it is mapped.
 */
export function toDispositionAmazon(r: ResultadoNotificacaoAmazon): NotificationDisposition {
  switch (r.kind) {
    case 'importado':
    case 'sem-mudanca':
    case 'obsoleto':
    case 'cancelado-nao-importado':
    case 'reversao-nao-importada':
      return { kind: 'resolve', label: r.kind };
    case 'conta-inexistente':
    case 'vendedor-mudou':
    case 'marketplace-estrangeiro':
      return { kind: 'drop', reason: r.kind, label: r.kind };
    case 'adiado':
      return { kind: 'defer', reason: `adiado/${r.motivo}` };
    case 'pedido-inexistente':
      return { kind: 'park', reason: r.kind };
    case 'recusa-deterministica':
      return { kind: 'park', reason: motivoDaRecusa(r.classe, r.status) };
  }
}

/* -------------------------------------------------------------------------- */
/*                               The classifier                               */
/* -------------------------------------------------------------------------- */

const adiado = (motivo: MotivoAdiamentoAmazon): ResultadoNotificacaoAmazon => ({
  kind: 'adiado',
  motivo,
});

const recusa = (classe: ClasseRecusaAmazon, status: number | null): ResultadoNotificacaoAmazon => ({
  kind: 'recusa-deterministica',
  classe,
  status,
});

/** What the classifier needs to park a conta and raise its avisos. */
export interface DepsClassificadorAmazon {
  /** Now, in MILLISECONDS. */
  readonly agora: () => number;
  /** `(by) => FieldValue.increment(by)`, for the avisos. */
  readonly increment: (by: number) => unknown;
  readonly logger: LoggerAmazon;
}

/**
 * An LWA refusal (`estacionar` or `segredo-recusado`): hand it to the park
 * (`tratarFalhaDeAutenticacao`, its first production caller), then answer by
 * what it found. `null` = rethrow.
 *
 * - `segredo-recusado` → `adiado/segredo-lwa-recusado` (the helper raised the
 *   app-wide aviso; nothing parked);
 * - `estacionado` / `ja-estacionado` → `adiado/conta-parada`;
 * - `sem-credencial` → `adiado/credencial-ausente`;
 * - `credencial-substituida` → `null`: the refusal was for an OLDER grant, and
 *   the queue's retry runs on the new one;
 * - no usable ref (`estacionamento: null`) → `null`.
 *
 * A credential found corrupt while parking defers like the context's own
 * refusal; the park's persistent contention and any gRPC error propagate.
 */
async function classificarRecusaLwa(
  db: Firestore,
  err: AmazonAuthError,
  contexto: ContextoAmazon | null,
  deps: DepsClassificadorAmazon,
): Promise<ResultadoNotificacaoAmazon | null> {
  // Unreachable: an LWA refusal can only come from a call made through a context.
  if (contexto === null) return null;
  let tratamento: Awaited<ReturnType<typeof tratarFalhaDeAutenticacao>>;
  try {
    tratamento = await tratarFalhaDeAutenticacao(
      db,
      {
        integracaoId: contexto.integracaoId,
        contaNome: contexto.conta.nome === '' ? contexto.integracaoId : contexto.conta.nome,
      },
      err,
      { agoraMs: deps.agora, increment: deps.increment, logger: deps.logger },
    );
  } catch (falha) {
    if (falha instanceof CredencialAmazonInvalidaError) {
      return adiado(MOTIVO_ADIAMENTO_AMAZON.credencialInvalida);
    }
    throw falha;
  }
  if (tratamento.classe === 'segredo-recusado') {
    return adiado(MOTIVO_ADIAMENTO_AMAZON.segredoLwaRecusado);
  }
  const estacionamento = tratamento.estacionamento;
  if (estacionamento === null) return null;
  switch (estacionamento.tipo) {
    case 'estacionado':
    case 'ja-estacionado':
      return adiado(MOTIVO_ADIAMENTO_AMAZON.contaParada);
    case 'sem-credencial':
      return adiado(MOTIVO_ADIAMENTO_AMAZON.credencialAusente);
    case 'credencial-substituida':
      return null;
  }
}

/**
 * Error → outcome, for everything a run can throw: the routing read, the
 * context's refusals and the importer's failures. Returns the DETERMINISTIC
 * outcome, or `null` when the caller must rethrow (transient, our own config,
 * gRPC, unknown — the queue's backoff, then the hot lane).
 *
 * Most-derived FIRST where classes nest: `AmazonAuthError`, `AmazonNotFoundError`
 * and `AmazonThrottleError` before `AmazonHttpError`, or a 401 would read as a
 * plain refusal and a 404 as a 4xx park of another name. The `ErroAppAmazon` and
 * `AmazonError` bases are NEVER tested: our own misconfiguration
 * (`ConfigAmazonAusenteError`, `AmazonConfigError`) must stay loud.
 *
 * ⚠️ An SP-API 401/403 reaching this function was ALREADY retried once after a
 * forced refresh (`core/renovacaoUnica.ts`, which every SP-API reader runs
 * through): it means a role grant (L1), a precondition outside this system —
 * `adiado/sem-permissao`, and NEVER a park.
 */
export async function classificarFalhaDaTarefaAmazon(
  db: Firestore,
  err: unknown,
  contexto: ContextoAmazon | null,
  deps: DepsClassificadorAmazon,
): Promise<ResultadoNotificacaoAmazon | null> {
  // The context's refusals (`core/erros.ts`) — and the getter's, mid-import.
  if (err instanceof ChamadasAmazonDesligadasError) {
    return adiado(MOTIVO_ADIAMENTO_AMAZON.chamadasDesligadas);
  }
  if (err instanceof ConfigAmazonAusenteError || err instanceof AmazonConfigError) return null;
  if (err instanceof ContaAmazonNaoEncontradaError) return { kind: 'conta-inexistente' };
  if (err instanceof ContaAmazonInativaError) return adiado(MOTIVO_ADIAMENTO_AMAZON.contaInativa);
  if (err instanceof ContaAmazonNaoConectadaError) {
    return adiado(MOTIVO_ADIAMENTO_AMAZON.contaNaoConectada);
  }
  if (err instanceof CredencialAmazonAusenteError) {
    return adiado(MOTIVO_ADIAMENTO_AMAZON.credencialAusente);
  }
  if (err instanceof CredencialAmazonInvalidaError) {
    return adiado(MOTIVO_ADIAMENTO_AMAZON.credencialInvalida);
  }
  if (err instanceof ContaAmazonParadaError) return adiado(MOTIVO_ADIAMENTO_AMAZON.contaParada);

  // Amazon's answers: the AmazonHttpError SUBCLASSES first (docblock).
  if (err instanceof AmazonAuthError) {
    const classe = classificarFalhaAmazon(err);
    if (classe === 'renovar-acesso') return adiado(MOTIVO_ADIAMENTO_AMAZON.semPermissao);
    if (classe === 'nenhuma') return null;
    return classificarRecusaLwa(db, err, contexto, deps);
  }
  if (err instanceof AmazonNotFoundError) return { kind: 'pedido-inexistente' };
  if (err instanceof AmazonThrottleError) return null;
  if (err instanceof AmazonHttpError) {
    return err.transitorio ? null : recusa('AmazonHttpError', err.status);
  }
  if (err instanceof AmazonSchemaError) return recusa('AmazonSchemaError', err.status);
  if (err instanceof ZodError) return recusa('ZodError', null);

  // Network and timeout, the park's contention, gRPC, anything unknown: rethrown.
  return null;
}

/* -------------------------------------------------------------------------- */
/*                          The sanitizing boundary                           */
/* -------------------------------------------------------------------------- */

/** The package classes the boundary renames — each NAMED, never the `AmazonError` base. */
export type ClassePacoteAmazon =
  | 'AmazonThrottleError'
  | 'AmazonNotFoundError'
  | 'AmazonAuthError'
  | 'AmazonHttpError'
  | 'AmazonSchemaError'
  | 'AmazonTimeoutError'
  | 'AmazonNetworkError'
  | 'AmazonConfigError';

/**
 * A package error, as it may leave a run (step-3 plan §3 decision 31): its
 * class and its HTTP status or config motivo — NOTHING else. No `cause`, no
 * credential ref, no path, no operation, no request id: the task wrapper logs
 * this object whole and the shared core persists and prints its message.
 */
export class FalhaTarefaAmazonError extends Error {
  readonly classe: ClassePacoteAmazon;
  /** The HTTP status, or the `AmazonConfigError` motivo; `null` for the transport classes. */
  readonly detalhe: number | string | null;

  constructor(classe: ClassePacoteAmazon, detalhe: number | string | null) {
    const sufixo =
      detalhe === null
        ? ''
        : typeof detalhe === 'number'
          ? ` HTTP ${String(detalhe)}`
          : ` (${detalhe})`;
    super(`falha da Amazon na tarefa: ${classe}${sufixo}`);
    this.name = 'FalhaTarefaAmazonError';
    this.classe = classe;
    this.detalhe = detalhe;
  }
}

/**
 * The boundary: a package error becomes a {@link FalhaTarefaAmazonError};
 * ANYTHING else is returned as the same object (this app's own errors name
 * conta ids and keys only; gRPC and a bug stay loud). Most-derived first.
 */
export function sanitizarFalhaDaTarefaAmazon(err: unknown): unknown {
  if (err instanceof AmazonThrottleError) {
    return new FalhaTarefaAmazonError('AmazonThrottleError', err.status);
  }
  if (err instanceof AmazonNotFoundError) {
    return new FalhaTarefaAmazonError('AmazonNotFoundError', err.status);
  }
  if (err instanceof AmazonAuthError)
    return new FalhaTarefaAmazonError('AmazonAuthError', err.status);
  if (err instanceof AmazonHttpError)
    return new FalhaTarefaAmazonError('AmazonHttpError', err.status);
  if (err instanceof AmazonSchemaError) {
    return new FalhaTarefaAmazonError('AmazonSchemaError', err.status);
  }
  if (err instanceof AmazonTimeoutError)
    return new FalhaTarefaAmazonError('AmazonTimeoutError', null);
  if (err instanceof AmazonNetworkError)
    return new FalhaTarefaAmazonError('AmazonNetworkError', null);
  if (err instanceof AmazonConfigError) {
    return new FalhaTarefaAmazonError('AmazonConfigError', err.motivo);
  }
  return err;
}

/* -------------------------------------------------------------------------- */
/*                                  One run                                   */
/* -------------------------------------------------------------------------- */

/** What a run's call lines say about it: the flow, the Cloud Tasks attempt and task id. */
export interface RegistroLeituraAmazon {
  readonly fluxo: FluxoLeituraAmazon;
  /** The 0-based Cloud Tasks attempt; `null` in a sweep. */
  readonly tentativa: number | null;
  /** The Cloud Tasks task id; `null` in a sweep. */
  readonly idTarefa: string | null;
}

/**
 * ONE deps binding shared by the task and the sweeps (the functions codebase's
 * `depsLeitura.ts`, PR 3-d). The registro is added per entry point.
 */
export interface DepsLeituraAmazon extends DepsClassificadorAmazon {
  /** The process environment, from the composition root — the read switch and the LWA pair. */
  readonly ambiente: AmbienteAmazon;
  /** The importer seam: {@link importadorPedidoAmazon} in the root, a fake in tests. */
  readonly importador: ImportadorPedidoAmazon | null;
  /** Test seams, forwarded to the context's client. */
  readonly fetch?: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

export interface DepsExecucaoAmazon extends DepsLeituraAmazon {
  readonly registro: RegistroLeituraAmazon;
}

/**
 * A CEP lookup, as the order import's endereço recovery takes it: a LOCAL
 * structural port (plan §3 decision 48), read off the shared
 * `recoverEnderecoFromCep`'s own signature, so this module — which the receiver
 * imports — never names the ViaCEP module, not even by type. The functions root
 * (PR 5-e) hands in `createViaCepClient()`, which satisfies it structurally; a
 * test hands in a fake.
 */
export type BuscadorCepAmazon = Parameters<typeof recoverEnderecoFromCep>[1];

/**
 * What the step-5 importer (`pedidos/importarPedido.ts`) needs besides the db,
 * the context and the payload. Declared HERE, and the importer imports it —
 * never the reverse — so the receiver's import closure never reaches the
 * importer (plan §3 decision 48). `ImportadorPedidoAmazon` and
 * {@link processarNotificacaoAmazon} stay as they are until PR 5-e widens them.
 */
export interface DepsImportadorAmazon {
  /** Now, in MILLISECONDS — read ONCE per import. */
  readonly agora: () => number;
  /** `(by) => FieldValue.increment(by)`, for the avisos. */
  readonly increment: (by: number) => unknown;
  readonly logger: LoggerAmazon;
  readonly viaCep: BuscadorCepAmazon;
  /** The run's flow and Cloud Tasks attempt: `tentativa` `null` = a sweep re-drive. */
  readonly registro: RegistroLeituraAmazon;
}

/** What one run learned beyond its outcome, for the task's log line: the conta it ran for. */
interface RelatorioDaExecucaoAmazon {
  contaId: string | null;
}

/**
 * One notification, start to finish (module header). Deterministic outcomes
 * RETURN; everything else rethrows through the sanitizing boundary.
 */
export async function processarNotificacaoAmazon(
  db: Firestore,
  payload: PayloadNotificacaoAmazon,
  deps: DepsExecucaoAmazon,
  relatorio: RelatorioDaExecucaoAmazon = { contaId: null },
): Promise<ResultadoNotificacaoAmazon> {
  // 1. FIRST: no Firestore read, no client, nothing at all while the switch is off.
  if (!lerChaveDeChamadasAmazon(deps.ambiente)) {
    registrarChamadaBloqueadaAmazon(deps.logger, {
      rota: ROTA_INTAKE_AMAZON,
      valor: deps.ambiente[CHAMADAS_ENV_AMAZON],
    });
    return adiado(MOTIVO_ADIAMENTO_AMAZON.chamadasDesligadas);
  }

  const idNotificacao = docIdNotificacaoAmazon(payload);
  let contexto: ContextoAmazon | null = null;
  try {
    // 2. Route.
    let integracaoId: string;
    if (payload.origem === ORIGEM_NOTIFICACAO_AMAZON.push) {
      const ids = await contasPorSellingPartnerId(db, payload.sellerId);
      const [unica, outra] = ids;
      if (unica === undefined) return adiado(MOTIVO_ADIAMENTO_AMAZON.semConta);
      if (outra !== undefined) {
        registrarEventoAmazon(
          deps.logger,
          'tarefa',
          'ERROR',
          '[amazon/notificacoes] um vendedor está ligado a mais de uma conta ativa',
          { motivo: MOTIVO_ADIAMENTO_AMAZON.vendedorDuplicado, contas: ids.join(',') },
          {
            fluxo: deps.registro.fluxo,
            tentativa: deps.registro.tentativa,
            idTarefa: deps.registro.idTarefa,
            idNotificacao,
          },
        );
        return adiado(MOTIVO_ADIAMENTO_AMAZON.vendedorDuplicado);
      }
      integracaoId = unica;
    } else {
      integracaoId = payload.contaId;
    }
    relatorio.contaId = integracaoId;

    // 3. The context.
    const depsDoContexto: ContextoAmazonDeps = {
      ambiente: deps.ambiente,
      agora: deps.agora,
      logger: deps.logger,
      registro: {
        fluxo: deps.registro.fluxo,
        tentativa: deps.registro.tentativa,
        idTarefa: deps.registro.idTarefa,
        idNotificacao,
      },
      fetch: deps.fetch,
      gerarCorrelationId: deps.gerarCorrelationId,
    };
    contexto = await loadAmazonContext(db, integracaoId, depsDoContexto);
    if (
      payload.origem === ORIGEM_NOTIFICACAO_AMAZON.poll &&
      contexto.conta.selling_partner_id !== payload.sellerId
    ) {
      // ⚠️ That conta is the CACHED copy (`core/contaCache.ts`): after a
      // reconnect, a warm instance keeps the previous seller for up to the TTL.
      // A drop is irreversible (the task persists nothing, a sweep removes the
      // row), so it is never decided on that copy. Evicting the entry makes the
      // reload a Firestore read started after the eviction (`invalidate` drops
      // an in-flight entry too), and the reload re-applies every refusal, in the
      // context's order, to the fresh copy. Only a disagreement that survives it
      // drops. The miss costs one conta read and one credential read; the happy
      // path costs nothing.
      invalidarContaEmCache(integracaoId);
      contexto = await loadAmazonContext(db, integracaoId, depsDoContexto);
      if (contexto.conta.selling_partner_id !== payload.sellerId) {
        return { kind: 'vendedor-mudou' };
      }
    }

    // 4. The importer seam.
    if (deps.importador === null) return adiado(MOTIVO_ADIAMENTO_AMAZON.importadorAusente);
    return await deps.importador(db, contexto, payload);
  } catch (err) {
    // 5. Classify; whatever leaves, leaves through the boundary (module header).
    let desfecho: ResultadoNotificacaoAmazon | null;
    try {
      desfecho = await classificarFalhaDaTarefaAmazon(db, err, contexto, deps);
    } catch (falha) {
      throw sanitizarFalhaDaTarefaAmazon(falha);
    }
    if (desfecho === null) throw sanitizarFalhaDaTarefaAmazon(err);
    return desfecho;
  }
}

/** Never called: the storage-only pipeline below only persists. */
function processoIndisponivel(): Promise<ResultadoNotificacaoAmazon> {
  return Promise.reject(
    new TypeError('pipeline de armazenamento da Amazon: process não é chamado aqui'),
  );
}

/**
 * The shared-core config. ⚠️ `collection` is written EXPLICITLY: guard B
 * (`notificationGuardrails.test.ts`) ignores the shorthand form on purpose, so
 * a shorthand here would read as "this channel hand-rolled its own store".
 */
function configAmazon(
  processar: (
    db: Firestore,
    payload: PayloadNotificacaoAmazon,
  ) => Promise<ResultadoNotificacaoAmazon>,
): NotificationPipelineConfig<PayloadNotificacaoAmazon, ResultadoNotificacaoAmazon> {
  return {
    channel: CANAL_LOG_AMAZON,
    collection: notificacaoAmazonCollection,
    taskSchema: tarefaAmazonSchema,
    docIdOf: docIdNotificacaoAmazon,
    dedupKeyOf: dedupKeyAmazon,
    toDocFields: camposDoDocumentoAmazon,
    // STRICT, from the raw document: a row that no longer parses throws, and
    // the sweep's per-row boundary marks it (parking it at the cap).
    fromDoc: (_parsed, raw) => tarefaAmazonSchema.parse(raw),
    process: processar,
    toDisposition: (resultado) => toDispositionAmazon(resultado),
    // A deferred row whose precondition cleared and whose import then THREW
    // returns to the hot lane with a fresh budget (module header).
    graduateDeferredTransientErrors: true,
  };
}

/**
 * The pipeline, built PER CALL so this run's `registro` (flow, attempt, task id)
 * reaches the logger: the shared `process(db, payload)` carries neither.
 */
export function criarPipelineAmazon(
  deps: DepsExecucaoAmazon,
  relatorio?: RelatorioDaExecucaoAmazon,
) {
  return defineNotificationPipeline(
    configAmazon((db, p) => processarNotificacaoAmazon(db, p, deps, relatorio)),
  );
}

/** Persist only — the write the receiver and the poll need, which runs no `process`. */
const armazenamentoAmazon = defineNotificationPipeline(configAmazon(processoIndisponivel));

/* -------------------------------------------------------------------------- */
/*                         The task and the two sweeps                        */
/* -------------------------------------------------------------------------- */

/** What one dispatch reports, for the functions codebase's ONE log line. */
export interface ResultadoTarefaAmazon {
  readonly resultado: NotificationTaskResult<
    PayloadNotificacaoAmazon,
    ResultadoNotificacaoAmazon
  >['outcome'];
  /**
   * On `done` and `dropped` only — the arms that persist NOTHING, so the log is
   * all there is. A park, a defer or a failure writes its reason on the row.
   */
  readonly detalhe: string | null;
  /** The conta the run ran for (a push's routed one), `null` before any routing. */
  readonly contaId: string | null;
  /** From the PARSED payload; `null` when the payload never parsed. */
  readonly amazonOrderId: string | null;
  readonly origem: PayloadNotificacaoAmazon['origem'] | null;
}

/** The `detalhe` of a dispatch: present only on the arms that leave no document. */
function detalheDaTarefa(
  r: NotificationTaskResult<PayloadNotificacaoAmazon, ResultadoNotificacaoAmazon>,
): string | null {
  if (r.outcome !== 'done' && r.outcome !== 'dropped') return null;
  // A payload that failed the task schema has no outcome at all.
  return r.result?.kind ?? 'payload-invalido';
}

/** The task's registro: the intake flow, with the Cloud Tasks attempt it drives the persist by. */
export interface RegistroDaTarefaAmazon extends RegistroLeituraAmazon {
  readonly fluxo: typeof FLUXO_LEITURA_AMAZON.intake;
  readonly tentativa: number;
}

/**
 * The reads-queue body: parse, run, dispose. `deps.registro.tentativa` is the
 * 0-based Cloud Tasks attempt; on the last one a transient failure is persisted
 * as `failed` instead of rethrown.
 */
export async function tratarTarefaLeituraAmazon(
  db: Firestore,
  dados: unknown,
  deps: DepsLeituraAmazon & { readonly registro: RegistroDaTarefaAmazon },
): Promise<ResultadoTarefaAmazon> {
  const relatorio: RelatorioDaExecucaoAmazon = { contaId: null };
  const r = await criarPipelineAmazon(deps, relatorio).handleTask(
    db,
    dados,
    deps.registro.tentativa,
  );
  return {
    resultado: r.outcome,
    detalhe: detalheDaTarefa(r),
    contaId: relatorio.contaId,
    amazonOrderId: r.payload?.amazonOrderId ?? null,
    origem: r.payload?.origem ?? null,
  };
}

/** One own, data-valued string property of the raw task data, or `null` (a getter is never invoked). */
function textoBruto(dados: unknown, chave: string): string | null {
  if (typeof dados !== 'object' || dados === null) return null;
  const d = Object.getOwnPropertyDescriptor(dados, chave);
  return d !== undefined && 'value' in d && typeof d.value === 'string' ? d.value : null;
}

/** A raw value when it passes its grammar, else `null`. */
function porGramatica(valor: string | null, valido: (v: string) => boolean): string | null {
  return valor !== null && valido(valor) ? valor : null;
}

/**
 * The ids of the functions codebase's ONE log line per dispatch, read off the
 * RAW task data — so they survive a payload the schema dropped — one by one,
 * each through its own grammar (`null` otherwise): never a spread of the data,
 * which no reviewer has vetted for what it may carry, and NEVER the seller id.
 */
export function camposDoRegistroDaTarefaAmazon(
  dados: unknown,
): Readonly<Record<string, string | null>> {
  return {
    tipo: porGramatica(
      textoBruto(dados, 'tipo'),
      (v) => tipoTarefaAmazonSchema.safeParse(v).success,
    ),
    origem: porGramatica(
      textoBruto(dados, 'origem'),
      (v) => origemNotificacaoAmazonSchema.safeParse(v).success,
    ),
    amazonOrderId: porGramatica(textoBruto(dados, 'amazonOrderId'), (v) =>
      PEDIDO_AMAZON_REGEX.test(v),
    ),
    contaId: porGramatica(textoBruto(dados, 'contaId'), (v) => CONTA_ID_AMAZON_REGEX.test(v)),
    notificationId: porGramatica(textoBruto(dados, 'notificationId'), (v) =>
      NOTIFICATION_ID_AMAZON_REGEX.test(v),
    ),
  };
}

/** The sweeps' registro: no Cloud Tasks attempt, no task id. */
const REGISTRO_DA_VARREDURA: RegistroLeituraAmazon = {
  fluxo: FLUXO_LEITURA_AMAZON.reprocesso,
  tentativa: null,
  idTarefa: null,
};

/** The `onSchedule` backstop over the HOT lane (`failed`, hourly window). */
export function reprocessarNotificacoesAmazon(
  db: Firestore,
  opts: ReprocessOptions,
  deps: DepsLeituraAmazon,
): Promise<ReprocessResult> {
  return criarPipelineAmazon({ ...deps, registro: REGISTRO_DA_VARREDURA }).reprocess(db, opts);
}

/** The `onSchedule` backstop over the DEFERRED lane (`deferred`, daily window). */
export function reprocessarAdiadasAmazon(
  db: Firestore,
  opts: ReprocessOptions,
  deps: DepsLeituraAmazon,
): Promise<ReprocessResult> {
  return criarPipelineAmazon({ ...deps, registro: REGISTRO_DA_VARREDURA }).reprocessDeferred(
    db,
    opts,
  );
}

/**
 * Persist a notification as `failed`, for a producer whose ENQUEUE failed
 * (the receiver, 3-c; the poll, 4-a): the hot sweep drains it. Tier 0: the
 * core's `create` on the deterministic id, so a re-delivery of the same event —
 * or a re-poll of the same change — never forks (ALREADY_EXISTS = already
 * durable).
 */
export function persistirFalhaNotificacaoAmazon(
  db: Firestore,
  payload: PayloadNotificacaoAmazon,
  erro: string,
): Promise<void> {
  return armazenamentoAmazon.persistFailure(db, payload, erro);
}
