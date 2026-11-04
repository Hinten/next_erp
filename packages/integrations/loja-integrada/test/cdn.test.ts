import { abrirPrazo } from '@delfrance/core/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  criarLeitorCdnLi,
  type DesfechoImagemLi,
  detectarTipoImagemLi,
  FORMA_IMAGEM_LI,
  type FormaImagemLi,
  type LeitorCdnLi,
  MAX_BYTES_IMAGEM_LI,
  type OpcoesLeitorCdnLi,
  PRAZO_CDN_LI_MS,
  TIPO_IMAGEM_LI,
  URL_BASE_CDN_LI,
} from '../src/cdn';
import { URL_BASE_LI } from '../src/client';
import {
  LiAuthError,
  LiConfigError,
  LiError,
  LiNetworkError,
  LiThrottleError,
  LiTimeoutError,
} from '../src/errors';
import {
  type FetchArgs,
  fetchQueNuncaResponde,
  fetchQueTravaNoCorpo,
  mockFetch,
  observar,
  requisicao,
  TOKEN,
  verificarSoGet,
} from './_helpers/mockFetch';

/**
 * The CDN reader for product photos. Every `caminho` is the neutral fake the
 * document examples use (`especificacao.ts`), every picture a handful of
 * hand-made bytes carrying a real magic number, and every other host
 * `.invalid`: no captured value, and nothing here can reach a network.
 */

afterEach(verificarSoGet);

/** Every fetch mock a test handed a reader, for the shape check below. */
const usados: { mock: { calls: FetchArgs[] } }[] = [];

function cdn<M extends { mock: { calls: FetchArgs[] } }>(m: M): M {
  usados.push(m);
  return m;
}

function hrefDe(input: FetchArgs[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/**
 * Every request any test made: the pinned host, NO header at all (so no
 * `Authorization`), `credentials: 'omit'` and `redirect: 'manual'`.
 */
afterEach(() => {
  const chamadas = usados.flatMap((m) => m.mock.calls);
  usados.length = 0;
  for (const [input, init] of chamadas) {
    expect(new URL(hrefDe(input)).origin).toBe(URL_BASE_CDN_LI);
    expect([...new Headers(init?.headers).keys()]).toEqual([]);
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('manual');
  }
});

const CAMINHO = '1000/1000001/produto/imagem-exemplo-1.jpg';
const { original: ORIGINAL, reduzida: REDUZIDA } = FORMA_IMAGEM_LI;
const FORMAS: readonly FormaImagemLi[] = [ORIGINAL, REDUZIDA];

function bytesDe(texto: string): number[] {
  return [...texto].map((c) => c.charCodeAt(0));
}

/** Magic numbers followed by a few bytes of filler. */
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...bytesDe('JFIF'), 0x00, 0x01);
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
const GIF87A = Uint8Array.of(...bytesDe('GIF87a'), 0x01, 0x00);
const GIF89A = Uint8Array.of(...bytesDe('GIF89a'), 0x01, 0x00);
const WEBP = Uint8Array.of(...bytesDe('RIFF'), 0x24, 0, 0, 0, ...bytesDe('WEBPVP8 '));
const HTML = Uint8Array.of(...bytesDe('<!DOCTYPE html><html><body>erro</body></html>'));
const SVG = Uint8Array.of(...bytesDe('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));

/** A 2xx picture, labelled as the CDN labels its JPEGs (C10: `image/jpg`). */
function imagem(
  bytes: Uint8Array,
  headers: Record<string, string> = { 'content-type': 'image/jpg' },
  status = 200,
): Response {
  return new Response(bytes.slice(), { status, headers });
}

/** A body served one chunk per `read()`, counting the chunks pulled and seeing a cancel. */
function corpoEmPedacos(pedacos: readonly Uint8Array[]) {
  const estado = { puxados: 0, cancelado: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const pedaco = pedacos[estado.puxados];
        if (pedaco === undefined) {
          controller.close();
          return;
        }
        estado.puxados += 1;
        controller.enqueue(pedaco.slice());
      },
      cancel() {
        estado.cancelado = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, estado };
}

/** A reader with every ambient input injected: no network, no randomness. */
function leitor(fetch: typeof globalThis.fetch, extra: Partial<OpcoesLeitorCdnLi> = {}) {
  let n = 0;
  return criarLeitorCdnLi({
    fetch,
    gerarCorrelationId: () => {
      n += 1;
      return `corr-cdn-${String(n)}`;
    },
    ...extra,
  });
}

/** A fetch serving one response per call from `factory`, registered for the shape check. */
function servir(factory: (...args: FetchArgs) => Response | Promise<Response>) {
  return cdn(mockFetch(factory));
}

async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma rejeição');
    },
    (e: unknown) => e,
  );
}

async function baixar(
  l: LeitorCdnLi,
  forma: FormaImagemLi = ORIGINAL,
  caminho: string = CAMINHO,
): Promise<DesfechoImagemLi> {
  return l.baixarImagemLi(caminho, { forma });
}

describe('the constants', () => {
  it('pins the host, the deadline and the byte cap — changing one must be a deliberate, reviewed edit', () => {
    expect(URL_BASE_CDN_LI).toBe('https://cdn.awsli.com.br');
    expect(PRAZO_CDN_LI_MS).toBe(20_000);
    expect(MAX_BYTES_IMAGEM_LI).toBe(8 * 1024 * 1024);
    expect(FORMA_IMAGEM_LI).toEqual({ original: 'original', reduzida: '800x800' });
  });

  it('the deadline is a positive integer of at most 30,000 ms that abrirPrazo accepts', () => {
    expect(Number.isInteger(PRAZO_CDN_LI_MS)).toBe(true);
    expect(PRAZO_CDN_LI_MS).toBeGreaterThan(0);
    expect(PRAZO_CDN_LI_MS).toBeLessThanOrEqual(30_000);
    const prazo = abrirPrazo(PRAZO_CDN_LI_MS);
    expect(prazo.esgotado()).toBe(false);
    prazo.liberar();
  });

  it('the CDN is another origin than the API: the token’s host is never this one', () => {
    expect(new URL(URL_BASE_CDN_LI).origin).not.toBe(new URL(URL_BASE_LI).origin);
  });
});

describe('the URL: the pinned host, the form’s prefix and `caminho`, nothing else', () => {
  it('`original` GETs `/<caminho>`; `800x800` GETs `/800x800/<caminho>`', async () => {
    const f = servir(() => imagem(JPEG));
    const l = leitor(f);
    await baixar(l, ORIGINAL);
    await baixar(l, REDUZIDA);
    expect(f).toHaveBeenCalledTimes(2);
    expect(requisicao(f, 0).url.href).toBe(`${URL_BASE_CDN_LI}/${CAMINHO}`);
    expect(requisicao(f, 1).url.href).toBe(`${URL_BASE_CDN_LI}/800x800/${CAMINHO}`);
  });

  it.each([
    ['the document’s form', CAMINHO],
    [
      'upper case, an underscore and inner dots',
      '1000/1000001/produto/123/Imagem_Exemplo-2.v2.JPG',
    ],
    ['one segment', 'imagem-exemplo-3.png'],
  ])('EQUAL side: %s is fetched VERBATIM, in both forms', async (_nome, caminho) => {
    const f = servir(() => imagem(JPEG));
    const l = leitor(f);
    for (const forma of FORMAS) {
      expect(await baixar(l, forma, caminho)).toMatchObject({ resultado: 'ok' });
    }
    expect(requisicao(f, 0).url.pathname).toBe(`/${caminho}`);
    expect(requisicao(f, 1).url.pathname).toBe(`/800x800/${caminho}`);
  });

  it('sends a GET with no header AT ALL, `credentials: "omit"` and `redirect: "manual"`', async () => {
    const f = servir(() => imagem(JPEG));
    await baixar(leitor(f));
    const { init, headers } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(init.body ?? null).toBeNull();
    expect([...headers.keys()]).toEqual([]);
    expect(headers.has('authorization')).toBe(false);
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('manual');
  });

  it('takes no credential: one forced on it is never called, and nothing like it is sent', async () => {
    const f = servir(() => imagem(JPEG));
    const obterCredencial = vi.fn(() => ({ token: TOKEN, ref: 'ref-A' }));
    const l = criarLeitorCdnLi({
      fetch: f,
      // @ts-expect-error -- the reader has no credential option at all.
      obterCredencial,
    });
    await baixar(l);
    expect(obterCredencial).not.toHaveBeenCalled();
    const { url, headers } = requisicao(f);
    expect([...headers.keys()]).toEqual([]);
    expect(url.href).not.toContain(TOKEN);
  });

  it.each([['grande'], ['toString'], ['__proto__'], ['']])(
    'an unknown form %j is LiConfigError("forma"); nothing fetched',
    async (forma) => {
      const f = servir(() => imagem(JPEG));
      const err = await falha(leitor(f).baixarImagemLi(CAMINHO, { forma: forma as FormaImagemLi }));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('forma');
      expect(f).not.toHaveBeenCalled();
    },
  );
});

describe('a `caminho` that could leave its path is refused BEFORE any fetch', () => {
  const RECUSADOS: readonly (readonly [string, string | null | undefined])[] = [
    ['empty', ''],
    ['null (an image without one)', null],
    ['absent', undefined],
    ['a leading slash (it would make `//`)', `/${CAMINHO}`],
    ['a protocol-relative host', '//outro.invalid/imagem.jpg'],
    ['a `//` inside', '1000//1000001/imagem.jpg'],
    ['a parent segment', '1000/../1000001/imagem.jpg'],
    ['a leading parent segment', '../imagem.jpg'],
    // The URL parser keeps this one as written, so only the literal check refuses it.
    ['a `..` inside a segment', '1000/imagem..jpg'],
    ['a `./` segment the parser would drop', '1000/./imagem.jpg'],
    ['a `?`', `${CAMINHO}?v=2`],
    ['a `#`', `${CAMINHO}#a`],
    ['a backslash', '1000\\1000001\\imagem.jpg'],
    ['an encoded slash `%2F`', '1000%2F1000001/imagem.jpg'],
    ['an encoded slash `%2f`', '1000%2f1000001/imagem.jpg'],
    ['an encoded parent `%2e%2e`', '1000/%2e%2e/imagem.jpg'],
    ['an encoded parent `%2E%2E`', '1000/%2E%2E/imagem.jpg'],
    ['an encoded backslash `%5C`', '1000%5Cimagem.jpg'],
    ['an `https:` scheme', 'https://outro.invalid/imagem.jpg'],
    ['a `data:` scheme', 'data:image/png;base64,AAAA'],
    ['a `javascript:` scheme', 'javascript:void(0)'],
    ['a NUL', '1000/imagem\u0000.jpg'],
    ['a tab', '1000/\t/imagem.jpg'],
    ['a line break', `${CAMINHO}\n`],
    ['a DEL', '1000/imagem\u007f.jpg'],
    ['a space', '1000/imagem exemplo.jpg'],
    ['a non-ASCII character', '1000/imagem-ç.jpg'],
  ];

  it.each(RECUSADOS)('NEAR-MISS: %s ⇒ caminho-invalido, in both forms', async (_nome, caminho) => {
    const f = servir(() => imagem(JPEG));
    const l = leitor(f);
    for (const forma of FORMAS) {
      expect(await l.baixarImagemLi(caminho, { forma })).toEqual({ resultado: 'caminho-invalido' });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('an absolute URL from a body (the detail’s `grande`) is never fetched', async () => {
    const f = servir(() => imagem(JPEG));
    const grande = `${URL_BASE_CDN_LI}/800x800/${CAMINHO}`;
    expect(await baixar(leitor(f), REDUZIDA, grande)).toEqual({ resultado: 'caminho-invalido' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('redirects are never followed', () => {
  it.each([301, 302, 303, 307, 308])(
    'a %d is `redirecionamento` with the target’s HOST only — never its path or query',
    async (status) => {
      const f = servir(
        () =>
          new Response(null, {
            status,
            headers: {
              location: 'https://outro.invalid/caminho-secreto/imagem.jpg?assinatura=abc',
            },
          }),
      );
      const desfecho = await baixar(leitor(f));
      expect(desfecho).toEqual({ resultado: 'redirecionamento', status, host: 'outro.invalid' });
      expect(JSON.stringify(desfecho)).not.toMatch(/caminho-secreto|assinatura/);
      expect(f).toHaveBeenCalledTimes(1);
    },
  );

  it('the host keeps its port; a relative target is the CDN’s own host', async () => {
    const f = servir(
      () =>
        new Response(null, { status: 302, headers: { location: 'https://outro.invalid:8443/x' } }),
    );
    expect(await baixar(leitor(f))).toMatchObject({ host: 'outro.invalid:8443' });

    const relativo = servir(
      () => new Response(null, { status: 301, headers: { location: '/800x800/outra.jpg' } }),
    );
    expect(await baixar(leitor(relativo))).toEqual({
      resultado: 'redirecionamento',
      status: 301,
      host: 'cdn.awsli.com.br',
    });
  });

  it('a `Location` carrying a user and password gives the host alone: the credential is never echoed', async () => {
    const f = servir(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://usuario:senha-secreta@outro.invalid/imagem.jpg' },
        }),
    );
    const desfecho = await baixar(leitor(f));
    expect(desfecho).toEqual({ resultado: 'redirecionamento', status: 302, host: 'outro.invalid' });
    expect(JSON.stringify(desfecho)).not.toMatch(/usuario|senha-secreta/);
  });

  it('no `Location`, or one that does not parse, is `host: null`', async () => {
    const sem = servir(() => new Response(null, { status: 302 }));
    expect(await baixar(leitor(sem))).toEqual({
      resultado: 'redirecionamento',
      status: 302,
      host: null,
    });
    const quebrado = servir(
      () => new Response(null, { status: 302, headers: { location: 'http://[' } }),
    );
    expect(await baixar(leitor(quebrado))).toMatchObject({ host: null });
  });

  it('a browser’s opaque redirect (status 0, no headers) is `redirecionamento` too', async () => {
    const f = servir(() => {
      const res = new Response(null, { status: 302 });
      Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
      Object.defineProperty(res, 'status', { value: 0 });
      return res;
    });
    expect(await baixar(leitor(f))).toEqual({
      resultado: 'redirecionamento',
      status: 0,
      host: null,
    });
  });
});

describe('a non-2xx is an outcome, and its body is never read', () => {
  it('404 is `nao-encontrada`, the body cancelled unread', async () => {
    const { stream, estado } = corpoEmPedacos([HTML]);
    const f = servir(() => new Response(stream, { status: 404 }));
    expect(await baixar(leitor(f))).toEqual({ resultado: 'nao-encontrada', status: 404 });
    expect(estado).toEqual({ puxados: 0, cancelado: true });
  });

  it.each([400, 401, 403, 410, 429, 500, 502, 503])(
    'NEAR-MISS: %d is `http` with its status — resolved, never thrown',
    async (status) => {
      const { stream, estado } = corpoEmPedacos([HTML]);
      const f = servir(() => new Response(stream, { status }));
      expect(await baixar(leitor(f))).toEqual({ resultado: 'http', status });
      expect(estado).toEqual({ puxados: 0, cancelado: true });
    },
  );

  it('a CDN 401, 403 or 429 is never LiAuthError or LiThrottleError: nothing parks a conta or paces the API', async () => {
    for (const status of [401, 403, 429]) {
      const f = servir(() => new Response(null, { status, headers: { 'retry-after': '5' } }));
      const desfecho = await baixar(leitor(f)).then(
        (d) => d,
        (e: unknown) => e,
      );
      expect(desfecho).not.toBeInstanceOf(LiAuthError);
      expect(desfecho).not.toBeInstanceOf(LiThrottleError);
      expect(desfecho).toEqual({ resultado: 'http', status });
    }
  });
});

describe('the type is read from the BYTES', () => {
  it('a JPEG labelled `image/jpg` (the CDN’s own header, C10) is `image/jpeg`, its bytes returned whole', async () => {
    const f = servir(() => imagem(JPEG));
    expect(await baixar(leitor(f))).toEqual({
      resultado: 'ok',
      status: 200,
      tipo: TIPO_IMAGEM_LI.jpeg,
      bytes: JPEG,
    });
  });

  it('a PNG labelled `image/jpeg`, at a `.jpg` caminho, is a PNG: never the header, never the extension', async () => {
    const f = servir(() => imagem(PNG, { 'content-type': 'image/jpeg' }));
    expect(await baixar(leitor(f))).toMatchObject({ resultado: 'ok', tipo: TIPO_IMAGEM_LI.png });
  });

  it('a JPEG labelled `image/png`, at a `.png` caminho, is a JPEG', async () => {
    const f = servir(() => imagem(JPEG, { 'content-type': 'image/png' }));
    expect(
      await baixar(leitor(f), ORIGINAL, '1000/1000001/produto/imagem-exemplo-2.png'),
    ).toMatchObject({ resultado: 'ok', tipo: TIPO_IMAGEM_LI.jpeg });
  });

  it.each([
    ['WebP', WEBP, TIPO_IMAGEM_LI.webp],
    ['GIF87a', GIF87A, TIPO_IMAGEM_LI.gif],
    ['GIF89a', GIF89A, TIPO_IMAGEM_LI.gif],
  ])(
    '%s, served with no Content-Type at all, is read from its bytes',
    async (_nome, bytes, tipo) => {
      const f = servir(() => imagem(bytes, {}));
      expect(await baixar(leitor(f))).toMatchObject({ resultado: 'ok', tipo });
    },
  );

  it.each([
    ['an HTML error page served 200 as `image/jpeg`', HTML, { 'content-type': 'image/jpeg' }],
    ['an SVG (it can carry script)', SVG, { 'content-type': 'image/svg+xml' }],
    ['an empty body', new Uint8Array(0), { 'content-type': 'image/jpg' }],
  ])('NEAR-MISS: %s is `nao-e-imagem`', async (_nome, bytes, headers) => {
    const f = servir(() => imagem(bytes, headers));
    expect(await baixar(leitor(f))).toEqual({ resultado: 'nao-e-imagem', status: 200 });
  });

  it('a 200 with no body at all is `nao-e-imagem`', async () => {
    const f = servir(() => new Response(null, { status: 200 }));
    expect(await baixar(leitor(f))).toEqual({ resultado: 'nao-e-imagem', status: 200 });
  });

  it('a picture that arrives in several chunks comes back byte for byte, in order', async () => {
    const { stream } = corpoEmPedacos([JPEG.slice(0, 2), JPEG.slice(2, 7), JPEG.slice(7)]);
    const f = servir(() => new Response(stream, { status: 200 }));
    expect(await baixar(leitor(f))).toMatchObject({ resultado: 'ok', bytes: JPEG });
  });
});

describe('detectarTipoImagemLi: the magic numbers', () => {
  it.each([
    ['JPEG (JFIF)', JPEG, 'image/jpeg'],
    ['JPEG (Exif)', Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0x00), 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
    ['GIF87a', GIF87A, 'image/gif'],
    ['GIF89a', GIF89A, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
  ])('EQUAL side: %s ⇒ %s', (_nome, bytes, tipo) => {
    expect(detectarTipoImagemLi(bytes)).toBe(tipo);
  });

  it.each([
    ['JPEG without its third byte', Uint8Array.of(0xff, 0xd8)],
    ['JPEG with a wrong third byte', Uint8Array.of(0xff, 0xd8, 0xfe, 0xe0)],
    ['PNG cut one byte short', PNG.slice(0, 7)],
    ['PNG with a wrong last signature byte', Uint8Array.of(...PNG.slice(0, 7), 0x0b)],
    ['GIF88a', Uint8Array.of(...bytesDe('GIF88a'), 0x01)],
    ['GIF89 cut short', Uint8Array.of(...bytesDe('GIF89'))],
    [
      'a RIFF that is a WAV',
      Uint8Array.of(...bytesDe('RIFF'), 0x24, 0, 0, 0, ...bytesDe('WAVEfmt ')),
    ],
    ['RIFF alone', Uint8Array.of(...bytesDe('RIFF'))],
    ['a WebP cut inside its second run', WEBP.slice(0, 11)],
    ['a JPEG behind a byte-order mark', Uint8Array.of(0xef, 0xbb, 0xbf, ...JPEG)],
    ['HTML', HTML],
    ['SVG', SVG],
    ['nothing', new Uint8Array(0)],
  ])('NEAR-MISS: %s ⇒ null', (_nome, bytes) => {
    expect(detectarTipoImagemLi(bytes)).toBeNull();
  });
});

describe('the byte cap', () => {
  /** A JPEG of exactly `n` bytes (its magic number, then filler). */
  function jpegDe(n: number): Uint8Array {
    const bytes = new Uint8Array(n);
    bytes.set(JPEG.slice(0, Math.min(n, JPEG.length)));
    return bytes;
  }

  it('EQUAL side: a body of EXACTLY the cap is read whole and accepted', async () => {
    const f = servir(() => imagem(jpegDe(10)));
    expect(await baixar(leitor(f, { maxBytes: 10 }))).toMatchObject({ resultado: 'ok' });
  });

  it('NEAR-MISS: one byte over the cap is `muito-grande`', async () => {
    const f = servir(() => imagem(jpegDe(11)));
    expect(await baixar(leitor(f, { maxBytes: 10 }))).toEqual({
      resultado: 'muito-grande',
      status: 200,
    });
  });

  it('with no Content-Length, the read STOPS the moment the total passes the cap, and the stream is cancelled', async () => {
    const pedacos = [0, 1, 2, 3, 4].map((i) => (i === 0 ? JPEG.slice(0, 4) : new Uint8Array(4)));
    const { stream, estado } = corpoEmPedacos(pedacos);
    const f = servir(() => new Response(stream, { status: 200 }));
    expect(await baixar(leitor(f, { maxBytes: 10 }))).toEqual({
      resultado: 'muito-grande',
      status: 200,
    });
    // 4 + 4 = 8 fits, + 4 = 12 does not: the third chunk is the last one pulled.
    expect(estado).toEqual({ puxados: 3, cancelado: true });
  });

  it('a Content-Length over the cap is refused before a single chunk is read', async () => {
    const { stream, estado } = corpoEmPedacos([jpegDe(4)]);
    const f = servir(
      () => new Response(stream, { status: 200, headers: { 'content-length': '11' } }),
    );
    expect(await baixar(leitor(f, { maxBytes: 10 }))).toEqual({
      resultado: 'muito-grande',
      status: 200,
    });
    expect(estado).toEqual({ puxados: 0, cancelado: true });
  });

  it('a Content-Length that LIES (under the cap) does not get a larger body through', async () => {
    const { stream, estado } = corpoEmPedacos([jpegDe(4), new Uint8Array(4), new Uint8Array(4)]);
    const f = servir(
      () => new Response(stream, { status: 200, headers: { 'content-length': '4' } }),
    );
    expect(await baixar(leitor(f, { maxBytes: 10 }))).toMatchObject({ resultado: 'muito-grande' });
    expect(estado.cancelado).toBe(true);
  });

  it('a Content-Length that is not plain digits is ignored: the bytes read decide', async () => {
    const f = servir(() => imagem(jpegDe(8), { 'content-length': '1e9' }));
    expect(await baixar(leitor(f, { maxBytes: 10 }))).toMatchObject({ resultado: 'ok' });
  });

  it('the default cap is MAX_BYTES_IMAGEM_LI: one byte over it is refused, the cap itself is not', async () => {
    const acima = servir(() =>
      imagem(jpegDe(4), { 'content-length': String(MAX_BYTES_IMAGEM_LI + 1) }),
    );
    expect(await baixar(leitor(acima))).toMatchObject({ resultado: 'muito-grande' });
    const noLimite = servir(() =>
      imagem(jpegDe(4), { 'content-length': String(MAX_BYTES_IMAGEM_LI) }),
    );
    expect(await baixar(leitor(noLimite))).toMatchObject({ resultado: 'ok' });
  });

  it('`muito-grande` is the caller’s cue to ask for `800x800`: the original over the cap, the reduction within it', async () => {
    const f = servir((input) =>
      hrefDe(input).includes('/800x800/')
        ? imagem(jpegDe(6))
        : imagem(jpegDe(4), { 'content-length': '200000' }),
    );
    const l = leitor(f, { maxBytes: 150_000 });
    const original = await baixar(l, ORIGINAL);
    expect(original).toEqual({ resultado: 'muito-grande', status: 200 });
    const reduzida = await baixar(l, REDUZIDA);
    expect(reduzida).toMatchObject({ resultado: 'ok', tipo: TIPO_IMAGEM_LI.jpeg });
    expect(requisicao(f, 0).url.pathname).toBe(`/${CAMINHO}`);
    expect(requisicao(f, 1).url.pathname).toBe(`/800x800/${CAMINHO}`);
  });
});

describe('the deadline and the transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is still pending at the deadline − 1 and throws LiTimeoutError at it, carrying no credential', async () => {
    const f = cdn(fetchQueNuncaResponde());
    const { estado, pronto } = observar(baixar(leitor(f), REDUZIDA));

    await vi.advanceTimersByTimeAsync(PRAZO_CDN_LI_MS - 1);
    expect(estado.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toBeInstanceOf(LiTimeoutError);
    expect(estado.valor).toBeInstanceOf(LiNetworkError);
    expect(estado.valor).toMatchObject({
      prazoMs: PRAZO_CDN_LI_MS,
      operacao: 'baixarImagem',
      caminho: `/800x800/${CAMINHO}`,
      correlationId: 'corr-cdn-1',
      refCredencial: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a shorter deadline is honoured', async () => {
    const f = cdn(fetchQueNuncaResponde());
    const { estado, pronto } = observar(baixar(leitor(f, { prazoMs: 5_000 })));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(estado.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toBeInstanceOf(LiTimeoutError);
    expect((estado.valor as LiTimeoutError).prazoMs).toBe(5_000);
  });

  it('a stall AFTER the headers times out too — the body is read inside the window', async () => {
    const f = cdn(fetchQueTravaNoCorpo());
    const { estado, pronto } = observar(baixar(leitor(f)));
    await vi.advanceTimersByTimeAsync(PRAZO_CDN_LI_MS);
    await pronto;
    expect(estado.valor).toBeInstanceOf(LiTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the caller’s abort, before the headers or mid-body, is rethrown as itself — never a timeout, never wrapped', async () => {
    for (const f of [cdn(fetchQueNuncaResponde()), cdn(fetchQueTravaNoCorpo())]) {
      const controller = new AbortController();
      const { estado, pronto } = observar(
        leitor(f).baixarImagemLi(CAMINHO, { forma: ORIGINAL, sinal: controller.signal }),
      );
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await pronto;
      expect(estado.valor).toBe(controller.signal.reason);
      expect(estado.valor).not.toBeInstanceOf(LiError);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('NEAR-MISS: a caller abort whose reason IS a TypeError is still the caller’s — never read as a dropped connection', async () => {
    for (const f of [cdn(fetchQueNuncaResponde()), cdn(fetchQueTravaNoCorpo())]) {
      const controller = new AbortController();
      const motivo = new TypeError('motivo do chamador');
      const { estado, pronto } = observar(
        leitor(f).baixarImagemLi(CAMINHO, { forma: ORIGINAL, sinal: controller.signal }),
      );
      await vi.advanceTimersByTimeAsync(10);
      controller.abort(motivo);
      await pronto;
      expect(estado.valor).toBe(motivo);
      expect(estado.valor).not.toBeInstanceOf(LiNetworkError);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('a caller already aborted: nothing is fetched, its reason comes back', async () => {
    const controller = new AbortController();
    controller.abort(new RangeError('motivo do chamador'));
    const f = servir(() => imagem(JPEG));
    await expect(
      leitor(f).baixarImagemLi(CAMINHO, { forma: ORIGINAL, sinal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    expect(f).not.toHaveBeenCalled();
  });

  it('a TypeError from fetch is LiNetworkError: its text kept out of the message, the original as cause', async () => {
    const causa = new TypeError('MARCADOR-DA-CAUSA fetch failed');
    const f = servir(() => {
      throw causa;
    });
    const err = await falha(baixar(leitor(f)));
    expect(err).toBeInstanceOf(LiNetworkError);
    expect(err).not.toBeInstanceOf(LiTimeoutError);
    expect((err as LiNetworkError).cause).toBe(causa);
    expect((err as LiNetworkError).message).not.toContain('MARCADOR-DA-CAUSA');
    expect(err).toMatchObject({ caminho: `/${CAMINHO}`, refCredencial: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a connection dropped mid-body is LiNetworkError', async () => {
    const f = servir(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(JPEG.slice(0, 4));
              controller.error(new TypeError('terminated'));
            },
          }),
          { status: 200 },
        ),
    );
    const err = await falha(baixar(leitor(f)));
    expect(err).toBeInstanceOf(LiNetworkError);
    expect(err).not.toBeInstanceOf(LiTimeoutError);
  });

  it('anything else fetch rejects with is rethrown as itself', async () => {
    const propria = new RangeError('init inválido');
    const f = servir(() => {
      throw propria;
    });
    await expect(baixar(leitor(f))).rejects.toBe(propria);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending after a picture or a refusal', async () => {
    await baixar(leitor(servir(() => imagem(JPEG))));
    expect(vi.getTimerCount()).toBe(0);
    await baixar(leitor(servir(() => new Response(null, { status: 404 }))));
    expect(vi.getTimerCount()).toBe(0);
    await baixar(leitor(servir(() => imagem(JPEG))), REDUZIDA);
    await baixar(
      leitor(
        servir(() => imagem(JPEG)),
        { maxBytes: 4 },
      ),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the options are checked where the reader is built', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, PRAZO_CDN_LI_MS + 1])(
    'NEAR-MISS: prazoMs %d ⇒ LiConfigError("prazo")',
    (prazoMs) => {
      expect(() => criarLeitorCdnLi({ prazoMs })).toThrow(LiConfigError);
      expect(() => criarLeitorCdnLi({ prazoMs })).toThrow(
        expect.objectContaining({ motivo: 'prazo' }),
      );
    },
  );

  it.each([1, PRAZO_CDN_LI_MS])('EQUAL side: prazoMs %d is accepted', (prazoMs) => {
    expect(() => criarLeitorCdnLi({ prazoMs })).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_BYTES_IMAGEM_LI + 1])(
    'NEAR-MISS: maxBytes %d ⇒ LiConfigError("maxBytes")',
    (maxBytes) => {
      expect(() => criarLeitorCdnLi({ maxBytes })).toThrow(
        expect.objectContaining({ motivo: 'maxBytes' }),
      );
    },
  );

  it.each([1, MAX_BYTES_IMAGEM_LI])('EQUAL side: maxBytes %d is accepted', (maxBytes) => {
    expect(() => criarLeitorCdnLi({ maxBytes })).not.toThrow();
  });

  it('the default fetch is resolved at call time from globalThis, and the default correlation id is a UUID', async () => {
    const f = servir(() => {
      throw new TypeError('sem rede');
    });
    vi.stubGlobal('fetch', f);
    try {
      const err = await falha(criarLeitorCdnLi().baixarImagemLi(CAMINHO, { forma: ORIGINAL }));
      expect(f).toHaveBeenCalledTimes(1);
      expect(err).toBeInstanceOf(LiNetworkError);
      expect((err as LiNetworkError).correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
