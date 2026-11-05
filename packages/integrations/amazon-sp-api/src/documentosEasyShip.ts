/**
 * The Easy Ship label document: the download of the zip behind the bulk
 * scheduling's `printableDocumentsUrl` (`easyShip.ts`), and the extraction of
 * its ONE ZPL label. Two pure-ish functions, both raising
 * `AmazonDocumentoEasyShipError` (`errors.ts`) with a closed `motivo`:
 *
 * - {@link baixarDocumentosEasyShip} — one header-free `GET` of the pre-signed
 *   object, bounded in time and size;
 * - {@link extrairEtiquetaZplEasyShip} — exactly one `.zpl`/`.zpl2` entry,
 *   inflated with fflate and VERIFIED against the zip's own central directory.
 *
 * This is the package's one request that is not an SP-API or LWA call. It goes
 * through neither client: no credential, no observer event, no `onChamada`, so
 * the URL (a bearer link to the buyer's label) can never reach an event or a
 * log line. Nothing here stores the URL, the zip or the label.
 *
 * ## The download
 *
 * 1. **The URL** must parse, be `https:`, carry no userinfo and no port, and
 *    name a host ending in `.amazonaws.com` (Amazon's object storage, where
 *    these documents have been observed in production). Anything else is
 *    `'url-invalida'` and nothing is fetched. The model's own example URL
 *    (`https://www.amazon.com/documents.zip`) is refused by this rule.
 * 2. **One request**: `fetch(url, { method: 'GET', redirect: 'error', signal })`.
 *    There is NO `headers` object at all — the pre-signed URL is its own
 *    credential, so nothing of ours (no `x-amz-access-token`) can ride along, and
 *    a redirect is an error rather than a hop to another host.
 * 3. **The deadline** is `PRAZO_AMAZON_MS.documento`; the body is read inside it.
 *    A cut download is `'prazo'`; the caller repeats the WHOLE label call, never
 *    the download alone (the URL may have expired).
 * 4. **The status**: 403 is `'expirado'` (an expired pre-signed URL is refused
 *    with 403), any other non-200 is `'http'`, each with its status.
 * 5. **The body** is read chunk by chunk with a running count; the first chunk
 *    past {@link MAX_ZIP_EASY_SHIP_BYTES} cancels the stream: `'grande-demais'`.
 * 6. **The signature**: the first four bytes must be `PK\x03\x04`, else
 *    `'nao-zip'` (an XML error page, an empty archive).
 * 7. **The network**: a `TypeError` from `fetch` or from the stream (a refused
 *    redirect included) is `'rede'`. The caller's own abort is rethrown as
 *    itself.
 *
 * ⚠️ `fetch` is a REQUIRED option, with no default: a forgotten injection must
 * fail to compile rather than send a real request from a test suite that does
 * not block the global one. One that slips past the type (a cast, a JS caller)
 * is a `TypeError` thrown before the deadline opens, never a retryable
 * `'rede'`.
 *
 * ## The extraction
 *
 * fflate's `unzipSync` verifies nothing: it inflates a deflated entry into a
 * buffer of the DECLARED size (a longer stream is silently truncated), copies a
 * stored entry by its declared COMPRESSED size, and checks no CRC. It also
 * inflates each entry its filter keeps AS SOON AS the filter keeps it, inside
 * the same walk. So:
 *
 * 1. **The structure first**: a minimal central-directory reader walks the same
 *    records fflate walks, BEFORE fflate does, refusing a zip64 marker, a record
 *    count that disagrees, a record past the buffer and a directory size that
 *    disagrees (`'zip-invalido'`). A malformed archive is therefore never
 *    reported as `'sem-zpl'` or `'zpl-multiplo'` because the walk could not see
 *    a record.
 * 2. **The filter** sees every entry before it is inflated, in
 *    central-directory order, and records the POSITION of the one it keeps.
 *    It counts every entry (`'entradas-demais'` past
 *    {@link MAX_ENTRADAS_ZIP_EASY_SHIP}), keeps only names ending in `.zpl` or
 *    `.zpl2` in any case, refuses a SECOND such entry on sight
 *    (`'zpl-multiplo'`: never "the first", since a zip with several labels has
 *    not been observed and picking one could print the wrong package; refused
 *    there, before fflate inflates it), and refuses a kept entry whose
 *    compressed OR original size passes {@link MAX_ZPL_EASY_SHIP_BYTES}
 *    (`'zpl-grande-demais'`) or whose method is neither stored (0) nor deflate
 *    (8) (`'zip-invalido'`).
 * 3. **A corrupt archive**: fflate's own error (a plain `Error` with a numeric
 *    `code`) becomes `'zip-invalido'`; the filter's own refusals pass through
 *    with their motivo, and any other exception is rethrown as itself.
 * 4. **The count**: no kept entry is `'sem-zpl'`.
 * 5. **The verification**: the kept entry's record is joined by POSITION,
 *    never by name. The inflated bytes must have the record's original size AND
 *    its CRC-32, else `'zip-invalido'`. The CRC-32 is a table here: the package
 *    imports no `node:` module, and its Node 22 floor predates `zlib.crc32`.
 * 6. **The content**: the bytes must hold `^XA` somewhere, and must not start
 *    (after an optional UTF-8 BOM and ASCII whitespace) with `%PDF-`, `PK` or
 *    `<`; else `'zpl-invalido'`. Nothing is required before `^XA`: ZPL may put
 *    `~` commands there.
 * 7. **The result** is the entry's bytes VERBATIM: never decoded, never
 *    re-encoded. A zip or a PDF is never returned.
 *
 * The caps are bomb bounds, not budgets: a label is a few kilobytes. They
 * bound MEMORY (at most one entry is inflated, into at most 1 MiB), not decode
 * TIME: fflate decodes the one kept deflate stream to its end and drops what
 * passes the declared size, so a crafted stream within the 1 MiB compressed cap
 * can cost seconds of synchronous CPU, and comes back as the declared prefix
 * when the record's CRC-32 was computed over that prefix.
 */
import { abrirPrazo } from '@delfrance/core/wire';
import { unzipSync, type UnzipFileInfo, type Unzipped } from 'fflate';

import { AmazonDocumentoEasyShipError } from './errors';
import { PRAZO_AMAZON_MS } from './prazos';

/** The download's byte cap: the stream is cancelled past it. */
export const MAX_ZIP_EASY_SHIP_BYTES = 5 * 1024 * 1024;

/** The most entries a label zip may hold (every entry counts, kept or not). */
export const MAX_ENTRADAS_ZIP_EASY_SHIP = 64;

/** The ZPL entry's cap, on its declared compressed AND original size. */
export const MAX_ZPL_EASY_SHIP_BYTES = 1024 * 1024;

/* -------------------------------------------------------------------------- */
/*                                The download                                */
/* -------------------------------------------------------------------------- */

export interface OpcoesDownloadEasyShip {
  /**
   * REQUIRED, never defaulted to the global: the app hands in the SAME `fetch`
   * its SP-API context uses, so one scripted `fetch` sees every request a test
   * makes (D11).
   */
  readonly fetch: typeof globalThis.fetch;
  /** The caller's cancellation; its abort is rethrown as itself. */
  readonly sinal?: AbortSignal;
}

/** The host suffix of Amazon's object storage, where the label documents live. */
const SUFIXO_HOST_DOCUMENTO = '.amazonaws.com';

/** `PK\x03\x04`: a zip's first local file header. */
const ASSINATURA_ZIP = [0x50, 0x4b, 0x03, 0x04] as const;

/** The URL to fetch, or `'url-invalida'` (module header, step 1). */
function urlDoDocumento(url: unknown): string {
  if (typeof url !== 'string') throw new AmazonDocumentoEasyShipError('url-invalida');
  let alvo: URL;
  try {
    alvo = new URL(url);
  } catch (err) {
    if (err instanceof TypeError) throw new AmazonDocumentoEasyShipError('url-invalida');
    throw err;
  }
  const valida =
    alvo.protocol === 'https:' &&
    alvo.username === '' &&
    alvo.password === '' &&
    alvo.port === '' &&
    alvo.hostname.toLowerCase().endsWith(SUFIXO_HOST_DOCUMENTO);
  if (!valida) throw new AmazonDocumentoEasyShipError('url-invalida');
  return alvo.href;
}

/** The body, chunk by chunk; the stream is cancelled the moment the total passes the cap. */
async function lerCorpoLimitado(res: Response): Promise<Uint8Array> {
  if (res.body === null) return new Uint8Array(0);
  const leitor = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ZIP_EASY_SHIP_BYTES) {
      await leitor.cancel();
      throw new AmazonDocumentoEasyShipError('grande-demais');
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

function ehZip(bytes: Uint8Array): boolean {
  return ASSINATURA_ZIP.every((b, i) => bytes[i] === b);
}

/**
 * Download the Easy Ship document zip (module header, "The download"). Resolves
 * with its bytes, which start with a zip signature and are at most
 * {@link MAX_ZIP_EASY_SHIP_BYTES} long.
 */
export async function baixarDocumentosEasyShip(
  url: string,
  opcoes: OpcoesDownloadEasyShip,
): Promise<Uint8Array> {
  const alvo = urlDoDocumento(url);
  const { fetch: buscar, sinal } = opcoes;
  // A missing `fetch` is a wiring bug, not a network failure: refused here,
  // outside the catch below, so it can never read as a retryable 'rede'.
  if (typeof buscar !== 'function') {
    throw new TypeError('baixarDocumentosEasyShip: a opção fetch é obrigatória.');
  }
  sinal?.throwIfAborted();

  const prazo = abrirPrazo(PRAZO_AMAZON_MS.documento, { vincular: sinal });
  try {
    const res = await buscar(alvo, { method: 'GET', redirect: 'error', signal: prazo.signal });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new AmazonDocumentoEasyShipError(res.status === 403 ? 'expirado' : 'http', {
        status: res.status,
      });
    }
    const bytes = await lerCorpoLimitado(res);
    if (!ehZip(bytes)) throw new AmazonDocumentoEasyShipError('nao-zip');
    return bytes;
  } catch (err) {
    // The same ladder as `enviar` in `transporte.ts`, in the same order
    // (deadline, caller abort, TypeError, rethrow), kept apart on purpose: no
    // headers, `redirect: 'error'`, a byte cap, no observer, its own error
    // class. A fix to one ladder belongs in the other.
    // Our own refusals (status, cap, signature) keep their motivo.
    if (err instanceof AmazonDocumentoEasyShipError) throw err;
    // Asked of the deadline itself: `fetch` rejects with the signal's reason as-is.
    if (prazo.esgotado()) throw new AmazonDocumentoEasyShipError('prazo');
    // The caller's own cancel is theirs: rethrown as itself, never wrapped.
    if (sinal?.aborted === true) throw err;
    // DNS, TLS, a reset, a body dropped mid-stream, a refused redirect. No
    // `cause`: a platform error can name the host.
    if (err instanceof TypeError) throw new AmazonDocumentoEasyShipError('rede');
    throw err;
  } finally {
    prazo.liberar();
  }
}

/* -------------------------------------------------------------------------- */
/*                                  CRC-32                                    */
/* -------------------------------------------------------------------------- */

/**
 * The CRC-32 (IEEE 802.3, reflected polynomial `0xEDB88320`) table, 256
 * entries, built on the FIRST label read, never at module load. The barrel
 * reaches every bundle that imports the package — the functions bundle
 * included, which reads no label — and esbuild keeps any top-level call it
 * cannot prove pure, so a module-level table would be built at every cold
 * start. A function nothing calls is dropped, with no annotation to trust.
 */
let tabelaCrc32: Uint32Array | null = null;

function obterTabelaCrc32(): Uint32Array {
  if (tabelaCrc32 !== null) return tabelaCrc32;
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  tabelaCrc32 = tabela;
  return tabela;
}

/**
 * The CRC-32 a zip records for an entry. Pinned by the standard check value:
 * `0xCBF43926` for the ASCII bytes `123456789`.
 *
 * ⚠️ INTERNAL: exported for the test, never from the barrel.
 */
export function crc32(bytes: Uint8Array): number {
  const tabela = obterTabelaCrc32();
  let c = 0xffffffff;
  for (const b of bytes) c = (tabela[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------------- */
/*                         The central-directory reader                       */
/* -------------------------------------------------------------------------- */

const ASSINATURA_FIM_DIRETORIO = 0x06054b50;
const ASSINATURA_REGISTRO_CENTRAL = 0x02014b50;
const ASSINATURA_LOCALIZADOR_ZIP64 = 0x07064b50;
/** The End-Of-Central-Directory record without its comment. */
const TAMANHO_FIM_DIRETORIO = 22;
/** A central-directory header without its name, extra field and comment. */
const TAMANHO_REGISTRO_CENTRAL = 46;
const MAX_COMENTARIO_ZIP = 0xffff;
/** The 16- and 32-bit sentinels that say "the real value is in a zip64 field". */
const SENTINELA_ZIP64_16 = 0xffff;
const SENTINELA_ZIP64_32 = 0xffffffff;

/** What the verification needs of one central-directory record. */
interface RegistroCentral {
  readonly crc: number;
  readonly tamanhoOriginal: number;
}

function u16(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}

function u32(b: Uint8Array, i: number): number {
  return (
    ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0
  );
}

function zipInvalido(): AmazonDocumentoEasyShipError {
  return new AmazonDocumentoEasyShipError('zip-invalido');
}

/**
 * Every central-directory record, in order — the same walk fflate makes: the
 * End-Of-Central-Directory record searched BACKWARD from the end (over a
 * comment of up to 65535 bytes), then `count` records from its offset, each
 * `46 + name + extra + comment` bytes long. Refused (`'zip-invalido'`): a zip64
 * marker (the zip64 locator, or a 0xFFFF/0xFFFFFFFF sentinel), a disk count
 * that disagrees with the total, a record that does not carry the record
 * signature or runs past the End-Of-Central-Directory record, and a walk that
 * does not end exactly at the declared directory size.
 */
function lerDiretorioCentral(zip: Uint8Array): readonly RegistroCentral[] {
  const limite = Math.max(0, zip.length - TAMANHO_FIM_DIRETORIO - MAX_COMENTARIO_ZIP);
  let fim = zip.length - TAMANHO_FIM_DIRETORIO;
  while (fim >= limite && u32(zip, fim) !== ASSINATURA_FIM_DIRETORIO) fim--;
  if (fim < limite) throw zipInvalido();

  const nesteDisco = u16(zip, fim + 8);
  const total = u16(zip, fim + 10);
  const tamanho = u32(zip, fim + 12);
  const inicio = u32(zip, fim + 16);
  const temLocalizador64 = fim >= 20 && u32(zip, fim - 20) === ASSINATURA_LOCALIZADOR_ZIP64;
  if (
    temLocalizador64 ||
    total === SENTINELA_ZIP64_16 ||
    tamanho === SENTINELA_ZIP64_32 ||
    inicio === SENTINELA_ZIP64_32 ||
    nesteDisco !== total
  ) {
    throw zipInvalido();
  }

  const registros: RegistroCentral[] = [];
  let o = inicio;
  for (let i = 0; i < total; i++) {
    if (o + TAMANHO_REGISTRO_CENTRAL > fim || u32(zip, o) !== ASSINATURA_REGISTRO_CENTRAL) {
      throw zipInvalido();
    }
    const comprimido = u32(zip, o + 20);
    const original = u32(zip, o + 24);
    const deslocamentoLocal = u32(zip, o + 42);
    if (
      comprimido === SENTINELA_ZIP64_32 ||
      original === SENTINELA_ZIP64_32 ||
      deslocamentoLocal === SENTINELA_ZIP64_32
    ) {
      throw zipInvalido();
    }
    const proximo =
      o + TAMANHO_REGISTRO_CENTRAL + u16(zip, o + 28) + u16(zip, o + 30) + u16(zip, o + 32);
    if (proximo > fim) throw zipInvalido();
    registros.push({ crc: u32(zip, o + 16), tamanhoOriginal: original });
    o = proximo;
  }
  if (o !== inicio + tamanho) throw zipInvalido();
  return registros;
}

/* -------------------------------------------------------------------------- */
/*                               The extraction                               */
/* -------------------------------------------------------------------------- */

/** The extensions of a ZPL label entry, compared in lower case. */
const EXTENSOES_ZPL = ['.zpl', '.zpl2'] as const;

/** Stored (0) and deflate (8): the two methods fflate inflates. */
const METODOS_ACEITOS: ReadonlySet<number> = new Set([0, 8]);

function ehNomeZpl(nome: string): boolean {
  const minusculo = nome.toLowerCase();
  return EXTENSOES_ZPL.some((ext) => minusculo.endsWith(ext));
}

/**
 * fflate's own error: a plain `Error` carrying a NUMERIC `code` (its error
 * table's index). `instanceof Error` alone would claim every exception, so the
 * code is what identifies it; our class (which has no numeric `code`) is
 * narrowed out before this is asked.
 */
function ehErroDoFflate(err: unknown): boolean {
  return err instanceof Error && typeof (err as { code?: unknown }).code === 'number';
}

const BOM_UTF8 = [0xef, 0xbb, 0xbf] as const;

/** Tab, LF, VT, FF, CR and space. */
const ESPACO_ASCII: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

/** Starts that are not a ZPL label: a PDF, a (nested) zip, markup. */
const INICIOS_PROIBIDOS: readonly (readonly number[])[] = [
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x50, 0x4b], // PK
  [0x3c], // <
];

function comecaCom(bytes: Uint8Array, posicao: number, prefixo: readonly number[]): boolean {
  return prefixo.every((b, i) => bytes[posicao + i] === b);
}

/** Raw-byte scan for the `^XA` block start (0x5E 0x58 0x41), anywhere. */
function contemInicioZpl(bytes: Uint8Array): boolean {
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0x5e && bytes[i + 1] === 0x58 && bytes[i + 2] === 0x41) return true;
  }
  return false;
}

/**
 * The label content rule (module header, "The extraction", step 6): `^XA`
 * anywhere (a raw byte scan), and no PDF, zip or markup start after an
 * optional BOM and ASCII whitespace.
 */
function pareceZpl(bytes: Uint8Array): boolean {
  let i = comecaCom(bytes, 0, BOM_UTF8) ? BOM_UTF8.length : 0;
  while (i < bytes.length && ESPACO_ASCII.has(bytes[i] ?? -1)) i++;
  if (INICIOS_PROIBIDOS.some((p) => comecaCom(bytes, i, p))) return false;
  return contemInicioZpl(bytes);
}

/**
 * The one ZPL label of an Easy Ship document zip, verbatim (module header, "The
 * extraction"). Raises `AmazonDocumentoEasyShipError` for every refusal.
 */
export function extrairEtiquetaZplEasyShip(zip: Uint8Array): Uint8Array {
  // The structure first (module header, "The extraction", step 1): a
  // malformed directory is 'zip-invalido' before fflate walks it, never a
  // 'sem-zpl' or 'zpl-multiplo' produced by a record its walk could not see.
  const registros = lerDiretorioCentral(zip);

  const posicoesMantidas: number[] = [];
  const nomesMantidos: string[] = [];
  let vistas = 0;

  const filtro = (entrada: UnzipFileInfo): boolean => {
    const posicao = vistas++;
    if (vistas > MAX_ENTRADAS_ZIP_EASY_SHIP) {
      throw new AmazonDocumentoEasyShipError('entradas-demais');
    }
    if (!ehNomeZpl(entrada.name)) return false;
    // A second label is refused HERE: `unzipSync` inflates each kept entry the
    // moment this returns true, so a count taken after it returns would come
    // only after every label had been inflated.
    if (posicoesMantidas.length > 0) throw new AmazonDocumentoEasyShipError('zpl-multiplo');
    if (entrada.size > MAX_ZPL_EASY_SHIP_BYTES || entrada.originalSize > MAX_ZPL_EASY_SHIP_BYTES) {
      throw new AmazonDocumentoEasyShipError('zpl-grande-demais');
    }
    if (!METODOS_ACEITOS.has(entrada.compression)) throw zipInvalido();
    posicoesMantidas.push(posicao);
    nomesMantidos.push(entrada.name);
    return true;
  };

  let arquivos: Unzipped;
  try {
    arquivos = unzipSync(zip, { filter: filtro });
  } catch (err) {
    // The filter's own refusals are thrown from inside `unzipSync`: they keep
    // their motivo, never rewritten to 'zip-invalido'.
    if (err instanceof AmazonDocumentoEasyShipError) throw err;
    if (ehErroDoFflate(err)) throw new AmazonDocumentoEasyShipError('zip-invalido');
    throw err;
  }

  const [posicao] = posicoesMantidas;
  const [nome] = nomesMantidos;
  if (posicao === undefined || nome === undefined) {
    throw new AmazonDocumentoEasyShipError('sem-zpl');
  }

  const etiqueta = arquivos[nome];
  const registro = registros[posicao];
  if (
    etiqueta === undefined ||
    registro === undefined ||
    etiqueta.length !== registro.tamanhoOriginal ||
    crc32(etiqueta) !== registro.crc
  ) {
    throw zipInvalido();
  }

  if (!pareceZpl(etiqueta)) throw new AmazonDocumentoEasyShipError('zpl-invalido');
  return etiqueta;
}
