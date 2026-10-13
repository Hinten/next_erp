/**
 * The reads-queue producer, offline: the valve, the payload-only enqueue and the
 * transient-vs-deploy narrowing, driven with the Admin SDK's REAL error classes
 * and their STRING codes (`testing/falhaDeEnfileiramento.ts`). No transport is
 * real and no network is reachable: the queue is a recording fake.
 */
import { AppErrorCode, type FirebaseAppError } from 'firebase-admin/app';
import { type FirebaseFunctionsError, FunctionsErrorCode } from 'firebase-admin/functions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import { LiError } from '@delfrance/integrations-loja-integrada';
import { ORIGEM_NOTIFICACAO_LI, TIPO_TAREFA_LI } from '@delfrance/schemas';

import { LiAppError } from '../core/erros';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDeConfiguracaoDoFunctions,
  falhaDoApp,
  falhaDoFunctions,
  rejeicaoDoTransporte,
} from '../testing/falhaDeEnfileiramento';
import {
  type FilaLeituraLi,
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  criarAgendadorLi,
  enfileirarNomeandoFalhaTransitoriaLi,
} from './agendador';
import type { PayloadNotificacaoLi } from './notificacao';

const PAYLOAD: PayloadNotificacaoLi = {
  tipo: TIPO_TAREFA_LI.pedido,
  contaId: 'conta-li-1',
  numero: '1234',
  origem: ORIGEM_NOTIFICACAO_LI.poll,
  dataModificacaoLi: '2026-10-13T08:15:58.123456',
};

/** Every `fetch` is a failure: the producer must never reach the network itself. */
const chamadasDeRede: string[] = [];
vi.stubGlobal('fetch', (input: unknown) => {
  chamadasDeRede.push(String(input));
  return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
});
afterEach(() => {
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/** A queue that records every enqueue with ALL its arguments, and how often it was resolved. */
function filaGravadora(falha?: () => unknown) {
  const enqueue = vi.fn((..._args: unknown[]): Promise<void> => {
    if (falha === undefined) return Promise.resolve();
    return Promise.reject(falha());
  });
  const fila: FilaLeituraLi = { enqueue: (payload) => enqueue(payload) };
  const resolver = vi.fn(() => fila);
  return { enqueue, resolver };
}

/** The rejection of one enqueue, or a failed test when it resolved. */
async function rejeicaoDe(p: Promise<void>): Promise<unknown> {
  return p.then(
    () => expect.unreachable('o enqueue deveria ter rejeitado'),
    (e: unknown) => e,
  );
}

describe('criarAgendadorLi — the valve', () => {
  it('closed: every enqueue rejects with LiTarefasDesligadasError and the queue is NEVER resolved', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorLi({ fila: resolver, desligado: true });

    await expect(agendador.enfileirar(PAYLOAD)).rejects.toBeInstanceOf(LiTarefasDesligadasError);
    await expect(agendador.enfileirar(PAYLOAD)).rejects.toBeInstanceOf(LiTarefasDesligadasError);

    // Sweep-only mode must work before the queue IAM exists, so it may not even
    // build the queue handle.
    expect(resolver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('open: one enqueue resolves the queue once and sends the payload ALONE — no task id, no uri', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorLi({ fila: resolver, desligado: false });

    await agendador.enfileirar(PAYLOAD);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // The whole argument list, not a `toHaveBeenCalledWith` prefix: a second
    // argument (`{ id }`, `{ uri }`, `{ scheduleDelaySeconds }`) is the defect.
    expect(enqueue.mock.calls[0]).toEqual([PAYLOAD]);
  });

  it('open: the queue is resolved PER enqueue, so a root reads its region at send time', async () => {
    const { resolver } = filaGravadora();
    const agendador = criarAgendadorLi({ fila: resolver, desligado: false });

    await agendador.enfileirar(PAYLOAD);
    await agendador.enfileirar({ ...PAYLOAD, numero: '1235' });

    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("a root's region guard rejects THAT enqueue, untouched — it is a deploy error, never transient", async () => {
    const semRegiao = new MissingRegionError('sem região', ['LOJA_INTEGRADA_TASKS_REGION']);
    const agendador = criarAgendadorLi({
      fila: () => {
        throw semRegiao;
      },
      desligado: false,
    });

    expect(await rejeicaoDe(agendador.enfileirar(PAYLOAD))).toBe(semRegiao);
  });

  it('the valve error names the variable and the sweep, and is about the deployment, not a conta', () => {
    const err = new LiTarefasDesligadasError();
    expect(err.message).toContain('LOJA_INTEGRADA_TASKS_DISABLED=1');
    expect(err.message).toContain('varredura');
    expect(err.name).toBe('LiTarefasDesligadasError');
    // A `catch` written for a conta's refusal, or for a Loja Integrada answer,
    // must never swallow it.
    expect(err).not.toBeInstanceOf(LiAppError);
    expect(err).not.toBeInstanceOf(LiError);
  });
});

describe('enfileirarNomeandoFalhaTransitoriaLi — transient vs deploy', () => {
  it.each<[string, () => Error, string, number | null]>([
    [
      '503 → functions/unknown-error',
      () => falhaDoFunctions('unknown-error'),
      'functions/unknown-error',
      503,
    ],
    [
      '429 → functions/unknown-error',
      () => falhaDoFunctions('unknown-error', 429),
      'functions/unknown-error',
      429,
    ],
    [
      '500 → functions/internal-error',
      () => falhaDoFunctions('internal-error', 500),
      'functions/internal-error',
      500,
    ],
    ['409 → functions/aborted', () => falhaDoFunctions('aborted', 409), 'functions/aborted', 409],
    ['socket → app/network-error', () => falhaDoApp('network-error'), 'app/network-error', null],
    [
      'timeout → app/network-timeout',
      () => falhaDoApp('network-timeout'),
      'app/network-timeout',
      null,
    ],
  ])('a TRANSIENT failure (%s) comes out named', async (_nome, falha, codigo, status) => {
    const err = await rejeicaoDe(rejeicaoDoTransporte(falha()));

    expect(err).toBeInstanceOf(LiTarefasTransitoriasError);
    expect(err).toMatchObject({ codigo, httpStatus: status });
    expect((err as LiTarefasTransitoriasError).classe).toBe(
      codigo.startsWith('app/') ? 'FirebaseAppError' : 'FirebaseFunctionsError',
    );
  });

  it('the named error carries the class, code and status ONLY — never the body the SDK quoted, never a cause', async () => {
    const err = await rejeicaoDe(rejeicaoDoTransporte(falhaDoFunctions('unknown-error')));

    expect(err).toBeInstanceOf(LiTarefasTransitoriasError);
    const e = err as LiTarefasTransitoriasError;
    expect(e.message).toBe(
      'enqueue no Cloud Tasks falhou de forma transitória (FirebaseFunctionsError functions/unknown-error, HTTP 503)',
    );
    expect(e.message).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(JSON.stringify(e)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(e.cause).toBeUndefined();
    // Anti-vacuity: the SDK's own message really does quote the body.
    expect(falhaDoFunctions('unknown-error').message).toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(falhaDoApp('network-error').message).toContain(CORPO_DA_RESPOSTA_DO_TASKS);
  });

  // The `FirebaseAppError` arm builds its own named error, so the assertion above
  // (a `functions/*` failure) says nothing about it. The fixture's socket message
  // carries the sentinel too (asserted just above), so a leak shows here.
  it.each([['network-error'], ['network-timeout']])(
    'the app/%s named error carries the class and code ONLY — never the SDK message, never a cause',
    async (code) => {
      const err = await rejeicaoDe(rejeicaoDoTransporte(falhaDoApp(code)));

      expect(err).toBeInstanceOf(LiTarefasTransitoriasError);
      const e = err as LiTarefasTransitoriasError;
      expect(e.message).toBe(
        `enqueue no Cloud Tasks falhou de forma transitória (FirebaseAppError app/${code})`,
      );
      expect(e.message).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
      expect(JSON.stringify(e)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
      expect(e.cause).toBeUndefined();
    },
  );

  // ⚠️ NEAR-MISS pairs. The same `functions/unknown-error` is transient with a
  // response and a config error without one; `not-found` and
  // `permission-denied` are a broken deploy even though Cloud Tasks answered.
  it.each<[string, () => Error]>([
    [
      'functions/unknown-error WITHOUT a response (project)',
      () => falhaDeConfiguracaoDoFunctions('projeto'),
    ],
    [
      'functions/unknown-error WITHOUT a response (service account)',
      () => falhaDeConfiguracaoDoFunctions('conta-de-servico'),
    ],
    ['functions/not-found (no queue in that region)', () => falhaDoFunctions('not-found', 404)],
    [
      'functions/permission-denied (no enqueuer role)',
      () => falhaDoFunctions('permission-denied', 403),
    ],
    ['functions/unauthenticated', () => falhaDoFunctions('unauthenticated', 401)],
    ['functions/invalid-argument', () => falhaDoFunctions('invalid-argument', 400)],
    ['app/invalid-credential', () => falhaDoApp('invalid-credential')],
    ['a plain TypeError', () => new TypeError('bug')],
  ])('a DEPLOY-shaped failure (%s) is rethrown UNTOUCHED', async (_nome, falha) => {
    const sdk = falha();
    expect(await rejeicaoDe(rejeicaoDoTransporte(sdk))).toBe(sdk);
  });

  it('a non-Error rejection is rethrown as is', async () => {
    const lancado = { qualquer: 'coisa' };
    expect(
      await rejeicaoDe(enfileirarNomeandoFalhaTransitoriaLi(() => Promise.reject(lancado))),
    ).toBe(lancado);
  });

  it('a transport that throws SYNCHRONOUSLY is narrowed the same way', async () => {
    const err = await rejeicaoDe(
      enfileirarNomeandoFalhaTransitoriaLi(() => {
        throw falhaDoFunctions('unknown-error');
      }),
    );
    expect(err).toBeInstanceOf(LiTarefasTransitoriasError);
  });

  it('a success resolves, untouched', async () => {
    await expect(
      enfileirarNomeandoFalhaTransitoriaLi(() => Promise.resolve()),
    ).resolves.toBeUndefined();
  });
});

/**
 * The transient set is CLOSED over the pinned SDK's own vocabulary. The
 * near-miss rows above name deploy codes one by one, so a code added to the set
 * that none of them names (`failed-precondition`, `task-already-exists`,
 * `app/internal-error`, `app/unable-to-parse-response`) passed all of them. This
 * table gives EVERY code the two classes declare a disposition: a `functions/*`
 * code built WITH a response (Cloud Tasks answered; the status never enters the
 * narrowing, so one serves every row), an `app/*` code without one (the SDK's
 * HTTP client never attaches one). A `firebase-admin` bump that adds a code reds
 * the first test until someone decides where it belongs.
 */
describe('enfileirarNomeandoFalhaTransitoriaLi — the transient set is CLOSED', () => {
  const ESPERADO: Readonly<Record<string, 'nomeada' | 'intocada'>> = {
    'functions/aborted': 'nomeada',
    'functions/internal-error': 'nomeada',
    'functions/unknown-error': 'nomeada',
    'functions/failed-precondition': 'intocada',
    'functions/invalid-argument': 'intocada',
    'functions/invalid-credential': 'intocada',
    'functions/not-found': 'intocada',
    'functions/permission-denied': 'intocada',
    'functions/task-already-exists': 'intocada',
    'functions/unauthenticated': 'intocada',
    'app/network-error': 'nomeada',
    'app/network-timeout': 'nomeada',
    'app/app-deleted': 'intocada',
    'app/duplicate-app': 'intocada',
    'app/internal-error': 'intocada',
    'app/invalid-app-name': 'intocada',
    'app/invalid-app-options': 'intocada',
    'app/invalid-argument': 'intocada',
    'app/invalid-credential': 'intocada',
    'app/no-app': 'intocada',
    'app/unable-to-parse-response': 'intocada',
  };

  /** What the classifier made of one SDK failure: named, untouched, or something else. */
  async function disposicao(
    sdk: FirebaseFunctionsError | FirebaseAppError,
  ): Promise<[string, string]> {
    const err = await rejeicaoDe(rejeicaoDoTransporte(sdk));
    if (err === sdk) return [sdk.code, 'intocada'];
    if (err instanceof LiTarefasTransitoriasError && err.codigo === sdk.code) {
      return [sdk.code, 'nomeada'];
    }
    return [sdk.code, 'outra'];
  }

  it('covers every code the pinned SDK declares, and no other', () => {
    const vocabulario = [
      ...Object.values(FunctionsErrorCode).map((c) => `functions/${c}`),
      ...Object.values(AppErrorCode).map((c) => `app/${c}`),
    ];
    expect(vocabulario.sort()).toEqual(Object.keys(ESPERADO).sort());
  });

  it('names exactly the five transient codes and rethrows every other one untouched', async () => {
    const obtido = Object.fromEntries(
      await Promise.all([
        ...Object.values(FunctionsErrorCode).map((c) => disposicao(falhaDoFunctions(c))),
        ...Object.values(AppErrorCode).map((c) => disposicao(falhaDoApp(c))),
      ]),
    );
    expect(obtido).toEqual(ESPERADO);
  });
});

describe('criarAgendadorLi — the real producer runs the classifier', () => {
  it('a transient transport failure leaves the producer NAMED', async () => {
    const { resolver } = filaGravadora(() => falhaDoFunctions('unknown-error'));
    const err = await rejeicaoDe(
      criarAgendadorLi({ fila: resolver, desligado: false }).enfileirar(PAYLOAD),
    );

    expect(err).toBeInstanceOf(LiTarefasTransitoriasError);
    expect(err).toMatchObject({ codigo: 'functions/unknown-error', httpStatus: 503 });
  });

  it('a deploy failure leaves the producer as the SDK threw it', async () => {
    const sdk = falhaDoFunctions('not-found', 404);
    const { resolver } = filaGravadora(() => sdk);

    expect(
      await rejeicaoDe(criarAgendadorLi({ fila: resolver, desligado: false }).enfileirar(PAYLOAD)),
    ).toBe(sdk);
  });
});
