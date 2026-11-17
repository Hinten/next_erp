/**
 * The two pre-signed transfers of a `JSON_LISTINGS_FEED` submission: the
 * upload of the feed document to the URL `createFeedDocument` answered
 * ({@link enviarDocumentoFeedAmazon}), and the bounded download of the
 * processing report behind `getFeedDocument`'s URL
 * ({@link baixarRelatorioFeedAmazon}). Both raise `AmazonDocumentoFeedError`
 * (`errors.ts`) with a closed `motivo`.
 *
 * Neither is an SP-API call: no credential, no observer event, no
 * `onChamada`, so the URL (a bearer link to the seller's feed) can never reach
 * an event or a log line, and neither does its host or its query. Nothing here
 * stores the URL, the document or the report. Both are gated TRANSITIVELY: their
 * URLs exist only in the answer of an SP-API call the app already let through.
 *
 * ## Shared by both
 *
 * - **The URL** goes through the pre-signed URL guard (`preAssinada.ts`):
 *   `https:`, no userinfo, no port, a host ending in `.amazonaws.com`. Anything
 *   else is `'url-invalida'` and nothing is sent. Amazon's sandbox answers carry
 *   CloudFront hosts; those are refused by this rule.
 * - **One request**, `redirect: 'error'` (a redirect is a `TypeError`, so
 *   `'rede'`, never a hop to another host), under its own deadline class
 *   (`prazos.ts`).
 * - **The ladder**, in this order: our own refusal keeps its motivo; the
 *   deadline is `'prazo'`; the caller's own abort is rethrown as itself; a
 *   `TypeError` (DNS, TLS, a reset, a body dropped mid-stream, a refused
 *   redirect) is `'rede'`; anything else is rethrown as itself.
 * - ⚠️ `fetch` is a REQUIRED option, with no default: a forgotten injection must
 *   fail to compile rather than send a real request from a test suite that does
 *   not block the global one. One that slips past the type (a cast, a JS caller)
 *   is a `TypeError` thrown before the deadline opens, never a retryable
 *   `'rede'`.
 *
 * ## The upload
 *
 * ONE `PUT` with EXACTLY one header, `content-type`, equal to the value the
 * document was declared with (`CONTENT_TYPE_FEED_JSON`, `feeds.ts`), and the
 * bytes as built; under `PRAZO_AMAZON_MS.upload`. Any 2xx is success; its body is
 * never kept. A 403 is `'expirado'` (transient) ONLY when the URL has outlived
 * its documented lifetime (5 minutes since `createFeedDocument` answered, the
 * caller's `emitidoEmMs`), else `'recusado'` (deterministic: most likely a
 * signature mismatch, such as a content type other than the signed one); both
 * carry the closed `codigoS3` read from at most 4 KiB of the XML answer, never
 * its message. Any other non-2xx is `'http'` with its status.
 *
 * ## The download
 *
 * ONE header-free `GET` (no `headers` key at all), under
 * `PRAZO_AMAZON_MS.documento`. A 403 is `'expirado'` (a fresh `getFeedDocument`
 * fixes it), any other non-200 is `'http'`. Then:
 *
 * 1. **The body** is read chunk by chunk with a running count; the first chunk
 *    past {@link MAX_RELATORIO_FEED_BYTES} cancels the stream: `'grande-demais'`.
 * 2. **`GZIP`** (the only `compressionAlgorithm` the model lists; any other
 *    value is `'relatorio-invalido'` before anything is fetched): the gzip
 *    trailer's ISIZE is read FIRST, and a value past
 *    {@link MAX_RELATORIO_JSON_BYTES} is `'grande-demais'` with nothing
 *    inflated. The body then goes through fflate's streaming `Gunzip`,
 *    {@link FATIA_GZIP_BYTES} at a time, into a buffer of exactly ISIZE bytes,
 *    and the first slice whose output passes ISIZE stops the inflation: an
 *    understated ISIZE costs at most one slice's expansion (deflate's ratio
 *    caps it near 1,032:1, ≈ 16 MiB; a stored block, ≤ 64 KiB, comes out only
 *    once whole), never the whole stream's. A fixed output buffer would not
 *    stop it: past the buffer's end fflate keeps decoding a Huffman block into
 *    nothing, and throws a bare `RangeError` on a stored block. The output
 *    must then be EXACTLY ISIZE bytes long and its
 *    CRC-32 (`crc32.ts`) must equal the trailer's, since fflate checks neither.
 *    An output past ISIZE, either mismatch, or fflate's own error is
 *    `'gzip-invalido'`.
 * 3. **The text**: strict UTF-8 (a malformed byte is `'json-invalido'`), then
 *    the report parser (`lerRelatorioProcessamentoListings`, `feeds.ts`).
 *
 * The caps are sized against the V8 heap, not the instance memory: ≤ 20 MiB of
 * compressed body and ≤ 32 MiB of inflated bytes (both off-heap), ≤ 64 MiB of
 * decoded string (UTF-16 in the worst case) and a parse tree of a few times the
 * inflated size, ≈ 160 MiB at most. That is meant to stay under the old space V8
 * is expected to size for a 1 GiB instance, an assumption: whether the platform
 * sizes the heap from the instance memory is not verified. A realistic
 * 25,000-message report is about 10 MB.
 */
import { abrirPrazo } from '@delfrance/core/wire';
import { Gunzip } from 'fflate';

import { crc32, ehErroDoFflate } from './crc32';
import { AmazonDocumentoFeedError, type CodigoS3Amazon } from './errors';
import {
  CONTENT_TYPE_FEED_JSON,
  lerRelatorioProcessamentoListings,
  type RelatorioProcessamentoListings,
} from './feeds';
import { urlPreAssinadaAmazon } from './preAssinada';
import { PRAZO_AMAZON_MS } from './prazos';

/** The download's byte cap: the stream is cancelled past it. */
export const MAX_RELATORIO_FEED_BYTES = 20 * 1024 * 1024;

/** The inflated report's cap, checked on the gzip trailer before anything is inflated. */
export const MAX_RELATORIO_JSON_BYTES = 32 * 1024 * 1024;

/** How long a feed document URL lives once issued (the model: "expires after 5 minutes"). */
export const VALIDADE_URL_DOCUMENTO_FEED_MS = 5 * 60_000;

/** The most bytes of a 403 answer read for its `<Code>`. */
const MAX_RESPOSTA_S3_BYTES = 4 * 1024;

/** The one compression the model lists for a feed document. */
const COMPRESSAO_GZIP = 'GZIP';

/** A gzip member's smallest size: a 10-byte header and an 8-byte trailer. */
const MIN_GZIP_BYTES = 18;

/** The compressed bytes handed to the inflater at a time (module header, step 2). */
const FATIA_GZIP_BYTES = 16 * 1024;

/** `<Code>…</Code>` of an object-storage XML error answer. */
const CODIGO_S3 = /<Code>([A-Za-z]{1,64})<\/Code>/;

/** The two codes the closed set keeps (`CodigoS3Amazon`). */
const CODIGOS_S3_CONHECIDOS: ReadonlyMap<string, CodigoS3Amazon> = new Map<string, CodigoS3Amazon>([
  ['SignatureDoesNotMatch', 'SignatureDoesNotMatch'],
  ['AccessDenied', 'AccessDenied'],
]);

/* -------------------------------------------------------------------------- */
/*                                Shared steps                                */
/* -------------------------------------------------------------------------- */

/** The URL to request, or `'url-invalida'` (module header). */
function urlDoDocumento(url: unknown): string {
  const alvo = urlPreAssinadaAmazon(url);
  if (alvo === null) throw new AmazonDocumentoFeedError('url-invalida');
  return alvo;
}

/** A wiring bug, not a network failure: refused before the deadline opens. */
function exigirFetch(buscar: unknown, funcao: string): asserts buscar is typeof globalThis.fetch {
  if (typeof buscar !== 'function') {
    throw new TypeError(`${funcao}: a opção fetch é obrigatória.`);
  }
}

/**
 * Up to `limite` bytes of the body, chunk by chunk. With `cancelarAcima`, the
 * first chunk past the limit cancels the stream and is `'grande-demais'`;
 * without it, the read simply stops there (the 403 answer's `<Code>` read).
 */
async function lerCorpoLimitado(
  res: Response,
  limite: number,
  cancelarAcima: boolean,
): Promise<Uint8Array> {
  if (res.body === null) return new Uint8Array(0);
  const leitor = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    if (total + value.byteLength > limite) {
      await leitor.cancel();
      if (cancelarAcima) throw new AmazonDocumentoFeedError('grande-demais');
      partes.push(value.subarray(0, limite - total));
      total = limite;
      break;
    }
    total += value.byteLength;
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

/** The closed `codigoS3` of a 403 answer, from at most 4 KiB of its body. */
async function codigoS3DaResposta(res: Response): Promise<CodigoS3Amazon> {
  const bytes = await lerCorpoLimitado(res, MAX_RESPOSTA_S3_BYTES, false);
  const achado = CODIGO_S3.exec(new TextDecoder().decode(bytes))?.[1];
  return (achado === undefined ? undefined : CODIGOS_S3_CONHECIDOS.get(achado)) ?? 'outro';
}

/**
 * One transfer inside one deadline, with the shared ladder (module header).
 * `ler` runs on the response INSIDE the deadline, so a body that stalls cannot
 * hang past it.
 */
async function transferir<T>(
  p: {
    readonly buscar: typeof globalThis.fetch;
    readonly url: string;
    readonly init: RequestInit;
    readonly prazoMs: number;
    readonly sinal: AbortSignal | undefined;
  },
  ler: (res: Response) => Promise<T>,
): Promise<T> {
  p.sinal?.throwIfAborted();
  const prazo = abrirPrazo(p.prazoMs, { vincular: p.sinal });
  try {
    const res = await p.buscar(p.url, { ...p.init, redirect: 'error', signal: prazo.signal });
    return await ler(res);
  } catch (err) {
    // Our own refusals (status, cap) keep their motivo.
    if (err instanceof AmazonDocumentoFeedError) throw err;
    // Asked of the deadline itself: `fetch` rejects with the signal's reason as-is.
    if (prazo.esgotado()) throw new AmazonDocumentoFeedError('prazo');
    // The caller's own cancel is theirs: rethrown as itself, never wrapped.
    if (p.sinal?.aborted === true) throw err;
    // DNS, TLS, a reset, a body dropped mid-stream, a refused redirect. No
    // `cause`: a platform error can name the host.
    if (err instanceof TypeError) throw new AmazonDocumentoFeedError('rede');
    throw err;
  } finally {
    prazo.liberar();
  }
}

/* -------------------------------------------------------------------------- */
/*                                 The upload                                 */
/* -------------------------------------------------------------------------- */

export interface OpcoesEnvioDocumentoFeed {
  /**
   * REQUIRED, never defaulted to the global: the app hands in the SAME `fetch`
   * its SP-API context uses, so one scripted `fetch` sees every request a test
   * makes (D11).
   */
  readonly fetch: typeof globalThis.fetch;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
  /** Our clock (ms) when `createFeedDocument` answered with this URL. */
  readonly emitidoEmMs: number;
  /** Milliseconds, read once a 403 arrives. Defaults to `Date.now`. */
  readonly agora?: () => number;
}

/**
 * Upload the feed document (module header, "The upload"). Resolves once the
 * object storage answered 2xx; the answer's body is discarded unread.
 */
export async function enviarDocumentoFeedAmazon(
  url: string,
  bytes: Uint8Array<ArrayBuffer>,
  opcoes: OpcoesEnvioDocumentoFeed,
): Promise<void> {
  const alvo = urlDoDocumento(url);
  const { fetch: buscar, sinal, emitidoEmMs } = opcoes;
  exigirFetch(buscar, 'enviarDocumentoFeedAmazon');
  const agora = opcoes.agora ?? (() => Date.now());

  await transferir(
    {
      buscar,
      url: alvo,
      init: { method: 'PUT', headers: { 'content-type': CONTENT_TYPE_FEED_JSON }, body: bytes },
      prazoMs: PRAZO_AMAZON_MS.upload,
      sinal,
    },
    async (res) => {
      if (res.status >= 200 && res.status <= 299) {
        await res.body?.cancel();
        return;
      }
      if (res.status === 403) {
        const codigoS3 = await codigoS3DaResposta(res);
        const expirou = agora() - emitidoEmMs >= VALIDADE_URL_DOCUMENTO_FEED_MS;
        throw new AmazonDocumentoFeedError(expirou ? 'expirado' : 'recusado', {
          status: res.status,
          codigoS3,
        });
      }
      await res.body?.cancel();
      throw new AmazonDocumentoFeedError('http', { status: res.status });
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                                The download                                */
/* -------------------------------------------------------------------------- */

export interface OpcoesDownloadRelatorioFeed {
  /** REQUIRED, never defaulted to the global (see {@link OpcoesEnvioDocumentoFeed.fetch}). */
  readonly fetch: typeof globalThis.fetch;
  /**
   * `getFeedDocument`'s `compressionAlgorithm`, as answered: `null` or absent
   * means uncompressed, `'GZIP'` means gzip, and any other value is
   * `'relatorio-invalido'` before anything is fetched.
   */
  readonly compressao: string | null | undefined;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

function u32(b: Uint8Array, i: number): number {
  return (
    ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0
  );
}

/**
 * The gzip report, inflated and VERIFIED (module header, "The download", step
 * 2): the ISIZE cap before anything is inflated, the inflation stopped at the
 * first slice whose output passes ISIZE, then the exact length and the CRC-32
 * against the trailer.
 */
function inflarVerificado(dados: Uint8Array): Uint8Array {
  if (dados.length < MIN_GZIP_BYTES) throw new AmazonDocumentoFeedError('gzip-invalido');
  const tamanho = u32(dados, dados.length - 4);
  const crcEsperado = u32(dados, dados.length - 8);
  if (tamanho > MAX_RELATORIO_JSON_BYTES) throw new AmazonDocumentoFeedError('grande-demais');

  const saida = new Uint8Array(tamanho);
  // Every inflated byte is counted; only the ones that fit are kept, so a
  // count past `tamanho` is the stop signal and, below, a length mismatch.
  let total = 0;
  const inflador = new Gunzip((parte) => {
    if (total + parte.length <= tamanho) saida.set(parte, total);
    total += parte.length;
  });
  try {
    for (let inicio = 0; inicio < dados.length && total <= tamanho; inicio += FATIA_GZIP_BYTES) {
      const fim = Math.min(inicio + FATIA_GZIP_BYTES, dados.length);
      inflador.push(dados.subarray(inicio, fim), fim === dados.length);
    }
  } catch (err) {
    // fflate's own error (a numeric `code`): a corrupt stream. Anything else is
    // not ours to rename.
    if (ehErroDoFflate(err)) throw new AmazonDocumentoFeedError('gzip-invalido');
    throw err;
  }
  if (total !== tamanho || crc32(saida) !== crcEsperado) {
    throw new AmazonDocumentoFeedError('gzip-invalido');
  }
  return saida;
}

/** Strict UTF-8: a malformed byte is `'json-invalido'` (JSON text is UTF-8). */
function decodificarUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    // The fatal decoder's own refusal of a malformed sequence.
    if (err instanceof TypeError) throw new AmazonDocumentoFeedError('json-invalido');
    throw err;
  }
}

/**
 * Download and read the processing report (module header, "The download").
 * Resolves with the parsed report.
 */
export async function baixarRelatorioFeedAmazon(
  url: string,
  opcoes: OpcoesDownloadRelatorioFeed,
): Promise<RelatorioProcessamentoListings> {
  const alvo = urlDoDocumento(url);
  const { fetch: buscar, compressao, sinal } = opcoes;
  exigirFetch(buscar, 'baixarRelatorioFeedAmazon');
  const gzip = compressao === COMPRESSAO_GZIP;
  if (!gzip && compressao !== null && compressao !== undefined) {
    throw new AmazonDocumentoFeedError('relatorio-invalido');
  }

  const corpo = await transferir(
    {
      buscar,
      url: alvo,
      init: { method: 'GET' },
      prazoMs: PRAZO_AMAZON_MS.documento,
      sinal,
    },
    async (res) => {
      if (res.status !== 200) {
        if (res.status === 403) {
          const codigoS3 = await codigoS3DaResposta(res);
          throw new AmazonDocumentoFeedError('expirado', { status: res.status, codigoS3 });
        }
        await res.body?.cancel();
        throw new AmazonDocumentoFeedError('http', { status: res.status });
      }
      return lerCorpoLimitado(res, MAX_RELATORIO_FEED_BYTES, true);
    },
  );

  const texto = decodificarUtf8(gzip ? inflarVerificado(corpo) : corpo);
  return lerRelatorioProcessamentoListings(texto);
}
