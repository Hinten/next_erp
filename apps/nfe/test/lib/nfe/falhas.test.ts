/**
 * `descreverFalhaConhecida` — the ONE table of failure classes a catch in
 * apps/nfe may report instead of rethrowing (#1654, rule 6). A class the table
 * does not know is a bug: the caller rethrows it, so it fails loudly instead
 * of being recorded as an ordinary per-doc error.
 *
 * Pinned here:
 *  - every class in the table maps to its LITERAL code, from a real instance
 *    built by its own constructor — the code equals the class's `name`, which
 *    is what the batch path (`toEmitError`) reported before it read this
 *    table, except where that name is the bare `'Error'`;
 *  - a subclass is reported through its parent (`NFeDocAusenteError` →
 *    `'NFeOrchestratorError'`), and no table entry is shadowed by an earlier
 *    parent;
 *  - an Admin-SDK Firestore failure (an `Error` with a numeric gRPC code
 *    1–16) is `'FirestoreRpcError'`; the near-misses stay out;
 *  - the backstop: every `*Error` class exported by
 *    `@delfrance/integrations-nfe`, by apps/nfe's `runtime.ts`, `tasks.ts`
 *    and `orchestrator/errors.ts`, and by the modules the Cloud Tasks enqueue
 *    raises from (`@delfrance/core/region`, `firebase-admin/functions`,
 *    `firebase-admin/app`) is either in the table (itself or through a
 *    parent) or in {@link NAO_REPORTAVEIS} with the reason it never reaches a
 *    reporting catch. A new exported class fails here until it is placed.
 */
import { describe, expect, it } from 'vitest';
import * as firebaseApp from 'firebase-admin/app';
import { AppErrorCode, FirebaseAppError } from 'firebase-admin/app';
import * as firebaseFunctions from 'firebase-admin/functions';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { ZodError } from 'zod';

import * as regiao from '@delfrance/core/region';
import { MissingRegionError, requireRegion } from '@delfrance/core/region';
import * as nfe from '@delfrance/integrations-nfe';
import {
  NFeConsumoIndevidoError,
  NFeDetError,
  NFePartiesError,
  NFeTransportError,
  NFeXsdValidationError,
} from '@delfrance/integrations-nfe';

import * as orquestrador from '../../../lib/nfe/orchestrator/errors';
import {
  NFeDocAusenteError,
  NFeMissingImpostoError,
  NFeOrchestratorError,
} from '../../../lib/nfe/orchestrator/errors';
import { descreverFalhaConhecida, FALHAS_CONHECIDAS } from '../../../lib/nfe/orchestrator/falhas';
import * as runtime from '../../../lib/nfe/runtime';
import * as tasks from '../../../lib/nfe/tasks';

type Classe = abstract new (...args: never[]) => Error;

/** What `requireRegion` throws when `NFE_TASKS_REGION` is unset. */
function regiaoAusente(): MissingRegionError {
  try {
    requireRegion({ NFE_TASKS_REGION: undefined });
  } catch (e) {
    if (e instanceof MissingRegionError) return e;
    throw e;
  }
  throw new TypeError('requireRegion aceitou uma região ausente');
}

/** A REAL instance of `C`, built by its own constructor. */
function instanciaDe(C: Classe): Error {
  const especiais = new Map<Classe, () => Error>([
    [
      NFeConsumoIndevidoError,
      () =>
        new NFeConsumoIndevidoError({
          cStat: '656',
          xMotivo: 'Rejeicao: Consumo Indevido',
          source: 'falhas.test',
        }),
    ],
    [
      NFeXsdValidationError,
      () => new NFeXsdValidationError('enviNFe', [{ message: 'campo inválido', line: 1 }]),
    ],
    [NFeMissingImpostoError, () => new NFeMissingImpostoError('PED-1', 'PROD-1', 0)],
    [tasks.NFeTasksConfigError, () => new tasks.NFeTasksConfigError(['NFE_TASKS_REGION'])],
    [ZodError, () => new ZodError([])],
    [
      FirebaseFunctionsError,
      () => new FirebaseFunctionsError({ code: 'unavailable', message: 'fila indisponível' }),
    ],
    // As the Admin SDK's HttpClient builds it once its retries are spent.
    [
      FirebaseAppError,
      () =>
        new FirebaseAppError({
          code: AppErrorCode.NETWORK_ERROR,
          message: 'Error while making request: socket hang up. Error code: ECONNRESET',
        }),
    ],
    // The very error an unset NFE_TASKS_REGION raises in `tasks.ts`.
    [MissingRegionError, regiaoAusente],
  ]);
  const especial = especiais.get(C);
  return especial ? especial() : new (C as unknown as new (m: string) => Error)('falha de teste');
}

/**
 * Classes whose `name` is not their code: `FirebaseFunctionsError` and
 * `FirebaseAppError` never set one, so they inherit `'Error'` — the literal
 * code is what names them.
 */
const NAME_NAO_E_O_CODIGO: ReadonlySet<Classe> = new Set<Classe>([
  FirebaseFunctionsError,
  FirebaseAppError,
]);

/**
 * Exported error classes that are deliberately NOT in the table, keyed
 * `<module>:<name>`, each with the reason no reporting catch ever sees one.
 * (Two browser classes share a name with apps/nfe's own — the key keeps them
 * apart.)
 */
const NAO_REPORTAVEIS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      'NFeAuthError',
      'NFeBadRequestError',
      'NFeBlockedError',
      'NFeHttpError',
      'NFeNetworkError',
      'NFePedidoNotFoundError',
      'NFeRejectedError',
      'NFeRuntimeNotReadyError',
      'NFeServerError',
    ].map((nome) => [
      `integrations-nfe:${nome}`,
      'browser-side HTTP client error (`http-provider`, apps/web → apps/nfe) — never thrown inside apps/nfe',
    ]),
  ),
  'integrations-nfe:NFeInutilizacaoError':
    'thrown only by `inutilizarNumeracao`, behind `POST /inutilizar`, which answers it itself',
  'integrations-nfe:NFeBulkSizeError':
    '`nextNumeracaoBulk` has no caller in apps/nfe — the batch allocates inside its own transaction',
  'orchestrator/errors:NFeInutilizacaoAbortedError':
    'a precondition of `POST /inutilizar` (409) — never raised by emit, reconcile or the sweep',
  'orchestrator/errors:NFeDanfeError':
    'a presentation precondition of the DANFE routes (422) — never raised by emit, reconcile or the sweep',
  'orchestrator/errors:NFeCancelamentoError':
    'the cancelamento route’s own rejection (422) — never raised by emit, reconcile or the sweep',
  'firebase-admin/app:FirebaseError':
    'the Admin SDK’s base class, never thrown itself — tabling it would admit every product’s ' +
    'error (auth, storage, …); only the enqueue’s own two subclasses are in the table',
};

/** Every class a module exports that extends `Error` — found by value, not by name. */
function classesDeErro(modulo: Readonly<Record<string, unknown>>): Array<[string, Classe]> {
  return Object.entries(modulo)
    .filter(
      (entrada): entrada is [string, Classe] =>
        typeof entrada[1] === 'function' &&
        (entrada[1] as { prototype?: unknown }).prototype instanceof Error,
    )
    .sort(([a], [b]) => a.localeCompare(b));
}

/** True when the table reports `C` — the class itself, or a parent of it. */
function naTabela(C: Classe): boolean {
  return FALHAS_CONHECIDAS.some(([T]) => C === T || C.prototype instanceof T);
}

describe('descreverFalhaConhecida — the table', () => {
  it.each(FALHAS_CONHECIDAS.map(([C, codigo]) => [codigo, C] as const))(
    '%s — a real instance maps to its literal code and its own message',
    (codigo, C) => {
      const e = instanciaDe(C);
      expect(e).toBeInstanceOf(C);
      expect(descreverFalhaConhecida(e)).toEqual({ codigo, mensagem: e.message });
      // The literal is the class's own name…
      expect(codigo).toBe(C.name);
      // …and, unless the class never sets one, the `name` the batch path
      // reported before it read this table, so the codes do not move.
      if (!NAME_NAO_E_O_CODIGO.has(C)) expect(e.name).toBe(codigo);
    },
  );

  it('carries the classes NFeDetError and NFePartiesError, now exported by the package', () => {
    expect(descreverFalhaConhecida(new NFeDetError('item sem NCM'))).toEqual({
      codigo: 'NFeDetError',
      mensagem: 'item sem NCM',
    });
    expect(descreverFalhaConhecida(new NFePartiesError('filial.cnpj is required'))).toEqual({
      codigo: 'NFePartiesError',
      mensagem: 'filial.cnpj is required',
    });
  });

  it('a subclass maps through its parent: NFeDocAusenteError → NFeOrchestratorError', () => {
    const e = new NFeDocAusenteError('pedidos/P1/nfev4/s1', 'nfev4 pedidos/P1/nfev4/s1 ausente');
    expect(e).toBeInstanceOf(NFeOrchestratorError);
    expect(descreverFalhaConhecida(e)).toEqual({
      codigo: 'NFeOrchestratorError',
      mensagem: 'nfev4 pedidos/P1/nfev4/s1 ausente',
    });
  });

  it('no entry is shadowed: a class never follows one of its own parents', () => {
    FALHAS_CONHECIDAS.forEach(([posterior], j) => {
      FALHAS_CONHECIDAS.slice(0, j).forEach(([anterior]) => {
        expect(posterior.prototype instanceof anterior).toBe(false);
      });
    });
  });

  it('every code is unique', () => {
    const codigos = FALHAS_CONHECIDAS.map(([, codigo]) => codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
  });
});

describe('descreverFalhaConhecida — Firestore gRPC failures and what stays out', () => {
  it.each([1, 3, 5, 9, 14, 16])(
    'an Error with the gRPC code %i → FirestoreRpcError, its own message',
    (code) => {
      const e = Object.assign(new Error(`${code} STATUS: detalhe`), { code });
      expect(descreverFalhaConhecida(e)).toEqual({
        codigo: 'FirestoreRpcError',
        mensagem: `${code} STATUS: detalhe`,
      });
    },
  );

  it.each<[string, unknown]>([
    ['an Error with code 99 (not a gRPC status)', Object.assign(new Error('x'), { code: 99 })],
    ['an Error with code 0', Object.assign(new Error('x'), { code: 0 })],
    ["an Error with the string code '14'", Object.assign(new Error('x'), { code: '14' })],
    ['a plain Error', new Error('bug')],
    ['a TypeError', new TypeError("Cannot read properties of undefined (reading 'x')")],
    ['a RangeError', new RangeError('Invalid array length')],
    ['a SyntaxError', new SyntaxError('Unexpected token')],
    ['a plain object {code: 14, message}', { code: 14, message: 'não é um Error' }],
    ['a string', 'falhou'],
    ['null', null],
    ['undefined', undefined],
    // Same NAME as apps/nfe's own classes, but the browser client's — never ours.
    ['the browser NFeBlockedError', new nfe.NFeBlockedError('PED-1', {})],
    ['the browser NFePedidoNotFoundError', new nfe.NFePedidoNotFoundError('PED-1', {})],
  ])('%s → null (the caller rethrows it)', (_caso, e) => {
    expect(descreverFalhaConhecida(e)).toBeNull();
  });

  it('a known class is reported even when it carries a numeric code of its own', () => {
    const e = Object.assign(new NFeTransportError('ECONNRESET'), { code: 14 });
    expect(descreverFalhaConhecida(e)).toEqual({
      codigo: 'NFeTransportError',
      mensagem: 'ECONNRESET',
    });
  });
});

describe('backstop — every exported error class is placed', () => {
  const modulos: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
    ['integrations-nfe', nfe],
    ['runtime', runtime],
    ['tasks', tasks],
    ['orchestrator/errors', orquestrador],
    // What `tasks.ts`'s enqueue raises — after the lote was sent.
    ['core/region', regiao],
    ['firebase-admin/functions', firebaseFunctions],
    ['firebase-admin/app', firebaseApp],
  ];
  const exportadas = modulos.flatMap(([modulo, m]) =>
    classesDeErro(m).map(([nome, C]) => [`${modulo}:${nome}`, C] as const),
  );

  it('the scan finds the classes it is meant to judge', () => {
    const chaves = exportadas.map(([chave]) => chave);
    expect(chaves).toEqual(
      expect.arrayContaining([
        'integrations-nfe:NFeTransportError',
        'integrations-nfe:NFeDetError',
        'integrations-nfe:NFePartiesError',
        'runtime:NFeRuntimeConfigError',
        'tasks:NFeTasksConfigError',
        'orchestrator/errors:NFeDocAusenteError',
        'core/region:MissingRegionError',
        'firebase-admin/functions:FirebaseFunctionsError',
        'firebase-admin/app:FirebaseAppError',
        'firebase-admin/app:FirebaseError',
      ]),
    );
  });

  it.each(exportadas)(
    '%s is in the table (itself or a parent) or listed as not reportable',
    (chave, C) => {
      const listada = Object.prototype.hasOwnProperty.call(NAO_REPORTAVEIS, chave);
      expect(
        naTabela(C) || listada,
        `${chave}: add it to FALHAS_CONHECIDAS (orchestrator/falhas.ts) with its literal ` +
          'code, or to NAO_REPORTAVEIS here with the reason no reporting catch ever sees it',
      ).toBe(true);
      // Never both — a listed class the table also reports is a stale entry.
      expect(naTabela(C) && listada).toBe(false);
    },
  );

  it('NAO_REPORTAVEIS has no stale entry', () => {
    const chaves = new Set<string>(exportadas.map(([chave]) => chave));
    expect(Object.keys(NAO_REPORTAVEIS).filter((k) => !chaves.has(k))).toEqual([]);
  });
});
