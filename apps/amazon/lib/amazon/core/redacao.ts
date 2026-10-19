/**
 * Redaction of Amazon (SP-API) traffic: what of a request path, a query and a
 * response body may leave this process — on a log line (`log` profile), or in
 * a committed fixture (`fixture` profile; the fixtures are PUBLIC).
 *
 * **Pure and total.** No clock, no I/O, no environment, no `catch`. Totality is
 * by construction: `lerRespostaJson` narrows the parse error itself, the size
 * and the nesting are bounded BEFORE any parse (`profundidadeJson`), the walk
 * stops at {@link PROFUNDIDADE_MAXIMA_PERCURSO}, every pattern is linear, and a
 * `JSON.parse` result holds no bigint, function or cycle. Imports only `zod`
 * and `@delfrance/core/{wire,documents}` (`estrutura.test.ts` asserts it): the
 * logger, step 2b-b's capture sanitizer and step 3's functions bundle all
 * reach this file.
 *
 * ## Fail closed: everything is an ALLOW-list
 *
 * 1. **The path picks the policy** (`classificarCaminho`): a closed table of
 *    path TEMPLATES ({@link MODELOS_DE_CAMINHO_AMAZON}). `segredo` (the RDT,
 *    the application client secret, every report and feed `/documents`) is
 *    never excerpted and refused as a fixture; everything else — orders,
 *    `ORDER_CHANGE`, Easy Ship, Delivery, and ANY unknown path — is
 *    `estrutural`.
 * 2. **A 2xx JSON body** is walked with its template's table: only the
 *    spelled-out leaves keep their value, and only when it passes that leaf's
 *    predicate. A denied subtree, a denied key or a denied prefix wins at ANY
 *    depth, case-insensitively, and is walked leaf by leaf. Every other value is
 *    redacted; KEYS are kept, so a new Amazon field shows up in the log. A path
 *    without a table (or an unknown path) keeps keys only in the log and is
 *    refused as a fixture (`sem-tabela`).
 * 3. **A non-2xx JSON body** takes the error walk ({@link percorrerErro}) in
 *    both profiles: the structure, booleans, `null`, small safe integers, and a
 *    `code` only through the closed {@link CODIGOS_ERRO_AMAZON}. `message` and
 *    `details` never survive. LI's three review rounds on #1877 each broke a
 *    shape rule, so no code word, value shape or key is ever added "to see the
 *    error".
 * 4. **A body that is not a JSON object or array** keeps its form and byte
 *    count only. No Amazon class needs text, and a proxy page or an echo is
 *    where PII hides (§3 decision 8).
 *
 * ## The regex layer runs PER LEAF, on decoded strings (§3 decision 7)
 *
 * {@link mascararTexto} runs over every kept string as the walk reaches it,
 * after `JSON.parse` decoded it, BEFORE serialization — so a `@` cannot
 * hide an e-mail from it, and a leaf kept by an id predicate can skip the bare
 * check-digit pass ({@link ISENTOS_DE_DIGITOS}): about 1% of 14-digit order
 * item ids pass the CNPJ check by chance. Only Amazon-made ids are exempt: `sku`
 * and every other id a SELLER typed (`idDoVendedor`) are NOT.
 *
 * ## Mask first, cut second
 *
 * The `log` profile masks every leaf, serializes, and only THEN cuts to the
 * caller's byte cap (`cortarUtf8`): a value cut first leaves the tail of an
 * e-mail or a CPF that no pattern recognises.
 */
import { validateCNPJ, validateCPF } from '@delfrance/core/documents';
import { lerRespostaJson } from '@delfrance/core/wire';
import { z } from 'zod';

/** What a refused value becomes in the `log` profile. */
export const REDIGIDO = '<redacted>';
/** What a refused path segment becomes, in both profiles. */
export const SEGMENTO_REDIGIDO = '<seg>';
/** A seller id, in BOTH profiles: never a seller id in a log line or a fixture. */
export const SELLER_ID_REDIGIDO = '<sellerId>';
/** An error code outside {@link CODIGOS_ERRO_AMAZON}. */
export const CODIGO_OUTRO = '<outro>';

export type PoliticaCorpoAmazon = 'estrutural' | 'segredo';
export type PerfilRedacaoAmazon = 'log' | 'fixture';
/**
 * What a body was: an object or array walked (`json`), something else that is
 * not (`texto`), empty, over the parse cap (`grande`), or nested deeper than
 * {@link PROFUNDIDADE_MAXIMA_JSON} (`profundo`). Neither of the last two is
 * ever parsed.
 */
export type FormaCorpoAmazon = 'json' | 'texto' | 'vazio' | 'grande' | 'profundo';

/** A JSON value as this module emits it. */
export type ValorJsonAmazon =
  | null
  | boolean
  | number
  | string
  | readonly ValorJsonAmazon[]
  | { readonly [chave: string]: ValorJsonAmazon };

/**
 * The parse cap per profile. `log` runs inside a request; `fixture` runs on a
 * local machine over an owner's capture. A body over the cap is never parsed.
 */
export const LIMITE_ANALISE_BYTES = { log: 1024 * 1024, fixture: 32 * 1024 * 1024 } as const;

/** Nesting beyond this is never handed to `JSON.parse` (see `profundidadeJson`). */
export const PROFUNDIDADE_MAXIMA_JSON = 256;

/** The walker's own cap: anything deeper is redacted. */
export const PROFUNDIDADE_MAXIMA_PERCURSO = 32;

/* -------------------------------------------------------------------------- */
/*                               Error codes                                  */
/* -------------------------------------------------------------------------- */

/**
 * The `errors[].code` values a log line or a fixture may carry; anything else is
 * {@link CODIGO_OUTRO} (§3 decision 9). A real new code costs a one-line,
 * cited edit after it is first seen. `redacao.test.ts` asserts this set holds
 * every code the leaf inventory found in the in-scope models' examples.
 *
 * The citation of each, from the models cached by `amazon-doc.mjs`:
 *
 * - `InvalidInput` — orders 2026-01-01 `searchOrders`/`getOrder` 400 sandbox,
 *   and the Delivery, Easy Ship, Sellers and Notifications models.
 * - `Invalid Input` — ordersV0's examples (the spaced spelling the package's
 *   `types.ts` also names).
 * - `InvalidRequest` — tokens `createRestrictedDataToken` 400 sandbox.
 * - `EntityNotFound` — Delivery `getInvoiceStatus` sandbox.
 * - `ResourceNotFound` — Easy Ship sandbox.
 * - `Forbidden`, `DuplicateRequest`, `RateLimited`, `InternalFailure`,
 *   `ServiceUnavailable` — External Fulfillment returns `listReturns`
 *   403/409/429/500/503 sandbox (the package's own test fixtures).
 * - `Unauthorized` — every model's 403 description ("Access Denied,
 *   Unauthorized, Expired Token, or Invalid Signature").
 * - `NotFound`, `QuotaExceeded`, `RequestEntityTooLarge`,
 *   `UnsupportedMediaType` — the generic SP-API codes the step-2b plan names
 *   for 404, 429, 413 and 415; no cached model example shows them, so each is
 *   confirmed in the migration window (D11).
 */
export const CODIGOS_ERRO_AMAZON: ReadonlySet<string> = new Set([
  'InvalidInput',
  'Invalid Input',
  'InvalidRequest',
  'EntityNotFound',
  'ResourceNotFound',
  'Forbidden',
  'DuplicateRequest',
  'RateLimited',
  'InternalFailure',
  'ServiceUnavailable',
  'Unauthorized',
  'NotFound',
  'QuotaExceeded',
  'RequestEntityTooLarge',
  'UnsupportedMediaType',
]);

/** A code through the closed set: itself, or {@link CODIGO_OUTRO}. */
export function codigoDeErroSeguro(codigo: unknown): string {
  return typeof codigo === 'string' && CODIGOS_ERRO_AMAZON.has(codigo) ? codigo : CODIGO_OUTRO;
}

/* -------------------------------------------------------------------------- */
/*                                Predicates                                  */
/* -------------------------------------------------------------------------- */

export type NomePredicadoAmazon =
  | 'pedidoAmazon'
  | 'itemPedido'
  | 'asin'
  | 'sku'
  | 'idMarketplace'
  | 'idAplicacao'
  | 'uuid'
  | 'opaco'
  | 'idDoVendedor'
  | 'enumSnake'
  | 'enumCamel'
  | 'codigoRejeicao'
  | 'codigoErro'
  | 'unidade'
  | 'dataIso'
  | 'decimal'
  | 'moeda'
  | 'inteiro'
  | 'booleano'
  | 'rotulo'
  | 'chaveNfe'
  | 'rastreio'
  | 'uf';

const PEDIDO_AMAZON = /^\d{3}-\d{7}-\d{7}$/;
const ITEM_PEDIDO = /^[A-Za-z0-9]{1,32}$/;
const ASIN = /^[A-Z0-9]{10}$/;
const SKU = /^[\x21-\x7E]{1,40}$/;
const ID_MARKETPLACE = /^A[A-Z0-9]{9,15}$/;
const UUID_TEXTO = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ID_APLICACAO = new RegExp(`^amzn1\\.sp\\.solution\\.${UUID_TEXTO}$`);
const UUID = new RegExp(`^${UUID_TEXTO}$`, 'i');
const OPACO = /^[A-Za-z0-9+/=_-]{1,64}$/;
const ENUM_SNAKE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENUM_CAMEL = /^[A-Z][A-Za-z]{0,63}$/;
const CODIGO_REJEICAO = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const UNIDADE = /^[A-Za-z]{1,16}$/;
const DATA_ISO =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DECIMAL = /^-?\d{1,12}(?:\.\d{1,6})?$/;
const MOEDA = /^[A-Z]{3}$/;
const INTEIRO_TEXTO = /^-?\d{1,15}$/;
const ROTULO = /^[\p{L}\p{N} ._/-]{1,40}$/u;
const CHAVE_NFE = /^\d{44}$/;
const RASTREIO = /^[A-Za-z0-9-]{6,40}$/;
const UF = /^[A-Z]{2}$/;

const texto = (re: RegExp) => (v: unknown) => typeof v === 'string' && re.test(v);

const PREDICADOS: Readonly<Record<NomePredicadoAmazon, (v: unknown) => boolean>> = {
  pedidoAmazon: texto(PEDIDO_AMAZON),
  itemPedido: texto(ITEM_PEDIDO),
  asin: texto(ASIN),
  sku: texto(SKU),
  idMarketplace: texto(ID_MARKETPLACE),
  idAplicacao: texto(ID_APLICACAO),
  uuid: texto(UUID),
  opaco: texto(OPACO),
  // The `opaco` grammar, but a SELLER typed it: never exempt from the check digits.
  idDoVendedor: texto(OPACO),
  enumSnake: texto(ENUM_SNAKE),
  enumCamel: texto(ENUM_CAMEL),
  codigoRejeicao: texto(CODIGO_REJEICAO),
  codigoErro: (v) => typeof v === 'string' && CODIGOS_ERRO_AMAZON.has(v),
  unidade: texto(UNIDADE),
  dataIso: texto(DATA_ISO),
  decimal: (v) =>
    (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && DECIMAL.test(v)),
  moeda: texto(MOEDA),
  inteiro: (v) => Number.isSafeInteger(v) || (typeof v === 'string' && INTEIRO_TEXTO.test(v)),
  booleano: (v) => typeof v === 'boolean',
  rotulo: texto(ROTULO),
  chaveNfe: texto(CHAVE_NFE),
  rastreio: texto(RASTREIO),
  uf: texto(UF),
};

/**
 * A kept value that passed one of these skips the bare check-digit pass (the
 * always-on patterns still run): Amazon ids, quantities, money, dates and the
 * 44-digit chave are bare digits by nature, and masking them would blind the
 * log. Every other kept string still takes it — above all one a SELLER typed:
 * `sku`, and `idDoVendedor`: an order alias ("seller-defined order numbers",
 * orders 2026-01-01), a promotion id ("provided by the seller", ordersV0), a
 * package reference ("seller-supplied", ordersV0). `opaco` is for Amazon-made
 * ids only (an Easy Ship package or slot, a subscription, a shipment).
 */
export const ISENTOS_DE_DIGITOS: ReadonlySet<NomePredicadoAmazon> = new Set<NomePredicadoAmazon>([
  'pedidoAmazon',
  'itemPedido',
  'asin',
  'inteiro',
  'decimal',
  'dataIso',
  'chaveNfe',
  'uuid',
  'opaco',
  'idMarketplace',
  'idAplicacao',
]);

/** Whether `v` passes the named predicate. */
export function passaPredicadoAmazon(nome: NomePredicadoAmazon, v: unknown): boolean {
  return PREDICADOS[nome](v);
}

/* -------------------------------------------------------------------------- */
/*                     The regex layer ("second layer")                        */
/* -------------------------------------------------------------------------- */

export type TipoMascaraAmazon =
  | 'email'
  | 'cpf'
  | 'cnpj'
  | 'cnpj-raiz'
  | 'telefone'
  | 'cep'
  | 'token-lwa'
  | 'segredo-lwa'
  | 'chave-aws'
  | 'arn'
  | 'url'
  | 'blob';

const etiqueta = (tipo: TipoMascaraAmazon) => `<redacted:${tipo}>`;

/** An LWA access or refresh token (`Atza|…`, `Atzr|…`). */
const TOKEN_LWA = /(?<![A-Za-z0-9])Atz[a-z.]{0,8}\|[A-Za-z0-9._~+/=%-]*/g;
/** An LWA client secret. */
const SEGREDO_LWA = /amzn1\.oa2-cs\.v1\.[A-Za-z0-9]*/g;
/** AWS access key ids and IAM principal ids. */
const CHAVE_AWS =
  /(?<![A-Z0-9])(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|APKA|AGPA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Z0-9])/g;
/** An ARN that carries a 12-digit account. */
const ARN_COM_CONTA = /arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d{12}:[^\s"'<>,]*/g;
/** A base64/hex-ish blob of 120 characters or more: a token, a signature, a document. */
const BLOB = /[A-Za-z0-9+/=_-]{120,}/g;
const CPF_PONTUADO = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
/** Letter-aware: the alphanumeric CNPJ keeps two numeric check digits. */
const CNPJ_PONTUADO =
  /(?<![A-Za-z0-9])[A-Za-z0-9]{2}\.[A-Za-z0-9]{3}\.[A-Za-z0-9]{3}\/[A-Za-z0-9]{4}-\d{2}(?!\d)/g;
/** A punctuated CNPJ root (`00.000.000`), uppercase letters only — never `s3.aws.com`. */
const CNPJ_RAIZ_PONTUADO =
  /(?<![A-Za-z0-9.])[0-9A-Z]{2}\.[0-9A-Z]{3}\.[0-9A-Z]{3}(?![A-Za-z0-9]|\.\d)/g;
/**
 * The phone shapes, each anchored by a separator, a `+` or parentheses — a
 * BARE 10/11-digit run is never one (it looks exactly like an Amazon id):
 *
 * - `+55 11 98765-4321`, `+5511987654321`, `+55 (11) 98765-4321`;
 * - E.164 (`+` and 8 to 15 digits);
 * - the international form with separators (`+1 206 555 0100`);
 * - `(11) 98765-4321`;
 * - `11 98765 4321`, `11 98765-4321`;
 * - `98765-4321` (a hyphenated number without its area code).
 *
 * Every group is a fixed or bounded run between mandatory separators, so a
 * match is found or refused in bounded work per start: linear.
 */
const TELEFONES: readonly RegExp[] = [
  /(?<![\w+])\+55[ .-]?(?:\(\d{2}\)|\d{2})[ .-]?9?\d{4}[ .-]?\d{4}(?!\d)/g,
  /(?<![\w+])\+\d{8,15}(?!\d)/g,
  /(?<![\w+])\+\d{1,3}(?:[ .-]\d{1,5}){2,4}(?!\d)/g,
  /(?<![\w(])\(\d{2}\) ?9?\d{4}[ .-]?\d{4}(?!\d)/g,
  /(?<![\w.-])\d{2}[ .-]9?\d{4}[ .-]\d{4}(?![\w-])/g,
  /(?<![\d+-])9?\d{4}-\d{4}(?![\d-])/g,
];
const CEP = /(?<!\d)(?:\d{5}-\d{3}|\d{2}\.\d{3}-\d{3})(?!\d)/g;
/**
 * A CPF with ANY subset of its punctuation: bare (`00000000000`), canonical, and
 * the half-punctuated spellings a person types (`000000000-00`,
 * `000.000.000.00`, `000-000-000-00`, `000.000.00000`). Only with `digitos`, and
 * only when the check digits are valid.
 */
const CPF_DIGITOS = /(?<!\d)\d{3}[.-]?\d{3}[.-]?\d{3}[-./]?\d{2}(?!\d)/g;
const QUATORZE_DIGITOS = /(?<!\d)\d{14}(?!\d)/g;
const CNPJ_COM_LETRA =
  /(?<![A-Za-z0-9])(?=[A-Za-z0-9]{0,11}[A-Za-z])[A-Za-z0-9]{12}\d{2}(?![A-Za-z0-9])/g;
/**
 * A CNPJ (letter-aware) with only PART of its punctuation (`00000000/0000-00`,
 * `00.000.0000000-00`, …); the canonical one is always on, the bare ones are
 * {@link QUATORZE_DIGITOS} and {@link CNPJ_COM_LETRA}.
 */
const CNPJ_PONTUACAO_PARCIAL =
  /(?<![A-Za-z0-9])[A-Za-z0-9]{2}\.?[A-Za-z0-9]{3}\.?[A-Za-z0-9]{3}\/?[A-Za-z0-9]{4}-?\d{2}(?![A-Za-z0-9])/g;

const ehAlfaNum = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** A letter, mark or digit of ANY script (`andré`, `joão`, `exämple`); one unit per test. */
const LETRA_UNICODE = /^[\p{L}\p{M}\p{N}]$/u;
/**
 * A non-ASCII unit that can sit inside an address: a letter, mark or digit of
 * any script, or half of a surrogate pair (an astral letter — over-masking an
 * emoji beside an address is the safe side). Punctuation (`“`, `”`, `…`) never is.
 */
const ehLetraNaoAscii = (c: number) =>
  c >= 0x80 && ((c >= 0xd800 && c <= 0xdfff) || LETRA_UNICODE.test(String.fromCharCode(c)));
/** `[A-Za-z0-9._%+-]`, plus any non-ASCII letter. */
const ehLocalDeEmail = (c: number) =>
  ehAlfaNum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45 || ehLetraNaoAscii(c);
/** `[A-Za-z0-9.-]`, plus any non-ASCII letter (an IDN domain). */
const ehDominioDeEmail = (c: number) => ehAlfaNum(c) || c === 46 || c === 45 || ehLetraNaoAscii(c);
/** A top-level domain: letters of any script, or the punycode form of one. */
const TLD = /^(?:[\p{L}\p{M}]{2,}|xn--[A-Za-z0-9-]{2,})$/u;

/**
 * E-mail addresses, found by expanding around each `@` instead of a regex: a
 * leading `[…]+` class would backtrack quadratically over a long run with no
 * `@`, and this layer runs over up to 1 MiB of leaves. Each character is
 * scanned a bounded number of times: neither class contains `@`. Both classes
 * take letters of any script, so a non-ASCII address is masked WHOLE, never
 * from its last accented letter on.
 */
function mascararEmails(t: string): { texto: string; mascarados: number } {
  let saida = '';
  let desde = 0;
  let mascarados = 0;
  let arroba = t.indexOf('@');
  while (arroba !== -1) {
    let inicio = arroba;
    while (inicio > desde && ehLocalDeEmail(t.charCodeAt(inicio - 1))) inicio--;
    let fim = arroba + 1;
    while (fim < t.length && ehDominioDeEmail(t.charCodeAt(fim))) fim++;
    while (fim > arroba + 1 && (t.charCodeAt(fim - 1) === 46 || t.charCodeAt(fim - 1) === 45)) {
      fim--;
    }
    const dominio = t.slice(arroba + 1, fim);
    const ponto = dominio.lastIndexOf('.');
    if (inicio < arroba && ponto > 0 && TLD.test(dominio.slice(ponto + 1))) {
      saida += `${t.slice(desde, inicio)}${etiqueta('email')}`;
      desde = fim;
      mascarados += 1;
      arroba = t.indexOf('@', fim);
    } else {
      arroba = t.indexOf('@', arroba + 1);
    }
  }
  return { texto: saida + t.slice(desde), mascarados };
}

/** Where a URL ends: whitespace, a quote, `<`, `>` or a backtick. */
const ehFimDeUrl = (c: number) =>
  c <= 32 || c === 34 || c === 39 || c === 60 || c === 62 || c === 96;

/**
 * Any URL that carries a query (a pre-signed S3 link, a document URL, a
 * pagination link). Linear: after each `http(s)://` the scan jumps past the
 * whole URL, whether or not it was masked.
 */
function mascararUrls(t: string): { texto: string; mascarados: number } {
  const inicio = /https?:\/\//gi;
  let saida = '';
  let desde = 0;
  let mascarados = 0;
  for (let m = inicio.exec(t); m !== null; m = inicio.exec(t)) {
    let fim = m.index + m[0].length;
    while (fim < t.length && !ehFimDeUrl(t.charCodeAt(fim))) fim++;
    if (t.slice(m.index, fim).includes('?')) {
      saida += `${t.slice(desde, m.index)}${etiqueta('url')}`;
      desde = fim;
      mascarados += 1;
    }
    inicio.lastIndex = Math.max(fim, m.index + 1);
  }
  return { texto: saida + t.slice(desde), mascarados };
}

/**
 * The regex layer. Each hit becomes a tag (`<redacted:cpf>`, …) and is counted.
 *
 * - Always: LWA tokens and client secrets, AWS key and principal ids, ARNs that
 *   carry an account, any URL with a query, blobs of 120+ characters, e-mail,
 *   punctuated CPF, punctuated CNPJ (letter-aware), a punctuated CNPJ root, the
 *   phone shapes of {@link TELEFONES}, CEP `00000-000` / `00.000-000`.
 * - With `digitos`: an 11-digit CPF, bare or with any part of its punctuation
 *   (`000000000-00`, `000.000.000.00`, …), with valid check digits; a 14-digit
 *   or letter-bearing 14-character CNPJ, bare or partly punctuated
 *   (`00000000/0000-00`, …), with valid check digits (`validateCPF` /
 *   `validateCNPJ` on the candidate only).
 *
 * Deliberately never matched: a bare 8-digit CEP or CNPJ root, a bare 10/11
 * digit phone, a bare 10-digit VAT, a 12-digit AWS account id. They look
 * exactly like Amazon ids; the denied keys cover them in a body.
 */
export function mascararTexto(
  t: string,
  opts: { readonly digitos: boolean },
): { texto: string; mascarados: number } {
  let mascarados = 0;
  const trocar = (
    s: string,
    re: RegExp,
    tipo: TipoMascaraAmazon,
    aceita?: (m: string) => boolean,
  ) =>
    s.replace(re, (m) => {
      if (aceita !== undefined && !aceita(m)) return m;
      mascarados += 1;
      return etiqueta(tipo);
    });
  let s = t;
  s = trocar(s, TOKEN_LWA, 'token-lwa');
  s = trocar(s, SEGREDO_LWA, 'segredo-lwa');
  s = trocar(s, CHAVE_AWS, 'chave-aws');
  s = trocar(s, ARN_COM_CONTA, 'arn');
  const urls = mascararUrls(s);
  mascarados += urls.mascarados;
  s = trocar(urls.texto, BLOB, 'blob');
  const emails = mascararEmails(s);
  mascarados += emails.mascarados;
  s = emails.texto;
  s = trocar(s, CPF_PONTUADO, 'cpf');
  s = trocar(s, CNPJ_PONTUADO, 'cnpj');
  s = trocar(s, CNPJ_RAIZ_PONTUADO, 'cnpj-raiz');
  for (const re of TELEFONES) s = trocar(s, re, 'telefone');
  s = trocar(s, CEP, 'cep');
  if (opts.digitos) {
    s = trocar(s, QUATORZE_DIGITOS, 'cnpj', validateCNPJ);
    s = trocar(s, CNPJ_COM_LETRA, 'cnpj', validateCNPJ);
    s = trocar(s, CNPJ_PONTUACAO_PARCIAL, 'cnpj', validateCNPJ);
    s = trocar(s, CPF_DIGITOS, 'cpf', validateCPF);
  }
  return { texto: s, mascarados };
}

/* -------------------------------------------------------------------------- */
/*                         Bytes, cut, depth pre-scan                          */
/* -------------------------------------------------------------------------- */

const ehAlta = (c: number) => c >= 0xd800 && c <= 0xdbff;
const ehBaixa = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Bytes and UTF-16 units of the code point at `i` (a lone surrogate counts as U+FFFD). */
function pontoDeCodigo(t: string, i: number): { bytes: number; unidades: number } {
  const c = t.charCodeAt(i);
  if (c < 0x80) return { bytes: 1, unidades: 1 };
  if (c < 0x800) return { bytes: 2, unidades: 1 };
  if (ehAlta(c) && i + 1 < t.length && ehBaixa(t.charCodeAt(i + 1))) {
    return { bytes: 4, unidades: 2 };
  }
  return { bytes: 3, unidades: 1 };
}

/** The UTF-8 byte length of `t`. */
export function bytesUtf8(t: string): number {
  let bytes = 0;
  for (let i = 0; i < t.length; ) {
    const p = pontoDeCodigo(t, i);
    bytes += p.bytes;
    i += p.unidades;
  }
  return bytes;
}

/**
 * At most `maxBytes` UTF-8 bytes of `t`, cut on a code-point boundary.
 *
 * ⚠️ Always AFTER the regex layer, never before: masking a text that was cut
 * first leaves the tail of an e-mail or a CPF that no pattern recognises.
 */
export function cortarUtf8(t: string, maxBytes: number): { texto: string; truncado: boolean } {
  let bytes = 0;
  for (let i = 0; i < t.length; ) {
    const p = pontoDeCodigo(t, i);
    if (bytes + p.bytes > maxBytes) return { texto: t.slice(0, i), truncado: true };
    bytes += p.bytes;
    i += p.unidades;
  }
  return { texto: t, truncado: false };
}

/**
 * The deepest `[`/`{` nesting of `t`, counted outside JSON strings in one linear
 * pass, stopping as soon as it exceeds `limite`. A body nested deeper than
 * {@link PROFUNDIDADE_MAXIMA_JSON} is never parsed, so totality does not rest on
 * how this runtime's `JSON.parse` and `JSON.stringify` recurse.
 */
export function profundidadeJson(t: string, limite = PROFUNDIDADE_MAXIMA_JSON): number {
  let profundidade = 0;
  let maxima = 0;
  let emString = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (emString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) emString = false;
      continue;
    }
    if (c === 0x22) emString = true;
    else if (c === 0x5b || c === 0x7b) {
      profundidade += 1;
      if (profundidade > maxima) {
        maxima = profundidade;
        if (maxima > limite) return maxima;
      }
    } else if ((c === 0x5d || c === 0x7d) && profundidade > 0) profundidade -= 1;
  }
  return maxima;
}

/* -------------------------------------------------------------------------- */
/*                       Fixture fakes and the faker seam                      */
/* -------------------------------------------------------------------------- */

/**
 * What the `fixture` profile writes in place of a refused value of each kind,
 * chosen by KEY NAME only — so re-redaction gives the same bytes.
 */
export const FALSO_AMAZON = {
  texto: 'REDACTED',
  email: 'redacted@example.invalid',
  telefone: '+00 00 0000-0000',
  cep: '00000-000',
  url: 'https://redacted.invalid/',
} as const;

/**
 * Shape-preserving placeholders for a document under `taxRegistrationNumber` or
 * `acquirerId` (C1 exists to answer format questions: punctuation, 8 vs 14
 * digits). The CPF and CNPJ ones carry VALID check digits on purpose, so a
 * fixture keeps the real shape; the scanner skips them by EXACT equality
 * ({@link PLACEHOLDERS_FIXTURE_AMAZON}), never by prefix or containment.
 */
export const PLACEHOLDERS_DOCUMENTO_AMAZON = {
  cpfPontuado: '000.000.001-91',
  cpf11: '00000000191',
  cnpjPontuado: '11.222.333/0001-81',
  cnpj14: '11222333000181',
  cnpjRaiz8: '11222333',
  cnpjAlfanumericoPontuado: '12.ABC.345/01DE-35',
  cnpjAlfanumerico14: '12ABC34501DE35',
} as const;

/** Every fixed string the `fixture` profile writes: the scanner skips exactly these. */
export const PLACEHOLDERS_FIXTURE_AMAZON: ReadonlySet<string> = new Set<string>([
  ...Object.values(FALSO_AMAZON),
  ...Object.values(PLACEHOLDERS_DOCUMENTO_AMAZON),
]);

/** A document-shaped value → its placeholder; any other shape → as many zeros as it is long. */
export function placeholderDeDocumento(v: string): string {
  const p = PLACEHOLDERS_DOCUMENTO_AMAZON;
  if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(v)) return p.cpfPontuado;
  if (/^\d{11}$/.test(v)) return p.cpf11;
  if (/^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/.test(v)) return p.cnpjPontuado;
  if (/^[0-9A-Z]{2}\.[0-9A-Z]{3}\.[0-9A-Z]{3}\/[0-9A-Z]{4}-\d{2}$/.test(v)) {
    return p.cnpjAlfanumericoPontuado;
  }
  if (/^\d{14}$/.test(v)) return p.cnpj14;
  if (/^[0-9A-Z]{12}\d{2}$/.test(v)) return p.cnpjAlfanumerico14;
  if (/^\d{8}$/.test(v)) return p.cnpjRaiz8;
  return '0'.repeat(v.length);
}

/** The keys whose refused value keeps its document SHAPE in a fixture. */
const CHAVES_DE_DOCUMENTO: ReadonlySet<string> = new Set(['taxregistrationnumber', 'acquirerid']);

/** A fake of the same JSON type, derived from the key name only — so idempotent. */
function falso(chave: string | null, v: string | number | boolean): string | number | boolean {
  if (typeof v === 'boolean') return false;
  if (typeof v === 'number') return 0;
  const k = (chave ?? '').toLowerCase();
  if (CHAVES_DE_DOCUMENTO.has(k)) return placeholderDeDocumento(v);
  if (k.includes('email')) return FALSO_AMAZON.email;
  if (k.includes('phone')) return FALSO_AMAZON.telefone;
  if (k.includes('postal')) return FALSO_AMAZON.cep;
  if (k.includes('url')) return FALSO_AMAZON.url;
  return FALSO_AMAZON.texto;
}

/** The kinds of id a `soLog` leaf holds: the `log` profile keeps them, the `fixture` one fakes them. */
export type ClasseFalsaAmazon =
  | 'pedido'
  | 'itemPedido'
  | 'alias'
  | 'pacote'
  | 'asin'
  | 'sku'
  | 'rastreio'
  | 'chaveNfe'
  | 'slot'
  | 'promocao'
  | 'aplicacao'
  | 'assinatura'
  | 'notificacao'
  | 'mensagem'
  | 'remessa'
  /** The SQS record's `awsRegion`: it names where OUR queue lives, so it never reaches a public fixture. */
  | 'regiao';

/**
 * The caller's id faker (§3 decision 14): tests use a counter, 2b-b a keyed
 * hash. ⚠️ Contract: it MUST return `valor` unchanged when `valor` is already
 * one of its own fakes (a fixpoint) — that is what makes the `fixture` profile
 * idempotent — and it must be total.
 */
export type FalsificadorAmazon = (classe: ClasseFalsaAmazon, valor: string) => string;

/* -------------------------------------------------------------------------- */
/*                                  Tables                                    */
/* -------------------------------------------------------------------------- */

type Entradas = readonly (readonly [string, NomePredicadoAmazon])[];
type EntradasSoLog = readonly (readonly [string, NomePredicadoAmazon, ClasseFalsaAmazon])[];

/** One allow-list, as the walker reads it. */
export interface TabelaRedacaoAmazon {
  readonly nome: string;
  /** Leaf path → predicate: kept in both profiles. `*` stands for an array index only. */
  readonly permitidas: ReadonlyMap<string, NomePredicadoAmazon>;
  /** Leaves the models show that are redacted ON PURPOSE (not caught by a denied key). */
  readonly negadas: ReadonlySet<string>;
  /** Leaf path → predicate + class: kept in `log`, faked in `fixture`. */
  readonly soLog: ReadonlyMap<
    string,
    { readonly predicado: NomePredicadoAmazon; readonly classe: ClasseFalsaAmazon }
  >;
  /**
   * The ORDER_CHANGE wrapper: a record-level `body` holding a JSON STRING (the
   * SQS message body, as the Pipe delivers it) is parsed and walked with this
   * same table, never just regex-scanned.
   */
  readonly corpoAninhado: boolean;
}

function tabela(
  nome: string,
  permitidas: Entradas,
  negadas: readonly string[] = [],
  soLog: EntradasSoLog = [],
  corpoAninhado = false,
): TabelaRedacaoAmazon {
  return {
    nome,
    permitidas: new Map(permitidas),
    negadas: new Set(negadas),
    soLog: new Map(soLog.map(([c, predicado, classe]) => [c, { predicado, classe }] as const)),
    corpoAninhado,
  };
}

const sob = (prefixo: string, entradas: Entradas): Entradas =>
  entradas.map(([c, p]) => [`${prefixo}.${c}`, p] as const);
const sobSoLog = (prefixo: string, entradas: EntradasSoLog): EntradasSoLog =>
  entradas.map(([c, p, k]) => [`${prefixo}.${c}`, p, k] as const);
const sobCaminhos = (prefixo: string, caminhos: readonly string[]) =>
  caminhos.map((c) => `${prefixo}.${c}`);

const DINHEIRO = (prefixo: string): Entradas => [
  [`${prefixo}.amount`, 'decimal'],
  [`${prefixo}.currencyCode`, 'moeda'],
];
const JANELA = (prefixo: string): Entradas => [
  [`${prefixo}.earliestDateTime`, 'dataIso'],
  [`${prefixo}.latestDateTime`, 'dataIso'],
];

/** An `errors` list inside a 2xx (Delivery answers its 200 with one). */
const ERROS_2XX: Entradas = [['errors.*.code', 'codigoErro']];

/** One v2026-01-01 order, relative to its object (`order` / `orders.*`). */
const PEDIDO: Entradas = [
  ['createdTime', 'dataIso'],
  ['lastUpdatedTime', 'dataIso'],
  ['programs.*', 'enumSnake'],
  ['orderAliases.*.aliasType', 'enumSnake'],
  ['associatedOrders.*.associationType', 'enumSnake'],
  ['salesChannel.channelName', 'enumSnake'],
  ['salesChannel.marketplaceId', 'idMarketplace'],
  ['salesChannel.marketplaceName', 'rotulo'],
  ...DINHEIRO('proceeds.grandTotal'),
  ['proceeds.breakdowns.*.type', 'enumSnake'],
  ['proceeds.breakdowns.*.status', 'enumSnake'],
  ...DINHEIRO('proceeds.breakdowns.*.subtotal'),
  ['fulfillment.fulfillmentStatus', 'enumSnake'],
  ['fulfillment.fulfilledBy', 'enumSnake'],
  ['fulfillment.fulfillmentServiceLevel', 'enumSnake'],
  ...JANELA('fulfillment.shipByWindow'),
  ...JANELA('fulfillment.deliverByWindow'),
  ...JANELA('fulfillment.labelPrintingWindow'),
  ['fulfillment.promiseCalculationInputs.transitTime.dataSource', 'enumSnake'],
  ['tax.taxInvoicing.buyerInvoicePreference', 'enumSnake'],
  ['tax.taxInvoicing.invoiceStatus', 'enumSnake'],
  ['tax.taxRegistrations.*.entityType', 'enumSnake'],
  ['tax.taxRegistrations.*.taxRegistrationType', 'enumSnake'],
  ['tax.taxRegistrations.*.taxRegistrationAttributes.*.key', 'enumSnake'],
  ['payment.paymentExecutions.*.paymentMethod', 'enumCamel'],
  ...DINHEIRO('payment.paymentExecutions.*.paymentAmount'),
  ['payment.paymentExecutions.*.cardBrand', 'rotulo'],
  ['packages.*.createdTime', 'dataIso'],
  ['packages.*.shipTime', 'dataIso'],
  ['packages.*.carrier', 'rotulo'],
  ['packages.*.shippingService', 'rotulo'],
  ['packages.*.packageStatus.status', 'enumSnake'],
  ['packages.*.packageStatus.detailedStatus', 'enumSnake'],
  ['packages.*.packageItems.*.quantity', 'inteiro'],
  ['orderItems.*.quantityOrdered', 'inteiro'],
  ['orderItems.*.measurement.unit', 'unidade'],
  ['orderItems.*.measurement.value', 'decimal'],
  ['orderItems.*.programs.*', 'enumSnake'],
  ['orderItems.*.product.condition.conditionType', 'enumSnake'],
  ['orderItems.*.product.condition.conditionSubtype', 'enumSnake'],
  ...DINHEIRO('orderItems.*.product.price.unitPrice'),
  ['orderItems.*.product.price.priceDesignation', 'enumSnake'],
  ...DINHEIRO('orderItems.*.proceeds.proceedsTotal'),
  ['orderItems.*.proceeds.breakdowns.*.type', 'enumSnake'],
  ...DINHEIRO('orderItems.*.proceeds.breakdowns.*.subtotal'),
  ['orderItems.*.proceeds.breakdowns.*.detailedBreakdowns.*.subtype', 'enumSnake'],
  ...DINHEIRO('orderItems.*.proceeds.breakdowns.*.detailedBreakdowns.*.value'),
  ['orderItems.*.expense.pointsCost.pointsGranted.pointsNumber', 'inteiro'],
  ...DINHEIRO('orderItems.*.expense.pointsCost.pointsGranted.pointsMonetaryValue'),
  ['orderItems.*.cancellation.cancellationRequest.requester', 'enumSnake'],
  ['orderItems.*.cancellation.cancellationExecution.cancelledBy', 'enumSnake'],
  ['orderItems.*.fulfillment.quantityFulfilled', 'inteiro'],
  ['orderItems.*.fulfillment.quantityUnfulfilled', 'inteiro'],
  ['orderItems.*.fulfillment.packing.serialNumberRequirement.requirementType', 'enumSnake'],
  ['orderItems.*.fulfillment.picking.substitutionPreference.substitutionType', 'enumSnake'],
  [
    'orderItems.*.fulfillment.picking.substitutionPreference.substitutionOptions.*.quantityOrdered',
    'inteiro',
  ],
  [
    'orderItems.*.fulfillment.picking.substitutionPreference.substitutionOptions.*.measurement.unit',
    'unidade',
  ],
  [
    'orderItems.*.fulfillment.picking.substitutionPreference.substitutionOptions.*.measurement.value',
    'decimal',
  ],
  ...JANELA('orderItems.*.fulfillment.shipping.scheduledDeliveryWindow'),
  ['orderItems.*.fulfillment.shipping.shippingConstraints.cashOnDelivery', 'enumSnake'],
  ['orderItems.*.fulfillment.shipping.shippingConstraints.palletDelivery', 'enumSnake'],
  ['orderItems.*.fulfillment.shipping.shippingConstraints.recipientAgeVerification', 'enumSnake'],
  [
    'orderItems.*.fulfillment.shipping.shippingConstraints.recipientIdentityVerification',
    'enumSnake',
  ],
  ['orderItems.*.fulfillment.shipping.shippingConstraints.signatureConfirmation', 'enumSnake'],
  ['orderItems.*.associatedOrderItems.*.associationType', 'enumSnake'],
  ...DINHEIRO('orderItems.*.associatedOrderItems.*.purchasePrice'),
  ['orderItems.*.tax.taxCalculationBreakdowns.*.reportingScheme', 'enumSnake'],
  ['orderItems.*.tax.taxCollections.*.model', 'enumSnake'],
];

/** The ids of one order: kept in the log (§4.ii needs them), faked in a fixture. */
const PEDIDO_SO_LOG: EntradasSoLog = [
  ['orderId', 'pedidoAmazon', 'pedido'],
  ['orderAliases.*.aliasId', 'idDoVendedor', 'alias'],
  ['associatedOrders.*.orderId', 'pedidoAmazon', 'pedido'],
  ['orderItems.*.orderItemId', 'itemPedido', 'itemPedido'],
  ['orderItems.*.product.asin', 'asin', 'asin'],
  ['orderItems.*.product.sellerSku', 'sku', 'sku'],
  ['orderItems.*.promotion.breakdowns.*.promotionId', 'idDoVendedor', 'promocao'],
  [
    'orderItems.*.fulfillment.picking.substitutionPreference.substitutionOptions.*.asin',
    'asin',
    'asin',
  ],
  [
    'orderItems.*.fulfillment.picking.substitutionPreference.substitutionOptions.*.sellerSku',
    'sku',
    'sku',
  ],
  ['orderItems.*.associatedOrderItems.*.asin', 'asin', 'asin'],
  ['orderItems.*.associatedOrderItems.*.orderId', 'pedidoAmazon', 'pedido'],
  ['orderItems.*.associatedOrderItems.*.orderItemId', 'itemPedido', 'itemPedido'],
  ['packages.*.packageReferenceId', 'idDoVendedor', 'pacote'],
  ['packages.*.trackingNumber', 'rastreio', 'rastreio'],
  ['packages.*.packageItems.*.orderItemId', 'itemPedido', 'itemPedido'],
];

/**
 * Order leaves the model shows that are redacted on purpose, beyond the denied
 * keys: an FBA fulfillment-order id (no pre-cutover step reads one), and a
 * tax-registration attribute's VALUE (its key is an enum; the value may be a
 * state registration).
 */
const PEDIDO_NEGADAS: readonly string[] = [
  'fulfillmentOrders.*.fulfillmentOrderId',
  'tax.taxRegistrations.*.taxRegistrationAttributes.*.value',
];

/** One Easy Ship `Package`, relative to its object (the root / `scheduledPackages.*`). */
const PACOTE: Entradas = [
  ['packageTimeSlot.startTime', 'dataIso'],
  ['packageTimeSlot.endTime', 'dataIso'],
  ['packageTimeSlot.handoverMethod', 'enumSnake'],
  ['packageDimensions.length', 'decimal'],
  ['packageDimensions.width', 'decimal'],
  ['packageDimensions.height', 'decimal'],
  ['packageDimensions.unit', 'unidade'],
  ['packageWeight.value', 'decimal'],
  ['packageWeight.unit', 'unidade'],
  ['invoice.invoiceDate', 'dataIso'],
  ['packageStatus', 'enumCamel'],
];
const PACOTE_SO_LOG: EntradasSoLog = [
  ['scheduledPackageId.amazonOrderId', 'pedidoAmazon', 'pedido'],
  ['scheduledPackageId.packageId', 'opaco', 'pacote'],
  ['packageTimeSlot.slotId', 'opaco', 'slot'],
  ['packageItems.*.orderItemId', 'itemPedido', 'itemPedido'],
  ['trackingDetails.trackingId', 'rastreio', 'rastreio'],
];
/** A seller-defined dimension label and the seller's own invoice number. */
const PACOTE_NEGADAS: readonly string[] = ['packageDimensions.identifier', 'invoice.invoiceNumber'];

/** The `ORDER_CHANGE` notification, relative to its root. */
const P_OC = 'Payload.OrderChangeNotification';
const S_OC = `${P_OC}.Summary`;
const I_OC = `${S_OC}.OrderItems.*`;
const ORDER_CHANGE: Entradas = [
  ['NotificationVersion', 'decimal'],
  ['NotificationType', 'enumSnake'],
  ['PayloadVersion', 'decimal'],
  ['EventTime', 'dataIso'],
  ['NotificationMetadata.PublishTime', 'dataIso'],
  [`${P_OC}.NotificationLevel`, 'enumCamel'],
  [`${P_OC}.OrderChangeType`, 'enumCamel'],
  [`${P_OC}.OrderChangeTrigger.TimeOfOrderChange`, 'dataIso'],
  [`${S_OC}.MarketplaceId`, 'idMarketplace'],
  [`${S_OC}.OrderStatus`, 'enumCamel'],
  [`${S_OC}.PurchaseDate`, 'dataIso'],
  [`${S_OC}.FulfillmentType`, 'enumSnake'],
  [`${S_OC}.OrderType`, 'enumCamel'],
  [`${S_OC}.NumberOfItemsShipped`, 'inteiro'],
  [`${S_OC}.NumberOfItemsUnshipped`, 'inteiro'],
  [`${S_OC}.EarliestDeliveryDate`, 'dataIso'],
  [`${S_OC}.LatestDeliveryDate`, 'dataIso'],
  [`${S_OC}.EarliestShipDate`, 'dataIso'],
  [`${S_OC}.LatestShipDate`, 'dataIso'],
  [`${S_OC}.CancelNotifyDate`, 'dataIso'],
  [`${S_OC}.OrderPrograms.*`, 'enumCamel'],
  [`${S_OC}.ShippingPrograms.*`, 'enumCamel'],
  [`${S_OC}.EasyShipShipmentStatus`, 'enumCamel'],
  [`${S_OC}.ElectronicInvoiceStatus`, 'enumCamel'],
  [`${I_OC}.OrderItemStatus`, 'enumCamel'],
  [`${I_OC}.Quantity`, 'inteiro'],
  [`${I_OC}.QuantityShipped`, 'inteiro'],
  [`${I_OC}.IsBuyerRequestedCancel`, 'booleano'],
  [`${I_OC}.ItemEarliestDeliveryDate`, 'dataIso'],
  [`${I_OC}.ItemLatestDeliveryDate`, 'dataIso'],
];
const ORDER_CHANGE_SO_LOG: EntradasSoLog = [
  ['NotificationMetadata.ApplicationId', 'idAplicacao', 'aplicacao'],
  ['NotificationMetadata.SubscriptionId', 'opaco', 'assinatura'],
  ['NotificationMetadata.NotificationId', 'uuid', 'notificacao'],
  [`${P_OC}.AmazonOrderId`, 'pedidoAmazon', 'pedido'],
  [`${I_OC}.OrderItemId`, 'itemPedido', 'itemPedido'],
  [`${I_OC}.SellerSKU`, 'sku', 'sku'],
];
/** The seller's own supply-source (warehouse) id. */
const ORDER_CHANGE_NEGADAS: readonly string[] = [`${I_OC}.SupplySourceId`];

/**
 * The SQS record the Pipe delivers (one record, or a batch as an array), whose
 * `body` is the notification as a JSON STRING. Not in the notification schema:
 * the AWS envelope (`redacao.test.ts` names these as off-spec).
 */
const REGISTRO_SQS: Entradas = [
  ['attributes.ApproximateReceiveCount', 'inteiro'],
  ['attributes.SentTimestamp', 'inteiro'],
  ['attributes.ApproximateFirstReceiveTimestamp', 'inteiro'],
];
/**
 * `awsRegion` is where the project's own queue lives: useful in a log line, an
 * infrastructure identifier in a committed (public) fixture — so it is faked
 * there like an id.
 */
const REGISTRO_SQS_SO_LOG: EntradasSoLog = [
  ['messageId', 'uuid', 'mensagem'],
  ['awsRegion', 'rotulo', 'regiao'],
];
const REGISTRO_SQS_NEGADAS: readonly string[] = ['eventSource', 'attributes.AWSTraceHeader'];

export const TABELAS_AMAZON = {
  searchOrders: tabela(
    'searchOrders',
    [['createdBefore', 'dataIso'], ['lastUpdatedBefore', 'dataIso'], ...sob('orders.*', PEDIDO)],
    ['pagination.nextToken', ...sobCaminhos('orders.*', PEDIDO_NEGADAS)],
    sobSoLog('orders.*', PEDIDO_SO_LOG),
  ),
  getOrder: tabela(
    'getOrder',
    sob('order', PEDIDO),
    sobCaminhos('order', PEDIDO_NEGADAS),
    sobSoLog('order', PEDIDO_SO_LOG),
  ),
  getInvoiceStatus: tabela(
    'getInvoiceStatus',
    [
      ['invoiceStatus', 'enumCamel'],
      ['orderInvoicingStatus', 'enumCamel'],
      ['invoices.*.status', 'enumCamel'],
      ...ERROS_2XX,
    ],
    [],
    [
      ['amazonOrderId', 'pedidoAmazon', 'pedido'],
      ['amazonShipmentId', 'opaco', 'remessa'],
      ['invoices.*.id', 'chaveNfe', 'chaveNfe'],
    ],
  ),
  /** Its 200 is `{}`, or an `errors` list. */
  submitInvoice: tabela('submitInvoice', ERROS_2XX),
  getScheduledPackage: tabela('getScheduledPackage', PACOTE, PACOTE_NEGADAS, PACOTE_SO_LOG),
  createScheduledPackageBulk: tabela(
    'createScheduledPackageBulk',
    [...sob('scheduledPackages.*', PACOTE), ['rejectedOrders.*.error.code', 'codigoRejeicao']],
    sobCaminhos('scheduledPackages.*', PACOTE_NEGADAS),
    [
      ...sobSoLog('scheduledPackages.*', PACOTE_SO_LOG),
      ['rejectedOrders.*.amazonOrderId', 'pedidoAmazon', 'pedido'],
    ],
  ),
  orderChange: tabela(
    'OrderChangeNotification',
    [...ORDER_CHANGE, ...REGISTRO_SQS, ...sob('*', REGISTRO_SQS)],
    [...ORDER_CHANGE_NEGADAS, ...REGISTRO_SQS_NEGADAS, ...sobCaminhos('*', REGISTRO_SQS_NEGADAS)],
    [...ORDER_CHANGE_SO_LOG, ...REGISTRO_SQS_SO_LOG, ...sobSoLog('*', REGISTRO_SQS_SO_LOG)],
    true,
  ),
} as const satisfies Record<string, TabelaRedacaoAmazon>;

/* -------------------------------------------------------------------------- */
/*                         Denied subtrees and keys                            */
/* -------------------------------------------------------------------------- */

/** Walked leaf by leaf at any depth, whatever a table says: keys and lengths kept. */
export const SUBARVORES_NEGADAS_AMAZON: ReadonlySet<string> = new Set([
  'buyer',
  'recipient',
  'shipFromAddress',
  'taxRegistrationAddress',
  'internationalShipping',
  'customization',
  'deliveryPreference',
]);

/** Denied anywhere, in every walk, case-insensitively. */
export const CHAVES_NEGADAS_AMAZON: ReadonlySet<string> = new Set([
  'buyerName',
  'buyerEmail',
  'buyerCompanyName',
  'buyerPurchaseOrderNumber',
  'name',
  'companyName',
  'legalName',
  'taxRegistrationNumber',
  'acquirerId',
  'authorizationCode',
  'giftMessage',
  'conditionNote',
  'title',
  'customizedUrl',
  'serialNumbers',
  'orderItemSerialNumbers',
  'cancelReason',
  'iossNumber',
  'responsibleParty',
  'transparencyCodes',
  'packageIdentifier',
  'printableDocumentsUrl',
  'url',
  'restrictedDataToken',
  'invoiceContent',
  'receiptHandle',
  'eventSourceARN',
  'SenderId',
  'md5OfBody',
  'messageAttributes',
  'DestinationPostalCode',
  'ChangeReason',
  'otp',
  'returnReason',
  'message',
  'details',
]);

/**
 * Denied by prefix, case-insensitively. Deliberately NO `buyer` prefix: the
 * `buyer` subtree and every `buyer*` PII key are listed above, and the allowed
 * `tax.taxInvoicing.buyerInvoicePreference` must not collide with a prefix.
 */
export const PREFIXOS_NEGADOS_AMAZON: readonly string[] = [
  'address',
  'postal',
  'phone',
  'email',
  'street',
  'gift',
];

/** `SellerId` (ORDER_CHANGE): `<sellerId>` in both profiles, like the path slot. */
export const CHAVES_SELLER_ID_AMAZON: ReadonlySet<string> = new Set(['SellerId', 'sellerId']);

const minusculas = (conjunto: ReadonlySet<string>): ReadonlySet<string> =>
  new Set([...conjunto].map((k) => k.toLowerCase()));
const SUBARVORES_MINUSCULAS = minusculas(SUBARVORES_NEGADAS_AMAZON);
const CHAVES_MINUSCULAS = minusculas(CHAVES_NEGADAS_AMAZON);
const SELLER_ID_MINUSCULAS = minusculas(CHAVES_SELLER_ID_AMAZON);

/** Case-insensitive: `BuyerEmail`, `BUYEREMAIL` and `buyeremail` are all denied. */
export function chaveNegadaAmazon(k: string): boolean {
  const c = k.toLowerCase();
  return (
    SUBARVORES_MINUSCULAS.has(c) ||
    CHAVES_MINUSCULAS.has(c) ||
    PREFIXOS_NEGADOS_AMAZON.some((p) => c.startsWith(p))
  );
}

const chaveDeSellerId = (k: string) => SELLER_ID_MINUSCULAS.has(k.toLowerCase());

/* -------------------------------------------------------------------------- */
/*                       Path templates → policy, table                        */
/* -------------------------------------------------------------------------- */

/**
 * What a template slot holds, and so what each profile does with its value:
 *
 * - `pedido` (`{orderId}`): kept in `log`, faked in `fixture`;
 * - `sku` (`{sku}`): the DECODED segment is tested (predicate + the regex
 *   layer), the RAW substring is emitted in `log`; faked in `fixture`;
 * - `sellerId`: always {@link SELLER_ID_REDIGIDO}, in BOTH profiles;
 * - `digitos` (`{feedId}`, `{reportId}`, …) and `enum` (`{notificationType}`):
 *   kept in both;
 * - `opaco` (`{subscriptionId}`, …): kept in `log` only;
 * - `segredo` (`{reportDocumentId}`, …): never kept.
 */
export type SlotDeCaminhoAmazon =
  | 'pedido'
  | 'sku'
  | 'sellerId'
  | 'digitos'
  | 'enum'
  | 'opaco'
  | 'segredo';

export interface ModeloDeCaminhoAmazon {
  /** The operation (`operationId`) the template serves; tests address a template by it. */
  readonly nome: string;
  /** Literal segments and `{slot}`s, without the leading `/`. */
  readonly segmentos: readonly (string | { readonly slot: SlotDeCaminhoAmazon })[];
  readonly politica: PoliticaCorpoAmazon;
  /** `null`: keys only in the log, refused as a fixture (`sem-tabela`). */
  readonly tabela: TabelaRedacaoAmazon | null;
}

const slot = (s: SlotDeCaminhoAmazon) => ({ slot: s }) as const;

function modelo(
  nome: string,
  caminho: string,
  politica: PoliticaCorpoAmazon,
  t: TabelaRedacaoAmazon | null = null,
): ModeloDeCaminhoAmazon {
  const segmentos = caminho
    .split('/')
    .slice(1)
    .map((s) => {
      const m = /^\{([a-zA-Z]+):([a-zA-Z]+)\}$/.exec(s);
      return m === null ? s : slot(m[2] as SlotDeCaminhoAmazon);
    });
  return { nome, segmentos, politica, tabela: t };
}

/** The pseudo path the ORDER_CHANGE notification (raw, SQS or Pipe-wrapped) is redacted under. */
export const NOTIFICACAO_ORDER_CHANGE = 'notificacao:ORDER_CHANGE';

/**
 * Every operation of §4.26 and C1–C6, plus the Sellers, Tokens, Application
 * and Notifications paths and the LWA token endpoint. The PATH redactor needs
 * them all (a later write step's URL is logged by this code); body TABLES
 * exist only for the 2b set (§3 decision 6). A slot is `{name:kind}`.
 */
export const MODELOS_DE_CAMINHO_AMAZON: readonly ModeloDeCaminhoAmazon[] = [
  modelo('searchOrders', '/orders/2026-01-01/orders', 'estrutural', TABELAS_AMAZON.searchOrders),
  modelo(
    'getOrder',
    '/orders/2026-01-01/orders/{orderId:pedido}',
    'estrutural',
    TABELAS_AMAZON.getOrder,
  ),
  modelo(
    'submitInvoice',
    '/delivery/2022-07-01/invoice',
    'estrutural',
    TABELAS_AMAZON.submitInvoice,
  ),
  modelo(
    'getInvoiceStatus',
    '/delivery/2022-07-01/invoice/status',
    'estrutural',
    TABELAS_AMAZON.getInvoiceStatus,
  ),
  // GET getScheduledPackage; POST createScheduledPackage answers the same `Package`.
  modelo(
    'getScheduledPackage',
    '/easyShip/2022-03-23/package',
    'estrutural',
    TABELAS_AMAZON.getScheduledPackage,
  ),
  modelo(
    'createScheduledPackageBulk',
    '/easyShip/2022-03-23/packages/bulk',
    'estrutural',
    TABELAS_AMAZON.createScheduledPackageBulk,
  ),
  modelo('listHandoverSlots', '/easyShip/2022-03-23/timeSlot', 'estrutural'),
  modelo('createRestrictedDataToken', '/tokens/2021-03-01/restrictedDataToken', 'segredo'),
  modelo('rotateApplicationClientSecret', '/applications/2023-11-30/clientSecret', 'segredo'),
  modelo('getReports', '/reports/2021-06-30/reports', 'estrutural'),
  modelo('getReport', '/reports/2021-06-30/reports/{reportId:digitos}', 'estrutural'),
  modelo('getReportSchedules', '/reports/2021-06-30/schedules', 'estrutural'),
  modelo(
    'getReportSchedule',
    '/reports/2021-06-30/schedules/{reportScheduleId:digitos}',
    'estrutural',
  ),
  modelo(
    'getReportDocument',
    '/reports/2021-06-30/documents/{reportDocumentId:segredo}',
    'segredo',
  ),
  modelo('getFeeds', '/feeds/2021-06-30/feeds', 'estrutural'),
  modelo('getFeed', '/feeds/2021-06-30/feeds/{feedId:digitos}', 'estrutural'),
  modelo('createFeedDocument', '/feeds/2021-06-30/documents', 'segredo'),
  modelo('getFeedDocument', '/feeds/2021-06-30/documents/{feedDocumentId:segredo}', 'segredo'),
  modelo('searchListingsItems', '/listings/2021-08-01/items/{sellerId:sellerId}', 'estrutural'),
  modelo(
    'getListingsItem',
    '/listings/2021-08-01/items/{sellerId:sellerId}/{sku:sku}',
    'estrutural',
  ),
  modelo('getMarketplaceParticipations', '/sellers/v1/marketplaceParticipations', 'estrutural'),
  modelo('getAccount', '/sellers/v1/account', 'estrutural'),
  modelo(
    'getSubscription',
    '/notifications/v1/subscriptions/{notificationType:enum}',
    'estrutural',
  ),
  modelo(
    'getSubscriptionById',
    '/notifications/v1/subscriptions/{notificationType:enum}/{subscriptionId:opaco}',
    'estrutural',
  ),
  modelo('getDestinations', '/notifications/v1/destinations', 'estrutural'),
  modelo('getDestination', '/notifications/v1/destinations/{destinationId:opaco}', 'estrutural'),
  modelo('listReturns', '/externalFulfillment/2024-09-11/returns', 'estrutural'),
  modelo('getReturn', '/externalFulfillment/2024-09-11/returns/{returnId:opaco}', 'estrutural'),
  // LWA is excerpt-free through `destino` (log.ts); the template only names the path.
  modelo('lwaToken', '/auth/o2/token', 'segredo'),
];

/** The ORDER_CHANGE pseudo-template (no path; `classificarCaminho` matches the constant). */
const MODELO_ORDER_CHANGE: ModeloDeCaminhoAmazon = {
  nome: 'OrderChangeNotification',
  segmentos: [],
  politica: 'estrutural',
  tabela: TABELAS_AMAZON.orderChange,
};

/** Every template literal: the ONLY segments an unknown path keeps. */
const VOCABULARIO: ReadonlySet<string> = new Set(
  MODELOS_DE_CAMINHO_AMAZON.flatMap((m) =>
    m.segmentos.filter((s): s is string => typeof s === 'string'),
  ),
);
const VERSAO = /^\d{4}-\d{2}-\d{2}$/;

function modeloDoCaminho(caminho: string): ModeloDeCaminhoAmazon | null {
  if (caminho === NOTIFICACAO_ORDER_CHANGE) return MODELO_ORDER_CHANGE;
  if (!caminho.startsWith('/')) return null;
  const segmentos = caminho.split('/').slice(1);
  return (
    MODELOS_DE_CAMINHO_AMAZON.find(
      (m) =>
        m.segmentos.length === segmentos.length &&
        m.segmentos.every((s, i) =>
          typeof s === 'string' ? s === segmentos[i] : (segmentos[i] ?? '') !== '',
        ),
    ) ?? null
  );
}

/** The template a template NAME addresses (an `operationId`), or `null`. */
function modeloPorNome(nome: string): ModeloDeCaminhoAmazon | null {
  if (nome === MODELO_ORDER_CHANGE.nome) return MODELO_ORDER_CHANGE;
  return MODELOS_DE_CAMINHO_AMAZON.find((m) => m.nome === nome) ?? null;
}

export interface ClassificacaoDoCaminhoAmazon {
  readonly politica: PoliticaCorpoAmazon;
  /** The template's name, or `null` for an unknown path. */
  readonly modelo: string | null;
  readonly tabela: TabelaRedacaoAmazon | null;
}

/** The body policy and table of a request path. An unknown path is `estrutural`, with no table. */
export function classificarCaminho(caminho: string): ClassificacaoDoCaminhoAmazon {
  const m = modeloDoCaminho(caminho);
  if (m === null) return { politica: 'estrutural', modelo: null, tabela: null };
  return { politica: m.politica, modelo: m.nome, tabela: m.tabela };
}

/* -------------------------------------------------------------------------- */
/*                            Path and query redactor                          */
/* -------------------------------------------------------------------------- */

/**
 * Decoded the way a URL decoder reads a path segment, never throwing. The two
 * characters a form decoder treats specially are escaped first: `+` stays `+`,
 * and a literal `&` (which WHATWG URL keeps in a pathname) stays in the value —
 * unescaped, it would split the pair and TRUNCATE the value, so a slot would
 * test only the head of a segment and emit the raw tail.
 */
function decodificar(bruto: string): string {
  return (
    new URLSearchParams(`v=${bruto.replaceAll('+', '%2B').replaceAll('&', '%26')}`).get('v') ?? ''
  );
}

const LISTA_DE_MARKETPLACES = (v: string) => v.split(',').every((x) => ID_MARKETPLACE.test(x));
const LISTA_DE_ENUMS = (v: string) => v.split(',').every((x) => ENUM_SNAKE.test(x));

/** A query value the line may carry, and the fixture class that fakes it (when there is one). */
interface RegraDaQuery {
  readonly aceita: (v: string) => boolean;
  /** `fixture`: faked through the faker (`null`: kept as is, it is not identifying). */
  readonly classe: ClasseFalsaAmazon | null;
  /** `fixture` refuses the value outright (no faker class fits). */
  readonly soLog?: boolean;
}

/**
 * The query keys whose value may be logged. Any other key keeps its name (when
 * it is `[A-Za-z_]{1,32}`) and loses its value.
 */
const PREDICADO_DA_QUERY: ReadonlyMap<string, RegraDaQuery> = new Map<string, RegraDaQuery>([
  ['marketplaceIds', { aceita: LISTA_DE_MARKETPLACES, classe: null }],
  ['marketplaceId', { aceita: LISTA_DE_MARKETPLACES, classe: null }],
  ['includedData', { aceita: LISTA_DE_ENUMS, classe: null }],
  ['fulfillmentStatuses', { aceita: LISTA_DE_ENUMS, classe: null }],
  ['createdAfter', { aceita: (v) => DATA_ISO.test(v), classe: null }],
  ['createdBefore', { aceita: (v) => DATA_ISO.test(v), classe: null }],
  ['lastUpdatedAfter', { aceita: (v) => DATA_ISO.test(v), classe: null }],
  ['lastUpdatedBefore', { aceita: (v) => DATA_ISO.test(v), classe: null }],
  ['maxResultsPerPage', { aceita: (v) => /^\d{1,9}$/.test(v), classe: null }],
  ['orderId', { aceita: (v) => PEDIDO_AMAZON.test(v), classe: 'pedido' }],
  ['amazonOrderId', { aceita: (v) => PEDIDO_AMAZON.test(v), classe: 'pedido' }],
  ['shipmentId', { aceita: (v) => OPACO.test(v), classe: 'remessa' }],
  ['invoiceType', { aceita: (v) => ENUM_CAMEL.test(v), classe: null }],
  ['programType', { aceita: (v) => ENUM_CAMEL.test(v), classe: null }],
  ['invoiceId', { aceita: (v) => CHAVE_NFE.test(v), classe: 'chaveNfe' }],
]);

/** The query keys whose value may be logged ({@link PREDICADO_DA_QUERY}'s keys). */
export const CHAVES_DA_QUERY_AMAZON: ReadonlySet<string> = new Set(PREDICADO_DA_QUERY.keys());

/** Pagination cursors: never the value, only its length. */
const CHAVES_DE_PAGINACAO: ReadonlySet<string> = new Set(['nextToken', 'paginationToken']);

const CHAVE_DE_CREDENCIAL =
  /token|secret|signature|credential|security|x-amz-|spapi_oauth_code|^state$|access_token|refresh_token|client_secret|api_?key/i;

/**
 * A credential-shaped query key: its value is always refused. ⚠️ Belt and
 * braces TODAY — no key of {@link PREDICADO_DA_QUERY} is credential-shaped (a
 * test pins it), so every such key already loses its value as an unknown key.
 * The check is what still refuses one if a future table row allow-lists a key
 * like `sessionToken`: it runs BEFORE the allow-list.
 */
export function chaveDeCredencialAmazon(chave: string): boolean {
  return CHAVE_DE_CREDENCIAL.test(chave);
}

/** A query key name kept as is. */
const NOME_DE_CHAVE = /^[A-Za-z_]{1,32}$/;

export interface CaminhoRedigidoAmazon {
  /** The redacted path. */
  readonly caminho: string;
  /** `[chave, valor]`, in order, duplicates kept. */
  readonly query: readonly (readonly [string, string])[];
  /** `caminho?k=v&…`, as one string — what a line carries. */
  readonly texto: string;
  /** Segments the regex layer refused (a `{sku}` that is a document). */
  readonly mascarados: number;
}

export interface OpcoesDeRedacaoAmazon {
  /** `fixture` only: fakes a kept id. Without it, the `fixture` profile refuses the id. */
  readonly falsificador?: FalsificadorAmazon;
}

/**
 * Redacts a request: the path through its template (or the closed literal
 * vocabulary, for an unknown path) and the query through
 * {@link PREDICADO_DA_QUERY}. The raw query never survives a key outside it.
 * `query` is the client's DECODED pairs (the event's `query`). Total.
 */
export function redigirCaminhoEQuery(
  caminho: string,
  query: readonly (readonly [string, string])[],
  perfil: PerfilRedacaoAmazon,
  opcoes: OpcoesDeRedacaoAmazon = {},
): CaminhoRedigidoAmazon {
  let mascarados = 0;
  const falsificar = (classe: ClasseFalsaAmazon, v: string): string =>
    opcoes.falsificador === undefined ? SEGMENTO_REDIGIDO : opcoes.falsificador(classe, v);

  const m = modeloDoCaminho(caminho);
  let redigido: string;
  if (caminho === NOTIFICACAO_ORDER_CHANGE) {
    redigido = NOTIFICACAO_ORDER_CHANGE;
  } else if (!caminho.startsWith('/')) {
    redigido = SEGMENTO_REDIGIDO;
  } else {
    const segmentos = caminho.split('/').slice(1);
    const saida = segmentos.map((s, i) => {
      if (s === '') return s;
      const molde = m?.segmentos[i];
      if (molde === undefined) {
        return VOCABULARIO.has(s) || VERSAO.test(s) ? s : SEGMENTO_REDIGIDO;
      }
      if (typeof molde === 'string') return s;
      const valor = decodificar(s);
      switch (molde.slot) {
        case 'sellerId':
          return SELLER_ID_REDIGIDO;
        case 'pedido':
          if (!PEDIDO_AMAZON.test(valor)) return SEGMENTO_REDIGIDO;
          return perfil === 'log' ? s : falsificar('pedido', valor);
        case 'sku': {
          if (!SKU.test(valor)) return SEGMENTO_REDIGIDO;
          if (mascararTexto(valor, { digitos: true }).mascarados > 0) {
            mascarados += 1;
            return SEGMENTO_REDIGIDO;
          }
          return perfil === 'log' ? s : encodeURIComponent(falsificar('sku', valor));
        }
        case 'digitos':
          return /^\d{1,20}$/.test(valor) ? s : SEGMENTO_REDIGIDO;
        case 'enum':
          return ENUM_SNAKE.test(valor) ? s : SEGMENTO_REDIGIDO;
        case 'opaco':
          return perfil === 'log' && OPACO.test(valor) ? s : SEGMENTO_REDIGIDO;
        case 'segredo':
          return SEGMENTO_REDIGIDO;
      }
    });
    redigido = `/${saida.join('/')}`;
  }

  const pares = query.map(([chave, valor], i): readonly [string, string] => {
    const nome = NOME_DE_CHAVE.test(chave) ? chave : `chave_redigida_${String(i + 1)}`;
    if (CHAVES_DE_PAGINACAO.has(chave)) return [nome, `<token len=${String(valor.length)}>`];
    if (chaveDeCredencialAmazon(chave)) return [nome, REDIGIDO];
    const regra = PREDICADO_DA_QUERY.get(chave);
    if (regra === undefined || !regra.aceita(valor)) return [nome, REDIGIDO];
    if (perfil === 'log' || regra.classe === null) return [nome, valor];
    return [
      nome,
      opcoes.falsificador === undefined ? REDIGIDO : opcoes.falsificador(regra.classe, valor),
    ];
  });
  const texto =
    pares.length === 0 ? redigido : `${redigido}?${pares.map(([k, v]) => `${k}=${v}`).join('&')}`;
  return { caminho: redigido, query: pares, texto, mascarados };
}

/* -------------------------------------------------------------------------- */
/*                                  Walkers                                   */
/* -------------------------------------------------------------------------- */

interface Percurso {
  readonly perfil: PerfilRedacaoAmazon;
  readonly tabela: TabelaRedacaoAmazon | null;
  /** A non-2xx body: the error walk's key grammar applies. */
  readonly erro: boolean;
  readonly falsificador: FalsificadorAmazon | null;
  /** The parse cap of the profile: a nested `body` string obeys it too. */
  readonly limite: number;
  /** Inside a parsed nested `body`: it is never parsed again. */
  dentroDoCorpo: boolean;
  mascarados: number;
  /** Each distinct 2xx key through the regex layer, once per walk. */
  readonly chaves: Map<string, { readonly texto: string; readonly mascarados: number }>;
}

const ehObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An own property, even for `__proto__`, on a plain object. */
function definir(
  alvo: Record<string, ValorJsonAmazon>,
  chave: string,
  valor: ValorJsonAmazon,
): void {
  Object.defineProperty(alvo, chave, {
    value: valor,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** The key grammar of an ERROR body, in both profiles: the shape of a real field name. */
const CHAVE_DE_ERRO = /^[A-Za-z_]{1,32}$/;
/** The identifier grammar a key must match to survive the `fixture` profile. */
const CHAVE_CONFORME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Each key that fails `conforme` becomes `chave_redigida_<n>`, `n` its 1-based
 * position among its siblings (bumped past any sibling already holding that
 * name), so the result is deterministic and a re-run gives the same names.
 */
function nomesPosicionais(chaves: readonly string[], conforme: (k: string) => boolean): string[] {
  const aceitas = chaves.map(conforme);
  const usadas = new Set(chaves.filter((_k, i) => aceitas[i]));
  return chaves.map((k, i) => {
    if (aceitas[i]) return k;
    let n = i + 1;
    while (usadas.has(`chave_redigida_${String(n)}`)) n += chaves.length;
    const nome = `chave_redigida_${String(n)}`;
    usadas.add(nome);
    return nome;
  });
}

/**
 * A 2xx key through the regex layer (with the check-digit pass), memoised per
 * walk: a page repeats the same few keys in every order, and each pass is ~20
 * patterns. The cache holds only what this walk already emitted.
 */
function chaveMascarada(k: string, ctx: Percurso): { texto: string; mascarados: number } {
  const visto = ctx.chaves.get(k);
  if (visto !== undefined) return visto;
  const m = mascararTexto(k, { digitos: true });
  ctx.chaves.set(k, m);
  return m;
}

/**
 * The OUTPUT names of an object's keys: an error body takes {@link CHAVE_DE_ERRO}
 * (positional otherwise) in both profiles. A 2xx body's keys take the regex
 * layer in BOTH: `log` masks the hit in place; `fixture` keeps a key only when it
 * is an identifier ({@link CHAVE_CONFORME}) with no hit, else it is positional —
 * a committed fixture is never laxer than a log line, and each hit is counted.
 */
function nomesDeSaida(chaves: readonly string[], ctx: Percurso): string[] {
  if (ctx.erro) return nomesPosicionais(chaves, (k) => CHAVE_DE_ERRO.test(k));
  if (ctx.perfil === 'log') {
    return chaves.map((k) => {
      const m = chaveMascarada(k, ctx);
      ctx.mascarados += m.mascarados;
      return m.texto;
    });
  }
  return nomesPosicionais(chaves, (k) => {
    const m = chaveMascarada(k, ctx);
    ctx.mascarados += m.mascarados;
    return m.mascarados === 0 && CHAVE_CONFORME.test(k);
  });
}

/** A key that cannot be part of a table path (it would read as a path of its own). */
const segmento = (k: string) => (k === '' || k.includes('.') || k === '*' ? '<?>' : k);
const juntar = (caminho: string, k: string) => (caminho === '' ? k : `${caminho}.${k}`);

function substituto(
  v: string | number | boolean,
  chave: string | null,
  ctx: Percurso,
): ValorJsonAmazon {
  return ctx.perfil === 'log' ? REDIGIDO : falso(chave, v);
}

const fundoDemais = (ctx: Percurso): ValorJsonAmazon =>
  ctx.perfil === 'log' ? REDIGIDO : FALSO_AMAZON.texto;

function mapearObjeto(
  v: Record<string, unknown>,
  ctx: Percurso,
  filho: (chave: string, valor: unknown) => ValorJsonAmazon,
): ValorJsonAmazon {
  const chaves = Object.keys(v);
  const nomes = nomesDeSaida(chaves, ctx);
  const saida: Record<string, ValorJsonAmazon> = {};
  chaves.forEach((k, i) => {
    definir(saida, nomes[i] ?? REDIGIDO, filho(k, v[k]));
  });
  return saida;
}

const ehPrimitivo = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Every leaf refused, keys and array lengths kept; `null` and `''` carry nothing and stay. */
function percorrerNegado(
  v: unknown,
  chave: string | null,
  prof: number,
  ctx: Percurso,
): ValorJsonAmazon {
  if (prof > PROFUNDIDADE_MAXIMA_PERCURSO) return fundoDemais(ctx);
  if (Array.isArray(v)) return v.map((item) => percorrerNegado(item, chave, prof + 1, ctx));
  if (ehObjeto(v)) {
    return mapearObjeto(v, ctx, (k, filho) => percorrerNegado(filho, k, prof + 1, ctx));
  }
  if (v === null || v === '') return v;
  if (ehPrimitivo(v)) return substituto(v, chave, ctx);
  return fundoDemais(ctx);
}

/** A seller id at any depth: the placeholder (a structure under one is walked as denied). */
function sellerIdRedigido(v: unknown, chave: string, prof: number, ctx: Percurso): ValorJsonAmazon {
  if (v === null || v === '') return v;
  if (ehPrimitivo(v)) return SELLER_ID_REDIGIDO;
  return percorrerNegado(v, chave, prof, ctx);
}

/**
 * A kept string still passes the regex layer, in BOTH profiles: `log` masks the
 * hit in place; `fixture` fakes the whole value (a committed fixture is never
 * laxer than a log line) and counts the hit — a value the table keeps but the
 * profile had to fake is a FINDING for the sanitizer.
 */
function manter(
  v: string | number | boolean,
  predicado: NomePredicadoAmazon,
  chave: string | null,
  ctx: Percurso,
): ValorJsonAmazon {
  if (typeof v !== 'string') return v;
  const m = mascararTexto(v, { digitos: !ISENTOS_DE_DIGITOS.has(predicado) });
  ctx.mascarados += m.mascarados;
  if (ctx.perfil === 'log') return m.texto;
  return m.mascarados === 0 ? v : falso(chave, v);
}

function folha2xx(
  v: string | number | boolean | null,
  caminho: string,
  chave: string | null,
  ctx: Percurso,
): ValorJsonAmazon {
  if (v === null || v === '') return v;
  const t = ctx.tabela;
  if (t === null || t.negadas.has(caminho)) return substituto(v, chave, ctx);
  const soLog = t.soLog.get(caminho);
  if (soLog !== undefined) {
    if (!PREDICADOS[soLog.predicado](v)) return substituto(v, chave, ctx);
    if (ctx.perfil === 'log') return manter(v, soLog.predicado, chave, ctx);
    const valor = String(v);
    ctx.mascarados += mascararTexto(valor, {
      digitos: !ISENTOS_DE_DIGITOS.has(soLog.predicado),
    }).mascarados;
    return ctx.falsificador === null ? falso(chave, v) : ctx.falsificador(soLog.classe, valor);
  }
  const predicado = t.permitidas.get(caminho);
  if (predicado !== undefined && PREDICADOS[predicado](v)) return manter(v, predicado, chave, ctx);
  return substituto(v, chave, ctx);
}

/**
 * A record-level `body` holding the ORDER_CHANGE notification as a JSON STRING:
 * parsed (inside the profile's cap and the depth pre-scan) and walked with the
 * same table, then serialized back into a string. Anything else is refused.
 */
function corpoAninhado(texto: string, ctx: Percurso): ValorJsonAmazon {
  if (bytesUtf8(texto) > ctx.limite || profundidadeJson(texto) > PROFUNDIDADE_MAXIMA_JSON) {
    return substituto(texto, 'body', ctx);
  }
  const leitura = lerRespostaJson(texto, z.unknown());
  if (!leitura.ok || typeof leitura.data !== 'object' || leitura.data === null) {
    return substituto(texto, 'body', ctx);
  }
  ctx.dentroDoCorpo = true;
  const saida = percorrer2xx(leitura.data, '', null, 0, ctx);
  ctx.dentroDoCorpo = false;
  return JSON.stringify(saida);
}

/** The 2xx allow-list walk. */
function percorrer2xx(
  v: unknown,
  caminho: string,
  chave: string | null,
  prof: number,
  ctx: Percurso,
): ValorJsonAmazon {
  if (prof > PROFUNDIDADE_MAXIMA_PERCURSO) return fundoDemais(ctx);
  if (Array.isArray(v)) {
    return v.map((item) => percorrer2xx(item, juntar(caminho, '*'), chave, prof + 1, ctx));
  }
  if (ehObjeto(v)) {
    return mapearObjeto(v, ctx, (k, filho) => {
      if (chaveDeSellerId(k)) return sellerIdRedigido(filho, k, prof + 1, ctx);
      if (chaveNegadaAmazon(k)) return percorrerNegado(filho, k, prof + 1, ctx);
      if (
        ctx.tabela?.corpoAninhado === true &&
        !ctx.dentroDoCorpo &&
        (caminho === '' || caminho === '*') &&
        k.toLowerCase() === 'body' &&
        typeof filho === 'string'
      ) {
        return corpoAninhado(filho, ctx);
      }
      return percorrer2xx(filho, juntar(caminho, segmento(k)), k, prof + 1, ctx);
    });
  }
  if (v === null || ehPrimitivo(v)) return folha2xx(v, caminho, chave, ctx);
  return fundoDemais(ctx);
}

/**
 * The error walk (every non-2xx JSON body), the same rules in both profiles.
 * It keeps the STRUCTURE and guesses nothing about a value's shape:
 *
 * - booleans and `null` survive;
 * - a number survives only as a safe integer below 1e7 in magnitude (a CEP, a
 *   phone or a CPF written as a number is 8+ digits);
 * - a string survives only under a `code` key (exact, any case; an array
 *   inherits its key), and only through {@link CODIGOS_ERRO_AMAZON} —
 *   {@link CODIGO_OUTRO} otherwise;
 * - a key keeps its NAME only under {@link CHAVE_DE_ERRO};
 * - denied subtrees and keys apply, and take the same key rule.
 *
 * `message` and `details` never survive: they are denied keys AND strings.
 */
const NUMERO_MAXIMO_NO_ERRO = 1e7;

function percorrerErro(
  v: unknown,
  chave: string | null,
  prof: number,
  ctx: Percurso,
): ValorJsonAmazon {
  if (prof > PROFUNDIDADE_MAXIMA_PERCURSO) return fundoDemais(ctx);
  if (Array.isArray(v)) return v.map((item) => percorrerErro(item, chave, prof + 1, ctx));
  if (ehObjeto(v)) {
    return mapearObjeto(v, ctx, (k, filho) =>
      chaveNegadaAmazon(k) || chaveDeSellerId(k)
        ? percorrerNegado(filho, k, prof + 1, ctx)
        : percorrerErro(filho, k, prof + 1, ctx),
    );
  }
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v) && Math.abs(v) < NUMERO_MAXIMO_NO_ERRO) return v;
    return ctx.perfil === 'log' ? REDIGIDO : 0;
  }
  if (typeof v !== 'string') return fundoDemais(ctx);
  if (chave !== null && chave.toLowerCase() === 'code') return codigoDeErroSeguro(v);
  return ctx.perfil === 'log' ? REDIGIDO : FALSO_AMAZON.texto;
}

/* -------------------------------------------------------------------------- */
/*                                 redigirCorpo                                */
/* -------------------------------------------------------------------------- */

export interface EntradaCorpoAmazon {
  /** The REQUEST path (`/orders/2026-01-01/orders/…`, or {@link NOTIFICACAO_ORDER_CHANGE}); it picks the policy. */
  readonly caminho: string;
  /** `null` when there was no response at all. */
  readonly status: number | null;
  /** The response text; `null` when none was read. */
  readonly corpo: string | null;
}

/** What the `log` profile keeps of a body. */
export interface CorpoParaLogAmazon {
  readonly politica: PoliticaCorpoAmazon;
  /** `null` for a `segredo` path: nothing about the body is read. */
  readonly forma: FormaCorpoAmazon | null;
  /** The raw body's UTF-8 length; `null` when there was no body. */
  readonly bytes: number | null;
  /** The masked excerpt, cut LAST to the cap; `null` when nothing may be shown. */
  readonly trecho: string | null;
  readonly truncado: boolean;
  readonly mascarados: number;
}

export type MotivoRecusaFixtureAmazon =
  | 'sem-resposta'
  | 'segredo'
  | 'sem-tabela'
  | 'nao-json'
  | 'grande-demais'
  | 'profundo-demais';

/** What the `fixture` profile makes of a body, or why it refuses to. */
export type CorpoParaFixtureAmazon =
  | {
      readonly ok: true;
      readonly politica: 'estrutural';
      readonly forma: 'json' | 'vazio';
      readonly bytes: number;
      /** `null` for an empty body. */
      readonly corpo: ValorJsonAmazon;
      /** Values a table keeps that the regex layer refused (faked anyway): findings. */
      readonly mascarados: number;
    }
  | { readonly ok: false; readonly motivo: MotivoRecusaFixtureAmazon };

export interface OpcoesLogAmazon {
  /** The excerpt's cap in UTF-8 bytes, applied AFTER the walk and the regex layer. */
  readonly maxBytes: number;
}

export interface OpcoesFixtureAmazon {
  readonly falsificador: FalsificadorAmazon;
}

type Analise =
  | { readonly forma: 'vazio' | 'texto' | 'grande' | 'profundo' }
  | { readonly forma: 'json'; readonly valor: object };

/**
 * Empty → `vazio` BEFORE any parse. Over the cap → `grande`, nested deeper than
 * {@link PROFUNDIDADE_MAXIMA_JSON} → `profundo`: neither is parsed. A JSON
 * scalar is `texto`, like anything that is not JSON. ⚠️ A failed read's result
 * is never serialised: its `nao-json` arm carries the raw text.
 */
function analisar(t: string, limite: number): Analise {
  if (t.length === 0) return { forma: 'vazio' };
  if (bytesUtf8(t) > limite) return { forma: 'grande' };
  if (profundidadeJson(t) > PROFUNDIDADE_MAXIMA_JSON) return { forma: 'profundo' };
  const leitura = lerRespostaJson(t, z.unknown());
  if (!leitura.ok || typeof leitura.data !== 'object' || leitura.data === null) {
    return { forma: 'texto' };
  }
  return { forma: 'json', valor: leitura.data };
}

const ehSucesso = (status: number | null) => status !== null && status >= 200 && status <= 299;

function percurso(
  perfil: PerfilRedacaoAmazon,
  t: TabelaRedacaoAmazon | null,
  erro: boolean,
  falsificador: FalsificadorAmazon | null,
): Percurso {
  return {
    perfil,
    tabela: t,
    erro,
    falsificador,
    limite: LIMITE_ANALISE_BYTES[perfil],
    dentroDoCorpo: false,
    mascarados: 0,
    chaves: new Map(),
  };
}

function corpoParaLog(e: EntradaCorpoAmazon, o: OpcoesLogAmazon): CorpoParaLogAmazon {
  const { politica, tabela: t } = classificarCaminho(e.caminho);
  const bytes = e.corpo === null ? null : bytesUtf8(e.corpo);
  const nada = (forma: FormaCorpoAmazon | null): CorpoParaLogAmazon => ({
    politica,
    forma,
    bytes,
    trecho: null,
    truncado: false,
    mascarados: 0,
  });
  // The RDT, the client secret, every `/documents`: nothing of the body is read.
  if (politica === 'segredo') return nada(null);
  if (e.corpo === null) return nada('vazio');
  const analise = analisar(e.corpo, LIMITE_ANALISE_BYTES.log);
  if (analise.forma !== 'json') return nada(analise.forma);
  const sucesso = ehSucesso(e.status);
  const ctx = percurso('log', t, !sucesso, null);
  const saida = sucesso
    ? percorrer2xx(analise.valor, '', null, 0, ctx)
    : percorrerErro(analise.valor, null, 0, ctx);
  // Mask first (each leaf, above), cut second.
  const corte = cortarUtf8(JSON.stringify(saida), o.maxBytes);
  return {
    politica,
    forma: 'json',
    bytes,
    trecho: corte.texto,
    truncado: corte.truncado,
    mascarados: ctx.mascarados,
  };
}

function corpoParaFixture(e: EntradaCorpoAmazon, o: OpcoesFixtureAmazon): CorpoParaFixtureAmazon {
  const { politica, tabela: t } = classificarCaminho(e.caminho);
  const recusa = (motivo: MotivoRecusaFixtureAmazon): CorpoParaFixtureAmazon => ({
    ok: false,
    motivo,
  });
  if (e.status === null || e.corpo === null) return recusa('sem-resposta');
  if (politica === 'segredo') return recusa('segredo');
  if (t === null) return recusa('sem-tabela');
  const analise = analisar(e.corpo, LIMITE_ANALISE_BYTES.fixture);
  const bytes = bytesUtf8(e.corpo);
  switch (analise.forma) {
    case 'vazio':
      return { ok: true, politica, forma: 'vazio', bytes, corpo: null, mascarados: 0 };
    case 'grande':
      return recusa('grande-demais');
    case 'profundo':
      return recusa('profundo-demais');
    case 'texto':
      return recusa('nao-json');
    case 'json': {
      const sucesso = ehSucesso(e.status);
      const ctx = percurso('fixture', t, !sucesso, o.falsificador);
      const corpo = sucesso
        ? percorrer2xx(analise.valor, '', null, 0, ctx)
        : percorrerErro(analise.valor, null, 0, ctx);
      return { ok: true, politica, forma: 'json', bytes, corpo, mascarados: ctx.mascarados };
    }
  }
}

/**
 * A response body through the policy of its request path, in one profile.
 *
 * | case | `log` | `fixture` |
 * | --- | --- | --- |
 * | no status, or no body | `vazio` | refused (`sem-resposta`) |
 * | `segredo` path, any status | nothing at all | refused (`segredo`) |
 * | no table (unknown path, or none yet) | keys only (2xx), error walk | refused (`sem-tabela`) |
 * | empty | `vazio` | `vazio`, `corpo: null` |
 * | over the cap / deeper than 256 | `grande` / `profundo`, never parsed | refused |
 * | not JSON, or a JSON scalar | `texto`, no excerpt | refused (`nao-json`) |
 * | 2xx JSON object or array | allow-list walk, masked, cut | allow-list walk, fakes |
 * | non-2xx JSON object or array | error walk | error walk |
 *
 * The 401/403, LWA and candidate-credential bans are the logger's
 * (`linhaDaChamada`): they depend on the call, not on the body.
 */
export function redigirCorpo(
  e: EntradaCorpoAmazon,
  perfil: 'log',
  o: OpcoesLogAmazon,
): CorpoParaLogAmazon;
export function redigirCorpo(
  e: EntradaCorpoAmazon,
  perfil: 'fixture',
  o: OpcoesFixtureAmazon,
): CorpoParaFixtureAmazon;
export function redigirCorpo(
  e: EntradaCorpoAmazon,
  perfil: PerfilRedacaoAmazon,
  o: OpcoesLogAmazon | OpcoesFixtureAmazon,
): CorpoParaLogAmazon | CorpoParaFixtureAmazon {
  if (perfil === 'log') return corpoParaLog(e, o as OpcoesLogAmazon);
  return corpoParaFixture(e, o as OpcoesFixtureAmazon);
}

/* -------------------------------------------------------------------------- */
/*                    Introspection for the spec-coverage test                 */
/* -------------------------------------------------------------------------- */

export type RegraDaFolhaAmazon =
  | { readonly tipo: 'permitida'; readonly predicado: NomePredicadoAmazon }
  | {
      readonly tipo: 'soLog';
      readonly predicado: NomePredicadoAmazon;
      readonly classe: ClasseFalsaAmazon;
    }
  /** A denied subtree, key or prefix (or a seller id) on the leaf's path. */
  | { readonly tipo: 'negada' }
  /** The table's own "redacted on purpose" list. */
  | { readonly tipo: 'negadaNaTabela' }
  /** The whole path is `segredo`. */
  | { readonly tipo: 'segredo' };

/**
 * Every rule that claims `folha` (a dotted leaf path, `*` for an array index) in
 * a 2xx body of the template named `modelo` (an `operationId`). The coverage
 * test demands EXACTLY one per leaf of the committed inventory: a leaf no rule
 * claims would be redacted by default, silently; a leaf two rules claim is a
 * table contradiction.
 */
export function regrasDaFolhaAmazon(modelo: string, folha: string): readonly RegraDaFolhaAmazon[] {
  const m = modeloPorNome(modelo);
  if (m === null) return [];
  if (m.politica === 'segredo') return [{ tipo: 'segredo' }];
  const t = m.tabela;
  if (t === null) return [];
  const regras: RegraDaFolhaAmazon[] = [];
  const predicado = t.permitidas.get(folha);
  if (predicado !== undefined) regras.push({ tipo: 'permitida', predicado });
  const soLog = t.soLog.get(folha);
  if (soLog !== undefined) regras.push({ tipo: 'soLog', ...soLog });
  const chaves = folha.split('.').filter((k) => k !== '*');
  if (chaves.some((k) => chaveNegadaAmazon(k) || chaveDeSellerId(k)))
    regras.push({ tipo: 'negada' });
  if (t.negadas.has(folha)) regras.push({ tipo: 'negadaNaTabela' });
  return regras;
}
