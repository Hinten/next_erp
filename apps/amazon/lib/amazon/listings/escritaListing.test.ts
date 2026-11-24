/**
 * The listings flows' shared task rungs, offline: (1) the budget checked and
 * the clock stamped with the write's credential IN HAND, inside the getter,
 * on every call the client makes; (2) the no-throw boundary's classifier, its
 * class names and its one-effect wrapper; (3) the 429 pause's re-enqueue rule.
 * The Admin SDK's REAL error classes drive the task-SDK cases
 * (`testing/falhaDeEnfileiramento.ts`). (4) The PATCH's own failure read as
 * "may have landed" or "refused", on the package's REAL error classes. Nothing
 * reaches a network.
 */
import { describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonSchemaError,
  AmazonThrottleError,
  type ContextoRequisicaoAmazon,
  OPERACAO_ENVIAR_LISTING,
  OPERACAO_LER_LISTING,
} from '@delfrance/integrations-amazon-sp-api';

import {
  AmazonTarefasTransitoriasError,
  descreverFalhaDoSdkDeTarefasAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
} from '../core/filaTarefas';
import { AmazonEstoquePrazoDaTarefaError } from '../estoque/processarEstoque';
import {
  AmazonEstoqueRegiaoDaFilaInvalidaError,
  AmazonEstoqueTarefasDesligadasError,
} from '../estoque/produtorEstoque';
import { AmazonLotesTarefasDesligadasError } from '../feeds/agendadorLotes';
import { grpc } from '../testing/fakeDb';
import { falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import {
  type ContextoDaEscritaListingAmazon,
  classeDaFalhaListingAmazon,
  contextoDaEscritaComOrcamentoListingAmazon,
  contidoListingAmazon,
  envioRecusadoListingAmazon,
  envioTalvezAplicadoListingAmazon,
  falhaContidaListingAmazon,
  pausarListingAmazon,
} from './escritaListing';

const INICIO = 1_000_000;
const ORCAMENTO = 200_000;

/* -------------------------------------------------------------------------- */
/*                         (1) the budget in the getter                        */
/* -------------------------------------------------------------------------- */

/** A context whose getter takes `demoraMs` on the fake clock before it answers. */
function cenarioDoGetter(demoraMs: number) {
  const relogio = { ms: INICIO };
  const chamadas: unknown[] = [];
  const contexto: ContextoDaEscritaListingAmazon = {
    integracaoId: 'conta-escrita',
    obterAcesso: async (opcoes) => {
      chamadas.push(opcoes);
      relogio.ms += demoraMs;
      await Promise.resolve();
      return { accessToken: 'tok|TESTE', acessoRef: 'ref-teste' } as never;
    },
  };
  const carimbos: number[] = [];
  const escrita = contextoDaEscritaComOrcamentoListingAmazon(contexto, {
    agora: () => relogio.ms,
    inicioMs: INICIO,
    orcamentoMs: ORCAMENTO,
    prazoEsgotado: () => new AmazonEstoquePrazoDaTarefaError(),
    carimbar: (ms) => carimbos.push(ms),
  });
  return { relogio, chamadas, carimbos, escrita, contexto };
}

describe('★ (1) the budget, checked with the credential IN HAND', () => {
  it('under budget: the credential is answered, and the clock stamped AFTER the getter answered (its own wait included)', async () => {
    const c = cenarioDoGetter(30_000);
    await expect(c.escrita.obterAcesso()).resolves.toEqual({
      accessToken: 'tok|TESTE',
      acessoRef: 'ref-teste',
    });
    expect(c.carimbos).toEqual([INICIO + 30_000]);
    expect(c.escrita.integracaoId).toBe('conta-escrita');
  });

  it('★ a SLOW getter that crosses the budget ⇒ the flow’s own class, nothing stamped (NEAR-MISS: the same getter one ms faster passes)', async () => {
    const lento = cenarioDoGetter(ORCAMENTO + 1);
    await expect(lento.escrita.obterAcesso()).rejects.toBeInstanceOf(
      AmazonEstoquePrazoDaTarefaError,
    );
    expect(lento.carimbos).toEqual([]);
    const justo = cenarioDoGetter(ORCAMENTO);
    await expect(justo.escrita.obterAcesso()).resolves.toBeDefined();
    expect(justo.carimbos).toEqual([INICIO + ORCAMENTO]);
  });

  it('★ NEAR-MISS: time spent BEFORE the getter but under budget at the getter ⇒ answered', async () => {
    const c = cenarioDoGetter(0);
    c.relogio.ms = INICIO + ORCAMENTO - 1;
    await expect(c.escrita.obterAcesso()).resolves.toBeDefined();
    expect(c.carimbos).toEqual([INICIO + ORCAMENTO - 1]);
  });

  it('every call is checked — the forced refresh’s too — and its options reach the context’s getter unchanged', async () => {
    const c = cenarioDoGetter(10);
    await c.escrita.obterAcesso();
    await c.escrita.obterAcesso({ forcarRenovacao: true });
    expect(c.chamadas).toEqual([undefined, { forcarRenovacao: true }]);
    expect(c.carimbos).toEqual([INICIO + 10, INICIO + 20]);
    c.relogio.ms = INICIO + ORCAMENTO + 5;
    await expect(c.escrita.obterAcesso({ forcarRenovacao: true })).rejects.toBeInstanceOf(
      AmazonEstoquePrazoDaTarefaError,
    );
    expect(c.carimbos).toHaveLength(2);
  });

  it('a getter failure is rethrown untouched, nothing stamped', async () => {
    const erro = new TypeError('getter');
    const carimbar = vi.fn();
    const escrita = contextoDaEscritaComOrcamentoListingAmazon(
      { integracaoId: 'c', obterAcesso: () => Promise.reject(erro) },
      {
        agora: () => INICIO,
        inicioMs: INICIO,
        orcamentoMs: ORCAMENTO,
        prazoEsgotado: () => new AmazonEstoquePrazoDaTarefaError(),
        carimbar,
      },
    );
    await expect(escrita.obterAcesso()).rejects.toBe(erro);
    expect(carimbar).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                          (2) the no-throw boundary                          */
/* -------------------------------------------------------------------------- */

const contidaEstoque = falhaContidaListingAmazon([
  AmazonEstoqueTarefasDesligadasError,
  AmazonEstoqueRegiaoDaFilaInvalidaError,
]);

describe('★ (2) the boundary’s classifier', () => {
  it.each<[string, unknown]>([
    ['a Firestore error', grpc(14, 'UNAVAILABLE')],
    ['a Cloud Tasks transient', AmazonTarefasTransitoriasError.porPrazo()],
    ['a missing region', new MissingRegionError('sem região', ['AMAZON_TASKS_REGION'])],
    ['a raw task-SDK failure', falhaDoFunctions('unavailable')],
    ['the flow producer’s valve', new AmazonEstoqueTarefasDesligadasError()],
    ['the flow producer’s region', new AmazonEstoqueRegiaoDaFilaInvalidaError()],
  ])('contains %s', (_c, err) => {
    expect(contidaEstoque(err)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a plain Error', new Error('x')],
    ['a TypeError', new TypeError('x')],
    ['a RangeError', new RangeError('x')],
    ['ANOTHER producer’s valve (not this flow’s)', new AmazonLotesTarefasDesligadasError()],
    ['the budget’s own class', new AmazonEstoquePrazoDaTarefaError()],
    ['a string', 'falhou'],
    ['undefined', undefined],
  ])('★ NEAR-MISS: does NOT contain %s (an unnamed failure crosses)', (_c, err) => {
    expect(contidaEstoque(err)).toBe(false);
  });

  it('a flow binds its OWN producer classes: the jobs producer’s valve is contained only where bound', () => {
    const contidaLotes = falhaContidaListingAmazon([AmazonLotesTarefasDesligadasError]);
    expect(contidaLotes(new AmazonLotesTarefasDesligadasError())).toBe(true);
    expect(contidaLotes(new AmazonEstoqueTarefasDesligadasError())).toBe(false);
    expect(falhaContidaListingAmazon([])(new AmazonEstoqueTarefasDesligadasError())).toBe(false);
  });

  it.each([
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    EvalError,
    URIError,
    AggregateError,
  ])(
    '★ a built-in error class (%o) is refused as a producer class: it would contain every unnamed failure (rule 6)',
    (nativa) => {
      expect(() =>
        falhaContidaListingAmazon([AmazonEstoqueTarefasDesligadasError, nativa]),
      ).toThrow(
        new RangeError('escritaListing.ts: uma classe nativa de erro não nomeia uma falha'),
      );
    },
  );

  it('NEAR-MISS: a producer class that EXTENDS a built-in one is a class of its own, and binds', () => {
    // The region class extends TypeError, and a plain TypeError still crosses.
    expect(contidaEstoque(new AmazonEstoqueRegiaoDaFilaInvalidaError())).toBe(true);
    expect(contidaEstoque(new TypeError('x'))).toBe(false);
  });

  it('names a failure by its CLASS, never its message', () => {
    expect(classeDaFalhaListingAmazon(grpc(9, 'segredo no texto'))).toBe('Firestore/9');
    expect(classeDaFalhaListingAmazon(new AmazonEstoqueTarefasDesligadasError())).toBe(
      'AmazonEstoqueTarefasDesligadasError',
    );
    expect(classeDaFalhaListingAmazon(falhaDoFunctions('unavailable'))).not.toMatch(/segredo/);
    expect(classeDaFalhaListingAmazon(falhaDoFunctions('unavailable'))).not.toBe('desconhecido');
    const doSdk = falhaDoFunctions('unavailable');
    if (!ehFalhaDoSdkDeTarefasAmazon(doSdk)) throw new TypeError('esperava uma falha do SDK');
    expect(classeDaFalhaListingAmazon(doSdk)).toBe(descreverFalhaDoSdkDeTarefasAmazon(doSdk));
    expect(classeDaFalhaListingAmazon(doSdk)).not.toBe(doSdk.name);
    expect(classeDaFalhaListingAmazon('texto')).toBe('desconhecido');
    expect(classeDaFalhaListingAmazon({ name: 7 })).toBe('desconhecido');
    expect(classeDaFalhaListingAmazon(null)).toBe('desconhecido');
  });

  it('★ ONE effect inside the boundary: its value; a contained failure ⇒ null and its class handed over; anything else crosses untouched', async () => {
    const perdas: string[] = [];
    const anotar = (classe: string) => perdas.push(classe);
    await expect(
      contidoListingAmazon(() => Promise.resolve(5), contidaEstoque, anotar),
    ).resolves.toBe(5);
    await expect(
      contidoListingAmazon(() => Promise.reject(grpc(10, 'ABORTED')), contidaEstoque, anotar),
    ).resolves.toBeNull();
    expect(perdas).toEqual(['Firestore/10']);
    const bug = new TypeError('bug');
    await expect(
      contidoListingAmazon(() => Promise.reject(bug), contidaEstoque, anotar),
    ).rejects.toBe(bug);
    expect(perdas).toEqual(['Firestore/10']);
  });
});

/* -------------------------------------------------------------------------- */
/*                               (3) the 429 pause                             */
/* -------------------------------------------------------------------------- */

describe('★ (3) the 429 pause', () => {
  it('the re-enqueue lands ⇒ pausado (the task ends with no throw, no attempt spent)', async () => {
    const enfileirar = vi.fn(() => Promise.resolve());
    await expect(pausarListingAmazon(enfileirar, contidaEstoque)).resolves.toEqual({
      tipo: 'pausado',
    });
    expect(enfileirar).toHaveBeenCalledTimes(1);
  });

  it('★ the re-enqueue refused by a contained class ⇒ retentar, the very failure as the cause, its class named', async () => {
    const valvula = new AmazonEstoqueTarefasDesligadasError();
    const r = await pausarListingAmazon(() => Promise.reject(valvula), contidaEstoque);
    expect(r).toEqual({
      tipo: 'retentar',
      causa: valvula,
      classe: 'AmazonEstoqueTarefasDesligadasError',
    });
    if (r.tipo === 'retentar') expect(r.causa).toBe(valvula);
  });

  it('★ NEAR-MISS: a producer that THROWS while built counts as its enqueue (contained the same way)', async () => {
    const regiao = new MissingRegionError('sem região', ['AMAZON_TASKS_REGION']);
    const r = await pausarListingAmazon(() => {
      throw regiao;
    }, contidaEstoque);
    expect(r).toMatchObject({ tipo: 'retentar', causa: regiao });
  });

  it('NEAR-MISS: an unnamed failure of the re-enqueue crosses, untouched', async () => {
    const bug = new RangeError('atraso');
    await expect(pausarListingAmazon(() => Promise.reject(bug), contidaEstoque)).rejects.toBe(bug);
  });
});

/* -------------------------------------------------------------------------- */
/*                          (4) the write's own failure                        */
/* -------------------------------------------------------------------------- */

/** One request's identity, as the package stamps every error it raises. */
function requisicao(
  operacao: string = OPERACAO_ENVIAR_LISTING,
  destino: ContextoRequisicaoAmazon['destino'] = 'sp-api',
): ContextoRequisicaoAmazon {
  return {
    destino,
    operacao,
    metodo: 'PATCH',
    caminho: '/x',
    correlationId: 'corr-teste',
    requestIdAmazon: null,
    refCredencial: 'ref-teste',
  };
}

describe('★ (4) the PATCH’s own failure: may have landed, or refused', () => {
  it.each<[string, unknown, boolean, boolean]>([
    ['a 5xx of the PATCH', new AmazonHttpError({ ...requisicao(), status: 503 }), true, true],
    ['a dropped connection of the PATCH', new AmazonNetworkError(requisicao(), null), true, false],
    [
      'a 2xx of the PATCH off its schema',
      new AmazonSchemaError({ ...requisicao(), status: 200, motivo: 'formato', campos: ['x'] }),
      true,
      false,
    ],
    ['a 4xx of the PATCH', new AmazonHttpError({ ...requisicao(), status: 400 }), false, true],
    [
      'a 401 of the PATCH (after the forced refresh)',
      new AmazonAuthError({ ...requisicao(), status: 401, codigoLwa: null }),
      false,
      true,
    ],
    [
      'a 429 of the PATCH (the pause reads it first)',
      new AmazonThrottleError({ ...requisicao(), status: 429, limiteTaxa: null }),
      false,
      true,
    ],
    [
      'NEAR-MISS: a 5xx of the READ',
      new AmazonHttpError({ ...requisicao(OPERACAO_LER_LISTING), status: 503 }),
      false,
      false,
    ],
    [
      'NEAR-MISS: a dropped connection of the READ',
      new AmazonNetworkError(requisicao(OPERACAO_LER_LISTING), null),
      false,
      false,
    ],
    [
      'NEAR-MISS: a 5xx of an LWA exchange under the same label',
      new AmazonHttpError({ ...requisicao(OPERACAO_ENVIAR_LISTING, 'lwa'), status: 503 }),
      false,
      false,
    ],
    ['NEAR-MISS: not an Amazon failure', new TypeError('x'), false, false],
  ])('%s', (_c, err, talvez, recusado) => {
    expect(envioTalvezAplicadoListingAmazon(err)).toBe(talvez);
    expect(envioRecusadoListingAmazon(err)).toBe(recusado);
  });
});
