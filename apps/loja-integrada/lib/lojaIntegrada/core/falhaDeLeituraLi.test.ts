/**
 * The shared read-failure mapper (`falhaDeLeituraLi.ts`): the class table, the per-caller choices
 * (what a 404 means, whether a 403 parks, what a paging stop means), and the 401/403 park behind
 * it — against `testing/fakeDb.ts`, the REAL context loader and the REAL park (`estacionamento.ts`).
 *
 * Nothing reaches the network (D17): the global `fetch` is stubbed to throw for the whole file,
 * and the one context this file builds gets a `deps.fetch` that throws too. No case makes a call:
 * every failure is handed to the mapper as the error the package would have raised.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  LiAuthError,
  LiConfigError,
  LiError,
  LiHttpError,
  LiNetworkError,
  LiNotFoundError,
  LiPaginacaoError,
  LiSchemaError,
  LiThrottleError,
  LiTimeoutError,
  type ContextoRequisicaoLi,
} from '@delfrance/integrations-loja-integrada';
import { CODIGO_ERRO_LI } from '@delfrance/schemas';

import { chaveReconexao } from '../avisos/avisos';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  TOKEN_B,
  caminhoAviso,
  caminhoCredencial,
  gravadorDeLog,
  loggerEspiao,
  ritmoFalso,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { __setRelogioDoCacheParaTestes } from './contaCache';
import { type ContextoLojaIntegrada, loadLojaIntegradaContext } from './contexto';
import { refDaCredencial } from './credencial';
import { lerCredencial, removerCredencial } from './credentialStore';
import {
  LiChamadasDesligadasError,
  LiContaParadaError,
  LiCredencialAlteradaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiEstacionamentoEmConflitoError,
} from './erros';
import {
  type FalhaDaLojaLi,
  type PoliticaDeFalhaLi,
  type TratarFalhaDeLeituraDeps,
  falhaDaLojaLi,
  mapearFalhaDeLeituraLi,
  tratarFalhaDeLeituraLi,
} from './falhaDeLeituraLi';

const CONTA = 'conta-li-leitura';
const CAMINHO = '/v1/recurso/123/';

const ctx: ContextoRequisicaoLi = {
  operacao: 'lerRecurso',
  caminho: CAMINHO,
  correlationId: 'corr-1',
  refCredencial: 'ref.1',
};

/** A caller's own answer for a 404 (any existing code: the mapper never looks inside it). */
const AUSENTE: FalhaDaLojaLi = falhaDaLojaLi(
  'nao-autorizado',
  409,
  CODIGO_ERRO_LI.pedidoAusenteNaLoja,
  'Mensagem do chamador para o 404.',
);

/** A caller's own answer for a 403 that must NOT park. */
const PROIBIDO: FalhaDaLojaLi = falhaDaLojaLi(
  'configuracao',
  502,
  CODIGO_ERRO_LI.lojaIndisponivel,
  'Mensagem do chamador para o 403.',
);

/** A paging caller's own answers, one per motivo: distinct objects, so a swap shows. */
const LIMITE: FalhaDaLojaLi = falhaDaLojaLi(
  'transitorio',
  502,
  CODIGO_ERRO_LI.lojaIndisponivel,
  'Mensagem do chamador para o limite de páginas.',
);
const OFFSET: FalhaDaLojaLi = falhaDaLojaLi(
  'transitorio',
  502,
  CODIGO_ERRO_LI.lojaIndisponivel,
  'Mensagem do chamador para o offset que não avança.',
);

/** A 404 is the caller's answer, and a 403 parks like a 401 (the paid re-check's choice). */
const ESTACIONA: PoliticaDeFalhaLi = { ausente: AUSENTE, proibido: 'estacionar' };
/** A 404 is not this read's to answer, and a 403 is answered without parking. */
const NAO_ESTACIONA: PoliticaDeFalhaLi = { ausente: null, proibido: PROIBIDO };
/** A read that pages: as {@link NAO_ESTACIONA}, plus its own answer for each paging stop. */
const PAGINA: PoliticaDeFalhaLi = {
  ausente: null,
  proibido: PROIBIDO,
  paginacao: { 'limite-de-paginas': LIMITE, 'offset-nao-avanca': OFFSET },
};

const POLITICAS: readonly (readonly [string, PoliticaDeFalhaLi])[] = [
  ['a 403 parks', ESTACIONA],
  ['a 403 does not park', NAO_ESTACIONA],
  ['a paging read', PAGINA],
];

/** The callers that name no paging answer: their reads never page. */
const SEM_PAGINACAO: readonly (readonly [string, PoliticaDeFalhaLi])[] = [
  ['a 403 parks', ESTACIONA],
  ['a 403 does not park', NAO_ESTACIONA],
];

/** What the mapper may see of a context: its third parameter, without the `null`. */
type ContaDaFalha = NonNullable<Parameters<typeof tratarFalhaDeLeituraLi>[2]>;

/**
 * The real context, of which only the conta's id and record can be read: anything else — the
 * client above all — throws, so a mapper that reached for it would fail the case.
 */
function soAConta(ctxLi: ContextoLojaIntegrada): ContaDaFalha {
  return new Proxy(ctxLi, {
    get(alvo, chave, receptor): unknown {
      if (chave === 'integracaoId' || chave === 'conta') return Reflect.get(alvo, chave, receptor);
      throw new TypeError(`o mapeador leu ${String(chave)} do contexto`);
    },
  });
}

function erroAuth(status: 401 | 403, refCredencial: string): LiAuthError {
  return new LiAuthError({ ...ctx, status, refCredencial });
}

let db: FakeDb;
let globalFetch: ReturnType<typeof vi.fn>;
let logger: ReturnType<typeof loggerEspiao>;

function deps(): TratarFalhaDeLeituraDeps {
  return { db: asDb(db), agoraMs: () => AGORA_MS, increment, logger: logger.logger };
}

/** The real context of the seeded conta: the switch on, a pacer that never sleeps, no network. */
async function contexto(): Promise<ContextoLojaIntegrada> {
  return loadLojaIntegradaContext(asDb(db), CONTA, {
    ambiente: AMBIENTE_LIGADO,
    ritmo: ritmoFalso().ritmo,
    fetch: () => Promise.reject(new Error('o mapeador não chama a Loja Integrada')),
    registro: { escrever: gravadorDeLog().escrever },
  });
}

/** The versioned ref of the credential stored right now: what a refused request carries. */
async function refAtual(): Promise<string> {
  const lida = await lerCredencial(asDb(db), CONTA);
  if (lida === null) throw new TypeError('nenhuma credencial semeada');
  return refDaCredencial(lida.credencial);
}

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  db = new FakeDb();
  logger = loggerEspiao();
  globalFetch = vi.fn(() => {
    throw new Error('o mapeador de falhas não chama a Loja Integrada');
  });
  vi.stubGlobal('fetch', globalFetch);
  seedConta(db, CONTA, { nome: 'Loja Leitura' });
  seedCredencial(db, CONTA);
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

/* -------------------------------------------------------------------------- */
/*                 The pure mapper: each class to its code, or null            */
/* -------------------------------------------------------------------------- */

describe('mapearFalhaDeLeituraLi — the classes every caller shares', () => {
  const compartilhados: readonly (readonly [string, unknown, Record<string, unknown>])[] = [
    [
      'LiThrottleError',
      new LiThrottleError({
        ...ctx,
        status: 429,
        escopo: 'desconhecido',
        codigosEncontrados: [],
        retryAfterS: null,
      }),
      { tipo: 'loja', classe: 'transitorio', status: 503, code: CODIGO_ERRO_LI.limiteDeChamadas },
    ],
    [
      'LiTimeoutError (before its parent)',
      new LiTimeoutError({ ...ctx, prazoMs: 20_000 }, null),
      { tipo: 'loja', classe: 'transitorio', status: 504, code: CODIGO_ERRO_LI.tempoEsgotadoLoja },
    ],
    [
      'LiNetworkError',
      new LiNetworkError(ctx, new TypeError('x')),
      { tipo: 'loja', classe: 'transitorio', status: 502, code: CODIGO_ERRO_LI.lojaIndisponivel },
    ],
    [
      'LiHttpError 503',
      new LiHttpError({ ...ctx, status: 503 }),
      { tipo: 'loja', classe: 'transitorio', status: 502, code: CODIGO_ERRO_LI.lojaIndisponivel },
    ],
    [
      'LiSchemaError',
      new LiSchemaError({ ...ctx, status: 200, motivo: 'formato', campos: ['id'] }),
      { tipo: 'loja', classe: 'transitorio', status: 502, code: CODIGO_ERRO_LI.lojaIndisponivel },
    ],
    [
      'LiChamadasDesligadasError (an app error)',
      new LiChamadasDesligadasError(CONTA),
      { tipo: 'conta', classe: 'configuracao' },
    ],
    [
      'LiEstacionamentoEmConflitoError (an app error, transient)',
      new LiEstacionamentoEmConflitoError(CONTA, 3),
      { tipo: 'conta', classe: 'transitorio' },
    ],
  ];

  for (const [politicaNome, politica] of POLITICAS) {
    it.each(compartilhados)(
      `%s — the same answer whatever the caller (${politicaNome})`,
      (_nome, err, esperado) => {
        expect(mapearFalhaDeLeituraLi(err, politica)).toMatchObject(esperado);
      },
    );
  }

  it('an app error is carried as the SAME object, for the shared envelope mapper', () => {
    const err = new LiChamadasDesligadasError(CONTA);
    const falha = mapearFalhaDeLeituraLi(err, ESTACIONA);
    expect(falha?.tipo === 'conta' && falha.erro).toBe(err);
  });

  const alheios: readonly (readonly [string, unknown])[] = [
    ['the LiError base (never caught wholesale)', new LiError('x', { refCredencial: null })],
    [
      'LiConfigError (our own misconfiguration)',
      new LiConfigError('caminho', { operacao: 'x', refCredencial: null }),
    ],
    ['a non-transient LiHttpError (400)', new LiHttpError({ ...ctx, status: 400 })],
    ['a redirect (301): never followed, never ours', new LiHttpError({ ...ctx, status: 301 })],
    ['a gRPC failure', grpc(14, 'UNAVAILABLE')],
    ['a plain Error', new Error('x')],
    ['a TypeError', new TypeError('x')],
  ];

  for (const [politicaNome, politica] of POLITICAS) {
    it.each(alheios)(`%s ⇒ null (${politicaNome})`, (_nome, err) => {
      expect(mapearFalhaDeLeituraLi(err, politica)).toBeNull();
    });
  }

  it('no shared message carries the call path or a correlation id', () => {
    const erros = [
      new LiThrottleError({
        ...ctx,
        status: 429,
        escopo: 'desconhecido',
        codigosEncontrados: [],
        retryAfterS: 3,
      }),
      new LiTimeoutError({ ...ctx, prazoMs: 20_000 }, null),
      new LiNetworkError(ctx, null),
      new LiHttpError({ ...ctx, status: 503 }),
      new LiSchemaError({ ...ctx, status: 200, motivo: 'formato', campos: ['id'] }),
    ];
    for (const err of erros) {
      const falha = mapearFalhaDeLeituraLi(err, NAO_ESTACIONA);
      const mensagem = falha?.tipo === 'loja' ? falha.mensagem : '';
      expect(mensagem.length).toBeGreaterThan(0);
      expect(mensagem).not.toContain(CAMINHO);
      expect(mensagem).not.toContain('123');
      expect(mensagem).not.toContain('corr-1');
    }
  });
});

describe('mapearFalhaDeLeituraLi — what a 404 means is the caller’s', () => {
  const nf = new LiNotFoundError({ ...ctx, status: 404 });

  it('a caller that owns its 404 gets exactly its own answer back', () => {
    expect(mapearFalhaDeLeituraLi(nf, ESTACIONA)).toBe(AUSENTE);
  });

  it('⚠️ NEAR-MISS: a caller that does not own it gets null — a refusal of our request stays loud', () => {
    expect(mapearFalhaDeLeituraLi(nf, NAO_ESTACIONA)).toBeNull();
  });

  it('the 404 answer never leaks into another status: a 410 is still not the caller’s', () => {
    expect(mapearFalhaDeLeituraLi(new LiHttpError({ ...ctx, status: 410 }), ESTACIONA)).toBeNull();
  });
});

describe('mapearFalhaDeLeituraLi — what a paging stop means is the caller’s', () => {
  const limite = new LiPaginacaoError({ ...ctx, motivo: 'limite-de-paginas', paginas: 10 });
  const offset = new LiPaginacaoError({ ...ctx, motivo: 'offset-nao-avanca', paginas: 3 });

  it('a caller that pages gets exactly its own answer, motivo by motivo', () => {
    expect(mapearFalhaDeLeituraLi(limite, PAGINA)).toBe(LIMITE);
    expect(mapearFalhaDeLeituraLi(offset, PAGINA)).toBe(OFFSET);
  });

  it.each(SEM_PAGINACAO)(
    '⚠️ NEAR-MISS: a caller that names no paging answer (%s) ⇒ null for both motivos: rethrown, never a code',
    (_nome, politica) => {
      expect(mapearFalhaDeLeituraLi(limite, politica)).toBeNull();
      expect(mapearFalhaDeLeituraLi(offset, politica)).toBeNull();
    },
  );

  it('a motivo the caller answers with null stays null, and the other keeps its own answer', () => {
    const parcial: PoliticaDeFalhaLi = {
      ...PAGINA,
      paginacao: { 'limite-de-paginas': null, 'offset-nao-avanca': OFFSET },
    };
    expect(mapearFalhaDeLeituraLi(limite, parcial)).toBeNull();
    expect(mapearFalhaDeLeituraLi(offset, parcial)).toBe(OFFSET);
  });

  it('a paging answer is not a 404 answer: a caller with one keeps its 404 choice', () => {
    const comAusente: PoliticaDeFalhaLi = { ...PAGINA, ausente: AUSENTE };
    expect(mapearFalhaDeLeituraLi(new LiNotFoundError({ ...ctx, status: 404 }), PAGINA)).toBeNull();
    expect(mapearFalhaDeLeituraLi(new LiNotFoundError({ ...ctx, status: 404 }), comAusente)).toBe(
      AUSENTE,
    );
    expect(mapearFalhaDeLeituraLi(limite, comAusente)).toBe(LIMITE);
  });
});

describe('mapearFalhaDeLeituraLi — whether a 403 parks is the caller’s; a 401 always parks', () => {
  it('a 403 under "a 403 parks" ⇒ null: the park is the caller’s, decided before this runs', () => {
    expect(mapearFalhaDeLeituraLi(erroAuth(403, 'ref.1'), ESTACIONA)).toBeNull();
  });

  it('a 403 under "a 403 does not park" ⇒ exactly the caller’s answer', () => {
    expect(mapearFalhaDeLeituraLi(erroAuth(403, 'ref.1'), NAO_ESTACIONA)).toBe(PROIBIDO);
  });

  it.each(POLITICAS)(
    '⚠️ NEAR-MISS: a 401 ⇒ null whatever the caller (%s): a 401 always parks',
    (_nome, politica) => {
      expect(mapearFalhaDeLeituraLi(erroAuth(401, 'ref.1'), politica)).toBeNull();
    },
  );
});

/* -------------------------------------------------------------------------- */
/*            The park behind it: a 401 always, a 403 when the caller says     */
/* -------------------------------------------------------------------------- */

describe('tratarFalhaDeLeituraLi — a 401/403: park, then answer as the park found it', () => {
  it.each(POLITICAS)(
    'a 401 for the stored token ⇒ PARKED, the reconexão aviso raised, `LiContaParadaError` (%s)',
    async (_nome, politica) => {
      const ctxLi = await contexto();
      const err = erroAuth(401, await refAtual());

      const r = await tratarFalhaDeLeituraLi(deps(), err, ctxLi, politica);

      expect(r).toMatchObject({
        tipo: 'propria',
        falha: { tipo: 'conta', classe: 'configuracao' },
      });
      expect(r.tipo === 'propria' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
        LiContaParadaError,
      );
      expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toMatchObject({
        status: 401,
        desdeMs: AGORA_MS,
      });
      expect(db.ler(caminhoAviso(chaveReconexao(CONTA)))).toMatchObject({ resolvidoEm: null });
    },
  );

  it('a 403 under "a 403 parks" ⇒ PARKED with status 403', async () => {
    const ctxLi = await contexto();
    const err = erroAuth(403, await refAtual());

    const r = await tratarFalhaDeLeituraLi(deps(), err, ctxLi, ESTACIONA);

    expect(r.tipo === 'propria' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
      LiContaParadaError,
    );
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toMatchObject({ status: 403 });
  });

  it('⚠️ NEAR-MISS: a 403 under "a 403 does not park" ⇒ the caller’s answer, NOTHING parked or read', async () => {
    const ctxLi = await contexto();
    const err = erroAuth(403, await refAtual());
    const leiturasAntes = db.leituras.length;

    const r = await tratarFalhaDeLeituraLi(deps(), err, ctxLi, NAO_ESTACIONA);

    expect(r).toEqual({ tipo: 'propria', falha: PROIBIDO });
    expect(db.escritas).toEqual([]);
    expect(db.leituras.slice(leiturasAntes)).toEqual([]);
    expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toBeNull();
    expect(db.ler(caminhoAviso(chaveReconexao(CONTA)))).toBeUndefined();
  });

  it('a 401 for a token REPLACED meanwhile ⇒ no park, `LiCredencialAlteradaError`', async () => {
    const ctxLi = await contexto();
    const err = erroAuth(401, await refAtual());
    seedCredencial(db, CONTA, { personalToken: TOKEN_B, tokenAtualizadoEmMs: AGORA_MS });

    const r = await tratarFalhaDeLeituraLi(deps(), err, ctxLi, ESTACIONA);

    expect(r.tipo === 'propria' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
      LiCredencialAlteradaError,
    );
    expect(db.escritas).toEqual([]);
  });

  it('a 401 after the credential was removed ⇒ `LiCredencialAusenteError`, nothing written', async () => {
    const ctxLi = await contexto();
    const err = erroAuth(401, await refAtual());
    await removerCredencial(asDb(db), CONTA);
    const escritasAntes = db.escritas.length;

    const r = await tratarFalhaDeLeituraLi(deps(), err, ctxLi, NAO_ESTACIONA);

    expect(r.tipo === 'propria' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
      LiCredencialAusenteError,
    );
    expect(db.escritas.slice(escritasAntes)).toEqual([]);
  });

  it('a credential found corrupt while parking ⇒ `LiCredencialInvalidaError` (an app error)', async () => {
    const ctxLi = await contexto();
    const err = erroAuth(401, await refAtual());
    db.seed(caminhoCredencial(CONTA), { personalToken: 42 });

    const r = await tratarFalhaDeLeituraLi(deps(), err, ctxLi, ESTACIONA);

    expect(r).toMatchObject({ tipo: 'propria', falha: { tipo: 'conta', classe: 'configuracao' } });
    expect(r.tipo === 'propria' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
      LiCredencialInvalidaError,
    );
  });

  it('the park losing its precondition every time ⇒ `LiEstacionamentoEmConflitoError`, transient', async () => {
    const ctxLi = await contexto();
    const err = erroAuth(401, await refAtual());
    db.falharEscrita(caminhoCredencial(CONTA), grpc(9, 'FAILED_PRECONDITION'));

    const r = await tratarFalhaDeLeituraLi(deps(), err, ctxLi, ESTACIONA);

    expect(r).toMatchObject({ tipo: 'propria', falha: { tipo: 'conta', classe: 'transitorio' } });
    expect(r.tipo === 'propria' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
      LiEstacionamentoEmConflitoError,
    );
  });

  it('the park failing on its own (a Firestore error) ⇒ that error, the caller’s to rethrow', async () => {
    const ctxLi = await contexto();
    const err = erroAuth(401, await refAtual());
    const falhaDoFirestore = grpc(14, 'UNAVAILABLE');
    db.falharLeitura(caminhoCredencial(CONTA), falhaDoFirestore);

    const r = await tratarFalhaDeLeituraLi(deps(), err, ctxLi, ESTACIONA);

    expect(r).toEqual({ tipo: 'alheia', erro: falhaDoFirestore });
  });

  it('a refusal with no context (it failed before one existed) is mapped, never parked', async () => {
    const leiturasAntes = db.leituras.length;
    const recusa = erroAuth(401, 'ref.1');

    const parkando = await tratarFalhaDeLeituraLi(deps(), recusa, null, ESTACIONA);
    const semParkar = await tratarFalhaDeLeituraLi(
      deps(),
      erroAuth(403, 'ref.1'),
      null,
      NAO_ESTACIONA,
    );

    expect(parkando).toEqual({ tipo: 'alheia', erro: recusa });
    expect(semParkar).toEqual({ tipo: 'propria', falha: PROIBIDO });
    expect(db.escritas).toEqual([]);
    expect(db.leituras.slice(leiturasAntes)).toEqual([]);
  });
});

describe('tratarFalhaDeLeituraLi — anything but a refusal is the pure mapper, unchanged', () => {
  it('an error the mapper owns ⇒ `propria`, with the mapper’s own answer', async () => {
    const ctxLi = await contexto();
    const nf = new LiNotFoundError({ ...ctx, status: 404 });

    expect(await tratarFalhaDeLeituraLi(deps(), nf, ctxLi, ESTACIONA)).toEqual({
      tipo: 'propria',
      falha: AUSENTE,
    });
  });

  it('an error it does not own ⇒ `alheia`, carrying the SAME object (rethrown unchanged)', async () => {
    const ctxLi = await contexto();
    const err = new LiHttpError({ ...ctx, status: 400 });
    const nf = new LiNotFoundError({ ...ctx, status: 404 });

    const r400 = await tratarFalhaDeLeituraLi(deps(), err, ctxLi, ESTACIONA);
    const r404 = await tratarFalhaDeLeituraLi(deps(), nf, ctxLi, NAO_ESTACIONA);

    expect(r400.tipo === 'alheia' && r400.erro).toBe(err);
    expect(r404.tipo === 'alheia' && r404.erro).toBe(nf);
    expect(db.escritas).toEqual([]);
  });

  it('a paging stop ⇒ the paging caller’s own answer; for a caller that names none, `alheia` with the SAME object', async () => {
    const ctxLi = await contexto();
    const limite = new LiPaginacaoError({ ...ctx, motivo: 'limite-de-paginas', paginas: 10 });

    const paginando = await tratarFalhaDeLeituraLi(deps(), limite, ctxLi, PAGINA);
    const semPaginar = await tratarFalhaDeLeituraLi(deps(), limite, ctxLi, ESTACIONA);

    expect(paginando).toEqual({ tipo: 'propria', falha: LIMITE });
    expect(semPaginar.tipo === 'alheia' && semPaginar.erro).toBe(limite);
    expect(db.escritas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*        What the mapper sees of a context: the conta, never its client       */
/* -------------------------------------------------------------------------- */

describe('tratarFalhaDeLeituraLi — answering a failure never reads Loja Integrada again', () => {
  it('its context parameter carries exactly the conta’s id and record: no client to read with', () => {
    expectTypeOf<keyof ContaDaFalha>().toEqualTypeOf<'integracaoId' | 'conta'>();
  });

  it.each(POLITICAS)(
    'a 401 parks through a context of which only the id and the record can be read (%s)',
    async (_nome, politica) => {
      const ctxLi = await contexto();
      const err = erroAuth(401, await refAtual());

      const r = await tratarFalhaDeLeituraLi(deps(), err, soAConta(ctxLi), politica);

      expect(r.tipo === 'propria' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
        LiContaParadaError,
      );
      expect(db.ler(caminhoCredencial(CONTA))?.reconexaoPendente).toMatchObject({ status: 401 });
    },
  );

  it('a 403 that parks does the same: the park reads the conta, nothing else', async () => {
    const ctxLi = await contexto();
    const err = erroAuth(403, await refAtual());

    const r = await tratarFalhaDeLeituraLi(deps(), err, soAConta(ctxLi), ESTACIONA);

    expect(r.tipo === 'propria' && r.falha.tipo === 'conta' && r.falha.erro).toBeInstanceOf(
      LiContaParadaError,
    );
  });
});
