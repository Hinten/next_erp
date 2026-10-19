/**
 * The independent check on an Amazon fixture envelope, run by the capture
 * sanitizer before anything is written and by `wireCorpus.test.ts` over every
 * committed fixture.
 *
 * Two layers, because they fail differently:
 *
 * 1. **Residue** (`residuoDeRedacao`). Re-run the `fixture` profile over the
 *    envelope's body (and its request body), the path and query redactor over
 *    its request line, and the zip-name faker over its listing — with a faker
 *    that accepts only values already in a fake format ({@link
 *    falsificadorDeVerificacao}). The fakes are fixpoints, so ANY change means a
 *    value reached the envelope without passing the redactor. A named local
 *    `deepEqual` decides "unchanged"; it folds nothing but key ORDER.
 * 2. **Patterns** (`achadosDePadroes`), over every key and every string or
 *    integer leaf of the whole envelope:
 *    - the redactor's always-on patterns (e-mail, punctuated CPF / CNPJ / root,
 *      phone, CEP, LWA tokens and secrets, AWS key ids, ARNs, URLs with a
 *      query, blobs), imported so they have ONE source;
 *    - the check digits on a value that is EXACTLY 11 digits, 14 digits or the
 *      letter-bearing CNPJ shape, with NO exemption (an id that collides is
 *      surfaced, never trusted); in URL-shaped text (holding a `/`), on every
 *      bare 11/14-digit run;
 *    - a street-address pattern;
 *    - an Amazon order id, an ASIN, an `A…` account-shaped id or a solution id
 *      that is not in its fake range (or the public marketplace-id set);
 *    - the owner's denylist (`nomes-proibidos.txt`, never in the repository),
 *      folded by `dobrarNomeDeLoja`. The sanitizer and `--verificar` pass it; CI
 *      has none, so CI finds no names.
 *    Every text is checked as written AND percent-decoded (up to 3 rounds). The
 *    redactor's own placeholders are skipped by EXACT equality only — a prefix
 *    or "contains" skip would hide a real document beside one.
 *
 * ⚠️ **A finding never carries a value.** It carries a path and a kind, and a key
 * on the path is printed only through `rotuloDeChave`.
 */
import { validateCNPJ, validateCPF } from '@delfrance/core/documents';
import { lerRespostaJson } from '@delfrance/core/wire';
import { z } from 'zod';

import {
  NOTIFICACAO_ORDER_CHANGE,
  PLACEHOLDERS_FIXTURE_AMAZON,
  type TipoMascaraAmazon,
  type FalsificadorAmazon,
  mascararTexto,
  redigirCaminhoEQuery,
  redigirCorpo,
  redigirRequisicaoParaFixture,
} from '../core/redacao';
import {
  FORMATO_FALSO_APLICACAO,
  FORMATO_FALSO_ASIN,
  FORMATO_FALSO_PEDIDO,
  SELLER_ID_FALSO,
  ehFalsoAmazon,
} from '../sanitizacao/falsificacao';
import { nomeFalsoDeEntrada } from '../sanitizacao/zip';
import type { EnvelopeFixtureAmazon } from './wireCorpus';

export type TipoAchadoAmazon =
  | 'residuo'
  | TipoMascaraAmazon
  | 'endereco'
  | 'pedido-amazon'
  | 'asin'
  | 'id-de-conta'
  | 'id-de-aplicacao'
  | 'nome-de-loja';

export interface AchadoPiiAmazon {
  /** Dotted path; an array index is `*`; `''` is the root. */
  readonly caminho: string;
  readonly tipo: TipoAchadoAmazon;
}

/**
 * The status a notification is redacted under: it is not an HTTP response, and
 * its walk is the 2xx allow-list (the sanitizer and the residue layer agree).
 */
export const STATUS_DA_NOTIFICACAO = 200;

/* -------------------------------------------------------------------------- */
/*                               The denylist                                 */
/* -------------------------------------------------------------------------- */

/**
 * The fold a listed name is matched under: accents dropped (NFD, combining marks
 * removed), lower case, and every run of characters that is not a letter or a
 * digit read as ONE space. `Loja  Exêmplo` and `loja-exemplo` both fold to
 * `loja exemplo`.
 */
export function dobrarNomeDeLoja(t: string): string {
  return t
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The owner's denylist, folded. Built from `nomes-proibidos.txt` only. */
export interface ListaDeNomesAmazon {
  readonly termos: readonly { readonly comEspacos: string; readonly juntos: string | null }[];
}

export function criarListaDeNomes(termos: readonly string[]): ListaDeNomesAmazon {
  return {
    termos: termos.map((t) => {
      const comEspacos = dobrarNomeDeLoja(t);
      return {
        comEspacos,
        // A multi-word term also matches with its separators gone (`lojaexemplo`
        // in a host name). A single word never does: joining a text's words would
        // match it across two different words.
        juntos: comEspacos.includes(' ') ? comEspacos.replaceAll(' ', '') : null,
      };
    }),
  };
}

const ESCAPES = /(?:%[0-9A-Fa-f]{2})+/g;
/** Not fatal: an invalid sequence becomes U+FFFD, so decoding never throws. */
const UTF8 = new TextDecoder('utf-8');
/** Rounds of decoding: a value encoded twice or three times (`%252F`) is still read. */
const RODADAS_DE_DECODIFICACAO = 3;

/** Every run of `%XX` escapes decoded as UTF-8; a malformed `%` is left as written. */
function decodificarEscapes(t: string): string {
  return t.replace(ESCAPES, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    }
    return UTF8.decode(bytes);
  });
}

/** `t` as written and decoded, round by round. Text without a `%` is returned as is. */
function formasDecodificadas(t: string): string[] {
  const formas = [t];
  let atual = t;
  for (let i = 0; i < RODADAS_DE_DECODIFICACAO && atual.includes('%'); i++) {
    const seguinte = decodificarEscapes(atual);
    if (seguinte === atual) break;
    formas.push(seguinte);
    atual = seguinte;
  }
  return formas;
}

/**
 * Whether `texto` holds any listed term: a substring match under the fold, so a
 * term never matches a DIFFERENT word (`exemplo` vs `exemplar`), and folding
 * more is the safe direction. Tried as written, percent-decoded, and with every
 * `%XX` escape dropped (`LOJA%C3%A9EXEMPLO` → `LOJAEXEMPLO`).
 */
export function contemNomeDeLoja(texto: string, lista: ListaDeNomesAmazon): boolean {
  if (lista.termos.length === 0) return false;
  const formas = formasDecodificadas(texto);
  if (texto.includes('%')) formas.push(texto.replace(ESCAPES, ''));
  return formas.some((forma) => {
    const dobrado = dobrarNomeDeLoja(forma);
    let juntos: string | null = null;
    return lista.termos.some((t) => {
      if (t.comEspacos !== '' && dobrado.includes(t.comEspacos)) return true;
      if (t.juntos === null) return false;
      juntos ??= dobrado.replaceAll(' ', '');
      return juntos.includes(t.juntos);
    });
  });
}

/* -------------------------------------------------------------------------- */
/*                                 Patterns                                   */
/* -------------------------------------------------------------------------- */

const TIPOS_MASCARA: readonly TipoMascaraAmazon[] = [
  'email',
  'cpf',
  'cnpj',
  'cnpj-raiz',
  'telefone',
  'cep',
  'token-lwa',
  'segredo-lwa',
  'chave-aws',
  'arn',
  'url',
  'blob',
];
const etiquetaDe = (tipo: TipoMascaraAmazon) => `<redacted:${tipo}>`;
const contar = (t: string, s: string) => t.split(s).length - 1;

/**
 * The redactor's mask kinds that hit `t`, counted as tags ADDED by the mask, so a
 * text that already spells a tag is not reported for it.
 */
export function tiposMascaradosAmazon(
  t: string,
  opts: { readonly digitos: boolean },
): TipoMascaraAmazon[] {
  const m = mascararTexto(t, opts);
  if (m.mascarados === 0) return [];
  return TIPOS_MASCARA.filter(
    (tipo) => contar(m.texto, etiquetaDe(tipo)) > contar(t, etiquetaDe(tipo)),
  );
}

const ONZE = /^\d{11}$/;
const QUATORZE = /^\d{14}$/;
const CNPJ_COM_LETRA = /^(?=[A-Za-z0-9]{0,11}[A-Za-z])[A-Za-z0-9]{12}\d{2}$/;

/** The check-digit kind of an EXACT 11/14-digit or letter-bearing CNPJ value, if valid. */
export function digitosVerificados(s: string): 'cpf' | 'cnpj' | null {
  if (ONZE.test(s) && validateCPF(s)) return 'cpf';
  if ((QUATORZE.test(s) || CNPJ_COM_LETRA.test(s)) && validateCNPJ(s)) return 'cnpj';
  return null;
}

const ONZE_NUM_TEXTO = /(?<!\d)\d{11}(?!\d)/g;
const QUATORZE_NUM_TEXTO = /(?<!\d)\d{14}(?!\d)/g;

/**
 * Every bare 11/14-digit run of a URL-shaped text with valid check digits, on its
 * own: the redactor's mask replaces a URL with a query WHOLE, so a document
 * inside it would only ever read as `url`.
 */
function corridasComDigitos(t: string): ('cpf' | 'cnpj')[] {
  const tipos: ('cpf' | 'cnpj')[] = [];
  if ([...t.matchAll(ONZE_NUM_TEXTO)].some((m) => validateCPF(m[0]))) tipos.push('cpf');
  if ([...t.matchAll(QUATORZE_NUM_TEXTO)].some((m) => validateCNPJ(m[0]))) tipos.push('cnpj');
  return tipos;
}

/** A street-address word followed by a name or a number. */
const ENDERECO =
  /(?<![\p{L}\p{N}])(?:rua|av\.?|avenida|travessa|alameda|rodovia|estrada|pra[cç]a|largo|quadra|apto\.?|sala)\s+[\p{L}\p{N}]/iu;
const PEDIDO_AMAZON = /(?<!\d)\d{3}-\d{7}-\d{7}(?!\d)/g;
const ASIN_B0 = /(?<![A-Za-z0-9])B0[A-Z0-9]{8}(?![A-Za-z0-9])/g;
/** A seller (merchant) id, or a marketplace id outside the public set. */
const ID_A = /(?<![A-Za-z0-9])A[A-Z0-9]{12,13}(?![A-Za-z0-9])/g;
const ID_APLICACAO =
  /amzn1\.sp\.solution\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The marketplace ids an `A…` id may be without a finding: the North America
 * set the sidecar's only host serves (US, CA, MX, BR — D:marketplace-ids), plus
 * the ones the in-scope models' sandbox cases carry (IN, UK, DE, JP, TR). Amazon
 * publishes them; none identifies a seller.
 */
export const MARKETPLACES_PUBLICOS_AMAZON: ReadonlySet<string> = new Set([
  'ATVPDKIKX0DER',
  'A2EUQ1WTGCTBG2',
  'A1AM78C64UM0Y8',
  'A2Q3Y263D00KWC',
  'A21TJRUUN4KGV',
  'A1F83G8C2ARO7P',
  'A1PA6795UKMFR9',
  'A1VC38T7YXB528',
  'A33AVAJ2PDY3EV',
]);

const algum = (re: RegExp, t: string, aceito: (m: string) => boolean) =>
  [...t.matchAll(re)].some((m) => !aceito(m[0]));

/**
 * Where a text comes from. In `prosa` (a doc, a PR body: `--verificar`) an
 * all-letter `A…` run is an English word written in capitals (AUTHORITATIVE,
 * AUTHORIZATION, ADMINISTRATOR), never an id. A `captura` (a capture's key, leaf
 * or request line, and every committed fixture through `piiScan`) keeps the
 * strict shape: a random id of that length has no digit about once in 60, and
 * there it must fail closed. The owner's own seller id is on the denylist either way.
 */
type OrigemDoTextoAmazon = 'captura' | 'prosa';
const SO_LETRAS = /^[A-Z]+$/;

/** The Amazon-id kinds of `t`: each shape outside its fake range (or the public set). */
function tiposDeIdAmazon(t: string, origem: OrigemDoTextoAmazon): TipoAchadoAmazon[] {
  const tipos: TipoAchadoAmazon[] = [];
  if (algum(PEDIDO_AMAZON, t, (m) => FORMATO_FALSO_PEDIDO.test(m))) tipos.push('pedido-amazon');
  if (algum(ASIN_B0, t, (m) => FORMATO_FALSO_ASIN.test(m))) tipos.push('asin');
  if (
    algum(
      ID_A,
      t,
      (m) =>
        m === SELLER_ID_FALSO ||
        MARKETPLACES_PUBLICOS_AMAZON.has(m) ||
        (origem === 'prosa' && SO_LETRAS.test(m)),
    )
  ) {
    tipos.push('id-de-conta');
  }
  if (algum(ID_APLICACAO, t, (m) => FORMATO_FALSO_APLICACAO.test(m))) tipos.push('id-de-aplicacao');
  return tipos;
}

/**
 * Every kind a text trips: a key, a string leaf, the request line. Each form of
 * the text (as written, percent-decoded) is checked. A text holding a `/` is
 * URL-shaped, so the check digits run on every bare 11/14-digit run in it.
 */
export function tiposDoTextoAmazon(
  s: string,
  lista: ListaDeNomesAmazon | null,
): TipoAchadoAmazon[] {
  const tipos = new Set<TipoAchadoAmazon>();
  for (const forma of formasDecodificadas(s)) {
    const url = forma.includes('/');
    for (const t of tiposMascaradosAmazon(forma, { digitos: url })) tipos.add(t);
    if (url) for (const t of corridasComDigitos(forma)) tipos.add(t);
    const digitos = digitosVerificados(forma);
    if (digitos !== null) tipos.add(digitos);
    if (ENDERECO.test(forma)) tipos.add('endereco');
    for (const t of tiposDeIdAmazon(forma, 'captura')) tipos.add(t);
  }
  if (lista !== null && contemNomeDeLoja(s, lista)) tipos.add('nome-de-loja');
  return [...tipos];
}

/* -------------------------------------------------------------------------- */
/*                           Printing a key safely                            */
/* -------------------------------------------------------------------------- */

const CHAVE_CONFORME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * How a key may be PRINTED (a finding's path, a dry-run leaf table): the key
 * itself when it is an identifier that trips nothing; the mask's tags when the
 * mask hits it; `<chave>` otherwise.
 */
export function rotuloDeChave(chave: string, lista: ListaDeNomesAmazon | null): string {
  const tipos = tiposMascaradosAmazon(chave, { digitos: true });
  if (tipos.length > 0) return tipos.map(etiquetaDe).join('');
  if (!CHAVE_CONFORME.test(chave)) return '<chave>';
  if (tiposDeIdAmazon(chave, 'captura').length > 0) return '<chave>';
  if (lista !== null && contemNomeDeLoja(chave, lista)) return '<chave>';
  return chave;
}

/* -------------------------------------------------------------------------- */
/*                              Layer 1: residue                              */
/* -------------------------------------------------------------------------- */

/** What a non-fake id becomes under the verification faker: never equal to the input. */
const ID_NAO_FALSIFICADO = '<id-nao-falsificado>';

/**
 * The faker layer 1 re-runs the profile with: a value already in its class's fake
 * format is a fixpoint, ANY other value becomes a marker that cannot equal it —
 * so a real id in a fixture shows up as residue.
 */
export const falsificadorDeVerificacao: FalsificadorAmazon = (classe, valor) =>
  ehFalsoAmazon(classe, valor) ? valor : ID_NAO_FALSIFICADO;

const ehObjetoSimples = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Structural identity over JSON values: the fold that decides "re-redaction left
 * this alone". Equal: the same key SET (order ignored), the same primitive
 * values, `null` only to `null`, arrays element by element. Distinct: a
 * placeholder and the value it replaced, `null` and `"REDACTED"`, `0` and `"0"`,
 * arrays of different length. Folding more would hide a leak.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ea = Object.entries(a);
  const eb = new Map(Object.entries(b));
  return ea.length === eb.size && ea.every(([k, v]) => eb.has(k) && deepEqual(v, eb.get(k)));
}

const juntar = (caminho: readonly string[]) => caminho.join('.');

/** Pushes the deepest paths where `antes` and `depois` differ. */
function localizarDiferencas(
  antes: unknown,
  depois: unknown,
  caminho: readonly string[],
  lista: ListaDeNomesAmazon | null,
  saida: AchadoPiiAmazon[],
): void {
  if (deepEqual(antes, depois)) return;
  if (Array.isArray(antes) && Array.isArray(depois) && antes.length === depois.length) {
    antes.forEach((x, i) => {
      localizarDiferencas(x, depois[i], [...caminho, '*'], lista, saida);
    });
    return;
  }
  if (ehObjetoSimples(antes) && ehObjetoSimples(depois)) {
    const outro = new Map(Object.entries(depois));
    const entradas = Object.entries(antes);
    if (entradas.length === outro.size && entradas.every(([k]) => outro.has(k))) {
      for (const [k, v] of entradas) {
        localizarDiferencas(v, outro.get(k), [...caminho, rotuloDeChave(k, lista)], lista, saida);
      }
      return;
    }
  }
  saida.push({ caminho: juntar(caminho), tipo: 'residuo' });
}

/**
 * Layer 1: every path of the envelope that the redactors would still change.
 * `lista` only shapes how keys are printed.
 */
export function residuoDeRedacao(
  envelope: EnvelopeFixtureAmazon,
  lista: ListaDeNomesAmazon | null = null,
): AchadoPiiAmazon[] {
  const achados: AchadoPiiAmazon[] = [];
  const { requisicao, resposta, anexos } = envelope;
  const opcoes = { falsificador: falsificadorDeVerificacao };

  let caminhoDoCorpo: string;
  let statusDoCorpo: number | null;
  if (requisicao.tipo === 'http') {
    caminhoDoCorpo = requisicao.caminho;
    statusDoCorpo = resposta.status;
    const deNovo = redigirCaminhoEQuery(requisicao.caminho, requisicao.query, 'fixture', opcoes);
    if (deNovo.caminho !== requisicao.caminho) {
      achados.push({ caminho: 'requisicao.caminho', tipo: 'residuo' });
    }
    localizarDiferencas(requisicao.query, deNovo.query, ['requisicao', 'query'], lista, achados);
    if (requisicao.corpo !== null) {
      const corpo = redigirRequisicaoParaFixture(
        {
          caminho: requisicao.caminho,
          metodo: requisicao.metodo,
          corpo: JSON.stringify(requisicao.corpo),
        },
        opcoes,
      );
      if (!corpo.ok || corpo.forma !== 'json') {
        achados.push({ caminho: 'requisicao.corpo', tipo: 'residuo' });
      } else {
        localizarDiferencas(requisicao.corpo, corpo.corpo, ['requisicao', 'corpo'], lista, achados);
      }
    }
  } else {
    caminhoDoCorpo = NOTIFICACAO_ORDER_CHANGE;
    statusDoCorpo = STATUS_DA_NOTIFICACAO;
  }

  if (anexos.zip !== null) {
    const nomes = anexos.zip.entradas.map((e) => e.nome);
    const deNovo = nomes.map((n) => nomeFalsoDeEntrada(n, falsificadorDeVerificacao));
    localizarDiferencas(nomes, deNovo, ['anexos', 'zip', 'entradas', 'nome'], lista, achados);
  }

  if (resposta.forma !== 'json') {
    if (resposta.corpo !== null) achados.push({ caminho: 'resposta.corpo', tipo: 'residuo' });
    return achados;
  }
  const corpo = redigirCorpo(
    { caminho: caminhoDoCorpo, status: statusDoCorpo, corpo: JSON.stringify(resposta.corpo) },
    'fixture',
    opcoes,
  );
  if (!corpo.ok || corpo.forma !== 'json') {
    achados.push({ caminho: 'resposta.corpo', tipo: 'residuo' });
    return achados;
  }
  localizarDiferencas(resposta.corpo, corpo.corpo, ['resposta', 'corpo'], lista, achados);
  return achados;
}

/* -------------------------------------------------------------------------- */
/*                             Layer 2: patterns                              */
/* -------------------------------------------------------------------------- */

/** Layer 2: every key and leaf of the envelope that trips a pattern or a listed term. */
export function achadosDePadroes(
  envelope: EnvelopeFixtureAmazon,
  lista: ListaDeNomesAmazon | null = null,
): AchadoPiiAmazon[] {
  const achados: AchadoPiiAmazon[] = [];
  const marcar = (caminho: readonly string[], tipos: readonly TipoAchadoAmazon[]) => {
    for (const tipo of tipos) achados.push({ caminho: juntar(caminho), tipo });
  };
  const notificacao = envelope.requisicao.tipo === 'notificacao';

  function percorrer(v: unknown, caminho: readonly string[], aninhado: boolean): void {
    if (Array.isArray(v)) {
      for (const x of v) percorrer(x, [...caminho, '*'], aninhado);
      return;
    }
    if (ehObjetoSimples(v)) {
      for (const [k, filho] of Object.entries(v)) {
        const aqui = [...caminho, rotuloDeChave(k, lista)];
        marcar(aqui, tiposDoTextoAmazon(k, lista));
        // The Pipe record's `body` is the notification as a JSON STRING: scan
        // the tree it holds, never the string (its placeholders would read as
        // findings inside a longer text).
        if (notificacao && !aninhado && k.toLowerCase() === 'body' && typeof filho === 'string') {
          const lido = lerRespostaJson(filho, z.unknown());
          if (lido.ok && typeof lido.data === 'object' && lido.data !== null) {
            percorrer(lido.data, [...aqui, '<json>'], true);
            continue;
          }
        }
        percorrer(filho, aqui, aninhado);
      }
      return;
    }
    if (typeof v === 'string') {
      if (!PLACEHOLDERS_FIXTURE_AMAZON.has(v)) marcar(caminho, tiposDoTextoAmazon(v, lista));
      return;
    }
    if (typeof v === 'number' && Number.isInteger(v)) {
      const digitos = digitosVerificados(String(Math.abs(v)));
      if (digitos !== null) marcar(caminho, [digitos]);
    }
  }

  percorrer(envelope, [], false);
  return achados;
}

/** Both layers, deduplicated. Empty means the envelope may be written. */
export function piiScan(
  envelope: EnvelopeFixtureAmazon,
  lista: ListaDeNomesAmazon | null = null,
): AchadoPiiAmazon[] {
  const vistos = new Set<string>();
  return [...residuoDeRedacao(envelope, lista), ...achadosDePadroes(envelope, lista)].filter(
    (a) => {
      const chave = `${a.caminho}\u0000${a.tipo}`;
      if (vistos.has(chave)) return false;
      vistos.add(chave);
      return true;
    },
  );
}

/** One line per finding, `<nome> <caminho> :: <tipo>`. Paths and kinds only, never a value. */
export function formatarAchadosAmazon(nome: string, achados: readonly AchadoPiiAmazon[]): string[] {
  return achados.map((a) => `${nome} ${a.caminho === '' ? '<raiz>' : a.caminho} :: ${a.tipo}`);
}

/* -------------------------------------------------------------------------- */
/*                         Free text (`--verificar`)                          */
/* -------------------------------------------------------------------------- */

const escaparRegex = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The fakes this repository's public text is REQUIRED to use, blanked before a
 * doc line is scanned: the redactor's placeholders (whole, never a prefix:
 * bounded by a non-alphanumeric on both sides), all-zero documents, CEPs and
 * phones with area code `00`, and e-mail addresses under a reserved domain.
 * None of them can belong to anyone.
 */
const FALSOS_EM_TEXTO: readonly RegExp[] = [
  ...[...PLACEHOLDERS_FIXTURE_AMAZON].map(
    (p) => new RegExp(`(?<![0-9A-Za-z])${escaparRegex(p)}(?![0-9A-Za-z])`, 'g'),
  ),
  /0{3}\.0{3}\.0{3}-0{2}/g,
  /0{2}\.0{3}\.0{3}\/0{4}-0{2}/g,
  /(?<!\d)0{5}-0{3}(?!\d)/g,
  /\(00\) ?[09]?0{4}-0{4}/g,
  /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){0,8}(?:invalid|example|test|localhost|example\.com|example\.net|example\.org)(?![A-Za-z0-9.-])/g,
];

export function semFalsosConhecidosAmazon(t: string): string {
  return FALSOS_EM_TEXTO.reduce((s, re) => s.replace(re, (m) => ' '.repeat(m.length)), t);
}

/**
 * A JS/JSON string escape: an escaped backslash, `\u{…}`, `\uXXXX`, `\xXX`, or a
 * one-letter control escape.
 */
const ESCAPE_DE_STRING =
  /\\(?:(\\)|u\{([0-9A-Fa-f]{1,6})\}|u([0-9A-Fa-f]{4})|x([0-9A-Fa-f]{2})|[nrtvfb0])/g;

/**
 * `t` with its string escapes decoded: a control escape (`\n`, `\t`, …) reads as
 * a space, a code-point escape as its character, `\\` as one backslash — so a
 * fixture's or a `.ts` literal's embedded line break does not glue two words.
 */
function semEscapesDeString(t: string): string {
  return t.replace(
    ESCAPE_DE_STRING,
    (
      _escape: string,
      barra: string | undefined,
      chaves: string | undefined,
      u: string | undefined,
      x: string | undefined,
    ) => {
      if (barra !== undefined) return '\\';
      const hex = chaves ?? u ?? x;
      if (hex === undefined) return ' ';
      const ponto = Number.parseInt(hex, 16);
      return ponto <= 0x10ffff ? String.fromCodePoint(ponto) : ' ';
    },
  );
}

/**
 * The kinds one line of a doc, a fixture or a PR-body draft trips: the listed
 * terms and every pattern of layer 2 (bare 11/14 digits only with valid check
 * digits), on the line as written and percent-decoded — and, when it holds a
 * backslash, with its string escapes decoded too. The mandated fakes are skipped,
 * and an all-letter `A…` run is a word here (`OrigemDoTextoAmazon`, `prosa`).
 */
export function tiposNaLinhaAmazon(linha: string, lista: ListaDeNomesAmazon): TipoAchadoAmazon[] {
  const tipos = new Set<TipoAchadoAmazon>();
  const leituras = linha.includes('\\') ? new Set([linha, semEscapesDeString(linha)]) : [linha];
  for (const leitura of leituras) {
    for (const forma of formasDecodificadas(leitura)) {
      const limpa = semFalsosConhecidosAmazon(forma);
      for (const t of tiposMascaradosAmazon(limpa, { digitos: true })) tipos.add(t);
      if (ENDERECO.test(limpa)) tipos.add('endereco');
      for (const t of tiposDeIdAmazon(limpa, 'prosa')) tipos.add(t);
    }
    if (contemNomeDeLoja(leitura, lista)) tipos.add('nome-de-loja');
  }
  return [...tipos];
}
