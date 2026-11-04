/**
 * The CDN reader for product photos (master-plan step 9): `criarLeitorCdnLi`
 * → `baixarImagemLi(caminho, { forma, sinal })`.
 *
 * A produto detail's image carries a `caminho` (`1000/1000001/produto/…/x.jpg`)
 * beside absolute URLs built from it (`grande`, `media`, …). The bytes live on
 * Loja Integrada's CDN, not on the API: another host, no credential, and a body
 * that is a picture, not JSON. So this is a reader of its own, not a method of
 * the API client, and it shares nothing with it but the transport error
 * classes and the deadline primitive.
 *
 * ## The URL is built here, from `caminho` alone
 *
 * {@link URL_BASE_CDN_LI}, then the form's prefix, then `caminho`:
 *
 *  - `'original'` → `/<caminho>`: the upload at full resolution, what the
 *    import stores (the ERP makes its own derivatives);
 *  - `'800x800'` → `/800x800/<caminho>`: the CDN's own reduction (the detail's
 *    `grande`), for when the original is over the byte cap.
 *
 * The owner's capture C10 saw both forms answer 200 for the same photo. Which
 * form to ask for, and falling back from one to the other, is the caller's:
 * this reader fetches exactly the form it is asked for.
 *
 * ⚠️ **Never a URL from a body** (`grande`, `url`, …): the host is a constant, so
 * no response can point this reader anywhere else. And a `caminho` that could
 * leave the path it names is refused BEFORE anything is fetched: empty or
 * absent, a leading `/` or a `//`, a `..`, a `?` or a `#`, a backslash, an
 * encoded `.`, `/` or `\` (`%2e`, `%2f`, `%5c`, any case), a scheme (`https:`,
 * `data:`), a control character, a space or anything outside visible ASCII —
 * and anything the URL parser would rewrite (a `./` segment). The same rule as
 * the API client's path check (`client.ts`), which it shares the encoded
 * separator test with: the path must reach the server exactly as written.
 *
 * ## No credential, ever
 *
 * The reader takes no credential, and its request carries NO header at all —
 * no `Authorization`, no cookie, no correlation id — with `credentials: 'omit'`.
 * The Personal Token belongs to the API host alone; neither the CDN nor
 * whatever it redirects to may ever see it.
 *
 * ## Each download, in order
 *
 *  1. The form must be one of the two (`LiConfigError('forma')` otherwise); the
 *     `caminho` must pass the check above (the `caminho-invalido` outcome
 *     otherwise). Nothing is fetched either way.
 *  2. A caller signal that already aborted gets its own reason back.
 *  3. The deadline opens (`prazoMs`, linked to the caller's `sinal`), `fetch`
 *     runs with `redirect: 'manual'`, the body is read INSIDE the window, and
 *     the deadline is released in `finally`.
 *  4. The response is classified (below). A body this reader does not need (a
 *     refusal) is cancelled, never read.
 *
 * ## Outcomes and throws
 *
 * A picture refused for what the CDN ANSWERED is a typed outcome
 * ({@link DesfechoImagemLi}), never an exception: the importer reports it on
 * that one photo (`foto-recusada`) and goes on with the next.
 *
 * | `resultado` | When |
 * | --- | --- |
 * | `ok` | a 2xx whose bytes are a JPEG, PNG, WebP or GIF, within the cap |
 * | `caminho-invalido` | the `caminho` failed the check; nothing was fetched |
 * | `redirecionamento` | a 3xx (never followed), with its target's HOST only |
 * | `nao-encontrada` | 404 |
 * | `http` | any other non-2xx, with its status |
 * | `muito-grande` | the body is over the byte cap (announced or read) |
 * | `nao-e-imagem` | a 2xx whose bytes are none of the four types |
 *
 * `muito-grande` is its own outcome on purpose: it is the one a caller asking
 * for the original answers by asking again for `800x800`.
 *
 * What is THROWN follows the API client's transport classes (`errors.ts`), so a
 * caller narrows a photo's failure as it narrows any read's:
 *
 *  - the deadline → `LiTimeoutError`, with `prazoMs`;
 *  - a transport failure (a `TypeError` from `fetch`, or from the body stream
 *    when the connection drops) → `LiNetworkError`, the original as `cause`
 *    and its text never copied;
 *  - the caller's own abort → its reason, as-is, never wrapped;
 *  - anything else `fetch` rejects with → as-is;
 *  - our own options (`prazo`, `maxBytes`, `forma`) → `LiConfigError`, before
 *    anything is fetched.
 *
 * These errors carry `refCredencial: null` (no credential travelled) and a
 * correlation id minted per download that is never sent: it only names the
 * download in the caller's log. Their `caminho` is the CDN path asked for.
 *
 * ⚠️ A CDN 401, 403 or 429 is never `LiAuthError` or `LiThrottleError`. The CDN
 * never saw the credential, so its refusal must not park a conta; and its rate
 * limit is not the API's, so it must not pace the API's queue. All three are the
 * `http` outcome, and whether a 5xx or a 429 is worth a later retry is the
 * caller's call, from `status`.
 *
 * ## The type is read from the BYTES
 *
 * Never from the header, the extension or the detail's `mime`. C10 showed why:
 * the CDN answers `Content-Type: image/jpg`, which is not a registered type, so
 * the header is not even well-formed where it is right. The magic numbers of
 * JPEG, PNG, WebP and GIF decide ({@link detectarTipoImagemLi}); anything else —
 * an HTML error page served with a 200, an SVG (it can carry script), AVIF,
 * BMP, an empty body — is `nao-e-imagem`.
 *
 * ## The byte cap
 *
 * A `Content-Length` over the cap is refused without reading the body. Without
 * one, or with a wrong one, the body is read chunk by chunk and refused the
 * moment the total passes the cap, the stream cancelled: it is never buffered
 * whole first. A body of exactly the cap is accepted.
 *
 * ## The deadline
 *
 * {@link PRAZO_CDN_LI_MS} per download, the body included, and a caller may only
 * shorten it: it is the worst case the import budgets a photo for, so a longer
 * one is refused rather than silently breaking that budget. The constant is a
 * plain scalar with no `longo` tier, so `http-client-timeout-ceiling.test.js`
 * has no row for it (that registry holds clients of OUR backends).
 */
import { abrirPrazo } from '@delfrance/core/wire';

import { SEPARADOR_CODIFICADO } from './client';
import { type ContextoRequisicaoLi, LiConfigError, LiNetworkError, LiTimeoutError } from './errors';

/** The one CDN origin photos are read from. A constant, never an option. */
export const URL_BASE_CDN_LI = 'https://cdn.awsli.com.br';

/** Milliseconds per download, the body included; the most a caller may set. */
export const PRAZO_CDN_LI_MS = 20_000;

/** The default byte cap of one photo (8 MiB); the most a caller may set. */
export const MAX_BYTES_IMAGEM_LI = 8 * 1024 * 1024;

/** Which rendition of a photo is fetched (module header). */
export type FormaImagemLi = 'original' | '800x800';

/** Named members of {@link FormaImagemLi}. */
export const FORMA_IMAGEM_LI = {
  original: 'original',
  reduzida: '800x800',
} as const satisfies Record<string, FormaImagemLi>;

/** The path prefix of each form, before `caminho`. */
const PREFIXO_DA_FORMA = {
  original: '/',
  '800x800': '/800x800/',
} as const satisfies Record<FormaImagemLi, string>;

/** The four picture types accepted, as the media type the bytes are. */
export type TipoImagemLi = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

/** Named members of {@link TipoImagemLi}. */
export const TIPO_IMAGEM_LI = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
} as const satisfies Record<string, TipoImagemLi>;

/** What one download came to (module header, "Outcomes and throws"). */
export type DesfechoImagemLi =
  | {
      readonly resultado: 'ok';
      readonly status: number;
      /** Read from the bytes, never from the header. */
      readonly tipo: TipoImagemLi;
      readonly bytes: Uint8Array;
    }
  | { readonly resultado: 'caminho-invalido' }
  | {
      readonly resultado: 'redirecionamento';
      /** The 3xx, or 0 for a browser's opaque redirect. */
      readonly status: number;
      /** The target's host alone (`host[:port]`), never its path or query; `null` when unreadable. */
      readonly host: string | null;
    }
  | { readonly resultado: 'nao-encontrada'; readonly status: number }
  | { readonly resultado: 'http'; readonly status: number }
  | { readonly resultado: 'muito-grande'; readonly status: number }
  | { readonly resultado: 'nao-e-imagem'; readonly status: number };

/** The discriminant of {@link DesfechoImagemLi}. */
export type ResultadoImagemLi = DesfechoImagemLi['resultado'];

export interface OpcoesLeitorCdnLi {
  /** Defaults to `globalThis.fetch`, resolved at call time. */
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to {@link PRAZO_CDN_LI_MS}; a positive safe integer no larger. */
  readonly prazoMs?: number;
  /** Defaults to {@link MAX_BYTES_IMAGEM_LI}; a positive safe integer no larger. */
  readonly maxBytes?: number;
  /** Names each download on its errors; never sent. Defaults to `crypto.randomUUID()`. */
  readonly gerarCorrelationId?: () => string;
}

export interface OpcoesBaixarImagemLi {
  /** Which rendition: there is no default, the caller says which. */
  readonly forma: FormaImagemLi;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

/** The CDN reader. There is no other method, and no credential anywhere. */
export interface LeitorCdnLi {
  /**
   * One photo, by its `caminho` as the produto detail carries it (absent or
   * `null` is refused like a malformed one).
   */
  baixarImagemLi(
    caminho: string | null | undefined,
    opts: OpcoesBaixarImagemLi,
  ): Promise<DesfechoImagemLi>;
}

/* -------------------------------------------------------------------------- */
/*                               The path check                               */
/* -------------------------------------------------------------------------- */

/** Visible ASCII only: no space, control character, line break or non-ASCII. */
const ASCII_VISIVEL = /^[\x21-\x7E]+$/;

/** A URL scheme at the start (`https:`, `data:`, `javascript:`). */
const ESQUEMA = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Whether `caminho`, after `prefixo`, names one path on the CDN exactly as
 * written (module header). The literal checks come first; then the full path
 * must come out of the URL parser unchanged, on our origin, with no query and
 * no fragment — whatever the parser would have rewritten is refused instead.
 */
function caminhoDeImagemValido(
  caminho: string | null | undefined,
  prefixo: string,
): caminho is string {
  if (
    typeof caminho !== 'string' ||
    !ASCII_VISIVEL.test(caminho) ||
    caminho.startsWith('/') ||
    caminho.includes('//') ||
    caminho.includes('..') ||
    caminho.includes('?') ||
    caminho.includes('#') ||
    caminho.includes('\\') ||
    SEPARADOR_CODIFICADO.test(caminho) ||
    ESQUEMA.test(caminho)
  ) {
    return false;
  }
  const caminhoCompleto = `${prefixo}${caminho}`;
  let url: URL;
  try {
    url = new URL(`${URL_BASE_CDN_LI}${caminhoCompleto}`);
  } catch (err) {
    if (err instanceof TypeError) return false;
    throw err;
  }
  return (
    url.origin === URL_BASE_CDN_LI &&
    url.pathname === caminhoCompleto &&
    url.search === '' &&
    url.hash === ''
  );
}

/* -------------------------------------------------------------------------- */
/*                             The type, from bytes                            */
/* -------------------------------------------------------------------------- */

/** One run of bytes at a fixed offset. */
interface TrechoAssinatura {
  readonly posicao: number;
  readonly bytes: readonly number[];
}

/** `GIF87a` / `GIF89a` and `RIFF` / `WEBP`, as bytes. */
const bytesDoTexto = (texto: string): readonly number[] => [...texto].map((c) => c.charCodeAt(0));

/**
 * Each type's magic number: every run of a row must match. WebP is a RIFF
 * container, so it takes TWO runs (`RIFF` at 0, `WEBP` at 8): `RIFF` alone is
 * also a WAV or an AVI.
 */
const ASSINATURAS: readonly {
  readonly tipo: TipoImagemLi;
  readonly trechos: readonly TrechoAssinatura[];
}[] = [
  { tipo: TIPO_IMAGEM_LI.jpeg, trechos: [{ posicao: 0, bytes: [0xff, 0xd8, 0xff] }] },
  {
    tipo: TIPO_IMAGEM_LI.png,
    trechos: [{ posicao: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  { tipo: TIPO_IMAGEM_LI.gif, trechos: [{ posicao: 0, bytes: bytesDoTexto('GIF87a') }] },
  { tipo: TIPO_IMAGEM_LI.gif, trechos: [{ posicao: 0, bytes: bytesDoTexto('GIF89a') }] },
  {
    tipo: TIPO_IMAGEM_LI.webp,
    trechos: [
      { posicao: 0, bytes: bytesDoTexto('RIFF') },
      { posicao: 8, bytes: bytesDoTexto('WEBP') },
    ],
  },
];

function casa(bytes: Uint8Array, { posicao, bytes: esperados }: TrechoAssinatura): boolean {
  return esperados.every((b, i) => bytes[posicao + i] === b);
}

/**
 * The picture type `bytes` ARE, from their magic number alone, or `null` when
 * they are none of the four (module header, "The type is read from the
 * BYTES"). Pure: no header, no name, no `mime` is consulted, because none is
 * passed.
 */
export function detectarTipoImagemLi(bytes: Uint8Array): TipoImagemLi | null {
  for (const { tipo, trechos } of ASSINATURAS) {
    if (trechos.every((t) => casa(bytes, t))) return tipo;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*                                The response                                */
/* -------------------------------------------------------------------------- */

/** A `Content-Length` of plain digits within the safe-integer range, else `null`. */
function tamanhoDeclarado(valor: string | null): number | null {
  if (valor === null || !/^\d+$/.test(valor.trim())) return null;
  const n = Number(valor.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/** The host a redirect points at, never its path or query; `null` when unreadable. */
function hostDoRedirecionamento(location: string | null, base: string): string | null {
  if (location === null) return null;
  let url: URL;
  try {
    url = new URL(location, base);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
  return url.host === '' ? null : url.host;
}

/** A body this reader does not need is cancelled, never read. */
async function descartarCorpo(res: Response): Promise<void> {
  await res.body?.cancel();
}

/**
 * The body, chunk by chunk, or `null` the moment the total passes `maxBytes`
 * (the stream then cancelled): never buffered whole before the cap is checked.
 */
async function lerAteOLimite(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (res.body === null) return new Uint8Array(0);
  const leitor = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await leitor.cancel();
      return null;
    }
    partes.push(value);
  }
  const bytes = new Uint8Array(total);
  let posicao = 0;
  for (const parte of partes) {
    bytes.set(parte, posicao);
    posicao += parte.byteLength;
  }
  return bytes;
}

/** Module header, "Outcomes and throws": every non-2xx before the body is read. */
async function classificar(
  res: Response,
  url: string,
  maxBytes: number,
): Promise<DesfechoImagemLi> {
  const { status } = res;
  // `redirect: 'manual'` hands Node the 3xx itself and a browser an opaque
  // redirect (status 0, no headers): neither is ever followed.
  if (res.type === 'opaqueredirect' || (status >= 300 && status <= 399)) {
    const host = hostDoRedirecionamento(res.headers.get('location'), url);
    await descartarCorpo(res);
    return { resultado: 'redirecionamento', status, host };
  }
  if (status === 404) {
    await descartarCorpo(res);
    return { resultado: 'nao-encontrada', status };
  }
  if (!res.ok) {
    await descartarCorpo(res);
    return { resultado: 'http', status };
  }
  const declarado = tamanhoDeclarado(res.headers.get('content-length'));
  if (declarado !== null && declarado > maxBytes) {
    await descartarCorpo(res);
    return { resultado: 'muito-grande', status };
  }
  const bytes = await lerAteOLimite(res, maxBytes);
  if (bytes === null) return { resultado: 'muito-grande', status };
  const tipo = detectarTipoImagemLi(bytes);
  if (tipo === null) return { resultado: 'nao-e-imagem', status };
  return { resultado: 'ok', status, tipo, bytes };
}

/* -------------------------------------------------------------------------- */
/*                                 The reader                                 */
/* -------------------------------------------------------------------------- */

/** A positive safe integer no larger than `teto`. */
function inteiroPositivoAte(valor: number, teto: number): boolean {
  return Number.isSafeInteger(valor) && valor > 0 && valor <= teto;
}

/**
 * The CDN reader. Its options are checked HERE, once (`LiConfigError('prazo')`,
 * `LiConfigError('maxBytes')`), so a misconfigured reader fails where it is
 * built, before any photo.
 */
export function criarLeitorCdnLi(opts: OpcoesLeitorCdnLi = {}): LeitorCdnLi {
  const prazoMs = opts.prazoMs ?? PRAZO_CDN_LI_MS;
  const maxBytes = opts.maxBytes ?? MAX_BYTES_IMAGEM_LI;
  if (!inteiroPositivoAte(prazoMs, PRAZO_CDN_LI_MS)) {
    throw new LiConfigError('prazo', { operacao: 'criarLeitorCdn', refCredencial: null });
  }
  if (!inteiroPositivoAte(maxBytes, MAX_BYTES_IMAGEM_LI)) {
    throw new LiConfigError('maxBytes', { operacao: 'criarLeitorCdn', refCredencial: null });
  }
  // Resolved at call time, and never called unbound (`client.ts`).
  const fetchImpl: typeof globalThis.fetch =
    opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const gerarCorrelationId = opts.gerarCorrelationId ?? (() => globalThis.crypto.randomUUID());

  async function baixarImagemLi(
    caminho: string | null | undefined,
    { forma, sinal }: OpcoesBaixarImagemLi,
  ): Promise<DesfechoImagemLi> {
    const operacao = 'baixarImagem';
    // A cast or an untyped caller can still pass anything: refused, not built into a URL.
    if (!Object.hasOwn(PREFIXO_DA_FORMA, forma)) {
      throw new LiConfigError('forma', { operacao, refCredencial: null });
    }
    const prefixo = PREFIXO_DA_FORMA[forma];
    if (!caminhoDeImagemValido(caminho, prefixo)) return { resultado: 'caminho-invalido' };

    // Nothing was sent yet: a caller that already gave up gets its own abort back.
    sinal?.throwIfAborted();

    const caminhoCompleto = `${prefixo}${caminho}`;
    const url = `${URL_BASE_CDN_LI}${caminhoCompleto}`;
    const ctx: ContextoRequisicaoLi = {
      operacao,
      caminho: caminhoCompleto,
      correlationId: gerarCorrelationId(),
      refCredencial: null,
      metodo: 'GET',
    };
    const prazo = abrirPrazo(prazoMs, { vincular: sinal });
    try {
      // No `headers` at all: no credential, no cookie, no correlation id.
      const res = await fetchImpl(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        signal: prazo.signal,
      });
      return await classificar(res, url, maxBytes);
    } catch (err) {
      // Asked of the deadline itself, never `err instanceof DOMException`
      // (`client.ts`, `prazo.ts`).
      if (prazo.esgotado()) throw new LiTimeoutError({ ...ctx, prazoMs }, err);
      if (sinal?.aborted === true) throw err;
      if (err instanceof TypeError) throw new LiNetworkError(ctx, err);
      throw err;
    } finally {
      prazo.liberar();
    }
  }

  return { baixarImagemLi };
}
