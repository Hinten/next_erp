/**
 * The shared task-SDK helpers (step 14, PR 14-c): MOVED out of the reads-queue
 * producer, behaviour unchanged. The transient-vs-deploy rule itself stays
 * pinned, row by row and closed over the SDK's vocabulary, by
 * `notificacoes/agendador.test.ts` — untouched by the move, and driving the
 * SAME function objects (the identity test below is what makes that true).
 * This suite adds what the move created: the re-export identity, the module's
 * own import edges, the SDK-failure description, and the named enqueue's
 * "already there" reading the NF-e producer needs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { describe, expect, it } from 'vitest';

import * as agendador from '../notificacoes/agendador';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDeConfiguracaoDoFunctions,
  falhaDeConflitoDoTasks,
  falhaDeTarefaJaExistente,
  falhaDoApp,
  falhaDoFunctions,
  rejeicaoDoTransporte,
} from '../testing/falhaDeEnfileiramento';
import {
  AmazonTarefasTransitoriasError,
  descreverFalhaDoSdkDeTarefasAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
  ehTarefaJaExistenteAmazon,
  enfileirarNomeandoFalhaTransitoriaAmazon,
  regiaoDaFilaValidaAmazon,
} from './filaTarefas';

/** The rejection of one enqueue, or a failed test when it resolved. */
async function rejeicaoDe(p: Promise<void>): Promise<unknown> {
  return p.then(
    () => expect.unreachable('o enqueue deveria ter rejeitado'),
    (e: unknown) => e,
  );
}

describe('the move — behaviour unchanged', () => {
  it('★ the reads-queue producer re-exports the SAME objects, so its callers and suite drive these', () => {
    expect(agendador.AmazonTarefasTransitoriasError).toBe(AmazonTarefasTransitoriasError);
    expect(agendador.ehFalhaDoSdkDeTarefasAmazon).toBe(ehFalhaDoSdkDeTarefasAmazon);
    expect(agendador.enfileirarNomeandoFalhaTransitoriaAmazon).toBe(
      enfileirarNomeandoFalhaTransitoriaAmazon,
    );
    expect(agendador.regiaoDaFilaValidaAmazon).toBe(regiaoDaFilaValidaAmazon);
  });

  it('★ the module imports the two SDK error modules and NOTHING else — no notificacoes/, context, env or package edge, type edges included', () => {
    const fonte = readFileSync(fileURLToPath(new URL('./filaTarefas.ts', import.meta.url)), 'utf8');
    const especificadores = [...fonte.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(especificadores.sort()).toEqual(['firebase-admin/app', 'firebase-admin/functions']);
    // Anti-vacuity: the reads-queue producer DOES reach `./notificacao` by value,
    // which is why the helpers could not stay there.
    const doAgendador = readFileSync(
      fileURLToPath(new URL('../notificacoes/agendador.ts', import.meta.url)),
      'utf8',
    );
    expect(doAgendador).toMatch(/from '\.\/notificacao'/);
    expect(doAgendador).not.toMatch(/from 'firebase-admin\//);
  });

  it('the transient naming still names a 503 and rethrows a 404 untouched (a sample; the closed table is agendador.test.ts)', async () => {
    expect(
      await rejeicaoDe(rejeicaoDoTransporte(falhaDoFunctions('unknown-error'))),
    ).toBeInstanceOf(AmazonTarefasTransitoriasError);
    const sdk = falhaDoFunctions('not-found', 404);
    expect(await rejeicaoDe(rejeicaoDoTransporte(sdk))).toBe(sdk);
  });

  it('the region grammar is unchanged', () => {
    expect(regiaoDaFilaValidaAmazon('xx-regiao1')).toBe(true);
    for (const r of ['', 'a/b', 'XX-REGIAO1', ' xx'])
      expect(regiaoDaFilaValidaAmazon(r), r).toBe(false);
  });
});

describe('descreverFalhaDoSdkDeTarefasAmazon — class and code, never a message', () => {
  it('names both SDK classes by code', () => {
    expect(descreverFalhaDoSdkDeTarefasAmazon(falhaDoFunctions('permission-denied', 403))).toBe(
      'FirebaseFunctionsError/functions/permission-denied',
    );
    expect(descreverFalhaDoSdkDeTarefasAmazon(falhaDoApp('invalid-credential'))).toBe(
      'FirebaseAppError/app/invalid-credential',
    );
    // The SDK's own message DOES quote the body; the description never does.
    for (const err of [falhaDoFunctions('unknown-error'), falhaDoApp('network-error')]) {
      expect(err.message).toContain(CORPO_DA_RESPOSTA_DO_TASKS);
      expect(descreverFalhaDoSdkDeTarefasAmazon(err)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    }
  });
});

describe('ehTarefaJaExistenteAmazon — a NAMED enqueue whose id Cloud Tasks already holds', () => {
  it('★ the SDK’s 409 for a named task, answered ALREADY_EXISTS ⇒ already there', () => {
    expect(ehTarefaJaExistenteAmazon(falhaDeTarefaJaExistente('a1b2'))).toBe(true);
  });

  it('a 409 whose body names no status (a non-JSON answer reaches the SDK as text) ⇒ the SDK’s code is believed', () => {
    const texto = new FirebaseFunctionsError({
      code: 'task-already-exists',
      message: 'A task with ID a1b2 already exists',
      httpResponse: { status: 409, headers: {}, data: CORPO_DA_RESPOSTA_DO_TASKS },
    });
    expect(ehTarefaJaExistenteAmazon(texto)).toBe(true);
  });

  it.each<[string, () => unknown]>([
    // ★ The same SDK code, the same status — a concurrency conflict, not a held id.
    ['the same 409 answered ABORTED', () => falhaDeTarefaJaExistente('a1b2', 'ABORTED')],
    ['the unnamed producer’s 409 (ABORTED)', () => falhaDeConflitoDoTasks()],
    [
      'task-already-exists with NO response',
      () => new FirebaseFunctionsError({ code: 'task-already-exists', message: 'sem resposta' }),
    ],
    [
      'task-already-exists at a status other than 409',
      () =>
        new FirebaseFunctionsError({
          code: 'task-already-exists',
          message: 'x',
          httpResponse: { status: 503, headers: {}, data: {} },
        }),
    ],
    ['a 503', () => falhaDoFunctions('unknown-error')],
    ['a config failure', () => falhaDeConfiguracaoDoFunctions('projeto')],
    ['an app socket failure', () => falhaDoApp('network-error')],
    ['a look-alike object', () => ({ code: 'functions/task-already-exists' })],
    ['a plain Error', () => new Error('functions/task-already-exists')],
    ['a NAMED transient', () => AmazonTarefasTransitoriasError.porPrazo()],
  ])('NEAR-MISS: %s ⇒ not "already there"', (_caso, falha) => {
    expect(ehTarefaJaExistenteAmazon(falha())).toBe(false);
  });

  it('an ABORTED named 409 still comes out of the naming as a TRANSIENT — surfaced, never dropped', async () => {
    const err = await rejeicaoDe(rejeicaoDoTransporte(falhaDeTarefaJaExistente('a1b2', 'ABORTED')));
    expect(err).toBeInstanceOf(AmazonTarefasTransitoriasError);
    expect(err).toMatchObject({ codigo: 'functions/task-already-exists', httpStatus: 409 });
  });

  it('ehFalhaDoSdkDeTarefasAmazon still narrows both classes', () => {
    expect(ehFalhaDoSdkDeTarefasAmazon(falhaDeTarefaJaExistente('a1b2'))).toBe(true);
    expect(
      ehFalhaDoSdkDeTarefasAmazon(new FirebaseAppError({ code: 'no-app', message: 'x' })),
    ).toBe(true);
    expect(ehFalhaDoSdkDeTarefasAmazon(new Error('x'))).toBe(false);
  });
});
