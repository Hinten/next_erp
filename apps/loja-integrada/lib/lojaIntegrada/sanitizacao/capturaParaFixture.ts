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
 * ⚠️ Nothing of the raw body or the raw sidecar reaches a result except through
 * the redactor: findings carry where and what, never a value, and the parsed raw
 * tree feeds only the leaf table (paths, types, treatments). A failed
 * `lerRespostaJson` result is never serialised — its `nao-json` arm carries the
 * raw text.
 *
 * Pure: bytes and a modification time in, a result out.
 */
import { lerRespostaJson } from '@delfrance/core/wire';
import { z } from 'zod';

import {
  LIMITE_ANALISE_BYTES,
  PROFUNDIDADE_MAXIMA_JSON,
  type PoliticaCorpoLi,
  type ValorJsonLi,
  classificarCaminho,
  passaPredicadoLi,
  profundidadeJson,
  redigirCaminhoEQuery,
  redigirCorpo,
  tabelaDoCaminho,
  textoDoCaminho,
} from '../core/redacao';
import {
  type ListaDeNomesLi,
  contemNomeDeLoja,
  piiScan,
  tiposMascaradosLi,
} from '../fixtures/piiScan';
import { type EnvelopeFixtureLi, serializarFixtureLi } from '../fixtures/wireCorpus';
import { type LinhaDeFolhaLi, folhasEmParalelo, tabelaDeFolhas } from './folhas';
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
  /** `METODO caminho?query` after the redactor; `null` when it holds a listed name. */
  readonly linhaRequisicao: string | null;
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
 * ids, cost) are not reported.
 */
function mantidosQueForamFalsificados(
  bruto: unknown,
  sanitizado: ValorJsonLi,
  caminho: string,
  lista: ListaDeNomesLi,
): AchadoDaCapturaLi[] {
  const tabela = tabelaDoCaminho(caminho);
  if (tabela === null) return [];
  const achados: AchadoDaCapturaLi[] = [];
  for (const p of folhasEmParalelo(bruto, sanitizado, lista)) {
    if (p.tratamento === 'mantido') continue;
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

/** Converts one pair. `lista` is the owner's store-name list. */
export function capturaParaFixture(c: CapturaLi, lista: ListaDeNomesLi): ResultadoDaCapturaLi {
  const sidecar = lerSidecar(c.sidecar);
  if (!sidecar.ok) {
    return { ok: false, achados: sidecar.problemas.map(ondeDoSidecar), resumo: null };
  }
  const req = sidecar.requisicao;
  const politica = classificarCaminho(req.caminho);

  const pedido = redigirCaminhoEQuery(
    req.query === '' ? req.caminho : `${req.caminho}?${req.query}`,
    'fixture',
  );
  const linha = `${req.metodo} ${textoDoCaminho(pedido)}`;
  const base: ResumoDaCapturaLi = {
    linhaRequisicao: contemNomeDeLoja(linha, lista) ? null : linha,
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
      corpo: corpo.corpo,
    },
  };
  const resumo: ResumoDaCapturaLi = {
    ...base,
    politica: corpo.politica,
    forma: corpo.forma,
    folhas: bruto === null ? [] : tabelaDeFolhas(bruto.valor, corpo.corpo, lista),
  };

  const sucesso = req.status >= 200 && req.status <= 299;
  const todos: AchadoDaCapturaLi[] = [
    ...(sucesso && bruto !== null
      ? mantidosQueForamFalsificados(bruto.valor, corpo.corpo, req.caminho, lista)
      : []),
    ...piiScan(envelope, lista).map((a) => ({
      onde: a.caminho === '' ? '<raiz>' : a.caminho,
      tipo: a.tipo,
    })),
  ];
  const vistos = new Set<string>();
  const achados = todos.filter((a) => {
    const chave = `${a.onde}\u0000${a.tipo}`;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
  if (achados.length > 0) return recusa(achados, resumo);
  return { ok: true, envelope, texto: serializarFixtureLi(envelope), resumo };
}
