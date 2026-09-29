/**
 * The ONE table of failure classes apps/nfe may REPORT instead of rethrowing
 * (#1654, root CLAUDE.md rule 6).
 *
 * A catch that records a failure and carries on — the backstop sweep's four
 * per-item catches (`runProcessarPendentes`) and the batch emit's per-member
 * report (`toEmitError`, `emitir.ts`) — asks
 * {@link descreverFalhaConhecida} what it caught: a known class comes back as
 * `{ codigo, mensagem }`, anything else as `null`, and the caller rethrows it.
 * An unknown class is a bug, and a bug recorded as an ordinary per-doc error
 * reads as a SEFAZ or Firestore hiccup forever; rethrown, it fails the run
 * loudly — the scheduled function errors and the next tick retries, the manual
 * sweep route and `POST /emitir-lote` answer 500.
 *
 * Every code is a LITERAL, not `e.name`: it names the class even where the
 * class never sets `name` (`FirebaseFunctionsError` and `FirebaseAppError`
 * inherit `'Error'`, which is what the batch path reported for them before it
 * read this table), and it cannot drift with a rename. For every other class it equals the `name` the
 * batch path has always reported. A subclass is reported through its
 * parent — `NFeDocAusenteError` is an `'NFeOrchestratorError'` — and an entry
 * never follows one of its own parents, or the parent would shadow it
 * (`falhas.test.ts` pins both, and that every exported error class is either
 * here or deliberately left out).
 *
 * An Admin-SDK Firestore failure (an `Error` with a numeric gRPC code 1–16,
 * `isGrpcStatusError`) is `'FirestoreRpcError'`, checked after the table.
 */
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { ZodError } from 'zod';

import { MissingRegionError } from '@delfrance/core/region';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import {
  NFeCertError,
  NFeChaveError,
  NFeConfigNotFoundError,
  NFeConsumoIndevidoError,
  NFeContingencyEndpointError,
  NFeDetError,
  NFeEndpointError,
  NFeEventoError,
  NFeGeneratorError,
  NFeIdeError,
  NFePartiesError,
  NFeProductionGuardError,
  NFeSignatureError,
  NFeTransportError,
  NFeTributeError,
  NFeTzError,
  NFeXmlError,
  NFeXsdValidationError,
  TributeFormatError,
} from '@delfrance/integrations-nfe';

import { NFeRuntimeConfigError } from '../runtime';
import { NFeTasksConfigError, NFeTasksEnqueueError } from '../tasks';
import {
  NFeBlockedError,
  NFeCartaCorrecaoError,
  NFeMissingImpostoError,
  NFeOrchestratorError,
  NFePedidoNotFoundError,
} from './errors';

/** A class whose instances the table recognises. */
type ClasseDeFalha = abstract new (...args: never[]) => Error;

/**
 * Known failure class → its literal code. Order matters only between a class
 * and its own subclass: the subclass comes first.
 */
export const FALHAS_CONHECIDAS: ReadonlyArray<readonly [ClasseDeFalha, string]> = [
  // The orchestrator's own preconditions.
  [NFeBlockedError, 'NFeBlockedError'],
  [NFePedidoNotFoundError, 'NFePedidoNotFoundError'],
  [NFeMissingImpostoError, 'NFeMissingImpostoError'],
  [NFeOrchestratorError, 'NFeOrchestratorError'],
  [NFeConfigNotFoundError, 'NFeConfigNotFoundError'],
  // Certificate, runtime and endpoint configuration.
  [NFeCertError, 'NFeCertError'],
  [NFeRuntimeConfigError, 'NFeRuntimeConfigError'],
  [NFeTasksConfigError, 'NFeTasksConfigError'],
  [NFeEndpointError, 'NFeEndpointError'],
  [NFeContingencyEndpointError, 'NFeContingencyEndpointError'],
  // Generation of the NF-e (a pós-EPEC transmission generates nothing, but
  // shares the emit path's classes).
  [NFeGeneratorError, 'NFeGeneratorError'],
  [NFeChaveError, 'NFeChaveError'],
  [NFeIdeError, 'NFeIdeError'],
  [NFeTzError, 'NFeTzError'],
  [NFeDetError, 'NFeDetError'],
  [NFePartiesError, 'NFePartiesError'],
  [NFeTributeError, 'NFeTributeError'],
  [TributeFormatError, 'TributeFormatError'],
  [NFeSignatureError, 'NFeSignatureError'],
  [NFeProductionGuardError, 'NFeProductionGuardError'],
  // SEFAZ transport and wire.
  [NFeTransportError, 'NFeTransportError'],
  [NFeXsdValidationError, 'NFeXsdValidationError'],
  [NFeXmlError, 'NFeXmlError'],
  [NFeEventoError, 'NFeEventoError'],
  [NFeConsumoIndevidoError, 'NFeConsumoIndevidoError'],
  [NFeCartaCorrecaoError, 'NFeCartaCorrecaoError'],
  // A stored doc that fails its schema.
  [ZodError, 'ZodError'],
  // The Cloud Tasks enqueue (`tasks.ts`), which runs AFTER the lote was sent
  // and its members persisted in flight on their nRec — so each of its
  // failures must stay that member's report, never fail the batch. The Admin
  // SDK wraps only an HTTP error reply in `FirebaseFunctionsError`; a network
  // error, a timeout or a credential it could not mint a token for is a
  // `FirebaseAppError` — a SIBLING class, not a subclass
  // (`apps/functions/src/produtos/kitRollupTasks.ts` contains the same two).
  // The service-account lookup it does NOT wrap — the metadata server, asked
  // on each instance's first enqueue under Application Default Credentials —
  // fails as gaxios' `GaxiosError`, which `tasks.ts` converts to
  // `NFeTasksEnqueueError`. `MissingRegionError` is an unset `NFE_TASKS_REGION`
  // (`requireRegion`). Anything else the enqueue throws is a bug and is
  // rethrown, like any other unknown class.
  [FirebaseFunctionsError, 'FirebaseFunctionsError'],
  [FirebaseAppError, 'FirebaseAppError'],
  [NFeTasksEnqueueError, 'NFeTasksEnqueueError'],
  [MissingRegionError, 'MissingRegionError'],
];

/** The code of an Admin-SDK Firestore failure — any non-OK gRPC status. */
export const CODIGO_FIRESTORE_RPC = 'FirestoreRpcError';

/** What a reporting catch records for a known failure. */
export interface FalhaConhecida {
  /** The class's literal code (see {@link FALHAS_CONHECIDAS}). */
  readonly codigo: string;
  /** The error's own message — the text a report has always carried. */
  readonly mensagem: string;
}

/**
 * `{ codigo, mensagem }` for a failure of a known class, or `null` — and on
 * `null` the caller rethrows (rule 6): it caught a bug, not a failure.
 */
export function descreverFalhaConhecida(e: unknown): FalhaConhecida | null {
  for (const [Classe, codigo] of FALHAS_CONHECIDAS) {
    if (e instanceof Classe) return { codigo, mensagem: e.message };
  }
  if (isGrpcStatusError(e)) return { codigo: CODIGO_FIRESTORE_RPC, mensagem: e.message };
  return null;
}
