/**
 * The feed submission's six package calls (step 12a, PR 12-c), against the
 * REAL package clients with a scripted `fetch` — no network (D11): the request
 * shapes, the two pre-signed URLs kept inside the module, the clock the upload
 * is judged by, the refresh rule (the reads' own, never the writes'), and the
 * report download at its size bound.
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one serves model shapes with
 * S3-shaped fake URLs and records anything it was not scripted for.
 */
import { gzipSync } from 'node:zlib';

import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonDocumentoFeedError,
  AmazonHttpError,
  AmazonSchemaError,
  CONTENT_TYPE_FEED_JSON,
  type CredencialSpApi,
  MARKETPLACE_ID_BR,
  MAX_RELATORIO_JSON_BYTES,
  TIPO_FEED_LISTINGS,
  URL_BASE_SP_API,
  criarClienteEscritaSpApi,
  criarClienteSpApi,
} from '@delfrance/integrations-amazon-sp-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENTE_USUARIO_AMAZON } from '../core/agente';
import { AGORA_MS, REF_VERSIONADA } from '../testing/fixtures';
import {
  baixarRelatorioFeedNaAmazon,
  criarFeedNaAmazon,
  enviarDocumentoFeedNaAmazon,
  lerFeedNaAmazon,
} from './feedsAmazon';

const FEED = '50001234567';
const DOC_ENTRADA = 'doc-feed-entrada-0001';
const DOC_RELATORIO = 'doc-feed-relatorio-0001';
const URL_UPLOAD = 'https://example-bucket.s3.amazonaws.com/entrada?X-Amz-Signature=0000sentinela';
const URL_RELATORIO =
  'https://example-bucket.s3.amazonaws.com/relatorio?X-Amz-Signature=0000sentinela';
const CAMINHO_DOCUMENTOS = '/feeds/2021-06-30/documents';
const CAMINHO_FEEDS = '/feeds/2021-06-30/feeds';

const RELATORIO = {
  header: { sellerId: 'A-VENDEDOR-TESTE', version: '2.0', feedId: FEED },
  issues: [{ messageId: 1, sku: 'SKU-1', code: '90000', severity: 'ERROR', message: 'x' }],
  summary: {
    errors: 1,
    warnings: 0,
    messagesProcessed: 2,
    messagesAccepted: 1,
    messagesInvalid: 1,
  },
};

/* ------------------------------- the scripted fetch ------------------------------- */

interface Pedido {
  readonly metodo: string;
  readonly url: URL;
  readonly cabecalhos: Headers;
  /** Whether the request carried a `headers` key at all. */
  readonly temCabecalhos: boolean;
  readonly corpo: unknown;
}

interface Passo {
  readonly metodo: string;
  /** `origin + pathname` the request must name. */
  readonly alvo: string;
  readonly resposta: () => Response;
}

const naoRoteirizados: string[] = [];
const redeGlobal: string[] = [];

beforeEach(() => {
  vi.stubGlobal('fetch', (input: unknown) => {
    redeGlobal.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(redeGlobal).toEqual([]);
  expect(naoRoteirizados).toEqual([]);
  redeGlobal.length = 0;
  naoRoteirizados.length = 0;
});

/** A `fetch` that answers the steps IN ORDER and records every request; anything else is refused. */
function roteiro(...passos: Passo[]) {
  const fila = [...passos];
  const pedidos: Pedido[] = [];
  const fetch = (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const metodo = init.method ?? 'GET';
    pedidos.push({
      metodo,
      url,
      cabecalhos: new Headers(init.headers),
      temCabecalhos: init.headers !== undefined,
      corpo: init.body ?? null,
    });
    const passo = fila[0];
    if (
      passo === undefined ||
      passo.metodo !== metodo ||
      passo.alvo !== url.origin + url.pathname
    ) {
      naoRoteirizados.push(`${metodo} ${url.origin}${url.pathname}`);
      return Promise.reject(new Error('teste: requisição fora do roteiro'));
    }
    fila.shift();
    return Promise.resolve(passo.resposta());
  };
  return { fetch: fetch as typeof globalThis.fetch, pedidos, restantes: fila };
}

const json = (status: number, corpo: unknown) => () =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

const spApi = (caminho: string) => `${URL_BASE_SP_API}${caminho}`;
const semConsulta = (url: string) => {
  const u = new URL(url);
  return u.origin + u.pathname;
};

const ERRO_401 = json(401, { errors: [{ code: 'Unauthorized', message: 'x' }] });

/** The access getter, recording every forced refresh. */
function acesso() {
  return vi.fn(
    (_opts?: { readonly forcarRenovacao?: boolean }): Promise<CredencialSpApi> =>
      Promise.resolve({ accessToken: 'tok|TESTE-acesso-feeds-naoreal', ref: REF_VERSIONADA }),
  );
}

const forcadas = (obterAcesso: ReturnType<typeof acesso>) =>
  obterAcesso.mock.calls.filter(([o]) => o?.forcarRenovacao === true).length;

/** The REAL write client over the scripted fetch. */
function escritor(fetch: typeof globalThis.fetch) {
  const obterAcesso = acesso();
  const cliente = criarClienteEscritaSpApi({
    obterCredencial: () => obterAcesso(),
    userAgent: AGENTE_USUARIO_AMAZON,
    fetch,
    gerarCorrelationId: () => 'corr-teste',
  });
  return { cliente, obterAcesso };
}

/** A context's read half: the REAL read client and the access getter it re-reads. */
function contexto(fetch: typeof globalThis.fetch) {
  const obterAcesso = acesso();
  const cliente = criarClienteSpApi({
    obterCredencial: () => obterAcesso(),
    userAgent: AGENTE_USUARIO_AMAZON,
    fetch,
    gerarCorrelationId: () => 'corr-teste',
  });
  return { cliente, obterAcesso };
}

const BYTES = new TextEncoder().encode('{"header":{},"messages":[]}');

/* --------------------------------- the document --------------------------------- */

describe('enviarDocumentoFeedNaAmazon — createFeedDocument, then the upload', () => {
  it('★ ONE POST of EXACTLY { contentType }, then ONE PUT of the bytes with ONE header; only the document id comes back', async () => {
    const r = roteiro(
      {
        metodo: 'POST',
        alvo: spApi(CAMINHO_DOCUMENTOS),
        resposta: json(201, { feedDocumentId: DOC_ENTRADA, url: URL_UPLOAD }),
      },
      { metodo: 'PUT', alvo: semConsulta(URL_UPLOAD), resposta: () => new Response(null) },
    );
    const { cliente } = escritor(r.fetch);

    const resultado = await enviarDocumentoFeedNaAmazon(cliente, BYTES, {
      fetch: r.fetch,
      agora: () => AGORA_MS,
    });

    expect(resultado).toEqual({ feedDocumentId: DOC_ENTRADA });
    // The bearer URL never leaves the module.
    expect(JSON.stringify(resultado)).not.toContain('sentinela');
    expect(r.pedidos.map((p) => p.metodo)).toEqual(['POST', 'PUT']);
    expect(JSON.parse(String(r.pedidos[0]?.corpo))).toEqual({
      contentType: CONTENT_TYPE_FEED_JSON,
    });
    const put = r.pedidos[1];
    expect(put?.url.href).toBe(URL_UPLOAD);
    expect([...(put?.cabecalhos.keys() ?? [])]).toEqual(['content-type']);
    expect(put?.cabecalhos.get('content-type')).toBe(CONTENT_TYPE_FEED_JSON);
    expect(put?.corpo).toBe(BYTES);
    expect(r.restantes).toEqual([]);
  });

  it('★ the URL’s 5-minute clock starts at the DOCUMENT’S ANSWER: a 403 at 5 min − 1 ms after it is a refusal, at 5 min it expired', async () => {
    const executar = async (aposRespostaMs: number) => {
      let relogio = AGORA_MS;
      const r = roteiro(
        {
          metodo: 'POST',
          alvo: spApi(CAMINHO_DOCUMENTOS),
          resposta: () => {
            // The document takes a minute to answer: a stamp taken BEFORE the
            // call would read the 403 a minute later than the module does.
            relogio += 60_000;
            return json(201, { feedDocumentId: DOC_ENTRADA, url: URL_UPLOAD })();
          },
        },
        {
          metodo: 'PUT',
          alvo: semConsulta(URL_UPLOAD),
          resposta: () => {
            relogio += aposRespostaMs;
            return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
          },
        },
      );
      const { cliente } = escritor(r.fetch);
      return enviarDocumentoFeedNaAmazon(cliente, BYTES, {
        fetch: r.fetch,
        agora: () => relogio,
      }).then(
        () => expect.unreachable('o envio deveria ter falhado'),
        (e: unknown) => e,
      );
    };

    const recusado = await executar(5 * 60_000 - 1);
    expect(recusado).toBeInstanceOf(AmazonDocumentoFeedError);
    expect((recusado as AmazonDocumentoFeedError).motivo).toBe('recusado');
    const expirado = await executar(5 * 60_000);
    expect((expirado as AmazonDocumentoFeedError).motivo).toBe('expirado');
  });

  it('★ a 401 on createFeedDocument propagates UNTOUCHED: one POST, zero forced refreshes (the engine’s rule wraps the write)', async () => {
    const r = roteiro({ metodo: 'POST', alvo: spApi(CAMINHO_DOCUMENTOS), resposta: ERRO_401 });
    const { cliente, obterAcesso } = escritor(r.fetch);

    await expect(
      enviarDocumentoFeedNaAmazon(cliente, BYTES, { fetch: r.fetch, agora: () => AGORA_MS }),
    ).rejects.toBeInstanceOf(AmazonAuthError);
    expect(r.pedidos).toHaveLength(1);
    expect(forcadas(obterAcesso)).toBe(0);
  });
});

/* ---------------------------------- the submission ---------------------------------- */

describe('criarFeedNaAmazon — createFeed, ONCE', () => {
  it('★ ONE POST of EXACTLY { feedType, marketplaceIds, inputFeedDocumentId }; the feedId comes back', async () => {
    const r = roteiro({
      metodo: 'POST',
      alvo: spApi(CAMINHO_FEEDS),
      resposta: json(202, { feedId: FEED }),
    });
    const { cliente } = escritor(r.fetch);

    await expect(criarFeedNaAmazon(cliente, DOC_ENTRADA)).resolves.toEqual({ feedId: FEED });
    expect(r.pedidos).toHaveLength(1);
    expect(JSON.parse(String(r.pedidos[0]?.corpo))).toEqual({
      feedType: TIPO_FEED_LISTINGS,
      marketplaceIds: [MARKETPLACE_ID_BR],
      inputFeedDocumentId: DOC_ENTRADA,
    });
  });

  it.each<[string, () => Response, (e: unknown) => boolean]>([
    [
      'a 202 with a non-digit feedId',
      json(202, { feedId: 'feed-x' }),
      (e) => e instanceof AmazonSchemaError,
    ],
    [
      'a 500',
      json(500, { errors: [{ code: 'InternalFailure', message: 'x' }] }),
      (e) => e instanceof AmazonHttpError && e.status === 500,
    ],
    ['a 401', ERRO_401, (e) => e instanceof AmazonAuthError],
  ])(
    '★ %s is thrown UNTOUCHED after ONE POST, never repeated here (the caller decides what may have landed)',
    async (_c, resposta, classe) => {
      const r = roteiro({ metodo: 'POST', alvo: spApi(CAMINHO_FEEDS), resposta });
      const { cliente, obterAcesso } = escritor(r.fetch);

      await expect(criarFeedNaAmazon(cliente, DOC_ENTRADA)).rejects.toSatisfy(classe);
      expect(r.pedidos).toHaveLength(1);
      expect(forcadas(obterAcesso)).toBe(0);
    },
  );
});

/* ------------------------------------ the read ------------------------------------ */

describe('lerFeedNaAmazon — getFeed', () => {
  it('ONE GET of the feed; the answer read tolerantly', async () => {
    const r = roteiro({
      metodo: 'GET',
      alvo: spApi(`${CAMINHO_FEEDS}/${FEED}`),
      resposta: json(200, { feedId: FEED, processingStatus: 'IN_PROGRESS' }),
    });
    const { cliente, obterAcesso } = contexto(r.fetch);

    await expect(lerFeedNaAmazon({ cliente, obterAcesso }, FEED)).resolves.toMatchObject({
      feedId: FEED,
      processingStatus: 'IN_PROGRESS',
    });
    expect(r.pedidos).toHaveLength(1);
  });

  it('★ a 401 ⇒ EXACTLY one forced refresh and one more GET', async () => {
    const r = roteiro(
      { metodo: 'GET', alvo: spApi(`${CAMINHO_FEEDS}/${FEED}`), resposta: ERRO_401 },
      {
        metodo: 'GET',
        alvo: spApi(`${CAMINHO_FEEDS}/${FEED}`),
        resposta: json(200, { feedId: FEED, processingStatus: 'DONE' }),
      },
    );
    const { cliente, obterAcesso } = contexto(r.fetch);

    await expect(lerFeedNaAmazon({ cliente, obterAcesso }, FEED)).resolves.toMatchObject({
      processingStatus: 'DONE',
    });
    expect(r.pedidos).toHaveLength(2);
    expect(forcadas(obterAcesso)).toBe(1);
  });

  it('NEAR-MISS: a second 401 after the refresh is final (no third GET)', async () => {
    const r = roteiro(
      { metodo: 'GET', alvo: spApi(`${CAMINHO_FEEDS}/${FEED}`), resposta: ERRO_401 },
      { metodo: 'GET', alvo: spApi(`${CAMINHO_FEEDS}/${FEED}`), resposta: ERRO_401 },
    );
    const { cliente, obterAcesso } = contexto(r.fetch);

    await expect(lerFeedNaAmazon({ cliente, obterAcesso }, FEED)).rejects.toBeInstanceOf(
      AmazonAuthError,
    );
    expect(r.pedidos).toHaveLength(2);
    expect(forcadas(obterAcesso)).toBe(1);
  });

  it('a feedId outside the digits-only grammar sends nothing', async () => {
    const r = roteiro();
    const { cliente, obterAcesso } = contexto(r.fetch);

    await expect(lerFeedNaAmazon({ cliente, obterAcesso }, '../x')).rejects.toBeInstanceOf(
      AmazonConfigError,
    );
    expect(r.pedidos).toEqual([]);
  });
});

/* ----------------------------------- the report ----------------------------------- */

/** getFeedDocument's answer, then the download's. */
function passosDoRelatorio(corpo: Uint8Array, compressao: string | null): Passo[] {
  return [
    {
      metodo: 'GET',
      alvo: spApi(`${CAMINHO_DOCUMENTOS}/${DOC_RELATORIO}`),
      resposta: json(200, {
        feedDocumentId: DOC_RELATORIO,
        url: URL_RELATORIO,
        ...(compressao === null ? {} : { compressionAlgorithm: compressao }),
      }),
    },
    {
      metodo: 'GET',
      alvo: semConsulta(URL_RELATORIO),
      resposta: () => new Response(corpo as Uint8Array<ArrayBuffer>, { status: 200 }),
    },
  ];
}

const bytesDe = (texto: string) => new TextEncoder().encode(texto);

describe('baixarRelatorioFeedNaAmazon — getFeedDocument, then the download', () => {
  it('★ the report behind the URL getFeedDocument answered, gzipped as it declared; header-free; only the report comes back', async () => {
    const r = roteiro(...passosDoRelatorio(gzipSync(bytesDe(JSON.stringify(RELATORIO))), 'GZIP'));
    const { cliente, obterAcesso } = contexto(r.fetch);

    const relatorio = await baixarRelatorioFeedNaAmazon({ cliente, obterAcesso }, DOC_RELATORIO, {
      fetch: r.fetch,
    });

    expect(relatorio.summary).toMatchObject({ errors: 1, messagesProcessed: 2 });
    expect(relatorio.issues?.[0]).toMatchObject({ sku: 'SKU-1', severity: 'ERROR' });
    expect(JSON.stringify(relatorio)).not.toContain('sentinela');
    const download = r.pedidos[1];
    expect(download?.url.href).toBe(URL_RELATORIO);
    expect(download?.temCabecalhos).toBe(false);
    expect(r.restantes).toEqual([]);
  });

  it('an uncompressed report (no compressionAlgorithm) is read as is', async () => {
    const r = roteiro(...passosDoRelatorio(bytesDe(JSON.stringify(RELATORIO)), null));
    const { cliente, obterAcesso } = contexto(r.fetch);

    const relatorio = await baixarRelatorioFeedNaAmazon({ cliente, obterAcesso }, DOC_RELATORIO, {
      fetch: r.fetch,
    });
    expect(relatorio.summary.messagesAccepted).toBe(1);
  });

  it('★ a 401 on getFeedDocument ⇒ one forced refresh, getFeedDocument once more, ONE download', async () => {
    const [documento, download] = passosDoRelatorio(
      gzipSync(bytesDe(JSON.stringify(RELATORIO))),
      'GZIP',
    );
    if (documento === undefined || download === undefined) throw new Error('roteiro incompleto');
    const r = roteiro(
      { metodo: 'GET', alvo: documento.alvo, resposta: ERRO_401 },
      documento,
      download,
    );
    const { cliente, obterAcesso } = contexto(r.fetch);

    await baixarRelatorioFeedNaAmazon({ cliente, obterAcesso }, DOC_RELATORIO, { fetch: r.fetch });
    expect(r.pedidos.map((p) => p.url.hostname)).toEqual([
      new URL(URL_BASE_SP_API).hostname,
      new URL(URL_BASE_SP_API).hostname,
      'example-bucket.s3.amazonaws.com',
    ]);
    expect(forcadas(obterAcesso)).toBe(1);
  });

  it('★ NEAR-MISS: a download failure is thrown UNTOUCHED and refreshes nothing (it carries no credential)', async () => {
    const [documento] = passosDoRelatorio(new Uint8Array(0), 'GZIP');
    if (documento === undefined) throw new Error('roteiro incompleto');
    const r = roteiro(documento, {
      metodo: 'GET',
      alvo: semConsulta(URL_RELATORIO),
      resposta: () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
    });
    const { cliente, obterAcesso } = contexto(r.fetch);

    const erro = await baixarRelatorioFeedNaAmazon({ cliente, obterAcesso }, DOC_RELATORIO, {
      fetch: r.fetch,
    }).then(
      () => expect.unreachable('o download deveria ter falhado'),
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(AmazonDocumentoFeedError);
    expect((erro as AmazonDocumentoFeedError).motivo).toBe('expirado');
    expect(r.pedidos).toHaveLength(2);
    expect(forcadas(obterAcesso)).toBe(0);
  });

  /** A valid report of EXACTLY `total` UTF-8 bytes (an unknown key pads it). */
  function relatorioDeTamanho(total: number): Uint8Array {
    const prefixo =
      '{"summary":{"errors":0,"warnings":0,"messagesProcessed":1,"messagesAccepted":1,' +
      '"messagesInvalid":0},"enchimento":"';
    const sufixo = '"}';
    const texto = prefixo + 'a'.repeat(total - prefixo.length - sufixo.length) + sufixo;
    const bytes = bytesDe(texto);
    expect(bytes.byteLength).toBe(total);
    return bytes;
  }

  it(
    '★ a report of EXACTLY MAX_RELATORIO_JSON_BYTES (32 MiB) parses; ONE byte over is grande-demais',
    { timeout: 60_000 },
    async () => {
      const noLimite = roteiro(
        ...passosDoRelatorio(
          gzipSync(relatorioDeTamanho(MAX_RELATORIO_JSON_BYTES), { level: 1 }),
          'GZIP',
        ),
      );
      const ctx = contexto(noLimite.fetch);
      const relatorio = await baixarRelatorioFeedNaAmazon(ctx, DOC_RELATORIO, {
        fetch: noLimite.fetch,
      });
      expect(relatorio.summary.messagesProcessed).toBe(1);

      const acima = roteiro(
        ...passosDoRelatorio(
          gzipSync(relatorioDeTamanho(MAX_RELATORIO_JSON_BYTES + 1), { level: 1 }),
          'GZIP',
        ),
      );
      const erro = await baixarRelatorioFeedNaAmazon(contexto(acima.fetch), DOC_RELATORIO, {
        fetch: acima.fetch,
      }).then(
        () => expect.unreachable('um relatório acima do limite deveria ser recusado'),
        (e: unknown) => e,
      );
      expect(erro).toBeInstanceOf(AmazonDocumentoFeedError);
      expect((erro as AmazonDocumentoFeedError).motivo).toBe('grande-demais');
    },
  );
});
