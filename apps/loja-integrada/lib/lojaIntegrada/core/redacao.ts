/**
 * Redaction of Loja Integrada (LI) traffic: what of a request path, a query and
 * a response body may leave this process — on a log line (`log` profile), or in
 * a committed fixture (`fixture` profile).
 *
 * **Pure and total.** No clock, no I/O, no environment, no `catch`. Totality is
 * by construction: `lerRespostaJson` narrows the parse error itself, size and
 * depth are bounded before and during the walk, every pattern is linear, and a
 * `JSON.parse` result holds no bigint, function or cycle. Imports only `zod` and
 * `@delfrance/core/*` (`estrutura.test.ts` asserts it), because the logger, the
 * capture sanitizer and step 3's functions bundle all reach this file.
 *
 * ## Fail closed: everything is an ALLOW-list
 *
 * 1. **The path picks the policy** (`classificarCaminho`), segment by segment.
 *    An unknown path is `estrutural`, the strictest.
 * 2. **`estrutural`** (pedido, cliente, envio, pagamento, histórico, and any
 *    unknown path): only the spelled-out leaves of the matching table keep their
 *    value, and only when it passes that leaf's predicate. A denied subtree
 *    (`cliente`, `endereco_entrega`, `enderecos`) or a denied key wins at any
 *    depth and is walked leaf by leaf. Every other value is redacted; KEYS are
 *    kept, so a new LI field shows up in the log.
 * 3. **`configuracao`** (`/v1/situacao`, `/v1/pagamento[/{id}]`, `/v1/envio[/{id}]`):
 *    a keep-list per resource, at the root (detail) and under `objects.*` (list).
 * 4. **`catalogo`** (produto, estoque, preço, imagem, categoria, marca, grades):
 *    carries no personal data, so the `log` profile keeps the whole text behind
 *    the regex layer; the `fixture` profile walks a keep-list.
 * 5. **`webhook`** (`/webhooks/…`): no excerpt, ever — its body carries the
 *    receiver's secret.
 * 6. **Non-2xx bodies** get an error walk that keeps only short, code-shaped
 *    values; see `redigirCorpo`. A 401/403 is never excerpted in the `log`
 *    profile, whatever the class: it is the answer that may echo the token, and
 *    the package scrubs only the token as sent.
 *
 * ## Two profiles
 *
 * - `log`: a refused value becomes `'<redacted>'`, and the kept text then passes
 *   the regex layer (`mascararTexto`), which replaces each hit with a tag such as
 *   `<redacted:email>` and counts it.
 * - `fixture`: committed fixtures are PUBLIC, so every class goes through a
 *   keep-list, a refused value becomes a fake of the SAME JSON type derived from
 *   its key name only (so redaction is idempotent), keys outside the identifier
 *   grammar become `chave_redigida_<n>`, and an error body keeps only its shape and
 *   short digit strings. On top of the log tables it fakes tracking codes, the
 *   pedido's external ids and `preco_custo`, and configuration labels.
 *
 * ## The regex layer is deliberately its OWN
 *
 * Bare 11- and 14-digit numbers (and the letter-bearing CNPJ) are masked only
 * when their check digits are valid (`validateCPF` / `validateCNPJ`), and not on
 * values that passed `inteiro`, `token`, `uriRecurso`, `decimal` or `data` in a
 * 2xx walk — LI ids look exactly like that. This is NOT a copy of the Mercado
 * Livre or Shopee scanners, which make different calls for their own id shapes;
 * nothing here claims to mirror either.
 *
 * ⚠️ Known residual: the regex layer reads serialized text, so a `\uXXXX`-escaped
 * character defeats it. For `estrutural` bodies the allow-list is the defence.
 */
import { validateCNPJ, validateCPF } from '@delfrance/core/documents';
import { lerRespostaJson } from '@delfrance/core/wire';
import { z } from 'zod';

/** The credential type every call of this code runs under (PLAN §1.3). */
export const CREDENCIAL_LI = 'personal-token';

/** The one origin LI is called at. A local copy: this file may not import the package. */
export const ORIGEM_LI = 'https://api.awsli.com.br';

/** What a refused value becomes in the `log` profile. */
export const REDIGIDO = '<redacted>';

export type PoliticaCorpoLi = 'estrutural' | 'configuracao' | 'catalogo' | 'webhook';
export type PerfilRedacaoLi = 'log' | 'fixture';
export type FormaCorpoLi = 'json' | 'texto' | 'vazio' | 'nao-analisado';

/** A JSON value as this module emits it. */
export type ValorJsonLi =
  | null
  | boolean
  | number
  | string
  | readonly ValorJsonLi[]
  | { readonly [chave: string]: ValorJsonLi };

/**
 * The parse cap per profile. `log` runs inside a request; `fixture` runs on a
 * local machine and must convert a `limit=1000` produto page. A body over the
 * cap keeps only its byte count, as `nao-analisado`.
 */
export const LIMITE_ANALISE_BYTES = { log: 1024 * 1024, fixture: 32 * 1024 * 1024 } as const;

/** Nesting beyond this is never handed to `JSON.parse` (see `profundidadeJson`). */
export const PROFUNDIDADE_MAXIMA_JSON = 256;

/** The walker's own cap: anything deeper is redacted. */
export const PROFUNDIDADE_MAXIMA_PERCURSO = 32;

/* -------------------------------------------------------------------------- */
/*                              Fixture fakes                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every string the `fixture` profile writes in place of a refused value.
 * Exported so the sanitizer's scanner skips them (`000.000.000-00` IS a CPF
 * shape).
 */
export const FALSO_LI = {
  cpf: '000.000.000-00',
  cnpj: '00.000.000/0000-00',
  cep: '00000-000',
  telefone: '(00) 00000-0000',
  email: 'redigido@example.invalid',
  url: 'https://redacted.invalid/',
  rastreio: 'AA000000000BR',
  texto: 'REDACTED',
} as const;

export const PLACEHOLDERS_FIXTURE_LI: ReadonlySet<string> = new Set(Object.values(FALSO_LI));

/** The identifier grammar a key must match to survive the `fixture` profile. */
const CHAVE_CONFORME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A fake of the same JSON type, derived from the key name only — so idempotent. */
function falso(chave: string | null, v: string | number | boolean): string | number | boolean {
  if (typeof v === 'boolean') return false;
  if (typeof v === 'number') return 0;
  const k = chave ?? '';
  if (k === 'cpf') return FALSO_LI.cpf;
  if (k === 'cnpj') return FALSO_LI.cnpj;
  if (k === 'cep') return FALSO_LI.cep;
  if (k.startsWith('telefone')) return FALSO_LI.telefone;
  if (k.includes('email')) return FALSO_LI.email;
  if (k.startsWith('url')) return FALSO_LI.url;
  if (k === 'objeto') return FALSO_LI.rastreio;
  return FALSO_LI.texto;
}

/* -------------------------------------------------------------------------- */
/*                                Predicates                                  */
/* -------------------------------------------------------------------------- */

export type NomePredicadoLi =
  | 'inteiro'
  | 'decimal'
  | 'data'
  | 'booleano'
  | 'token'
  | 'uriRecurso'
  | 'sku'
  | 'rastreio'
  | 'rotulo'
  | 'gtin'
  | 'ncm'
  | 'mime'
  /** `meta.next` / `meta.previous`: kept only through `redigirCaminhoEQuery`. */
  | 'urlLi';

const INTEIRO_TEXTO = /^\d{1,12}$/;
const DECIMAL_TEXTO = /^-?\d{1,12}(\.\d{1,4})?$/;
const DATA_TEXTO =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const TOKEN_TEXTO = /^[A-Za-z0-9_.-]{1,64}$/;
const URI_RECURSO = /^\/api\/v1\/[a-z_]+(\/[a-z_]+)?\/\d+\/?$/;
const SKU_TEXTO = /^[\x21-\x7E]{1,64}$/;
const RASTREIO_CORREIOS = /^[A-Z]{2}\d{9}[A-Z]{2}$/;
const RASTREIO_GERAL = /^[A-Za-z0-9-]{6,40}$/;
const ROTULO = /^[\p{L}\p{N} ._/-]{1,60}$/u;
const GTIN = /^\d{8,14}$/;
const NCM = /^\d{8}$/;
const MIME = /^[a-z]+\/[a-z0-9.+-]{1,40}$/;

const texto = (re: RegExp) => (v: unknown) => typeof v === 'string' && re.test(v);

const PREDICADOS: Readonly<Record<Exclude<NomePredicadoLi, 'urlLi'>, (v: unknown) => boolean>> = {
  inteiro: (v) => Number.isSafeInteger(v) || (typeof v === 'string' && INTEIRO_TEXTO.test(v)),
  decimal: (v) =>
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && DECIMAL_TEXTO.test(v)),
  data: texto(DATA_TEXTO),
  booleano: (v) => typeof v === 'boolean',
  token: (v) => Number.isSafeInteger(v) || (typeof v === 'string' && TOKEN_TEXTO.test(v)),
  uriRecurso: texto(URI_RECURSO),
  sku: texto(SKU_TEXTO),
  rastreio: (v) => typeof v === 'string' && (RASTREIO_CORREIOS.test(v) || RASTREIO_GERAL.test(v)),
  rotulo: texto(ROTULO),
  gtin: texto(GTIN),
  ncm: texto(NCM),
  mime: texto(MIME),
};

/**
 * Values that passed one of these in a 2xx walk skip the check-digit layer: LI
 * ids, numeros, prices and dates are bare digits, and masking them would blind
 * the log. Every other kept string — `sku`, `rastreio` (a Correios code is never
 * 11 or 14 bare digits), `rotulo` — still goes through it.
 */
const ISENTOS_DE_DIGITOS: ReadonlySet<NomePredicadoLi> = new Set([
  'inteiro',
  'token',
  'uriRecurso',
  'decimal',
  'data',
]);

/** Whether `v` passes the named predicate (`urlLi` accepts any string; it is rewritten). */
export function passaPredicadoLi(nome: NomePredicadoLi, v: unknown): boolean {
  return nome === 'urlLi' ? typeof v === 'string' : PREDICADOS[nome](v);
}

/* -------------------------------------------------------------------------- */
/*                    The regex layer ("second layer")                         */
/* -------------------------------------------------------------------------- */

export type TipoMascaraLi = 'email' | 'cpf' | 'cnpj' | 'telefone' | 'cep';

const etiqueta = (tipo: TipoMascaraLi) => `<redacted:${tipo}>`;

const CPF_PONTUADO = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
/** Letter-aware: the alphanumeric CNPJ keeps two numeric check digits. */
const CNPJ_PONTUADO =
  /(?<![A-Za-z0-9])[A-Za-z0-9]{2}\.[A-Za-z0-9]{3}\.[A-Za-z0-9]{3}\/[A-Za-z0-9]{4}-\d{2}(?!\d)/g;
/** Only a phone WRITTEN with a hyphen; a bare 10/11-digit run looks like an LI id. */
const TELEFONE = /(?<![\d+])(?:\+55\s?)?(?:\(\d{2}\)\s?)?\d{4,5}-\d{4}(?!\d)/g;
const CEP = /(?<!\d)(?:\d{5}-\d{3}|\d{2}\.\d{3}-\d{3})(?!\d)/g;
const ONZE_DIGITOS = /(?<!\d)\d{11}(?!\d)/g;
const QUATORZE_DIGITOS = /(?<!\d)\d{14}(?!\d)/g;
const CNPJ_COM_LETRA =
  /(?<![A-Za-z0-9])(?=[A-Za-z0-9]{0,11}[A-Za-z])[A-Za-z0-9]{12}\d{2}(?![A-Za-z0-9])/g;

const ehAlfaNum = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** `[A-Za-z0-9._%+-]` */
const ehLocalDeEmail = (c: number) =>
  ehAlfaNum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;
/** `[A-Za-z0-9.-]` */
const ehDominioDeEmail = (c: number) => ehAlfaNum(c) || c === 46 || c === 45;
const TLD = /^[A-Za-z]{2,}$/;

/**
 * E-mail addresses, found by expanding around each `@` instead of a regex: a
 * leading `[…]+` class would backtrack quadratically over a long run of letters
 * with no `@`, and this layer runs over bodies of up to 1 MB. Each character is
 * scanned a bounded number of times: neither class contains `@`.
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

/**
 * The regex layer. Each hit becomes a tag (`<redacted:cpf>`, …) and is counted.
 *
 * - Always: e-mail; punctuated CPF; punctuated CNPJ (letter-aware); a phone
 *   written with a hyphen (with or without `(DD)` / `+55`); CEP `00000-000` or
 *   `00.000-000`.
 * - With `digitos`: a bare 11-digit run with valid CPF check digits, a bare
 *   14-digit run or letter-bearing CNPJ with valid CNPJ check digits. The check
 *   runs on the matched candidate only (`validateCPF` strips non-digits).
 *
 * Never matched: a bare 8-digit CEP or a bare 10/11-digit phone — they look
 * exactly like LI ids. Denied keys cover them in a body.
 */
export function mascararTexto(
  t: string,
  opts: { readonly digitos: boolean },
): { texto: string; mascarados: number } {
  const emails = mascararEmails(t);
  let mascarados = emails.mascarados;
  const trocar = (s: string, re: RegExp, tipo: TipoMascaraLi, aceita?: (m: string) => boolean) =>
    s.replace(re, (m) => {
      if (aceita !== undefined && !aceita(m)) return m;
      mascarados += 1;
      return etiqueta(tipo);
    });
  let s = emails.texto;
  s = trocar(s, CPF_PONTUADO, 'cpf');
  s = trocar(s, CNPJ_PONTUADO, 'cnpj');
  s = trocar(s, TELEFONE, 'telefone');
  s = trocar(s, CEP, 'cep');
  if (opts.digitos) {
    s = trocar(s, ONZE_DIGITOS, 'cpf', validateCPF);
    s = trocar(s, QUATORZE_DIGITOS, 'cnpj', validateCNPJ);
    s = trocar(s, CNPJ_COM_LETRA, 'cnpj', validateCNPJ);
  }
  return { texto: s, mascarados };
}

/** `redigirTexto` is the regex layer as the plan names it: always with the digit check. */
export function redigirTexto(t: string): { texto: string; mascarados: number } {
  return mascararTexto(t, { digitos: true });
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
 * whether this runtime's `JSON.parse` recurses (unverified).
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
/*                               Path and query                               */
/* -------------------------------------------------------------------------- */

/** A path segment kept as-is: a lowercase name, an id, or `;`-joined ids. */
const SEGMENTO_SEGURO = /^(?:[a-z][a-z0-9_]*|\d+(?:;\d+)*)$/;

const inteiroQ = (v: string) => INTEIRO_TEXTO.test(v);
const dataQ = (v: string) => DATA_TEXTO.test(v);
const booleanoQ = (v: string) => v === 'true' || v === 'false' || v === '1' || v === '0';
const tokenQ = (v: string) => TOKEN_TEXTO.test(v);
const skuQ = (v: string) =>
  SKU_TEXTO.test(v) && mascararTexto(v, { digitos: true }).mascarados === 0;

/**
 * The query keys whose value may be logged, and the test it must pass. Any
 * other key — `email`, `cliente_email` included — keeps its name and loses its
 * value. `since_atualizado`, `removido` and `data_criacao__gte` are not declared
 * in the public document; they come from its prose and from the legacy app.
 */
const PREDICADO_DA_QUERY: ReadonlyMap<string, (v: string) => boolean> = new Map([
  ['limit', inteiroQ],
  ['offset', inteiroQ],
  ['since_numero', inteiroQ],
  ['situacao_id', inteiroQ],
  ['pagamento_id', inteiroQ],
  ['produto', inteiroQ],
  ['numero', inteiroQ],
  ['since_atualizado', dataQ],
  ['data_modificacao__gte', dataQ],
  ['data_modificacao__lte', dataQ],
  ['data_criacao__gte', dataQ],
  ['ativo', booleanoQ],
  ['removido', booleanoQ],
  ['descricao_completa', booleanoQ],
  ['id_externo', tokenQ],
  ['sku', skuQ],
]);

/**
 * Query keys whose value a `log` line keeps but a FIXTURE refuses (Q3): the
 * pedido's external id is faked in the body, so `meta.next` may not carry it.
 */
const QUERY_SO_LOG: ReadonlySet<string> = new Set(['id_externo']);

export interface CaminhoRedigidoLi {
  /** The path, each unsafe segment replaced by `<redacted>`. */
  readonly caminho: string;
  /** `[chave, valor]`, in order, duplicates kept; a kept value is its ORIGINAL substring. */
  readonly query: readonly (readonly [string, string])[];
  /** Query values the regex layer refused (`sku`). */
  readonly mascarados: number;
}

/** A request as the client holds it: the path, and the query pairs DECODED. */
export interface RequisicaoParaRedigirLi {
  readonly caminho: string;
  readonly query: readonly (readonly [string, string])[];
}

/** Decoded the way `URLSearchParams` decodes (`+` is a space); never throws. */
function decodificar(bruto: string): string {
  return new URLSearchParams(`v=${bruto}`).get('v') ?? '';
}

function redigirSegmentos(caminho: string): string {
  return caminho
    .split('/')
    .map((s) => (s === '' || SEGMENTO_SEGURO.test(s) ? s : REDIGIDO))
    .join('/');
}

/** `raw` is the substring as written (a URL); `decodificado` is what the predicates test. */
function redigirPar(
  chave: string,
  bruto: string,
  decodificado: string,
  perfil: PerfilRedacaoLi,
): { par: readonly [string, string]; mascarou: boolean } {
  if (!CHAVE_CONFORME.test(chave)) return { par: ['<chave>', REDIGIDO], mascarou: false };
  const predicado = PREDICADO_DA_QUERY.get(chave);
  if (predicado === undefined) return { par: [chave, REDIGIDO], mascarou: false };
  if (perfil === 'fixture' && QUERY_SO_LOG.has(chave)) {
    return { par: [chave, REDIGIDO], mascarou: false };
  }
  if (predicado(decodificado)) return { par: [chave, bruto], mascarou: false };
  return { par: [chave, REDIGIDO], mascarou: chave === 'sku' && SKU_TEXTO.test(decodificado) };
}

const ESQUEMA_E_AUTORIDADE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/;
const ORIGEM_REDIGIDA = '<origem>';

/**
 * Redacts a request line.
 *
 * Takes either a RAW URL — a sidecar line, `meta.next`, `meta.previous` — or the
 * client's DECODED pairs (the call event's `query`). For a raw URL, each pair is split
 * on its first `=` and decoded only to TEST it: a kept value is emitted as its
 * original substring, so `%3A` and `:` stay distinct. A key outside
 * `^[A-Za-z_][A-Za-z0-9_]{0,63}$` (tested on the raw key) becomes `<chave>`. An
 * origin other than {@link ORIGEM_LI} becomes `<origem>`; a fragment is dropped
 * (it never reaches a server).
 *
 * `perfil` (default `log`): a `fixture` also refuses the values the body walk
 * fakes for it (`id_externo`), so a committed `meta.next` never carries what
 * the body beside it hides.
 */
export function redigirCaminhoEQuery(
  entrada: string | RequisicaoParaRedigirLi,
  perfil: PerfilRedacaoLi = 'log',
): CaminhoRedigidoLi {
  let mascarados = 0;
  const pares: (readonly [string, string])[] = [];
  const somar = (r: { par: readonly [string, string]; mascarou: boolean }) => {
    pares.push(r.par);
    if (r.mascarou) mascarados += 1;
  };

  if (typeof entrada !== 'string') {
    for (const [chave, valor] of entrada.query) somar(redigirPar(chave, valor, valor, perfil));
    return { caminho: redigirSegmentos(entrada.caminho), query: pares, mascarados };
  }

  let resto = entrada;
  const hash = resto.indexOf('#');
  if (hash !== -1) resto = resto.slice(0, hash);
  let origem = '';
  const esquema = ESQUEMA_E_AUTORIDADE.exec(resto);
  if (esquema !== null) {
    origem = esquema[0] === ORIGEM_LI ? ORIGEM_LI : ORIGEM_REDIGIDA;
    resto = resto.slice(esquema[0].length);
  } else if (resto.startsWith(ORIGEM_REDIGIDA)) {
    // Already redacted once: re-redaction must leave it alone.
    origem = ORIGEM_REDIGIDA;
    resto = resto.slice(ORIGEM_REDIGIDA.length);
  }
  const interrogacao = resto.indexOf('?');
  const caminho = interrogacao === -1 ? resto : resto.slice(0, interrogacao);
  if (interrogacao !== -1) {
    for (const parBruto of resto.slice(interrogacao + 1).split('&')) {
      if (parBruto === '') continue;
      const igual = parBruto.indexOf('=');
      const chave = igual === -1 ? parBruto : parBruto.slice(0, igual);
      const valor = igual === -1 ? '' : parBruto.slice(igual + 1);
      somar(redigirPar(chave, valor, decodificar(valor), perfil));
    }
  }
  return { caminho: `${origem}${redigirSegmentos(caminho)}`, query: pares, mascarados };
}

/** `caminho?k=v&…`, as one string. */
export function textoDoCaminho(c: CaminhoRedigidoLi): string {
  if (c.query.length === 0) return c.caminho;
  return `${c.caminho}?${c.query.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

/* -------------------------------------------------------------------------- */
/*                         Path → policy, path → table                         */
/* -------------------------------------------------------------------------- */

const ID = /^\d+$/;
const IDS = /^\d+(?:;\d+)*$/;

function segmentosDe(caminho: string): string[] {
  const corte = caminho.search(/[?#]/);
  return (corte === -1 ? caminho : caminho.slice(0, corte)).split('/').filter((s) => s !== '');
}

/** A list, a detail by id(s), or a `/set/{ids}` subset. */
const listaOuDetalhe = (resto: readonly string[]) =>
  resto.length === 0 ||
  (resto.length === 1 && IDS.test(resto[0] ?? '')) ||
  (resto.length === 2 && resto[0] === 'set' && IDS.test(resto[1] ?? ''));

function ehCatalogo(recurso: string, resto: readonly string[]): boolean {
  const [a, b, c] = resto;
  switch (recurso) {
    case 'produto':
      return (
        resto.length === 0 ||
        (resto.length === 1 && ID.test(a ?? '')) ||
        (resto.length === 2 && ID.test(a ?? '') && b === 'alias')
      );
    case 'produto_estoque':
    case 'produto_preco':
    case 'categoria':
    case 'marca':
    case 'grades':
      return listaOuDetalhe(resto);
    case 'produto_imagem':
      return (
        resto.length === 0 ||
        (resto.length === 1 && ID.test(a ?? '')) ||
        (resto.length === 3 && ID.test(a ?? '') && b === 'grade_variacao' && ID.test(c ?? ''))
      );
    case 'grade':
      return resto.length === 2 && ID.test(a ?? '') && b === 'variacao';
    default:
      return false;
  }
}

function ehConfiguracao(recurso: string, resto: readonly string[]): boolean {
  if (recurso === 'situacao') return resto.length === 0;
  if (recurso === 'pagamento' || recurso === 'envio') {
    return resto.length === 0 || (resto.length === 1 && ID.test(resto[0] ?? ''));
  }
  return false;
}

/**
 * The body policy of a request path, segment by segment. An unknown path is
 * `estrutural`, the strictest. `/v1/situacao/pedido/{id}` is `estrutural`
 * (only the `/v1/situacao` LIST is configuration); `/webhooks/…` is `webhook`.
 */
export function classificarCaminho(caminho: string): PoliticaCorpoLi {
  const [raiz, recurso, ...resto] = segmentosDe(caminho);
  if (raiz === 'webhooks') return 'webhook';
  if (raiz !== 'v1' || recurso === undefined) return 'estrutural';
  if (ehCatalogo(recurso, resto)) return 'catalogo';
  if (ehConfiguracao(recurso, resto)) return 'configuracao';
  return 'estrutural';
}

/** The resource name a log line is filtered by (`pedido`, `produto_estoque`, …), or `null`. */
export function recursoDoCaminho(caminho: string): string | null {
  const s = segmentosDe(caminho);
  const nome = s[0] === 'v1' ? s[1] : s[0] === 'webhooks' ? s[2] : undefined;
  return nome !== undefined && /^[a-z][a-z0-9_]*$/.test(nome) ? nome : null;
}

/* -------------------------------------------------------------------------- */
/*                                  Tables                                    */
/* -------------------------------------------------------------------------- */

type Entradas = readonly (readonly [string, NomePredicadoLi])[];

/** `*` stands for an array index, and only that: no prefix wildcards. */
const sob = (prefixo: string, entradas: Entradas): Entradas =>
  entradas.map(([caminho, p]) => [`${prefixo}.${caminho}`, p] as const);
const sobCaminhos = (prefixo: string, caminhos: readonly string[]) =>
  caminhos.map((c) => `${prefixo}.${c}`);

const META: Entradas = [
  ['meta.limit', 'inteiro'],
  ['meta.offset', 'inteiro'],
  ['meta.total_count', 'inteiro'],
  ['meta.next', 'urlLi'],
  ['meta.previous', 'urlLi'],
];

/** A situação object as the estrutural tables see it: no `nome` (a denied key there). */
const SITUACAO: Entradas = [
  ['id', 'inteiro'],
  ['codigo', 'token'],
  ['aprovado', 'booleano'],
  ['cancelado', 'booleano'],
  ['final', 'booleano'],
  ['padrao', 'booleano'],
  ['notificar_comprador', 'booleano'],
  ['resource_uri', 'uriRecurso'],
];

const PEDIDO: Entradas = [
  ['numero', 'inteiro'],
  ['id_externo', 'token'],
  ['id_anymarket', 'token'],
  ['resource_uri', 'uriRecurso'],
  ['data_criacao', 'data'],
  ['data_modificacao', 'data'],
  ['data_expiracao', 'data'],
  ['valor_total', 'decimal'],
  ['valor_subtotal', 'decimal'],
  ['valor_envio', 'decimal'],
  ['valor_desconto', 'decimal'],
  ['peso_real', 'decimal'],
  ...sob('situacao', SITUACAO),
  ['itens.*.id', 'inteiro'],
  ['itens.*.linha', 'inteiro'],
  ['itens.*.disponibilidade', 'inteiro'],
  ['itens.*.sku', 'sku'],
  ['itens.*.quantidade', 'decimal'],
  ['itens.*.preco_cheio', 'decimal'],
  ['itens.*.preco_custo', 'decimal'],
  ['itens.*.preco_promocional', 'decimal'],
  ['itens.*.preco_subtotal', 'decimal'],
  ['itens.*.preco_venda', 'decimal'],
  ['itens.*.peso', 'decimal'],
  ['itens.*.altura', 'decimal'],
  ['itens.*.largura', 'decimal'],
  ['itens.*.profundidade', 'decimal'],
  ['itens.*.tipo', 'token'],
  ['itens.*.pedido', 'uriRecurso'],
  ['itens.*.produto_pai', 'uriRecurso'],
  ['itens.*.produto.resource_uri', 'uriRecurso'],
  ['itens.*.produto.id_externo', 'token'],
  ['envios.*.id', 'inteiro'],
  ['envios.*.prazo', 'inteiro'],
  ['envios.*.objeto', 'rastreio'],
  ['envios.*.valor', 'decimal'],
  ['envios.*.data_criacao', 'data'],
  ['envios.*.data_modificacao', 'data'],
  ['envios.*.forma_envio.id', 'inteiro'],
  ['envios.*.forma_envio.code', 'token'],
  ['envios.*.forma_envio.codigo', 'token'],
  ['envios.*.forma_envio.tipo', 'token'],
  ['pagamentos.*.id', 'inteiro'],
  ['pagamentos.*.valor', 'decimal'],
  ['pagamentos.*.valor_pago', 'decimal'],
  ['pagamentos.*.pagamento_tipo', 'token'],
  ['pagamentos.*.forma_pagamento.id', 'inteiro'],
  ['pagamentos.*.forma_pagamento.codigo', 'token'],
  ['pagamentos.*.parcelamento.numero_parcelas', 'inteiro'],
  ['pagamentos.*.parcelamento.valor_parcela', 'decimal'],
];

/** Pedido leaves the public document shows that are redacted on purpose (not denied keys). */
const PEDIDO_REDIGIDAS: readonly string[] = [
  'pagamentos.*.forma_pagamento.configuracoes.ativo',
  'pagamentos.*.forma_pagamento.configuracoes.disponivel',
  'pagamentos.*.forma_pagamento.imagem',
  'pagamentos.*.forma_pagamento.resource_uri',
];

/**
 * Kept in the `log` profile, FAKED in the `fixture` one (Q3): a real tracking
 * code and an external order id are publicly searchable, and cost is the
 * store's business.
 */
const PEDIDO_SO_LOG: readonly string[] = [
  'envios.*.objeto',
  'id_externo',
  'id_anymarket',
  'itens.*.preco_custo',
];

const LINHA_GENERICA: Entradas = [
  ['id', 'inteiro'],
  ['resource_uri', 'uriRecurso'],
  ['data_criacao', 'data'],
  ['data_modificacao', 'data'],
];

const SITUACAO_CONFIG: Entradas = [...SITUACAO, ['nome', 'rotulo']];
const ENVIO_CONFIG: Entradas = [
  ['id', 'inteiro'],
  ['codigo', 'token'],
  ['nome', 'rotulo'],
  ['tipo', 'token'],
  ['configuracoes.ativo', 'booleano'],
  ['configuracoes.disponivel', 'booleano'],
  ['resource_uri', 'uriRecurso'],
];
const PAGAMENTO_CONFIG: Entradas = ENVIO_CONFIG.filter(([c]) => c !== 'tipo');

const IMAGEM: Entradas = [
  ['id', 'inteiro'],
  ['imagem_id', 'inteiro'],
  ['posicao', 'inteiro'],
  ['principal', 'booleano'],
  ['mime', 'mime'],
  ['produto', 'uriRecurso'],
  ['resource_uri', 'uriRecurso'],
];

const PRODUTO: Entradas = [
  ['id', 'inteiro'],
  ['id_externo', 'token'],
  ['mpn', 'token'],
  ['tipo', 'token'],
  ['sku', 'sku'],
  ['gtin', 'gtin'],
  ['ncm', 'ncm'],
  ['pai', 'uriRecurso'],
  ['marca', 'uriRecurso'],
  ['categorias.*', 'uriRecurso'],
  ['grades.*', 'uriRecurso'],
  ['variacoes.*', 'uriRecurso'],
  // Documented in the public document's EXAMPLES only (PLAN §1.2 item 19).
  ['filhos.*', 'uriRecurso'],
  ['ativo', 'booleano'],
  ['bloqueado', 'booleano'],
  ['removido', 'booleano'],
  ['destaque', 'booleano'],
  ['usado', 'booleano'],
  ['estoque_gerenciado', 'booleano'],
  ['preco_sob_consulta', 'booleano'],
  ['estoque_quantidade', 'inteiro'],
  ['estoque_situacao_em_estoque', 'inteiro'],
  ['estoque_situacao_sem_estoque', 'inteiro'],
  ['preco_cheio', 'decimal'],
  ['preco_promocional', 'decimal'],
  ['peso', 'decimal'],
  ['altura', 'decimal'],
  ['largura', 'decimal'],
  ['profundidade', 'decimal'],
  ['data_criacao', 'data'],
  ['data_modificacao', 'data'],
  ['resource_uri', 'uriRecurso'],
  ...sob('imagens.*', IMAGEM),
  ...sob('imagem_principal', IMAGEM),
];

const ESTOQUE: Entradas = [
  ['id', 'inteiro'],
  ['produto', 'uriRecurso'],
  ['resource_uri', 'uriRecurso'],
  ['gerenciado', 'booleano'],
  ['quantidade', 'decimal'],
  ['quantidade_disponivel', 'decimal'],
  ['quantidade_reservada', 'decimal'],
  ['situacao_em_estoque', 'inteiro'],
  ['situacao_sem_estoque', 'inteiro'],
];

const PRECO: Entradas = [
  ['id', 'inteiro'],
  ['produto', 'uriRecurso'],
  ['resource_uri', 'uriRecurso'],
  ['cheio', 'decimal'],
  ['promocional', 'decimal'],
  ['sob_consulta', 'booleano'],
];

const CATEGORIA: Entradas = [
  ['id', 'inteiro'],
  ['id_externo', 'token'],
  ['categoria_pai', 'uriRecurso'],
  ['resource_uri', 'uriRecurso'],
];

const MARCA: Entradas = [
  ['id', 'inteiro'],
  ['id_externo', 'token'],
  ['ativo', 'booleano'],
  ['resource_uri', 'uriRecurso'],
];

const GRADE: Entradas = [
  ['id', 'inteiro'],
  ['id_externo', 'token'],
  ['resource_uri', 'uriRecurso'],
  ['variacoes.*.id', 'inteiro'],
  ['variacoes.*.id_externo', 'token'],
  ['variacoes.*.grade', 'uriRecurso'],
  ['variacoes.*.resource_uri', 'uriRecurso'],
];

/** One allow-list, as the walker reads it. */
export interface TabelaRedacaoLi {
  readonly nome: string;
  /** Leaf path → predicate. The only values that survive. */
  readonly permitidas: ReadonlyMap<string, NomePredicadoLi>;
  /** Leaves the public document shows that are redacted ON PURPOSE. */
  readonly redigidas: ReadonlySet<string>;
  /** Permitted in `log`, faked in `fixture` (Q3). */
  readonly soLog: ReadonlySet<string>;
}

function tabela(
  nome: string,
  permitidas: Entradas,
  redigidas: readonly string[] = [],
  soLog: readonly string[] = [],
): TabelaRedacaoLi {
  return {
    nome,
    permitidas: new Map(permitidas),
    redigidas: new Set(redigidas),
    soLog: new Set(soLog),
  };
}

/** A keep-list read at the root (a detail) AND under `objects.*` (a list page), plus `meta`. */
function manutencao(
  nome: string,
  entradas: Entradas,
  redigidas: readonly string[] = [],
  soLog: readonly string[] = [],
): TabelaRedacaoLi {
  return tabela(
    nome,
    [...META, ...entradas, ...sob('objects.*', entradas)],
    [...redigidas, ...sobCaminhos('objects.*', redigidas)],
    [...soLog, ...sobCaminhos('objects.*', soLog)],
  );
}

export const TABELAS_LI = {
  // estrutural
  pedido: tabela('pedido', PEDIDO, PEDIDO_REDIGIDAS, PEDIDO_SO_LOG),
  pedidoBusca: tabela(
    'pedido-busca',
    [...META, ...sob('objects.*', PEDIDO)],
    sobCaminhos('objects.*', PEDIDO_REDIGIDAS),
    sobCaminhos('objects.*', PEDIDO_SO_LOG),
  ),
  historico: tabela('historico', [
    ...META,
    ['objects.*.id', 'inteiro'],
    ['objects.*.numero', 'inteiro'],
    ['objects.*.data', 'data'],
    ['objects.*.resource_uri', 'uriRecurso'],
    ...sob('objects.*.situacao', SITUACAO),
    ...sob('objects.*.situacao_anterior', SITUACAO),
  ]),
  situacaoPedido: tabela('situacao-pedido', [...SITUACAO, ['pedido', 'uriRecurso']]),
  pedidoEnvio: tabela(
    'pedido-envio',
    [
      ['id', 'inteiro'],
      ['prazo', 'inteiro'],
      ['objeto', 'rastreio'],
      ['valor', 'decimal'],
      ['data_criacao', 'data'],
      ['data_modificacao', 'data'],
    ],
    [],
    ['objeto'],
  ),
  generica: tabela('generica', [...META, ...LINHA_GENERICA, ...sob('objects.*', LINHA_GENERICA)]),
  // configuracao
  situacao: manutencao('situacao', SITUACAO_CONFIG, [], ['nome']),
  envio: manutencao('envio', ENVIO_CONFIG, ['imagem'], ['nome']),
  pagamento: manutencao('pagamento', PAGAMENTO_CONFIG, ['imagem'], ['nome']),
  // catalogo (fixture profile only: the log keeps a catalogue body whole)
  produto: manutencao('produto', PRODUTO),
  produtoImagem: manutencao('produto-imagem', IMAGEM),
  produtoEstoque: manutencao('produto-estoque', ESTOQUE),
  produtoPreco: manutencao('produto-preco', PRECO),
  categoria: manutencao('categoria', CATEGORIA),
  marca: manutencao('marca', MARCA),
  grade: manutencao('grade', GRADE),
} as const satisfies Record<string, TabelaRedacaoLi>;

/** The catalogue keep-list of each catalogue resource (`classificarCaminho` names them). */
const TABELA_DO_CATALOGO: ReadonlyMap<string, TabelaRedacaoLi> = new Map([
  ['produto', TABELAS_LI.produto],
  ['produto_imagem', TABELAS_LI.produtoImagem],
  ['produto_estoque', TABELAS_LI.produtoEstoque],
  ['produto_preco', TABELAS_LI.produtoPreco],
  ['categoria', TABELAS_LI.categoria],
  ['marca', TABELAS_LI.marca],
  ['grades', TABELAS_LI.grade],
  ['grade', TABELAS_LI.grade],
]);

/** The table a 2xx body of this path is walked with, or `null` (webhook). */
export function tabelaDoCaminho(caminho: string): TabelaRedacaoLi | null {
  const politica = classificarCaminho(caminho);
  const [, recurso, ...resto] = segmentosDe(caminho);
  switch (politica) {
    case 'webhook':
      return null;
    case 'configuracao':
      if (recurso === 'situacao') return TABELAS_LI.situacao;
      return recurso === 'envio' ? TABELAS_LI.envio : TABELAS_LI.pagamento;
    case 'catalogo':
      // `ehCatalogo` admits exactly these resources, so the fallback never runs.
      return TABELA_DO_CATALOGO.get(recurso ?? '') ?? TABELAS_LI.grade;
    case 'estrutural': {
      const [a, b] = resto;
      if (recurso === 'pedido' && resto.length === 1 && a === 'search')
        return TABELAS_LI.pedidoBusca;
      if (recurso === 'pedido' && resto.length === 1 && ID.test(a ?? '')) return TABELAS_LI.pedido;
      if (recurso === 'situacao_historico' && resto.length === 1 && a === 'search') {
        return TABELAS_LI.historico;
      }
      if (recurso === 'situacao' && a === 'pedido' && resto.length === 2 && ID.test(b ?? '')) {
        return TABELAS_LI.situacaoPedido;
      }
      if (recurso === 'pedido_envio' && resto.length === 1 && ID.test(a ?? '')) {
        return TABELAS_LI.pedidoEnvio;
      }
      return TABELAS_LI.generica;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                         Denied subtrees and keys                            */
/* -------------------------------------------------------------------------- */

/** Walked leaf by leaf at any depth, whatever a table says: keys and lengths kept. */
export const SUBARVORES_NEGADAS_LI: ReadonlySet<string> = new Set([
  'cliente',
  'endereco_entrega',
  'enderecos',
]);

/**
 * Denied anywhere in an `estrutural` body and in every error body. Matched
 * case-insensitively (`chaveNegada`): an error body's keys are not the
 * documented ones, and its walk keeps a code-shaped value under any key it does
 * not deny.
 */
export const CHAVES_NEGADAS_LI: ReadonlySet<string> = new Set([
  'cpf',
  'cnpj',
  'rg',
  'ie',
  'email',
  'nome',
  'razao_social',
  'data_nascimento',
  'sexo',
  'bairro',
  'cidade',
  'complemento',
  'referencia',
  'obs',
  'observacao',
  'cliente_obs',
  'access_key',
  'transacao_id',
  'authorization_code',
  'mensagem_gateway',
  'codigo_retorno_gateway',
  'identificador_id',
  'bandeira',
  'banco',
  'destinatario',
  'cupom_desconto',
  'utm_campaign',
  'token',
  'notifyUrl',
]);

/**
 * Denied by prefix, case-insensitively: `telefone*`, `celular*`, `cep*`
 * (`cep_destino`), `endereco*`, `alterado_por*`, `url*`.
 */
export const PREFIXOS_NEGADOS_LI: readonly string[] = [
  'telefone',
  'celular',
  'cep',
  'endereco',
  'alterado_por',
  'url',
];

/**
 * Catalogue keys FAKED by the `fixture` profile (names, descriptions, URLs,
 * image paths, cost). Everything off the keep-list is faked anyway; this list
 * is what the spec-coverage test reads as "redacted on purpose".
 */
export const CHAVES_FALSAS_CATALOGO_LI: ReadonlySet<string> = new Set([
  'nome',
  'nome_visivel',
  'apelido',
  'caminho',
  'grande',
  'media',
  'pequena',
  'icone',
  'id_anymarket',
  'imagem_variacao',
  'imagem',
  'tags',
  'custo',
  'preco_custo',
]);
export const PREFIXOS_FALSOS_CATALOGO_LI: readonly string[] = ['descricao', 'seo', 'url'];

const minusculas = (conjunto: ReadonlySet<string>): ReadonlySet<string> =>
  new Set([...conjunto].map((k) => k.toLowerCase()));
const SUBARVORES_NEGADAS_MINUSCULAS = minusculas(SUBARVORES_NEGADAS_LI);
const CHAVES_NEGADAS_MINUSCULAS = minusculas(CHAVES_NEGADAS_LI);

/** Case-insensitive: `CEP`, `Nome` and `notifyurl` are denied too. */
const chaveNegada = (k: string) => {
  const c = k.toLowerCase();
  return (
    SUBARVORES_NEGADAS_MINUSCULAS.has(c) ||
    CHAVES_NEGADAS_MINUSCULAS.has(c) ||
    PREFIXOS_NEGADOS_LI.some((p) => c.startsWith(p))
  );
};

const chaveFalsaDoCatalogo = (k: string) =>
  CHAVES_FALSAS_CATALOGO_LI.has(k) || PREFIXOS_FALSOS_CATALOGO_LI.some((p) => k.startsWith(p));

/* -------------------------------------------------------------------------- */
/*                                  Walkers                                   */
/* -------------------------------------------------------------------------- */

interface Percurso {
  readonly perfil: PerfilRedacaoLi;
  readonly tabela: TabelaRedacaoLi | null;
  /** Apply the denied subtrees and keys (estrutural bodies, every error body). */
  readonly negacoes: boolean;
  /** Fake the catalogue keys whole (the `fixture` catalogue walk). */
  readonly falsasDoCatalogo: boolean;
  mascarados: number;
}

const ehObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An own property, even for `__proto__`, on a plain object. */
function definir(alvo: Record<string, ValorJsonLi>, chave: string, valor: ValorJsonLi): void {
  Object.defineProperty(alvo, chave, {
    value: valor,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * The OUTPUT names of an object's keys: `log` passes each through the regex
 * layer; `fixture` renames a key outside the identifier grammar to
 * `chave_redigida_<n>`, `n` its 1-based position among its siblings (bumped past
 * any sibling that already holds that name). A placeholder matches the grammar,
 * so re-redaction keeps it.
 */
function nomesDeSaida(chaves: readonly string[], ctx: Percurso): string[] {
  if (ctx.perfil === 'log') {
    return chaves.map((k) => {
      const m = mascararTexto(k, { digitos: true });
      ctx.mascarados += m.mascarados;
      return m.texto;
    });
  }
  const usadas = new Set(chaves.filter((k) => CHAVE_CONFORME.test(k)));
  return chaves.map((k, i) => {
    if (CHAVE_CONFORME.test(k)) return k;
    let n = i + 1;
    while (usadas.has(`chave_redigida_${String(n)}`)) n += chaves.length;
    const nome = `chave_redigida_${String(n)}`;
    usadas.add(nome);
    return nome;
  });
}

/** A key that cannot be part of a table path (it would read as a path of its own). */
const segmento = (k: string) => (k === '' || k.includes('.') || k === '*' ? '<?>' : k);
const juntar = (caminho: string, k: string) => (caminho === '' ? k : `${caminho}.${k}`);

function substituto(
  v: string | number | boolean,
  chave: string | null,
  ctx: Percurso,
): ValorJsonLi {
  return ctx.perfil === 'log' ? REDIGIDO : falso(chave, v);
}

const fundoDemais = (ctx: Percurso): ValorJsonLi =>
  ctx.perfil === 'log' ? REDIGIDO : FALSO_LI.texto;

function mapearObjeto(
  v: Record<string, unknown>,
  ctx: Percurso,
  filho: (chave: string, valor: unknown) => ValorJsonLi,
): ValorJsonLi {
  const chaves = Object.keys(v);
  const nomes = nomesDeSaida(chaves, ctx);
  const saida: Record<string, ValorJsonLi> = {};
  chaves.forEach((k, i) => definir(saida, nomes[i] ?? REDIGIDO, filho(k, v[k])));
  return saida;
}

/** Every leaf refused, keys and array lengths kept; `null` and `''` carry nothing and stay. */
function percorrerNegado(
  v: unknown,
  chave: string | null,
  prof: number,
  ctx: Percurso,
): ValorJsonLi {
  if (prof > PROFUNDIDADE_MAXIMA_PERCURSO) return fundoDemais(ctx);
  if (Array.isArray(v)) return v.map((item) => percorrerNegado(item, chave, prof + 1, ctx));
  if (ehObjeto(v)) {
    return mapearObjeto(v, ctx, (k, filho) => percorrerNegado(filho, k, prof + 1, ctx));
  }
  if (v === null || v === '') return v;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return substituto(v, chave, ctx);
  }
  return fundoDemais(ctx);
}

/**
 * A kept string still passes the regex layer, in BOTH profiles: `log` masks the
 * hit in place; `fixture` fakes the whole value (a committed fixture is never
 * laxer than a log line).
 */
function manter(
  v: string | number | boolean,
  predicado: NomePredicadoLi,
  chave: string | null,
  ctx: Percurso,
): ValorJsonLi {
  if (typeof v !== 'string') return v;
  const m = mascararTexto(v, { digitos: !ISENTOS_DE_DIGITOS.has(predicado) });
  if (ctx.perfil === 'fixture') return m.mascarados === 0 ? v : falso(chave, v);
  ctx.mascarados += m.mascarados;
  return m.texto;
}

function folha2xx(
  v: string | number | boolean | null,
  caminho: string,
  chave: string | null,
  ctx: Percurso,
): ValorJsonLi {
  if (v === null || v === '') return v;
  const tabelaAtual = ctx.tabela;
  const predicado = tabelaAtual?.permitidas.get(caminho);
  const soNoLog = ctx.perfil === 'fixture' && tabelaAtual?.soLog.has(caminho) === true;
  if (predicado !== undefined && !soNoLog) {
    if (predicado === 'urlLi') {
      if (typeof v === 'string') {
        const r = redigirCaminhoEQuery(v, ctx.perfil);
        ctx.mascarados += r.mascarados;
        return textoDoCaminho(r);
      }
    } else if (PREDICADOS[predicado](v)) {
      return manter(v, predicado, chave, ctx);
    }
  }
  return substituto(v, chave, ctx);
}

/** The 2xx allow-list / keep-list walk. */
function percorrer2xx(
  v: unknown,
  caminho: string,
  chave: string | null,
  prof: number,
  ctx: Percurso,
): ValorJsonLi {
  if (prof > PROFUNDIDADE_MAXIMA_PERCURSO) return fundoDemais(ctx);
  if (Array.isArray(v)) {
    return v.map((item) => percorrer2xx(item, juntar(caminho, '*'), chave, prof + 1, ctx));
  }
  if (ehObjeto(v)) {
    return mapearObjeto(v, ctx, (k, filho) => {
      const negada = ctx.negacoes && chaveNegada(k);
      const falsa = ctx.falsasDoCatalogo && chaveFalsaDoCatalogo(k);
      return negada || falsa
        ? percorrerNegado(filho, k, prof + 1, ctx)
        : percorrer2xx(filho, juntar(caminho, segmento(k)), k, prof + 1, ctx);
    });
  }
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return folha2xx(v, caminho, chave, ctx);
  }
  return fundoDemais(ctx);
}

/**
 * The error walk (any non-2xx JSON body), both profiles. Keys and booleans and
 * `null` survive; a number survives only with at most 7 integer digits. A
 * string survives — `log`: only when code-shaped (`token`), with no run of 8
 * or more digits, and untouched by the regex layer; `fixture`: only when it is 1
 * to 7 digits. Denied subtrees and keys apply. No message text survives either.
 *
 * Why 7 and 8: a bare CEP is 8 digits, a mobile without its area code 9, a CPF
 * that starts with zeros 9 or fewer once written as a number — and an error
 * body's keys are not the documented ones, so the denied keys cannot be relied
 * on to catch them.
 */
const NUMERO_MAXIMO_NO_ERRO = 1e7;
const DIGITOS_CURTOS = /^\d{1,7}$/;
const SEQUENCIA_LONGA_DE_DIGITOS = /\d{8}/;

function percorrerErro(v: unknown, chave: string | null, prof: number, ctx: Percurso): ValorJsonLi {
  if (prof > PROFUNDIDADE_MAXIMA_PERCURSO) return fundoDemais(ctx);
  if (Array.isArray(v)) return v.map((item) => percorrerErro(item, chave, prof + 1, ctx));
  if (ehObjeto(v)) {
    return mapearObjeto(v, ctx, (k, filho) =>
      chaveNegada(k)
        ? percorrerNegado(filho, k, prof + 1, ctx)
        : percorrerErro(filho, k, prof + 1, ctx),
    );
  }
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (Math.abs(v) < NUMERO_MAXIMO_NO_ERRO) return v;
    return ctx.perfil === 'log' ? REDIGIDO : 0;
  }
  if (typeof v !== 'string') return fundoDemais(ctx);
  if (ctx.perfil === 'fixture') return DIGITOS_CURTOS.test(v) ? v : FALSO_LI.texto;
  const seguro =
    TOKEN_TEXTO.test(v) &&
    !SEQUENCIA_LONGA_DE_DIGITOS.test(v) &&
    mascararTexto(v, { digitos: true }).mascarados === 0;
  return seguro ? v : REDIGIDO;
}

/* -------------------------------------------------------------------------- */
/*                                 redigirCorpo                                */
/* -------------------------------------------------------------------------- */

export interface EntradaCorpoLi {
  /** The REQUEST path (`/v1/pedido/165`); it picks the policy. */
  readonly caminho: string;
  /** `null` when there was no response at all. */
  readonly status: number | null;
  /** The response text; `null` when none was read. */
  readonly corpo: string | null;
}

/** What the `log` profile keeps of a body. */
export interface CorpoParaLogLi {
  readonly politica: PoliticaCorpoLi;
  readonly forma: FormaCorpoLi | null;
  /** The raw body's UTF-8 length; `null` when there was no body. */
  readonly bytes: number | null;
  /**
   * The redacted text, masked but NOT yet cut: the logger cuts it
   * (`cortarUtf8`) — mask first, cut second. `null` when nothing may be shown.
   */
  readonly trecho: string | null;
  readonly mascarados: number;
}

/** What the `fixture` profile makes of a body, or why it refuses to. */
export type CorpoParaFixtureLi =
  | {
      readonly ok: true;
      readonly politica: Exclude<PoliticaCorpoLi, 'webhook'>;
      readonly forma: Exclude<FormaCorpoLi, 'nao-analisado'>;
      readonly bytes: number;
      /** `null` for a body that is not JSON or is empty. */
      readonly corpo: ValorJsonLi;
    }
  | {
      readonly ok: false;
      readonly politica: PoliticaCorpoLi;
      readonly motivo: 'sem-resposta' | 'webhook' | 'nao-analisado' | 'estrutural-nao-json';
    };

type Analise =
  | { readonly forma: 'vazio' | 'texto' | 'nao-analisado' }
  | {
      readonly forma: 'json';
      readonly valor: unknown;
    };

/**
 * Empty → `vazio` BEFORE any parse (`lerRespostaJson` reads `''` as `null`, which
 * `z.unknown()` accepts). Over the cap or too deep → `nao-analisado`, never
 * parsed. ⚠️ A failed read's result is never serialised: its `nao-json` arm
 * carries the raw text.
 */
function analisar(t: string, bytes: number, limite: number): Analise {
  if (t.length === 0) return { forma: 'vazio' };
  if (bytes > limite) return { forma: 'nao-analisado' };
  if (profundidadeJson(t) > PROFUNDIDADE_MAXIMA_JSON) return { forma: 'nao-analisado' };
  const leitura = lerRespostaJson(t, z.unknown());
  return leitura.ok ? { forma: 'json', valor: leitura.data } : { forma: 'texto' };
}

const ehSucesso = (status: number) => status >= 200 && status <= 299;

function percurso(
  perfil: PerfilRedacaoLi,
  tabelaAtual: TabelaRedacaoLi | null,
  politica: PoliticaCorpoLi,
): Percurso {
  return {
    perfil,
    tabela: tabelaAtual,
    negacoes: politica === 'estrutural',
    falsasDoCatalogo: perfil === 'fixture' && politica === 'catalogo',
    mascarados: 0,
  };
}

function corpoParaLog(e: EntradaCorpoLi): CorpoParaLogLi {
  const politica = classificarCaminho(e.caminho);
  if (e.status === null || e.corpo === null) {
    return { politica, forma: null, bytes: null, trecho: null, mascarados: 0 };
  }
  const bytes = bytesUtf8(e.corpo);
  const nada = (forma: FormaCorpoLi): CorpoParaLogLi => ({
    politica,
    forma,
    bytes,
    trecho: null,
    mascarados: 0,
  });
  // The webhook body carries the receiver's secret: never read, never shown.
  if (politica === 'webhook') return nada('nao-analisado');

  const analise = analisar(e.corpo, bytes, LIMITE_ANALISE_BYTES.log);
  if (analise.forma === 'nao-analisado' || analise.forma === 'vazio') return nada(analise.forma);

  // A credential outcome is never excerpted, on any path: the package scrubs
  // only the token AS SENT, and a 401/403 is exactly the answer that may echo
  // it back escaped (JSON, HTML entities) or in part.
  if (e.status === 401 || e.status === 403) return nada(analise.forma);

  const textoMascarado = (): CorpoParaLogLi => {
    const m = mascararTexto(e.corpo ?? '', { digitos: true });
    return { politica, forma: analise.forma, bytes, trecho: m.texto, mascarados: m.mascarados };
  };

  if (politica !== 'estrutural' && (!ehSucesso(e.status) || politica === 'catalogo')) {
    return textoMascarado();
  }
  // estrutural (any status) or a configuracao 2xx: never the raw text. A
  // configuracao 2xx that is not JSON (a BOM, a cut list) is no exception: its
  // keep-list exists because the body (gateway `configuracoes`) is not trusted
  // whole.
  if (analise.forma !== 'json') return nada(analise.forma);
  const ctx = percurso('log', tabelaDoCaminho(e.caminho), politica);
  const saida = ehSucesso(e.status)
    ? percorrer2xx(analise.valor, '', null, 0, ctx)
    : percorrerErro(analise.valor, null, 0, ctx);
  return {
    politica,
    forma: 'json',
    bytes,
    trecho: JSON.stringify(saida),
    mascarados: ctx.mascarados,
  };
}

function corpoParaFixture(e: EntradaCorpoLi): CorpoParaFixtureLi {
  const politica = classificarCaminho(e.caminho);
  if (e.status === null || e.corpo === null) return { ok: false, politica, motivo: 'sem-resposta' };
  if (politica === 'webhook') return { ok: false, politica, motivo: 'webhook' };
  const bytes = bytesUtf8(e.corpo);
  const analise = analisar(e.corpo, bytes, LIMITE_ANALISE_BYTES.fixture);
  if (analise.forma === 'nao-analisado') return { ok: false, politica, motivo: 'nao-analisado' };
  if (analise.forma !== 'json') {
    if (ehSucesso(e.status) && politica === 'estrutural') {
      return { ok: false, politica, motivo: 'estrutural-nao-json' };
    }
    return { ok: true, politica, forma: analise.forma, bytes, corpo: null };
  }
  const ctx = percurso('fixture', tabelaDoCaminho(e.caminho), politica);
  const corpo = ehSucesso(e.status)
    ? percorrer2xx(analise.valor, '', null, 0, ctx)
    : percorrerErro(analise.valor, null, 0, ctx);
  return { ok: true, politica, forma: 'json', bytes, corpo };
}

/**
 * A response body through the policy of its request path, in one profile.
 *
 * | case | `log` | `fixture` |
 * | --- | --- | --- |
 * | no status, or no body | nothing | refused (`sem-resposta`) |
 * | `webhook`, any status | byte count only | refused |
 * | over the cap, or nested deeper than 256 | byte count only | refused |
 * | 401 or 403, any class | byte count and form only | error walk (JSON) or `null` |
 * | other non-2xx `catalogo`/`configuracao` | regex layer on the text | error walk (JSON) or `null` |
 * | non-2xx `estrutural` | error walk (JSON); nothing otherwise | error walk (JSON) or `null` |
 * | 2xx `estrutural` JSON | allow-list walk | allow-list walk, fakes |
 * | 2xx `estrutural` not JSON | nothing (could be a cut pedido) | refused |
 * | 2xx `configuracao` JSON | keep-list walk | keep-list walk, fakes |
 * | 2xx `configuracao` not JSON | nothing (its keep-list exists for a reason) | `null` |
 * | 2xx `catalogo` JSON | regex layer on the text | keep-list walk, fakes |
 * | 2xx `catalogo` not JSON | regex layer on the text | `null` |
 *
 * The `log` line of a call made with a candidate credential (no stored
 * version) drops the excerpt whatever this returns (`linhaDaChamada`).
 */
export function redigirCorpo(e: EntradaCorpoLi, perfil: 'log'): CorpoParaLogLi;
export function redigirCorpo(e: EntradaCorpoLi, perfil: 'fixture'): CorpoParaFixtureLi;
export function redigirCorpo(
  e: EntradaCorpoLi,
  perfil: PerfilRedacaoLi,
): CorpoParaLogLi | CorpoParaFixtureLi {
  return perfil === 'log' ? corpoParaLog(e) : corpoParaFixture(e);
}

/* -------------------------------------------------------------------------- */
/*                    Introspection for the spec-coverage test                 */
/* -------------------------------------------------------------------------- */

export type RegraDaFolhaLi =
  | { readonly tipo: 'permitida'; readonly predicado: NomePredicadoLi }
  | { readonly tipo: 'negada' }
  | { readonly tipo: 'redigida' }
  /** An (empty) array or object whose element paths the table lists. */
  | { readonly tipo: 'conteiner' };

/**
 * Every rule that claims `folha` (a dotted leaf path, `*` for an array index) in
 * a 2xx body of `caminho`. The spec-coverage test demands EXACTLY one per leaf
 * of the committed inventory: a leaf no rule claims would be redacted by
 * default, silently; a leaf two rules claim is a table contradiction.
 */
export function regrasDaFolhaLi(caminho: string, folha: string): readonly RegraDaFolhaLi[] {
  const politica = classificarCaminho(caminho);
  const t = tabelaDoCaminho(caminho);
  if (t === null) return [];
  const regras: RegraDaFolhaLi[] = [];
  const predicado = t.permitidas.get(folha);
  if (predicado !== undefined) regras.push({ tipo: 'permitida', predicado });
  const chaves = folha.split('.').filter((k) => k !== '*');
  if (politica === 'estrutural' && chaves.some(chaveNegada)) regras.push({ tipo: 'negada' });
  const falsa = politica === 'catalogo' && chaves.some(chaveFalsaDoCatalogo);
  if (t.redigidas.has(folha) || falsa) regras.push({ tipo: 'redigida' });
  if ([...t.permitidas.keys()].some((p) => p.startsWith(`${folha}.`))) {
    regras.push({ tipo: 'conteiner' });
  }
  return regras;
}
