/**
 * The independent check on a Loja Integrada (LI) fixture envelope, run by the
 * capture sanitizer before anything is written and by `wireCorpus.test.ts` over
 * every committed fixture.
 *
 * Two layers, because they fail differently:
 *
 * 1. **Residue** (`residuoDeRedacao`). Re-run the `fixture` profile over the
 *    envelope's body (and the path and query redactor over its request line). If
 *    anything changes, a value reached the envelope without passing the
 *    redactor. A named local `deepEqual` decides "unchanged"; it folds nothing
 *    but key ORDER (the equivalence-fold inventory records what it treats as
 *    equal and what must stay distinct).
 * 2. **Patterns** (`achadosDePadroes`), over every key and string or integer
 *    leaf of the whole envelope:
 *    - the always-on patterns of the redactor (e-mail, punctuated CPF and CNPJ, a
 *      hyphenated phone, CEP), imported so they have ONE source;
 *    - the check-digit test on a value or key that is EXACTLY 11 or 14 digits, or
 *      has the letter-bearing CNPJ shape — with no exemption, so a real SKU or
 *      GTIN that collides refuses the run and is surfaced (an exemption is a
 *      reviewed change for one exact path); in a URL-shaped text (one holding a
 *      `/`: the request path, `meta.next`), on every bare 11/14-digit run, since
 *      the redactor keeps every all-digit path segment;
 *    - a street-address pattern, and a Correios-shaped tracking code other than
 *      the placeholder;
 *    - the store-name list (`nomes-proibidos.txt`, which never enters the
 *      repository), folded for case, accents and separators. The sanitizer and
 *      `--verificar` pass it; CI has none.
 *    Every text is checked as written AND percent-decoded: a kept query value
 *    stays as written (`LOJA%2FEXEMPLO`) while the redactor tested it decoded.
 *    The redactor's own placeholders are skipped.
 *
 * ⚠️ **A finding never carries a value.** It carries a path and a kind, and a key
 * on the path is printed only when it is an identifier that trips nothing
 * (`rotuloDeChave`); otherwise the path shows `<chave>` or the pattern's tag.
 *
 * ⚠️ This scanner does NOT mirror the Mercado Livre or Shopee ones. It is the
 * second line behind `core/redacao.ts`, whose allow-lists are the first.
 */
import { validateCNPJ, validateCPF } from '@delfrance/core/documents';

import {
  PLACEHOLDERS_FIXTURE_LI,
  type TipoMascaraLi,
  mascararTexto,
  redigirCaminhoEQuery,
  redigirCorpo,
  textoDoCaminho,
} from '../core/redacao';
import type { EnvelopeFixtureLi } from './wireCorpus';

export type TipoAchadoLi = 'residuo' | TipoMascaraLi | 'endereco' | 'rastreio' | 'nome-de-loja';

export interface AchadoPiiLi {
  /** Dotted path; an array index is `*`; `''` is the root. */
  readonly caminho: string;
  readonly tipo: TipoAchadoLi;
}

/* -------------------------------------------------------------------------- */
/*                            The store-name list                             */
/* -------------------------------------------------------------------------- */

/**
 * The fold a store name is matched under: accents dropped (NFD, combining marks
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

/** The owner's store names and domains, folded. Built from `nomes-proibidos.txt` only. */
export interface ListaDeNomesLi {
  readonly termos: readonly { readonly comEspacos: string; readonly juntos: string | null }[];
}

export function criarListaDeNomes(termos: readonly string[]): ListaDeNomesLi {
  return {
    termos: termos.map((t) => {
      const comEspacos = dobrarNomeDeLoja(t);
      return {
        comEspacos,
        // A multi-word name also matches with its separators gone (`lojaexemplo`
        // in a domain). A single word never does: joining a text's words would
        // match it across two different words.
        juntos: comEspacos.includes(' ') ? comEspacos.replaceAll(' ', '') : null,
      };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/*                            Percent-encoded text                            */
/* -------------------------------------------------------------------------- */

const ESCAPES = /(?:%[0-9A-Fa-f]{2})+/g;
/** Not fatal: an invalid sequence becomes U+FFFD, so decoding never throws. */
const UTF8 = new TextDecoder('utf-8');
/** Rounds of decoding: a value encoded twice (`%252F`) is still read. */
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

/**
 * `t` as written and as a server reads it. The redactor tests a query value
 * DECODED but keeps it as WRITTEN (`sku=LOJA%2FEXEMPLO`, in the request line and
 * in `meta.next`), so a check on the written text alone misses what the decoded
 * one says. Text without a `%` is returned as is.
 */
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
 * Whether `texto` holds any listed name: a substring match under the fold, so a
 * term never matches a DIFFERENT word (`exemplo` vs `exemplar`), and folding more
 * is the safe direction. The text is tried as written, percent-decoded, and with
 * every `%XX` escape dropped (`LOJA%C3%A9EXEMPLO` → `LOJAEXEMPLO`).
 */
export function contemNomeDeLoja(texto: string, lista: ListaDeNomesLi): boolean {
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

const TIPOS_MASCARA: readonly TipoMascaraLi[] = ['email', 'cpf', 'cnpj', 'telefone', 'cep'];
const etiquetaDe = (tipo: TipoMascaraLi) => `<redacted:${tipo}>`;
const contar = (t: string, s: string) => t.split(s).length - 1;

/**
 * The redactor's mask kinds that hit `t`. Counted as tags ADDED by the mask, so a
 * text that already spells a tag is not reported for it.
 */
export function tiposMascaradosLi(t: string, opts: { readonly digitos: boolean }): TipoMascaraLi[] {
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
function digitosVerificados(s: string): TipoMascaraLi | null {
  if (ONZE.test(s) && validateCPF(s)) return 'cpf';
  if ((QUATORZE.test(s) || CNPJ_COM_LETRA.test(s)) && validateCNPJ(s)) return 'cnpj';
  return null;
}

/** A street-address prefix followed by a name or number. */
const ENDERECO =
  /(?<![\p{L}\p{N}])(?:rua|r\.|avenida|av\.|travessa|tv\.|alameda|al\.|rodovia|rod\.|estrada|pra[cç]a|largo|viela|beco)\s+[\p{L}\p{N}]/iu;
/** A Correios-shaped tracking code (`AA000000000BR` is the placeholder, skipped as such). */
const RASTREIO_CORREIOS = /(?<![A-Za-z0-9])[A-Z]{2}\d{9}[A-Z]{2}(?![A-Za-z0-9])/;

/**
 * Every kind a text trips: a key, a string leaf, the request line. Each form of
 * the text (as written, percent-decoded) is checked.
 *
 * A text holding a `/` is URL-shaped (the request path, `meta.next`, a resource
 * URI): the redactor keeps EVERY all-digit path segment as an id, so the check
 * digits run on each bare 11/14-digit run in it (`/v1/cliente/<cpf>`,
 * `1;<cpf>`), not only on a value that is exactly a document.
 */
export function tiposDoTextoLi(s: string, lista: ListaDeNomesLi | null): TipoAchadoLi[] {
  const tipos = new Set<TipoAchadoLi>();
  for (const forma of formasDecodificadas(s)) {
    for (const t of tiposMascaradosLi(forma, { digitos: forma.includes('/') })) tipos.add(t);
    const digitos = digitosVerificados(forma);
    if (digitos !== null) tipos.add(digitos);
    if (ENDERECO.test(forma)) tipos.add('endereco');
    if (RASTREIO_CORREIOS.test(forma)) tipos.add('rastreio');
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
 * itself when it is an identifier that trips no pattern and no listed name; the
 * mask's tags when the mask hits it (`<redacted:email>`, never the rest of the
 * key); `<chave>` otherwise.
 */
export function rotuloDeChave(chave: string, lista: ListaDeNomesLi | null): string {
  const tipos = tiposMascaradosLi(chave, { digitos: true });
  if (tipos.length > 0) return tipos.map(etiquetaDe).join('');
  if (!CHAVE_CONFORME.test(chave)) return '<chave>';
  if (lista !== null && contemNomeDeLoja(chave, lista)) return '<chave>';
  return chave;
}

/* -------------------------------------------------------------------------- */
/*                              Layer 1: residue                              */
/* -------------------------------------------------------------------------- */

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
  lista: ListaDeNomesLi | null,
  saida: AchadoPiiLi[],
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
  envelope: EnvelopeFixtureLi,
  lista: ListaDeNomesLi | null = null,
): AchadoPiiLi[] {
  const achados: AchadoPiiLi[] = [];
  const { requisicao, resposta } = envelope;

  const linha = textoDoCaminho({
    caminho: requisicao.caminho,
    query: requisicao.query,
    mascarados: 0,
  });
  const deNovo = redigirCaminhoEQuery(linha, 'fixture');
  if (deNovo.caminho !== requisicao.caminho) {
    achados.push({ caminho: 'requisicao.caminho', tipo: 'residuo' });
  }
  localizarDiferencas(requisicao.query, deNovo.query, ['requisicao', 'query'], lista, achados);

  if (resposta.forma !== 'json') {
    if (resposta.corpo !== null) achados.push({ caminho: 'resposta.corpo', tipo: 'residuo' });
    return achados;
  }
  const corpo = redigirCorpo(
    {
      caminho: requisicao.caminho,
      status: resposta.status,
      corpo: JSON.stringify(resposta.corpo),
    },
    'fixture',
  );
  if (!corpo.ok || corpo.forma !== 'json') {
    achados.push({ caminho: 'resposta.corpo', tipo: 'residuo' });
    return achados;
  }
  if (corpo.politica !== resposta.politica) {
    achados.push({ caminho: 'resposta.politica', tipo: 'residuo' });
  }
  localizarDiferencas(resposta.corpo, corpo.corpo, ['resposta', 'corpo'], lista, achados);
  return achados;
}

/* -------------------------------------------------------------------------- */
/*                             Layer 2: patterns                              */
/* -------------------------------------------------------------------------- */

/** Layer 2: every key and leaf of the envelope that trips a pattern or a listed name. */
export function achadosDePadroes(
  envelope: EnvelopeFixtureLi,
  lista: ListaDeNomesLi | null = null,
): AchadoPiiLi[] {
  const achados: AchadoPiiLi[] = [];
  const marcar = (caminho: readonly string[], tipos: readonly TipoAchadoLi[]) => {
    for (const tipo of tipos) achados.push({ caminho: juntar(caminho), tipo });
  };

  function percorrer(v: unknown, caminho: readonly string[]): void {
    if (Array.isArray(v)) {
      for (const x of v) percorrer(x, [...caminho, '*']);
      return;
    }
    if (ehObjetoSimples(v)) {
      for (const [k, filho] of Object.entries(v)) {
        const aqui = [...caminho, rotuloDeChave(k, lista)];
        marcar(aqui, tiposDoTextoLi(k, lista));
        percorrer(filho, aqui);
      }
      return;
    }
    if (typeof v === 'string') {
      if (!PLACEHOLDERS_FIXTURE_LI.has(v)) marcar(caminho, tiposDoTextoLi(v, lista));
      return;
    }
    if (typeof v === 'number' && Number.isInteger(v)) {
      const digitos = digitosVerificados(String(Math.abs(v)));
      if (digitos !== null) marcar(caminho, [digitos]);
    }
  }

  percorrer(envelope, []);
  return achados;
}

/** Both layers, deduplicated. Empty means the envelope may be written. */
export function piiScan(
  envelope: EnvelopeFixtureLi,
  lista: ListaDeNomesLi | null = null,
): AchadoPiiLi[] {
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
export function formatarAchadosLi(nome: string, achados: readonly AchadoPiiLi[]): string[] {
  return achados.map((a) => `${nome} ${a.caminho === '' ? '<raiz>' : a.caminho} :: ${a.tipo}`);
}

/* -------------------------------------------------------------------------- */
/*                         Free text (`--verificar`)                          */
/* -------------------------------------------------------------------------- */

/**
 * The fakes this repository's public text is REQUIRED to use, blanked before a
 * doc line is scanned: all-zero documents, CEPs and phones with area code `00`,
 * and e-mail addresses under a reserved domain (`.invalid`, `.example`, `.test`,
 * `.localhost`, `example.com|net|org`). None of them can belong to anyone.
 */
const FALSOS_EM_TEXTO = [
  /0{3}\.0{3}\.0{3}-0{2}/g,
  /0{2}\.0{3}\.0{3}\/0{4}-0{2}/g,
  /(?<!\d)0{5}-0{3}(?!\d)/g,
  /\(00\) ?[09]?0{4}-0{4}/g,
  /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){0,8}(?:invalid|example|test|localhost|example\.com|example\.net|example\.org)(?![A-Za-z0-9.-])/g,
];

export function semFalsosConhecidosLi(t: string): string {
  return FALSOS_EM_TEXTO.reduce((s, re) => s.replace(re, (m) => ' '.repeat(m.length)), t);
}

/**
 * The kinds one line of a doc, a fixture or a PR-body draft trips: the store
 * names, and every redactor pattern (bare 11/14 digits only with valid check
 * digits), on the line as written and percent-decoded. The repository's
 * mandated fakes are skipped.
 */
export function tiposNaLinhaLi(linha: string, lista: ListaDeNomesLi): TipoAchadoLi[] {
  const tipos = new Set<TipoAchadoLi>();
  for (const forma of formasDecodificadas(linha)) {
    for (const t of tiposMascaradosLi(semFalsosConhecidosLi(forma), { digitos: true })) {
      tipos.add(t);
    }
  }
  if (contemNomeDeLoja(linha, lista)) tipos.add('nome-de-loja');
  return [...tipos];
}
