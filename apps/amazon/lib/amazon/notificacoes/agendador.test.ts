/**
 * The reads-queue producer, offline: the valve, the payload-only enqueue and the
 * transient-vs-deploy narrowing, driven with the Admin SDK's REAL error classes
 * and their STRING codes (`testing/falhaDeEnfileiramento.ts`). No transport is
 * real and no network is reachable: the queue is a recording fake.
 */
import { AppErrorCode, FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError, FunctionsErrorCode } from 'firebase-admin/functions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import { AmazonError } from '@delfrance/integrations-amazon-sp-api';
import { ORIGEM_NOTIFICACAO_AMAZON, TIPO_TAREFA_AMAZON } from '@delfrance/schemas';

import { ErroAppAmazon } from '../core/erros';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDeConfiguracaoDoFunctions,
  falhaDeConflitoDoTasks,
  falhaDoApp,
  falhaDoFunctions,
  rejeicaoDoTransporte,
} from '../testing/falhaDeEnfileiramento';
import { SPID_A } from '../testing/fixtures';
import {
  AmazonTarefasDesligadasError,
  AmazonTarefasTransitoriasError,
  type FilaLeituraAmazon,
  caminhoDaFilaAmazon,
  criarAgendadorAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
  enfileirarNomeandoFalhaTransitoriaAmazon,
} from './agendador';
import { FILA_LEITURA_AMAZON, type PayloadNotificacaoAmazon } from './notificacao';

const PAYLOAD: PayloadNotificacaoAmazon = {
  tipo: TIPO_TAREFA_AMAZON.pedido,
  origem: ORIGEM_NOTIFICACAO_AMAZON.push,
  sellerId: SPID_A,
  amazonOrderId: '000-0000000-0000001',
  notificationId: '00000000-0000-0000-0000-000000000001',
  publishTimeMs: 1_800_000_000_000,
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
  const fila: FilaLeituraAmazon = {
    enqueue: (...args: Parameters<FilaLeituraAmazon['enqueue']>) => enqueue(...args),
  };
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

describe('caminhoDaFilaAmazon — the region-qualified queue path', () => {
  it('is locations/<region>/functions/<the queue constant>', () => {
    expect(caminhoDaFilaAmazon('xx-regiao1')).toBe(
      `locations/xx-regiao1/functions/${FILA_LEITURA_AMAZON}`,
    );
    expect(FILA_LEITURA_AMAZON).toBe('filaLeituraAmazon');
  });

  it.each(['', 'a/b', '../x', 'XX-REGIAO1', ' xx', 'xx\n'])(
    'refuses the region %j: never another path, never a path to nowhere',
    (regiao) => {
      expect(() => caminhoDaFilaAmazon(regiao)).toThrow(TypeError);
    },
  );
});

describe('criarAgendadorAmazon — the valve', () => {
  it('★ closed: every enqueue rejects with AmazonTarefasDesligadasError and the queue is NEVER resolved', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorAmazon({ fila: resolver, desligado: true });

    await expect(agendador.enfileirar(PAYLOAD)).rejects.toBeInstanceOf(
      AmazonTarefasDesligadasError,
    );
    await expect(agendador.enfileirar(PAYLOAD)).rejects.toBeInstanceOf(
      AmazonTarefasDesligadasError,
    );

    // Sweep-only mode must work before the queue IAM exists, so it may not even
    // build the queue handle.
    expect(resolver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('★ open: one enqueue resolves the queue once and sends the payload ALONE — no task id, no uri', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorAmazon({ fila: resolver, desligado: false });

    await agendador.enfileirar(PAYLOAD);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // The whole argument list, not a `toHaveBeenCalledWith` prefix: a second
    // argument (`{ id }`, `{ uri }`, `{ scheduleDelaySeconds }`) is the defect.
    expect(enqueue.mock.calls[0]).toEqual([PAYLOAD]);
  });

  it('open: the queue is resolved PER enqueue, so a root reads its region at send time', async () => {
    const { resolver } = filaGravadora();
    const agendador = criarAgendadorAmazon({ fila: resolver, desligado: false });

    await agendador.enfileirar(PAYLOAD);
    await agendador.enfileirar({ ...PAYLOAD, amazonOrderId: '000-0000000-0000002' });

    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("a root's region guard rejects THAT enqueue, untouched — a deploy error, never transient", async () => {
    const semRegiao = new MissingRegionError('sem região', ['AMAZON_TASKS_REGION']);
    const agendador = criarAgendadorAmazon({
      fila: () => {
        throw semRegiao;
      },
      desligado: false,
    });

    expect(await rejeicaoDe(agendador.enfileirar(PAYLOAD))).toBe(semRegiao);
  });

  it('the valve error names the variable and the sweep, and is about the deployment, not a conta', () => {
    const err = new AmazonTarefasDesligadasError();
    expect(err.message).toContain('AMAZON_TASKS_DISABLED=1');
    expect(err.message).toContain('varredura');
    expect(err.name).toBe('AmazonTarefasDesligadasError');
    // A `catch` written for a conta's refusal, or for an Amazon answer, must never swallow it.
    expect(err).not.toBeInstanceOf(ErroAppAmazon);
    expect(err).not.toBeInstanceOf(AmazonError);
  });
});

describe('enfileirarNomeandoFalhaTransitoriaAmazon — transient vs deploy', () => {
  // Each row a code/status pair the pinned SDK really builds for an enqueue.
  it.each<[string, () => Error, string, number | null]>([
    [
      '503 UNAVAILABLE → functions/unknown-error',
      () => falhaDoFunctions('unknown-error'),
      'functions/unknown-error',
      503,
    ],
    [
      '429 RESOURCE_EXHAUSTED → functions/unknown-error',
      () => falhaDoFunctions('unknown-error', 429),
      'functions/unknown-error',
      429,
    ],
    [
      '504 DEADLINE_EXCEEDED → functions/unknown-error',
      () => falhaDoFunctions('unknown-error', 504),
      'functions/unknown-error',
      504,
    ],
    [
      '500 INTERNAL → functions/internal-error',
      () => falhaDoFunctions('internal-error', 500),
      'functions/internal-error',
      500,
    ],
    [
      '409 ABORTED → functions/task-already-exists (the SDK’s own 409 branch; no task id is ever sent)',
      () => falhaDeConflitoDoTasks(),
      'functions/task-already-exists',
      409,
    ],
    ['socket → app/network-error', () => falhaDoApp('network-error'), 'app/network-error', null],
    [
      'timeout → app/network-timeout',
      () => falhaDoApp('network-timeout'),
      'app/network-timeout',
      null,
    ],
  ])('★ a TRANSIENT failure (%s) comes out named', async (_nome, falha, codigo, status) => {
    const err = await rejeicaoDe(rejeicaoDoTransporte(falha()));

    expect(err).toBeInstanceOf(AmazonTarefasTransitoriasError);
    expect(err).toMatchObject({ codigo, httpStatus: status });
    expect((err as AmazonTarefasTransitoriasError).classe).toBe(
      codigo.startsWith('app/') ? 'FirebaseAppError' : 'FirebaseFunctionsError',
    );
  });

  it('the named error carries the class, code and status ONLY — never the body the SDK quoted, never a cause', async () => {
    const err = await rejeicaoDe(rejeicaoDoTransporte(falhaDoFunctions('unknown-error')));

    expect(err).toBeInstanceOf(AmazonTarefasTransitoriasError);
    const e = err as AmazonTarefasTransitoriasError;
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

  it.each([['network-error'], ['network-timeout']])(
    'the app/%s named error carries the class and code ONLY — never the SDK message, never a cause',
    async (code) => {
      const err = await rejeicaoDe(rejeicaoDoTransporte(falhaDoApp(code)));

      expect(err).toBeInstanceOf(AmazonTarefasTransitoriasError);
      const e = err as AmazonTarefasTransitoriasError;
      expect(e.message).toBe(
        `enqueue no Cloud Tasks falhou de forma transitória (FirebaseAppError app/${code})`,
      );
      expect(JSON.stringify(e)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
      expect(e.cause).toBeUndefined();
    },
  );

  // ⚠️ NEAR-MISS pairs. The same `functions/*` codes are a config error WITHOUT a
  // response; `unknown-error` at a 400 is a bad request, not a hiccup; and
  // `not-found` and `permission-denied` are a broken deploy even though Cloud
  // Tasks answered.
  it.each<[string, () => Error]>([
    [
      'functions/unknown-error WITHOUT a response (project)',
      () => falhaDeConfiguracaoDoFunctions('projeto'),
    ],
    [
      'functions/unknown-error WITHOUT a response (service account)',
      () => falhaDeConfiguracaoDoFunctions('conta-de-servico'),
    ],
    [
      'functions/internal-error WITHOUT a response',
      () => new FirebaseFunctionsError({ code: 'internal-error', message: 'sem resposta' }),
    ],
    [
      'functions/aborted WITHOUT a response',
      () => new FirebaseFunctionsError({ code: 'aborted', message: 'sem resposta' }),
    ],
    [
      'functions/unknown-error 400 (OUT_OF_RANGE, outside the SDK’s map): the CODE is not the decision',
      () => falhaDoFunctions('unknown-error', 400),
    ],
    [
      'functions/task-already-exists WITHOUT a response',
      () => new FirebaseFunctionsError({ code: 'task-already-exists', message: 'sem resposta' }),
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
  ])('★ a DEPLOY-shaped failure (%s) is rethrown UNTOUCHED', async (_nome, falha) => {
    const sdk = falha();
    expect(await rejeicaoDe(rejeicaoDoTransporte(sdk))).toBe(sdk);
  });

  it('a non-Error rejection is rethrown as is', async () => {
    const lancado = { qualquer: 'coisa' };
    expect(
      await rejeicaoDe(enfileirarNomeandoFalhaTransitoriaAmazon(() => Promise.reject(lancado))),
    ).toBe(lancado);
  });

  it('a transport that throws SYNCHRONOUSLY is narrowed the same way', async () => {
    const err = await rejeicaoDe(
      enfileirarNomeandoFalhaTransitoriaAmazon(() => {
        throw falhaDoFunctions('unknown-error');
      }),
    );
    expect(err).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });
});

/**
 * The transient rule is CLOSED over the pinned SDK's own vocabulary: EVERY code
 * the two classes declare gets a disposition here, so a `firebase-admin` bump
 * that adds a code reds the first test.
 *
 * A `functions/*` code never decides alone (`agendador.ts`): every declared one
 * is untouched at a 400 and without a response, and named at a 503. The status
 * decides, so the status table is closed too, over every error status.
 */
describe('enfileirarNomeandoFalhaTransitoriaAmazon — the transient rule is CLOSED', () => {
  const DO_APP: Readonly<Record<string, 'nomeada' | 'intocada'>> = {
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
  const DO_FUNCTIONS = [
    'functions/aborted',
    'functions/failed-precondition',
    'functions/internal-error',
    'functions/invalid-argument',
    'functions/invalid-credential',
    'functions/not-found',
    'functions/permission-denied',
    'functions/task-already-exists',
    'functions/unauthenticated',
    'functions/unknown-error',
  ];

  async function disposicao(sdk: FirebaseFunctionsError | FirebaseAppError): Promise<string> {
    const err = await rejeicaoDe(rejeicaoDoTransporte(sdk));
    if (err === sdk) return 'intocada';
    if (err instanceof AmazonTarefasTransitoriasError && err.codigo === sdk.code) return 'nomeada';
    return 'outra';
  }

  it('covers every code the pinned SDK declares, and no other', () => {
    expect(
      Object.values(FunctionsErrorCode)
        .map((c) => `functions/${c}`)
        .sort(),
    ).toEqual(DO_FUNCTIONS);
    expect(
      Object.values(AppErrorCode)
        .map((c) => `app/${c}`)
        .sort(),
    ).toEqual(Object.keys(DO_APP).sort());
  });

  it('names exactly app/network-error and app/network-timeout, and rethrows every other app code untouched', async () => {
    const obtido = Object.fromEntries(
      await Promise.all(
        Object.values(AppErrorCode).map(
          async (c) => [`app/${c}`, await disposicao(falhaDoApp(c))] as const,
        ),
      ),
    );
    expect(obtido).toEqual(DO_APP);
  });

  it('★ no functions code decides alone: each is untouched at a 400 and without a response, named at a 503', async () => {
    for (const c of Object.values(FunctionsErrorCode)) {
      expect(await disposicao(falhaDoFunctions(c, 400)), `${c} 400`).toBe('intocada');
      expect(
        await disposicao(new FirebaseFunctionsError({ code: c, message: 'sem resposta' })),
        `${c} sem resposta`,
      ).toBe('intocada');
      expect(await disposicao(falhaDoFunctions(c, 503)), `${c} 503`).toBe('nomeada');
    }
  });

  it('★ the status decides: 409, 429 and every 5xx are named; every other error status is untouched', async () => {
    const nomeados: number[] = [];
    for (let status = 400; status <= 599; status += 1) {
      const d = await disposicao(falhaDoFunctions('unknown-error', status));
      expect(d, String(status)).not.toBe('outra');
      if (d === 'nomeada') nomeados.push(status);
    }
    expect(nomeados).toEqual([409, 429, ...Array.from({ length: 100 }, (_v, i) => 500 + i)]);
  });
});

describe('ehFalhaDoSdkDeTarefasAmazon — the one narrowing the receiver and the poll import', () => {
  it('is true for both SDK classes, transient or deploy-shaped', () => {
    expect(ehFalhaDoSdkDeTarefasAmazon(falhaDoFunctions('permission-denied', 403))).toBe(true);
    expect(ehFalhaDoSdkDeTarefasAmazon(falhaDeConfiguracaoDoFunctions('projeto'))).toBe(true);
    expect(ehFalhaDoSdkDeTarefasAmazon(falhaDoApp('network-error'))).toBe(true);
  });

  it('near-miss: the NAMED errors, a look-alike object and a plain Error are not SDK failures', () => {
    expect(ehFalhaDoSdkDeTarefasAmazon(new AmazonTarefasDesligadasError())).toBe(false);
    expect(
      ehFalhaDoSdkDeTarefasAmazon(
        new AmazonTarefasTransitoriasError(
          'FirebaseFunctionsError',
          'functions/unknown-error',
          503,
        ),
      ),
    ).toBe(false);
    expect(ehFalhaDoSdkDeTarefasAmazon({ code: 'functions/permission-denied', message: 'x' })).toBe(
      false,
    );
    expect(ehFalhaDoSdkDeTarefasAmazon(new Error('functions/permission-denied'))).toBe(false);
    expect(
      ehFalhaDoSdkDeTarefasAmazon(new FirebaseAppError({ code: 'no-app', message: 'x' })),
    ).toBe(true);
  });
});

describe('criarAgendadorAmazon — the real producer runs the classifier', () => {
  it('a transient transport failure leaves the producer NAMED', async () => {
    const { resolver } = filaGravadora(() => falhaDoFunctions('unknown-error'));
    const err = await rejeicaoDe(
      criarAgendadorAmazon({ fila: resolver, desligado: false }).enfileirar(PAYLOAD),
    );

    expect(err).toBeInstanceOf(AmazonTarefasTransitoriasError);
    expect(err).toMatchObject({ codigo: 'functions/unknown-error', httpStatus: 503 });
  });

  it('a deploy failure leaves the producer as the SDK threw it', async () => {
    const sdk = falhaDoFunctions('not-found', 404);
    const { resolver } = filaGravadora(() => sdk);

    expect(
      await rejeicaoDe(
        criarAgendadorAmazon({ fila: resolver, desligado: false }).enfileirar(PAYLOAD),
      ),
    ).toBe(sdk);
  });
});
