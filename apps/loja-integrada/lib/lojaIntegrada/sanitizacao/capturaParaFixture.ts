/**
 * One capture pair → one fixture envelope, or the reasons it is refused.
 *
 * In order: the sidecar gives the request (`requisicao.ts`); the path gives the
 * class (`webhook` is refused); the body is decoded (UTF-8, BOM stripped, UTF-16
 * refused), capped at the `fixture` parse cap, depth-checked, parsed, and checked
 * for integers that `JSON.parse` already altered; then it goes through the
 * `fixture` profile (`redigirCorpo`), the request line through the path and
 * query redactor, and the whole envelope through `piiScan` with the store-name
 * list. ANY finding refuses the pair, and the run (`executar.ts`) then writes
 * nothing at all.
 *
 * A `catalogo` pair also has its kept Loja Integrada ids replaced by their keyed
 * pseudonyms (`pseudonimo.ts`): a 2xx body's kept `id`/`*_id` leaves, resource
 * URIs and `meta.next`/`meta.previous` ids, and the request's path ids and
 * `produto=` value. The key is passed in as data; without one, a catalogue pair
 * is refused (`sem-chave-de-fixtures`, its printed request line blanked to
 * `<id>`), and so is a pair where two different ids land on one pseudonym
 * (`colisao-de-pseudonimo`). Catalogue data the mapping cannot reach is refused
 * too: an error body that keeps a number (`numero-em-erro-do-catalogo`), and a
 * catalogue resource on a path the class does not admit, which would fall to
 * `estrutural` and keep its ids (`catalogo-fora-da-classe`).
 *
 * ⚠️ Nothing of the raw body or the raw sidecar reaches a result except through
 * the redactor: findings carry where and what, never a value, and the parsed raw
 * tree feeds only the leaf table (paths, types, treatments). A failed
 * `lerRespostaJson` result is never serialised — its `nao-json` arm carries the
 * raw text.
 *
 * Pure: bytes, a modification time and the key in, a result out.
 */
import { lerRespostaJson } from '@delfrance/core/wire';
import { z } from 'zod';

import {
  LIMITE_ANALISE_BYTES,
  PROFUNDIDADE_MAXIMA_JSON,
  type PoliticaCorpoLi,
  RECURSOS_DO_CATALOGO_LI,
  type ValorJsonLi,
  classificarCaminho,
  passaPredicadoLi,
  profundidadeJson,
  recursoDoCaminho,
  redigirCaminhoEQuery,
  redigirCorpo,
  tabelaDoCaminho,
  textoDoCaminho,
} from '../core/redacao';
import {
  type ListaDeNomesLi,
  type TipoAchadoLi,
  piiScan,
  tiposDoTextoLi,
  tiposMascaradosLi,
} from '../fixtures/piiScan';
import { type EnvelopeFixtureLi, serializarFixtureLi } from '../fixtures/wireCorpus';
import { type LinhaDeFolhaLi, folhasEmParalelo, tabelaDeFolhas } from './folhas';
import { ARQUIVO_CHAVE_FIXTURES } from './lote';
import {
  type ChaveDeFixturesLi,
  OCULTAR_IDS_LI,
  PseudonimosLi,
  pseudonimizarCaminhoLi,
  pseudonimizarCorpoLi,
  pseudonimizarQueryLi,
} from './pseudonimo';
import { type ProblemaDoSidecar, decodificarUtf8, lerSidecar } from './requisicao';

/** One capture pair, as the script read it. */
export interface CapturaLi {
  readonly sidecar: Uint8Array;
  readonly corpo: Uint8Array;
  /** The body file's modification time (ms since the epoch): the default capture date. */
  readonly corpoModificadoEmMs: number;
}

/** A refusal: WHERE (`.txt:3`, `.json`, an envelope path) and WHAT. Never a value. */
export interface AchadoDaCapturaLi {
  readonly onde: string;
  readonly tipo: string;
}

/** What `--dry-run` prints about a pair; it holds no body value. */
export interface ResumoDaCapturaLi {
  /**
   * `METODO caminho?query` after the redactor; `null` when it trips any pattern
   * of the scanner or a listed name. The redactor keeps some values the scanner
   * refuses (an 11-digit `numero`, an id segment), so the line is checked again
   * here: a refused value is never printed, not even in a refused pair.
   */
  readonly linhaRequisicao: string | null;
  /** Why `linhaRequisicao` is `null`: the kinds it trips (empty when it is printed). */
  readonly linhaOmitidaPor: readonly TipoAchadoLi[];
  readonly politica: PoliticaCorpoLi;
  readonly status: number;
  readonly forma: 'json' | 'texto' | 'vazio' | null;
  /** The body file's size in bytes. */
  readonly bytes: number;
  readonly folhas: readonly LinhaDeFolhaLi[];
}

export type ResultadoDaCapturaLi =
  | {
      readonly ok: true;
      readonly envelope: EnvelopeFixtureLi;
      /** The fixture file's exact text. */
      readonly texto: string;
      readonly resumo: ResumoDaCapturaLi;
      /**
       * Pseudonym → the real id behind it, for the run's collision check across
       * pairs. Empty outside the catalogue class. In memory only: never printed.
       */
      readonly pseudonimos: ReadonlyMap<number, string>;
    }
  | {
      readonly ok: false;
      readonly achados: readonly AchadoDaCapturaLi[];
      readonly resumo: ResumoDaCapturaLi | null;
    };

const ehDigito = (c: number) => c >= 48 && c <= 57;
const ehEspaco = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * How many integer literals of 16 or more digits, in VALUE position (outside
 * every string), do not survive a `Number` round trip — i.e. `JSON.parse` has
 * already changed them. One linear pass that skips strings, so digits inside a
 * string never count; a number with a fraction or an exponent never counts
 * (a double is lossy by nature).
 */
export function contarInteirosInseguros(texto: string): number {
  let inseguros = 0;
  let emString = false;
  let anterior = 0; // the last non-space character outside strings; 0 at the start
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    if (emString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) {
        emString = false;
        anterior = c;
      }
      continue;
    }
    if (c === 0x22) {
      emString = true;
      continue;
    }
    const comecaNumero = ehDigito(c) || (c === 0x2d && ehDigito(texto.charCodeAt(i + 1)));
    const emPosicaoDeValor =
      anterior === 0 || anterior === 0x3a || anterior === 0x5b || anterior === 0x2c;
    if (comecaNumero && emPosicaoDeValor) {
      let j = c === 0x2d ? i + 1 : i;
      while (j < texto.length && ehDigito(texto.charCodeAt(j))) j++;
      const literal = texto.slice(i, j);
      const proximo = texto.charCodeAt(j);
      const inteiro = proximo !== 0x2e && proximo !== 0x65 && proximo !== 0x45;
      const digitos = literal.length - (c === 0x2d ? 1 : 0);
      if (inteiro && digitos >= 16 && String(Number(literal)) !== literal) inseguros += 1;
      // Skip the rest of the number token (fraction, exponent).
      while (j < texto.length && /[0-9.eE+-]/.test(texto.charAt(j))) j++;
      i = j - 1;
      anterior = 0x30;
      continue;
    }
    if (!ehEspaco(c)) anterior = c;
  }
  return inseguros;
}

/** The capture date: the `data:` line, else the body file's modification day in UTC. */
function diaUtc(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const ondeDoSidecar = (p: ProblemaDoSidecar): AchadoDaCapturaLi => ({
  onde:
    p.chave === undefined
      ? `.txt${p.linha === null ? '' : `:${String(p.linha)}`}`
      : `.txt:${String(p.linha ?? 1)} query:${p.chave}`,
  tipo: p.tipo,
});

/**
 * Allow-listed values the `fixture` profile FAKED although they passed their
 * predicate: the redactor's pattern layer hit them (a SKU that happens to be a
 * valid CPF, say). The fake is safe, but it would silently drop a value the
 * fixtures keep (SKUs, numeros, dates, quantities, prices), so the pair is
 * refused and surfaced instead; an exemption is a reviewed change for one exact
 * path. Values the profile fakes by design (`soLog`: tracking codes, external
 * ids, cost) are not reported, and neither are the catalogue ids the profile
 * KEPT and the pseudonym mapping then replaced (`doPerfil` is the profile's
 * output before that mapping): those are `pseudonimizado`, not faked.
 */
function mantidosQueForamFalsificados(
  bruto: unknown,
  sanitizado: ValorJsonLi,
  doPerfil: ValorJsonLi,
  caminho: string,
  lista: ListaDeNomesLi,
): AchadoDaCapturaLi[] {
  const tabela = tabelaDoCaminho(caminho);
  if (tabela === null) return [];
  const achados: AchadoDaCapturaLi[] = [];
  for (const p of folhasEmParalelo(bruto, sanitizado, lista, doPerfil)) {
    if (p.tratamento === 'mantido' || p.tratamento === 'pseudonimizado') continue;
    const predicado = tabela.permitidas.get(p.caminhoDaTabela);
    if (predicado === undefined || predicado === 'urlLi') continue;
    if (tabela.soLog.has(p.caminhoDaTabela) || !passaPredicadoLi(predicado, p.bruto)) continue;
    const tipos = typeof p.bruto === 'string' ? tiposMascaradosLi(p.bruto, { digitos: true }) : [];
    for (const tipo of tipos.length > 0 ? tipos : ['valor-mantido-falsificado']) {
      achados.push({ onde: `resposta.corpo.${p.caminhoImpresso}`, tipo });
    }
  }
  return achados;
}

/**
 * Numbers a catalogue ERROR body kept: the error walk keeps any safe integer
 * below 1e7 under any key, and in a catalogue body that may be a resource id
 * echoed back (`{"error":{"categoria":9191}}` beside a pseudonymized path). A
 * pseudonym cannot replace it there — the walk refuses numbers of 1e7 and above,
 * so the residue check would reject the envelope — so the pair is refused
 * instead. A number equal to the response status (`"status": 404`) is not an id.
 */
function numerosNoErroDoCatalogo(
  bruto: unknown,
  sanitizado: ValorJsonLi,
  status: number,
  lista: ListaDeNomesLi,
): AchadoDaCapturaLi[] {
  return folhasEmParalelo(bruto, sanitizado, lista)
    .filter((p) => p.tratamento === 'mantido' && typeof p.bruto === 'number' && p.bruto !== status)
    .map((p) => ({
      onde: `resposta.corpo.${p.caminhoImpresso}`,
      tipo: 'numero-em-erro-do-catalogo',
    }));
}

/**
 * Converts one pair. `lista` is the owner's store-name list; `chave` the
 * pseudonym key (`null` when the capture folder has none: a catalogue pair is
 * then refused).
 */
export function capturaParaFixture(
  c: CapturaLi,
  lista: ListaDeNomesLi,
  chave: ChaveDeFixturesLi | null,
): ResultadoDaCapturaLi {
  const sidecar = lerSidecar(c.sidecar);
  if (!sidecar.ok) {
    return { ok: false, achados: sidecar.problemas.map(ondeDoSidecar), resumo: null };
  }
  const req = sidecar.requisicao;
  const politica = classificarCaminho(req.caminho);
  const pseudonimos = politica === 'catalogo' && chave !== null ? new PseudonimosLi(chave) : null;

  const redigido = redigirCaminhoEQuery(
    req.query === '' ? req.caminho : `${req.caminho}?${req.query}`,
    'fixture',
  );
  // A catalogue request line never shows a real id: pseudonyms under the key, and
  // `<id>` blanks without one (the pair is then refused, but the dry run prints it).
  const troca = politica !== 'catalogo' ? null : (pseudonimos ?? OCULTAR_IDS_LI);
  const pedido =
    troca === null
      ? redigido
      : {
          ...redigido,
          caminho: pseudonimizarCaminhoLi(redigido.caminho, troca),
          query: pseudonimizarQueryLi(redigido.query, troca),
        };
  const linha = `${req.metodo} ${textoDoCaminho(pedido)}`;
  const omitidaPor = tiposDoTextoLi(linha, lista);
  const base: ResumoDaCapturaLi = {
    linhaRequisicao: omitidaPor.length === 0 ? linha : null,
    linhaOmitidaPor: omitidaPor,
    politica,
    status: req.status,
    forma: null,
    bytes: c.corpo.length,
    folhas: [],
  };
  const recusa = (achados: readonly AchadoDaCapturaLi[], resumo = base): ResultadoDaCapturaLi => ({
    ok: false,
    achados,
    resumo,
  });

  if (politica === 'webhook') return recusa([{ onde: '.txt:1', tipo: 'webhook' }]);
  // A catalogue resource on a path the catalogue class does not admit (a grade's
  // sub-resource) is `estrutural`, whose generic table keeps `id` and
  // `resource_uri` unmapped: its real ids would be written. Refused instead.
  if (
    politica === 'estrutural' &&
    RECURSOS_DO_CATALOGO_LI.has(recursoDoCaminho(req.caminho) ?? '')
  ) {
    return recusa([{ onde: '.txt:1', tipo: 'catalogo-fora-da-classe' }]);
  }
  if (politica === 'catalogo' && pseudonimos === null) {
    return recusa([{ onde: ARQUIVO_CHAVE_FIXTURES, tipo: 'sem-chave-de-fixtures' }]);
  }
  if (c.corpo.length > LIMITE_ANALISE_BYTES.fixture) {
    return recusa([{ onde: '.json', tipo: 'corpo-acima-do-limite' }]);
  }
  const decodificado = decodificarUtf8(c.corpo);
  if (!decodificado.ok) return recusa([{ onde: '.json', tipo: 'utf16' }]);
  const texto = decodificado.texto;
  if (profundidadeJson(texto) > PROFUNDIDADE_MAXIMA_JSON) {
    return recusa([{ onde: '.json', tipo: 'corpo-profundo-demais' }]);
  }

  // The raw tree, for the unsafe-integer check and the leaf table only.
  const leitura = texto.length === 0 ? null : lerRespostaJson(texto, z.unknown());
  const bruto = leitura?.ok === true ? { valor: leitura.data } : null;
  if (bruto !== null) {
    const inseguros = contarInteirosInseguros(texto);
    if (inseguros > 0) {
      return recusa([
        { onde: '.json', tipo: `inteiro-alterado-pelo-parse (${String(inseguros)})` },
      ]);
    }
  }

  const corpo = redigirCorpo({ caminho: req.caminho, status: req.status, corpo: texto }, 'fixture');
  if (!corpo.ok) return recusa([{ onde: '.json', tipo: `recusado-${corpo.motivo}` }]);

  const capturadoEm = req.data ?? diaUtc(c.corpoModificadoEmMs);
  if (capturadoEm === null) return recusa([{ onde: '.json', tipo: 'sem-data' }]);

  // The profile's output, then (a catalogue 2xx only) the same tree with its kept
  // ids pseudonymized. Both shapes are one, so the leaf table can tell the two
  // apart. An error body is never mapped: the error walk refuses a pseudonym-sized
  // number, and a catalogue one that keeps any number is refused below.
  const sucesso = req.status >= 200 && req.status <= 299;
  const doPerfil = corpo.corpo;
  const final =
    pseudonimos === null || bruto === null || !sucesso
      ? doPerfil
      : pseudonimizarCorpoLi(bruto.valor, doPerfil, tabelaDoCaminho(req.caminho), pseudonimos);

  const envelope: EnvelopeFixtureLi = {
    versao: 1,
    perfil: 'fixture',
    credencial: req.credencial,
    capturadoEm,
    requisicao: { metodo: req.metodo, caminho: pedido.caminho, query: pedido.query },
    resposta: {
      status: req.status,
      politica: corpo.politica,
      forma: corpo.forma,
      bytes: corpo.bytes,
      corpo: final,
    },
  };
  const resumo: ResumoDaCapturaLi = {
    ...base,
    politica: corpo.politica,
    forma: corpo.forma,
    folhas: bruto === null ? [] : tabelaDeFolhas(bruto.valor, final, lista, doPerfil),
  };

  const todos: AchadoDaCapturaLi[] = [
    ...(sucesso && bruto !== null
      ? mantidosQueForamFalsificados(bruto.valor, final, doPerfil, req.caminho, lista)
      : []),
    ...(!sucesso && bruto !== null && politica === 'catalogo'
      ? numerosNoErroDoCatalogo(bruto.valor, final, req.status, lista)
      : []),
    ...piiScan(envelope, lista).map((a) => ({
      onde: a.caminho === '' ? '<raiz>' : a.caminho,
      tipo: a.tipo,
    })),
    ...(pseudonimos !== null && pseudonimos.colisoes > 0
      ? [{ onde: 'pseudonimos', tipo: 'colisao-de-pseudonimo' }]
      : []),
  ];
  const vistos = new Set<string>();
  const achados = todos.filter((a) => {
    const marca = `${a.onde}\u0000${a.tipo}`;
    if (vistos.has(marca)) return false;
    vistos.add(marca);
    return true;
  });
  if (achados.length > 0) return recusa(achados, resumo);
  return {
    ok: true,
    envelope,
    texto: serializarFixtureLi(envelope),
    resumo,
    pseudonimos: pseudonimos?.ids ?? new Map<number, string>(),
  };
}
