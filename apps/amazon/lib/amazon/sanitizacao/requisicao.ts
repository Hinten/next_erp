/**
 * The request sidecar of a capture (`<nome>.txt`): its grammar, read offline.
 *
 * ```
 * GET /orders/2026-01-01/orders/000-0000000-0000000?includedData=BUYER 200   ← or with the origin
 * credencial: token-legado-curl            ← required, closed set, no default
 * papeis: dtc,tax-invoicing                ← required: the roles it was made under
 * data: 2026-10-20                         ← optional (absent: the body's mtime, UTC)
 * limite-taxa: 0.0167                      ← optional (the `x-amzn-RateLimit-Limit` seen)
 * ```
 *
 * or, for a notification, line 1 is `NOTIFICACAO ORDER_CHANGE sqs|pipe`.
 *
 * ⚠️ **Nothing of a refused line ever reaches output.** A sidecar typed by hand may
 * hold anything — an `x-amz-access-token:` line, a pre-signed URL — so a refusal
 * names a LINE NUMBER and a kind, and at most a query KEY when the key is a plain
 * identifier. `URL.canParse` gates every `new URL`, because an uncaught
 * `ERR_INVALID_URL` prints its input.
 *
 * Refused, besides any other line (a header):
 * - a host other than `sellingpartnerapi-na.amazon.com`, spelled exactly — LWA
 *   (`api.amazon.com`) is never captured, nor S3, CloudFront, Seller Central or
 *   any pre-signed host;
 * - a credential-shaped query key, and a query value that is itself a URL;
 * - a `segredo` path (the RDT, the client secret, any `/documents`), and a path
 *   whose template has no table yet (`sem-tabela`): it could never become a fixture;
 * - a method that is not the matched operation's own (`metodo-da-operacao`,
 *   {@link METODOS_DA_OPERACAO_AMAZON}): `GET /delivery/2022-07-01/invoice` would
 *   be redacted with `submitInvoice`'s table into a fixture of a request that
 *   cannot exist;
 * - `token-legado-curl` with anything but `GET`: a write endpoint is never curled.
 *
 * Pure: bytes in, a request or a list of refusals out.
 */
import { NOTIFICACAO_ORDER_CHANGE, classificarCaminho } from '../core/redacao';
import {
  CREDENCIAIS_CAPTURA_AMAZON,
  CREDENCIAIS_DE_DOCUMENTACAO_AMAZON,
  type CredencialCapturaAmazon,
  METODOS_CAPTURA_AMAZON,
  type MetodoCapturaAmazon,
  PAPEIS_CAPTURA_AMAZON,
  type PapelCapturaAmazon,
  TRANSPORTES_NOTIFICACAO_AMAZON,
  type TransporteNotificacaoAmazon,
} from '../fixtures/wireCorpus';

/** The ONLY origin a sidecar may name: the SP-API North America endpoint. */
export const ORIGEM_SP_API = 'https://sellingpartnerapi-na.amazon.com';

interface Comum {
  readonly credencial: CredencialCapturaAmazon;
  readonly papeis: readonly PapelCapturaAmazon[];
  /** The `data:` line (`AAAA-MM-DD`), or `null` when absent. */
  readonly data: string | null;
  readonly limiteTaxa: number | null;
}

/** A capture's request, as written (nothing redacted yet). */
export type RequisicaoCapturadaAmazon =
  | (Comum & {
      readonly tipo: 'http';
      readonly metodo: MetodoCapturaAmazon;
      /** The raw path, exactly as written; a trailing slash is kept. */
      readonly caminho: string;
      /** The DECODED query pairs, in order (what the client's own event carries). */
      readonly query: readonly (readonly [string, string])[];
      readonly status: number;
    })
  | (Comum & {
      readonly tipo: 'notificacao';
      readonly transporte: TransporteNotificacaoAmazon;
    });

export type TipoProblemaDoSidecar =
  | 'utf16'
  | 'utf8-invalido'
  | 'vazio'
  | 'linha-de-requisicao'
  | 'metodo'
  | 'status'
  | 'notificacao-desconhecida'
  | 'transporte'
  | 'url-com-fragmento'
  | 'url-invalida'
  | 'host'
  | 'caminho-inseguro'
  | 'caminho-nao-canonico'
  | 'credencial-na-url'
  | 'url-na-query'
  | 'segredo'
  | 'sem-tabela'
  | 'metodo-da-operacao'
  | 'curl-so-get'
  | 'credencial-desconhecida'
  | 'credencial-repetida'
  | 'sem-credencial'
  | 'papeis-invalidos'
  | 'papeis-repetidos'
  | 'sem-papeis'
  | 'papeis-incoerentes'
  | 'data-invalida'
  | 'data-repetida'
  | 'limite-taxa-invalido'
  | 'limite-taxa-repetido'
  | 'linha-nao-reconhecida';

export interface ProblemaDoSidecar {
  /** 1-based; `null` when the problem is the file as a whole. */
  readonly linha: number | null;
  readonly tipo: TipoProblemaDoSidecar;
  /** Only for `credencial-na-url` / `url-na-query`: the key, or `<chave>` when it is not an identifier. */
  readonly chave?: string;
}

export type LeituraDoSidecar =
  | { readonly ok: true; readonly requisicao: RequisicaoCapturadaAmazon }
  | { readonly ok: false; readonly problemas: readonly ProblemaDoSidecar[] };

/* -------------------------------------------------------------------------- */
/*                                  Encoding                                  */
/* -------------------------------------------------------------------------- */

export type LeituraUtf8 =
  | { readonly ok: true; readonly texto: string }
  | { readonly ok: false; readonly motivo: 'utf16' | 'utf8-invalido' };

/**
 * A capture file as text: UTF-8, its BOM stripped (UTF-8's only). Refused:
 * UTF-16 — a UTF-16 BOM (either order) or any NUL byte (UTF-16 text without a
 * BOM is full of them; no UTF-8 JSON or sidecar carries a raw one) — and bytes
 * that are not valid UTF-8 (a replacement character would hide what they were).
 */
export function decodificarUtf8(bytes: Uint8Array): LeituraUtf8 {
  const [a, b, c] = bytes;
  if ((a === 0xfe && b === 0xff) || (a === 0xff && b === 0xfe))
    return { ok: false, motivo: 'utf16' };
  if (bytes.includes(0)) return { ok: false, motivo: 'utf16' };
  const inicio = a === 0xef && b === 0xbb && c === 0xbf ? 3 : 0;
  try {
    return {
      ok: true,
      texto: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(inicio),
      ),
    };
  } catch (err) {
    // The fatal decoder's one failure: an invalid byte sequence.
    if (err instanceof TypeError) return { ok: false, motivo: 'utf8-invalido' };
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                                    URL                                     */
/* -------------------------------------------------------------------------- */

/**
 * A query key that names a credential refuses the pair (delete both files).
 * Wider than the redactor's: `signature|credential` catch the SigV4 query
 * (`X-Amz-Signature`, `X-Amz-Credential`) a pre-signed URL carries.
 */
export const CHAVE_DE_CREDENCIAL_NA_CAPTURA =
  /token|secret|signature|credential|security|x-amz-|spapi_oauth_code|^state$|selling_partner_id|access_token|refresh_token|client_secret|api_?key|senha|password|auth/i;
const CHAVE_IDENTIFICADOR = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Decoded the way the client builds its pairs, never throwing: `+` stays `+`
 * (a date offset), a malformed `%` is left as written.
 */
const decodificar = (bruto: string) =>
  new URLSearchParams(`v=${bruto.replaceAll('+', '%2B')}`).get('v') ?? '';

/** A value that is itself a URL (any scheme). */
const ehUrl = (v: string) => URL.canParse(v);

type LeituraDaUrl =
  | {
      readonly ok: true;
      readonly caminho: string;
      readonly query: readonly (readonly [string, string])[];
    }
  | { readonly ok: false; readonly problemas: readonly ProblemaDoSidecar[] };

function lerUrl(url: string): LeituraDaUrl {
  const falha = (tipo: TipoProblemaDoSidecar): LeituraDaUrl => ({
    ok: false,
    problemas: [{ linha: 1, tipo }],
  });
  if (url.includes('#')) return falha('url-com-fragmento');
  // The gate comes FIRST: `new URL` on an unparseable input throws an error that
  // prints the input.
  if (!URL.canParse(url, ORIGEM_SP_API)) return falha('url-invalida');
  const analisada = new URL(url, ORIGEM_SP_API);

  // Exactly the SP-API origin, spelled exactly (no userinfo, no port, no other
  // case or scheme), or a path that starts at `/`.
  let resto: string;
  if (url.startsWith(`${ORIGEM_SP_API}/`)) resto = url.slice(ORIGEM_SP_API.length);
  else if (url.startsWith('/') && !url.startsWith('//')) resto = url;
  else return falha('host');
  if (analisada.origin !== ORIGEM_SP_API) return falha('host');

  const interrogacao = resto.indexOf('?');
  const caminho = interrogacao === -1 ? resto : resto.slice(0, interrogacao);
  const query = interrogacao === -1 ? '' : resto.slice(interrogacao + 1);

  if (caminho.includes('..') || caminho.includes('\\') || /%5c/i.test(caminho)) {
    return falha('caminho-inseguro');
  }
  // The URL parser would have rewritten it (dot segments, percent-encoding):
  // what was captured is not what the path says.
  if (analisada.pathname !== caminho) return falha('caminho-nao-canonico');

  const problemas: ProblemaDoSidecar[] = [];
  const pares: (readonly [string, string])[] = [];
  for (const par of query === '' ? [] : query.split('&')) {
    const igual = par.indexOf('=');
    const brutaChave = igual === -1 ? par : par.slice(0, igual);
    const brutoValor = igual === -1 ? '' : par.slice(igual + 1);
    const chave = decodificar(brutaChave);
    const valor = decodificar(brutoValor);
    const rotulo = CHAVE_IDENTIFICADOR.test(brutaChave) ? brutaChave : '<chave>';
    if (
      CHAVE_DE_CREDENCIAL_NA_CAPTURA.test(brutaChave) ||
      CHAVE_DE_CREDENCIAL_NA_CAPTURA.test(chave)
    ) {
      problemas.push({ linha: 1, tipo: 'credencial-na-url', chave: rotulo });
    } else if (ehUrl(valor) || ehUrl(brutoValor)) {
      problemas.push({ linha: 1, tipo: 'url-na-query', chave: rotulo });
    }
    pares.push([chave, valor]);
  }
  return problemas.length > 0 ? { ok: false, problemas } : { ok: true, caminho, query: pares };
}

/* -------------------------------------------------------------------------- */
/*                                  Sidecar                                   */
/* -------------------------------------------------------------------------- */

const ehMetodo = (m: string): m is MetodoCapturaAmazon =>
  METODOS_CAPTURA_AMAZON.some((conhecido) => conhecido === m);
const ehCredencial = (c: string): c is CredencialCapturaAmazon =>
  CREDENCIAIS_CAPTURA_AMAZON.some((conhecida) => conhecida === c);
const ehPapel = (p: string): p is PapelCapturaAmazon =>
  PAPEIS_CAPTURA_AMAZON.some((conhecido) => conhecido === p);
const ehTransporte = (t: string): t is TransporteNotificacaoAmazon =>
  TRANSPORTES_NOTIFICACAO_AMAZON.some((conhecido) => conhecido === t);

const STATUS = /^\d{3}$/;
const LINHA_CREDENCIAL = /^credencial:[ \t]*(\S+)$/;
const LINHA_PAPEIS = /^papeis:[ \t]*(\S(?:.*\S)?)$/;
const LINHA_DATA = /^data:[ \t]*(\S+)$/;
const LINHA_LIMITE = /^limite-taxa:[ \t]*(\S+)$/;
const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL = /^\d{1,6}(?:\.\d{1,6})?$/;
/** Each path segment literally `documents`: a report or feed document is a secret, whatever the template. */
const SEGMENTO_DOCUMENTOS = /(?:^|\/)documents(?:\/|$)/;

/**
 * The methods a capture of each templated operation may name: the template's
 * name (`classificarCaminho(…).modelo`) → the methods Amazon's model declares on
 * that path WHOSE ANSWER the template's table describes. The ONE source of the
 * pairing; only a template with a body table can become a fixture (`sem-tabela`
 * refuses the rest), so exactly those are listed, and `requisicao.test.ts` pins
 * the key set against the redactor's templates and every row against the
 * models' operations. A template without a row refuses every method.
 *
 * `/easyShip/2022-03-23/package` serves `GET` getScheduledPackage and `POST`
 * createScheduledPackage, which answer the same `Package`; its `PATCH`
 * (updateScheduledPackages) answers `Packages`, a shape the table does not
 * describe, so it is refused.
 */
export const METODOS_DA_OPERACAO_AMAZON: Readonly<Record<string, readonly MetodoCapturaAmazon[]>> =
  {
    // orders_2026-01-01
    searchOrders: ['GET'],
    getOrder: ['GET'],
    // deliveryShipmentInvoiceV2022-07-01
    submitInvoice: ['POST'],
    getInvoiceStatus: ['GET'],
    // easyShip_2022-03-23
    getScheduledPackage: ['GET', 'POST'],
    createScheduledPackageBulk: ['POST'],
  };

/** Whether `metodo` is one the operation of template `modelo` is captured under. */
export function metodoDaOperacaoAmazon(
  modelo: string | null,
  metodo: MetodoCapturaAmazon,
): boolean {
  if (modelo === null || !Object.hasOwn(METODOS_DA_OPERACAO_AMAZON, modelo)) return false;
  return (METODOS_DA_OPERACAO_AMAZON[modelo] ?? []).includes(metodo);
}

/** A real calendar date, `AAAA-MM-DD`; checked in UTC, never a local-time getter. */
function ehDataValida(s: string): boolean {
  const m = DATA.exec(s);
  if (m === null) return false;
  const [, ano, mes, dia] = m;
  const ms = Date.UTC(Number(ano), Number(mes) - 1, Number(dia));
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

/** The `papeis:` list: known roles, none twice, `nenhum` / `nao-se-aplica` alone. */
function lerPapeis(lista: string): readonly PapelCapturaAmazon[] | TipoProblemaDoSidecar {
  const itens = lista.split(',').map((p) => p.trim());
  const papeis: PapelCapturaAmazon[] = [];
  for (const item of itens) {
    if (!ehPapel(item)) return 'papeis-invalidos';
    if (papeis.includes(item)) return 'papeis-repetidos';
    papeis.push(item);
  }
  const sozinho = papeis.some((p) => p === 'nenhum' || p === 'nao-se-aplica');
  return sozinho && papeis.length > 1 ? 'papeis-invalidos' : papeis;
}

interface LinhaUm {
  readonly problemas: ProblemaDoSidecar[];
  readonly http: {
    readonly metodo: MetodoCapturaAmazon;
    readonly caminho: string;
    readonly query: readonly (readonly [string, string])[];
    readonly status: number;
  } | null;
  readonly transporte: TransporteNotificacaoAmazon | null;
  /** What line 1 asked for, even when it is refused for another reason (`curl-so-get`). */
  readonly metodoLido: MetodoCapturaAmazon | 'NOTIFICACAO' | null;
}

function lerLinhaUm(linha: string): LinhaUm {
  const problemas: ProblemaDoSidecar[] = [];
  const tokens = linha.trim().split(/[ \t]+/);
  if (tokens.length !== 3) {
    return {
      problemas: [{ linha: 1, tipo: 'linha-de-requisicao' }],
      http: null,
      transporte: null,
      metodoLido: null,
    };
  }
  const [m = '', u = '', s = ''] = tokens;
  if (m === 'NOTIFICACAO') {
    if (u !== 'ORDER_CHANGE') problemas.push({ linha: 1, tipo: 'notificacao-desconhecida' });
    if (!ehTransporte(s)) problemas.push({ linha: 1, tipo: 'transporte' });
    return {
      problemas,
      http: null,
      transporte: problemas.length === 0 && ehTransporte(s) ? s : null,
      metodoLido: 'NOTIFICACAO',
    };
  }
  const metodo = ehMetodo(m) ? m : null;
  if (metodo === null) problemas.push({ linha: 1, tipo: 'metodo' });
  const numero = Number(s);
  const status = STATUS.test(s) && numero >= 100 && numero <= 599 ? numero : null;
  if (status === null) problemas.push({ linha: 1, tipo: 'status' });
  const url = lerUrl(u);
  if (!url.ok) {
    problemas.push(...url.problemas);
    return { problemas, http: null, transporte: null, metodoLido: metodo };
  }
  const classe = classificarCaminho(url.caminho);
  if (classe.politica === 'segredo' || SEGMENTO_DOCUMENTOS.test(url.caminho)) {
    problemas.push({ linha: 1, tipo: 'segredo' });
  } else if (classe.tabela === null) {
    problemas.push({ linha: 1, tipo: 'sem-tabela' });
  } else if (metodo !== null && !metodoDaOperacaoAmazon(classe.modelo, metodo)) {
    // The table is the operation's: another method's request would be redacted
    // with it, into a fixture of a request that cannot exist.
    problemas.push({ linha: 1, tipo: 'metodo-da-operacao' });
  }
  if (metodo === null || status === null || problemas.length > 0) {
    return { problemas, http: null, transporte: null, metodoLido: metodo };
  }
  return {
    problemas,
    http: { metodo, caminho: url.caminho, query: url.query, status },
    transporte: null,
    metodoLido: metodo,
  };
}

/**
 * Reads a sidecar. Every problem is collected (by line number), so one run shows
 * them all; the request exists only when there is none.
 */
export function lerSidecar(bytes: Uint8Array): LeituraDoSidecar {
  const decodificado = decodificarUtf8(bytes);
  if (!decodificado.ok) {
    return { ok: false, problemas: [{ linha: null, tipo: decodificado.motivo }] };
  }
  const linhas = decodificado.texto.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, ''));
  while (linhas.length > 0 && linhas[linhas.length - 1] === '') linhas.pop();
  if (linhas.length === 0) return { ok: false, problemas: [{ linha: null, tipo: 'vazio' }] };

  const um = lerLinhaUm(linhas[0] ?? '');
  const problemas: ProblemaDoSidecar[] = [...um.problemas];

  let credencial: CredencialCapturaAmazon | null = null;
  let papeis: readonly PapelCapturaAmazon[] | null = null;
  let data: string | null = null;
  let limiteTaxa: number | null = null;
  const vistas = new Map<string, number>();
  const repetida = (chave: string) => {
    const n = (vistas.get(chave) ?? 0) + 1;
    vistas.set(chave, n);
    return n > 1;
  };
  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i] ?? '';
    const numero = i + 1;
    const c = LINHA_CREDENCIAL.exec(linha);
    if (c !== null) {
      const valor = c[1] ?? '';
      if (repetida('credencial')) problemas.push({ linha: numero, tipo: 'credencial-repetida' });
      else if (ehCredencial(valor)) credencial = valor;
      else problemas.push({ linha: numero, tipo: 'credencial-desconhecida' });
      continue;
    }
    const p = LINHA_PAPEIS.exec(linha);
    if (p !== null) {
      const lidos = lerPapeis(p[1] ?? '');
      if (repetida('papeis')) problemas.push({ linha: numero, tipo: 'papeis-repetidos' });
      else if (typeof lidos === 'string') problemas.push({ linha: numero, tipo: lidos });
      else papeis = lidos;
      continue;
    }
    const d = LINHA_DATA.exec(linha);
    if (d !== null) {
      const valor = d[1] ?? '';
      if (repetida('data')) problemas.push({ linha: numero, tipo: 'data-repetida' });
      else if (ehDataValida(valor)) data = valor;
      else problemas.push({ linha: numero, tipo: 'data-invalida' });
      continue;
    }
    const l = LINHA_LIMITE.exec(linha);
    if (l !== null) {
      const valor = l[1] ?? '';
      if (repetida('limite')) problemas.push({ linha: numero, tipo: 'limite-taxa-repetido' });
      else if (DECIMAL.test(valor)) limiteTaxa = Number(valor);
      else problemas.push({ linha: numero, tipo: 'limite-taxa-invalido' });
      continue;
    }
    problemas.push({ linha: numero, tipo: 'linha-nao-reconhecida' });
  }
  if (!vistas.has('credencial')) problemas.push({ linha: null, tipo: 'sem-credencial' });
  if (!vistas.has('papeis')) problemas.push({ linha: null, tipo: 'sem-papeis' });

  // A document is made under no seller's roles, and a real capture always is.
  if (credencial !== null && papeis !== null) {
    const documento = CREDENCIAIS_DE_DOCUMENTACAO_AMAZON.has(credencial);
    if (documento !== papeis.includes('nao-se-aplica')) {
      problemas.push({ linha: null, tipo: 'papeis-incoerentes' });
    }
  }
  // The owner's curl only ever GETs: a write endpoint is never curled, and a
  // notification is never fetched.
  if (credencial === 'token-legado-curl' && um.metodoLido !== null && um.metodoLido !== 'GET') {
    problemas.push({ linha: 1, tipo: 'curl-so-get' });
  }

  if (problemas.length > 0 || credencial === null || papeis === null) {
    return { ok: false, problemas };
  }
  const comum: Comum = { credencial, papeis, data, limiteTaxa };
  if (um.http !== null) return { ok: true, requisicao: { ...comum, tipo: 'http', ...um.http } };
  if (um.transporte !== null) {
    return { ok: true, requisicao: { ...comum, tipo: 'notificacao', transporte: um.transporte } };
  }
  return { ok: false, problemas: [{ linha: 1, tipo: 'linha-de-requisicao' }] };
}

/** The path the redactor classifies a capture under. */
export function caminhoDoRedator(r: RequisicaoCapturadaAmazon): string {
  return r.tipo === 'http' ? r.caminho : NOTIFICACAO_ORDER_CHANGE;
}
