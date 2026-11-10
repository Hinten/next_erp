import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  CATEGORIAS_IMPORTACAO_LI,
  CODIGO_ERRO_LI,
  FASE_IMPORTACAO_LI,
  FOTOS_IMPORTACAO_LI,
  MODO_IMPORTACAO_LI,
  OPCOES_IMPORTACAO_LI_PADRAO,
  type RespostaImportacaoLi,
  STATUS_IMPORTACAO_LI,
} from '@delfrance/schemas';

/**
 * The six product-import calls of the browser client (master plan step 9).
 *
 * Pinned, each with its near miss:
 *  - the WIRE: method, path (both ids percent-encoded), the start body and the
 *    page cursor exactly as the routes read them;
 *  - the start body is rebuilt by name and parsed through the shared strict
 *    schema: under "só vincular" the category and photo options go at their
 *    defaults, and a contradictory body never leaves the browser;
 *  - every answer is READ against the shared contract, and a key a newer backend
 *    adds is stripped, never refused;
 *  - a busy start's 409 keeps the running `jobId` on the error;
 *  - a 404 WITHOUT the envelope (a backend older than the import) has no code,
 *    unlike a 404 that names a missing job;
 *  - every call gives up at its 30 s deadline, and a read's caller abort comes
 *    back as the abort itself.
 *
 * ⚠️ No request leaves this file: every client gets an injected fetch, and the
 * base URL is an `.invalid` host. The job ids are obviously fake.
 */

vi.mock('@/lib/auth/useAuth', () => ({ useAuth: () => ({ user: null }) }));

const {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  LojaIntegradaClientTempoEsgotadoError,
  PRAZO_IMPORTACAO_LI_MS,
  corpoInicioImportacaoLi,
  createLojaIntegradaClient,
} = await import('./client');

type HttpError = InstanceType<typeof LojaIntegradaClientHttpError>;

const BASE = 'https://li.backend.invalid';
const CONTA = `${BASE}/api/marketplace/loja-integrada/conta`;

interface Chamada {
  readonly url: string;
  readonly init: RequestInit;
}

function cliente(responder: (c: Chamada) => Promise<Response> | Response) {
  const chamadas: Chamada[] = [];
  const getAuthToken = vi.fn(async () => 'id-token-firebase');
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const chamada = { url: String(input), init: init ?? {} };
    chamadas.push(chamada);
    return responder(chamada);
  });
  const c = createLojaIntegradaClient({ baseUrl: `${BASE}/`, getAuthToken, fetch: fetchImpl });
  return { c, chamadas, getAuthToken };
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function corpoEnviado(c: Chamada): unknown {
  return JSON.parse(String(c.init.body));
}

const JOB: RespostaImportacaoLi = {
  jobId: 'job-teste-1',
  integracaoId: 'conta-1',
  status: STATUS_IMPORTACAO_LI.executando,
  fase: FASE_IMPORTACAO_LI.familias,
  motivo: null,
  modo: MODO_IMPORTACAO_LI.simular,
  alvo: ALVO_IMPORTACAO_LI.todos,
  acao: ACAO_IMPORTACAO_LI.soVincular,
  categorias: CATEGORIAS_IMPORTACAO_LI.soVincular,
  fotos: FOTOS_IMPORTACAO_LI.naoImportar,
  selecionados: 0,
  simulacaoId: null,
  iniciadoEmMs: 1_790_000_000_000,
  atualizadoEmMs: 1_790_000_060_000,
  concluidoEmMs: null,
  contadores: {
    familias: 12,
    vinculados: 10,
    criados: 0,
    completados: 0,
    semMudanca: 2,
    pendenciasAcionaveis: 1,
    pendenciasInformativas: 3,
    fotos: 0,
    falhas: 0,
  },
  listagem: { paginas: 2, linhas: 150, totalLi: 150, divergente: false },
  pausas429: 0,
  fotosIndisponiveis: false,
};

const ITEM = {
  liId: 182904918,
  tipo: 'atributo',
  sku: 'SKU-FALSO-1',
  nome: 'Produto de teste',
  filhos: 2,
  situacaoErp: 'vinculado',
  erpId: 'produto-falso-1',
  acao: 'vincular',
  aplicada: false,
  camposPreenchidos: [],
  categoriasCriadas: [],
  pendencias: [{ codigo: 'nome-cortado', acionavel: false, liId: null, referencias: [] }],
  atualizadoEmMs: 1_790_000_060_000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('iniciarImportacao — the start', () => {
  it('POST …/conta/<id>/importacoes with the parsed body, every default explicit', async () => {
    const { c, chamadas } = cliente(() => json(202, { jobId: 'job-teste-1' }));

    await expect(
      c.iniciarImportacao('conta-1', {
        modo: MODO_IMPORTACAO_LI.simular,
        alvo: ALVO_IMPORTACAO_LI.todos,
        acao: ACAO_IMPORTACAO_LI.completar,
      }),
    ).resolves.toEqual({ jobId: 'job-teste-1' });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe(`${CONTA}/conta-1/importacoes`);
    expect(chamadas[0]!.init.method).toBe('POST');
    expect(chamadas[0]!.init.headers).toMatchObject({
      Authorization: 'Bearer id-token-firebase',
      'Content-Type': 'application/json',
    });
    expect(corpoEnviado(chamadas[0]!)).toEqual({
      modo: MODO_IMPORTACAO_LI.simular,
      alvo: ALVO_IMPORTACAO_LI.todos,
      acao: ACAO_IMPORTACAO_LI.completar,
      categorias: OPCOES_IMPORTACAO_LI_PADRAO.categorias,
      fotos: OPCOES_IMPORTACAO_LI_PADRAO.fotos,
      selecionados: [],
      simulacaoId: null,
    });
  });

  it('⭐ under "só vincular" the category and photo options go at their DEFAULTS', async () => {
    const { c, chamadas } = cliente(() => json(202, { jobId: 'job-teste-1' }));

    // A dialog that switched from "Completar" back still holds its picks.
    await c.iniciarImportacao('conta-1', {
      modo: MODO_IMPORTACAO_LI.aplicar,
      alvo: ALVO_IMPORTACAO_LI.todos,
      acao: ACAO_IMPORTACAO_LI.soVincular,
      categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
      fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
    });

    expect(corpoEnviado(chamadas[0]!)).toMatchObject({
      acao: ACAO_IMPORTACAO_LI.soVincular,
      categorias: CATEGORIAS_IMPORTACAO_LI.soVincular,
      fotos: FOTOS_IMPORTACAO_LI.naoImportar,
    });
  });

  it('NEAR MISS — under "completar" the same picks are sent as given', () => {
    expect(
      corpoInicioImportacaoLi({
        modo: MODO_IMPORTACAO_LI.aplicar,
        alvo: ALVO_IMPORTACAO_LI.todos,
        acao: ACAO_IMPORTACAO_LI.completar,
        categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
        fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
      }),
    ).toMatchObject({
      categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
      fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
    });
  });

  it('"Importar selecionados" sends exactly the ids and the simulation they came from', async () => {
    const { c, chamadas } = cliente(() => json(202, { jobId: 'job-teste-2' }));

    await c.iniciarImportacao('conta-1', {
      modo: MODO_IMPORTACAO_LI.aplicar,
      alvo: ALVO_IMPORTACAO_LI.selecionados,
      acao: ACAO_IMPORTACAO_LI.completar,
      categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
      fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
      selecionados: [182904918, 182904919],
      simulacaoId: 'job-teste-1',
    });

    expect(corpoEnviado(chamadas[0]!)).toEqual({
      modo: MODO_IMPORTACAO_LI.aplicar,
      alvo: ALVO_IMPORTACAO_LI.selecionados,
      acao: ACAO_IMPORTACAO_LI.completar,
      categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
      fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
      selecionados: [182904918, 182904919],
      simulacaoId: 'job-teste-1',
    });
  });

  it('the body is rebuilt BY NAME: a key the caller object carries never reaches the strict route', async () => {
    const { c, chamadas } = cliente(() => json(202, { jobId: 'job-teste-1' }));
    const daTela = {
      modo: MODO_IMPORTACAO_LI.simular,
      alvo: ALVO_IMPORTACAO_LI.todos,
      acao: ACAO_IMPORTACAO_LI.soVincular,
      contas: ['conta-1'],
    };

    await c.iniciarImportacao('conta-1', daTela);

    expect(Object.keys(corpoEnviado(chamadas[0]!) as object).sort()).toEqual([
      'acao',
      'alvo',
      'categorias',
      'fotos',
      'modo',
      'selecionados',
      'simulacaoId',
    ]);
  });

  it('a contradictory body throws ZodError with NO request and no token asked for', async () => {
    const { c, chamadas, getAuthToken } = cliente(() => json(202, { jobId: 'job-teste-1' }));

    const semIds = await c
      .iniciarImportacao('conta-1', {
        modo: MODO_IMPORTACAO_LI.aplicar,
        alvo: ALVO_IMPORTACAO_LI.selecionados,
        acao: ACAO_IMPORTACAO_LI.soVincular,
      })
      .catch((e: unknown) => e);
    const idsForaDoAlvo = await c
      .iniciarImportacao('conta-1', {
        modo: MODO_IMPORTACAO_LI.aplicar,
        alvo: ALVO_IMPORTACAO_LI.todos,
        acao: ACAO_IMPORTACAO_LI.soVincular,
        selecionados: [182904918],
      })
      .catch((e: unknown) => e);

    expect(semIds).toBeInstanceOf(ZodError);
    expect(idsForaDoAlvo).toBeInstanceOf(ZodError);
    expect(chamadas).toHaveLength(0);
    expect(getAuthToken).not.toHaveBeenCalled();
  });

  it('⭐ a busy start (409 LI_IMPORTACAO_EM_ANDAMENTO) keeps the running jobId on the error', async () => {
    const { c } = cliente(() =>
      json(409, {
        error: 'Esta conta já tem uma importação de produtos em andamento.',
        code: CODIGO_ERRO_LI.importacaoEmAndamento,
        jobId: 'job-em-curso-1',
      }),
    );

    const err = (await c
      .iniciarImportacao('conta-1', {
        modo: MODO_IMPORTACAO_LI.simular,
        alvo: ALVO_IMPORTACAO_LI.todos,
        acao: ACAO_IMPORTACAO_LI.soVincular,
      })
      .catch((e: unknown) => e)) as HttpError;

    expect(err).toBeInstanceOf(LojaIntegradaClientHttpError);
    expect(err.status).toBe(409);
    expect(err.code).toBe(CODIGO_ERRO_LI.importacaoEmAndamento);
    expect(err.jobId).toBe('job-em-curso-1');
  });

  it('NEAR MISS — an envelope without jobId leaves it null; a non-string jobId is not our envelope at all', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const opcoes = {
      modo: MODO_IMPORTACAO_LI.simular,
      alvo: ALVO_IMPORTACAO_LI.todos,
      acao: ACAO_IMPORTACAO_LI.soVincular,
    };
    const semId = cliente(() =>
      json(409, { error: 'Em andamento.', code: CODIGO_ERRO_LI.importacaoEmAndamento }),
    );
    const idNumerico = cliente(() =>
      json(409, { error: 'Em andamento.', code: CODIGO_ERRO_LI.importacaoEmAndamento, jobId: 7 }),
    );

    const a = (await semId.c
      .iniciarImportacao('conta-1', opcoes)
      .catch((e: unknown) => e)) as HttpError;
    const b = (await idNumerico.c
      .iniciarImportacao('conta-1', opcoes)
      .catch((e: unknown) => e)) as HttpError;

    expect(a.code).toBe(CODIGO_ERRO_LI.importacaoEmAndamento);
    expect(a.jobId).toBeNull();
    // The envelope schema refuses the whole body: no code, no id — never a cast.
    expect(b).toBeInstanceOf(LojaIntegradaClientHttpError);
    expect(b.code).toBeNull();
    expect(b.jobId).toBeNull();
  });

  it('the switch off (503 LI_CHAMADAS_DESLIGADAS) reaches the caller as that code', async () => {
    const { c } = cliente(() =>
      json(503, { error: 'Desligadas.', code: CODIGO_ERRO_LI.chamadasDesligadas }),
    );

    const err = (await c
      .iniciarImportacao('conta-1', {
        modo: MODO_IMPORTACAO_LI.simular,
        alvo: ALVO_IMPORTACAO_LI.todos,
        acao: ACAO_IMPORTACAO_LI.soVincular,
      })
      .catch((e: unknown) => e)) as HttpError;

    expect(err.status).toBe(503);
    expect(err.code).toBe(CODIGO_ERRO_LI.chamadasDesligadas);
  });
});

describe('the reads and the cancel — the wire', () => {
  it('importacoes → GET …/conta/<id>/importacoes, no body', async () => {
    const { c, chamadas } = cliente(() => json(200, { importacoes: [JOB] }));

    await expect(c.importacoes('a/b c')).resolves.toEqual({ importacoes: [JOB] });

    expect(chamadas[0]!.url).toBe(`${CONTA}/a%2Fb%20c/importacoes`);
    expect(chamadas[0]!.init.method).toBe('GET');
    expect(chamadas[0]!.init.body).toBeUndefined();
  });

  it('importacao → GET …/importacoes/<jobId>, both ids percent-encoded', async () => {
    const { c, chamadas } = cliente(() => json(200, JOB));

    await expect(c.importacao('conta-1', 'job/1 x')).resolves.toEqual(JOB);

    expect(chamadas[0]!.url).toBe(`${CONTA}/conta-1/importacoes/job%2F1%20x`);
    expect(chamadas[0]!.init.method).toBe('GET');
  });

  it('cancelarImportacao → POST …/importacoes/<jobId>/cancelar with NO body', async () => {
    const cancelado = { ...JOB, status: STATUS_IMPORTACAO_LI.cancelado };
    const { c, chamadas } = cliente(() => json(200, cancelado));

    await expect(c.cancelarImportacao('conta-1', 'job-teste-1')).resolves.toEqual(cancelado);

    expect(chamadas[0]!.url).toBe(`${CONTA}/conta-1/importacoes/job-teste-1/cancelar`);
    expect(chamadas[0]!.init.method).toBe('POST');
    expect(chamadas[0]!.init.body).toBeUndefined();
    expect(chamadas[0]!.init.headers).not.toHaveProperty('Content-Type');
  });

  it('itensImportacao → GET …/itens, `?depois=` only for a real cursor', async () => {
    const { c, chamadas } = cliente(() => json(200, { itens: [ITEM], proximo: null }));

    await c.itensImportacao('conta-1', 'job-teste-1');
    await c.itensImportacao('conta-1', 'job-teste-1', null);
    // NEAR MISS: an empty cursor is the first page, never `?depois=`.
    await c.itensImportacao('conta-1', 'job-teste-1', '');
    await c.itensImportacao('conta-1', 'job-teste-1', '182904918');
    await c.itensImportacao('conta-1', 'job-teste-1', 'a&b=c');

    const itens = `${CONTA}/conta-1/importacoes/job-teste-1/itens`;
    expect(chamadas.map((ch) => ch.url)).toEqual([
      itens,
      itens,
      itens,
      `${itens}?depois=182904918`,
      `${itens}?depois=a%26b%3Dc`,
    ]);
  });

  it('revisaoImportacao → GET …/revisao, the same cursor rule', async () => {
    const { c, chamadas } = cliente(() => json(200, { entradas: [], proximo: null }));

    await c.revisaoImportacao('conta-1', 'job-teste-1');
    await c.revisaoImportacao('conta-1', 'job-teste-1', 'produto-falso-9');

    const revisao = `${CONTA}/conta-1/importacoes/job-teste-1/revisao`;
    expect(chamadas.map((ch) => ch.url)).toEqual([revisao, `${revisao}?depois=produto-falso-9`]);
  });
});

describe('every 2xx is read against the shared contract', () => {
  it('a job with a status outside the closed enum is RESPOSTA_INVALIDA, naming the field', async () => {
    const { c } = cliente(() => json(200, { ...JOB, status: 'rodando' }));

    const err = (await c
      .importacao('conta-1', 'job-teste-1')
      .catch((e: unknown) => e)) as HttpError;

    expect(err).toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
    expect(err.campos).toEqual(['status']);
  });

  it('NEAR MISS — an unknown phase, motivo or pendência code PARSES (plain strings), and a new key is stripped', async () => {
    const { c } = cliente((ch) =>
      ch.url.endsWith('/itens')
        ? json(200, {
            itens: [
              {
                ...ITEM,
                situacaoErp: 'nova-situacao',
                pendencias: [{ codigo: 'codigo-novo', acionavel: true }],
              },
            ],
            proximo: null,
            extra: 1,
          })
        : json(200, { ...JOB, fase: 'fase-nova', motivo: 'motivo-novo', extra: true }),
    );

    const job = await c.importacao('conta-1', 'job-teste-1');
    const pagina = await c.itensImportacao('conta-1', 'job-teste-1');

    expect(job.fase).toBe('fase-nova');
    expect(job.motivo).toBe('motivo-novo');
    expect(job).not.toHaveProperty('extra');
    expect(pagina.itens[0]!.situacaoErp).toBe('nova-situacao');
    expect(pagina.itens[0]!.pendencias[0]).toEqual({
      codigo: 'codigo-novo',
      acionavel: true,
      liId: null,
      referencias: [],
    });
    expect(pagina).not.toHaveProperty('extra');
  });

  it('a tax-review entry keeps an unknown motivo verbatim', async () => {
    const { c } = cliente(() =>
      json(200, {
        entradas: [{ produtoId: 'produto-falso-1', motivos: ['produto-criado', 'motivo-novo'] }],
        proximo: null,
      }),
    );

    const lista = await c.revisaoImportacao('conta-1', 'job-teste-1');

    expect(lista.entradas[0]).toEqual({
      produtoId: 'produto-falso-1',
      motivos: ['produto-criado', 'motivo-novo'],
      liId: null,
      desdeJobId: null,
      desdeMs: null,
    });
  });
});

describe('the feature probe: a 404 with no code is a backend without the import', () => {
  it('⭐ a 404 WITHOUT the envelope has NO code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { c } = cliente(
      () =>
        new Response('<!DOCTYPE html><html>404</html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const err = (await c.importacoes('conta-1').catch((e: unknown) => e)) as HttpError;

    expect(err).toBeInstanceOf(LojaIntegradaClientHttpError);
    expect(err).not.toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
    expect(err.status).toBe(404);
    expect(err.code).toBeNull();
  });

  it('NEAR MISS — a missing job is a 404 that CARRIES its code', async () => {
    const { c } = cliente(() =>
      json(404, {
        error: 'Importação não encontrada.',
        code: CODIGO_ERRO_LI.importacaoNaoEncontrada,
      }),
    );

    const err = (await c
      .importacao('conta-1', 'job-teste-1')
      .catch((e: unknown) => e)) as HttpError;

    expect(err.status).toBe(404);
    expect(err.code).toBe(CODIGO_ERRO_LI.importacaoNaoEncontrada);
  });
});

/** A fetch that only ever settles by its signal aborting (`client.catalogo.test.ts`'s). */
function fetchQueSoAborta(chamadas: Chamada[]) {
  return vi.fn(
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        chamadas.push({ url: String(input), init: init ?? {} });
        const sinal = init?.signal;
        if (!sinal) return;
        if (sinal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        sinal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }),
  );
}

describe('the deadline and the caller signal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function clienteQueSoAborta() {
    const chamadas: Chamada[] = [];
    const c = createLojaIntegradaClient({
      baseUrl: BASE,
      getAuthToken: async () => 'id-token-firebase',
      fetch: fetchQueSoAborta(chamadas),
    });
    return { c, chamadas };
  }

  it.each([
    [
      'iniciarImportacao',
      (c: ReturnType<typeof createLojaIntegradaClient>) =>
        c.iniciarImportacao('conta-1', {
          modo: MODO_IMPORTACAO_LI.simular,
          alvo: ALVO_IMPORTACAO_LI.todos,
          acao: ACAO_IMPORTACAO_LI.soVincular,
        }),
    ],
    ['importacoes', (c: ReturnType<typeof createLojaIntegradaClient>) => c.importacoes('conta-1')],
    [
      'importacao',
      (c: ReturnType<typeof createLojaIntegradaClient>) => c.importacao('conta-1', 'job-teste-1'),
    ],
    [
      'cancelarImportacao',
      (c: ReturnType<typeof createLojaIntegradaClient>) =>
        c.cancelarImportacao('conta-1', 'job-teste-1'),
    ],
    [
      'itensImportacao',
      (c: ReturnType<typeof createLojaIntegradaClient>) =>
        c.itensImportacao('conta-1', 'job-teste-1'),
    ],
    [
      'revisaoImportacao',
      (c: ReturnType<typeof createLojaIntegradaClient>) =>
        c.revisaoImportacao('conta-1', 'job-teste-1'),
    ],
  ])(
    '%s gives up at PRAZO_IMPORTACAO_LI_MS (30 s: no Loja Integrada call)',
    async (_nome, chamar) => {
      expect(PRAZO_IMPORTACAO_LI_MS).toBe(30_000);
      const { c, chamadas } = clienteQueSoAborta();

      const resultado = chamar(c).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(PRAZO_IMPORTACAO_LI_MS - 1);
      expect(chamadas[0]!.init.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const err = await resultado;
      expect(chamadas[0]!.init.signal?.aborted).toBe(true);
      expect(err).toBeInstanceOf(LojaIntegradaClientTempoEsgotadoError);
      expect(err).toBeInstanceOf(LojaIntegradaClientNetworkError);
    },
  );

  it("a read's CALLER abort (a query cancelled) comes back as the abort itself", async () => {
    const { c, chamadas } = clienteQueSoAborta();
    const controle = new AbortController();

    const resultado = c
      .importacao('conta-1', 'job-teste-1', { sinal: controle.signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    controle.abort();

    const err = await resultado;
    expect(chamadas[0]!.init.signal?.aborted).toBe(true);
    expect(err).toBeInstanceOf(DOMException);
    expect(err).not.toBeInstanceOf(LojaIntegradaClientNetworkError);
  });

  it('an answer in time clears the deadline — no timer outlives the call', async () => {
    const { c } = cliente(() => json(200, { importacoes: [] }));

    await c.importacoes('conta-1');

    expect(vi.getTimerCount()).toBe(0);
  });
});
