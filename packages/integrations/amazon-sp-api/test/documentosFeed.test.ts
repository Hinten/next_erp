import { type FlateStreamHandler, gzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { crc32 } from '../src/crc32';
import {
  baixarRelatorioFeedAmazon,
  enviarDocumentoFeedAmazon,
  MAX_RELATORIO_FEED_BYTES,
  MAX_RELATORIO_JSON_BYTES,
  type OpcoesDownloadRelatorioFeed,
  type OpcoesEnvioDocumentoFeed,
  VALIDADE_URL_DOCUMENTO_FEED_MS,
} from '../src/documentosFeed';
import {
  AmazonDocumentoFeedError,
  ehTransitoriaDocumentoFeed,
  type MotivoDocumentoFeed,
} from '../src/errors';
import { CONTENT_TYPE_FEED_JSON } from '../src/feeds';
import { PRAZO_AMAZON_MS } from '../src/prazos';
import { URL_CLOUDFRONT_DO_SANDBOX, URL_DOCUMENTO_FEED_FALSA } from './_fixtures/sandbox';
import { falha, observar, textosDoErro } from './_helpers/mockFetch';

/*
 * Every document and report here is built IN the test (fflate's `gzipSync` and
 * byte patches for the corrupt cases): never a real feed, never a file on disk.
 * The URL is the S3-shaped fake of `sandbox.ts`: no region, no real bucket.
 */

/** The streaming inflaters the download created, and the non-empty slices pushed into them. */
const inflacao = vi.hoisted(() => ({ criados: 0, fatias: 0 }));

vi.mock('fflate', async (importOriginal) => {
  const real = await importOriginal<typeof import('fflate')>();
  class GunzipContado extends real.Gunzip {
    constructor(cb?: FlateStreamHandler) {
      super(cb);
      inflacao.criados += 1;
    }
    override push(chunk: Uint8Array, final?: boolean): void {
      // fflate's own re-entry for a following member pushes an empty chunk.
      if (chunk.length > 0) inflacao.fatias += 1;
      super.push(chunk, final);
    }
  }
  return { ...real, Gunzip: GunzipContado };
});

const URL_NEUTRA = URL_DOCUMENTO_FEED_FALSA;

const bytes = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

/** A valid processing report, as text. */
const RELATORIO = JSON.stringify({
  header: { sellerId: 'SELLER-TESTE', version: '2.0', feedId: '3485934' },
  issues: [{ messageId: 1, sku: 'A', code: '90220', severity: 'ERROR', message: 'm' }],
  summary: {
    errors: 1,
    warnings: 0,
    messagesProcessed: 2,
    messagesAccepted: 1,
    messagesInvalid: 1,
  },
});

/* ---------------------------- byte-level helpers ---------------------------- */

function poe32(b: Uint8Array, i: number, v: number): void {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(i, v >>> 0, true);
}

/** A copy of `gz` with its trailer's ISIZE replaced. */
function comIsize(gz: Uint8Array, isize: number): Uint8Array {
  const c = new Uint8Array(gz);
  poe32(c, c.length - 4, isize);
  return c;
}

/** A copy of `gz` with its trailer's CRC-32 replaced. */
function comCrc(gz: Uint8Array, crc: number): Uint8Array {
  const c = new Uint8Array(gz);
  poe32(c, c.length - 8, crc);
  return c;
}

/* ------------------------------ the scripted fetch ------------------------------ */

type ArgsFetch = Parameters<typeof globalThis.fetch>;

/** Every request this file's scripted fetches saw. */
const vistas: ArgsFetch[] = [];

function roteiro(resposta: (...args: ArgsFetch) => Response | Promise<Response>) {
  return vi.fn(async (...args: ArgsFetch) => {
    vistas.push(args);
    return resposta(...args);
  });
}

function hrefDe(input: ArgsFetch[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

afterEach(() => {
  // Every request was either the one-header PUT or a header-free GET, to an
  // object-storage host, never a redirect follower.
  const fora = vistas.filter(([input, init]) => {
    const url = new URL(hrefDe(input));
    if (!url.hostname.endsWith('.amazonaws.com') || init?.redirect !== 'error') return true;
    if (init.method === 'GET') return init.headers !== undefined || init.body !== undefined;
    if (init.method !== 'PUT') return true;
    const cabecalhos = Object.keys(init.headers ?? {});
    return cabecalhos.length !== 1 || cabecalhos[0] !== 'content-type';
  });
  vistas.length = 0;
  expect(fora).toEqual([]);
});

/** A `Response` body: bytes are copied into a fresh `ArrayBuffer` (what `BodyInit` takes). */
function corpoDe(corpo: Uint8Array | ReadableStream<Uint8Array> | string | null): BodyInit | null {
  return corpo instanceof Uint8Array ? new Uint8Array(corpo) : corpo;
}

const responde = (corpo: Uint8Array | ReadableStream<Uint8Array> | string | null, status = 200) =>
  roteiro(() => new Response(corpoDe(corpo), { status }));

/** A body served one chunk per pull, counting pulls, with a `cancel` spy. */
function corpoEmPedacos(pedacos: readonly Uint8Array[]) {
  let puxados = 0;
  const cancelar = vi.fn();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const p = pedacos[puxados];
        puxados += 1;
        if (p === undefined) controller.close();
        else controller.enqueue(p);
      },
      cancel: cancelar,
    },
    { highWaterMark: 0 },
  );
  return { stream, cancelar, puxados: () => puxados };
}

async function motivoDe(p: Promise<unknown>): Promise<MotivoDocumentoFeed> {
  const err = await falha(p);
  expect(err).toBeInstanceOf(AmazonDocumentoFeedError);
  return (err as AmazonDocumentoFeedError).motivo;
}

const EMITIDO_EM = 1_000_000;

/** The upload's options: the clock `segundos` after the URL was issued. */
const envio = (fetch: typeof globalThis.fetch, segundos = 0, sinal?: AbortSignal) => ({
  fetch,
  emitidoEmMs: EMITIDO_EM,
  agora: () => EMITIDO_EM + segundos * 1000,
  sinal,
});

const DOCUMENTO = bytes('{"header":{},"messages":[]}');

/** The S3 XML error answer for a refused pre-signed request. */
const xmlS3 = (codigo: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${codigo}</Code><Message>MARCADOR-DA-MENSAGEM-S3</Message></Error>`;

/* -------------------------------------------------------------------------- */
/*                                 The upload                                 */
/* -------------------------------------------------------------------------- */

describe('enviarDocumentoFeedAmazon: the request', () => {
  it('★ ONE PUT with exactly one header (the declared content type), the bytes, redirect: error', async () => {
    const f = responde(null, 200);
    await enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, envio(f));
    expect(f).toHaveBeenCalledTimes(1);
    const [input, init] = f.mock.calls[0] ?? [];
    expect(hrefDe(input ?? '')).toBe(URL_NEUTRA);
    expect(Object.keys(init ?? {}).sort()).toEqual([
      'body',
      'headers',
      'method',
      'redirect',
      'signal',
    ]);
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toStrictEqual({ 'content-type': CONTENT_TYPE_FEED_JSON });
    expect(init?.body).toBe(DOCUMENTO);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('any 2xx is success, its body discarded', async () => {
    for (const status of [200, 201, 204, 299]) {
      await expect(
        enviarDocumentoFeedAmazon(
          URL_NEUTRA,
          DOCUMENTO,
          envio(responde(status === 204 ? null : 'ok', status)),
        ),
      ).resolves.toBeUndefined();
    }
  });

  it.each([
    ['the sandbox’s CloudFront URL', URL_CLOUDFRONT_DO_SANDBOX],
    ['http:', 'http://bucket-teste.s3.amazonaws.com/x'],
    ['a port', 'https://bucket-teste.s3.amazonaws.com:8443/x'],
    ['userinfo', 'https://u:p@bucket-teste.s3.amazonaws.com/x'],
    ['the suffix as a subdomain of a foreign host', 'https://amazonaws.com.evil.example/x'],
    ['not a URL', 'nao e uma url'],
  ])(
    '★ %s is refused BEFORE fetch (url-invalida), by the upload and the download',
    async (_caso, url) => {
      const f = responde(RELATORIO);
      expect(await motivoDe(enviarDocumentoFeedAmazon(url, DOCUMENTO, envio(f)))).toBe(
        'url-invalida',
      );
      expect(await motivoDe(baixarRelatorioFeedAmazon(url, { fetch: f, compressao: null }))).toBe(
        'url-invalida',
      );
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('★ calling without fetch is a type error, and the global fetch is never used', async () => {
    const global = vi.fn(async () => new Response(RELATORIO));
    const original = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: global,
    });
    try {
      // @ts-expect-error — `fetch` is REQUIRED: there is no global default.
      const p1 = enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, { emitidoEmMs: 0 });
      // @ts-expect-error — `fetch` is REQUIRED here too.
      const p2 = baixarRelatorioFeedAmazon(URL_NEUTRA, { compressao: null });
      const semFetch1 = { emitidoEmMs: 0 } as unknown as OpcoesEnvioDocumentoFeed;
      const semFetch2 = { compressao: null } as unknown as OpcoesDownloadRelatorioFeed;
      for (const err of [
        await falha(p1),
        await falha(p2),
        await falha(enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, semFetch1)),
        await falha(baixarRelatorioFeedAmazon(URL_NEUTRA, semFetch2)),
      ]) {
        // A wiring bug stays a programming error: never a retryable 'rede'.
        expect(err).toBeInstanceOf(TypeError);
        expect(err).not.toBeInstanceOf(AmazonDocumentoFeedError);
      }
      expect(global).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});

describe('enviarDocumentoFeedAmazon: the answer', () => {
  it('★ a 403 30 s after the URL was issued is recusado, with its S3 code: deterministic', async () => {
    const err = await falha(
      enviarDocumentoFeedAmazon(
        URL_NEUTRA,
        DOCUMENTO,
        envio(responde(xmlS3('SignatureDoesNotMatch'), 403), 30),
      ),
    );
    expect(err).toBeInstanceOf(AmazonDocumentoFeedError);
    expect(err).toMatchObject({
      motivo: 'recusado',
      status: 403,
      codigoS3: 'SignatureDoesNotMatch',
    });
    expect(ehTransitoriaDocumentoFeed(err as AmazonDocumentoFeedError)).toBe(false);
  });

  it('★ NEAR-MISS: the same 403 at 5 min is expirado: transient', async () => {
    expect(VALIDADE_URL_DOCUMENTO_FEED_MS).toBe(5 * 60_000);
    const err = await falha(
      enviarDocumentoFeedAmazon(
        URL_NEUTRA,
        DOCUMENTO,
        envio(responde(xmlS3('AccessDenied'), 403), 300),
      ),
    );
    expect(err).toMatchObject({ motivo: 'expirado', status: 403, codigoS3: 'AccessDenied' });
    expect(ehTransitoriaDocumentoFeed(err as AmazonDocumentoFeedError)).toBe(true);
  });

  it('a 403 one millisecond before the lifetime is still recusado', async () => {
    const f = responde(xmlS3('AccessDenied'), 403);
    const err = await falha(
      enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, {
        fetch: f,
        emitidoEmMs: EMITIDO_EM,
        agora: () => EMITIDO_EM + VALIDADE_URL_DOCUMENTO_FEED_MS - 1,
      }),
    );
    expect(err).toMatchObject({ motivo: 'recusado' });
  });

  it('without `agora`, the lifetime is judged on the real clock', async () => {
    const expirada = await falha(
      enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, {
        fetch: responde(xmlS3('AccessDenied'), 403),
        emitidoEmMs: Date.now() - VALIDADE_URL_DOCUMENTO_FEED_MS - 60_000,
      }),
    );
    expect(expirada).toMatchObject({ motivo: 'expirado' });
    // NEAR-MISS: a URL issued just now is recusado.
    const nova = await falha(
      enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, {
        fetch: responde(xmlS3('AccessDenied'), 403),
        emitidoEmMs: Date.now(),
      }),
    );
    expect(nova).toMatchObject({ motivo: 'recusado' });
  });

  it.each<[string, string, string]>([
    ['an unknown code', xmlS3('SlowDown'), 'outro'],
    ['no XML', 'acesso negado', 'outro'],
    ['an empty body', '', 'outro'],
    ['a code with a space', xmlS3('Access Denied'), 'outro'],
  ])('the S3 code of %s is outro, never the text', async (_caso, corpo, codigo) => {
    const err = await falha(
      enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, envio(responde(corpo || null, 403), 30)),
    );
    expect(err).toMatchObject({ motivo: 'recusado', codigoS3: codigo });
    for (const t of textosDoErro(err)) expect(t).not.toContain('MARCADOR-DA-MENSAGEM-S3');
  });

  it('the S3 code is read from at most 4 KiB: a code past it is outro, and the stream is cancelled', async () => {
    const { stream, cancelar } = corpoEmPedacos([
      bytes(`<Error>${' '.repeat(4096)}`),
      bytes('<Code>SignatureDoesNotMatch</Code></Error>'),
    ]);
    const err = await falha(
      enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, envio(responde(stream, 403), 30)),
    );
    expect(err).toMatchObject({ motivo: 'recusado', codigoS3: 'outro' });
    expect(cancelar).toHaveBeenCalledTimes(1);
  });

  /** One 6-KiB chunk whose `<Code>…</Code>` (34 bytes) starts at byte `inicio`. */
  const resposta403ComCodigoEm = (inicio: number) => {
    const codigo = '<Code>SignatureDoesNotMatch</Code>';
    const texto = `<Error>${' '.repeat(inicio - 7)}${codigo}`;
    return corpoEmPedacos([bytes(texto.padEnd(6 * 1024, ' '))]);
  };

  it.each<[string, number, string]>([
    ['well inside the first 4 KiB', 3000, 'SignatureDoesNotMatch'],
    ['ending on the 4,096th byte', 4096 - 34, 'SignatureDoesNotMatch'],
    ['ending on the 4,097th byte', 4097 - 34, 'outro'],
  ])('a code %s of ONE larger chunk is read up to the 4 KiB cut', async (_caso, inicio, codigo) => {
    const { stream, cancelar } = resposta403ComCodigoEm(inicio);
    const err = await falha(
      enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, envio(responde(stream, 403), 30)),
    );
    expect(err).toMatchObject({ motivo: 'recusado', codigoS3: codigo });
    expect(cancelar).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 409, 500, 503, 300, 301])('HTTP %i → http with its status', async (status) => {
    const err = await falha(
      enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, envio(responde('x', status))),
    );
    expect(err).toMatchObject({ motivo: 'http', status, codigoS3: null });
    expect(ehTransitoriaDocumentoFeed(err as AmazonDocumentoFeedError)).toBe(status >= 500);
  });

  it('★ a TypeError from fetch (a refused redirect included) is rede; anything else is rethrown', async () => {
    const redirecionado = roteiro((_input, init) => {
      if (init?.redirect === 'error') throw new TypeError('fetch failed');
      return new Response(null, {
        status: 307,
        headers: { location: 'https://outro-host.example/x' },
      });
    });
    expect(
      await motivoDe(enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, envio(redirecionado))),
    ).toBe('rede');
    const estranho = new RangeError('outra coisa');
    await expect(
      enviarDocumentoFeedAmazon(
        URL_NEUTRA,
        DOCUMENTO,
        envio(
          roteiro(() => {
            throw estranho;
          }),
        ),
      ),
    ).rejects.toBe(estranho);
  });

  it('the caller’s signal, already aborted: its reason comes back, nothing sent', async () => {
    const c = new AbortController();
    c.abort(new RangeError('motivo do chamador'));
    const f = responde(null);
    await expect(
      enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, envio(f, 0, c.signal)),
    ).rejects.toBe(c.signal.reason);
    expect(f).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                                The download                                */
/* -------------------------------------------------------------------------- */

describe('baixarRelatorioFeedAmazon: the request', () => {
  it('★ ONE GET, with no headers key at all and redirect: error', async () => {
    const f = responde(RELATORIO);
    const r = await baixarRelatorioFeedAmazon(URL_NEUTRA, { fetch: f, compressao: null });
    expect(r.summary.messagesProcessed).toBe(2);
    expect(f).toHaveBeenCalledTimes(1);
    const [, init] = f.mock.calls[0] ?? [];
    expect(Object.keys(init ?? {}).sort()).toEqual(['method', 'redirect', 'signal']);
    expect(init?.method).toBe('GET');
    expect(init && 'headers' in init).toBe(false);
  });

  it('★ an uncompressed report parses (compressao null or absent)', async () => {
    for (const compressao of [null, undefined]) {
      const r = await baixarRelatorioFeedAmazon(URL_NEUTRA, {
        fetch: responde(RELATORIO),
        compressao,
      });
      expect(r.issues?.[0]?.sku).toBe('A');
    }
  });

  it('a compression the model does not list is refused before anything is fetched', async () => {
    const f = responde(RELATORIO);
    expect(
      await motivoDe(baixarRelatorioFeedAmazon(URL_NEUTRA, { fetch: f, compressao: 'ZSTD' })),
    ).toBe('relatorio-invalido');
    expect(
      await motivoDe(baixarRelatorioFeedAmazon(URL_NEUTRA, { fetch: f, compressao: 'gzip' })),
    ).toBe('relatorio-invalido');
    expect(f).not.toHaveBeenCalled();
  });

  it.each<[number, MotivoDocumentoFeed, boolean]>([
    [403, 'expirado', true],
    [404, 'http', false],
    [500, 'http', true],
    [206, 'http', false],
  ])('HTTP %i → %s (transient: %s)', async (status, motivo, transitoria) => {
    const err = await falha(
      baixarRelatorioFeedAmazon(URL_NEUTRA, {
        fetch: responde(xmlS3('AccessDenied'), status),
        compressao: null,
      }),
    );
    expect(err).toMatchObject({
      motivo,
      status,
      codigoS3: status === 403 ? 'AccessDenied' : null,
    });
    expect(ehTransitoriaDocumentoFeed(err as AmazonDocumentoFeedError)).toBe(transitoria);
  });

  it('★ a report over 20 MiB cancels the stream on the chunk that passes the cap', async () => {
    const { stream, cancelar, puxados } = corpoEmPedacos([
      new Uint8Array(MAX_RELATORIO_FEED_BYTES),
      new Uint8Array(1),
      new Uint8Array(1),
    ]);
    expect(
      await motivoDe(
        baixarRelatorioFeedAmazon(URL_NEUTRA, { fetch: responde(stream), compressao: null }),
      ),
    ).toBe('grande-demais');
    expect(cancelar).toHaveBeenCalledTimes(1);
    expect(puxados()).toBe(2);
  });

  it('NEAR-MISS: exactly 20 MiB is read whole (then judged as text: zeros are not JSON)', async () => {
    const { stream, cancelar } = corpoEmPedacos([new Uint8Array(MAX_RELATORIO_FEED_BYTES)]);
    expect(
      await motivoDe(
        baixarRelatorioFeedAmazon(URL_NEUTRA, { fetch: responde(stream), compressao: null }),
      ),
    ).toBe('json-invalido');
    expect(cancelar).not.toHaveBeenCalled();
  });
});

/**
 * A report of `n` issues whose messages barely compress (a fixed-seed
 * generator), so its gzip spans several of the inflater's slices.
 */
function relatorioGrande(n: number): { texto: string; mensagens: string[] } {
  let semente = 0x2545f491;
  const hex = () => {
    semente = (Math.imul(semente, 1664525) + 1013904223) >>> 0;
    return semente.toString(16).padStart(8, '0');
  };
  const mensagens = Array.from({ length: n }, () => `${hex()}${hex()}${hex()}${hex()}`);
  const texto = JSON.stringify({
    header: { sellerId: 'SELLER-TESTE', version: '2.0', feedId: '3485934' },
    issues: mensagens.map((message, i) => ({
      messageId: i + 1,
      sku: `SKU-${i}`,
      code: '90220',
      severity: 'ERROR',
      message,
    })),
    summary: {
      errors: n,
      warnings: 0,
      messagesProcessed: n,
      messagesAccepted: 0,
      messagesInvalid: n,
    },
  });
  return { texto, mensagens };
}

describe('baixarRelatorioFeedAmazon: the verified gunzip', () => {
  beforeEach(() => {
    inflacao.criados = 0;
    inflacao.fatias = 0;
  });

  const baixar = (corpo: Uint8Array) =>
    baixarRelatorioFeedAmazon(URL_NEUTRA, { fetch: responde(corpo), compressao: 'GZIP' });

  it('★ NEAR-MISS: the unpatched gzip parses', async () => {
    const r = await baixar(gzipSync(bytes(RELATORIO)));
    expect(r.summary).toMatchObject({ errors: 1, messagesAccepted: 1 });
    expect(inflacao.criados).toBe(1);
  });

  it.each([0, 1, 6, 9] as const)(
    'NEAR-MISS: a report gzipped at level %i over several slices parses whole',
    async (level) => {
      const { texto, mensagens } = relatorioGrande(2000);
      const gz = gzipSync(bytes(texto), { level });
      expect(gz.length).toBeGreaterThan(3 * 16 * 1024);
      const r = await baixar(gz);
      expect(r.issues?.map((i) => i.message)).toEqual(mensagens);
      expect(inflacao.fatias).toBeGreaterThan(3);
    },
  );

  it('★ an ISIZE above MAX_RELATORIO_JSON_BYTES is refused with ZERO inflation', async () => {
    const gz = comIsize(gzipSync(bytes(RELATORIO)), MAX_RELATORIO_JSON_BYTES + 1);
    expect(await motivoDe(baixar(gz))).toBe('grande-demais');
    expect(inflacao.criados).toBe(0);
  });

  it('NEAR-MISS: an ISIZE of exactly the cap is inflated (then refused for its length)', async () => {
    const gz = comIsize(gzipSync(bytes(RELATORIO)), MAX_RELATORIO_JSON_BYTES);
    expect(await motivoDe(baixar(gz))).toBe('gzip-invalido');
    expect(inflacao.criados).toBe(1);
  });

  it('★ an ISIZE SMALLER than the real stream is gzip-invalido, never a truncated report', async () => {
    // The trailer is patched coherently: ISIZE n and the CRC-32 of the first n
    // bytes, so an inflation that kept only the first n bytes would pass both
    // the length and the CRC check. Only the output PAST n can tell. (The
    // length check alone is pinned by the stored-block boundary case below.)
    const original = bytes(RELATORIO);
    const n = original.length - 10;
    const gz = comCrc(comIsize(gzipSync(original), n), crc32(original.subarray(0, n)));
    expect(await motivoDe(baixar(gz))).toBe('gzip-invalido');
  });

  it('★ the same for a STORED (level 0) stream: gzip-invalido, never a bare RangeError', async () => {
    const original = bytes(RELATORIO);
    const n = original.length - 10;
    const armazenado = gzipSync(original, { level: 0 });
    const gz = comCrc(comIsize(armazenado, n), crc32(original.subarray(0, n)));
    expect(await motivoDe(baixar(gz))).toBe('gzip-invalido');
    // NEAR-MISS: the unpatched stored stream parses.
    expect((await baixar(armazenado)).summary.messagesProcessed).toBe(2);
  });

  it('★ an ISIZE ending EXACTLY on a stored block is gzip-invalido, never the first block alone', async () => {
    // A stored stream comes out one whole 65,535-byte block at a time. With
    // ISIZE and the CRC-32 patched to the first block, the output reaches ISIZE
    // exactly: an inflation that stopped AT ISIZE, or a check of the CRC alone,
    // would hand that block back as the report. The inflation goes on past
    // ISIZE, and the exact-length check refuses the longer output.
    const original = bytes(relatorioGrande(2000).texto);
    const bloco = 65_535;
    expect(original.length).toBeGreaterThan(bloco);
    const armazenado = gzipSync(original, { level: 0 });
    const gz = comCrc(comIsize(armazenado, bloco), crc32(original.subarray(0, bloco)));
    expect(await motivoDe(baixar(gz))).toBe('gzip-invalido');
  });

  it.each<[string, 0 | 6, number]>([
    // A Huffman stream yields output from its first slice on.
    ['a Huffman stream: at its first slice', 6, 1],
    // A stored block (≤ 65,535 bytes) yields nothing until it is whole: the
    // header and the first block fit in five 16-KiB slices.
    ['a stored stream: once its first block is whole', 0, 5],
  ])('★ the inflation stops past ISIZE, %s', async (_caso, level, maxFatias) => {
    // A report of many slices under an ISIZE of 100: nothing after the slice
    // that passes it is inflated.
    const gz = comIsize(gzipSync(bytes(relatorioGrande(6000).texto), { level }), 100);
    expect(gz.length).toBeGreaterThan(8 * 16 * 1024);
    expect(await motivoDe(baixar(gz))).toBe('gzip-invalido');
    expect(inflacao.fatias).toBeGreaterThan(0);
    expect(inflacao.fatias).toBeLessThanOrEqual(maxFatias);
  });

  it('an ISIZE LARGER than the real stream is gzip-invalido too', async () => {
    const original = bytes(RELATORIO);
    expect(await motivoDe(baixar(comIsize(gzipSync(original), original.length + 5)))).toBe(
      'gzip-invalido',
    );
  });

  it('★ a flipped trailer CRC is gzip-invalido', async () => {
    const gz = gzipSync(bytes(RELATORIO));
    const crc = new DataView(gz.buffer, gz.byteOffset, gz.byteLength).getUint32(
      gz.length - 8,
      true,
    );
    expect(await motivoDe(baixar(comCrc(gz, crc ^ 1)))).toBe('gzip-invalido');
  });

  it.each<[string, () => Uint8Array]>([
    ['a body shorter than a gzip member', () => new Uint8Array([0x1f, 0x8b, 8])],
    // A trailer that passes the ISIZE cap, so the magic check is what refuses it.
    ['a plain report without the gzip magic', () => bytes(`${RELATORIO}\u0000\u0000\u0000\u0000`)],
    [
      'a gzip header over garbage',
      () => {
        const gz = gzipSync(bytes(RELATORIO));
        gz.fill(0xff, 10, gz.length - 8);
        return gz;
      },
    ],
    [
      'a cut deflate stream under its real trailer',
      () => {
        const gz = gzipSync(bytes(RELATORIO));
        const cortado = new Uint8Array(23);
        cortado.set(gz.subarray(0, 15));
        cortado.set(gz.subarray(gz.length - 8), 15);
        return cortado;
      },
    ],
  ])('%s is gzip-invalido (fflate’s own error, named)', async (_caso, corpo) => {
    expect(await motivoDe(baixar(corpo()))).toBe('gzip-invalido');
  });

  it('a gzip of non-UTF-8 bytes is json-invalido; of JSON that is not a report, relatorio-invalido', async () => {
    expect(await motivoDe(baixar(gzipSync(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))))).toBe(
      'json-invalido',
    );
    expect(await motivoDe(baixar(gzipSync(bytes('{"a":1}'))))).toBe('relatorio-invalido');
  });

  it('★ a malformed byte INSIDE a JSON string is json-invalido, plain or gzipped: never a report read with U+FFFD', async () => {
    // The issue message `"m"` becomes `"<0xFF>"`: valid JSON once a lenient
    // decoder substitutes the byte, so only the strict decoder refuses it.
    const corrompido = bytes(RELATORIO);
    corrompido[RELATORIO.indexOf('"m"') + 1] = 0xff;
    expect(await motivoDe(baixar(gzipSync(corrompido)))).toBe('json-invalido');
    expect(
      await motivoDe(
        baixarRelatorioFeedAmazon(URL_NEUTRA, { fetch: responde(corrompido), compressao: null }),
      ),
    ).toBe('json-invalido');
    // NEAR-MISS: a well-formed multi-byte character in the same place parses.
    const r = await baixar(gzipSync(bytes(RELATORIO.replace('"m"', '"é"'))));
    expect(r.issues?.[0]?.message).toBe('é');
  });
});

describe('★ no error carries the URL, a query value or a report byte', () => {
  const SENTINELA = 'SENTINELA-DO-RELATORIO';
  const urlComSegredo = `${URL_NEUTRA}&X-Amz-Credential=SENTINELA-DA-QUERY`;

  it.each<[string, () => Promise<unknown>]>([
    [
      'a non-JSON report',
      () =>
        baixarRelatorioFeedAmazon(urlComSegredo, {
          fetch: responde(`${SENTINELA} <html>`),
          compressao: null,
        }),
    ],
    [
      'a JSON non-report',
      () =>
        baixarRelatorioFeedAmazon(urlComSegredo, {
          fetch: responde(JSON.stringify({ x: SENTINELA })),
          compressao: null,
        }),
    ],
    [
      'a corrupt gzip',
      () =>
        baixarRelatorioFeedAmazon(urlComSegredo, {
          fetch: responde(comCrc(gzipSync(bytes(SENTINELA)), 1)),
          compressao: 'GZIP',
        }),
    ],
    [
      'a 403 upload',
      () =>
        enviarDocumentoFeedAmazon(
          urlComSegredo,
          DOCUMENTO,
          envio(responde(xmlS3(SENTINELA), 403), 30),
        ),
    ],
    [
      'a network failure quoting the URL',
      () =>
        enviarDocumentoFeedAmazon(
          urlComSegredo,
          DOCUMENTO,
          envio(
            roteiro(() => {
              throw new TypeError(`fetch failed ${urlComSegredo}`);
            }),
          ),
        ),
    ],
    [
      'a refused URL',
      () =>
        baixarRelatorioFeedAmazon('https://evil.example/?X-Amz-Credential=SENTINELA-DA-QUERY', {
          fetch: responde(RELATORIO),
          compressao: null,
        }),
    ],
  ])('%s', async (_caso, chamar) => {
    const err = await falha(chamar());
    expect(err).toBeInstanceOf(AmazonDocumentoFeedError);
    expect((err as AmazonDocumentoFeedError).cause).toBeUndefined();
    for (const t of textosDoErro(err)) {
      expect(t).not.toContain(SENTINELA);
      expect(t).not.toContain('SENTINELA-DA-QUERY');
      expect(t).not.toContain('bucket-teste');
      expect(t).not.toContain('amazonaws');
    }
  });
});

describe('★ the deadlines: upload for the PUT, documento for the GET', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const nuncaResponde = () =>
    roteiro(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

  it('the upload is pending at 20 s and cut at PRAZO_AMAZON_MS.upload (prazo)', async () => {
    expect(PRAZO_AMAZON_MS.upload).toBe(30_000);
    const { estado, pronto } = observar(
      enviarDocumentoFeedAmazon(URL_NEUTRA, DOCUMENTO, envio(nuncaResponde())),
    );
    await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.documento);
    expect(estado.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.upload - PRAZO_AMAZON_MS.documento);
    await pronto;
    expect(estado.valor).toMatchObject({ motivo: 'prazo' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the download is cut at PRAZO_AMAZON_MS.documento, a body that stalls included', async () => {
    const travaNoCorpo = roteiro((_input, init) => {
      const corpo = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes('{"summary":'));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return new Response(corpo, { status: 200 });
    });
    for (const f of [nuncaResponde(), travaNoCorpo]) {
      const { estado, pronto } = observar(
        baixarRelatorioFeedAmazon(URL_NEUTRA, { fetch: f, compressao: null }),
      );
      await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.documento - 1);
      expect(estado.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pronto;
      expect(estado.valor).toMatchObject({ motivo: 'prazo' });
      expect(ehTransitoriaDocumentoFeed(estado.valor as AmazonDocumentoFeedError)).toBe(true);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a caller abort mid-flight is rethrown as itself, never a prazo', async () => {
    const c = new AbortController();
    const { estado, pronto } = observar(
      baixarRelatorioFeedAmazon(URL_NEUTRA, {
        fetch: nuncaResponde(),
        compressao: null,
        sinal: c.signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(10);
    c.abort(new RangeError('cancelado'));
    await pronto;
    expect(estado.valor).toBe(c.signal.reason);
  });
});
