import { type ZipOptions, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as barril from '../src/index';
import {
  baixarDocumentosEasyShip,
  crc32,
  extrairEtiquetaZplEasyShip,
  MAX_ENTRADAS_ZIP_EASY_SHIP,
  MAX_ZIP_EASY_SHIP_BYTES,
  MAX_ZPL_EASY_SHIP_BYTES,
  type OpcoesDownloadEasyShip,
} from '../src/documentosEasyShip';
import {
  AmazonDocumentoEasyShipError,
  AmazonError,
  type MotivoDocumentoEasyShip,
} from '../src/errors';
import { PRAZO_AMAZON_MS } from '../src/prazos';
import { agendamentoEasyShip200 } from './_fixtures/sandbox';
import { falha, observar, textosDoErro } from './_helpers/mockFetch';

/*
 * Every zip here is built IN the test with fflate's `zipSync` (and byte patches
 * for the corrupt cases): never a real label, never a file on disk. The URL is
 * a neutral one: no region, no marketplace prefix.
 */

const URL_NEUTRA = 'https://example-bucket.s3.amazonaws.com/x.zip?X-Amz-Signature=0000';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A ZPL label: `^XA` … `^XZ`. */
const ZPL = bytes('^XA^FO50,50^ADN,36,20^FDETIQUETA DE TESTE^FS^XZ\n');

/** A stored-or-deflated entry. */
const armazenado = (b: Uint8Array): [Uint8Array, ZipOptions] => [b, { level: 0 }];

function zip(entradas: Record<string, Uint8Array | [Uint8Array, ZipOptions]>): Uint8Array {
  return zipSync(entradas);
}

/** A zip whose first bytes are the signature, padded with zeros to `n` bytes. */
function corpoZip(n: number): Uint8Array {
  const b = new Uint8Array(n);
  b.set([0x50, 0x4b, 0x03, 0x04]);
  return b;
}

/* ---------------------------- byte-level helpers ---------------------------- */

function u16(b: Uint8Array, i: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(i, true);
}
function u32(b: Uint8Array, i: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(i, true);
}
function poe16(b: Uint8Array, i: number, v: number): void {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint16(i, v, true);
}
function poe32(b: Uint8Array, i: number, v: number): void {
  new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(i, v, true);
}

/** The EOCD offset of a zip with no archive comment (what `zipSync` writes). */
const fimDe = (z: Uint8Array): number => z.length - 22;

/** The offsets of every central-directory record, in order. */
function registrosDe(z: Uint8Array): number[] {
  const fim = fimDe(z);
  const n = u16(z, fim + 10);
  let o = u32(z, fim + 16);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(o);
    o += 46 + u16(z, o + 28) + u16(z, o + 30) + u16(z, o + 32);
  }
  return out;
}

/** Where entry `i`'s data starts (after its local header). */
function dadosDe(z: Uint8Array, i: number): number {
  const local = u32(z, (registrosDe(z)[i] ?? -1) + 42);
  return local + 30 + u16(z, local + 26) + u16(z, local + 28);
}

async function motivoDe(p: Promise<unknown> | (() => unknown)): Promise<MotivoDocumentoEasyShip> {
  let err: unknown;
  if (typeof p === 'function') {
    try {
      p();
      throw new Error('esperava uma recusa');
    } catch (e) {
      if (e instanceof AmazonDocumentoEasyShipError) return e.motivo;
      throw e;
    }
  } else {
    err = await falha(p);
  }
  expect(err).toBeInstanceOf(AmazonDocumentoEasyShipError);
  return (err as AmazonDocumentoEasyShipError).motivo;
}

const extrair = (z: Uint8Array) => () => extrairEtiquetaZplEasyShip(z);

/* -------------------------------------------------------------------------- */
/*                                 The class                                  */
/* -------------------------------------------------------------------------- */

describe('AmazonDocumentoEasyShipError', () => {
  it('★ roots at AmazonError with refCredencial null, and carries no numeric code', () => {
    const err = new AmazonDocumentoEasyShipError('http', { status: 500 });
    expect(err).toBeInstanceOf(AmazonError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AmazonDocumentoEasyShipError');
    expect(err.refCredencial).toBeNull();
    expect(err.status).toBe(500);
    expect(new AmazonDocumentoEasyShipError('sem-zpl').status).toBeNull();
    expect((err as unknown as { code?: unknown }).code).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                                The download                                */
/* -------------------------------------------------------------------------- */

type ArgsFetch = Parameters<typeof globalThis.fetch>;

/** Every request this file's scripted fetches saw. */
const vistas: ArgsFetch[] = [];

/** A scripted `fetch`: every call recorded, a fresh `Response` per call. */
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
  // Every request was a header-free GET to an object-storage host, never a redirect follower.
  const fora = vistas.filter(([input, init]) => {
    const url = new URL(hrefDe(input));
    return (
      !url.hostname.endsWith('.amazonaws.com') ||
      init?.method !== 'GET' ||
      init.headers !== undefined ||
      init.redirect !== 'error'
    );
  });
  vistas.length = 0;
  expect(fora).toEqual([]);
});

/** A `Response` body: bytes are copied into a fresh `ArrayBuffer` (what `BodyInit` takes). */
function corpoDe(corpo: Uint8Array | ReadableStream<Uint8Array> | null): BodyInit | null {
  return corpo instanceof Uint8Array ? new Uint8Array(corpo) : corpo;
}

const ok = (corpo: Uint8Array | ReadableStream<Uint8Array> | null, status = 200) =>
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

describe('baixarDocumentosEasyShip: the URL', () => {
  it.each([
    ['http:', 'http://example-bucket.s3.amazonaws.com/x.zip'],
    ['userinfo', 'https://user:pw@example-bucket.s3.amazonaws.com/x.zip'],
    ['a user only', 'https://user@example-bucket.s3.amazonaws.com/x.zip'],
    ['a port', 'https://x.amazonaws.com:8443/x.zip'],
    ['a foreign host', 'https://evil.example/x.zip'],
    ['the suffix as a subdomain of a foreign host', 'https://amazonaws.com.evil.example/x.zip'],
    ['the bare suffix', 'https://amazonaws.com/x.zip'],
    ['a look-alike suffix', 'https://example-bucket.s3.xamazonaws.com/x.zip'],
    ['a trailing dot', 'https://example-bucket.s3.amazonaws.com./x.zip'],
    ['not a URL', 'nao e uma url'],
    ['a relative path', '/x.zip'],
    ['empty', ''],
    ['the model’s own example URL', 'https://www.amazon.com/documents.zip'],
    ['ftp:', 'ftp://example-bucket.s3.amazonaws.com/x.zip'],
  ])('★ %s is refused BEFORE fetch (url-invalida)', async (_caso, url) => {
    const f = ok(corpoZip(30));
    expect(await motivoDe(baixarDocumentosEasyShip(url, { fetch: f }))).toBe('url-invalida');
    expect(f).not.toHaveBeenCalled();
  });

  it('★ the sandbox answer’s own printableDocumentsUrl is refused (decision row: the host)', async () => {
    const f = ok(corpoZip(30));
    const url = agendamentoEasyShip200.printableDocumentsUrl;
    expect(await motivoDe(baixarDocumentosEasyShip(url, { fetch: f }))).toBe('url-invalida');
    expect(f).not.toHaveBeenCalled();
  });

  it('★ NEAR-MISS: the neutral pre-signed URL is accepted, and an upper-case host is read lower-case', async () => {
    const corpo = corpoZip(30);
    for (const url of [
      URL_NEUTRA,
      'https://EXAMPLE-BUCKET.S3.AMAZONAWS.COM/x.zip?X-Amz-Signature=0000',
    ]) {
      const f = ok(corpo);
      expect(await baixarDocumentosEasyShip(url, { fetch: f })).toEqual(corpo);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });
});

describe('baixarDocumentosEasyShip: the request', () => {
  it('★ ONE GET, with no headers key at all and redirect: error', async () => {
    const f = ok(corpoZip(30));
    await baixarDocumentosEasyShip(URL_NEUTRA, { fetch: f });
    expect(f).toHaveBeenCalledTimes(1);
    const [input, init] = f.mock.calls[0] ?? [];
    expect(hrefDe(input ?? '')).toBe(URL_NEUTRA);
    expect(Object.keys(init ?? {}).sort()).toEqual(['method', 'redirect', 'signal']);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init && 'headers' in init).toBe(false);
  });

  it('★ a redirect is never followed: fetch refuses it (TypeError) → rede', async () => {
    const f = roteiro((_input, init) => {
      if (init?.redirect === 'error') throw new TypeError('fetch failed');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://outro-host.example/x' },
      });
    });
    expect(await motivoDe(baixarDocumentosEasyShip(URL_NEUTRA, { fetch: f }))).toBe('rede');
  });

  it('★ calling without fetch is a type error, and the global fetch is never used', async () => {
    const global = vi.fn(async () => new Response(corpoDe(corpoZip(30))));
    const original = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: global,
    });
    try {
      // @ts-expect-error — `fetch` is REQUIRED: there is no global default.
      const p = baixarDocumentosEasyShip(URL_NEUTRA, {});
      const semFetch = { sinal: undefined } as unknown as OpcoesDownloadEasyShip;
      for (const err of [
        await falha(p),
        await falha(baixarDocumentosEasyShip(URL_NEUTRA, semFetch)),
      ]) {
        // A wiring bug stays a programming error: never a retryable 'rede'
        // (nor any other motivo of ours).
        expect(err).toBeInstanceOf(TypeError);
        expect(err).not.toBeInstanceOf(AmazonDocumentoEasyShipError);
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

describe('baixarDocumentosEasyShip: the answer', () => {
  const XML_S3 =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>';

  it('★ the S3 XML body with 403 → expirado (status 403); with 200 → nao-zip', async () => {
    const err = await falha(
      baixarDocumentosEasyShip(URL_NEUTRA, { fetch: ok(bytes(XML_S3), 403) }),
    );
    expect(err).toBeInstanceOf(AmazonDocumentoEasyShipError);
    expect(err).toMatchObject({ motivo: 'expirado', status: 403 });
    expect(
      await motivoDe(baixarDocumentosEasyShip(URL_NEUTRA, { fetch: ok(bytes(XML_S3), 200) })),
    ).toBe('nao-zip');
  });

  it.each([400, 404, 500, 503, 206, 204])('★ HTTP %i → http with its status', async (status) => {
    const corpo = status === 204 ? null : corpoZip(30);
    const err = await falha(baixarDocumentosEasyShip(URL_NEUTRA, { fetch: ok(corpo, status) }));
    expect(err).toMatchObject({ motivo: 'http', status });
  });

  it.each([
    ['empty', null],
    ['an empty archive (EOCD only)', zipSync({})],
    ['a PDF', bytes('%PDF-1.7\n')],
    ['three bytes of the signature', new Uint8Array([0x50, 0x4b, 0x03])],
  ])('★ a 200 body that is %s → nao-zip', async (_caso, corpo) => {
    expect(await motivoDe(baixarDocumentosEasyShip(URL_NEUTRA, { fetch: ok(corpo) }))).toBe(
      'nao-zip',
    );
  });

  it('★ MAX + 1 bytes in two chunks: cancelled on the SECOND chunk (grande-demais), the reader’s cancel called', async () => {
    const { stream, cancelar, puxados } = corpoEmPedacos([
      corpoZip(MAX_ZIP_EASY_SHIP_BYTES),
      new Uint8Array(1),
      new Uint8Array(1),
    ]);
    expect(await motivoDe(baixarDocumentosEasyShip(URL_NEUTRA, { fetch: ok(stream) }))).toBe(
      'grande-demais',
    );
    expect(cancelar).toHaveBeenCalledTimes(1);
    expect(puxados()).toBe(2);
  });

  it('★ NEAR-MISS: exactly MAX bytes in two chunks is the zip, whole and in order', async () => {
    const primeiro = corpoZip(MAX_ZIP_EASY_SHIP_BYTES - 2);
    const { stream, cancelar } = corpoEmPedacos([primeiro, new Uint8Array([7, 9])]);
    const r = await baixarDocumentosEasyShip(URL_NEUTRA, { fetch: ok(stream) });
    expect(r).toHaveLength(MAX_ZIP_EASY_SHIP_BYTES);
    expect([...r.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect([...r.subarray(-2)]).toEqual([7, 9]);
    expect(cancelar).not.toHaveBeenCalled();
  });

  it('★ a TypeError from fetch, or from the stream mid-body → rede', async () => {
    const rejeita = roteiro(() => {
      throw new TypeError('fetch failed');
    });
    expect(await motivoDe(baixarDocumentosEasyShip(URL_NEUTRA, { fetch: rejeita }))).toBe('rede');
    const quebra = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(corpoZip(10));
        controller.error(new TypeError('terminated'));
      },
    });
    expect(await motivoDe(baixarDocumentosEasyShip(URL_NEUTRA, { fetch: ok(quebra) }))).toBe(
      'rede',
    );
  });

  it('anything else the transport throws is rethrown as itself', async () => {
    const estranho = new RangeError('outra coisa');
    const f = roteiro(() => {
      throw estranho;
    });
    await expect(baixarDocumentosEasyShip(URL_NEUTRA, { fetch: f })).rejects.toBe(estranho);
  });

  it('the caller’s signal: already aborted → its reason, nothing fetched; aborted mid-flight → its reason', async () => {
    const antes = new AbortController();
    antes.abort(new RangeError('motivo do chamador'));
    const f = ok(corpoZip(30));
    await expect(
      baixarDocumentosEasyShip(URL_NEUTRA, { fetch: f, sinal: antes.signal }),
    ).rejects.toBe(antes.signal.reason);
    expect(f).not.toHaveBeenCalled();

    const durante = new AbortController();
    const pendente = roteiro(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const p = baixarDocumentosEasyShip(URL_NEUTRA, { fetch: pendente, sinal: durante.signal });
    durante.abort(new RangeError('cancelado'));
    await expect(p).rejects.toBe(durante.signal.reason);
  });
});

describe('★ baixarDocumentosEasyShip: the documento deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Accepts the connection and never answers; rejects with the signal's reason on abort. */
  const nuncaResponde = () =>
    roteiro(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

  /** 200 headers, then a body that stalls until the signal aborts. */
  const travaNoCorpo = () =>
    roteiro((_input, init) => {
      const corpo = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(corpoZip(10));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return new Response(corpo, { status: 200 });
    });

  it.each([
    ['no answer at all', nuncaResponde],
    ['a body that stalls', travaNoCorpo],
  ])('%s: pending 1 ms before 20 s, cut at 20 s → prazo, timer released', async (_caso, criar) => {
    expect(PRAZO_AMAZON_MS.documento).toBe(20_000);
    const { estado, pronto } = observar(baixarDocumentosEasyShip(URL_NEUTRA, { fetch: criar() }));
    await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.documento - 1);
    expect(estado.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toBeInstanceOf(AmazonDocumentoEasyShipError);
    expect(estado.valor).toMatchObject({ motivo: 'prazo' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('★ no download error carries the URL, its host or a query value', () => {
  const HOST = 'sentinela-host-0000.s3.amazonaws.com';
  const QUERY = 'SENTINELA-QUERY-1111';
  const URL_SENTINELA = `https://${HOST}/SENTINELA-CAMINHO-2222/x.zip?X-Amz-Signature=${QUERY}`;

  it.each<[string, string, () => typeof globalThis.fetch]>([
    ['url-invalida', `http://${HOST}/x.zip?X-Amz-Signature=${QUERY}`, () => ok(corpoZip(30))],
    ['expirado', URL_SENTINELA, () => ok(bytes('<Error/>'), 403)],
    ['http', URL_SENTINELA, () => ok(corpoZip(30), 500)],
    ['nao-zip', URL_SENTINELA, () => ok(bytes(URL_SENTINELA))],
    [
      'rede',
      URL_SENTINELA,
      () =>
        roteiro(() => {
          // A platform error that names the host: it must not ride the error.
          throw new TypeError(`getaddrinfo ENOTFOUND ${HOST} ${URL_SENTINELA}`);
        }),
    ],
  ])('%s', async (motivo, url, criar) => {
    const err = await falha(baixarDocumentosEasyShip(url, { fetch: criar() }));
    expect(err).toMatchObject({ motivo });
    for (const t of textosDoErro(err)) {
      for (const proibido of [url, HOST, QUERY, 'SENTINELA', 'amazonaws']) {
        expect(t).not.toContain(proibido);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                               The extraction                               */
/* -------------------------------------------------------------------------- */

describe('crc32', () => {
  it('★ the standard check value: 0xCBF43926 for the ASCII bytes 123456789', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
  });

  it('the empty input, and agreement with the CRC fflate writes into a zip', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    const tudo = new Uint8Array(256).map((_, i) => i);
    const z = zip({ 'a.bin': armazenado(tudo) });
    expect(crc32(tudo)).toBe(u32(z, (registrosDe(z)[0] ?? -1) + 16));
  });

  it('stays internal: not in the barrel', () => {
    expect(Object.keys(barril)).not.toContain('crc32');
    for (const nome of ['baixarDocumentosEasyShip', 'extrairEtiquetaZplEasyShip'] as const) {
      expect(typeof barril[nome], nome).toBe('function');
    }
  });
});

describe('extrairEtiquetaZplEasyShip', () => {
  it('★ one label.zpl → its exact bytes: a leading BOM preserved, non-ASCII bytes untouched', () => {
    const conteudo = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...bytes('^XA^FDA'),
      0xc3,
      0xa7,
      0xff,
      0x00,
      0x80,
      ...bytes('^FS^XZ'),
    ]);
    for (const entrada of [conteudo, armazenado(conteudo)]) {
      const r = extrairEtiquetaZplEasyShip(zip({ 'label.zpl': entrada }));
      expect(r).toEqual(conteudo);
      expect([...r.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    }
  });

  it.each(['LABEL.ZPL', 'x.zpl2', 'X.Zpl2', 'pasta/etiqueta.zpl'])(
    '★ %s is a label entry (case-insensitive)',
    (nome) => {
      expect(extrairEtiquetaZplEasyShip(zip({ [nome]: ZPL }))).toEqual(ZPL);
    },
  );

  it('★ [label.pdf, label.zpl] → the ZPL', () => {
    const z = zip({ 'label.pdf': bytes('%PDF-1.7 documento'), 'label.zpl': ZPL });
    expect(extrairEtiquetaZplEasyShip(z)).toEqual(ZPL);
  });

  it('★ two entries where only the SECOND is a .zpl: its record is joined by position', () => {
    // Stored, so the first record's sizes and CRC are the PDF's own: a join on
    // the wrong record fails the verification.
    const z = zip({ 'a.pdf': armazenado(bytes('%PDF-1.7 outra coisa')), 'b.zpl': armazenado(ZPL) });
    expect(extrairEtiquetaZplEasyShip(z)).toEqual(ZPL);
  });

  it('a name read as latin1 (no UTF-8 flag) is still joined: by position, never by a re-decoded name', () => {
    const z = zip({ 'a.txt': bytes('x'), 'rótulo.zpl': ZPL });
    const registro = registrosDe(z)[1] ?? -1;
    poe16(z, registro + 8, u16(z, registro + 8) & ~0x0800);
    expect(extrairEtiquetaZplEasyShip(z)).toEqual(ZPL);
  });

  it('★ [a.zpl, b.zpl] → zpl-multiplo (never the first)', async () => {
    expect(await motivoDe(extrair(zip({ 'a.zpl': ZPL, 'b.zpl': ZPL })))).toBe('zpl-multiplo');
    expect(await motivoDe(extrair(zip({ 'a.zpl': ZPL, 'B.ZPL2': ZPL })))).toBe('zpl-multiplo');
  });

  it('★ [label.pdf] → sem-zpl; NEAR-MISS: the PDF is never returned, nor is the zip', async () => {
    expect(await motivoDe(extrair(zip({ 'label.pdf': bytes('%PDF-1.7 ^XA ^XZ') })))).toBe(
      'sem-zpl',
    );
    expect(await motivoDe(extrair(zip({ 'label.zpl.pdf': ZPL, zpl: ZPL })))).toBe('sem-zpl');
    expect(await motivoDe(extrair(zipSync({})))).toBe('sem-zpl');
  });

  it('★ 65 entries → entradas-demais, every entry counted (kept or not); NEAR-MISS: 64 is fine', async () => {
    const outras = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${String(i)}.txt`, bytes('x')]));
    expect(MAX_ENTRADAS_ZIP_EASY_SHIP).toBe(64);
    expect(await motivoDe(extrair(zip(outras(65))))).toBe('entradas-demais');
    expect(await motivoDe(extrair(zip({ ...outras(64), 'label.zpl': ZPL })))).toBe(
      'entradas-demais',
    );
    expect(extrairEtiquetaZplEasyShip(zip({ ...outras(63), 'label.zpl': ZPL }))).toEqual(ZPL);
  });

  it('★ a declared originalSize over the cap → zpl-grande-demais, with ZERO inflation', async () => {
    const z = zip({ 'label.zpl': ZPL.slice().fill(0x41) });
    const registro = registrosDe(z)[0] ?? -1;
    poe32(z, registro + 24, MAX_ZPL_EASY_SHIP_BYTES + 1);
    // The deflate stream is ALSO corrupted: had it been inflated, the answer
    // would have been fflate's error (zip-invalido), not the filter's.
    z.fill(0xff, dadosDe(z, 0), dadosDe(z, 0) + 2);
    expect(await motivoDe(extrair(z))).toBe('zpl-grande-demais');
  });

  it('★ a stored entry whose compressed size is over the cap → zpl-grande-demais', async () => {
    const z = zip({ 'label.zpl': armazenado(ZPL) });
    poe32(z, (registrosDe(z)[0] ?? -1) + 20, MAX_ZPL_EASY_SHIP_BYTES + 1);
    expect(await motivoDe(extrair(z))).toBe('zpl-grande-demais');
  });

  it('NEAR-MISS: a declared size of exactly the cap is not refused by the cap', async () => {
    const z = zip({ 'label.zpl': ZPL });
    poe32(z, (registrosDe(z)[0] ?? -1) + 24, MAX_ZPL_EASY_SHIP_BYTES);
    // It passes the filter and then fails the verification (the stream is short).
    expect(await motivoDe(extrair(z))).toBe('zip-invalido');
  });

  it('★ an over-cap entry that is NOT a label is not inflated and not refused', () => {
    const z = zip({ 'grande.pdf': bytes('%PDF'), 'label.zpl': ZPL });
    poe32(z, (registrosDe(z)[0] ?? -1) + 24, MAX_ZPL_EASY_SHIP_BYTES + 1);
    expect(extrairEtiquetaZplEasyShip(z)).toEqual(ZPL);
  });

  it('★ a method other than stored or deflate → zip-invalido', async () => {
    const z = zip({ 'label.zpl': ZPL });
    poe16(z, (registrosDe(z)[0] ?? -1) + 10, 14);
    expect(await motivoDe(extrair(z))).toBe('zip-invalido');
  });

  it('★ NEAR-MISS: another method on a NON-label entry is skipped, never refused: the label comes back', () => {
    const z = zip({ 'outro.bin': bytes('qualquer coisa'), 'label.zpl': ZPL });
    poe16(z, (registrosDe(z)[0] ?? -1) + 10, 14);
    expect(extrairEtiquetaZplEasyShip(z)).toEqual(ZPL);
  });

  it('★ a SECOND label is refused before fflate inflates it: [a.zpl, b.zpl with a corrupt stream] → zpl-multiplo', async () => {
    // Had b.zpl been inflated, fflate's own error would have answered
    // (zip-invalido), not the count.
    const z = zip({ 'a.zpl': ZPL, 'b.zpl': bytes(`^XA${'x'.repeat(200)}^XZ`) });
    z.fill(0xff, dadosDe(z, 1), dadosDe(z, 1) + 4);
    expect(await motivoDe(extrair(z))).toBe('zpl-multiplo');
  });

  it('★ an exception that is neither ours nor fflate’s, raised inside unzipSync, is rethrown as itself', () => {
    // fflate reads each record's name through `subarray`, inside its walk and
    // after the central-directory reader (which never calls it) has passed.
    const sentinela = new RangeError('sentinela fora do fflate');
    const bomba = new Proxy(zip({ 'label.zpl': ZPL }), {
      get(alvo, chave) {
        if (chave === 'subarray') throw sentinela;
        return Reflect.get(alvo, chave);
      },
    });
    let err: unknown;
    try {
      extrairEtiquetaZplEasyShip(bomba);
    } catch (e) {
      // Anything but the sentinel itself (a 'zip-invalido' above all) fails here.
      if (e !== sentinela) throw e;
      err = e;
    }
    expect(err).toBe(sentinela);
  });

  describe('★ the verification against the central-directory record', () => {
    const LONGO = bytes(`^XA${'^FO10,10^FDLINHA DE TESTE^FS'.repeat(20)}^XZ`);

    it('a declared originalSize SMALLER than the deflate stream → zip-invalido, never a truncated label', async () => {
      const z = zip({ 'label.zpl': LONGO });
      // NEAR-MISS first: the unpatched zip gives the full bytes.
      expect(extrairEtiquetaZplEasyShip(z.slice())).toEqual(LONGO);
      poe32(z, (registrosDe(z)[0] ?? -1) + 24, LONGO.length - 10);
      expect(await motivoDe(extrair(z))).toBe('zip-invalido');
    });

    it('a declared originalSize LARGER than the stream → zip-invalido (only the LENGTH sees it: the CRC matches)', async () => {
      const z = zip({ 'label.zpl': LONGO });
      poe32(z, (registrosDe(z)[0] ?? -1) + 24, LONGO.length + 10);
      expect(await motivoDe(extrair(z))).toBe('zip-invalido');
    });

    it('a stored entry whose compressed size exceeds its declared originalSize → zip-invalido', async () => {
      const z = zip({ 'label.zpl': armazenado(ZPL), 'depois.txt': armazenado(bytes('^XA^XZ')) });
      poe32(z, (registrosDe(z)[0] ?? -1) + 20, ZPL.length + 4);
      expect(await motivoDe(extrair(z))).toBe('zip-invalido');
    });

    it('one flipped byte inside a stored entry, the structure valid → zip-invalido (the CRC-32)', async () => {
      const z = zip({ 'label.zpl': armazenado(ZPL) });
      const i = dadosDe(z, 0) + 10;
      z[i] = (z[i] ?? 0) ^ 0x01;
      expect(await motivoDe(extrair(z))).toBe('zip-invalido');
    });

    it('a record count that disagrees (disk vs total) → zip-invalido', async () => {
      const z = zip({ 'a.txt': bytes('x'), 'label.zpl': ZPL });
      poe16(z, fimDe(z) + 10, 3);
      expect(await motivoDe(extrair(z))).toBe('zip-invalido');
    });

    it('a disk count SMALLER than the total, where fflate walks only the disk count → zip-invalido', async () => {
      // fflate reads the count at +8 and keeps the label (the first record);
      // the total at +10 still names both records, so the walk alone would pass.
      const z = zip({ 'label.zpl': ZPL, 'a.txt': bytes('x') });
      poe16(z, fimDe(z) + 8, 1);
      expect(await motivoDe(extrair(z))).toBe('zip-invalido');
    });

    it.each<[string, () => Uint8Array]>([
      [
        'a disk count of 1 under a total of 2, the label SECOND (fflate never walks to it)',
        () => {
          const z = zip({ 'a.txt': bytes('x'), 'label.zpl': ZPL });
          poe16(z, fimDe(z) + 8, 1);
          return z;
        },
      ],
      [
        'a disk count of 0 under a total of 1 (fflate reads an empty archive)',
        () => {
          const z = zip({ 'label.zpl': ZPL });
          poe16(z, fimDe(z) + 8, 0);
          return z;
        },
      ],
      [
        'no label, and a directory offset past the buffer',
        () => {
          const z = zip({ 'a.txt': bytes('x') });
          poe32(z, fimDe(z) + 16, z.length + 100);
          return z;
        },
      ],
      [
        'two labels, and a declared directory size 7 bytes too long',
        () => {
          const z = zip({ 'a.zpl': ZPL, 'b.zpl': ZPL });
          poe32(z, fimDe(z) + 12, u32(z, fimDe(z) + 12) + 7);
          return z;
        },
      ],
    ])(
      '★ a malformed directory is zip-invalido, never sem-zpl or zpl-multiplo: %s',
      async (_caso, criar) => {
        expect(await motivoDe(extrair(criar()))).toBe('zip-invalido');
      },
    );

    it('a directory size that disagrees with the records → zip-invalido', async () => {
      const z = zip({ 'label.zpl': ZPL });
      poe32(z, fimDe(z) + 12, u32(z, fimDe(z) + 12) + 1);
      expect(await motivoDe(extrair(z))).toBe('zip-invalido');
    });

    it('a record without the record signature (fflate does not check it) → zip-invalido', async () => {
      const z = zip({ 'a.txt': bytes('x'), 'label.zpl': ZPL });
      poe32(z, registrosDe(z)[0] ?? -1, 0x12345678);
      expect(await motivoDe(extrair(z))).toBe('zip-invalido');
    });

    it('a zip64 sentinel on another record → zip-invalido', async () => {
      for (const campo of [20, 24, 42]) {
        const z = zip({ 'a.txt': bytes('x'), 'label.zpl': ZPL });
        poe32(z, (registrosDe(z)[0] ?? -1) + campo, 0xffffffff);
        expect(await motivoDe(extrair(z)), String(campo)).toBe('zip-invalido');
      }
    });

    it('a zip64 locator before the End-Of-Central-Directory record → zip-invalido', async () => {
      const z = zip({ 'label.zpl': ZPL });
      const fim = fimDe(z);
      const localizador = new Uint8Array(20);
      poe32(localizador, 0, 0x07064b50);
      const comLocalizador = new Uint8Array([
        ...z.subarray(0, fim),
        ...localizador,
        ...z.subarray(fim),
      ]);
      expect(await motivoDe(extrair(comLocalizador))).toBe('zip-invalido');
    });

    it('★ NEAR-MISS: an archive COMMENT is scanned over (the record is found from the end, as fflate does)', () => {
      const z = zip({ 'a.txt': bytes('x'), 'label.zpl': ZPL });
      const comentario = bytes('um comentário do arquivo zip, '.repeat(40));
      const comComentario = new Uint8Array([...z, ...comentario]);
      poe16(comComentario, fimDe(z) + 20, comentario.length);
      expect(extrairEtiquetaZplEasyShip(comComentario)).toEqual(ZPL);
    });

    it('a record that runs past the End-Of-Central-Directory record → zip-invalido', async () => {
      const z = zip({ 'a.txt': bytes('x'), 'label.zpl': ZPL });
      // The LAST record's comment length now points past the EOCD record, and
      // the declared directory size grows with it, so only the bound sees it.
      poe16(z, (registrosDe(z)[1] ?? -1) + 32, 40);
      poe32(z, fimDe(z) + 12, u32(z, fimDe(z) + 12) + 40);
      expect(await motivoDe(extrair(z))).toBe('zip-invalido');
    });
  });

  it.each([
    ['random bytes', new Uint8Array(64).map((_, i) => (i * 37 + 11) & 0xff)],
    ['a truncated zip', zip({ 'label.zpl': ZPL }).subarray(0, 40)],
    ['nothing', new Uint8Array(0)],
  ])('★ corrupt bytes (%s) → zip-invalido', async (_caso, z) => {
    expect(await motivoDe(extrair(z))).toBe('zip-invalido');
  });

  it('★ a corrupt deflate stream inside a valid structure → zip-invalido', async () => {
    const z = zip({ 'label.zpl': bytes(`^XA${'x'.repeat(200)}^XZ`) });
    z.fill(0xff, dadosDe(z, 0), dadosDe(z, 0) + 4);
    expect(await motivoDe(extrair(z))).toBe('zip-invalido');
  });

  it('★ the filter’s refusals reach the caller with THEIR motivo, never rewritten to zip-invalido', () => {
    const outras = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`f${String(i)}.txt`, bytes('x')]),
    );
    const grande = zip({ 'label.zpl': ZPL });
    poe32(grande, (registrosDe(grande)[0] ?? -1) + 24, MAX_ZPL_EASY_SHIP_BYTES + 1);
    for (const [z, motivo] of [
      [zip(outras), 'entradas-demais'],
      [grande, 'zpl-grande-demais'],
    ] as const) {
      let err: unknown;
      try {
        extrairEtiquetaZplEasyShip(z);
      } catch (e) {
        if (!(e instanceof AmazonDocumentoEasyShipError)) throw e;
        err = e;
      }
      expect(err).toBeInstanceOf(AmazonDocumentoEasyShipError);
      expect(err).toMatchObject({ motivo });
    }
  });

  describe('★ the content rule', () => {
    it.each([
      ['%PDF-', '%PDF-1.7 ^XA^XZ'],
      ['PK', 'PK^XA^XZ'],
      ['<', '<?xml?>^XA^XZ'],
      ['%PDF- after a BOM and whitespace', '﻿ \r\n\t%PDF-1.7 ^XA^XZ'],
      ['< after whitespace', '\n\n<html>^XA^XZ</html>'],
      ['no ^XA anywhere', '~JA\r\n^FDsem inicio^FS^XZ'],
      ['a lower-case ^xa only', '^xa^FD^FS^xz'],
      ['empty', ''],
    ])('a .zpl starting with %s → zpl-invalido', async (_caso, texto) => {
      expect(await motivoDe(extrair(zip({ 'label.zpl': bytes(texto) })))).toBe('zpl-invalido');
    });

    it.each([
      ['~JA plus CRLF before ^XA', '~JA\r\n^XA^FD^FS^XZ'],
      ['a leading BOM', '﻿^XA^FD^FS^XZ'],
      ['whitespace then ^XA', '  \r\n^XA^XZ'],
      ['^XA in the middle', '~SD15\n~TA000\n^XA^XZ'],
    ])('NEAR-MISS: %s is accepted, verbatim', (_caso, texto) => {
      expect(extrairEtiquetaZplEasyShip(zip({ 'label.zpl': bytes(texto) }))).toEqual(bytes(texto));
    });
  });

  it('★ no error message holds an entry name or a ZPL byte', async () => {
    const NOME = 'SENTINELA-NOME-3333';
    const DADO = 'SENTINELA-DADO-4444';
    const casos: [Uint8Array, MotivoDocumentoEasyShip][] = [
      [zip({ [`${NOME}-a.zpl`]: bytes(DADO), [`${NOME}-b.zpl`]: bytes(DADO) }), 'zpl-multiplo'],
      [zip({ [`${NOME}.zpl`]: bytes(DADO) }), 'zpl-invalido'],
      [zip({ [`${NOME}.pdf`]: bytes(DADO) }), 'sem-zpl'],
    ];
    const invalido = zip({ [`${NOME}.zpl`]: armazenado(bytes(`^XA${DADO}^XZ`)) });
    const i = dadosDe(invalido, 0) + 5;
    invalido[i] = (invalido[i] ?? 0) ^ 0x01;
    casos.push([invalido, 'zip-invalido']);
    for (const [z, motivo] of casos) {
      let err: unknown;
      try {
        extrairEtiquetaZplEasyShip(z);
      } catch (e) {
        if (!(e instanceof AmazonDocumentoEasyShipError)) throw e;
        err = e;
      }
      expect(err).toMatchObject({ motivo });
      for (const t of textosDoErro(err)) {
        expect(t).not.toContain('SENTINELA');
        expect(t).not.toContain('^XA');
      }
    }
  });
});
